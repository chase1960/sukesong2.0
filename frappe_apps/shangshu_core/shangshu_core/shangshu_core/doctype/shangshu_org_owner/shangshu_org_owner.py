import frappe
from frappe.model.document import Document


class ShangshuOrgOwner(Document):
    """企业管理者（老板）任职记录。与 System Manager 角色是两种权，互不相认。"""

    def validate(self):
        self.user = str(self.user or "").strip().lower()
        if not self.user:
            frappe.throw("请指定用户", frappe.ValidationError)
        if not frappe.db.exists("User", self.user):
            frappe.throw(f"账号不存在：{self.user}", frappe.ValidationError)
        self.enterprise_id = str(self.enterprise_id or "").strip() or "default"
        dup = frappe.db.exists(
            "Shangshu Org Owner",
            {"user": self.user, "enterprise_id": self.enterprise_id, "name": ("!=", self.name)},
        )
        if dup:
            frappe.throw("该用户已是本企业管理者", frappe.ValidationError)
