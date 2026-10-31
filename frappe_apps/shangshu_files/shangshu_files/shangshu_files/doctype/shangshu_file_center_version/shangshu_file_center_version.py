from shangshu_files.business_permissions import BusinessReadMixin
import frappe


class ShangshuFileCenterVersion(BusinessReadMixin, frappe.model.document.Document):
    def validate(self):
        if not self.uploaded_by:
            self.uploaded_by = frappe.session.user
        if not self.uploaded_at:
            self.uploaded_at = frappe.utils.now()
