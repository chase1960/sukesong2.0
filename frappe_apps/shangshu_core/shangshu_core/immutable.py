import frappe
from frappe.model.document import Document


class ImmutableDocument(Document):
    """已插入事实只允许首次落库；纠错必须追加新记录。"""

    def validate(self):
        if not self.is_new():
            frappe.throw(f"{self.doctype} 是不可变事实，禁止覆盖；请追加纠正记录", frappe.ValidationError)

    def on_trash(self):
        if not getattr(self.flags, "allow_test_delete", False):
            frappe.throw(f"{self.doctype} 是不可变事实，禁止删除", frappe.PermissionError)
