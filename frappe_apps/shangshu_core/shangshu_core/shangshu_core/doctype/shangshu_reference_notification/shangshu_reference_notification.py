import frappe
from frappe.model.document import Document


class ShangshuReferenceNotification(Document):
    def validate(self):
        if not getattr(frappe.flags,'shangshu_reference_work_write',False):frappe.throw('工作提醒只由来源原域维护',frappe.PermissionError)
        old=self.get_doc_before_save()
        if old and any(self.get(k)!=old.get(k) for k in ('event_key','enterprise_id','domain_id','object_id','reference_name','recipient_user','title','body')):
            frappe.throw('提醒来源与内容不可改写，请关闭后按新依据生成',frappe.PermissionError)

    def on_trash(self):frappe.throw('提醒历史须保留，请通过原事项关闭',frappe.PermissionError)
