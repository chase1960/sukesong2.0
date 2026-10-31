"""无需站点的执行边界单测；真实事务并发另由站点回归验证。"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock


class DomainExecutionTest(unittest.TestCase):
    def setUp(self):
        self.frappe = types.ModuleType('frappe')
        self.frappe.flags = types.SimpleNamespace(shangshu_call_domain=None, shangshu_domain_execution_depth=None)
        self.frappe.PermissionError = PermissionError
        self.frappe.ValidationError = ValueError
        self.frappe.DoesNotExistError = LookupError
        self.frappe.throw = lambda message, error: self._raise(error(message))
        self.frappe.db = Mock()
        self.frappe.db.sql.return_value = [dict(enabled=1, execution_stopped=0, health_status='healthy')]
        self.previous = {key: sys.modules.get(key) for key in ('frappe', 'shangshu_core.lifecycle')}
        sys.modules['frappe'] = self.frappe
        lifecycle = types.ModuleType('shangshu_core.lifecycle')
        lifecycle.assert_declared_call = Mock()
        sys.modules['shangshu_core.lifecycle'] = lifecycle
        path = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/domain_execution.py'
        spec = importlib.util.spec_from_file_location('domain_execution_under_test', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    @staticmethod
    def _raise(error):
        raise error

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def test_context_restores_owner_and_does_not_commit(self):
        with self.module.domain_execution('domain.a'):
            self.assertEqual(self.frappe.flags.shangshu_call_domain, 'domain.a')
            with self.assertRaises(RuntimeError):
                with self.module.domain_execution('domain.b'):
                    raise RuntimeError('handler failed')
            self.assertEqual(self.frappe.flags.shangshu_call_domain, 'domain.a')
        self.assertIsNone(self.frappe.flags.shangshu_call_domain)
        self.frappe.db.commit.assert_not_called()
        self.assertIn('LOCK IN SHARE MODE', self.frappe.db.sql.call_args.args[0])

    def test_complete_stop_cannot_be_bypassed_by_continuation(self):
        self.frappe.db.sql.return_value[0].update(enabled=0, execution_stopped=1)
        for allow_disabled in (False, True):
            with self.assertRaises(PermissionError):
                with self.module.domain_execution('domain.a', allow_disabled=allow_disabled):
                    self.fail('stopped handler ran')

    def test_legacy_drain_and_missing_domain(self):
        self.frappe.db.sql.return_value[0]['enabled'] = 0
        with self.assertRaises(PermissionError):
            with self.module.domain_execution('domain.a'):
                self.fail('disabled handler ran')
        with self.module.domain_execution('domain.a', allow_disabled=True):
            pass
        self.frappe.db.sql.return_value = []
        with self.assertRaises(LookupError):
            with self.module.domain_execution('missing'):
                self.fail('unknown handler ran')

    def test_core_has_no_shared_control_row_lock(self):
        with self.module.domain_execution('com.shangshu.core'):
            pass
        self.frappe.db.sql.assert_not_called()


if __name__ == '__main__':
    unittest.main()
