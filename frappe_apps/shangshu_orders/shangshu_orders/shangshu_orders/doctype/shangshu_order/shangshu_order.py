import frappe
from frappe.model.document import Document


class ShangshuOrder(Document):
    def validate(self):
        if not getattr(frappe.flags, "orders_write", False):
            frappe.throw("订单只允许受管动作修改", frappe.PermissionError)

    def on_trash(self):
        frappe.throw("订单不可删除，保留审批与履约记录", frappe.PermissionError)

