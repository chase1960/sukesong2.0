"""日常填值只读投影：可选值、是否允许自定义、是否能留空。

不保存规则，不读记录，不返回物理映射；规则与最终校验仍在原记录写入口。
"""
import json
import math

SCALAR_TYPES = {'text', 'long_text', 'integer', 'decimal', 'date', 'boolean', 'choice'}


def input_schema():
    return {'type': 'object', 'additionalProperties': False,
            'required': ['object_id', 'fields'], 'properties': {
                'object_id': {'type': 'string', 'minLength': 1, 'maxLength': 140},
                'fields': {'type': 'array', 'minItems': 1, 'maxItems': 64, 'uniqueItems': True,
                           'items': {'type': 'string', 'minLength': 1, 'maxLength': 140}},
                'search': {'type': 'string', 'maxLength': 200},
                'page': {'type': 'integer', 'minimum': 1},
                'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 50}}}


def _scope(names, page=1, page_length=20, search='', max_length=140):
    if (not isinstance(names, list) or not 1 <= len(names) <= 64
            or any(not isinstance(name, str) or not name.strip() or len(name) > max_length for name in names)
            or len(set(names)) != len(names)):
        raise ValueError('输入约束须指定1至64个不重复的字段')
    if type(page) is not int or page < 1 or type(page_length) is not int or not 1 <= page_length <= 50:
        raise ValueError('选项页码须为正整数，每页1至50项')
    if not isinstance(search, str) or len(search) > 200:
        raise ValueError('选项搜索词须为最多200字的文字')
    return page, page_length, search


def _number_option(code, field):
    """把值域原码投影为能稳定经JSON提交的数字，不把001/1.0偷改成1。"""
    try:
        value = json.loads(code)
    except (TypeError, ValueError):
        return None
    if type(value) not in (int, float) or str(value) != code:
        return None
    if field['type'] == 'integer':
        if type(value) is not int or not -2147483648 <= value <= 2147483647:
            return None
    elif (type(value) is float and (not math.isfinite(value) or value.is_integer())
          or type(value) is int and abs(value) > 9007199254740991):
        # JS JSON.stringify(1.0) == '1'，Python重读变int，原值域'1.0'就不再匹配。
        # 非整数有限double的JSON往返保留数值；整数超出JS安全范围不作为候选。
        return None
    constraints = field.get('constraints') or {}
    if (constraints.get('minimum') is not None and value < constraints['minimum']
            or constraints.get('maximum') is not None and value > constraints['maximum']):
        return None
    return value


def project_field(field, *, page=1, page_length=20, search=''):
    """从正式逻辑字段投影三项提示；不重复实现最终值校验。"""
    kind = field.get('type')
    if kind not in SCALAR_TYPES:
        raise ValueError('该字段不是已声明的表格标量，不能按单值输入：%s' % field.get('id', ''))
    domain = field.get('value_domain') or {}
    declared = domain.get('options')
    has_domain = isinstance(declared, list) and bool(declared)
    closed_domain = has_domain and domain.get('allow_custom', True) is False
    if kind == 'boolean':
        values, allow_custom = [True, False], False
        if closed_domain:
            values = [value for value in values if str(value) in declared]
    elif kind == 'choice':
        values = field.get('options')
        if not isinstance(values, list):
            raise ValueError('选项字段缺少正式选项：%s' % field.get('id', ''))
        values, allow_custom = list(values), False
        if closed_domain:
            values = [value for value in values if str(value) in declared]
    elif has_domain:
        values, allow_custom = list(declared), domain.get('allow_custom', True)
        if kind in {'integer', 'decimal'}:
            values = [value for value in (_number_option(code, field) for code in declared)
                      if value is not None]
            if not values and not allow_custom:
                raise ValueError('该数字字段的值域没有可稳定提交的JSON数值，请修正规则：%s'
                                 % field.get('id', ''))
    else:
        values, allow_custom = None, True
    result = {'options': None, 'allow_custom': bool(allow_custom),
              'nullable': not bool(field.get('required'))}
    if values is not None:
        needle = search.casefold()
        matches = [value for value in values if needle in str(value).casefold()]
        start = (page - 1) * page_length
        result['options'] = {'items': [{'value': value} for value in matches[start:start + page_length]],
                             'total': len(matches), 'page': page, 'page_length': page_length,
                             'has_more': start + page_length < len(matches)}
    return result


def read(_service, payload, _context=None):
    import frappe
    from shangshu_core.public_api import get_object_definition

    payload = payload or {}
    object_id = payload.get('object_id')
    names = payload.get('fields')
    try:
        if not isinstance(object_id, str) or not object_id.strip() or len(object_id) > 140:
            raise ValueError('对象身份必填')
        page, length, search = _scope(names, payload.get('page', 1), payload.get('page_length', 20),
                                      payload.get('search', ''))
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    # 这是当前用户的公开可读字段投影；不是未经授权的compiled定义/对象目录。
    definition = get_object_definition(object_id)
    fields = {field['id']: field for field in definition.get('fields') or [] if field.get('id')}
    if definition.get('source') == 'native':
        # native的定义包含声明字段，并不等于逐列可读集；复用原生读记录使用的同一判定。
        from shangshu_core.native_objects import _readable_fields
        readable = _readable_fields(definition['doctype'], declared=list(fields))
        fields = {key: field for key, field in fields.items() if key in readable}
    if any(name not in fields for name in names):
        frappe.throw('指定字段不存在或当前用户不可读', frappe.PermissionError)
    try:
        return {'fields': {name: project_field(fields[name], page=page, page_length=length, search=search)
                           for name in names}}
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
