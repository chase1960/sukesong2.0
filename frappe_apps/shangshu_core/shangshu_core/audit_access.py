"""Independent audit-purpose authorization (user decision, 2026-10-19).

Company owners read their enterprise; heads read current managed departments
including descendants. Resource shares, manager role labels and field reads do
not grant this access. Ordinary employees retain only their own facts/receipts.
"""
import frappe
from shangshu_core.identity import get_identity


def _authorized_subjects(identity, scope):
    if scope == 'self':
        return [{'name':identity.name, 'user':frappe.session.user,
                 'identity_id':identity.identity_id, 'collaboration_key':identity.collaboration_key}]
    roles = set(frappe.get_roles())
    from shangshu_core.org_admin import org_context
    org = org_context(frappe.session.user)
    enterprise = identity.enterprise_id
    company_reader = 'System Manager' in roles or enterprise in (org.get('owned_enterprises') or [])
    if scope == 'all' and not company_reader:
        frappe.throw('未获得企业范围日志查询授权', frappe.PermissionError)
    # Intersect with current enterprise before projecting identities or counts.
    candidates = frappe.get_all('Shangshu Identity', filters={'enterprise_id':enterprise},
                                fields=['name','user','identity_id','collaboration_key'])
    if company_reader:
        return candidates
    departments = org.get('head_departments') or []
    managed_users = set(frappe.get_all('Shangshu Org Member',
        filters={'department':['in',departments]}, pluck='user')) if departments else set()
    managed_users.add(frappe.session.user)
    return [row for row in candidates if row.get('user') in managed_users]


def audit_query_filters(filters=None, scope='self'):
    identity = get_identity()  # Active session/User/Identity, checked every request.
    result = dict(filters or {})
    if scope not in ('self', 'all', 'managed'):
        frappe.throw('日志查询范围不支持', frappe.ValidationError)
    requested = result.get('actor_user')
    if requested is not None and (not isinstance(requested,str) or not requested.strip()):
        frappe.throw('日志员工筛选必须是单个有效账号', frappe.ValidationError)
    subjects = _authorized_subjects(identity, scope)
    if requested:
        subjects = [row for row in subjects if row.get('user') == requested]
        if not subjects:
            frappe.throw('该员工不在当前日志授权范围内', frappe.PermissionError)
    # Never trust caller-supplied identity filters or return the unfiltered set.
    ids = [row['name'] for row in subjects]
    result['actor_identity'] = ['in', ids or ['__no_authorized_audit_identity__']]
    if scope == 'self':
        result['actor_user'] = frappe.session.user
    return result


def authorize_audit_actor(user):
    """Authorize a concrete conversation/log actor before another store reads it.

    Returns only the requested subject's stable mapping, not a staff directory.
    The consumer must query records by this server-derived actor, never by a
    caller-supplied conversation prefix or context snippet.
    """
    if not isinstance(user,str) or not user.strip():
        frappe.throw('请指定日志所属员工', frappe.ValidationError)
    identity = get_identity()
    subjects = _authorized_subjects(identity, 'managed')
    for row in subjects:
        if row.get('user') == user:
            return {'user':row['user'], 'identity_id':row['identity_id'],
                    'collaboration_key':row.get('collaboration_key'),
                    'enterprise_id':identity.enterprise_id}
    frappe.throw('该员工不在当前日志授权范围内', frappe.PermissionError)
