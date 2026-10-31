"""基础附件读取：已挂载附件继承来源授权，不能以二进制上传人绕过。"""
import json
from contextlib import nullcontext

import frappe
from frappe.core.doctype.file.file import File
from shangshu_core.domain_execution import domain_execution
from shangshu_core.identity import get_identity


def _owners(doctype):
    return {row.domain_id for row in frappe.get_all('Shangshu Domain', fields=['domain_id', 'contribution_json'])
            if any(obj.get('doctype') == doctype for obj in json.loads(row.contribution_json or '{}').get('objects', [])
                   if isinstance(obj, dict))}


def can_read_reference(doctype, name):
    if not doctype or not name or frappe.session.user == 'Guest':
        return False
    try:
        get_identity()
        # 只读已注册声明，不调用领域 provider；先入执行边界再加载来源业务记录。
        owners = _owners(doctype)
        if len(owners) > 1:
            frappe.throw('附件来源归属不唯一', frappe.PermissionError)
        with domain_execution(next(iter(owners))) if owners else nullcontext():
            # ⚠️ **必须传文档对象，不能传名字字符串**（BASE967-38 / R967-E01 查证）。
            #
            # `has_permission` 钩子的签名是 `(doc, user=None, permission_type=None)`，
            # 钩子里普遍用 **`getattr(doc, '<字段>')`** 取字段做判定。传名字进去，
            # `getattr('某编号', 'mailbox_id', None)` 得 `None` → **字段级判定整条失效**，
            # 通常还会掉到 `doc.owner == user` 那条兜底（对字符串再取 `.owner` 就 AttributeError）。
            #
            # **实测后果**（`shangshu_mail/service.py:49` 的 `has_permission`）：
            # 邮箱授权**从来没被问过** —— 连**收件人本人对自己的信**都判成无权，
            # 而 `Shangshu Mail Access` 里的授权行是**真落了库的**。
            # 于是「共享邮箱授予的读取权在文件入口生效」（账号与权限.md §mail-attachment-access
            # 第 1 条）根本做不到，附件授权只能退回按归属猜。
            #
            # **为什么是内核这层的问题，不是各领域的**：钩子约定收 doc 是 Frappe 的既有形状
            # （`objects.get_object_record` 也是 `doc.check_permission('read')`）；
            # 这里传名字是**本函数**自己传错，**所有已挂载附件的授权都受影响**，不只文件域。
            doc = frappe.get_doc(doctype, name)
            # 走文档的正式读取入口，保留其授权适配（普通原生文档仍回 Frappe）。
            # 仅调用 frappe.has_permission 会跳过文件中心的开放试用读适配。
            doc.check_permission('read')
            return True
    except (frappe.PermissionError, frappe.DoesNotExistError):
        return False


def can_download_reference(doctype, name):
    """下载/导出独立于读（用户 2026-10-12：管理读不带下载，「不因可见就可导出」）。

    有组织归属的资源按 org_admin.download_allows 判；无归属资源回落读权，
    存量行为不变（B6 兼容）。
    """
    if not can_read_reference(doctype, name):
        return False
    from shangshu_core import org_admin
    verdict = org_admin.download_allows(frappe.session.user, name)
    return True if verdict is None else bool(verdict)


def require_attachment_export(file):
    """Same download/content gate for raw File URLs and new snapshot bindings.

    A completed attachment copy belongs to its target record. This check applies
    when exporting the source, not retroactively to an already delivered copy.
    """
    if not can_download_reference(file.attached_to_doctype, file.attached_to_name):
        frappe.throw('没有导出来源附件的权限', frappe.PermissionError)
    from shangshu_core.field_access import check_content_ready
    check_content_ready(file.attached_to_doctype, file.attached_to_name, file.name)


def _ids(files):
    if not isinstance(files, list) or len(files) > 20 or any(not isinstance(value, str) or not 0 < len(value) <= 140 for value in files):
        frappe.throw('附件引用无效或超过20个', frappe.ValidationError)
    return list(dict.fromkeys(files))


def _metadata(file):
    return {'file': file.name, 'name': file.file_name, 'size': file.file_size or 0}


