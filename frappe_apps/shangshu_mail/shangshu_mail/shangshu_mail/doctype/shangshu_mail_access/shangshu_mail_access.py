import frappe
from frappe.model.document import Document


class ShangshuMailAccess(Document):
    """谁能进哪个邮箱、能干什么。**一行 = 一个人对一个邮箱的一项授权**。

    判定一律走这一张表，不看 owner —— owner 是「谁建的记录」，
    不是「谁能用这个邮箱」。N5-1：账户身份独立于登录人。
    """

    def validate(self):
        if not getattr(frappe.flags, 'shangshu_mail_access_write', False):
            frappe.throw('邮箱授权必须经过授权管理动作', frappe.PermissionError)
        if not self.mailbox or not self.user:
            frappe.throw('授权必须写明邮箱和员工', frappe.ValidationError)

    def on_trash(self):
        if not getattr(frappe.flags, 'shangshu_mail_access_write', False):
            frappe.throw('邮箱授权必须经过授权管理动作', frappe.PermissionError)
