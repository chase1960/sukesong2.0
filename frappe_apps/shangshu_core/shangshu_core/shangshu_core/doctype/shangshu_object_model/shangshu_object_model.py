import frappe
from frappe.model.document import Document


class ShangshuObjectModel(Document):
    def validate(self):
        from shangshu_core.write_zone_schema import validate_model_update
        validate_model_update(self)
        before=self.get_doc_before_save()
        if before and any(self.get(key)!=before.get(key) for key in ("object_id","application","enterprise_id","owner_identity","physical_doctype")):
            frappe.throw("对象归属和物理映射不可修改",frappe.ValidationError)
