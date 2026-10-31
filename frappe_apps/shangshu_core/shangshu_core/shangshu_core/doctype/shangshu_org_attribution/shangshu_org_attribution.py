import frappe
from frappe.model.document import Document


class ShangshuOrgAttribution(Document):
    """资源归属：一张资源一行（**只认 personal / department 两级**）。

    **尚书是单例，没有企业归属**（用户 2026-10-15 原话）—— 企业级这一层不存在，
    `enterprise` **永不产生**。归属层级≠共享范围（契约 §4 矩阵）。
    判据 FA-21 ⑫。
    """

    def validate(self):
        self.resource = str(self.resource or "").strip()
        if not self.resource:
            frappe.throw("请指定资源", frappe.ValidationError)
        # 归属层级走公共判定（`field_access.attribution_level`），不自己列白名单。
        # 改之前这里白名单是 `("personal", "enterprise", "department")` —— **第三道闸是漏的**：
        # 文案写着「没有企业归属」，闸却放 enterprise 过。贴假标。
        from shangshu_core.field_access import attribution_level as _attribution_level
        try:
            self.level = _attribution_level(self.level, department=self.department,
                                            owner_user=self.owner_user)
        except ValueError as e:
            frappe.throw(str(e), frappe.ValidationError)
        if self.level == "department":
            if not self.department:
                frappe.throw("部门级归属必须指定部门", frappe.ValidationError)
            if not frappe.db.exists("Shangshu Department", self.department):
                frappe.throw("归属部门不存在", frappe.ValidationError)
        else:
            self.department = None
        if self.level == "personal" and not self.owner_user:
            frappe.throw("个人级归属必须指定归属人", frappe.ValidationError)
        dup = frappe.db.exists(
            "Shangshu Org Attribution", {"resource": self.resource, "name": ("!=", self.name)}
        )
        if dup:
            frappe.throw("该资源已有归属记录", frappe.ValidationError)
