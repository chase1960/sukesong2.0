"""File action evidence contains every actual cell delta, independent of UI facts."""
import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
from _f_module_seam import install_real_environment, load_module_functions

install_real_environment()

ROOT = Path(__file__).resolve().parents[2]


class SheetPackageEvidence(unittest.TestCase):
    def setUp(self):
        self.ledger = []
        def document(data):
            self.ledger.append(data)
            return SimpleNamespace(insert=lambda **kw: None)
        fake = SimpleNamespace(get_doc=document, session=SimpleNamespace(user='person'))
        self.ns = load_module_functions(
            ROOT / 'frappe_apps/shangshu_files/shangshu_files/sheet.py', {'_record_op'},
            stubs={'frappe': fake}, overrides={'copy': copy, 'json': json,
                '_fault': lambda *a: None, '_stamp_versions': lambda doc: (1, 2),
                'OP_DOCTYPE': 'Shangshu Sheet Op', 'DOCTYPE': 'Shangshu File'})
        self.doc = SimpleNamespace(name='file-1', file_name='测试.xlsx')

    def record(self, cells, context):
        self.ns['_record_op'](self.doc, 'files.sheet_cells_write', 'op', cells, 3, context)

    def test_full_delta_is_not_truncated_to_summary_limit(self):
        cells = [{'row_id': f'R{i}', 'header': '备注',
                  'before': {'type': 'empty', 'value': None},
                  'after': {'type': 'text', 'value': str(i)}} for i in range(1000)]
        context = {'atomic_package': True, 'idempotency_key': 'pack'}
        self.record(cells, context)
        changes = context['record_change']['data']['changes']
        self.assertEqual(len(changes), 1000)
        self.assertEqual(changes[-1]['after']['value'], '999')
        self.assertEqual(context['record_change']['name'], 'file-1')
        cells[-1]['after']['value'] = 'later edit'
        self.assertEqual(changes[-1]['after']['value'], '999')
        self.assertEqual(len(self.ledger), 1, '撤回台账仍然只写一包')

    def test_skip_equal_cells_and_whole_structure_snapshot(self):
        context = {'atomic_package': True, 'package_structure_changes': [
            {'field': 'rows', 'kind': 'rows_added', 'before': [], 'after': ['R2']}]}
        cells = [{'row_id': 'R1', 'header': '备注', 'before': 2, 'after': 2},
                 {'structure_snapshot': {'large': 'whole table'}, 'before': 1, 'after': 2},
                 {'row_id': 'R2', 'header': '备注', 'before': None, 'after': False}]
        self.record(cells, context)
        changes = context['record_change']['data']['changes']
        self.assertEqual(len(changes), 2)
        self.assertIs(changes[0]['after'], False)
        self.assertEqual(changes[1]['after'], ['R2'])
        self.assertNotIn('package_structure_changes', context)
        self.assertIn('structure_snapshot', json.loads(self.ledger[0]['cells_json'])[1])

    def test_old_nonpackage_action_does_not_change_its_audit_shape(self):
        context = {}
        self.record([{'before': None, 'after': 1}], context)
        self.assertNotIn('record_change', context)
        self.assertEqual(len(self.ledger), 1)


if __name__ == '__main__':
    unittest.main()
