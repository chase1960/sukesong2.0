"""文件中心业务：上传、版本、元信息、回收与恢复。存储复用 Frappe 私有 File（save_file）。"""
import base64
import hashlib
import json
import os
from io import BytesIO

import frappe
from frappe.utils.file_manager import save_file

from shangshu_files import directories, access, relations
from shangshu_core.public_api import business_access

DOCTYPE = 'Shangshu File Center File'
# 上传白名单：加 .xml／.tif／.tiff 是因为 **Host 批量上传会带这三类件**
# （回执是 .xml，扫描件可能是 .tif/.tiff）—— 不收 ⇒ 这几件存不进文件中心，
# 批次只能判「部分完成」。**只加扩展名，不放宽类型/大小/权限任何一道闸。**
ALLOWED_EXTENSIONS = {'.pdf', '.docx', '.xlsx', '.png', '.jpg', '.jpeg', '.txt', '.md', '.csv', '.zip',
                    '.xml', '.tif', '.tiff'}
MAX_FILE_BYTES = 20 * 1024 * 1024


def _dump(value):
    return json.dumps(value, ensure_ascii=False)


def _manager():
    return 'System Manager' in frappe.get_roles()


def _owns(doc):
    return doc.owner == frappe.session.user


def _can_write(doc):
    """改值/编辑权：有组织归属走组织判定（当前归属人或管理人/编辑共享），无归属保持旧口径。

    管理读不带编辑——老板/负责人对默认可读的表不在这里放行（用户 2026-10-12）。
    """
    business_access.require_identity()
    trial = business_access.resource_decision(doc.name, owner=doc.owner)
    if trial is not None:
        return trial
    from shangshu_core.public_api import organization as org_admin
    user = frappe.session.user
    att = org_admin.resource_attribution(doc.name)
    if att:
        return bool(org_admin.write_allows(user, doc.name, att))
    return _owns(doc) or _manager()


def _can_structure(doc):
    """结构权属于可写的创建者/个人资源所有人，或获结构角色的可写者。编辑共享不升级。"""
    business_access.require_identity()
    trial = business_access.resource_decision(doc.name, owner=doc.owner)
    if trial is not None:
        return trial and doc.status == 'Active'
    from shangshu_core import org_admin
    if doc.status != 'Active' or not _can_write(doc):
        return False
    user = frappe.session.user
    att = org_admin.resource_attribution(doc.name)
    owner = bool((att.owner_user or '').lower() == user.lower()) if att else doc.owner == user
    return owner or bool({'System Manager', 'Sheet Structure Editor'} & set(frappe.get_roles()))


def _can_download(doc):
    business_access.require_identity()
    trial = business_access.resource_decision(doc.name, owner=doc.owner)
    if trial is not None:
        return trial and doc.status == 'Active'
    if doc.status != 'Active':return False
    from shangshu_core import org_admin
    att=org_admin.resource_attribution(doc.name)
    return bool(org_admin.download_allows(frappe.session.user,doc.name,att)) if att else _can_write(doc)


def _can_share(doc):
    business_access.require_identity()
    trial = business_access.resource_decision(doc.name, owner=doc.owner)
    if trial is not None:
        return trial and doc.status == 'Active'
    if doc.status != 'Active':return False
    from shangshu_core import org_admin
    att=org_admin.resource_attribution(doc.name)
    return bool(org_admin.share_right_allows(frappe.session.user,doc.name,att)) if att else (_owns(doc) or _manager())


def _require_structure(doc):
    if not _can_structure(doc):
        frappe.throw('当前用户可修改已有值，但没有该表的结构编辑权限', frappe.PermissionError)


def _writable(file):
    doc = frappe.get_doc(DOCTYPE, str(file or ''), for_update=True)
    doc.check_permission('read')
    if not _can_write(doc):
        frappe.throw('只有上传人、资源归属人或获编辑共享的人可以修改文件', frappe.PermissionError)
    return doc


def _check_location(doc):
    if doc.status == 'Active' and frappe.db.exists(DOCTYPE, {
        'directory': doc.directory, 'file_name': doc.file_name,
        'status': 'Active', 'name': ('!=', doc.name),
    }):
        frappe.throw('目标目录已有同名文件，请改名或选择其他目录', frappe.ValidationError)


def _read_content(content_base64, file_sha256=None, allow_empty=False):
    try:
        content = base64.b64decode(content_base64, validate=True)
    except Exception:
        frappe.throw('文件内容不是有效 Base64', frappe.ValidationError)
    if (not content and not allow_empty) or len(content) > MAX_FILE_BYTES:
        frappe.throw('文件为空或超过 20MB', frappe.ValidationError)
    digest = hashlib.sha256(content).hexdigest()
    if file_sha256 and digest != str(file_sha256):
        frappe.throw('文件摘要校验失败', frappe.ValidationError)
    return content, digest


def _safe_name(file_name):
    raw = str(file_name or '').strip()
    safe = os.path.basename(raw)
    ext = os.path.splitext(safe)[1].lower()
    if not safe or ext not in ALLOWED_EXTENSIONS:
        frappe.throw('仅支持 ' + '、'.join(sorted(ALLOWED_EXTENSIONS)) + ' 格式文件', frappe.ValidationError)
    if raw != safe:
        frappe.throw('文件名不能包含路径分隔符', frappe.ValidationError)
    return safe


def _normalize_tags(tags):
    if tags in (None, ''):
        return []
    if isinstance(tags, str):
        tags = json.loads(tags)
    if not isinstance(tags, list) or len(tags) > 10:
        frappe.throw('标签须为不超过 10 项的列表', frappe.ValidationError)
    return [str(tag).strip()[:20] for tag in tags if str(tag).strip()]


def _record_version(doc, file_doc, digest, size, note, source_file=None, *, initial_creation=False):
    if json.loads(doc.sheet_meta_json or '{}').get('object_companion'):
        frappe.throw('原对象伴随文件不能被上传整份替换，请在原表编辑普通列',frappe.ValidationError)
    # 新归档的第一版完成已获准的创建，不授予创建者之后修改部门资源的权限。
    initializing = (initial_creation is True and bool(source_file)
        and doc.owner == frappe.session.user and not doc.current_file
        and int(doc.version_count or 0) == 1
        and not frappe.db.exists('Shangshu File Center Version', {'file': doc.name}))
    if not initializing and not _can_write(doc):
        frappe.throw('只有上传人、资源归属人或获编辑共享的人可以上传新版本', frappe.PermissionError)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再上传新版本', frappe.ValidationError)
    from shangshu_files.working_file import content_revision
    revision = content_revision(doc) + 1
    version_no = int(doc.version_count or 1)
    frappe.get_doc({
        'doctype': 'Shangshu File Center Version',
        'file': doc.name,
        'version_no': version_no,
        'frappe_file': file_doc.name,
        'size': size,
        'sha256': digest,
        'note': str(note or '')[:500],
        'uploaded_by': frappe.session.user,
        'source_file': source_file,
    }).insert(ignore_permissions=True)
    doc.current_file = file_doc.name
    doc.current_size = size
    doc.current_sha256 = digest
    doc.version_count = version_no + 1
    doc.content_revision = revision
    doc.status = 'Active'
    doc.save(ignore_permissions=True)
    return version_no


def _append_version(doc, content, digest, note, attach_to=None):
    """存这一版字节。

    ⚠️ **`attach_to`**（2026-10-22 · PKG-036-T04）：那个 File 行**挂在谁身上**。
    默认挂在**文件中心自己那条记录**上；给了 `attach_to`（记录类型 ＋ 记录编号）
    就挂在**那条记录**上（例：来信的附件挂在「这封信」上 —— 读信面按这封信的归属取字节就靠它）。
    ⚠️ **字节仍然只有一份**：File 行指向同一个磁盘文件（`file_url`），不是复制。
    """
    target_doctype, target_name = attach_to if attach_to else (DOCTYPE, doc.name)
    file_doc = save_file(doc.file_name, content, target_doctype, target_name, is_private=1)
    return _record_version(doc, file_doc, digest, len(content), note)


def _mail_sys_fields(payload):
    """来信附件自动入库时由**服务端**填的两个系统字段（所有人 / 关联邮件）。

    字段权威语义见「字段字典 · 文件系统字段」：
      · 所有人 = 文件归属主体（员工ID或部门ID），个人邮箱收件归邮箱所属员工、
        共享邮箱归所属部门；**不是**发件人、不是收信服务、也不是第一个打开邮件的人
      · 关联邮件 = 来源已收邮件的稳定引用

    只有受管收信路径能带进来 —— 普通用户动作带上一律拒。
    契约原话：「员工不能靠改显示文字/请求字段更换所有人或伪造来源」。
    """
    raw = payload.get('mail_system') or {}
    if not raw:
        return {}
    if not getattr(frappe.flags, 'shangshu_mail_write', False):
        frappe.throw('所有人与关联邮件由系统按邮箱归属推导，不能由请求指定', frappe.PermissionError)
    kind = str(raw.get('owner_subject_kind') or '')
    if kind not in ('Employee', 'Department'):
        frappe.throw('所有人类型无效', frappe.ValidationError)
    owner = str(raw.get('owner_subject') or '').strip()
    if not owner:
        frappe.throw('所有人不能为空', frappe.ValidationError)
    return {'owner_subject_kind': kind, 'owner_subject': owner,
            'related_mail': str(raw.get('related_mail') or '').strip()}


