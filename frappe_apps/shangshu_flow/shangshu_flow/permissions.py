import frappe


def _escape(value):
    return frappe.db.escape(value or "")


def _is_approver(user):
    roles = frappe.get_roles(user)
    return "Expense Approver" in roles or "Finance Approver" in roles


def process_copy_query(user=None):
    user = user or frappe.session.user
    if "System Manager" in frappe.get_roles(user):
        return ""
    return f"`tabProcess Copy`.`user` = {_escape(user)}"


def process_copy_permission(doc, user=None, permission_type=None):
    user = user or frappe.session.user
    return "System Manager" in frappe.get_roles(user) or doc.user == user


def expense_request_query(user=None):
    """列表级条件：普通员工只能扫到自己发起/参与/被抄送的单据。"""
    user = user or frappe.session.user
    if user == "Administrator" or "System Manager" in frappe.get_roles(user) or _is_approver(user):
        return ""
    u = _escape(user)
    return (
        f"(`tabExpense Request`.`owner` = {u}"
        f" or `tabExpense Request`.`applicant` = {u}"
        f" or exists(select 1 from `tabProcess Copy` pc"
        f"   where pc.reference_doctype='Expense Request' and pc.reference_name=`tabExpense Request`.`name` and pc.`user`={u})"
        f" or exists(select 1 from `tabWorkflow Action` wa"
        f"   where wa.reference_doctype='Expense Request' and wa.reference_name=`tabExpense Request`.`name` and wa.completed_by={u}))"
    )


def expense_request_permission(doc, user=None, permission_type=None):
    """记录级权限：员工只读自己参与的单据；审批角色可读流转单据。

    能否审批由 Workflow 转换的角色与状态条件控制，不在这里放宽。
    """
    from shangshu_flow.api import user_participated_in

    user = user or frappe.session.user
    if user == "Administrator" or "System Manager" in frappe.get_roles(user):
        return True
    roles = frappe.get_roles(user)
    approver = _is_approver(user)
    if permission_type in (None, "read", "share", "email", "print"):
        if approver:
            return True
        if doc is None:
            # 类型级判定：允许进入列表，行级由 query conditions 与逐条校验过滤。
            return True
        return user_participated_in(doc, user)
    if permission_type == "create":
        return True
    if doc is None:
        return approver
    return approver or doc.owner == user
