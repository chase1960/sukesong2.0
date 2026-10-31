"""真实事务接入回归；只在独立 Frappe 测试站运行。"""
from unittest.mock import patch
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import execute_registered_action, domain_execution


class TestOfficeTransaction(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')

    def test_failed_nested_action_keeps_outer_write_and_commit_barrier(self):
        outer='office-outer-'+frappe.generate_hash(length=10)
        inner='office-inner-'+frappe.generate_hash(length=10)
        def failing(*args, **kwargs):
            frappe.get_doc({'doctype':'Role','role_name':inner}).insert(ignore_permissions=True)
            raise RuntimeError('internal-database-secret')
        with domain_execution('com.shangshu.finance'):
            frappe.get_doc({'doctype':'Role','role_name':outer}).insert(ignore_permissions=True)
            with patch('shangshu_core.actions._execute_action_handler',side_effect=failing):
                with self.assertRaises(RuntimeError):
                    execute_registered_action('platform.identity.status',
                        {'email':'nobody@example.invalid','enabled':False},confirmed=True,
                        idempotency_key='office-fail-'+frappe.generate_hash(length=10))
            self.assertTrue(frappe.db.exists('Role',outer))
            self.assertFalse(frappe.db.exists('Role',inner))
            with self.assertRaises(frappe.ValidationError):
                frappe.db.commit()
