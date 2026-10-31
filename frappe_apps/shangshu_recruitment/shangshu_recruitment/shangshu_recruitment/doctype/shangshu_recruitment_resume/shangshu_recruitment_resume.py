import frappe
from frappe.model.document import Document

IMMUTABLE_FIELDS = ('enterprise_id', 'candidate', 'intake', 'file_reference', 'file_sha256',
                    'source_type', 'created_at')


class ShangshuRecruitmentResume(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 简历只允许受管动作修改', frappe.PermissionError)
        before = None if self.is_new() else self.get_doc_before_save()
        if before:
            if self.enterprise_id != before.enterprise_id:
                frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 简历企业归属不可修改', frappe.ValidationError)
            for fieldname in IMMUTABLE_FIELDS:
                if (self.get(fieldname) or '') != (before.get(fieldname) or ''):
                    frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 简历来源标识不可修改: ' + fieldname,
                                 frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
