"""包日志真实关系索引/计数/回滚；仅独立测试站。"""
import copy
import uuid
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core import unified_log


class TestLogTargets(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        from shangshu_core.identity import get_identity
        self.identity = get_identity().name
        self.key = 'target-test-' + uuid.uuid4().hex
        self.object_id = self.key
        self.package = {'version': 1, 'steps': [{
            'action_id': 'platform.object.update_many', 'action_version': '1.0.0',
            'idempotency_key': self.key + '-step', 'source': 'user',
            'record_changes': [self.change('R1', 1, 2), self.change('R2', 3, 4), self.change('R1', 2, 5)]}],
            'record_count': 2, 'change_count': 3}

    def change(self, name, before, after):
        return {'doctype': 'Managed Test', 'name': name, 'data': {'version': 1,
            'object_id': self.object_id, 'object_title': 'Test', 'revision': 1,
            'changes': [{'field': 'amount', 'type': 'number', 'label': 'Amount', 'before': before, 'after': after}]}}

    def entry(self):
        return dict(kind='action', what_id='files.sheet_cells_write', actor_user='Administrator',
            actor_identity=self.identity, result='Succeeded', idempotency_key=self.key,
            detail={'package': self.package, 'legacy': {'action_id': 'files.sheet_cells_write',
                'result_summary_json': '{"private_other_target":"must not return"}'}})

    def test_one_fact_distinct_targets_authorized_count_and_safe_business_summary(self):
        from shangshu_core.receipts import query_business_audits
        doc = unified_log.write_log(**self.entry())
        self.assertEqual(frappe.db.count(unified_log.LOG_DOCTYPE, {'idempotency_key': self.key}), 1)
        self.assertEqual(frappe.db.count('Shangshu Log Target', {'log_no': doc.log_no}), 2)
        filters = {'business_object_id': self.object_id, 'actor_identity': ['in', [self.identity]]}
        self.assertEqual(unified_log.merged_legacy_count(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters), 1)
        for record in ('R1', 'R2'):
            rows = unified_log.merged_legacy_rows(unified_log.LEGACY_AUDIT_DOCTYPE, 'action',
                {**filters, 'business_name': record}, limit_page_length=1)
            self.assertEqual([row.name for row in rows], [doc.name])
        self.assertEqual(unified_log.merged_legacy_count(unified_log.LEGACY_AUDIT_DOCTYPE, 'action',
            {**filters, 'actor_identity': ['in', []]}), 0)
        result = query_business_audits(self.object_id, 'R1')
        row = next(row for row in result['items'] if row['audit'] == doc.name)
        self.assertEqual(row['result_summary'], {'record_count': 1, 'change_count': 2, 'scope': 'requested_target'})
        self.assertNotIn('package', row)
        self.assertEqual(row['business_name'], 'R1')

    def test_retry_reuses_one_fact_and_targets_but_changed_package_is_rejected(self):
        first = unified_log.write_log(**self.entry())
        again = unified_log.write_log(**self.entry())
        self.assertEqual(first.name, again.name)
        self.assertEqual(frappe.db.count('Shangshu Log Target', {'log_no': first.name}), 2)
        self.package['steps'][0]['record_changes'][0]['data']['changes'][0]['after'] = 999
        with self.assertRaises(frappe.ValidationError):
            unified_log.write_log(**self.entry())

    def test_target_failure_rolls_back_new_main_fact(self):
        original = frappe.db.bulk_insert
        def insert(doctype, *args, **kwargs):
            if doctype == 'Shangshu Log Target':
                raise RuntimeError('target insert failed')
            return original(doctype, *args, **kwargs)
        with patch.object(frappe.db, 'bulk_insert', side_effect=insert):
            with self.assertRaisesRegex(RuntimeError, 'target insert failed'):
                unified_log.write_log(**self.entry())
        self.assertFalse(frappe.db.exists(unified_log.LOG_DOCTYPE, {'idempotency_key': self.key}))

    def test_singleton_scalar_history_remains_visible_without_target_rows(self):
        entry = self.entry()
        entry.update(what_id='platform.object.update', reference_doctype='Managed Test', reference_name='R1',
                     business_object_id=self.object_id, business_name='R1', detail={'record_changes': self.change('R1', 1, 2)['data']})
        doc = unified_log.write_log(**entry)
        self.assertEqual(frappe.db.count('Shangshu Log Target', {'log_no': doc.name}), 0)
        filters = {'reference_doctype': 'Managed Test', 'reference_name': 'R1'}
        rows = unified_log.merged_legacy_rows(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters,
                                             record_action_ids=['platform.object.update'])
        self.assertIn(doc.name, [row.name for row in rows])