def import_attachment(payload):
    """仅经公共附件契约归档；来源授权与目标域存储相互独立，不导入邮件/财务代码。"""
    from shangshu_core.public_api import get_record_attachments, bind_record_attachments
    # 这两个系统字段**一进函数就校验**，不管后面走不走「已导入」那条早退。
    # 放到后面校验会被早退绕过：同一附件再导一次时直接返回 already_imported，
    # 根本走不到校验 —— 伪造的「所有人」被静默吞掉，试探的人得不到任何回音
    # （实测 1-6 抓到）。不吭声等于放过试探，要当场拒。
    mail_sys = _mail_sys_fields(payload)
    source = payload['source']
    meta = get_record_attachments(source['ref_doctype'], source['ref_name'], [source['file']])[0]
    safe = _safe_name(meta['name'])
    if not 0 < int(meta['size']) <= MAX_FILE_BYTES:
        frappe.throw('附件为空或超过20MB', frappe.ValidationError)
    folder = directories.resolve(payload)
    existing = frappe.db.get_value(DOCTYPE, {'directory_id': folder.name, 'file_name': safe, 'status': 'Active'}, 'name')
    if existing:
        doc = _writable(existing)
        prior = frappe.db.get_value('Shangshu File Center Version', {'file': doc.name, 'source_file': source['file']}, 'version_no')
        if prior:
            return {'file': doc.name, 'version': prior, 'created': 0, 'already_imported': True,
                    'attribution': _attribution_of(doc.name)}
        if os.path.splitext(doc.file_name)[1].lower() == '.xlsx':
            # 外部覆盖边界：附件归档不得改写已有表内容——同名不同附件落恒新表（同 files.upload 口径）
            safe = _unique_sheet_name(folder.path, safe)
            existing = None
    if not existing:
        # **新建才要归属** —— 追版本/已导入早退（`existing` / `already_imported`）不新建记录、
        # 也不碰归属，**不许被一刀切拦住**（ATT-⑨ ⑤ 那条对照就是钉这个）。
        _require_attribution('files.import_attachment', payload)
        doc = frappe.get_doc({'doctype': DOCTYPE, 'file_name': safe, 'directory': folder.path,
            'directory_id': folder.name, 'tags_json': _dump(_normalize_tags(payload.get('tags'))),
            'note': str(payload.get('note') or '')[:500], 'status': 'Active', 'version_count': 1,
            **mail_sys}).insert(ignore_permissions=True)
        # G1：归档进来的附件同样要落组织归属，否则 `resource_attribution` 一律 None，
        # 部门判定没有落点，越权反例会「筛不到」而假绿。与 files.upload / files.create
        # **同一套判定、同一个写入口**（`_apply_attribution` → `org_admin.attribution_record`）。
        # 只在新建文档时落；追版本不改归属（与 upload 的 existing 分支一致）。
        _apply_attribution(payload, doc)
        # 「声明了所有人，权威归属那一行就必须落」—— **不许静默**。
        # `mail_system` 只是显示/筛选字段，`Shangshu Org Attribution` 才是
        # `read_allows`/`write_allows` 判的那一份（B 2026-10-14：两者同一个键、
        # 同一次推导，但落点不同）。声明了前者而后者没落 → 授权判不到 →
        # `read_allows` 回 None → 回落旧目录授权，**声明的所有人拿不到任何权利，
        # 回包还说成功**（G1-⑥ 实测：call='ok' created=… landed=False）。
        # 降级点在邮件侧 delivery.py:374：`_attribution_supported()` 为假时**不发**
        # attribution。本侧 `_apply_attribution` 现在 **不传就当场拒**
        # （2026-10-15 用户选「上传必填归属」，原来是 `if not att: return` 静默跳过）——
        # 两边合起来是 **fail-closed**：传不过来就建不成，不再「静默建一条没归属的」。
        # 核过：`delivery.py` 的 `attachment_attribution()` **永远返回合法归属、从不 None**，
        # 所以在 schema 认 attribution 的这支上邮件附件不会被这条拒掉。
        # **本模块不从 `mail_system` 反推归属**（B 定的解耦：不把邮件概念吃进文件域），
        # 只守这条 fail-closed：落不了就当场拒，不猜。
        if mail_sys and not _attribution_of(doc.name):
            frappe.throw(
                '已声明所有人但组织归属未落，本次不入库：请同时传 attribution。'
                'mail_system 只作显示/筛选，授权判的是 Shangshu Org Attribution',
                frappe.ValidationError)
    elif mail_sys:
        # 已有同名资源：系统字段**补齐**而不是覆盖 —— 同名不同附件各有各的身份，
        # 不许后一次导入把前一次的所有人改掉。
        extra = {k: v for k, v in mail_sys.items() if v and not doc.get(k)}
        if extra:
            doc.update(extra)
            doc.save(ignore_permissions=True)
    bound = bind_record_attachments(DOCTYPE, doc.name, [source['file']])[0]
    # 引用已归属于本域记录；私有字节仍复用Frappe存储，不另建下载/上传通道。
    file_doc = frappe.get_doc('File', bound['file'])
    content = file_doc.get_content()
    content = content if isinstance(content, bytes) else str(content).encode()
    if not content or len(content) > MAX_FILE_BYTES:
        frappe.throw('附件为空或超过20MB', frappe.ValidationError)
    version = _record_version(doc, file_doc, hashlib.sha256(content).hexdigest(), len(content), payload.get('note'), source['file'], initial_creation=not existing)
    return {'file': doc.name, 'version': version, 'created': 0 if existing else 1, 'already_imported': False,
            'attribution': _attribution_of(doc.name)}


def _unique_sheet_name(directory, safe):
    """独立资源同名时自动改名（附件.pdf → 附件 (2).pdf），保留原资源。"""
    stem, ext = os.path.splitext(safe)
    def literal_like(value):
        return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    # 只取当前目录同一命名族的标题，不逐候选SQL，也不读文件内容/其他目录。
    names = frappe.get_all(DOCTYPE,
        filters={'directory': directory, 'status': 'Active',
                 'file_name': ('like', literal_like(stem) + ' (%)' + literal_like(ext))},
        fields=['file_name'], limit_page_length=0)
    used = set()
    for row in names:
        name = str(row.get('file_name') or '')
        # 前后缀已由DB按原排序规则匹配（保留大小写/重音语义）；中间只认ASCII整数。
        number = name[len(stem) + 2:len(name) - len(ext) - 1]
        if number and number[0] != '0' and number.isascii() and number.isdecimal():
            used.add(int(number))
    number = 2
    while number in used:
        number += 1
    # 并发争用仍由既有目录/文件名/location_slot唯一约束拒绝，不覆盖原资源。
    return '%s (%d)%s' % (stem, number, ext)


NO_ENTERPRISE = '尚书是单例，没有企业归属'
# 用户 2026-10-15 选修法一「上传必填归属」；E 定的拒因文案（两句话都带上）：
# 前半句说清「缺什么、怎么补」，后半句把口径摆在那儿 —— 不用再翻文档。
NO_ATTRIBUTION = '不传归属不能建文件。请选个人或部门归属 —— ' + NO_ENTERPRISE

# 建表占位（2026-10-21，agent 建表一线）：**占位必须是占位**——
# 写进去的那句话要让人一眼看出「这不是数据，请改」。
PLACEHOLDER_DEFAULT = '这是占位，请改'


def _placeholder_text(value):
    """占位文字：**永远写明这是占位**。

    调用方给了自己的话 ⇒ 后面补一句「（这是占位，请改）」，
    免得 agent 把自己猜的内容当正式值写进去（那是猜的，不是事实）；
    没给 ⇒ 用默认那句。
    """
    text = str(value or '').strip()
    if not text:
        return PLACEHOLDER_DEFAULT
    if '占位' in text:
        return text[:200]
    return (text[:180] + '（' + PLACEHOLDER_DEFAULT + '）')[:200]


def _table_headers(value):
    """表头清单：去空白；**空表头/重名表头当场拒**（表头空着或重名，表就没法按列定位）。

    不传 ⇒ `[]`（老样子，一张空表）。
    """
    if value is None:
        return []
    if not isinstance(value, list):
        frappe.throw('表头必须是列名清单', frappe.ValidationError)
    names = [str(item or '').strip() for item in value]
    if any(not name for name in names):
        frappe.throw('表头不能为空，请给出每一列的名字', frappe.ValidationError)
    if len(set(names)) != len(names):
        frappe.throw('表头不能重名', frappe.ValidationError)
    if len(names) > 50:
        frappe.throw('表头最多 50 列', frappe.ValidationError)
    return names

# **系统路径自动填给调用者本人**（用户 2026-10-15：「算,要填,这个让尚书系统自动填就行」）。
#
# **人填和系统填是两条路，别搅在一起**：
#   · **人填**：`files.upload` / `files.create` —— 不传就拒（修法一）
#   · **系统填**：下面这个集合 —— 不传就自动填**调用者本人**
#
# **分界线不是「有没有归属选择器」**（第一版我这么写的，E 当场指出标准和结论对不上）。
# 按选择器判的话，邮件编辑器插图上传（`mail-editor.js`）**也没有**选择器，就该自动填；
# 可它不该 —— 两条都是「人点一下」，一个填一个不填，按选择器判会判反。
#
# **真正的分界**：**「归属是谁」这个动作，该不该当场产生业务决策。**
#   · **附件导入**（`files.import_attachment`）= 把信里的东西归档到文件中心，
#     归属天然跟**人**走 —— 谁点的归谁。**系统代填调用者本人**是对的。
#   · **上传 / 新建 / 编辑器插图** = 把东西放进文件库或写信流程的一步，
#     归属该跟着**这份东西/这封信**走 —— **前端该带**。漏了是前端的 bug，
#     不该由后端悄悄补（补了就把漏传藏起来，下次换个入口又漏一次）。
#
# **为什么 `files.import_attachment` 进这个集合**：它两个调用方（邮件管线
# `shangshu_mail.delivery` 自己推导归属传进来；邮件中心「存入文件中心」按钮只是触发归档）
# 都不产生「归属是谁」的业务决策，也不该被「不传就拒」拦住。
#
# **形状跟测试夹具 `_ss_fixture.FIXTURE_ATTRIBUTION` 一样**（`{'level':'personal'}`），
# 但这是**产品行为不是夹具兜底** —— 落下去的归属用户在页面上看得见、也算数。
#
# **放宽不是破坏**：以前不传 → 拒；现在不传 → 填给本人。老调用方照样能用，所以
# 不动动作版本号（schema 没变，变的是领域代码的判定）。
AUTO_ATTRIBUTION_ACTIONS = frozenset({'files.import_attachment'})


def _require_attribution(action_id, payload):
    """**入口先验**：新建必须有归属 —— 人填路径不传当场拒；系统路径不传自动填本人。

    **为什么不只靠 `_apply_attribution` 里那一句**（两个都是真的，各管一头）：

    1. **别把半成品留在库里** —— `upload`/`create` 是**先 `insert()` 再调
       `_apply_attribution``。等那儿再抛，文件行已经建了（靠整请求回滚收拾，
       太脆）。入口先验 = **一件都不建**。
    2. **别让旁因盖过主因** —— `import_attachment` 是**先查来源附件**再判归属；
       来源查不到就先炸「File xxx not found」，**缺归属那件事被盖住**。
       用户该先听见「不传归属不能建文件」，那是他能立刻改的。

    跟本文件 `mail_sys` 那条既有写法同一口径（「这两个系统字段**一进函数就校验**，
    不管后面走不走「已导入」那条早退」）：**必填的先验，不许被早退/查找绕过。**

    **自动填只在「确实没传」时补**，调用方已经给了就**不覆盖** —— 谁填的算谁的，
    系统不抢人填的那份。
    """
    if payload.get('attribution'):
        return
    if action_id in AUTO_ATTRIBUTION_ACTIONS:
        # 系统新建：不用人填，**系统自动填给调用者本人**（`_apply_attribution` 的
        # `level == 'personal'` 分支里 `owner_user` 省略 = 落调用者本人）。
        payload['attribution'] = {'level': 'personal'}
        return
    frappe.throw(NO_ATTRIBUTION, frappe.ValidationError)


