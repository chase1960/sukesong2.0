"""公开已知行值读只包装原get_records；真实范围/投影/权限逻辑仍运行。"""
import ast
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from _f_module_seam import install_real_environment
import test_record_read_projection as projection_fixture

install_real_environment('shangshu_core')
from shangshu_core import model_records as records, record_values

OBJECT = 'com.shangshu.app.tests.object.invoice'
CORE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core'


class HarnessValuesRead(unittest.TestCase):
    def setUp(self):
        projection_fixture.RecordReadProjection.setUp(self)
        self.bulk.return_value = [{**self.row, 'name': 'R1', 'f_amount': 1},
                                 {**self.row, 'name': 'R2', 'f_amount': 2}]
        self.modules = patch.dict(sys.modules, {'frappe': self.frappe})
        self.modules.start(); self.addCleanup(self.modules.stop)

    def call(self, names=None, fields=None, object_id=OBJECT):
        return record_values.read('platform.object.values_read', {
            'object_id': object_id, 'names': ['R2', 'R1'] if names is None else names,
            'fields': ['amount'] if fields is None else fields}, {})

    def test_known_rows_use_one_original_batch_read_and_requested_fields(self):
        with patch.object(records, 'get_records', wraps=records.get_records) as batch, \
                patch.object(records, 'get_record', side_effect=AssertionError('不能逐行读')), \
                patch.object(records, 'query_records', side_effect=AssertionError('不能全表搜索')), \
                patch.object(records, '_record', side_effect=AssertionError('不能整行文档')):
            result = self.call()
        batch.assert_called_once_with(OBJECT, ['R2', 'R1'], fields=['amount'],
            read_scope={'mode': 'rows', 'purpose': 'interactive'})
        self.assertEqual([row['name'] for row in result['rows']], ['R2', 'R1'])
        self.assertEqual([row['amount'] for row in result['rows']], [2, 1])
        self.assertEqual(set(result['rows'][0]), {'name', 'modified', 'creation', 'amount'})
        self.bulk.assert_called_once()
        self.assertEqual(self.bulk.call_args.args[1], ['R2', 'R1'])
        self.assertEqual(self.bulk.call_args.args[2],
                         ['name', 'modified', 'creation', 'owner', 'ss_recycled', 'f_amount'])

    def test_empty_duplicate_or_oversized_scope_rejected_before_read(self):
        for names, fields in [([], ['amount']), (['R1'], []), (['R1', 'R1'], ['amount']),
                (['R1'], ['amount', 'amount']), (['R%d' % i for i in range(51)], ['amount']),
                (['R1'], ['f%d' % i for i in range(65)]), ([' R1'], ['amount'])]:
            with self.subTest(names=names, fields=fields), self.assertRaises(ValueError):
                self.call(names, fields)
        self.bulk.assert_not_called()
        records._load.assert_not_called()

    def test_native_objects_are_explicitly_rejected_without_query(self):
        with self.assertRaisesRegex(ValueError, '受管'):
            self.call(object_id='finance.invoice')
        self.bulk.assert_not_called(); records._load.assert_not_called()

    def test_original_field_permission_and_missing_record_errors_propagate(self):
        with self.assertRaises(PermissionError): self.call(fields=['secret'])
        self.bulk.assert_not_called()
        with self.assertRaises(LookupError): self.call(names=['R404'])

    def test_original_owner_and_recycle_checks_still_apply(self):
        self.bulk.return_value = [{**self.row, 'name': 'R1', 'owner': 'another'}]
        with self.assertRaises(PermissionError): self.call(names=['R1'])
        self.bulk.return_value = [{**self.row, 'name': 'R1', 'ss_recycled': 1}]
        with self.assertRaises(ValueError): self.call(names=['R1'])

    def test_registration_uses_bounded_read_schema(self):
        tree = ast.parse((CORE / 'domain.py').read_text())
        node = next(node for node in ast.walk(tree) if isinstance(node, ast.Dict)
            and any(isinstance(k, ast.Constant) and k.value == 'id'
                    and isinstance(v, ast.Constant) and v.value == 'platform.object.values_read'
                    for k, v in zip(node.keys, node.values)))
        spec = eval(compile(ast.Expression(node), 'domain.py', 'eval'),
                    {'values_read_schema': record_values.input_schema})
        self.assertEqual(spec['effect'], 'read')
        self.assertEqual(spec['input_schema']['required'], ['object_id', 'names', 'fields'])
        self.assertEqual(spec['input_schema']['properties']['names']['maxItems'], 50)
        self.assertEqual(spec['input_schema']['properties']['fields']['maxItems'], 64)


if __name__ == '__main__': unittest.main()
