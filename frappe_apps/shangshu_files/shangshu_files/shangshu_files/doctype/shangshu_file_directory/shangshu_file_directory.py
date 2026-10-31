from shangshu_files.business_permissions import BusinessReadMixin
from frappe.model.document import Document


class ShangshuFileDirectory(BusinessReadMixin, Document):
    pass
