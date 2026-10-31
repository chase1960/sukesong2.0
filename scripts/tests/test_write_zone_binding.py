"""绑定变化撤销并行资格；工程核验不把回收或索引错位当作无依赖。"""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/binding_metadata.py'


class BindingGate(unittest.TestCase):
    def setUp(self):
        self.sql = Mock()
        self.invalidate = Mock()
        self.frappe = SimpleNamespace(db=SimpleNamespace(sql=self.sql),
            throw=lambda text, error: (_ for _ in ()).throw(error(text)),
            ValidationError=ValueError, DoesNotExistError=KeyError)
        self.modules = patch.dict(sys.modules, {'frappe': self.frappe,
            'shangshu_core.public_api': SimpleNamespace(invalidate_managed_write_zone=self.invalidate)})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        spec = importlib.util.spec_from_file_location('test_binding_metadata_impl', SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.doc = SimpleNamespace(name='file-1', db_set=Mock())

    def old(self, object_id='', indexed_id=None):
        meta = {'promotion_binding': {'object_id': object_id}} if object_id else {}
        return {'name': 'file-1', 'sheet_meta_json': json.dumps(meta),
                'managed_object_id': object_id if indexed_id is None else indexed_id}

    def test_pointer_change_revokes_old_and_new_before_atomic_metadata_write(self):
        self.sql.return_value = [self.old('object-z')]
        events = []
        self.invalidate.side_effect = lambda key: events.append(('revoke', key))
        self.doc.db_set.side_effect = lambda *a, **k: events.append(('write', a[0]))
        self.module.save_meta(self.doc, {'promotion_binding': {'object_id': 'object-a'}})
        self.assertEqual(events[:2], [('revoke', 'object-a'), ('revoke', 'object-z')])
        self.assertEqual(events[2][1]['managed_object_id'], 'object-a')
        self.assertIn('sheet_meta_json', events[2][1])

    def test_ordinary_metadata_change_does_not_touch_model(self):
        self.sql.return_value = [self.old('object-a')]
        self.module.save_meta(self.doc, {'promotion_binding': {'object_id': 'object-a'}, 'widths': {}})
        self.invalidate.assert_not_called()
        self.doc.db_set.assert_called_once()

    def test_unbind_revokes_without_automatically_recertifying(self):
        self.sql.return_value = [self.old('object-a')]
        self.module.save_meta(self.doc, {})
        self.invalidate.assert_called_once_with('object-a')
        self.assertEqual(self.doc.db_set.call_args.args[0]['managed_object_id'], '')

    def test_failed_index_write_is_not_legacy_success(self):
        self.sql.return_value = [self.old()]
        self.doc.db_set.side_effect = RuntimeError('index missing')
        with self.assertRaisesRegex(RuntimeError, 'index missing'):
            self.module.save_meta(self.doc, {'promotion_binding': {'object_id': 'object-a'}})

    def test_all_states_are_inspected_and_recycled_binding_prevents_certification(self):
        self.sql.side_effect = [[{**self.old('object-a'), 'status': 'Recycled'}], []]
        self.assertTrue(self.module.inspect_projection_scope('object-a')['bound'])
        self.assertNotIn('status', self.sql.call_args_list[0].args[0])

    def test_index_mismatch_and_invalid_json_fail_closed(self):
        for row in (self.old('object-a', 'object-b'),
                    {**self.old(), 'sheet_meta_json': 'invalid json'}):
            with self.subTest(row=row):
                self.sql.side_effect = [[row], []]
                with self.assertRaises(ValueError):
                    self.module.inspect_projection_scope('object-a')


if __name__ == '__main__':
    unittest.main()
