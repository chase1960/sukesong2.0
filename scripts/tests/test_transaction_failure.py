"""事务失效守卫；真实 SQL 并发在 core/tests/test_transaction_failure_concurrency.py。"""
import importlib.util
import sys
import unittest
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/transaction_failure.py'


class DriverError(Exception):
    pass


class InterfaceError(DriverError):
    pass


class QueryDeadlockError(Exception):
    pass


class QueryTimeoutError(Exception):
    pass


class Hooks:
    def __init__(self): self.callbacks = deque()
    def add(self, fn): self.callbacks.append(fn)
    def reset(self): self.callbacks.clear()
    def run(self):
        while self.callbacks: self.callbacks.popleft()()


class Database:
    def __init__(self):
        for key in ('before_commit', 'after_commit', 'before_rollback', 'after_rollback'):
            setattr(self, key, Hooks())
        self.commits = 0
        self.rollbacks = []
        self.rollback_error = None

    def commit(self):
        # Actual Frappe 15 resets these BEFORE before_commit callbacks.
        self.before_rollback.reset(); self.after_rollback.reset()
        self.before_commit.run()
        self.commits += 1
        self.after_commit.run()

    def rollback(self, *, save_point=None):
        self.rollbacks.append(save_point)
        if self.rollback_error: raise self.rollback_error
        if save_point: return
        self.before_commit.reset(); self.after_commit.reset()
        self.before_rollback.run(); self.after_rollback.run()


