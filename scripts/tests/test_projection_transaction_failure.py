"""投影吞错点必须先调用公共事务守卫；普通文件错误维持原 pending/拒绝语义。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from _f_module_seam import load_module_functions

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/promotion.py'


class DatabaseAborted(Exception):
    pass


class ValidationError(Exception):
    pass


class ProjectionTransactionFailure(unittest.TestCase):
    def setUp(self):
        self.doc = SimpleNamespace(name='F1', version_count=3, reload=Mock(), db_set=Mock())
        self.column = {'field': 'amount', 'header': '金额', 'promoted': True}
        self.definition = {'promoted': True, 'columns': [self.column], 'structure_version': 2}
        self.frappe = SimpleNamespace(flags=SimpleNamespace(),
            db=SimpleNamespace(exists=lambda *a: True),
            get_all=Mock(return_value=[{'name': 'F1'}]), get_doc=Mock(return_value=self.doc),
            ValidationError=ValidationError, PermissionError=PermissionError, DoesNotExistError=KeyError)
        self.frappe.throw = lambda message, exc: (_ for _ in ()).throw(exc(message))
        # Classification/transaction poisoning is tested by core and real two-connection tests.
        # This seam observes whether each files catch invokes that public contract before fallback.
        def guard(error):
            if isinstance(error, DatabaseAborted):
                raise error
        self.guard = Mock(side_effect=guard)
        self.writeback, self.mark, self.clear = Mock(return_value={'written': 1}), Mock(), Mock()
        self.write_managed = Mock()
        self.ctx = load_module_functions(SOURCE,
            {'on_managed_record_change', 'formal_write', 'cell_write', '_save_binding'},
            stubs={'frappe': self.frappe, 'access_scope': SimpleNamespace(),
                   'raise_if_transaction_failed': self.guard},
            overrides=(helpers := {'FILE': 'Shangshu File', 'raise_if_transaction_failed': self.guard,
                '_managed_binding': lambda doc: {'object_id': 'object', 'records': {'R1': 'record'}},
                'load_definition': lambda doc: self.definition,
                'promoted_columns': lambda definition: definition['columns'],
                'column_by_header': lambda *a: self.column,
                '_writeback_rows': self.writeback, '_writeback': self.writeback,
                'mark_writeback_pending': self.mark, 'clear_writeback_pending': self.clear,
                'writeback_pending': lambda doc: {}, '_require_resource_write': lambda doc: None,
                'require_fields_writable': lambda *a, **kw: None, '_check_rules': lambda *a: None,
                'require_field_rules_ok': lambda *a, **kw: None,
                '_load_formal': lambda *a, **kw: {'R1': {'amount': 1}},
                'declared_fields': lambda *a: ['amount'], '_write_managed': self.write_managed,
                'update_row_readiness': lambda *a: None,
                '_reload_locked_file': lambda doc: self.doc, '_load_meta': lambda doc: {},
                '_save_meta': Mock(), '_sync_doc': lambda *a: None}))
        self.ctx.update(helpers)
        self.payload = {'table': 'F1', 'row_id': 'R1', 'header': '金额',
                        'value': {'type': 'number', 'value': 7}, 'values': {'amount': 7}}

    def notify(self):
        return self.ctx['on_managed_record_change']({'object_id': 'object', 'records': {'record': {'amount': 7}}})

    def assert_original_error(self, error, call):
        with self.assertRaises(DatabaseAborted) as raised:
            call()
        self.assertIs(raised.exception, error)

    def test_reverse_lookup_database_error_is_not_empty_success(self):
        error = DatabaseAborted('lookup timeout')
        self.frappe.get_all.side_effect = error
        self.assert_original_error(error, self.notify)
        self.guard.assert_called_once_with(error)
        self.writeback.assert_not_called()

    def test_reverse_lookup_ordinary_error_keeps_existing_fallback(self):
        self.frappe.get_all.side_effect = OSError('ordinary lookup failure')
        self.assertEqual(self.notify()['handled'], 0)

    def test_notification_database_writeback_or_clear_failure_cannot_mark_pending(self):
        for point in ('writeback', 'clear'):
            with self.subTest(point=point):
                self.setUp()
                error = DatabaseAborted(point)
                getattr(self, point).side_effect = error
                self.assert_original_error(error, self.notify)
                self.mark.assert_not_called()

    def test_notification_pending_marker_database_failure_is_not_swallowed(self):
        self.writeback.side_effect = OSError('file full')
        error = DatabaseAborted('mark pending deadlock')
        self.mark.side_effect = error
        self.assert_original_error(error, self.notify)
        self.assertEqual(self.guard.call_args.args, (error,))

    def test_notification_ordinary_file_and_marker_errors_keep_pending(self):
        self.writeback.side_effect = OSError('file full')
        self.assertTrue(self.notify()['pending'])
        self.mark.side_effect = RuntimeError('ordinary marker failure')
        self.assertTrue(self.notify()['pending'])

    def test_formal_and_cell_writeback_database_errors_have_no_pending_receipt(self):
        for function in ('formal_write', 'cell_write'):
            with self.subTest(function=function):
                self.setUp()
                error = DatabaseAborted('writeback timeout')
                self.writeback.side_effect = error
                self.assert_original_error(error, lambda: self.ctx[function](self.payload))
                self.mark.assert_not_called()
                self.doc.reload.assert_not_called()
                self.assertFalse(self.frappe.flags.shangshu_files_own_writeback)

    def test_formal_and_cell_reload_database_error_cannot_return_pending_receipt(self):
        for function in ('formal_write', 'cell_write'):
            with self.subTest(function=function):
                self.setUp()
                self.writeback.side_effect = OSError('file full')
                error = DatabaseAborted('reload timeout')
                self.doc.reload.side_effect = error
                self.assert_original_error(error, lambda: self.ctx[function](self.payload))
                self.mark.assert_called_once()  # Earlier mark is undone by the outer DB rollback.
                self.assertEqual(self.guard.call_args.args, (error,))

    def test_formal_and_cell_ordinary_file_and_reload_errors_keep_pending(self):
        for function in ('formal_write', 'cell_write'):
            with self.subTest(function=function):
                self.setUp()
                self.writeback.side_effect = OSError('file full')
                self.doc.reload.side_effect = RuntimeError('ordinary reload failure')
                result = self.ctx[function](self.payload)
                self.assertTrue(result['pending'])
                self.assertTrue(result['formal_written'])
                self.assertFalse(result['sheet_written'])
                self.mark.assert_called_once()

    def test_plain_cell_database_error_is_not_a_retryable_rejection(self):
        self.column['promoted'] = False
        error = DatabaseAborted('plain cell timeout')
        sheet = SimpleNamespace(write_cell=Mock(side_effect=error))
        with patch.dict(sys.modules, {'shangshu_files': SimpleNamespace(sheet=sheet)}):
            self.assert_original_error(error, lambda: self.ctx['cell_write'](self.payload))

    def test_plain_cell_ordinary_file_error_keeps_existing_failure_receipt(self):
        self.column['promoted'] = False
        sheet = SimpleNamespace(write_cell=Mock(side_effect=OSError('disk full')))
        with patch.dict(sys.modules, {'shangshu_files': SimpleNamespace(sheet=sheet)}):
            result = self.ctx['cell_write'](self.payload)
        self.assertFalse(result['applied'])
        self.assertFalse(result['rejected'])
        self.assertTrue(result['fatal'])
        self.assertTrue(result['retryable'])

    def test_new_row_binding_database_failure_is_not_missing_column_fallback(self):
        error = DatabaseAborted('binding update deadlock')
        self.ctx['_save_meta'].side_effect = error
        self.assert_original_error(error, lambda: self.ctx['_save_binding'](self.doc, {'object_id': 'object'}))
        self.ctx['_save_meta'].side_effect = RuntimeError('binding index unavailable')
        with self.assertRaisesRegex(RuntimeError, 'binding index unavailable'):
            self.ctx['_save_binding'](self.doc, {'object_id': 'object'})

    def test_already_poisoned_transaction_cannot_disguise_itself_as_file_error(self):
        original = DatabaseAborted('earlier database abort')
        self.guard.side_effect = original
        self.writeback.side_effect = OSError('later wrapper')
        self.assert_original_error(original, self.notify)
        self.mark.assert_not_called()


if __name__ == '__main__':
    unittest.main()
