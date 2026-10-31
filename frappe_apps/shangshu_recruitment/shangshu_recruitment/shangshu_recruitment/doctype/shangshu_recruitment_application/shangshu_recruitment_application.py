import frappe
from frappe.model.document import Document

# 归属字段一旦写入不可改；process_instance 是唯一例外——
# 流程实例要先有申请名才能 start_process（business_name=申请编号），
# 所以它按「空 → 只允许写一次」处理：插入后绑定，之后不可变。
IMMUTABLE_FIELDS = ('job', 'candidate', 'source_intake', 'applied_at')
SET_ONCE_FIELDS = ('enterprise_id', 'process_instance')


class ShangshuRecruitmentApplication(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 申请只允许受管动作修改', frappe.PermissionError)
        before = None if self.is_new() else self.get_doc_before_save()
        if before:
            for fieldname in IMMUTABLE_FIELDS:
                if (self.get(fieldname) or '') != (before.get(fieldname) or ''):
                    frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 申请归属字段不可修改: ' + fieldname,
                                 frappe.ValidationError)
            for fieldname in SET_ONCE_FIELDS:
                old = before.get(fieldname) or ''
                if old and (self.get(fieldname) or '') != old:
                    frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 申请绑定字段不可修改: ' + fieldname,
                                 frappe.ValidationError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
