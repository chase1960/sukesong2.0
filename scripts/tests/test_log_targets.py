"""一包一事实的无值索引及按目标历史裁剪；复用现有函数接缝。"""
import copy
import datetime
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import load_module_functions
ROOT = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core'


class Attr(dict):
    __getattr__ = dict.get


def change(name, before, after, object_id='object', field='amount'):
    return {'doctype': 'Managed', 'name': name, 'data': {'version': 1, 'object_id': object_id,
        'object_title': 'Table', 'revision': 1, 'changes': [{'field': field, 'label': field,
            'type': 'number', 'before': before, 'after': after}]}}


def package():
    return {'version': 1, 'steps': [
        {'action_id': 'platform.object.update_many', 'record_changes': [change('R1', 1, 2), change('R2', 9, 10)]},
        {'action_id': 'platform.object.update_many', 'record_changes': [change('R1', 2, 3), change('R1', 7, 8, field='secret')]},
        {'action_id': 'other', 'record_changes': [change('R1', 99, 100, object_id='other-object')]},
    ]}


class LogTargets(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.frappe = SimpleNamespace(ValidationError=ValueError,
            throw=lambda message, exc=ValueError: (_ for _ in ()).throw(exc(message)),
            db=SimpleNamespace(bulk_insert=lambda *a, **kw: self.calls.append((a, kw))))
        self.ctx = load_module_functions(ROOT / 'log_targets.py', {'package_targets', 'write_log_targets', 'target_changes'},
                                         stubs={'frappe': self.frappe})

    def test_index_contains_only_distinct_identity_tuples_and_one_bulk_write(self):
        p = package()
        self.ctx['write_log_targets']([SimpleNamespace(log_no='LOG-1', detail_json=json.dumps({'package': p}))])
        self.assertEqual(len(self.calls), 1)
        args, kwargs = self.calls[0]
        self.assertEqual(args[:2], ('Shangshu Log Target', ('name', 'log_no', 'reference_doctype', 'reference_name', 'business_object_id', 'business_name')))
        self.assertEqual(len(args[2]), 3)
        self.assertTrue(all(len(row) == 6 and row[1] == 'LOG-1' for row in args[2]))
        self.assertEqual(kwargs['chunk_size'], 500)

    def test_same_target_in_two_steps_preserves_two_changes_but_one_target(self):
        rows = self.ctx['package_targets']('LOG', package())
        self.assertEqual(rows.count(('LOG', 'Managed', 'R1', 'object', 'R1')), 1)
        values = self.ctx['target_changes'](package(), doctype='Managed', name='R1', object_id='object')
        self.assertEqual([data['changes'][0]['after'] for _, data in values], [2, 3, 8])

    def test_invalid_target_fails_before_bulk_insert_and_singletons_are_unchanged(self):
        p = package(); p['steps'][1]['record_changes'][0]['name'] = ''
        with self.assertRaises(ValueError):
            self.ctx['write_log_targets']([SimpleNamespace(log_no='LOG', detail_json=json.dumps({'package': p}))])
        self.assertEqual(self.calls, [])
        self.ctx['write_log_targets']([SimpleNamespace(log_no='OLD', detail_json='{"record_changes":{}}')])
        self.assertEqual(self.calls, [])


class RecordPackageHistory(unittest.TestCase):
    setUp = LogTargets.setUp
    def test_history_checks_current_record_then_returns_only_target_visible_changes_in_order(self):
        calls = []
        audit = Attr(name='LOG', creation='2026-10-28 10:00:00', actor_user='actor',
                     action_id='files.sheet_cells_write', idempotency_key='parent-key',
                     executor_source='user', package=package(), record_changes_json=None)
        log = SimpleNamespace(merged_legacy_rows=lambda *a, **kw: calls.append(('rows', a, kw)) or [audit],
                              merged_legacy_count=lambda *a, **kw: calls.append(('count', a, kw)) or 1)
        fp = SimpleNamespace(db=SimpleNamespace(get_value=lambda *a: 'Actor'),
                             PermissionError=PermissionError, ValidationError=ValueError, DoesNotExistError=KeyError)
        ctx = load_module_functions(ROOT / 'record_history.py', {'record_history'}, stubs={
            'frappe': fp, 'unified_log': log,
            'get_datetime': datetime.datetime.fromisoformat, 'get_system_timezone': lambda: 'UTC',
            '_load': lambda *a: (SimpleNamespace(name='object', physical_doctype='Managed'), {'title': 'Table'}, []),
            '_record': lambda *a, **kw: calls.append(('authorize',)),
            '_fields': lambda *a: [{'id': 'amount', 'label': 'Amount', 'type': 'number'}],
            '_references': lambda *a: {}, '_values': lambda *a: {}})
        with patch.dict(sys.modules, {'shangshu_core.log_targets': SimpleNamespace(target_changes=self.ctx['target_changes'])}):
            result = ctx['record_history']('service', {'object_id': 'object', 'name': 'R1'}, {})
        self.assertEqual(calls[0], ('authorize',))
        self.assertEqual(result['total'], 1)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual([(c['before'], c['after']) for c in result['items'][0]['changes']], [(1, 2), (2, 3)])
        self.assertEqual(result['items'][0]['id'], 'LOG')
        self.assertNotIn('package', result['items'][0])
        self.assertNotIn('action_id', calls[1][1][2] if len(calls[1][1]) > 2 else calls[1][2]['filters'])
        self.assertIn('record_action_ids', calls[1][2])
        calls.clear()
        ctx['_record'] = lambda *a, **kw: (_ for _ in ()).throw(PermissionError('revoked'))
        with self.assertRaises(PermissionError):
            ctx['record_history']('service', {'object_id': 'object', 'name': 'R1'}, {})
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