def _apply_attribution(payload, doc):
    """建表归属（B2）：归属层级 **只有** personal / department，建不扩大别人的读写权。

    **`enterprise` 一律明确拒** —— 用户 **2026-10-15** 一句话定了：
    「**尚书是单例，没有企业归属。**」「你只要保证内核不乱跑就行」。
    这不是「选哪条」，是**那个桶压根不该存在**。

    **拒因必须点名用户原话**（`:data:`NO_ENTERPRISE``），不许用泛泛的「无效」——
    改完之后有人看报错，「无效」什么也说明不了；「尚书是单例，没有企业归属」
    直接把口径摆在那儿，不用再翻文档。

    **原先这里有一条 `else` 分支**：`level='enterprise'` 时把 department/owner_user
    **清成空**再落库 —— 那就是「传了不拦」的实现本体，已随本口径删掉。
    连同 `('personal','enterprise','department')` 三值枚举一起收成两值。

    建表权（契约 M1）：个人表只归本人（管理员可代办）；部门表须本人所属/管辖
    或拿到 create_grant。无权归属不可通过改请求选入。

    **新建必填**（用户 2026-10-15 选修法一）：不传 `attribution` 直接拒
    （:data:`NO_ATTRIBUTION``）。本函数只在**新建分支**被调，所以这一句天然只管新建 ——
    追版本/搬旧走 `existing` 分支、不碰归属，**自动豁免**。

    **不动存量**：库里已有的 `level='enterprise'` 行**不迁不动、列出来等人核**（用户
    2026-10-13 `账号与权限.md:192` 第 5 条「历史不明归属保持既有权限并待核」）——
    本函数只管**新建时不再产生**，不去翻旧账。
    """
    # ⚠️ 合并 fast 之后的口径校正：登记归属走**私有** org_admin（低层写入器），
    #   **不是** public_api.organization 的同名函数。
    #   公共 façade 那一层加了一道闸：「组织归属只能在**所属领域的受管写动作内**登记」
    #   （要求 frappe.flags.shangshu_call_domain ＋ shangshu_action_pin）。
    #   而建表这条路的**归属合法性由本函数自己判完**（建表权、层级、部门启用、create_grant），
    #   `upload` 也可以被域内直接调用（不经过动作派发、没有 action pin）⇒ 走 façade 会被无差别拒。
    #   私有 org_admin.attribution_record 的注释写的就是这个口径：
    #   「建表权/归属合法性由调用方（files.upload 的 _apply_attribution、resource_assign）按各自口径判完再调这里」。
    from shangshu_core import org_admin
    att = payload.get('attribution')
    if not att:
        # 兜底同一句话（正常路径已在三处 **insert 之前** `_require_attribution` 验过，这儿是
        # **给将来新加调用点**留的闸 —— 谁绕过入口直调本函数，照样拦得住）。
        # **新建必须落库归属**（用户 2026-10-15 选修法一「上传必填归属」）——
        # 堵的是「建了文件却没有归属」，不是「代码少写了一个参数」。
        #
        # **为什么落在这儿**：`_apply_attribution` 只在**三条新建分支**被调
        # （`upload` 在 existing 早退之后、`create`、`import_attachment` 在 `if not existing:` 内），
        # 所以这一句**天然只管新建** —— 追版本/搬旧走 `existing` 分支、压根不碰归属，
        # **自动豁免**，不用再开一个「搬旧不适用」的口子。
        #
        # **不给默认归属**（修法三）—— 用户已拒、B 也排除：那等于又发明一个归属。
        # 归属决定谁看得到，**猜错就是越权**。
        frappe.throw(NO_ATTRIBUTION, frappe.ValidationError)
    user = frappe.session.user
    level = str(att.get('level') or '').strip()
    department = str(att.get('department') or '').strip() or None
    owner_user = str(att.get('owner_user') or '').strip().lower() or None
    if level == 'enterprise':
        # 用户原话当拒因，别自造理由
        frappe.throw(NO_ENTERPRISE, frappe.ValidationError)
    if level not in ('personal', 'department'):
        frappe.throw('归属层级只能是 personal 或 department', frappe.ValidationError)
    if level == 'personal':
        owner_user = owner_user or user.lower()
        if owner_user != user.lower() and not _manager():
            frappe.throw('无权为他人建个人表', frappe.PermissionError)
        # **把 department 清掉** —— 跟下面 `department` 级清 `owner_user` 对称。
        # 原先不对称：personal 级不清 department，于是传了会原样落库，
        # 变成 `level='personal'` + `department=xxx` 的**脏形状**（A 2026-10-15 问到）。
        # 归属是三选一的**一层**，不是「个人+兼个部门」—— 留着 department
        # 下游判权会认错人（`download_allows`/`read_allows` 看 department）。
        department = None
    else:  # department
        if not department:
            frappe.throw('部门级归属必须指定部门', frappe.ValidationError)
        row = org_admin.department_row(department)
        if not row.enabled:
            frappe.throw('部门已停用，不能作为新的归属落点', frappe.ValidationError)
        if not _manager() and not org_admin.create_grant_allows(user, department):
            frappe.throw('无权在该部门建表（跨部门建表需先授权）', frappe.PermissionError)
        # Department owns the resource; owner_user is its current custodian.
        # Shared mailbox imports have no human creator/custodian by default.
        owner_user = None if payload.get('mail_system') else user.lower()
    org_admin.attribution_record(doc.name, level, department, owner_user)


def _attribution_of(doc_name):
    """从权威表读回归属，供回包出示。

    **回的是认定的事实，不是回声** —— 不回显调用方传了什么，回 `Shangshu Org
    Attribution` 里实际落的那一行。这样「落没落、落的什么键」在 HTTP 回包上就
    看得见，不用另开页面。无归属返回 None（存量/普通文件的既定语义，B6 兼容）。
    """
    from shangshu_core.public_api import organization as org_admin
    row = org_admin.resource_attribution(doc_name)
    if not row:
        return None
    return {'resource': row.get('resource'), 'level': row.get('level'),
            'department': row.get('department'), 'owner_user': row.get('owner_user')}


def upload(payload, attach_to=None):
    """放一份字节进文件中心（受管）。

    `attach_to` ＝ 那个 File 行**挂在哪条记录上**（默认：文件中心自己那条记录）。
    """
    import time as _time
    t_all = _time.perf_counter()
    timing = {}
    t0 = _time.perf_counter()
    safe = _safe_name(payload.get('file_name'))
    content, digest = _read_content(payload.get('content_base64'), payload.get('file_sha256'))
    if os.path.splitext(safe)[1].lower() == '.xlsx':
        # Validate the real workbook before any resource/File/version insertion.
        # Read mode deliberately keeps legal complex/formula workbooks admissible;
        # edit-only feature restrictions belong to the later write operation.
        from shangshu_files.sheet import safe_open
        try:
            workbook = safe_open(content, for_write=False)
            workbook.close()
        except frappe.ValidationError:
            frappe.throw('该文件不是可解析的 xlsx 工作簿，上传已拒绝，未创建文件', frappe.ValidationError)
    timing['read'] = (_time.perf_counter() - t0) * 1000.0
    t0 = _time.perf_counter()
    folder = directories.resolve(payload)
    directory = folder.path
    # 普通未声明新资源的上传保留内容去重；显式新建不能被hash命中绕过。
    # 不同来源即使字节相同也有独立权限/血缘；同源重投靠调用方稳定幂等键，
    # 不能把别的来源当重试，或把原资源的container_sha256改到新包。
    same_bytes = None
    if payload.get('new_resource') is not True:
        same_bytes = frappe.db.get_value(
            DOCTYPE, {'directory': directory, 'current_sha256': digest, 'status': 'Active'}, 'name')
    if same_bytes:
        doc = _writable(same_bytes)
        # ⚠️ **不追版本**：同一份字节再来一次**不是新版本**
        # （追了会出现「同一个文件有 N 个一样的内容」⇒ 人看着就是存了 N 遍）。
        # ⚠️ **血缘跟着当前内容走**（同上面那条规则：这份字节来自哪个包）。
        lineage = str(payload.get('container_sha256') or '')[:64]
        if lineage and doc.get('container_sha256') != lineage:
            doc.container_sha256 = lineage
            doc.save(ignore_permissions=True)
        return {'file': doc.name, 'version': doc.get('version_count') or 1, 'created': 0,
                'reused': True, 'attribution': _attribution_of(doc.name)}
    existing = frappe.db.get_value(DOCTYPE, {'directory': directory, 'file_name': safe, 'status': 'Active'}, 'name')
    if existing and (os.path.splitext(safe)[1].lower() == '.xlsx' or payload.get('new_resource') is True):
        # Host 等独立来源显式要求新资源时，同名也不能把旧引用追到新内容。
        # 普通文件未声明该选项时仍沿用下方显式版本链。
        # 表格资源同名上传恒为新表：不追旧版本、不接回原表、不继承绑定（Excel 交互契约 §2）。
        #
        # **合并说明（2026-10-21）**：fast 那条线在这条分支前面加了
        # `payload.get('new_resource') is True` 的闸 —— 意思是「xlsx 同名**默认追版本**，
        # 只有显式声明 new_resource 才另存新表」。**这条口径被我们线改回去了**，
        # 因为它跟**用户 2026-10-20 的原话**直接冲突：
        # 「这个 excel 以后会有版本的说法吗？不是只有多种表格吗？」——
        # 表格**没有版本**，只有多张表；同名上传就该是**新表**，不是「原表加个版本」。
        # 文件中心上传同名 xlsx 若默认追版本，用户会在表格上看见「版本 2」，
        # 正是他明确不认的那个概念（FIX-46 的示例文件库口径就建在这条规则上）。
        # `new_resource` 这个参数**保留**（Excel 域的「新建表格」入口在传，
        # 域内动作签名不动），但它不再是「恒为新表」的**前提** —— 现在是**默认口径**。
        safe = _unique_sheet_name(directory, safe)
        existing = None
    if existing:
        if payload.get('create_only') is True:
            frappe.throw('目录中已有同名文件，请修改新表格名称；不会覆盖已有文件', frappe.ValidationError)
        # 普通文件同目录同名重传：按需求保留历史版本，不无提示覆盖（文件库-05）。
        # （走到这里的一定不是 xlsx —— xlsx 在上面已经改名另存成新表了。）
        doc = _writable(existing)
        version_no = _append_version(doc, content, digest, payload.get('note'), attach_to=attach_to)
        # **血缘跟着当前内容走**（2026-10-22 第 1 步）：同名文件被另一个包再投一次
        # ⇒ 这一条记录的**当前版本**来自那个包 ⇒ 血缘要跟着更新，
        # 不许留着上一个包的摘要（那会把「这份字节来自哪个包」说错）。
        lineage = str(payload.get('container_sha256') or '')[:64]
        if lineage and doc.get('container_sha256') != lineage:
            doc.container_sha256 = lineage
            doc.save(ignore_permissions=True)
        return {'file': doc.name, 'version': version_no, 'created': 0,
                'attribution': _attribution_of(doc.name)}
    _require_attribution('files.upload', payload)   # **新建才要** —— 排在 insert 前，一件都不建
    doc = frappe.get_doc({
        'doctype': DOCTYPE,
        'file_name': safe,
        'directory': directory,
        'directory_id': folder.name,
        'tags_json': _dump(_normalize_tags(payload.get('tags'))),
        'note': str(payload.get('note') or '')[:500],
        'status': 'Active',
        'version_count': 1,
        # **血缘**（2026-10-22 第 1 步：包件交接）：这份字节来自哪个**原包**。
        # 成员靠它溯源到原包；`files.file` 数据集可按它筛 ⇒ 血缘可查。
        'container_sha256': str(payload.get('container_sha256') or '')[:64],
    }).insert(ignore_permissions=True)
    _apply_attribution(payload, doc)
    timing['meta'] = (_time.perf_counter() - t0) * 1000.0
    t0 = _time.perf_counter()
    version_no = _append_version(doc, content, digest, payload.get('note'), attach_to=attach_to)
    timing['version_write'] = (_time.perf_counter() - t0) * 1000.0
    if os.path.splitext(safe)[1].lower() == '.xlsx':
        # 上传预热（N2-B6）+ 首次清洗（R1，2026-10-13）：剔外链/批注进备注在上传后一次做完
        # （**原文件仍是第 1 版可下载**），此后格值写入走手术快路径。预热/清洗失败不拦上传——
        # 首次改格回落慢路径做同样的清洗。懒 import 避开 sheet↔service 循环。
        #
        # **合并说明（2026-10-21）**：fast 那条线把这里的清洗**删了**（「上传只读预热，
        # 保存原始字节；清洗只能在明确编辑后的新版本发生」）。两边不冲突的关键是
        # **原件与工作副本不是同一份字节**：
        #   · **原件（第 1 版）** = 上传进来的原始字节，`_append_version` 存的，**一个字节不动**
        #     （fast 的「preserve original files」照样成立）；
        #   · **工作副本** = `save_current` 写的**可变工作文件**（不进版本链），
        #     清洗（剔外链/外链公式固化/批注进备注）落在这一份上；
        #   · 版本链**不因上传多出一版**（`version_count` 不变）——
        #     fast 判据 `test_upload_preserves_original_bytes_and_existing_duplicate_version_semantics`
        #     的两条（`_content(doc)==上传字节`、`version_count==2`）照样成立：
        #     不需要清洗的簿，上传后当前字节与上传字节**逐字节相同**。
        # 不许改成「上传时把原件也清洗掉」——那会让用户下载到的原件不再是原件。
        from shangshu_files.sheet import process_upload, warm_parse
        t0 = _time.perf_counter()
        if not process_upload(doc, content, timing=timing):
            warm_parse(doc, content)
        timing['clean_warm'] = (_time.perf_counter() - t0) * 1000.0
    timing['total_ms'] = (_time.perf_counter() - t_all) * 1000.0
    return {'file': doc.name, 'version': version_no, 'created': 1, 'file_name': safe,
            'attribution': _attribution_of(doc.name),
            'upload_timing': {k: round(v, 1) for k, v in timing.items()}}


