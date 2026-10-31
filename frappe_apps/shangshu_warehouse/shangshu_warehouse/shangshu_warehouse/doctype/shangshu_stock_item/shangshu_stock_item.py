import frappe
from frappe.model.document import Document


class ShangshuStockItem(Document):
    def validate(self):
        if not getattr(frappe.flags, "warehouse_write", False):
            frappe.throw("库存只能通过受管动作变更，流水不可覆盖", frappe.PermissionError)

    def on_trash(self):
        frappe.throw("库存记录不可删除，请追加更正流水", frappe.PermissionError)
