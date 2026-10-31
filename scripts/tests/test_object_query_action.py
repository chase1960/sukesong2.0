"""公共查询动作接线：真实注册/schema/handler/对象投影，只有框架与数据库用接缝。"""
import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from _f_module_seam import install_real_environment
import test_record_read_projection as projection_fixture

install_real_environment('shangshu_core')
from shangshu_core import (business_access, domain, domains, manifest, native_objects, objects, public_handlers,
                          runtime, schema_validation, model_records as records, result_sets)

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core'
ACTION = 'platform.object.query'
OBJECT = 'com.shangshu.app.test.object.invoice'


def registered_query_call():
    """取 install 中原注册调用，实际执行原 register_action，不手写一份新 schema。"""
    tree = ast.parse((CORE / 'install.py').read_text())
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == 'register_action'
             and node.args and isinstance(node.args[0], ast.Constant)
             and node.args[0].value == ACTION]
    if len(calls) != 1:
        raise AssertionError('查询动作必须只有一处当前定义')
    return calls[0]


class ActionRegistry:
    """文档存储接缝；不可变比较、序列化和 schema 验证全部执行生产代码。"""
    def __init__(self):
        self.docs = {}
        self.db = SimpleNamespace(exists=lambda dt, name: name in self.docs)

    def get_doc(self, source, name=None):
        if not isinstance(source, dict):
            return self.docs[name]
        store = self.docs

        class Doc(dict):
            def insert(self, **kwargs):
                store[self['registry_key']] = self
                return self
        return Doc(copy.deepcopy(source))


