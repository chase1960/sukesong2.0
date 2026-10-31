import frappe

IMMUTABLE_FIELDS = ('enterprise_id', 'application')


def validate(doc, method=None):
    if not frappe.flags.recruitment_write:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 面试记录只允许受管动作修改', frappe.PermissionError)
    previous = doc.get_doc_before_save()
    if not previous:
        return
    for field in IMMUTABLE_FIELDS:
        if doc.get(field) != previous.get(field):
            frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: %s 不可修改' % field, frappe.ValidationError)


def on_trash(doc, method=None):
    frappe.throw('RECRUITMENT_PERMISSION_DENIED: 面试记录不可删除', frappe.PermissionError)
