"""组织授权公共面（API 1.10）；只导出已冻结能力，不暴露私有模块整体。"""
import frappe

from shangshu_core.org_admin import (
    resource_attribution, resources_by_level, write_allows, read_allows, download_allows,
    department_row, department_title, create_grant_allows,
    all_attribution_resources, org_readable_resources, org_context,
    # **主体判定口**（PKG-117-T01）：列级/表级权限按「主体范围」（全局/部门/个人）判。
    subject_context, subject_allows, field_subject_allows,
)
# **主体范围声明的形状校验**（PKG-117-T01 · 导出半）：域要判「这份声明形状合不合法」
# ⇒ **正式导出**这两个口（域不必再借 `subject_allows` 绕道触发同一份校验）。
# `shangshu_core.subject_access` 是**纯规则**模块（不碰 frappe）⇒ 顶层 import 不成环。
from shangshu_core.subject_access import normalize_scope, normalize_access


def attribution_record(resource, level, department=None, owner_user=None):
    """仅当前 owner 的已保存原生记录，可在本域确认写动作中首次登记归属。"""
    from shangshu_core.domains import platform_contributions
    from shangshu_core.org_admin import attribution_record as save_attribution
    caller = getattr(frappe.flags, 'shangshu_call_domain', None)
    pin = getattr(frappe.flags, 'shangshu_action_pin', None)
    if not caller or not pin:
        frappe.throw('组织归属只能在所属领域的受管写动作内登记', frappe.PermissionError)
    from shangshu_core.domains import raw_resource
    from shangshu_core.actions import _definition
    action_owner, _ = raw_resource('actions', pin['action_id'])
    if not action_owner or action_owner['id'] != caller:
        frappe.throw('组织归属动作所有者不匹配', frappe.PermissionError)
    action = _definition(pin['action_id'], pin['action_version'])
    if action.effect in ('read', 'external/read', 'extract'):
        frappe.throw('只读动作不能登记组织归属', frappe.PermissionError)
    # 贡献聚合的 owner 形状兼容：直接核对原对象的正式 owner，不信客户端 DocType。
    for item in platform_contributions().get('objects', []):
        owner, definition = raw_resource('objects', item['id'])
        doctype = definition.get('doctype') if definition else None
        if owner and owner['id'] == caller and doctype and frappe.db.exists(doctype, resource):
            doc = frappe.get_doc(doctype, resource)
            doc.check_permission('read')
            return save_attribution(resource, level, department, owner_user)
    frappe.throw('只能登记本领域已经保存且当前可读的记录', frappe.PermissionError)


def user_department(user):
    """存量协作分组只作兼容展示；不用于新组织授权或推断管理员。"""
    return str(frappe.db.get_value('Shangshu Identity', {'user': user}, 'collaboration_group') or '').strip()


def resolve_department(raw):
    """当前企业内启用的部门编号/唯一名称；不返回跨企业部门。"""
    from shangshu_core.identity import get_identity
    identity = get_identity()
    value = str(raw or '').strip()
    if not value:
        frappe.throw('请先选择受管部门', frappe.ValidationError)
    filters = {'enterprise_id': identity.enterprise_id, 'enabled': 1}
    exact = frappe.get_all('Shangshu Department', filters={**filters, 'name': value}, pluck='name')
    names = exact or frappe.get_all('Shangshu Department', filters={**filters, 'title': value}, pluck='name')
    if len(names) != 1:
        frappe.throw('部门不存在、已停用或名称不唯一，请选择部门编号', frappe.ValidationError)
    return names[0]


__all__ = ['resource_attribution', 'resources_by_level', 'write_allows', 'read_allows', 'download_allows',
           'department_row', 'department_title', 'create_grant_allows', 'attribution_record',
           'all_attribution_resources', 'org_readable_resources', 'org_context',
           'user_department', 'resolve_department',
           # **主体判定口**（PKG-117-T01）：域层按主体判，别自己写一套。
           'subject_context', 'subject_allows', 'field_subject_allows',
           # **主体范围声明的形状校验**（PKG-117-T01 · 导出半）：域直调，不绕道。
           'normalize_scope', 'normalize_access']
