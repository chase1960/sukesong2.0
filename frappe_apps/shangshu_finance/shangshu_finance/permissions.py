import frappe


FINANCE_STATES = ("SS Pending Finance Review", "SS Pending Posting", "SS Pending Payment", "SS Completed")


def _escape(value):
    return frappe.db.escape(value or "")


def expense_claim_query(user=None):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    if user == "Administrator" or "System Manager" in roles:
        return ""
    table = "`tabShangshu Expense Claim`"
    u = _escape(user)
    if "Finance Approver" in roles or "Cashier" in roles:
        states = ",".join(_escape(state) for state in FINANCE_STATES)
        return f"({table}.applicant={u} or {table}.workflow_state in ({states}))"
    if "Expense Approver" in roles:
        return f"({table}.applicant={u} or {table}.workflow_state in ('SS Pending Manager Approval','SS Needs Supplement','SS Pending Finance Review','SS Pending Posting','SS Pending Payment','SS Completed'))"
    return f"{table}.applicant={u}"


def expense_claim_permission(doc, user=None, permission_type=None):
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    if user == "Administrator" or "System Manager" in roles:
        return True
    if permission_type == "create":
        return True
    if doc is None:
        return True
    if doc.applicant == user:
        return True
    if "Expense Approver" in roles and doc.workflow_state != "SS Draft":
        return True
    if ("Finance Approver" in roles or "Cashier" in roles) and doc.workflow_state in FINANCE_STATES:
        return True
    return False
