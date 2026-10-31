import frappe
from frappe.model.document import Document


class ShangshuRecruitmentJob(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 岗位只允许受管动作修改', frappe.PermissionError)
        if not self.is_new() and self.get_doc_before_save():
            if self.enterprise_id != self.get_doc_before_save().enterprise_id:
                frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 岗位企业归属不可修改', frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