def get_record_attachments(doctype, name, files):
    """只读本记录已绑定的附件；不返回磁盘路径、不读取来源业务域。"""
    files = _ids(files)
    # 与绑定引用一致，由核心代理来源授权；调用域不因此获得来源数据库访问权。
    with domain_execution('com.shangshu.core'):
        if not can_read_reference(doctype, name):
            frappe.throw('无权读取附件所属记录', frappe.PermissionError)
    result = []
    for file_id in files:
        file = frappe.get_doc('File', file_id)
        if (file.attached_to_doctype, file.attached_to_name) != (doctype, name) or not file.is_private or file.is_folder:
            frappe.throw('附件未挂载到当前记录', frappe.PermissionError)
        result.append(_metadata(file))
    return result


def bind_record_attachments(doctype, name, files):
    """仅受信公共动作可为本域记录建立独立引用；字节仍由原 File 存储管理。"""
    from shangshu_core.domains import raw_resource

    files = _ids(files)
    caller = getattr(frappe.flags, 'shangshu_call_domain', None)
    pin = getattr(frappe.flags, 'shangshu_action_pin', None) or {}
    action_owner, _ = raw_resource('actions', pin.get('action_id')) if pin.get('action_id') else (None, None)
    if not caller or not action_owner or action_owner['id'] != caller or _owners(doctype) != {caller}:
        frappe.throw('附件绑定必须由所属领域的公共动作执行', frappe.PermissionError)
    if not can_read_reference(doctype, name):
        frappe.throw('无权访问附件目标记录', frappe.PermissionError)
    # 锁住目标，避免同一记录并发重选堆出多个挂载；外层动作负责审计与事务。
    frappe.get_doc(doctype, name, for_update=True)
    result = []
    # 核心仅代理“读取并建立引用”，不是放开领域间直接调用。
    # 来源仍经过启停屏障及当前用户权限；已有引用随后只受目标域授权约束。
    with domain_execution('com.shangshu.core'):
        for file_id in files:
            snapshot = None
            source = frappe.get_doc('File', file_id)
            if not source.is_private or source.is_folder or not (source.file_url or '').startswith('/private/files/'):
                frappe.throw('只能引用已保存的私有附件', frappe.ValidationError)
            if not can_read_reference(source.attached_to_doctype, source.attached_to_name):
                frappe.throw('附件来源不可访问，请重新选择', frappe.PermissionError)
            require_attachment_export(source)
            if str(getattr(source, 'content_hash', '') or '').startswith('mutable:'):
                # Attaching is an explicit snapshot operation. Do not make a
                # sent/draft attachment silently follow later workbook edits.
                # Working blobs use a namespaced hash so ordinary immutable
                # File deduplication can never reuse a mutable working path.
                from frappe.utils.file_manager import save_file
                import hashlib
                content = source.get_content()
                bound = save_file(source.file_name, content, doctype, name, is_private=1)
                snapshot = {'source_file': file_id, 'source_record': source.attached_to_name,
                            'captured_at': str(frappe.utils.now_datetime()),
                            'sha256': hashlib.sha256(content).hexdigest()}
            elif (source.attached_to_doctype, source.attached_to_name) == (doctype, name):
                bound = source
            else:
                existing = frappe.db.get_value('File', {'attached_to_doctype': doctype, 'attached_to_name': name,
                    'file_url': source.file_url, 'file_name': source.file_name, 'is_private': 1}, 'name')
                bound = frappe.get_doc('File', existing) if existing else source.create_attachment_copy(
                    doctype, name, ignore_permissions=True)
            item = next((item for item in result if item['file'] == bound.name), None)
            if item is None:
                item = {**_metadata(bound), 'source_files': []}
                result.append(item)
            if snapshot:
                item['snapshot'] = snapshot
            item['source_files'].append(file_id)
    return result


class PlatformFile(File):
    def get_content(self, *args, **kwargs):
        from shangshu_core.mutable_files import read_mutable_file
        content = read_mutable_file(self)
        return content if content is not None else super().get_content(*args, **kwargs)

    def is_downloadable(self):
        if self.is_private and self.attached_to_doctype and self.attached_to_name:
            try:
                require_attachment_export(self)
                return True
            except frappe.PermissionError:
                return False
        return super().is_downloadable()


def reference_doctype(object_id):
    """注册对象到附件目标的映射；访问仍须 can_read_reference 检查。"""
    from shangshu_core.domains import raw_resource
    from shangshu_core.identity import get_identity
    get_identity()
    domain, item = raw_resource('objects', str(object_id or '').strip())
    return str((item or {}).get('doctype') or '') if domain else ''
