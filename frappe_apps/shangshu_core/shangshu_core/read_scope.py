"""公共数据访问范围：普通查询有页界，定点读取有行界，全量用途必须显式。

这里只规范访问意图，不授予权限；字段、行、企业、生命周期仍由原数据入口判定。
fields=None 表示当前可读字段，[] 表示只读身份/版本；两者不得混为全物理列。
"""
import frappe

MODES = frozenset({'rows', 'query', 'all'})
PURPOSES = frozenset({'interactive', 'export', 'migration', 'analysis', 'recovery'})


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _identifiers(values, label):
    if not isinstance(values, (list, tuple)):
        _fail('%s必须是明确的数组' % label)
    result = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not value or value != value.strip():
            _fail('%s包含无效身份' % label)
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def normalize_read_scope(scope=None, *, rows=None, fields=None, default_mode=None):
    """规范化已有入口的范围；不复制filters/page/row_ids形成第二套查询来源。"""
    if scope is not None and not isinstance(scope, dict):
        _fail('读取范围必须是对象')
    source = dict(scope or {})
    if set(source) - {'mode', 'purpose', 'fields'}:
        _fail('读取范围包含未声明的配置')
    mode = source.get('mode') or default_mode or ('rows' if rows is not None else None)
    if mode not in MODES:
        _fail('请明确指定目标行、分页查询或全量用途，不能默认读取整表')
    purpose = source.get('purpose', 'interactive')
    if purpose not in PURPOSES:
        _fail('读取用途未支持')
    if mode == 'all' and purpose == 'interactive':
        _fail('日常读取必须限定行或查询范围，不能隐式读取整表')
    if mode == 'rows' and rows is None:
        _fail('按行读取必须明确给出行身份')
    if mode != 'rows' and rows is not None:
        _fail('读取模式与目标行范围冲突')
    if 'fields' in source:
        if fields is not None and fields != source['fields']:
            _fail('字段范围有两份不同声明')
        fields = source['fields']
    return {'mode': mode, 'purpose': purpose,
            'rows': _identifiers(rows, '目标行') if rows is not None else None,
            'fields': _identifiers(fields, '读取字段') if fields is not None else None}