def _empty_workbook_bytes(file_name, headers=None, placeholder=None):
    """新建表的最小 xlsx：单工作表；表头（可选）＋前两行第一格的占位文字（可选）。

    **占位只写前两行第一格**（数据区第 2、3 行的 A 列）——
    让人一眼看见「这里还没填」，**其余格一律空着**：
    agent 猜出来的数据**不许**当正式值写进来（那是猜的，不是事实）。

    **表头不传时**保持老样子（A1 写「列1」）—— 老调用方（人填路径、既有脚本、
    夹具）照旧拿到同一张空表，**载荷形状没变**。
    """
    from openpyxl import Workbook
    stem = os.path.splitext(file_name)[0]
    for ch in '[]:*?/\\':
        stem = stem.replace(ch, ' ')
    stem = stem.strip()[:31] or 'Sheet1'
    wb = Workbook()
    sheet = wb.active
    sheet.title = stem
    columns = list(headers or [])
    if columns:
        for index, name in enumerate(columns, start=1):
            sheet.cell(row=1, column=index).value = name
    else:
        sheet.cell(row=1, column=1).value = '列1'
    if placeholder:
        sheet.cell(row=2, column=1).value = placeholder
        sheet.cell(row=3, column=1).value = placeholder
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def create(payload):
    """建表（R3）：**建表 ＋ 表头 ＋ 占位文字 ＋ 归属**，一次调用完成。

    同名恒新（独立文件资源，不覆盖旧表）；归属仍走 _apply_attribution（建表权
    不扩大）；返回 file_id 供前端直接打开。缺表名拒；不带合法后缀自动补 .xlsx。

    **表头（`headers`）与占位（`placeholder`）是可选的**（2026-10-21，agent 建表一线）：
    传了就一次建好（表头进第一行；占位写进**前两行第一格**），
    不传就是老样子（一张空表）—— **老调用方的载荷形状没变**。
    """
    raw = str(payload.get('file_name') or '').strip()
    if raw and os.path.splitext(raw)[1].lower() != '.xlsx':
        raw += '.xlsx'
    safe = _safe_name(raw)
    headers = _table_headers(payload.get('headers'))
    placeholder = None
    if payload.get('placeholder') is not None:
        placeholder = _placeholder_text(payload.get('placeholder'))
    folder = directories.resolve(payload)
    directory = folder.path
    if frappe.db.get_value(DOCTYPE, {'directory': directory, 'file_name': safe, 'status': 'Active'}, 'name'):
        safe = _unique_sheet_name(directory, safe)
    content = _empty_workbook_bytes(safe, headers, placeholder)
    digest = hashlib.sha256(content).hexdigest()
    _require_attribution('files.create', payload)   # **新建才要** —— 排在 insert 前，一件都不建
    doc = frappe.get_doc({
        'doctype': DOCTYPE,
        'file_name': safe,
        'directory': directory,
        'directory_id': folder.name,
        'tags_json': _dump(_normalize_tags(payload.get('tags'))),
        'note': str(payload.get('note') or '')[:500],
        'status': 'Active',
        'version_count': 1,
    }).insert(ignore_permissions=True)
    _apply_attribution(payload, doc)
    version_no = _append_version(doc, content, digest, payload.get('note'))
    # 同 upload：新建的表也要过一遍清洗（剔外链/批注进备注）并记 ss_clean，
    # 否则它的格值写永远回落整簿慢路径（手术路对不上资格）。
    from shangshu_files.sheet import process_upload, warm_parse
    if not process_upload(doc, content):
        warm_parse(doc, content)
    return {'file': doc.name, 'file_id': doc.name, 'version': version_no,
            'created': 1, 'file_name': safe, 'headers': headers,
            'placeholder': placeholder, 'attribution': _attribution_of(doc.name)}


def upload_version(doc):
    """**当前上传版本号** ＝ `version_count - 1`。

    ⚠️ `version_count` 存的是**下一个可分配号**，不是版本号 ——
    2026-10-21 用户在 3850 站失败的那条就是这个差一：助手把 `version_count`（2）
    当版本号传，而实际当前版本是 1 ⇒ 提案永远被判成过期。
    """
    return max(0, int(doc.version_count or 1) - 1)


def check_live_revision(doc, payload):
    """改格这条路的**前置条件**：当前上传版本号 ＋ 当前内容修订号（两个都要）。

    **为什么不用 `doc.modified`**：那是文件中心**记录**的修改时间 ——
    改文件名/备注这类**不改内容**的事也会推进它 ⇒ 内容没变的提案被误判成过期
    （2026-10-21 现场：1.xlsx 内容没变，却被判「提案对应的原始记录已更新」）。
    内容真变没变看**内容修订号**（工作副本与上传版本两条血脉共用这一个进位号）。

    **并发保护没有放宽**：上传版本被换掉（版本号变了）**或**内容被改过（修订号变了）
    ⇒ 一律拒。
    """
    from shangshu_files.working_file import content_revision
    version = payload.get('expected_version')
    revision = payload.get('expected_content_revision')
    if version is None or revision is None:
        frappe.throw('必须提供当前上传版本号（expected_version）与当前内容修订号（expected_content_revision）',
                     frappe.ValidationError)
    try:
        version, revision = int(version), int(revision)
    except (TypeError, ValueError):
        frappe.throw('上传版本号与内容修订号必须是整数', frappe.ValidationError)
    current_version = upload_version(doc)
    if version != current_version:
        frappe.throw('文件已被其他操作修改（当前上传版本 %d），请重新读取后核对' % current_version,
                     frappe.TimestampMismatchError)
    current_revision = content_revision(doc)
    if revision != current_revision:
        frappe.throw('文件内容已被其他操作修改（当前内容修订 %d），请重新读取后核对' % current_revision,
                     frappe.TimestampMismatchError)


def check_content_revision(doc, payload):
    # 在原父文件锁内核对，旧上传调用可省略；编辑器必须提交完整前置条件。
    if ('expected_version' in payload) != ('expected_modified' in payload):
        frappe.throw('内容版本与文件修订必须同时提供', frappe.ValidationError)
    if 'expected_version' in payload:
        from frappe.utils import get_datetime
        if payload['expected_version'] != int(doc.version_count or 1) - 1 \
                or not payload['expected_modified'] \
                or get_datetime(payload['expected_modified']) != get_datetime(doc.modified):
            frappe.throw('文件已被其他操作修改，请保留草稿并重新核对版本', frappe.TimestampMismatchError)


def new_version(payload):
    doc = _writable(payload.get('file'))
    check_content_revision(doc, payload)
    content, digest = _read_content(payload.get('content_base64'), payload.get('file_sha256'),
                                  allow_empty=os.path.splitext(doc.file_name)[1].lower() in {'.md', '.txt'})
    version_no = _append_version(doc, content, digest, payload.get('note'))
    return {'file': doc.name, 'version': version_no}


