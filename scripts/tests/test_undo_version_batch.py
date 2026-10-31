"""撤回版本回填保持逐记录语义，物理更新按批执行；不替代站点事务测试。"""
import types
import unittest
from pathlib import Path

from _f_module_seam import load_module_functions

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/promotion_records.py'


class TestUndoVersionBatch(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.cleared = []
        self.fake = types.SimpleNamespace(db=types.SimpleNamespace(
            bulk_update=lambda *args, **kwargs: self.calls.append((args, kwargs)),
            value_cache={'Managed Test Row': {'modified': 'stale'}}),
            clear_document_cache=lambda *args: self.cleared.append(args))
        core = types.SimpleNamespace(subject_access=types.SimpleNamespace())
        self.context = load_module_functions(SOURCE, {'_restore_record_versions'}, stubs={
            'frappe': self.fake, 'shangshu_core': core,
            'shangshu_core.design_support': types.SimpleNamespace(require_designer=lambda: None),
        })
        self.restore = self.context['_restore_record_versions']
        self.model = types.SimpleNamespace(physical_doctype='Managed Test Row')

    def test_500_versions_use_one_bulk_entry_and_only_touch_modified(self):
        targets = [('row-%s' % i, '2026-10-25 12:00:00') for i in range(500)]
        current = {name: '2026-10-28 12:00:00' for name, _ in targets}
        self.assertEqual(self.restore(self.model, targets, current), 500)
        self.assertEqual(len(self.calls), 1)
        args, kwargs = self.calls[0]
        self.assertEqual(args[0], self.model.physical_doctype)
        self.assertEqual(args[1], {name: {'modified': version} for name, version in targets})
        self.assertEqual(kwargs, {'chunk_size': 500, 'update_modified': False})
        self.assertEqual(self.cleared, [(self.model.physical_doctype, name) for name, _ in targets])
        self.assertNotIn(self.model.physical_doctype, self.fake.db.value_cache)

    def test_missing_equal_or_newer_targets_are_not_restored(self):
        targets = [('ok', '2026-10-25'), ('missing', '2026-10-25'),
                   ('equal', '2026-10-28'), ('future', '2026-10-29'), ('empty', '')]
        current = {name: '2026-10-28' for name in ('ok', 'equal', 'future', 'empty')}
        self.assertEqual(self.restore(self.model, targets, current), 1)
        self.assertEqual(self.calls[0][0][1], {'ok': {'modified': '2026-10-25'}})

    def test_empty_plan_does_not_touch_database(self):
        self.assertEqual(self.restore(self.model, [], {}), 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.cleared, [])

    def test_database_error_is_not_swallowed(self):
        def fail(*args, **kwargs):
            raise RuntimeError('write failed')
        self.fake.db.bulk_update = fail
        with self.assertRaisesRegex(RuntimeError, 'write failed'):
            self.restore(self.model, [('a', '2026-10-25')], {'a': '2026-10-28'})


if __name__ == '__main__':
    unittest.main()
