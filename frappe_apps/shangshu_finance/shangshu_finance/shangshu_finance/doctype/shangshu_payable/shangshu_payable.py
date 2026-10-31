import frappe
from frappe.model.document import Document


class ShangshuPayable(Document):
    def validate(self):
        if self.amount < 0 or self.paid_amount < 0 or self.balance_amount < 0:
            frappe.throw("应付金额不能为负数", frappe.ValidationError)
        if self.paid_amount + self.balance_amount != self.amount:
            frappe.throw("已付金额与余额之和必须等于应付金额", frappe.ValidationError)
