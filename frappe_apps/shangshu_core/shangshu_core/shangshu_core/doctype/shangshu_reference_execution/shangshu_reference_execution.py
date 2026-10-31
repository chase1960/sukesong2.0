import frappe
from frappe.model.document import Document


class ShangshuReferenceExecution(Document):
    def validate(self):
        if not getattr(frappe.flags,'shangshu_reference_work_write',False):frappe.throw('助手执行租约只由公共编排维护',frappe.PermissionError)
        old=self.get_doc_before_save()
        if old and any(old.get(field)!=self.get(field) for field in ('actor_user','enterprise_id','domain_id','object_id','reference_name','expires_at')):
            frappe.throw('执行来源、负责人和期限不可改写',frappe.ValidationError)

    def on_trash(self):frappe.throw('执行撤销与历史须保留，不物理删除',frappe.PermissionError)
