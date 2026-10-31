"""开放试用真实链回归；仅在独立自动测试站运行，绝不对客户真表造夹具。"""
import base64
import uuid
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import business_access
from shangshu_core.public_api import execute_registered_action
from shangshu_core.public_api import get_identity
from shangshu_files import domain, promotion, service, sheet
from shangshu_files.tests import promotion_fixture as fixture


class TestOpenBusinessAccess(FrappeTestCase):
    _cleanup = fixture.cleanup_created_models

    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'open-trial-' + uuid.uuid4().hex[:10]
        self.user = self.key + '@example.test'
        self.created = []
        # 无管理角色的账号；不人为给它 Desk User 或 System Manager。
        frappe.get_doc({'doctype': 'User', 'email': self.user, 'first_name': '试用权限夹具',
                        'enabled': 1, 'user_type': 'System User',
                        'send_welcome_email': 0}).insert(ignore_permissions=True)
        get_identity()
        get_identity(self.user)
        self.table = service.upload({'file_name': self.key + '.xlsx',
            'content_base64': base64.b64encode(fixture.workbook_bytes()).decode(),
            'attribution': {'level': 'personal'}})['file']
        frappe.db.commit()
        none = {op: {'scope': 'none'} for op in ('read', 'write', 'download')}
        promotion.define({'table': self.table, 'definition': {
            'access': dict(none, record_scope='own'),
            'columns': [{**column, 'access': none} for column in fixture.PROMOTED] + fixture.ORDINARY}})
        doc = frappe.get_doc(service.DOCTYPE, self.table)
        self.binding = promotion._managed_binding(doc)
        self.created.append((self.binding['object_id'], self.binding['application_id']))
        frappe.db.commit()
        frappe.set_user(self.user)

    def tearDown(self):
        frappe.set_user('Administrator')
        self._cleanup()
        super().tearDown()

    def test_other_owner_table_uses_real_user_rules_and_atomic_write(self):
        roles = set(frappe.get_roles())
        self.assertNotIn('System Manager', roles)
        rows = domain.query('files.library', {'scope': 'sheet', 'q': self.key}, 1, 10)
        self.assertEqual([row['name'] for row in rows['rows']], [self.table])
        doc = frappe.get_doc(service.DOCTYPE, self.table)
        detail = domain.file_detail(doc)
        for key in ('can_edit', 'can_structure', 'can_download'):
            self.assertTrue(detail[key], key)
        versions = domain.versions(None, {'file': self.table}, None)
        self.assertTrue(versions['versions'])
        # 下载确实能过原生 File 检查，不只验证按钮或下载 ref。
        blob = frappe.get_doc('File', doc.current_file)
        self.assertTrue(blob.is_downloadable())
        self.assertTrue(blob.get_content())
        read = sheet.read_payload(None, {'table': self.table, 'page_length': 10})
        self.assertTrue(read['writable'])
        payload = {'table': self.table, 'row_id': read['rows'][0]['row_id'], 'header': '金额',
                   'expected_content_version': read['content_version'],
                   'expected_structure_version': read['structure_version'],
                   'value': {'type': 'number', 'value': 96.5}, 'op_id': self.key + ':write'}
        outcome = execute_registered_action('files.sheet_cell_write', payload, confirmed=True,
                                            idempotency_key=self.key + ':write')
        self.assertTrue(outcome['result']['formal_written'])
        self.assertEqual(frappe.db.get_value('Shangshu Unified Log', outcome['audit'], 'actor_user'), self.user)
        after = sheet.read_payload(None, {'table': self.table, 'page_length': 10})
        self.assertEqual(after['rows'][0]['values']['金额']['value'], 96.5)
        bad = {**payload, 'expected_content_version': after['content_version'],
               'value': {'type': 'number', 'value': -1}, 'op_id': self.key + ':bad'}
        with self.assertRaises(frappe.ValidationError):
            execute_registered_action('files.sheet_cell_write', bad, confirmed=True,
                                      idempotency_key=self.key + ':bad')
        final = sheet.read_payload(None, {'table': self.table, 'page_length': 10})
        self.assertEqual(final['content_version'], after['content_version'])
        self.assertEqual(final['rows'][0]['values']['金额']['value'], 96.5)
        self.assertEqual(frappe.session.user, self.user)
        self.assertEqual(set(frappe.get_roles()), roles)
        # 裸文档写口仍不能替代受管动作。
        with self.assertRaises(frappe.PermissionError):
            doc.check_permission('write')
        frappe.set_user('Guest')
        with self.assertRaises(frappe.PermissionError):
            sheet.read_payload(None, {'table': self.table})
        with self.assertRaises(frappe.PermissionError):
            execute_registered_action('files.sheet_cell_write', payload, confirmed=True,
                                      idempotency_key=self.key + ':guest')

    def test_tenant_and_disabled_policy_do_not_leak(self):
        # 显式只改本夹具账号的企业，模拟另一企业；不会修改任何客户身份。
        identity = get_identity(self.user)
        frappe.db.set_value('Shangshu Identity', identity.name, 'enterprise_id', 'other-test-enterprise')
        frappe.local.shangshu_business_identities = {}
        self.assertEqual(domain.query('files.library', {'q': self.key}, 1, 10)['total'], 0)
        with self.assertRaises(frappe.PermissionError):
            sheet.read_payload(None, {'table': self.table})
        frappe.db.set_value('Shangshu Identity', identity.name, 'enterprise_id', 'default')
        frappe.local.shangshu_business_identities = {}
        with patch.object(business_access, 'OPEN_BUSINESS_ACCESS', False):
            self.assertFalse(service._can_write(frappe.get_doc(service.DOCTYPE, self.table)))
