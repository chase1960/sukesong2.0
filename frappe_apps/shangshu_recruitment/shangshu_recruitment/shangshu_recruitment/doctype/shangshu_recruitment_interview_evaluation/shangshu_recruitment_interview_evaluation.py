import frappe

# 评价是面试官的一次性独立结论：提交后整体不可变。
IMMUTABLE_FIELDS = ('enterprise_id', 'interview', 'evaluator', 'conclusion', 'comment',
                    'submitted_at')


def validate(doc, method=None):
    if not frappe.flags.recruitment_write:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 面试评价只允许受管动作提交', frappe.PermissionError)
    previous = doc.get_doc_before_save()
    if not previous:
        return
    for field in IMMUTABLE_FIELDS:
        if doc.get(field) != previous.get(field):
            frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 评价提交后不可修改', frappe.ValidationError)


def on_trash(doc, method=None):
    frappe.throw('RECRUITMENT_PERMISSION_DENIED: 面试评价不可删除', frappe.PermissionError)
