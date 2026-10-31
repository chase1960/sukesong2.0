import json

import frappe
from frappe.model.document import Document


class ShangshuDomain(Document):
    def validate(self):
        if not str(self.domain_id or "").startswith("com.shangshu."):
            frappe.throw("领域 ID 必须使用 com.shangshu.* 命名空间", frappe.ValidationError)
        try:
            json.loads(self.contribution_json or "{}")
        except (TypeError, ValueError):
            frappe.throw("领域贡献必须是有效 JSON", frappe.ValidationError)

