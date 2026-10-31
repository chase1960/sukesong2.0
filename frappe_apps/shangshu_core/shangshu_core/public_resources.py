"""Enterprise public read/reference grants on the existing organization authority.

Publishing never creates an enterprise ownership tier and never grants edit,
structure, export or approval. Domain validators must approve disclosure first.
"""
import frappe


def resource_enterprise(resource):
    from shangshu_core import org_admin
    att=org_admin.resource_attribution(resource)
    return org_admin._attribution_enterprise(att,resource)


def public_resource_allows(user, resource):
    from shangshu_core.identity import get_identity
    try:identity=get_identity(user)
    except frappe.PermissionError:return False
    enterprise=resource_enterprise(resource)
    if not enterprise or enterprise!=identity.enterprise_id:return False
    return bool(frappe.db.exists('Shangshu Org Grant',{'kind':'public','resource':resource,
                'grantee_enterprise':enterprise,'access':'read'}))


def assert_relation_direction(source, target):
    """Relationship direction does not follow the caller's broad read privilege."""
    from shangshu_core import org_admin
    from shangshu_core.identity import get_identity
    actor=get_identity();enterprise=actor.enterprise_id
    if resource_enterprise(source)!=enterprise or resource_enterprise(target)!=enterprise:
        frappe.throw('关联两侧必须属于当前企业',frappe.PermissionError)
    if source==target or public_resource_allows(actor.user,target):return True
    a=org_admin.resource_attribution(source);b=org_admin.resource_attribution(target)
    if not a or not b:frappe.throw('关联前须明确两侧归属',frappe.ValidationError)
    if a.level=='department':
        permitted=org_admin._descendants(a.department)
        if b.level=='department' and b.department in permitted:return True
        if b.level=='personal':
            depts=set(frappe.get_all('Shangshu Org Member',filters={'user':b.owner_user},pluck='department'))
            if depts & permitted:return True
    elif a.level=='personal' and b.level=='personal' and a.owner_user==b.owner_user:
        return True
    frappe.throw('不允许向上或跨管理范围关联非公共资料',frappe.PermissionError)


def publish(_action_id,payload,context):
    from shangshu_core import org_admin
    from shangshu_core.identity import get_identity
    resource=str(payload.get('resource') or '').strip()
    if not resource:frappe.throw('请选择资源',frappe.ValidationError)
    identity=get_identity()
    att=frappe.db.get_value('Shangshu Org Attribution',{'resource':resource},'name')
    if not att:frappe.throw('请先明确资源归属',frappe.ValidationError)
    frappe.get_doc('Shangshu Org Attribution',att,for_update=True)
    enterprise=resource_enterprise(resource)
    if not enterprise or enterprise!=identity.enterprise_id:
        frappe.throw('资源不在当前企业',frappe.PermissionError)
    if org_admin.share_right_allows(frappe.session.user,resource) is not True:
        frappe.throw('只有当前资源所有者级身份可发布或撤出公共空间',frappe.PermissionError)
    enabled=payload.get('enabled') is True
    if enabled:
        # Validator is a registered domain hook, never a client-selected method.
        validated=False
        for path in frappe.get_hooks('shangshu_public_resource_validate') or []:
            if not str(path).startswith('shangshu_files.'):continue
            if frappe.get_attr(path)(resource) is True:validated=True;break
        if not validated:frappe.throw('此资源尚不支持安全发布到公共空间',frappe.ValidationError)
    filters={'kind':'public','resource':resource,'grantee_enterprise':enterprise}
    existing=frappe.db.get_value('Shangshu Org Grant',filters,'name')
    if enabled and not existing:
        prior=getattr(frappe.flags,'shangshu_public_publish',None)
        try:
            frappe.flags.shangshu_public_publish=resource
            frappe.get_doc({'doctype':'Shangshu Org Grant',**filters,'access':'read'}).insert(ignore_permissions=True)
        finally:frappe.flags.shangshu_public_publish=prior
    if not enabled and existing:frappe.delete_doc('Shangshu Org Grant',existing,ignore_permissions=True)
    context['record_change']={'doctype':'Shangshu Org Attribution','name':att,
        'data':{'resource':resource,'public_before':bool(existing),'public_after':enabled,'enterprise_id':enterprise}}
    return {'resource':resource,'public':enabled,'enterprise_id':enterprise,'grants':['read','reference'] if enabled else []}
