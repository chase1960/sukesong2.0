import frappe
from frappe.model.document import Document


class ShangshuSchemaChange(Document):
    def validate(self):
        before=self.get_doc_before_save()
        if before and any(self.get(key)!=before.get(key) for key in ("change_key","request_hash","object_model","actor_identity","base_revision","target_revision","compiled_json","plan_json")):
            frappe.throw("迁移计划不可覆盖，请创建新变更",frappe.ValidationError)
