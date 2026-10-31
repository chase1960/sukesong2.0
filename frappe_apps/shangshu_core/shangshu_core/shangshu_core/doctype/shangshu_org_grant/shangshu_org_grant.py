import frappe
from frappe.model.document import Document


class ShangshuOrgGrant(Document):
    """授权事实（B1）：create=跨部门建表授权；share=明确共享（默认读权之外唯一例外）。

    组织事实单一权威原则同样适用：共享/建表授权只在本表维护一份，
    不在目录 allowed_*_json 里另起第二套可独立修改的授权事实。
    """

    def validate(self):
        kind = str(self.kind or "").strip()
        if kind not in ("create", "share", "public"):
            frappe.throw("授权类型只能是 create、share 或 public", frappe.ValidationError)
        access = str(self.access or "").strip()
        self.grantee_user = str(self.grantee_user or "").strip().lower() or None
        self.grantee_department = str(self.grantee_department or "").strip() or None
        self.department = str(self.department or "").strip() or None
        self.resource = str(self.resource or "").strip() or None
        self.grantee_enterprise = str(self.get('grantee_enterprise') or '').strip() or None
        if kind == 'public':
            if access != 'read' or not self.resource or not self.grantee_enterprise:
                frappe.throw('公共授权必须指定资源、企业且仅允许 read',frappe.ValidationError)
            if self.grantee_user or self.grantee_department or self.department:
                frappe.throw('公共范围不同时混入个人、部门或建表授权',frappe.ValidationError)
            if getattr(frappe.flags,'shangshu_public_publish',None) != self.resource:
                frappe.throw('公共范围只能经受管发布动作修改',frappe.PermissionError)
            return
        if self.grantee_enterprise:
            frappe.throw('普通共享不接受公共企业范围',frappe.ValidationError)
        if kind == "create":
            if access != "create":
                frappe.throw("建表授权的档位只能是 create", frappe.ValidationError)
            if not self.grantee_user or not self.department:
                frappe.throw("建表授权必须指定被授权人与建表归属部门", frappe.ValidationError)
            if self.resource or self.grantee_department:
                frappe.throw("建表授权不带共享资源或被授权部门", frappe.ValidationError)
            if not frappe.db.exists("Shangshu Department", self.department):
                frappe.throw("建表归属部门不存在", frappe.ValidationError)
        else:
            if access not in ("read", "edit"):
                frappe.throw("共享档位只能是 read 或 edit", frappe.ValidationError)
            if not self.resource:
                frappe.throw("共享必须指定资源", frappe.ValidationError)
            if not self.grantee_user and not self.grantee_department:
                frappe.throw("共享必须指定个人或部门", frappe.ValidationError)
            if self.grantee_user and self.grantee_department:
                frappe.throw("一次共享只面向个人或部门之一", frappe.ValidationError)
            if self.department:
                frappe.throw("共享不带建表归属部门", frappe.ValidationError)
            if self.grantee_user and not frappe.db.exists("User", self.grantee_user):
                frappe.throw(f"被共享账号不存在：{self.grantee_user}", frappe.ValidationError)
            if self.grantee_department and not frappe.db.exists("Shangshu Department", self.grantee_department):
                frappe.throw("被共享部门不存在", frappe.ValidationError)