class TransactionFailureTests(unittest.TestCase):
    def setUp(self):
        self.db = Database()
        self.frappe = SimpleNamespace(db=self.db, QueryDeadlockError=QueryDeadlockError,
                                     QueryTimeoutError=QueryTimeoutError)
        modules = {'frappe': self.frappe,
                   'pymysql': SimpleNamespace(err=SimpleNamespace(Error=DriverError, InterfaceError=InterfaceError)),
                   'pymysql.err': SimpleNamespace(Error=DriverError, InterfaceError=InterfaceError)}
        scope = patch.dict(sys.modules, modules); scope.start(); self.addCleanup(scope.stop)
        spec = importlib.util.spec_from_file_location('tested_transaction_failure', SOURCE)
        self.guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.guard)

    def test_only_real_types_and_numeric_codes_not_error_text(self):
        for error in (ValueError(1213, 'deadlock'), RuntimeError('QueryDeadlockError'),
                      ConnectionError('lost connection'), DriverError(1062, 'duplicate'), OSError(1205, 'file')):
            self.guard.raise_if_transaction_failed(error)
        self.db.commit(); self.assertEqual(self.db.commits, 1)

    def test_driver_codes_interface_and_frappe_types_fail_closed(self):
        for error in [DriverError(code, 'db') for code in (1213, 1205, 1020, 2006, 2013)] + [
                InterfaceError(0, ''), QueryDeadlockError(), QueryTimeoutError()]:
            with self.subTest(error=type(error).__name__, args=error.args):
                with self.assertRaises(type(error)) as caught: self.guard.raise_if_transaction_failed(error)
                self.assertIs(caught.exception, error)
                with self.assertRaises(type(error)): self.db.commit()
                self.db.rollback()

    def test_cause_context_cycles_and_original_error_retained(self):
        original = RuntimeError('wrapper'); cause = DriverError(1205, 'timeout')
        original.__cause__ = cause; cause.__context__ = original
        with self.assertRaises(RuntimeError) as caught: self.guard.raise_if_transaction_failed(original)
        self.assertIs(caught.exception, original)
        with self.assertRaises(RuntimeError) as later: self.guard.raise_if_transaction_failed(KeyError('receipt missing'))
        self.assertIs(later.exception, original)

    def test_rejected_commits_preserve_file_recovery_callbacks(self):
        restored = []; self.db.after_rollback.add(lambda: restored.append('file restored'))
        error = DriverError(1213, 'deadlock')
        with self.assertRaises(DriverError): self.guard.raise_if_transaction_failed(error)
        for _ in range(2):
            with self.assertRaises(DriverError): self.db.commit()
        self.assertEqual(restored, [])
        self.db.rollback()
        self.assertEqual(restored, ['file restored'])
        self.guard.assert_transaction_healthy(); self.db.commit()
        self.assertEqual(self.db.commits, 1)
        self.assertNotIn('commit', self.db.__dict__)
        self.assertNotIn('rollback', self.db.__dict__)

    def test_savepoint_and_failed_full_rollback_do_not_clear_poison(self):
        with self.assertRaises(QueryTimeoutError): self.guard.raise_if_transaction_failed(QueryTimeoutError())
        self.db.rollback(save_point='action')
        with self.assertRaises(QueryTimeoutError): self.guard.assert_transaction_healthy()
        self.db.rollback_error = InterfaceError(0, '')
        with self.assertRaises(InterfaceError): self.db.rollback()
        with self.assertRaises(QueryTimeoutError): self.db.commit()
        self.db.rollback_error = None; self.db.rollback()
        with self.assertRaises(QueryTimeoutError): self.guard.assert_transaction_healthy()

    def test_invalid_savepoint_requires_rollback_context(self):
        error = DriverError(1305, 'missing object')
        self.guard.raise_if_transaction_failed(error)
        wrapper = RuntimeError('rollback failed'); wrapper.__cause__ = error
        self.assertIs(self.guard.mark_transaction_failed(wrapper, rollback=True), wrapper)
        with self.assertRaises(RuntimeError): self.db.commit()

    def test_instances_do_not_share_poison_and_callback_failure_stays_poisoned(self):
        error = QueryDeadlockError()
        with self.assertRaises(QueryDeadlockError): self.guard.raise_if_transaction_failed(error)
        other = Database(); self.frappe.db = other
        self.guard.assert_transaction_healthy(); other.commit()
        self.frappe.db = self.db
        self.db.after_rollback.add(lambda: (_ for _ in ()).throw(OSError('restore failed')))
        with self.assertRaises(OSError): self.db.rollback()
        self.db.rollback()
        with self.assertRaises(QueryDeadlockError): self.db.commit()

    def test_ordinary_file_failure_keeps_outer_transaction_usable(self):
        self.guard.raise_if_transaction_failed(OSError('ordinary file failure'))
        self.db.rollback(save_point='package-B')
        self.db.commit(); self.assertEqual(self.db.commits, 1)

    def test_proxy_switch_does_not_redirect_installed_guards(self):
        current = [self.db]
        class Proxy:
            def _get_current_object(self): return current[0]
            def __getattr__(self, key): return getattr(current[0], key)
        self.frappe.db = Proxy()
        restored = []; self.db.after_rollback.add(lambda: restored.append('A'))
        with self.assertRaises(QueryDeadlockError): self.guard.raise_if_transaction_failed(QueryDeadlockError())
        other = Database(); current[0] = other
        self.guard.assert_transaction_healthy(); other.commit()
        self.db.rollback()
        self.assertEqual(restored, ['A'])
        self.assertEqual(other.commits, 1)
        self.assertNotIn('commit', other.__dict__)
        current[0] = self.db; self.guard.assert_transaction_healthy()

    def test_actual_managed_notification_stops_on_db_failure_but_reports_io(self):
        source = SOURCE.with_name('managed_changes.py')
        spec = importlib.util.spec_from_file_location('tested_managed_changes', source)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'shangshu_core.transaction_failure': self.guard}):
            spec.loader.exec_module(module)
        calls = []
        self.frappe.get_hooks = lambda key: ['first', 'second']
        def handler(path):
            def run(payload):
                calls.append(path)
                if path == 'first': raise QueryTimeoutError()
            return run
        self.frappe.get_attr = handler
        with self.assertRaises(QueryTimeoutError): module._notify(object_id='O', records={'R':{'v':1}}, source='user')
        self.assertEqual(calls, ['first'])
        self.db.rollback(); calls.clear()
        self.frappe.get_attr = lambda path: lambda payload: (_ for _ in ()).throw(OSError('disk'))
        result = module._notify(object_id='O', records={'R':{'v':1}}, source='user')
        self.assertEqual(result['handlers'], 2)
        self.assertEqual([r['error'] for r in result['results']], ['disk','disk'])
        self.db.commit()

    def test_handler_registry_and_resolver_failures_are_not_converted_to_empty_results(self):
        spec = importlib.util.spec_from_file_location('tested_managed_changes', SOURCE.with_name('managed_changes.py'))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'shangshu_core.transaction_failure': self.guard}): spec.loader.exec_module(module)
        self.frappe.get_hooks = lambda key: (_ for _ in ()).throw(QueryDeadlockError())
        with self.assertRaises(QueryDeadlockError): module._handlers()
        self.db.rollback()
        self.frappe.get_hooks = lambda key: ['first']
        self.frappe.get_attr = lambda path: (_ for _ in ()).throw(QueryTimeoutError())
        with self.assertRaises(QueryTimeoutError): module._notify(object_id='O', records={'R':{}}, source='user')


if __name__ == '__main__': unittest.main()
