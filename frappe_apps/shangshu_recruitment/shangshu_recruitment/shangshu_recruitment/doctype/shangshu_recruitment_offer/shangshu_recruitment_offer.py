import frappe

# 条款在创建时锁定：后续状态流转（审批/回复）只改 status/reply_note/revision。
IMMUTABLE_FIELDS = ('enterprise_id', 'application', 'terms', 'effective_date')


def validate(doc, method=None):
    if not frappe.flags.recruitment_write:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: Offer 只允许受管动作修改', frappe.PermissionError)
    previous = doc.get_doc_before_save()
    if not previous:
        return
    for field in IMMUTABLE_FIELDS:
        if doc.get(field) != previous.get(field):
            frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: %s 不可修改' % field, frappe.ValidationError)


def on_trash(doc, method=None):
    frappe.throw('RECRUITMENT_PERMISSION_DENIED: Offer 不可删除', frappe.PermissionError)


from frappe.model.document import Document


class ShangshuRecruitmentOffer(Document):
    def validate(self):
        validate(self)

    def on_trash(self):
        on_trash(self)
