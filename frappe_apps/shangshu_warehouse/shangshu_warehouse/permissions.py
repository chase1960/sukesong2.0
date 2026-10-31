import frappe
from shangshu_core.public_api import get_request_context


def query(user=None):
    # 本产品一企业一站；仍按当前身份限制查询，避免以后扩展时丢失边界。
    context = get_request_context()
    return "enterprise_id=" + frappe.db.escape(context["enterprise_id"])


def check(doc, user=None, permission_type=None):
    if permission_type not in (None, "read", "select"):
        return False
    if doc is None:
        return True
    return doc.enterprise_id == get_request_context()["enterprise_id"]

