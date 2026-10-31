import frappe
from decimal import Decimal
from frappe.model.document import Document


class ShangshuExpenseClaim(Document):
    def validate(self):
        if self.amount is not None and self.amount <= 0:
            frappe.throw("报销金额必须大于零", frappe.ValidationError)
        if self.invoice and self.amount:
            invoice_amount = frappe.db.get_value("Shangshu Finance Invoice", self.invoice, "total_amount")
            if invoice_amount is not None and Decimal(str(self.amount)).quantize(Decimal("0.01")) != Decimal(str(invoice_amount)).quantize(Decimal("0.01")):
                frappe.throw("报销金额必须与已核对发票金额一致", frappe.ValidationError)
