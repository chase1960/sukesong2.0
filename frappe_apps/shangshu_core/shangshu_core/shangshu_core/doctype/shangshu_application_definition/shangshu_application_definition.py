import frappe
from frappe.model.document import Document


class ShangshuApplicationDefinition(Document):
    def validate(self):
        previous = self.get_doc_before_save()
        if previous:
            for field in ("application_id", "namespace", "enterprise_id", "owner_identity", "creation_key", "creation_hash"):
                if self.get(field) != previous.get(field):
                    frappe.throw("应用身份与创建绑定不可修改", frappe.ValidationError)

