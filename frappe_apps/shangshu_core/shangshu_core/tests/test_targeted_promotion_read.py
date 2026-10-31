"""目标行正式值读取的 Frappe 集成回归；只在隔离自动测试站运行。

与离线测试不同，本模块创建真实受管对象并调用现有记录授权/写入入口。
不代表客户真表性能采样，也不应在试用站执行。
"""
import uuid
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records, promotion_records
from shangshu_core.tests import test_promotion_records as fixtures

rows_for = fixtures.rows_for


class TestTargetedPromotionRead(FrappeTestCase):
    _provision = fixtures.TestPromotionRecords._provision
    _cleanup = fixtures.TestPromotionRecords._cleanup

    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'target-read-' + uuid.uuid4().hex
        self.table = 'target-read-' + uuid.uuid4().hex[:10]
        self.created = []

    def tearDown(self):
        frappe.set_user('Administrator')
        self._cleanup()
        super().tearDown()

    def test_targets_equal_authorized_full_read_without_whole_object_query(self):
        bound = self._provision(rows=rows_for(6))
        args = {'object_id': bound['object_id'], 'records': bound['records']}
        full = promotion_records.read_promoted_values(**args,
            read_scope={'mode': 'all', 'purpose': 'analysis'})
        targets = ['r-000002', 'r-000006']
        # ⚠️ **断言口径 2026-10-28 更新**（PKG-132 · R14）：
        #   目标行读取在 2026-10-27 已经从「逐行 `get_record`」改成
        #   「**一次 `get_records` 批量取回**」（一次 `name IN (...)`）。
        #   ⇒ 这条判据要断的**本意**没变：**不许读全对象**（`query_records` 仍然当场抛），
        #     且**只读那两行**（批量口一次、且取回的正是这两个受管记录）。
        with mock.patch.object(model_records, 'query_records', side_effect=AssertionError('不能查询全对象')), \
                mock.patch.object(model_records, 'get_records', wraps=model_records.get_records) as reads:
            selected = promotion_records.read_promoted_values(**args, row_ids=targets)
        self.assertEqual(reads.call_count, 1,
                         '目标行读取要**一次**批量取回（不是逐行取、也不是读全对象）')
        self.assertEqual(sorted(reads.call_args[0][1]),
                         sorted(bound['records'][rid] for rid in targets),
                         '批量取回的行必须正好是目标行')
        for key in ('values', 'versions'):
            self.assertEqual(selected[key], {rid: full[key][rid] for rid in targets})

    def test_field_projection_reaches_sql_and_query_page(self):
        bound = self._provision(rows=rows_for(3))
        name = bound['records']['r-000001']
        with mock.patch.object(model_records, '_bulk_rows', wraps=model_records._bulk_rows) as bulk:
            selected = model_records.get_records(bound['object_id'], [name], fields=['amount'])
        self.assertEqual(set(selected[name]), {'name', 'modified', 'creation', 'amount'})
        model, compiled, _roles = model_records._load(bound['object_id'])
        columns = {f['id']: c['fieldname'] for f, c in zip(compiled['fields'], compiled['doctype']['fields'])}
        self.assertIn(columns['amount'], bulk.call_args.args[2])
        for field, physical in columns.items():
            if field != 'amount':
                self.assertNotIn(physical, bulk.call_args.args[2])
        with mock.patch.object(model_records, 'definition', side_effect=AssertionError('分页不能重装定义')):
            page = model_records.query_records(bound['object_id'], page=1, page_length=1,
                                               fields=['amount', 'name', 'modified'], include_definition=False)
        self.assertIsNone(page['object'])
        self.assertEqual(page['total'], 3)
        self.assertEqual(len(page['rows']), 1)
        self.assertEqual(set(page['rows'][0]), {'name', 'modified', 'creation', 'amount'})

    def test_explicit_all_skips_recycled_bound_record_but_exact_rows_reject_it(self):
        from shangshu_core.actions import execute_registered_action
        bound = self._provision(rows=rows_for(3))
        row_id = 'r-000002'
        name = bound['records'][row_id]
        current = model_records.get_records(bound['object_id'], [name], fields=[])[name]
        execute_registered_action('platform.object.recycle', {
            'object_id': bound['object_id'], 'name': name,
            'expected_revision': bound['revision'], 'expected_modified': current['modified']},
            confirmed=True, idempotency_key=self.key + ':recycle', source='user')
        args = {'object_id': bound['object_id'], 'records': bound['records']}
        all_rows = promotion_records.read_promoted_values(**args, fields=['amount'],
            read_scope={'mode': 'all', 'purpose': 'export'})
        self.assertEqual(set(all_rows['values']), {'r-000001', 'r-000003'})
        with self.assertRaises(frappe.ValidationError):
            promotion_records.read_promoted_values(**args, row_ids=[row_id], fields=['amount'])
        with mock.patch.object(model_records, 'definition', side_effect=AssertionError('不应装配定义')):
            trash = model_records.query_records(bound['object_id'], filters={'$scope': 'trash'},
                                               fields=['amount'], include_definition=False)
        self.assertEqual([row['name'] for row in trash['rows']], [name])
        self.assertEqual(trash['rows'][0]['_lifecycle']['state'], 'trash')
        self.assertEqual(trash['total'], 1)

    def test_catalog_paged_summary_keeps_real_metadata_without_schema_expansion(self):
        from shangshu_core import objects
        bound = self._provision(rows=rows_for(1))
        with mock.patch.object(model_records, 'definition', wraps=model_records.definition) as define:
            result = objects.list_object_definitions(search=bound['object_id'], page=1,
                                                     page_length=20, summary=True)
        self.assertEqual(result['total'], 1)
        self.assertEqual([row['id'] for row in result['list']], [bound['object_id']])
        row = result['list'][0]
        self.assertEqual(row['source'], 'managed')
        self.assertIsInstance(row['can_edit'], bool)
        self.assertIsInstance(row['can_download'], bool)
        self.assertIn('attribution', row)
        self.assertNotIn('input_schema', row)
        self.assertNotIn('fields', row)
        self.assertTrue(all(call.args == (bound['object_id'],) for call in define.call_args_list))

    def test_missing_promoted_scope_never_reads_the_whole_object(self):
        bound = self._provision(rows=rows_for(2))
        with mock.patch.object(model_records, 'query_records', side_effect=AssertionError('隐式全表查询')), \
                self.assertRaises(frappe.ValidationError):
            promotion_records.read_promoted_values(object_id=bound['object_id'], records=bound['records'])

    def test_read_after_write_is_current_and_stale_write_is_still_rejected(self):
        bound = self._provision(rows=rows_for(3))
        args = {'object_id': bound['object_id'], 'records': bound['records']}
        before = promotion_records.read_promoted_values(**args, row_ids=['r-000001'])
        promotion_records.write_promoted_values(**args, values_by_row={'r-000001': {'amount': 91.5}},
            idempotency_key=self.key + ':write', expected_modified_by_row=before['versions'])
        after = promotion_records.read_promoted_values(**args, row_ids=['r-000001'])
        self.assertEqual(after['values']['r-000001']['amount'], 91.5)
        self.assertNotEqual(before['versions'], after['versions'])
        with self.assertRaises(frappe.TimestampMismatchError):
            promotion_records.write_promoted_values(**args, values_by_row={'r-000001': {'amount': 92.5}},
                idempotency_key=self.key + ':stale', expected_modified_by_row=before['versions'])
        self.assertEqual(promotion_records.read_promoted_values(**args, row_ids=['r-000001'])['values'], after['values'])

    def test_unknown_row_and_unauthorized_identity_cannot_read(self):
        bound = self._provision(rows=rows_for(2))
        args = {'object_id': bound['object_id'], 'records': bound['records']}
        with self.assertRaises(frappe.ValidationError):
            promotion_records.read_promoted_values(**args, row_ids=['unmapped'])
        frappe.set_user('Guest')
        with self.assertRaises(frappe.PermissionError):
            promotion_records.read_promoted_values(**args, row_ids=['r-000001'])

    def test_new_record_creation_retries_without_rebuilding_object_or_duplicate_record(self):
        bound = self._provision(rows=rows_for(2))
        payload = {'object_id': bound['object_id'],
                   'rows': [{'row_id': 'r-000003', 'values': {'amount': 30.5}}],
                   'idempotency_key': self.key + ':append'}
        first = promotion_records.create_promoted_records(**payload)
        retry = promotion_records.create_promoted_records(**payload)
        self.assertEqual(first, retry)
        state = promotion_records.read_promoted_values(object_id=bound['object_id'],
            records={**bound['records'], **first['records']}, row_ids=['r-000003'])
        self.assertEqual(state['values']['r-000003']['amount'], 30.5)
        self.assertEqual(model_records.query_records(bound['object_id'])['total'], 3)
        self.assertEqual(first['revision'], bound['revision'])

    def test_new_record_creation_does_not_bypass_required_rule(self):
        columns = [{'header': '金额', 'promoted': True, 'field': 'amount',
                    'type': 'number', 'rules': {'required': True, 'min': 0}}]
        bound = self._provision(columns=columns, rows=rows_for(2, fields=('amount',)))
        with self.assertRaises(frappe.ValidationError):
            promotion_records.create_promoted_records(object_id=bound['object_id'],
                rows=[{'row_id': 'r-000003', 'values': {}}], idempotency_key=self.key + ':empty')
        self.assertEqual(model_records.query_records(bound['object_id'])['total'], 2)

