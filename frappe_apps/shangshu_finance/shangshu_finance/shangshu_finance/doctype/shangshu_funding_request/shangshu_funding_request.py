import frappe
from frappe.model.document import Document


class ShangshuFundingRequest(Document):
    def validate(self):
        if not getattr(frappe.flags, "finance_funding_write", False):
            frappe.throw("资金业务只允许受管动作，已登记流水不可改写", frappe.PermissionError)

    def on_trash(self):
        frappe.throw("资金申请与流水不可删除", frappe.PermissionError)
