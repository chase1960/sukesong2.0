"""纯数据库对象的显式并行资格核验；不是第二份绑定或正式值。

首次安装及核验在排空的工程窗口执行。日常请求不扫描文件：只使用锁后
模型上的核验凭据。绑定和定义变更先撤销凭据，解绑不自动恢复资格。
"""
import hashlib
import json
import uuid

import frappe


def certificate_for(model):
    return {
        'protocol': 1,
        'revision': int(model.active_revision or 0),
        'physical_doctype': model.physical_doctype,
        'definition_hash': hashlib.sha256((model.active_json or '').encode()).hexdigest(),
    }


def invalidate_managed_write_zone(object_id):
    """适配器改变绑定前调用；仅撤销性能资格，不改变数据或权限。"""
    if not object_id:
        return
    from shangshu_core.write_zone_schema import revoke_certification
    revoke_certification(object_id)


def certify_managed_write_zone(object_id):
    """管理员独立工程核验；不由 HTTP/Assistant 日常动作自动调用。"""
    from shangshu_core.write_zone_schema import lock_model, assert_model_writable, set_certification
    from shangshu_core.identity import get_identity
    if 'System Manager' not in frappe.get_roles():
        frappe.throw('并行范围核验仅供管理员工程入口', frappe.PermissionError)
    if frappe.db.transaction_writes or getattr(frappe.flags, 'shangshu_domain_execution_depth', 0):
        frappe.throw('并行范围核验必须在独立、已排空的工程事务执行', frappe.ValidationError)
    model = lock_model(object_id)
    assert_model_writable(model)
    identity = get_identity()
    if model.enterprise_id != identity.enterprise_id or not model.active_revision:
        frappe.throw('对象不在当前企业或尚未生效', frappe.PermissionError)
    compiled = json.loads(model.active_json)
    if compiled.get('kind') != 'record' or any(
            f.get('type') in ('reference', 'detail') for f in compiled.get('fields', [])):
        frappe.throw('关联或明细对象继续使用完整应用范围', frappe.ValidationError)
    # 所有状态都算依赖，不能把回收文件/停用绑定当作“从未绑定”。
    companion = frappe.db.sql(
        'SELECT name FROM `tabShangshu Object Companion` WHERE object_id=%s '
        'LOCK IN SHARE MODE', (object_id,))
    if companion:
        frappe.throw('对象已有伴随文件，继续使用完整范围', frappe.ValidationError)
    handlers = set(frappe.get_hooks('shangshu_managed_change_handlers') or [])
    checked = set()
    for path in frappe.get_hooks('shangshu_write_zone_projection_checks') or []:
        result = frappe.get_attr(path)(object_id)
        if not isinstance(result, dict) or result.get('handler') not in handlers:
            frappe.throw('投影范围核验器与正式处理器不一致', frappe.ValidationError)
        if result.get('bound') is not False:
            frappe.throw('对象仍有文件投影或依赖未确认', frappe.ValidationError)
        checked.add(result['handler'])
    if checked != handlers:
        frappe.throw('仍有未核定范围的变更处理器', frappe.ValidationError)
    certificate = {**certificate_for(model), 'certification_id': uuid.uuid4().hex}
    set_certification(model, certificate)
    from shangshu_core.unified_log import write_log
    write_log('action', 'platform.object.write_zone_certify', actor_user=frappe.session.user,
              actor_identity=identity.name, result='Succeeded', trigger_source='user',
              reference_doctype=model.doctype, reference_name=model.name,
              detail={'object_id': model.name, 'certificate': certificate})
    return {'object_id': model.name, 'certificate': certificate}
