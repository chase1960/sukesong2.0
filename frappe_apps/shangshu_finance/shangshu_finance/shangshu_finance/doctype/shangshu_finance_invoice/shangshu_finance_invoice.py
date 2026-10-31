import frappe
from frappe.model.document import Document


class ShangshuFinanceInvoice(Document):
    def validate(self):
        if self.total_amount is not None and self.total_amount < 0:
            frappe.throw("发票金额不能为负数", frappe.ValidationError)
        if not self.is_new() and self.get_db_value("status") == "Confirmed":
            protected = ("invoice_number", "invoice_date", "seller_name", "seller_tax_id", "total_amount", "tax_amount", "direction")
            if any(self.has_value_changed(field) for field in protected):
                frappe.throw("已确认发票字段不可覆盖；请作废后新增纠正记录", frappe.ValidationError)
