import frappe
from frappe.model.document import Document

IMMUTABLE_FIELDS = ('enterprise_id', 'source_type', 'idempotency_key', 'request_id',
                    'mail_account', 'mail_message', 'sender_email', 'subject',
                    'candidate_name', 'candidate_email', 'candidate_phone',
                    'attachments_json', 'received_at')


class ShangshuRecruitmentIntake(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 收件记录只允许受管动作修改', frappe.PermissionError)
        before = None if self.is_new() else self.get_doc_before_save()
        if before:
            if self.enterprise_id != before.enterprise_id:
                frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 收件企业归属不可修改', frappe.ValidationError)
            for fieldname in IMMUTABLE_FIELDS:
                if (self.get(fieldname) or '') != (before.get(fieldname) or ''):
                    frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 收件来源标识不可修改: ' + fieldname,
                                 frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
