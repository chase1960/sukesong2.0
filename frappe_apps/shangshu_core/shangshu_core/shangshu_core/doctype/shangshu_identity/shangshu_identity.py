from frappe.model.document import Document
import frappe


class ShangshuIdentity(Document):
    def validate(self):
        previous = self.get_doc_before_save()
        if previous:
            for field in ("identity_id", "collaboration_key"):
                if previous.get(field) and previous.get(field) != self.get(field):
                    frappe.throw("身份引用键不可修改", frappe.ValidationError)
