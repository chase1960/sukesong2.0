"""Batch model metadata stays in core; files only translate the public result."""
import ast
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/model_definition_reads.py'
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files/promotion.py'


def fail(message, kind):
    raise kind(message)


class ManagedDefinitionReads(unittest.TestCase):
    def load(self, rows=()):
        self.get_all = Mock(return_value=list(rows))
        frappe = types.SimpleNamespace(get_all=self.get_all, throw=fail, ValidationError=ValueError)
        modules = patch.dict('sys.modules', {'frappe': frappe,
                             'shangshu_core.model_records': types.SimpleNamespace(MODEL='Shangshu Object Model')})
        modules.start()
        self.addCleanup(modules.stop)
        spec = importlib.util.spec_from_file_location('model_definition_reads_under_test', CORE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_only_explicit_ids_active_metadata_and_one_batch_are_read(self):
        definition = {'fields': [{'id': 'amount'}], 'access': {'read': 'none'}}
        module = self.load([{'name': 'A', 'active_json': json.dumps(definition)}])
        self.assertEqual(module.managed_object_definitions(['A', 'B', 'A', '']), {'A': definition})
        self.get_all.assert_called_once_with('Shangshu Object Model',
            filters={'name': ['in', ['A', 'B']], 'active_revision': ['>', 0]},
            fields=['name', 'active_json'], limit_page_length=2)

    def test_empty_ids_do_not_mean_all_models(self):
        module = self.load()
        self.assertEqual(module.managed_object_definitions([]), {})
        self.assertEqual(module.managed_object_definitions(None), {})
        self.get_all.assert_not_called()

    def test_invalid_scope_is_rejected_before_query(self):
        module = self.load()
        for ids in ('A', {'A': True}, [42]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                module.managed_object_definitions(ids)
        self.get_all.assert_not_called()

    def test_large_explicit_scope_is_bounded_without_per_model_queries(self):
        module = self.load()
        ids = ['M%s' % index for index in range(1001)]
        module.managed_object_definitions(ids)
        self.assertEqual([call.kwargs['limit_page_length'] for call in self.get_all.call_args_list],
                         [500, 500, 1])
        self.assertEqual([name for call in self.get_all.call_args_list
                          for name in call.kwargs['filters']['name'][1]], ids)

    def test_corrupt_or_missing_definition_never_becomes_another_models_definition(self):
        module = self.load([{'name': 'A', 'active_json': '{bad'},
                            {'name': 'B', 'active_json': '[]'},
                            {'name': 'C', 'active_json': '{"fields": []}'}])
        self.assertEqual(module.managed_object_definitions(['A', 'B', 'C', 'missing']),
                         {'C': {'fields': []}})


class FilesDefinitionAdapter(unittest.TestCase):
    def test_files_delegates_then_translates_without_reading_core_table(self):
        tree = ast.parse(FILES.read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'authoritative_definitions')
        public = Mock(return_value={'A': {'fields': [
            {'id': 'amount', 'label': '金额', 'type': 'number', 'access': {'read': 'none'}},
            {'id': 'detail', 'type': 'detail'}], 'access': {'write': 'none'}}})
        namespace = {'frappe': types.SimpleNamespace(get_all=Mock(side_effect=AssertionError('private table read')))}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(FILES), 'exec'), namespace)
        with patch.dict('sys.modules', {'shangshu_core.public_api': types.SimpleNamespace(managed_object_definitions=public)}):
            result = namespace['authoritative_definitions'](['A', 'missing'])
        public.assert_called_once_with(['A', 'missing'])
        self.assertEqual(result, {'A': {'columns': [{'promoted': True, 'field': 'amount',
            'header': '金额', 'access': {'read': 'none'}}], 'access': {'write': 'none'}}})
        self.assertNotIn('missing', result)

    def test_directory_marks_missing_authority_without_dropping_other_files(self):
        path = FILES.with_name('domain.py')
        tree = ast.parse(path.read_text())
        rows = [{'name': name, 'modified': 'v1'} for name in ('known', 'broken', 'plain')]
        meta = {'known': {'promotion_binding': {'object_id': 'A'}},
                'broken': {'promotion_binding': {'object_id': 'missing'},
                           'promotion': {'columns': [{'header': '旧列', 'field': 'old', 'promoted': True}]}},
                'plain': {}}
        def read(_doctype, **kwargs):
            if kwargs['fields'] == ['count(name) as count']:
                return [{'count': 3}]
            if kwargs['fields'] == ['name', 'sheet_meta_json']:
                return [{'name': name, 'sheet_meta_json': json.dumps(value)} for name, value in meta.items()]
            return rows
        core = types.ModuleType('shangshu_core')
        core.org_admin = types.SimpleNamespace(preview_allows=lambda *a, **kw: True,
                                              structure_allows=lambda *a, **kw: True)
        files = types.ModuleType('shangshu_files')
        files.promotion = types.SimpleNamespace(authoritative_definitions=Mock(return_value={
            'A': {'columns': [{'header': '金额', 'field': 'amount', 'promoted': True}], 'access': {}}}))
        files.access_scope = types.SimpleNamespace(context=lambda: {})
        detail = {'can_edit': True, 'can_download': True, 'can_share': True, 'can_assign': True,
                  'can_structure': True, 'attribution': {}, 'upload_version': 1, 'content_revision': 1}
        namespace = {'json': json, 'DOMAIN': 'files', 'FILE_KINDS': {}, 'OBJECT_FIELDS': [],
                     'frappe': types.SimpleNamespace(session=types.SimpleNamespace(user='staff')),
                     'business_get_list': read, 'file_detail': lambda row: dict(detail),
                     '_attribution_label': lambda value: '企业',
                     '_capability_summary': lambda *a, **kw: '原有展示'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and
                 n.name in ('query', '_definition_from_meta', '_load_tags')]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), namespace)
        with patch.dict('sys.modules', {'shangshu_core': core, 'shangshu_files': files,
            'shangshu_core.public_api': types.SimpleNamespace(list_object_companion_files=lambda: [])}):
            result = namespace['query']('files.library', {'scope': 'sheet'})
        self.assertEqual(result['total'], 3)
        self.assertEqual([row['name'] for row in result['rows']], ['known', 'broken', 'plain'])
        self.assertEqual([row['definition_authority'] for row in result['rows']],
                         ['available', 'unavailable', 'unmanaged'])
        self.assertIn('不可用', result['rows'][1]['definition_authority_reason'])


if __name__ == '__main__':
    unittest.main()
