import frappe
from frappe.model.document import Document


class ShangshuDepartment(Document):
    """部门：稳定身份 department_id 不随改名变化；组织事实的唯一权威（部门部分）。

    历史日志保留当时快照（track_changes=1），不回写过去。
    """

    def validate(self):
        self.title = str(self.title or "").strip()
        if not self.title:
            frappe.throw("请填写部门名称", frappe.ValidationError)
        self.enterprise_id = str(self.enterprise_id or "").strip() or "default"
        parent = str(self.parent or "").strip()
        if parent:
            if parent == self.name:
                frappe.throw("上级部门不能是自己（循环部门关系）", frappe.ValidationError)
            row = frappe.db.get_value(
                "Shangshu Department", parent, ["name", "enterprise_id"], as_dict=True
            )
            if not row:
                frappe.throw("上级部门不存在", frappe.ValidationError)
            if row.enterprise_id != self.enterprise_id:
                frappe.throw("不能跨企业挂接部门", frappe.ValidationError)
            # 循环：新父链里不能出现自己（改父场景）
            seen = {parent}
            cur = parent
            while cur:
                up = frappe.db.get_value("Shangshu Department", cur, "parent")
                if not up:
                    break
                if up in seen or up == self.name:
                    frappe.throw("循环部门关系被拒绝", frappe.ValidationError)
                seen.add(up)
                cur = up
