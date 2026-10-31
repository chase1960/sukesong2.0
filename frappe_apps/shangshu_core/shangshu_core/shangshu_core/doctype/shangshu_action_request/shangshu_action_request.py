import frappe
from frappe.model.document import Document


class ShangshuActionRequest(Document):
    def validate(self):
        previous = self.get_doc_before_save()
        if previous:
            for field in ("request_key", "action_id", "action_version", "actor_identity",
                          "enterprise_id", "request_hash"):
                if self.get(field) != previous.get(field):
                    frappe.throw("动作请求绑定不可修改", frappe.ValidationError)
            if previous.status == "Succeeded":
                frappe.throw("已完成动作请求不可覆盖", frappe.ValidationError)
