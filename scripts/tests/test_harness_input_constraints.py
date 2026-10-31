"""Harness输入约束：真实纯投影/服务函数，只对权限及存储边界作接缝。"""
import copy
import ast
import json
import subprocess
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/input_constraints.py'
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files/input_constraints.py'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fail(message, kind=ValueError):
    raise kind(message)


class InputConstraints(unittest.TestCase):
    def setUp(self):
        self.core = load(CORE, 'core_constraints_under_test')
        self.files = load(FILES, 'files_constraints_under_test')
        self.definition = {'fields': [
            {'id': 'status', 'type': 'text', 'required': True,
             'value_domain': {'options': ['已接收', '待确认', '受理 '], 'allow_custom': False}},
            {'id': 'note', 'type': 'long_text', 'required': False},
            {'id': 'choice', 'type': 'choice', 'required': False, 'options': ['甲', '乙']},
            {'id': 'flag', 'type': 'boolean', 'required': False},
            {'id': 'lines', 'type': 'detail', 'required': False},
        ], 'doctype': 'SECRET_PHYSICAL_TABLE', 'source': 'managed'}
        self.get_definition = Mock(return_value=self.definition)
        self.doc = SimpleNamespace(name='file-a', status='Active', check_permission=Mock())
        self.frappe = SimpleNamespace(throw=fail, ValidationError=ValueError,
            PermissionError=PermissionError, get_doc=Mock(return_value=self.doc))
        self.file_definition = {'promoted': True, 'binding_current': True, 'columns': [
            {'header': '状态', 'field': 'status', 'promoted': True,
             'rules': {'required': False, 'options': ['旧值'], 'allow_custom': True,
                       'option_labels': {'已接收': '收到', '待确认': '等待'}}},
            {'header': '备注', 'promoted': False},
        ]}
        self.promotion = SimpleNamespace(load_definition=Mock(return_value=self.file_definition),
            _managed_binding=Mock(return_value={'object_id': 'object-a'}))
        self.public = SimpleNamespace(get_object_definition=self.get_definition,
            invoke_domain_service=Mock(side_effect=lambda sid, payload:
                self.core.read(sid, payload, {})))
        self.modules = patch.dict(sys.modules, {'frappe': self.frappe,
            'shangshu_core.public_api': self.public,
            'shangshu_files': SimpleNamespace(promotion=self.promotion)})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def object(self, fields, **kwargs):
        return self.core.read('platform.object.input_constraints',
                              {'object_id': 'object-a', 'fields': fields, **kwargs}, {})

    def sheet(self, headers, **kwargs):
        return self.files.read('files.sheet_input_constraints',
                               {'table': 'file-a', 'headers': headers, **kwargs}, {})

    def test_values_only_three_attributes_and_no_physical_details(self):
        result = self.object(['status'])
        self.assertEqual(set(result), {'fields'})
        info = result['fields']['status']
        self.assertEqual(set(info), {'options', 'allow_custom', 'nullable'})
        self.assertFalse(info['allow_custom']); self.assertFalse(info['nullable'])
        self.assertEqual([item['value'] for item in info['options']['items']],
                         ['已接收', '待确认', '受理 '])
        self.assertNotIn('SECRET_PHYSICAL_TABLE', repr(result))
        self.get_definition.assert_called_once_with('object-a')

    def test_boolean_values_stay_boolean_and_are_distinct_from_empty(self):
        info = self.object(['flag'])['fields']['flag']
        values = [item['value'] for item in info['options']['items']]
        self.assertEqual(values, [True, False]); self.assertTrue(all(type(v) is bool for v in values))
        self.assertTrue(info['nullable']); self.assertFalse(info['allow_custom'])

    def test_closed_choice_and_unrestricted_optional_text_are_different(self):
        result = self.object(['choice', 'note'])['fields']
        self.assertFalse(result['choice']['allow_custom'])
        self.assertEqual(result['note'], {'options': None, 'allow_custom': True, 'nullable': True})

    def test_optional_value_domain_defaults_to_custom_and_empty_list_stays_unrestricted(self):
        self.definition['fields'][0].update(required=False, value_domain={'options': ['甲']})
        self.assertTrue(self.object(['status'])['fields']['status']['allow_custom'])
        self.definition['fields'][0]['value_domain'] = {'options': [], 'allow_custom': False}
        self.assertEqual(self.object(['status'])['fields']['status'],
                         {'options': None, 'allow_custom': True, 'nullable': True})

    def test_large_list_is_bounded_and_page_miss_is_not_unrestricted(self):
        values = ['标准项%03d' % i for i in range(73)]
        self.definition['fields'][0]['value_domain']['options'] = values
        info = self.object(['status'], page=2, page_length=50)['fields']['status']
        self.assertEqual([item['value'] for item in info['options']['items']], values[50:])
        self.assertEqual(info['options']['total'], 73)
        self.assertFalse(info['options']['has_more']); self.assertFalse(info['allow_custom'])
        missing = self.object(['status'], search='不匹配')['fields']['status']
        self.assertEqual(missing['options']['items'], [])
        self.assertFalse(missing['allow_custom']); self.assertFalse(missing['nullable'])

    def test_boolean_and_choice_respect_additional_closed_value_domain(self):
        self.definition['fields'][3]['value_domain'] = {'options': ['False'], 'allow_custom': False}
        boolean = self.object(['flag'])['fields']['flag']
        self.assertEqual(boolean['options']['items'], [{'value': False}])
        self.definition['fields'][2]['value_domain'] = {'options': ['乙'], 'allow_custom': False}
        choice = self.object(['choice'])['fields']['choice']
        self.assertEqual(choice['options']['items'], [{'value': '乙'}])

    def test_numeric_value_domains_return_numbers_that_pass_real_rules_after_json(self):
        validator = load(CORE.with_name('schema_validation.py'), 'numeric_constraint_schema')
        namespace = {'frappe': self.frappe}
        for source, function in [('model_records.py', '_check_value_domain'), ('model_schema.py', 'field_schema')]:
            tree = ast.parse(CORE.with_name(source).read_text())
            node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == function)
            exec(compile(ast.Module(body=[node], type_ignores=[]), str(CORE.with_name(source)), 'exec'), namespace)
        for kind, codes, wanted in [('integer', ['0', '1', '2', '001', '-0', '2147483648'], [0, 1, 2]),
                                    ('decimal', ['1', '1.5', '1e-05', '001', 'NaN', 'Infinity'], [1, 1.5, 0.00001])]:
            with self.subTest(kind=kind):
                field = {'id': 'numeric', 'label': '数字', 'type': kind, 'required': False,
                         'value_domain': {'options': codes, 'allow_custom': False}}
                self.definition['fields'] = [field]
                values = [item['value'] for item in self.object(['numeric'])['fields']['numeric']['options']['items']]
                self.assertEqual(values, wanted)
                self.assertTrue(all(type(value) in (int, float) for value in values))
                wire = subprocess.run(['node', '-e', 'process.stdin.on("data",x=>process.stdout.write(JSON.stringify(JSON.parse(x))))'],
                    input=json.dumps(values), text=True, capture_output=True, check=True).stdout
                for value in json.loads(wire):
                    namespace['_check_value_domain'](field, value)
                    validator._validate_schema(value, namespace['field_schema'](field))
        field = {'id': 'numeric', 'label': '数字', 'type': 'integer', 'required': False,
                 'constraints': {'minimum': 2, 'maximum': 3},
                 'value_domain': {'options': ['1', '2', '4'], 'allow_custom': False}}
        self.definition['fields'] = [field]
        self.assertEqual(self.object(['numeric'])['fields']['numeric']['options']['items'], [{'value': 2}])

    def test_numeric_ambiguous_closed_domains_are_not_presented_as_legal_candidates(self):
        for kind, codes in [('integer', ['001', '1.0']), ('decimal', ['1.0', '-0.0', '9007199254740993'])]:
            with self.subTest(kind=kind):
                self.definition['fields'] = [{'id': 'numeric', 'type': kind, 'required': False,
                    'value_domain': {'options': codes, 'allow_custom': False}}]
                with self.assertRaisesRegex(ValueError, '稳定'):
                    self.object(['numeric'])

    def test_native_field_access_uses_real_open_and_closed_mode_reader(self):
        native_tree = ast.parse(CORE.with_name('native_objects.py').read_text())
        node = next(n for n in native_tree.body if isinstance(n, ast.FunctionDef) and n.name == '_readable_fields')
        env = {'frappe': self.frappe}
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'native_objects.py', 'exec'), env)
        mode = SimpleNamespace(is_open=Mock(return_value=False))
        permissions = Mock(return_value=['note'])
        self.definition.update(source='native', doctype='Native Metadata')
        self.frappe.session = SimpleNamespace(user='staff')
        with patch.dict(sys.modules, {'shangshu_core': SimpleNamespace(business_access=mode),
                'shangshu_core.native_objects': SimpleNamespace(_readable_fields=env['_readable_fields']),
                'frappe.model': SimpleNamespace(get_permitted_fields=permissions)}):
            with self.assertRaises(PermissionError): self.object(['status'])
            self.assertEqual(set(self.object(['note'])['fields']), {'note'})
            permissions.assert_called_with('Native Metadata', user='staff', permission_type='read')
            mode.is_open.return_value = True
            self.assertEqual(set(self.object(['status'])['fields']), {'status'})
            with self.assertRaises(PermissionError): self.object(['physical_unlisted'])

    def test_search_and_paging_keep_declared_values_exact(self):
        self.definition['fields'][0]['value_domain']['options'] = ['已受理', '待确认', '受理 ']
        result = self.object(['status'], search='受', page=2, page_length=1)['fields']['status']['options']
        self.assertEqual(result, {'items': [{'value': '受理 '}], 'total': 2,
                                 'page': 2, 'page_length': 1, 'has_more': False})

    def test_hidden_unknown_or_non_scalar_field_is_rejected(self):
        for fields, kind in [(['secret'], PermissionError), (['invented'], PermissionError),
                              (['lines'], ValueError)]:
            with self.subTest(fields=fields), self.assertRaises(kind): self.object(fields)

    def test_invalid_scope_and_paging_rejected_before_metadata(self):
        for fields, params in [([], {}), (['note', 'note'], {}), (['note'] * 65, {}),
                (['note'], {'page': 0}), (['note'], {'page_length': 51}),
                (['note'], {'page': True}), (['note'], {'search': 'x' * 201})]:
            with self.subTest(fields=fields, params=params), self.assertRaises(ValueError):
                self.object(fields, **params)
        self.get_definition.assert_not_called()

    def test_permission_error_propagates_without_discovery_fallback(self):
        self.get_definition.side_effect = PermissionError('denied')
        with self.assertRaises(PermissionError): self.object(['status'])
        self.get_definition.assert_called_once()

    def test_sheet_uses_formal_rules_and_labels_do_not_change_saved_values(self):
        before = copy.deepcopy(self.definition)
        result = self.sheet(['状态', '备注', '不存在'])
        self.assertEqual(set(result), {'table', 'columns'})
        self.assertEqual(set(result['columns']), {'状态'})
        info = result['columns']['状态']
        self.assertFalse(info['allow_custom']); self.assertFalse(info['nullable'])
        self.assertEqual(info['options']['items'][:2],
                         [{'value': '已接收', 'label': '收到'}, {'value': '待确认', 'label': '等待'}])
        self.assertEqual(self.definition, before)
        self.doc.check_permission.assert_called_once_with('read')
        self.public.invoke_domain_service.assert_called_once_with('platform.object.input_constraints',
            {'object_id': 'object-a', 'fields': ['status'], 'page': 1, 'page_length': 20, 'search': ''})

    def test_sheet_free_columns_do_not_invent_constraints_or_read_records(self):
        self.assertEqual(self.sheet(['备注', '不存在']), {'table': 'file-a', 'columns': {}})
        self.public.invoke_domain_service.assert_not_called()

    def test_sheet_recycled_stale_or_missing_binding_rejected(self):
        self.doc.status = 'Recycled'
        with self.assertRaises(PermissionError): self.sheet(['状态'])
        self.doc.status = 'Active'; self.file_definition['binding_current'] = False
        with self.assertRaises(ValueError): self.sheet(['状态'])
        self.file_definition['binding_current'] = True; self.promotion._managed_binding.return_value = None
        with self.assertRaises(ValueError): self.sheet(['状态'])
        self.public.invoke_domain_service.assert_not_called()

    def test_sheet_hidden_field_is_not_silently_unrestricted(self):
        self.definition['fields'] = [f for f in self.definition['fields'] if f['id'] != 'status']
        with self.assertRaises(PermissionError): self.sheet(['状态'])

    def test_actual_service_registrations_enforce_scope_and_are_read_only(self):
        validator = load(CORE.with_name('schema_validation.py'), 'constraint_schema_validator')
        for module, sid, identity, names in [
                (CORE.with_name('domain.py'), 'platform.object.input_constraints', 'object_id', 'fields'),
                (FILES.with_name('domain.py'), 'files.sheet_input_constraints', 'table', 'headers')]:
            tree = ast.parse(module.read_text())
            env = {'input_constraints_schema': self.core.input_schema, 'ROLES': ['Desk User']}
            if names == 'headers':
                nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                         and node.name in {'schema', 'text'}]
                exec(compile(ast.Module(body=nodes, type_ignores=[]), str(module), 'exec'), env)
            matches = [node for node in ast.walk(tree) if isinstance(node, ast.Dict)
                and any(isinstance(key, ast.Constant) and key.value == 'id'
                        and isinstance(value, ast.Constant) and value.value == sid
                        for key, value in zip(node.keys, node.values))]
            self.assertEqual(len(matches), 1, sid)
            registration = eval(compile(ast.Expression(matches[0]), str(module), 'eval'), env)
            self.assertEqual(registration['effect'], 'read')
            schema = registration['input_schema']
            validator._validate_schema({identity: 'test', names: ['one'], 'page_length': 50}, schema)
            for invalid in [{identity: 'test', names: []}, {identity: 'test', names: ['a', 'a']},
                            {identity: 'test', names: ['a'], 'page_length': 51},
                            {identity: 'test', names: ['a'], 'control_type': 'dropdown'}]:
                with self.subTest(service=sid, invalid=invalid), self.assertRaises(ValueError):
                    validator._validate_schema(invalid, schema)


if __name__ == '__main__': unittest.main()
