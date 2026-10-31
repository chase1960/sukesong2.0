import frappe
from frappe.model.document import Document


class ShangshuMailRead(Document):
    """**我读过没有** —— 按人记，一封信一行一人。

    为什么要单独一张表：共享箱里 `Shangshu Mail Message.read_at` 只有一个字段，
    张三一读李四的未读也跟着没了。部门那条「有人看过」另记在信上
    （`dept_read_at`），两条互不牵连。
    """

    def validate(self):
        if not getattr(frappe.flags, 'shangshu_mail_write', False):
            frappe.throw('读信状态必须经过受管动作', frappe.PermissionError)
        if not self.mail or not self.user:
            frappe.throw('读信记录必须写明邮件和员工', frappe.ValidationError)

    def on_trash(self):
        if not getattr(frappe.flags, 'shangshu_mail_write', False):
            frappe.throw('读信状态必须经过受管动作', frappe.PermissionError)
