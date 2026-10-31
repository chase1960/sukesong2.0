import frappe
from frappe.model.document import Document


class ShangshuMailAccount(Document):
    def validate(self):
        if not getattr(frappe.flags,'shangshu_mail_account_write',False):
            frappe.throw('邮箱配置必须经过本人设置动作',frappe.PermissionError)

    def on_trash(self):
        frappe.throw('请解除邮箱绑定，不能直接删除配置历史',frappe.PermissionError)