class ObjectQueryAction(unittest.TestCase):
    def setUp(self):
        projection_fixture.RecordReadProjection.setUp(self)
        self.registry = ActionRegistry()
        self.frappe.db = self.registry.db
        self.frappe.get_doc = self.registry.get_doc
        self.frappe.DuplicateEntryError = RuntimeError
        self.model.application, self.model.active_revision = 'app', 1
        self.compiled['title'] = '案件'
        # 本组查询使用标量夹具；明细投影沿原 test_record_read_projection 覆盖。
        self.compiled['fields'] = self.compiled['fields'][:3]
        self.compiled['doctype']['fields'] = self.compiled['doctype']['fields'][:3]
        self.define = Mock(return_value={'id': OBJECT, 'name': '案件', 'fields': []})
        self.trace = projection_fixture.RecordReadProjection.database_scope(self, [
            {**self.row, 'name': 'R%d' % i} for i in range(3)] + [
            {**self.row, 'name': 'other', 'owner': 'other'},
            {**self.row, 'name': 'trash', 'ss_recycled': 1}])
        for target, name, value in (
            (runtime, 'frappe', self.frappe),
            (schema_validation, 'frappe', self.frappe),
            (objects, 'frappe', self.frappe),
            (domains, 'raw_resource', Mock(return_value=(None, None))),
            (objects, 'raw_resource', Mock(return_value=(None, None))),
            (records, '_subject', Mock(return_value={})),
            (records, '_fields_for_op', Mock(side_effect=lambda c, r, o, s: c['fields'])),
            (records, '_query_capabilities', Mock(return_value={
                'search_max_length': 200, 'search_fields': ['title'], 'sort_fields': ['name']})),
            (records, 'definition', self.define),
            (result_sets, 'issue', Mock(return_value={'id': 'rs-test'})),
            (records.query_receipt, 'build_receipt', Mock(return_value={})),
        ):
            scoped = patch.object(target, name, value)
            scoped.start()
            self.addCleanup(scoped.stop)
        self.definition = self.register_current()

    def register_current(self):
        return eval(compile(ast.Expression(registered_query_call()), str(CORE / 'install.py'), 'eval'),
                    {'register_action': runtime.register_action})

    def validate(self, payload):
        schema_validation._validate_schema(payload, json.loads(self.definition['input_schema_json']))

    def invoke(self, payload):
        self.validate(payload)
        return public_handlers.execute_action(ACTION, payload, {})

    def test_current_action_is_new_version_and_registration_is_idempotent(self):
        self.assertEqual(self.definition['action_version'], '1.2.0')
        self.assertIs(self.register_current(), self.definition)
        self.definition['title'] = '不允许同版本改定义'
        with self.assertRaises(RuntimeError):
            self.register_current()

    def test_old_registry_definition_is_preserved_and_rejects_new_arguments(self):
        legacy_schema = {'type': 'object', 'additionalProperties': False, 'required': [],
            'properties': {'object_id': {'type': 'string'}, 'filters': {'type': 'object'},
                           'page': {'type': 'integer', 'minimum': 1},
                           'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 100},
                           'result_set': {'type': 'string'}}}
        old = runtime.register_action(ACTION, '1.1.0', '查询业务对象', 'read', 'none',
                                      ['Desk User'], legacy_schema, {}, 30, 'safe_read')
        before = copy.deepcopy(old)
        self.register_current()
        self.assertEqual(self.registry.docs[ACTION + '@1.1.0'], before)
        schema_validation._validate_schema({'object_id': OBJECT}, legacy_schema)
        with self.assertRaises(ValueError):
            schema_validation._validate_schema({'object_id': OBJECT, 'fields': []}, legacy_schema)

    def test_requested_projection_reaches_real_record_query_and_skips_definition(self):
        result = self.invoke({'object_id': OBJECT, 'page': 2, 'page_length': 1,
                              'fields': ['amount'], 'include_definition': False})
        self.assertEqual(result['rows'], [{'name': 'R1', 'modified': 'v1', 'creation': 'created', 'amount': 7}])
        self.assertEqual(result['total'], 3)
        self.assertEqual(self.trace, [['R1']])
        self.assertEqual(self.bulk.call_args.args[2],
                         ['name', 'modified', 'creation', 'owner', 'ss_recycled', 'f_amount'])
        self.assertIsNone(result['object'])
        self.define.assert_not_called()

    def test_fields_inside_query_scope_and_empty_projection_are_not_dropped(self):
        result = self.invoke({'object_id': OBJECT,
            'read_scope': {'mode': 'query', 'purpose': 'interactive', 'fields': []},
            'include_definition': False})
        self.assertEqual(len(result['rows']), 3)
        self.assertTrue(all(set(row) == {'name', 'modified', 'creation'} for row in result['rows']))
        self.assertEqual(self.bulk.call_args.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled'])

    def test_legacy_defaults_keep_visible_projection_and_definition(self):
        result = self.invoke({'object_id': OBJECT})
        self.assertEqual(set(result['rows'][0]), {'name', 'modified', 'creation', 'title', 'amount'})
        self.assertEqual(result['object']['id'], OBJECT)
        self.define.assert_called_once_with(OBJECT)

    def test_filters_and_result_set_remain_authoritative_with_projection(self):
        trace = projection_fixture.RecordReadProjection.database_scope(self, [
            {**self.row, 'name': 'kept', 'f_title': '保留'},
            {**self.row, 'name': 'excluded', 'f_title': '排除'}])
        with patch.object(result_sets, 'resolve', return_value={
                'object_id': OBJECT, 'criteria': {'filters': {'title': '保留'}}}) as resolve:
            result = self.invoke({'object_id': OBJECT, 'result_set': 'rs-base',
                'filters': {'amount': 7}, 'fields': ['amount'], 'include_definition': False})
        resolve.assert_called_once_with('rs-base')
        self.assertEqual(result['total'], 1)
        self.assertEqual(trace, [['kept']])
        self.assertEqual(result['rows'], [{'name': 'kept', 'modified': 'v1', 'creation': 'created', 'amount': 7}])
        self.assertNotIn('f_title', self.bulk.call_args.args[2])

    def test_empty_projection_still_checks_source_access(self):
        with patch.object(records, '_load', side_effect=PermissionError('来源已撤权')), \
                self.assertRaisesRegex(PermissionError, '来源已撤权'):
            self.invoke({'object_id': OBJECT, 'fields': [], 'include_definition': False})
        self.bulk.assert_not_called()

    def test_native_handler_uses_real_sql_projection_and_search_filter_dependencies(self):
        fields = [{'id': 'title', 'type': 'text'}, {'id': 'amount', 'type': 'decimal'},
                  {'id': 'secret', 'type': 'text'}, {'id': 'status', 'type': 'text'}]
        item = {'id': 'native', 'doctype': 'Invoice', 'fields': fields,
                'filter_fields': ['status'], 'operations': ['read']}
        block = {'fields': fields, 'title': '原生表', 'search_fields': ['title'], 'order_by': 'modified desc'}
        found = ({'id': 'domain'}, item, block, {}, {field['id']: field for field in fields})
        query = Mock(side_effect=lambda dt, **kw: [SimpleNamespace(count=1)]
                     if kw['fields'] == ['count(name) as count'] else
                     [{'name': 'n1', 'modified': 'v1', 'title': 'needle', 'amount': 2,
                       'secret': 'never', 'status': 'Open'}])
        with patch.object(native_objects, 'frappe', self.frappe), \
                patch.object(native_objects, 'declared', return_value=found), \
                patch.object(native_objects, '_require', return_value=found), \
                patch.object(native_objects, '_gate_read'), \
                patch.object(native_objects, '_readable_fields', return_value={'name', 'modified', 'title', 'amount', 'status'}), \
                patch.object(native_objects, 'definition', side_effect=AssertionError('不应装配定义')), \
                patch.object(business_access, 'authorized_get_list', query):
            result = self.invoke({'object_id': 'native', 'fields': ['amount'], 'include_definition': False,
                                  'filters': {'$search': 'needle', '$sort': 'title', 'status': 'Open'}})
            self.assertEqual(result['rows'], [{'name': 'n1', 'modified': 'v1', 'amount': 2}])
            self.assertNotIn('object', result)
            params = query.call_args_list[0].kwargs
            self.assertEqual(params['fields'], ['amount', 'name', 'modified'])
            self.assertEqual(params['filters'], {'status': 'Open'})
            self.assertEqual(set(params['or_filters']), {'title'})
            self.assertEqual(params['order_by'], 'title asc, name asc')
            query.reset_mock()
            with self.assertRaises(PermissionError):
                self.invoke({'object_id': 'native', 'fields': ['secret'], 'include_definition': False})
            query.assert_not_called()

    def test_hidden_unknown_and_conflicting_fields_reject_before_row_reads(self):
        for fields, error in ((['secret'], PermissionError), (['unknown'], ValueError)):
            with self.subTest(fields=fields), self.assertRaises(error):
                self.invoke({'object_id': OBJECT, 'fields': fields, 'include_definition': False})
        with self.assertRaisesRegex(ValueError, '两份不同'):
            self.invoke({'object_id': OBJECT, 'fields': ['amount'], 'read_scope': {'fields': ['title']}})
        self.bulk.assert_not_called()

    def test_schema_rejects_non_query_and_undeclared_properties_before_handler(self):
        invalid = [
            {'read_scope': {'mode': 'all', 'purpose': 'export'}},
            {'read_scope': {'mode': 'rows'}},
            {'read_scope': {'mode': 'query', 'row_ids': []}},
            {'read_scope': {'filters': {}}}, {'read_scope': {'purpose': 'unknown'}},
            {'read_scope': 'query'}, {'fields': 'amount'}, {'fields': [1]},
            {'fields': ['']}, {'include_definition': 0}, {'unknown': True},
            {'page_length': 101},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.validate({'object_id': OBJECT, **payload})
        self.bulk.assert_not_called()

    def test_handler_cannot_turn_all_scope_into_default_query(self):
        # 即使从内部直接调 handler，read_scope 仍须进入原 query 范围守卫。
        with self.assertRaisesRegex(ValueError, '分页查询范围'):
            public_handlers.execute_action(ACTION, {'object_id': OBJECT,
                'read_scope': {'mode': 'all', 'purpose': 'export'}}, {})
        self.bulk.assert_not_called()

    def test_omitted_object_id_preserves_existing_not_registered_result(self):
        # 原 handler 并无目录分支；不要将空对象调用悄悄变成更宽的目录读。
        with self.assertRaisesRegex(LookupError, '对象未注册'):
            self.invoke({})
        self.bulk.assert_not_called()

    def test_manifest_and_runtime_contribution_still_match(self):
        contribution = domain.get_contribution()
        with patch.object(manifest, 'frappe', SimpleNamespace(
                throw=self.frappe.throw, ValidationError=ValueError,
                get_app_path=lambda _: str(CORE), get_hooks=lambda *a, **kw: [])), \
                patch.object(domains, '_providers', return_value=[contribution]):
            self.assertEqual(manifest.check_registered_manifests(), {'checked': ['com.shangshu.core']})
        resource = next(item for item in contribution['actions'] if item['id'] == ACTION)
        self.assertEqual(resource['handler'], 'shangshu_core.public_handlers.execute_action')
        self.assertIn({'id': ACTION}, contribution['tools'])


if __name__ == '__main__':
    unittest.main()
