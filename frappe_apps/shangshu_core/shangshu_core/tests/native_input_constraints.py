"""仅自建隔离站的公开服务检查；不建模、不读记录、不上传、不提交。

站点须已加载同版core/files声明；显式给已有测试对象/字段，可附测试表/表头：
bench --site example-perf-20261029.localhost execute \
  shangshu_core.tests.native_input_constraints.run \
  --kwargs '{"object_id":"...","field":"...","table":"...","header":"..."}'
"""
import hashlib
from pathlib import Path
from unittest.mock import patch

import frappe

from shangshu_core.public_api import invoke_domain_service


SITE = 'example-perf-20261029.localhost'


def _assert(condition, message):
    if not condition:
        raise AssertionError(message)


def _check_info(info, page_length):
    _assert(set(info) == {'options', 'allow_custom', 'nullable'}, info)
    _assert(type(info['allow_custom']) is bool and type(info['nullable']) is bool, info)
    options = info['options']
    if options is not None:
        _assert(set(options) == {'items', 'total', 'page', 'page_length', 'has_more'}, options)
        _assert(options['page'] == 1 and options['page_length'] == page_length, options)
        _assert(len(options['items']) <= page_length, options)
        _assert(all('value' in item and not set(item) - {'value', 'label'} for item in options['items']), options)


def run(object_id, field, table=None, header=None, names=None):
    _assert(str(frappe.local.site) == SITE, '仅允许自建隔离站')
    _assert(bool(table) == bool(header), '表与表头必须同时给出')
    checks = []
    try:
        with patch.object(frappe.db, 'commit', side_effect=AssertionError('约束服务不允许提交')):
            result = invoke_domain_service('platform.object.input_constraints', {
                'object_id': object_id, 'fields': [field], 'page': 1, 'page_length': 2})
            _assert(set(result) == {'fields'} and set(result['fields']) == {field}, result)
            _check_info(result['fields'][field], 2)
            checks.append('对象只返回当前字段三项约束；选项分页上限为2')
            try:
                invoke_domain_service('platform.object.input_constraints', {
                    'object_id': object_id, 'fields': ['__not_a_declared_field__']})
            except frappe.PermissionError:
                checks.append('未声明/不可读字段明确拒绝，不降成自由输入')
            else:
                raise AssertionError('未知字段没有被拒绝')
            if table:
                result = invoke_domain_service('files.sheet_input_constraints', {
                    'table': table, 'headers': [header], 'page': 1, 'page_length': 2})
                _assert(set(result) == {'table', 'columns'} and result['table'] == table, result)
                _assert(set(result['columns']) == {header}, result)
                _check_info(result['columns'][header], 2)
                checks.append('表格声明列经公共服务取得正式约束，未返回存储位置')
            if names is not None:
                result = invoke_domain_service('platform.object.values_read', {
                    'object_id': object_id, 'names': names, 'fields': [field]})
                _assert(set(result) == {'rows'} and [row['name'] for row in result['rows']] == names, result)
                _assert(all(not set(row) - {'name', 'modified', 'creation', field}
                            for row in result['rows']), result)
                checks.append('已知受管行值经公开批读返回，顺序与目标字段/版本保持')
        from shangshu_core import input_constraints
        sources = {input_constraints.__name__: hashlib.sha256(Path(input_constraints.__file__).read_bytes()).hexdigest()}
        return {'site': SITE, 'checks': checks, 'source_sha256': sources,
                'scope': '已有测试对象/列的公开只读元数据；不证明完整LLM对话或3850部署',
                'rolled_back': True}
    finally:
        frappe.db.rollback()