def update_meta(payload):
    doc = _writable(payload.get('file'))
    from frappe.utils import get_datetime
    if payload.get('expected_modified') and get_datetime(payload['expected_modified']) != get_datetime(doc.modified):
        # 带出**当前修订**给调用方重试（同 _check_versions 的口径：文案带「版本」+ 当前值）
        frappe.throw('文件已被其他操作修改（版本冲突：当前修订 %s），输入已保留，请重新读取后核对'
                     % (doc.modified,), frappe.ValidationError)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再修改信息', frappe.ValidationError)
    if 'file_name' in payload:
        doc.file_name = _safe_name(payload.get('file_name'))
    if 'directory' in payload or 'directory_id' in payload:
        folder = directories.resolve(payload)
        doc.directory, doc.directory_id = folder.path, folder.name
    if 'tags' in payload:
        doc.tags_json = _dump(_normalize_tags(payload.get('tags')))
    if 'note' in payload:
        doc.note = str(payload.get('note') or '')[:500]
    _check_location(doc)
    doc.save(ignore_permissions=True)
    from shangshu_files.domain import file_detail
    return {'file': doc.name, 'record': file_detail(doc)}


def _set_status(payload, status):
    doc = _writable(payload.get('file'))
    doc.status = status
    _check_location(doc)
    doc.save(ignore_permissions=True)
    return {'file': doc.name, 'status': status}


def recycle(payload):
    return _set_status(payload, 'Recycled')


def restore(payload):
    doc = _writable(payload.get('file'))
    from frappe.utils import get_datetime
    if payload.get('expected_modified') and get_datetime(payload['expected_modified']) != get_datetime(doc.modified):
        frappe.throw('文件已变化，请重新读取后确认恢复方式', frappe.TimestampMismatchError)
    explicit = 'keep_relations' in payload
    if explicit:
        if not payload.get('expected_modified'):
            frappe.throw('请重新读取文件后确认恢复方式', frappe.ValidationError)
        if not isinstance(payload['keep_relations'], bool):
            frappe.throw('请选择是否保留原业务关联', frappe.ValidationError)
        if doc.status != 'Recycled':
            frappe.throw('只能恢复回收站中的文件', frappe.ValidationError)
        # 与整份审核一致：撤权或停用目标不能被此入口静默解绑。
        from shangshu_core.public_api import get_object_record
        refs = json.loads(doc.relations_json or '[]')
        for ref in refs:
            get_object_record(ref['object_id'], ref['name'])
    doc.status = 'Active'
    _check_location(doc)
    previous = frappe.flags.shangshu_file_review_write
    try:
        if explicit and not payload['keep_relations']:
            doc.relations_json = '[]'
            frappe.flags.shangshu_file_review_write = True
        doc.save(ignore_permissions=True)
    finally:
        frappe.flags.shangshu_file_review_write = previous
    return {'file': doc.name, 'status': doc.status}


def _table_aggregate(payload, _context=None):
    """`files.table_aggregate`：统计一张表（普通 XLSX／数据库绑定表）。

    PKG-018-T06 第一阶段。**只读**：不写文件、不 bump 版本、不写 op 台账。
    懒加载（`table_analysis` → `sheet` → `service` 有环）。
    """
    from shangshu_files import table_analysis
    return table_analysis.aggregate(payload, _context)


def _range_read(payload, _context=None):
    """`files.sheet_range_read`：把只读范围读取**投影成动作**（T07 的 range_read 工具）。

    内核硬约束是「AI Tool 必须投影已注册 Action」，而 `files.sheet_read` 是**服务**，
    投影不了。所以开一个只读动作壳，**处理器就是 `files.sheet_read` 那个服务实现** ——
    不新增读逻辑、不改服务行为，只把签名从 `(service_id, payload, context)` 适配成
    动作的 `(payload, context)`。

    effect=read / confirm=none：读不需要幂等键、不需要确认卡。

    正式值与记录版本在 `sheet.read_payload` 内、复制日志之前统一合并，
    页面服务和动作读到同一份结果；此处不能再次读取或合并正式值。
    """
    from shangshu_files import sheet
    return sheet.read_payload('files.sheet_range_read', payload, _context)


def _cell_is_blank(cell):
    """这一格在工作簿里**本来就是空的**吗。

    「空」＝ 没有值（None／空串／纯空白）；**不是**「被权限挡住」。
    两种形状要分清：被挡住的格（`hidden`）值不给 ⇒ 那不是空，是**不给看**。
    """
    if not isinstance(cell, dict):
        return cell is None or cell == ''
    if cell.get('hidden') is True or cell.get('type') == 'hidden':
        return False
    if cell.get('type') == 'empty':
        return True
    value = cell.get('value')
    return value is None or (isinstance(value, str) and not value.strip())


def merge_range_read(result, payload, *, doc=None):
    """把读回来的行**合并**数据库正式值（只读，**不碰表数据**）。

    没有晋升定义的表**原样返回**（这张表本来就没有正式值可言）。
    合并口径与 `files.row_read` 同一份实现（`read_merge`）。
    """
    table = str((payload or {}).get('table') or '').strip()
    rows = (result or {}).get('rows')
    if not table or not isinstance(rows, list) or not rows:
        return result
    if doc is None:
        if not frappe.db.exists(DOCTYPE, table):
            return result
        doc = frappe.get_doc(DOCTYPE, table)
    from shangshu_files import promotion, read_merge
    definition = promotion.load_definition(doc)
    if not definition.get('promoted'):
        return result
    row_ids = [str(row.get('row_id') or '') for row in rows if row.get('row_id')]
    headers = set(header for row in rows for header in (row.get('values') or {}))
    fields = [col['field'] for col in promotion.promoted_columns(definition)
              if col.get('header') in headers]
    # —— **只对「有受管记录的行」取正式值**：历史缺映射的那几行（客户那张总表的
    #    r-015501／r-015502）**不进正式值范围** ⇒ 否则它们会把**整页读**堵死（表打不开）；
    #    那些行的晋升列下面明写「没有正式值」（hidden）——**不回落旧 xlsx 值**。
    managed_ids = set(promotion.managed_row_ids(doc, row_ids))
    state = promotion.formal_state_for_rows(doc, [r for r in row_ids if r in managed_ids], fields=fields)
    formal = state.get('values') or {}
    versions = state.get('versions') or {}
    promoted = read_merge.promoted_by_header(definition.get('columns') or [])
    # A clipped/absent official value never resurrects the previous XLSX value.
    rows = [dict(row, values=dict(row.get('values') or {})) for row in rows]
    for row in rows:
        rid = str(row.get('row_id') or '')
        if rid not in managed_ids:
            # 这一行**没有受管记录** —— 两种情况**要分开说**（2026-10-29 站上实测撞出来的）：
            #   · **工作簿里那格本来就是空的**（**新建的空行**）⇒ 显示**空格子**、许写。
            #     盖成「无权查看」的话，人**写不进去** ⇒ 受管记录也就永远建不出来
            #     ⇒ **自己把自己锁住**（建案这一步直接走不下去）。
            #   · **工作簿里那格有残留旧值**（历史缺映射）⇒ 仍然盖住，
            #     **不回落旧 xlsx 值**（这条规矩不许拆）。
            for header in row['values']:
                if not (promoted.get(header) or {}).get('field'):
                    continue
                if _cell_is_blank(row['values'][header]):
                    continue
                row['values'][header] = {'type': 'hidden', 'hidden': True, 'value': None}
            continue
        official = formal.setdefault(rid, {})
        for header in row['values']:
            field = (promoted.get(header) or {}).get('field')
            if not field or field in official:
                continue
            if versions.get(rid):
                row['values'][header] = {'type': 'hidden', 'hidden': True, 'value': None}
            else:
                official[field] = None  # Explicitly registered new draft row, already verified above.
    merged, _sources = read_merge.merge_rows(
        rows, formal,
        read_merge.promoted_by_header(definition.get('columns') or []))
    # **每行带上受管记录的版本**（客户端写回来时带上 ⇒ 服务端能拒陈旧写）。
    # 没有受管绑定的老表没有这个版本 ⇒ 不带（键也不给）。
    versions = state.get('versions') or {}
    for row in merged:
        version = versions.get(str(row.get('row_id') or ''))
        if version:
            row['record_version'] = version
    out = dict(result)
    out['rows'] = merged
    # 标出来：模型据此知道「这一列以数据库为准」，别再拿表里的旧值当答案。
    out['merged_read'] = True
    out['promoted_columns'] = [str(c.get('header') or '') for c in (definition.get('columns') or [])
                                if isinstance(c, dict) and c.get('promoted') and c.get('field')]
    return out


def _promotion_define(payload):
    from shangshu_files import promotion
    return promotion.define(payload or {})


def _promotion_rewrite(payload, _context=None):
    """**存量表按新模型整体重写**（PKG-117-T01）—— 重写的是**声明**，不是**效果**。"""
    from shangshu_files import promotion
    return promotion.rewrite(payload or {}, _context)


def _formal_value_write(payload, _context=None):
    from shangshu_files import promotion
    return promotion.formal_write(payload or {}, _context)


def _cell_write(payload, _context=None):
    from shangshu_files import promotion
    return promotion.cell_write(payload or {}, _context)


# 合并说明（2026-10-21，合并 fast 之后的语义修复）：
# 这六个动作合并前**只活在内联分支里**（`execute()` 里的一串 `if action == …`），
# **分发表里没有落点** —— 而动作登记判据（`tests/test_action_registry.py`）盯的是
# 「**在 domain.ACTIONS 注册了，就要在 SHEET_ACTIONS / HANDLERS / CTX_HANDLERS /
# INLINE_ACTIONS 里有一个落点**」，内联分支不算落点 ⇒ 这一族动作「一半在、一半不在」。
# 现在把它们**接到各自真正的处理器**上（fast 侧的实现原样接过来，不重写）：
#   files.sheet_structure    → sheet_operations.structure   （插删行列）
#   files.sheet_style        → sheet_operations.style_cells  （选区格式）
#   files.edit_paragraphs    → paragraphs.edit               （DOCX 普通正文）
#   files.edit_cells         → cells.edit                    （自由工作簿逐格）
#   files.action_fact        → facts.action_fact             （动作事实上报）
#   files.action_fact_query  → facts.action_fact_query       （动作事实查询）
# 后两个在**本分支**原本放在 HANDLERS 里（合并时被内联分支顶掉了），这里放回分发表。
def _sheet_structure_action(payload, _context=None):
    from shangshu_files import sheet_operations
    return sheet_operations.structure(payload or {}, _context)


def _sheet_style_action(payload, _context=None):
    from shangshu_files import sheet_operations
    return sheet_operations.style_cells(payload or {}, _context)


