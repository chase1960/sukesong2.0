"""表格已声明晋升列的最小输入提示；不读工作簿、记录或整表。

只回答已有正式声明；未声明表头不在columns中，不能据此认定该列存在。
"""


def read(_service, payload, _context=None):
    import frappe
    from shangshu_core.public_api import invoke_domain_service
    from shangshu_files import promotion

    payload = payload or {}
    table, headers = payload.get('table'), payload.get('headers')
    page, length, search = payload.get('page', 1), payload.get('page_length', 20), payload.get('search', '')
    if not isinstance(table, str) or not table.strip() or len(table) > 140:
        frappe.throw('表身份必填', frappe.ValidationError)
    if (not isinstance(headers, list) or not 1 <= len(headers) <= 64
            or any(not isinstance(h, str) or not h.strip() or len(h) > 32767 for h in headers)
            or len(set(headers)) != len(headers)):
        frappe.throw('输入约束须指定1至64个不重复的表头', frappe.ValidationError)
    if type(page) is not int or page < 1 or type(length) is not int or not 1 <= length <= 50:
        frappe.throw('选项页码须为正整数，每页1至50项', frappe.ValidationError)
    if not isinstance(search, str) or len(search) > 200:
        frappe.throw('选项搜索词须为最多200字的文字', frappe.ValidationError)
    doc = frappe.get_doc('Shangshu File Center File', table)
    doc.check_permission('read')
    if doc.status == 'Recycled':
        frappe.throw('该表在回收站，恢复后才能读取', frappe.PermissionError)
    definition = promotion.load_definition(doc)
    declared = {column.get('header'): column for column in definition.get('columns') or []
                if isinstance(column, dict) and column.get('promoted') and column.get('field')}
    selected = [header for header in headers if header in declared]
    if not selected:
        return {'table': table, 'columns': {}}
    binding = promotion._managed_binding(doc)
    if definition.get('binding_current') is not True or not binding or not binding.get('object_id'):
        frappe.throw('晋升绑定失效，不能提供正式输入约束，请先核对绑定', frappe.ValidationError)
    response = invoke_domain_service('platform.object.input_constraints', {
        'object_id': binding['object_id'],
        'fields': list(dict.fromkeys(declared[header]['field'] for header in selected)),
        'page': page, 'page_length': length, 'search': search})
    fields = response['fields']
    result = {}
    for header in selected:
        field = declared[header]['field']
        if field not in fields:
            frappe.throw('指定列没有可读的正式输入约束', frappe.PermissionError)
        info = dict(fields[field])
        # 中文名只是显示附属；正式值/是否自定义/是否可空都不能由文件旧声明覆盖。
        labels = (declared[header].get('rules') or {}).get('option_labels')
        if info.get('options') is not None:
            info['options'] = {**info['options'], 'items': [dict(item) for item in info['options']['items']]}
            if isinstance(labels, dict):
                for item in info['options']['items']:
                    label = labels.get(str(item['value']))
                    if isinstance(label, str) and label:
                        item['label'] = label
        result[header] = info
    return {'table': table, 'columns': result}
