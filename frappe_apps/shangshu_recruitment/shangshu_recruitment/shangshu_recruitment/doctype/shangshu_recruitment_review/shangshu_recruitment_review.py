from frappe.model.document import Document
from shangshu_recruitment.workbench import validate_record, prevent_delete


class ShangshuRecruitmentReview(Document):
    def validate(self):
        validate_record(self)

    def on_trash(self):
        prevent_delete(self)