def _edit_paragraphs_action(payload, _context=None):
    from shangshu_files import paragraphs
    return paragraphs.edit(payload or {})


def _edit_cells_action(payload, _context=None):
    from shangshu_files import cells
    return cells.edit(payload or {}, _context)


def _action_fact_action(payload, _context=None):
    from shangshu_files import facts
    return facts.action_fact(payload or {}, _context)


def _action_fact_query_action(payload, _context=None):
    from shangshu_files import facts
    return facts.action_fact_query(payload or {}, _context)


# 需要 `_context`（幂等键 / 操作台账）的领域动作。HANDLERS 里那批都是单参，
# 这里单开一张表，免得为一个动作去改一排既有签名。
#
# **写入口已合成**（用户 2026-10-15「合成吧，这样后面好维护」）：
# `files.cell_write` 与 `files.sheet_cell_write` **同一个实现** `promotion.cell_write`
# —— 一个口、一套闸、一套校验。**理由不是「两个按钮重复」**，是**写入不该被晋升的权限拖累**
# （用户原话：「要区分的是：**晋升字段这个动作和写入这个动作**」）：
#   · **晋升**（把一列变成数据库字段、定规矩）= 管理员的活，偶尔做，改**结构**
#   · **写入**（往格子里填值）= 有写权的人的活，天天做，改**内容**
# 把「往有字段的列里写值」当成「晋升」，才是那个洞的根子：能校验的入口被锁成
# System Manager，普通员工进不去，只能走不过校验的口。
# 老口保留（**同实现**，不是两条路）—— A/C 现有调用不 404。
CTX_HANDLERS = {
    'files.cell_write': _cell_write,
    'files.sheet_cell_write': _cell_write,
    # 合并说明（2026-10-21）：这六个动作合并前**只活在内联分支里**，分发表没有落点
    # ⇒ 动作登记判据判它们「注册了没落点」。现在接到它们**真正的处理器**上，
    # 两套动作族（我们的 `files.sheet_row_insert`／`files.sheet_style_write`… 与
    # fast 的 `files.sheet_structure`／`files.sheet_style`…）**都活**，谁也不删。
    'files.sheet_structure': _sheet_structure_action,
    'files.sheet_style': _sheet_style_action,
    'files.edit_paragraphs': _edit_paragraphs_action,
    'files.edit_cells': _edit_cells_action,
    'files.action_fact': _action_fact_action,
    'files.action_fact_query': _action_fact_query_action,
}


