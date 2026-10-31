"""已知受管行的公共值读：只给目标行/列，不装配逐行详情或再建查询引擎。"""


def input_schema():
    identity = {'type': 'string', 'minLength': 1, 'maxLength': 140}
    return {'type': 'object', 'additionalProperties': False,
            'required': ['object_id', 'names', 'fields'], 'properties': {
                'object_id': dict(identity),
                'names': {'type': 'array', 'minItems': 1, 'maxItems': 50, 'uniqueItems': True,
                          'items': dict(identity)},
                'fields': {'type': 'array', 'minItems': 1, 'maxItems': 64, 'uniqueItems': True,
                           'items': dict(identity)}}}


def read(_service, payload, _context=None):
    import frappe
    from shangshu_core import model_records

    payload = payload or {}
    object_id, names, fields = payload.get('object_id'), payload.get('names'), payload.get('fields')
    if not isinstance(object_id, str) or not object_id or len(object_id) > 140 or object_id != object_id.strip():
        frappe.throw('受管对象身份必填', frappe.ValidationError)
    for values, maximum, label in ((names, 50, '目标行'), (fields, 64, '目标字段')):
        if (not isinstance(values, list) or not 1 <= len(values) <= maximum
                or any(not isinstance(value, str) or not value or len(value) > 140
                       or value != value.strip() for value in values)
                or len(set(values)) != len(values)):
            frappe.throw('%s须为1至%d个不重复的明确身份' % (label, maximum), frappe.ValidationError)
    if not model_records.is_managed(object_id):
        frappe.throw('该批量值读只支持受管对象', frappe.ValidationError)
    # 权限、生命周期、字段范围和版本仍由原批读入口处理；不吞错或扩大范围。
    rows = model_records.get_records(object_id, names, fields=fields,
                                     read_scope={'mode': 'rows', 'purpose': 'interactive'})
    return {'rows': [rows[name] for name in names]}
