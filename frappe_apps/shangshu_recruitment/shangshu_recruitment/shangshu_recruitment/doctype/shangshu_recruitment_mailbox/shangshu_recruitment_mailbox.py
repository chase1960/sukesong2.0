import frappe
from frappe.model.document import Document

# 邮箱绑定是收件来源的审计锚点：绑哪个共享箱、用哪个系统账号同步，
# 一经创建不可改（换箱/换账号 = 新建绑定，旧绑定停用留痕）。
# 唯一允许的后续变更是停用/启用（enabled），走受管动作递增 revision。
IMMUTABLE_FIELDS = ('enterprise_id', 'mailbox_id', 'sync_user')


class ShangshuRecruitmentMailbox(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 邮箱绑定只允许受管动作修改', frappe.PermissionError)
        before = None if self.is_new() else self.get_doc_before_save()
        if before:
            for fieldname in IMMUTABLE_FIELDS:
                if (self.get(fieldname) or '') != (before.get(fieldname) or ''):
                    frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 邮箱绑定不可修改: ' + fieldname,
                                 frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 邮箱绑定不可删除，请停用', frappe.PermissionError)