def sheet_snapshot(payload, _context=None):
    """`files.sheet_snapshot`：把一张表的**当前版本**复制成新的文件中心快照（固定引用）。

    **产品语义**（E 2026-10-17 口径）：
      · 导出资格 = `domain.file_detail(doc)['can_download']` —— 与下载按钮**同一口径**，
        **不自己再算一遍字段 ACL**（`can_download` 已含字段可读）；
      · 快照归属 = **发起人个人**（不沿用原表归属）；
      · **必须写 relations 指向原表** —— (a)/(b)/(c) 三种「撤原表权后快照是否有效」的
        语义都靠它；本版**不写死**跟随原表读权的强制逻辑（等用户拍）；
      · 同步执行：纯字节拷贝（取当前版本 + 建 File + 登记），不解析不校验，
        9.7MB 实测这一路远低于 POST 超时，不需要排队。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    doc = frappe.get_doc(DOCTYPE, table)
    from shangshu_files import domain as _domain
    detail = _domain.file_detail(doc)
    if not detail.get('can_download'):
        # 只读/无下载权/字段不可读（can_download 已含字段 ACL）→ 明确拒。
        frappe.throw('没有导出该表的权限（需要下载权）', frappe.PermissionError)
    version = max(0, int(doc.version_count or 1) - 1)
    expected = payload.get('expected_content_version')
    if expected is not None and int(expected) != version:
        frappe.throw('表已更新（版本冲突：当前 content=%d），请刷新后重试' % version,
                     frappe.ValidationError)
    from shangshu_files.sheet import _content as _sheet_content
    content = _sheet_content(doc, for_write=False)
    folder = directories.resolve({'directory': '/'})
    base = os.path.splitext(doc.file_name or table)[0]
    stamp = frappe.utils.now_datetime().strftime('%Y%m%dT%H%M%S')
    safe = _safe_name('%s-v%d-%s.xlsx' % (base, version, stamp))
    safe = _unique_sheet_name(folder.path, safe)
    relations_list = [{'object_id': 'files.file', 'name': table}]
    # `relations_json` 的字段守卫只允许**受管审核动作**写（防客户端伪造关联）。
    # 本动作就是受管动作：只为写「快照 → 源表」这一条关联，临时放行后恢复。
    _prev_flag = getattr(frappe.flags, 'shangshu_file_review_write', False)
    frappe.flags.shangshu_file_review_write = True
    try:
        new = frappe.get_doc({
            'doctype': DOCTYPE,
            'file_name': safe,
            'directory': folder.path,
            'directory_id': folder.name,
            'note': '表格快照（源 %s v%d）' % (table, version),
            'status': 'Active',
            'version_count': 1,
            'relations_json': _dump(relations_list),
        }).insert(ignore_permissions=True)
    finally:
        frappe.flags.shangshu_file_review_write = _prev_flag
    # 发起人个人归属：`_apply_attribution` 走与建表同一套（个人表只归本人）。
    _apply_attribution({'attribution': {'level': 'personal'}}, new)
    digest = hashlib.sha256(content).hexdigest()
    _append_version(new, content, digest, '快照 from %s v%d' % (table, version))
    file_ref = frappe.db.get_value(
        'File',
        {'attached_to_doctype': DOCTYPE, 'attached_to_name': new.name},
        'name', order_by='creation desc')
    return {
        'file': file_ref,
        'lib': new.name,
        'file_name': safe,
        'content_version': version,
        'sha256': digest,
        'size': len(content),
        'relations': relations_list,
        'attribution': _attribution_of(new.name),
        'snapshot_of': table,
        'snapshot_version': version,
    }


def upload_attached(payload):
    """`files.upload_attached`：放字节 ＋ **把那个 File 行挂到指定记录上**。

    **为什么要有这个口**（2026-10-22 · PKG-036-T04，收口「收信附件自己建 File」那处限期豁免）：
    · 字节**必须**由文件域放（契约「所有进尚书的文件都进文件中心」）；
    · 但那封信上的附件**还要能按这封信的归属取字节**（读信面按这封信取附件；正文 `cid:` 解析得出图）
      ⇒ 那个 File 行**得挂在那封信上**；
    · 以前这两件事只能由**邮件域自己建 File**来同时满足 ⇒ 那就是「绕过文件中心」。

    ⚠️ **权限**：调用方必须**读得到**那条记录（`can_read_reference`）——
    不许把文件挂到别人的记录上（挂上去就等于把字节送到他眼前）。
    """
    from shangshu_core.public_api import can_read_reference

    payload = payload or {}
    target = payload.get('attach_to') or {}
    doctype = str(target.get('doctype') or '').strip()
    name = str(target.get('name') or '').strip()
    if not doctype or not name:
        frappe.throw('要挂到哪条记录上说清楚（attach_to）', frappe.ValidationError)
    if not can_read_reference(doctype, name):
        frappe.throw('没有那条记录的读权，不能把文件挂上去', frappe.PermissionError)
    result = upload(payload, attach_to=(doctype, name))
    result['attached_to'] = {'doctype': doctype, 'name': name}
    # 那个 File 行的编号（**挂在目标记录上的那一份**）—— 调用方要靠它取字节。
    result['attached_file'] = str(
        frappe.db.get_value(DOCTYPE, result.get('file'), 'current_file') or '')
    return result


def _package_store(payload):
    """按包存成员 ＋ 广播成员清单（懒加载：避开与 packages 模块的循环导入）。"""
    from shangshu_files import packages

    return packages.store_package(payload)


def _attachment_bindings():
    """**文件 ↔ 文件附件绑定**（懒加载：避开与 attachment_bindings 模块的循环导入）。"""
    from shangshu_files import attachment_bindings

    return attachment_bindings


HANDLERS = {
    'files.sheet_range_read': _range_read,
    # PKG-047-T01（契约 §8 第 13 项）：文件 ↔ 文件附件绑定口（父件侧零改动）。
    'files.attachment.bind': lambda payload: _attachment_bindings().bind(payload),
    'files.attachment.list': lambda payload: _attachment_bindings().list_of(payload),
    # PKG-018-T06 第一阶段：表格分析（普通 XLSX／数据库绑定表）。
    # **只读**：不写文件、不 bump 版本、不写 op 台账。
    'files.table_aggregate': _table_aggregate,
    'files.sheet_snapshot': sheet_snapshot,
    'files.import_attachment': import_attachment,
    'files.upload': upload,
    # 包件交接第 1 步：按包存成员 ＋ 广播成员清单（**文件域这一侧**）。
    'files.package.store': _package_store,
    # PKG-036-T04：放字节 ＋ 挂到指定记录上（收掉「收信附件自己建 File」那处豁免）
    'files.upload_attached': upload_attached,
    'files.create': create,
    'files.new_version': new_version,
    'files.update_meta': update_meta,
    'files.recycle': recycle,
    'files.restore': restore,
    'files.directory_create': directories.create,
    'files.directory_rename': directories.rename,
    'files.directory_access': access.configure,
    # PKG-004 / D-a：晋升定义（FDE 受管入口，角色卡在 domain 注册处）
    'files.promotion_define': _promotion_define,
    # PKG-117-T01：存量表按新模型**整体重写**已生效的权限声明
    'files.promotion_rewrite': _promotion_rewrite,
    'files.formal_value_write': _formal_value_write,
}

# sheet 写/结构动作 → sheet.py 函数名；懒加载避免与 service 循环导入。
# ⚠️ **`files.sheet_cell_write` 不在这里** —— 已合成进 CTX_HANDLERS（同 `files.cell_write`）。
# `sheet.write_cell` 现在是**内部的「存进表」机械动作**（合成口的普通列分支调它），
# 不再是动作处理器。
SHEET_ACTIONS = {
    'files.sheet_input_write': 'input_write',
    'files.sheet_sort': 'sheet_sort',
    'files.sheet_cells_write': 'write_cells',
    'files.sheet_cells_undo': 'undo_cells',
    'files.sheet_style_write': 'write_style',
    'files.sheet_layout_update': 'update_layout',
    'files.sheet_row_heights_write': 'update_row_heights',
    'files.sheet_row_move': 'row_move',
    'files.sheet_column_move': 'column_move',
    'files.sheet_row_restore': 'row_restore',
    'files.sheet_row_insert': 'row_insert',
    'files.sheet_row_delete': 'row_delete',
    'files.sheet_column_insert': 'column_insert',
    'files.sheet_column_delete': 'column_delete',
    'files.sheet_row_append': 'row_append',
    'files.sheet_column_append': 'column_append',
    'files.sheet_header_rename': 'header_rename',
    'files.sheet_rename': 'table_rename',
    'files.sheet_paste_apply': 'paste_apply',
    # 第四批成包编辑：查找替换 / 填充序列 / 选择性粘贴（一次成包写、一步撤回）
    'files.sheet_find_replace': 'find_replace',
    'files.sheet_fill_series': 'fill_series',
    'files.sheet_paste_special': 'paste_special',
}

# **批量用户口** —— 这两个是「人一次写多格」。009 边界只挡它们，
# **不挡后端回填 `_writeback`**（它就往有字段的列写字，挡它等于自杀）。
def replay_guard(payload):
    """重放守卫（B5，公共入口在同键重放取旧结果前调用）：按当前权限复核。

    撤权/调岗后，旧回执不能换出带格值的旧结果（M7 缺口）——重放载荷与原请求指纹
    一致（核心断言绑定保证），这里只判「现在还有没有读权」。无权 → 权限错整请求拒。
    """
    table = str((payload or {}).get('table') or '')
    if not table or not frappe.db.exists(DOCTYPE, table):
        frappe.throw('原文件已不可访问，不能读取旧回执',frappe.PermissionError)
    frappe.get_doc(DOCTYPE, table).check_permission('read')


def proposal_snapshot(action_id, payload, purpose, snapshot=None):
    """Pin table definition at proposal creation; reject semantic drift before writes."""
    if purpose not in ('capture', 'validate', 'inspect'):
        frappe.throw('未知提案快照用途', frappe.ValidationError)
    value = payload if isinstance(payload, dict) else {}
    table = value.get('table')
    if not table:
        return None
    # This row lock is held through the registered write. A concurrent definition
    # save cannot pass between validation and mutation.
    doc = frappe.get_doc(DOCTYPE, str(table), for_update=purpose != 'inspect')
    doc.check_permission('read')
    from shangshu_files import promotion
    meta = promotion._load_meta(doc)
    definition = meta.get('promotion') or {}
    current = {
        'version': 1,
        'table': str(table),
        'definition_sha': promotion._definition_fingerprint(meta),
        'structure_version': int(meta.get('structure_version') or 1),
        'bound_structure_version': definition.get('structure_version'),
    }
    if purpose == 'capture':
        if action_id in ('files.sheet_cells_write', 'files.sheet_cell_write', 'files.cell_write'):
            # Return field-rule errors to the Agent before a confirmation card is
            # persisted. This is the same read-only package validator used by
            # saving: per-header write checks, per-value rules, no record/file IO.
            cells = value.get('cells') if action_id == 'files.sheet_cells_write' else [value]
            items = [{'header': cell.get('header'),
                      'value': None if (cell.get('value') or {}).get('type') == 'empty'
                      else (cell.get('value') or {}).get('value')}
                     for cell in cells or []]
            promotion.require_package_rules_ok(doc, items, definition=definition)
        return current
    if not isinstance(snapshot, dict) or snapshot.get('version') != 1:
        frappe.throw('旧提案没有创建时的字段定义快照，请重新提议；本次未保存', frappe.TimestampMismatchError)
    if snapshot != current:
        frappe.throw('字段定义或表结构已变化，请重新核对并提议；本次未保存', frappe.TimestampMismatchError)
    return current


def proposal_guard(action_id, payload, purpose, actor_user):
    """提案展示/裁决**沿原文件权限**；`actor_user` 只由内核提案记录传入。

    基线内核有、重做内核时丢了 —— G3（逐项审核）的 `/review` 读口和确认执行都要过这道。
    **读**按当前读权；**裁决**按既有组织/编辑共享写权（管理读不等于编辑）。
    """
    if purpose not in ('read', 'resolve'):
        frappe.throw('未知的提案权限检查类型', frappe.ValidationError)
    value = payload if isinstance(payload, dict) else {}
    target = value.get('table') if action_id.startswith('files.sheet_') or action_id in (
        'files.cell_write', 'files.formal_value_write', 'files.promotion_define',
        'files.promotion_rewrite') else value.get('file')
    if target:
        if purpose == 'resolve':
            _writable(target)  # 当前读权 + 既有组织/编辑共享写权；管理读不等于编辑。
        else:
            frappe.get_doc(DOCTYPE, str(target)).check_permission('read')
        return
    if action_id == 'files.create':
        # 尚无正式资源，不能按审核人猜测「新表归我」；仅原发起人或原系统管理者。
        if frappe.session.user != actor_user and not _manager():
            frappe.throw('无权查看或处理其他员工尚未创建的表格提案', frappe.PermissionError)
        directories.resolve(value)
        return
    if action_id == 'files.import_attachment':
        from shangshu_core.public_api import get_record_attachments
        source = value.get('source') or {}
        if not all(source.get(key) for key in ('ref_doctype', 'ref_name', 'file')):
            frappe.throw('附件提案缺少可核对的来源', frappe.PermissionError)
        get_record_attachments(source['ref_doctype'], source['ref_name'], [source['file']])
        directories.resolve(value)
        return
    frappe.throw('提案缺少可核对的文件或表格目标', frappe.PermissionError)


def execute(action, payload, _context):
    if action in ('files.table_relation_define','files.table_relation_set','files.table_relation_remove'):
        from shangshu_files import table_relations
        return {'files.table_relation_define':table_relations.define,'files.table_relation_set':table_relations.set_link,'files.table_relation_remove':table_relations.remove}[action](action,payload,_context)
    if action == 'files.sheet_structure_undo':
        from shangshu_files.sheet_structure import undo
        return undo(payload or {}, _context)
    if action == 'files.sheet_view_save':
        from shangshu_files.sheet_view import save_view
        return save_view(payload or {}, _context)
    # 合并说明（2026-10-21，合并 fast 之后的语义修复）：
    # 原先这里还有四段内联分支 ——
    #   `files.sheet_structure`／`files.sheet_style`（走 `sheet_operations`）、
    #   `files.action_fact`／`files.action_fact_query`（走 `facts`）、
    #   `files.edit_paragraphs`／`files.edit_cells`（走 `paragraphs`／`cells`）。
    # 它们**都搬进 CTX_HANDLERS 了**（见那里的合并说明）：内联分支不算分发表里的落点，
    # 动作登记判据（`tests/test_action_registry.py`）判它们「注册了没落点」。
    # **行为不变** —— CTX_HANDLERS 那条路同样先 `directories.lock_tree()` 再调同一个实现。
    #
    # `files.sheet_sort` **两边都留**（载荷形状不同，语义映射见 `sheet.sheet_sort`）：
    # 我们的前端发 `column` + `identity_only`（只排视图、不动文件行），
    # fast 那条线发 `header`（整表落盘、移动整行）。
    if action == 'files.review':
        from shangshu_files.review import save
        directories.lock_tree()
        return save(payload, _context)
    if action in SHEET_ACTIONS:
        from shangshu_files import sheet
        directories.lock_tree()
        try:
            from shangshu_files.sheet_structure import ACTIONS, execute as execute_structure
            handler = getattr(sheet, SHEET_ACTIONS[action])
            if action in ACTIONS:
                return execute_structure(action, payload or {}, _context, handler)
            return handler(payload or {}, _context)
        except frappe.UniqueValidationError:
            frappe.throw('文件位置或版本已被其他操作占用，请刷新核对后重试；本次没有覆盖已有文件。', frappe.ValidationError)
    handler = HANDLERS.get(action)
    if not handler:
        ctx_handler = CTX_HANDLERS.get(action)
        if not ctx_handler:
            frappe.throw('未知动作：' + str(action), frappe.ValidationError)
        directories.lock_tree()
        return ctx_handler(payload or {}, _context)
    try:
        directories.lock_tree(exclusive=action.startswith('files.directory_'))
        return handler(payload or {})
    except frappe.UniqueValidationError:
        frappe.throw('文件位置或版本已被其他操作占用，请刷新核对后重试；本次没有覆盖已有文件。', frappe.ValidationError)


def _name_filter(names, inclusive):
    """把资源名集拼成 SQL 片段。inclusive=True → name in (...)；False → not in (...)。"""
    col = '`tabShangshu File Center File`.`name`'
    if not names:
        return '1=1' if not inclusive else '1=0'
    joined = ','.join(frappe.db.escape(n) for n in names)
    return '%s %s (%s)' % (col, 'in' if inclusive else 'not in', joined)


def source_readable_resources(user):
    """**来源当前可读的资源名集**（收信附件那类「有来源关联」的）。

    与 `has_permission` 的来源分支**同一口径**：来源读权 ∪ 管理默认读权。
    **列表那条 SQL 过滤链此前完全没有这一路** → 结果是
    「**点得开、列表里看不见**」，两边对不上（实测：单条 `has_permission` 回 true，
    `files.file` 数据集查 0 条）。

    ⚠️ **为什么走 `_name_filter` 而不是「先取全集再前端过滤」**：
    口径 `账号与权限.md:189`「**先授权，再筛选**……**不得先返回全部文件再用前端过滤**」。
    所以这里是**在服务端把可读集算出来再进 SQL**，不是拿全量给前端挑。
    """
    out = []
    for name in frappe.get_all(DOCTYPE, filters={'related_mail': ['is', 'set']},
                               pluck='name', limit=10000):
        try:
            doc = frappe.get_doc(DOCTYPE, name)
        except Exception:
            continue
        if _source_read_allows(user, doc) is not False:   # None = 没来源，不归这路管
            out.append(name)
    return out


def permission_query(user=None):
    """清单/计数/搜索同一套校验（B3）：有组织归属走组织判定，无归属走旧目录授权。

    与 has_permission 同一口径——撤权/调岗后旧列表不能借旧权限看到（M8）。
    无归属那条里另含部门归属的默认读（乙）—— 否则**直开读得到、列表里看不见**，
    两边对不上。见 `has_permission` 的同名规则。

    **有来源关联的资源另加一路**（BASE967-38 / 口径 `:189`「先授权，再筛选」）：
    来源当前可读 → 也要在列表里看得见。**不加这路就是「点得开、列表里没有」**。
    """
    user = user or frappe.session.user
    business_access.require_identity(user)
    if business_access.is_open(user):
        return business_access.file_query_condition(DOCTYPE, user)
    from shangshu_core.public_api import organization as org_admin
    escaped = frappe.db.escape(user)
    if 'System Manager' in frappe.get_roles(user):
        legacy = '(1=1)'  # 旧口径：SM 对无归属资源全可见（存量行为）
    else:
        legacy = '(' + access.query_condition(DOCTYPE, 'directory_id', user) + ") AND ((`tabShangshu File Center File`.`status` = 'Active') or (`tabShangshu File Center File`.`owner` = {0}))".format(escaped)
        # 部门归属的默认读（乙）：本部门的人也看得到 —— **在目录门之外另开一条**，
        # 不是替换目录 ACL。只对无归属资源生效，与 `has_permission` 的分支顺序一致
        # （那边是「先归属、后部门、再目录」，这里对应的 SQL 是 OR 进 legacy）。
        mine = _user_department(user)
        if dept_read_default() == 'open' and mine:
            dept = frappe.db.escape(mine)
            legacy += (" OR ((`tabShangshu File Center File`.`owner_subject_kind` = 'Department')"
                       " AND (`tabShangshu File Center File`.`owner_subject` = %s))" % dept)
    attributed = org_admin.all_attribution_resources()
    if not attributed:
        return legacy
    readable = org_admin.org_readable_resources(user)
    in_attr = _name_filter(attributed, True)
    not_attr = _name_filter(attributed, False)
    in_ok = _name_filter(readable, True)
    # 归属资源：当前组织判定或来源当前可读；历史创建人不是独立授权。
    from_src = _name_filter(source_readable_resources(user), True)
    return ('((%s) and ((%s) or (%s)))'
            ' or ((%s) and %s)') % (
        in_attr, in_ok, from_src, not_attr, legacy)


# ── 部门归属的默认读规则 ────────────────────────────────────────────
# 用户 2026-10-14 原话：
#   「我建议是这样，你目前用的是甲的方案，但是默认值设置为乙就行，都可读不就行了嘛」
#
# 落地：**默认值 = 乙（同部门可读），架构 = 甲（可收紧）**。
# 这个开关就是「留收紧口子」那一层 —— 将来收紧只是把下面这行换成 'closed'，
# 不重写、不迁数据、不动别的规则。
#
#   'open'   = 乙：部门归属的资源，本部门的人可读（**当前默认**）
#   'closed' = 甲：部门归属只作显示/筛选，不给读权（收紧后）
DEPT_READ_DEFAULT = 'closed'  # 接入不扩大存量文件访问权；部门默认共享须另行明确授权。


def dept_read_default():
    """取当前的部门默认读规则。**收紧只换这一个值。**"""
    return DEPT_READ_DEFAULT


def _user_department(user):
    """这个人属于哪个部门。

    现有字段是 `Shangshu Identity.collaboration_group`（协作分组）。
    组织表（部门/成员）在 Excel 那条分支，合过来之后**自动换过去**，
    调用方不用改 —— 这里只认「同一个部门标识」。

    没填分组的人返回空 —— **不默认放行**（宁可严一点，不默认全开）。
    """
    if not user:
        return ''
    # 合并说明：fast 那边走 `organization.user_department(user)`，本分支走
    # `identity_department(user)` —— **两者读的是同一个字段**
    # （Shangshu Identity.collaboration_group），只是入口不同。取本分支的公共入口。
    from shangshu_core.public_api import identity_department
    row = identity_department(user)
    return (row or '').strip()


def _dept_allows(user, doc):
    """部门归属的资源，本部门的人可读吗？

    三条一起成立才放：
      1. 规则当前是 'open'（乙）—— 收紧成 'closed' 这里就直接不放
      2. 这条资源确实是**部门归属**（不是个人/空）
      3. 这个人的部门和资源的部门**对得上**（没填分组的人对不上，不放）

    ⚠️ **判定源搬进内核映射**（PKG-013-T02 / D 半，B 2026-10-15 定的三条答案）：
    先前**自己判** `owner_subject_kind == 'Department'`，跟内核那套
    （`map_owner_subject` 的 `Employee→personal` / `Department→department`）
    **各写一份** —— 撤了遗留字段就烂（契约 §3.5.3：「只换人侧会看起来修好其实还烂」）。
    现在**调内核公共映射**（`809fd179`，**不各写一份**）翻译，再判。

    ⚠️ **`map_owner_subject` 只管「字段怎么对应」，不管「谁能看」**（它 docstring 写死）——
    所以判定权仍在这儿（「本部门可读」是乙口径的**文件域规则**，不是内核通用规则）。
    **不缓存**（B：谁加缓存谁就把撤权弄没了）。

    ⚠️ **遗留字段那套还留着**（本函数仍读 `doc.owner_subject_*`）——
    **因为还有 383 行老数据没迁进内核归属**（2026-10-15 实查）。
    **数据迁完（`migrate_legacy_attribution`）才删本函数。**
    **没一次性搬完，如实记**：数据迁移要动真实数据，**等用户批**。
    """
    if dept_read_default() != 'open':
        return False
    from shangshu_core.public_api import map_owner_subject
    try:
        level, want, _owner = map_owner_subject(doc.get('owner_subject_kind'),
                                                doc.get('owner_subject'))
    except Exception:
        # **类型/ID 不合法（如 `Ghost`）→ 明确不放**，不猜、不兜底、不发明第三种归属
        # （`map_owner_subject` 的边界）。
        return False
    if level != 'department':
        return False
    if not want:
        return False
    mine = _user_department(user)
    return bool(mine) and mine == want


def _source_links(doc):
    """这份资源的**来源关联**。空列表 = 没有来源（普通上传的文件）。"""
    rels = relations.links(doc) if hasattr(doc, 'get') else []
    legacy = str(doc.get('related_mail') or '').strip() if hasattr(doc, 'get') else ''
    if not rels and legacy:
        # 遗留字段还没迁进通用 `relations` 的那批（`relations.migrate_legacy` 用的就是
        # `mail.message` 这个对象 id）—— 两条路都认，不留缝。
        rels = [{'object_id': 'mail.message', 'name': legacy}]
    return rels


def _management_read_only(user, attribution):
    """**管理默认读**，**不含「同部门成员自动可读」**。

    ⚠️ **不能拿 `org_admin.default_read_allows` 顶** —— 那个函数里有
    `if dept in ctx["member_of"]: return True`，**正是「部门所有人自动获读权」**。
    口径 `#mail-attachment-access` 第 1 条明写：
    「**部门所有人不等于部门所有员工自动获读权**」。
    第一版就栽在这：嘴上说「不含部门成员默认读」，调的却是包含它的那个函数 →
    同部门的人照样过，反例没关住。

    只认两种：**老板**（`owned_enterprises`）、**负责人**（`head_departments`，含下属）。

    ⚠️ **实现在内核**（`org_admin._management_read_only`）—— §13 只留一份。
    本函数是**转发**，别在这儿再写一遍（写两遍迟早漂，撤权时一边新一边旧）。
    """
    from shangshu_core import org_admin
    return org_admin._management_read_only(user, attribution)


def _doctype_of(object_id):
    from shangshu_core.public_api import reference_doctype
    return reference_doctype(object_id)


def _source_read_allows(user, doc):
    """**来源的当前读权**（口径 `账号与权限.md` §`#mail-attachment-access` 第 1 条）。

    > 自动入库的附件**按来源邮箱/邮件附件的当前读取授权**……
    > **文件中心不能成为读取无权邮件附件的旁路**。
    > 共享邮箱授予的读取权须在文件入口生效，**部门所有人不等于部门所有员工自动获读权**。

    **单向**：附件可见范围**跟随来源**（丢来源 → 丢附件），
    但关联**不反过来**给来源读权（第 4 条「关联不自动授权」）。

    回 `True` / `False`；**没来源时回 `None`**（调用方走原来的归属那套，不改存量语义）。
    """
    business_access.require_identity(user)
    trial = business_access.resource_decision(doc.name, user, owner=doc.owner)
    if trial is not None:
        return trial
    rels = _source_links(doc)
    if not rels:
        return None
    from shangshu_core.public_api import can_read_reference
    for rel in rels:
        obj_id, name = str(rel.get('object_id') or ''), str(rel.get('name') or '')
        if not obj_id or not name:
            continue
        doctype = _doctype_of(obj_id)
        if not doctype or not can_read_reference(doctype, name):
            return False
    return True


def has_permission(doc=None, ptype='read', user=None):
    """读/写统一校验（B3）：有组织归属走组织事实（含 System Manager——
    角色不自动等于老板读权，用户 2026-10-12④）；无归属走旧目录授权（B6 兼容）。"""
    user = user or frappe.session.user
    business_access.require_identity(user)
    if doc is None:
        return True
    trial = business_access.resource_decision(doc.name, user, owner=doc.owner)
    if trial is not None:
        return trial
    from shangshu_core.public_api import organization as org_admin
    att = org_admin.resource_attribution(doc.name)

    # ---- 收信附件（有来源）：跟随来源 ----
    src = _source_read_allows(user, doc)
    if src is not None:
        if ptype != 'read':
            return False if not src else bool(att and org_admin.write_allows(user, doc.name, att))
        if src:
            return True
        # 来源没权 → 只剩**管理默认读权**。
        # ⚠️ **不是 `org_admin.default_read_allows`** —— 那个含「部门成员自动可读」，
        # 正是口径要禁的那条。用 `_management_read_only`。
        return bool(att and _management_read_only(user, att))

    if att:
        if ptype == 'read':
            return bool(org_admin.read_allows(user, doc.name, att))
        return bool(org_admin.write_allows(user, doc.name, att))
    if 'System Manager' in frappe.get_roles(user):
        return True
    # 部门归属的默认读（乙）：本部门的人读得到 —— **在目录门之外另开一条**，
    # 不是替换目录 ACL：目录仍可给其他人开门，这条只管「本部门的人」。
    if ptype == 'read' and _dept_allows(user, doc):
        return True
    if not access.can_read(doc.get('directory_id'), user):
        return False
    if doc.get('status') == 'Active':
        return True if ptype == 'read' else doc.owner == user
    return doc.owner == user


def version_permission_query(user=None):
    parent_scope = permission_query(user) or '1=1'
    return ('`tabShangshu File Center Version`.`file` in '
            '(select `name` from `tabShangshu File Center File` where (' + parent_scope + '))')


def version_has_permission(doc=None, ptype='read', user=None):
    """版本入口与详情/下载同一套校验（B3/M7）：跟着父文件的当前权限走。"""
    business_access.require_identity(user)
    if doc is None:
        return True
    user = user or frappe.session.user
    if ptype != 'read' or not frappe.db.exists(DOCTYPE, doc.file):
        return False
    return has_permission(frappe.get_doc(DOCTYPE, doc.file), 'read', user)
