import frappe
from frappe.model.document import Document


class ShangshuRecruitmentScreeningRubric(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 筛选标准只允许受管动作修改', frappe.PermissionError)
        before = self.get_doc_before_save()
        if before:
            if before.status != 'draft':
                frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 已发布或退役筛选标准不可修改', frappe.ValidationError)
            if any(getattr(self, field) != getattr(before, field)
                   for field in ('enterprise_id', 'job', 'version_no')):
                frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 筛选标准版本归属不可修改', frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
