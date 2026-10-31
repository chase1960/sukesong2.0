import frappe
from frappe.model.document import Document

class ShangshuMailMessage(Document):
    def before_insert(self):
        """默认挂到**建信人自己的个人箱**（N5-1：归属按邮箱算，不按收信人算）。

        共享箱收信时由收信链**显式**指定 mailbox_id，不走这里 ——
        部门箱的信归部门，不归第一个把它存进来的人。
        """
        if not self.mailbox_id:
            from shangshu_mail import account
            self.mailbox_id = account.account_name(self.owner or frappe.session.user)

    def validate(self):
        if not getattr(frappe.flags, 'shangshu_mail_write', False):
            frappe.throw('邮件修改必须经过受管动作', frappe.PermissionError)
        if self.status not in ('Draft','Trash','Queued','Sending','Sent','Partial','Failed','Unknown','Received'):
            frappe.throw('邮件状态无效', frappe.ValidationError)

    def on_trash(self):
        if not getattr(frappe.flags, 'shangshu_mail_write', False):
            frappe.throw('请使用邮件回收站，不能直接删除邮件', frappe.PermissionError)
