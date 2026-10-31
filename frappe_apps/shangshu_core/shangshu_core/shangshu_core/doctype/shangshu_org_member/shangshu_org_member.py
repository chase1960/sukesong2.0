import frappe
from frappe.model.document import Document


class ShangshuOrgMember(Document):
    """成员任职：一人可多行（兼任多部门）；is_head=负责人任命。组织事实的唯一权威（任职部分）。"""

    def validate(self):
        self.user = str(self.user or "").strip().lower()
        if not self.user:
            frappe.throw("请指定用户", frappe.ValidationError)
        if not frappe.db.exists("User", self.user):
            frappe.throw(f"账号不存在：{self.user}", frappe.ValidationError)
        dept = frappe.db.get_value(
            "Shangshu Department", self.department, ["name", "enterprise_id"], as_dict=True
        )
        if not dept:
            frappe.throw("部门不存在", frappe.ValidationError)
        dup = frappe.db.exists(
            "Shangshu Org Member",
            {"user": self.user, "department": self.department, "name": ("!=", self.name)},
        )
        if dup:
            frappe.throw("该用户已在此部门任职", frappe.ValidationError)
