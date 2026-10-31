"""Public file packages: real XLSX, managed rows, requests, logs and checkpoints.

Run only after core/files migrate on an isolated test site. Fixture DDL is fully
committed before executing a package; no inheritance of unrelated test cases.
"""
import copy
import json
import uuid
from io import BytesIO
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import load_workbook

from shangshu_core.public_api import execute_registered_action, get_action_request_status
from shangshu_files import promotion, sheet
from shangshu_files.domain import PACKAGE_ACTION_VERSIONS
from shangshu_files.tests import promotion_fixture as fixture
from shangshu_files.tests import test_incremental_write_path as incremental


class TestActionPackageLog(FrappeTestCase):
    _upload = incremental.TestIncrementalWritePath._upload
    _promote = incremental.TestIncrementalWritePath._promote
    _cleanup = fixture.cleanup_created_models
    doc = incremental.TestIncrementalWritePath.doc
    pin = incremental.TestIncrementalWritePath.pin
    formal = incremental.TestIncrementalWritePath.formal

    def setUp(self):
        super().setUp()
        frappe.set_user('Administrator')
        self.key = 'pkglog-' + uuid.uuid4().hex
        self.table, self.created = None, []
        self._upload()
        self._promote(fixture.PROMOTED + fixture.ORDINARY)
        # Provisioning is an independent migration. Packages below own ordinary
        # transactions only and must never absorb its DDL/implicit commit.
        frappe.db.commit()
        self.row_id = sheet._load_meta(self.doc())['rows'][0]
        self.binding = promotion._managed_binding(self.doc())
        self.record_name = self.binding['records'][self.row_id]

    def tearDown(self):
        frappe.set_user('Administrator')
        frappe.db.rollback()
        self._cleanup()
        super().tearDown()

    def _payload(self, suffix, amount=81.5, note='包内普通值'):
        return self.pin(op_id=self.key + ':' + suffix, cells=[
            {'row_id': self.row_id, 'header': '金额', 'value': {'type': 'number', 'value': amount}},
            {'row_id': self.row_id, 'header': '名称', 'value': {'type': 'text', 'value': note}},
        ])

    def _execute(self, action_id, payload, key):
        return execute_registered_action(action_id, payload, confirmed=True,
            idempotency_key=key, source='user', action_version=PACKAGE_ACTION_VERSIONS[action_id])

    def _write(self, payload):
        return self._execute('files.sheet_cells_write', payload, payload['op_id'])

    def _logs(self):
        # Both former child batch/row keys and root keys contain this isolated
        # operation token. A child log cannot escape this exact fixture scope.
        return frappe.get_all('Shangshu Unified Log',
            filters={'what_kind': 'action', 'idempotency_key': ['like', '%' + self.key + '%']},
            fields=['name', 'what_id', 'idempotency_key', 'detail_json'],
            order_by='name asc', limit_page_length=0)

    def _ops(self):
        return frappe.get_all(sheet.OP_DOCTYPE, filters={'file': self.table},
            fields=['name', 'op_id', 'undone', 'request_key', 'cells_json', 'content_version'],
            order_by='name asc', limit_page_length=0)

    def _targets(self):
        return frappe.get_all('Shangshu Log Target', filters={
            'reference_name': ['in', [self.table, *self.binding['records'].values()]]},
            fields=['name', 'log_no', 'reference_doctype', 'reference_name',
                    'business_object_id', 'business_name'], order_by='name asc', limit_page_length=0)

    def _snapshot(self):
        doc = self.doc()
        return {
            'file': {field: copy.deepcopy(doc.get(field)) for field in (
                'current_file', 'current_sha256', 'current_size', 'content_revision',
                'sheet_meta_json', 'modified')},
            'bytes': sheet._content(doc),
            'formal': promotion.formal_state(doc, row_ids=[self.row_id],
                                             fields=promotion.declared_fields(doc)),
            'ops': self._ops(), 'logs': self._logs(), 'targets': self._targets(),
        }

    def test_mixed_two_cells_are_one_log_with_complete_child_and_root_evidence(self):
        payload = self._payload('mixed')
        receipt = self._write(payload)
        frappe.db.commit()
        logs = self._logs()
        self.assertEqual(len(logs), 1)
        self.assertEqual(receipt['audit'], logs[0].name)
        self.assertEqual(logs[0].what_id, 'files.sheet_cells_write')
        detail = json.loads(logs[0].detail_json)
        self.assertIsNone(detail['record_changes'])
        self.assertIsNone(detail['legacy']['record_changes_json'])
        steps = detail['package']['steps']
        child = next(step for step in steps if step['action_id'] == 'platform.object.update_many')
        managed = next(row for row in child['record_changes'] if row['name'] == self.record_name)
        amount = next(change for change in managed['data']['changes'] if change['field'] == 'amount')
        self.assertEqual((amount['before'], amount['after']), (10.5, 81.5))
        root = next(step for step in steps if step['action_id'] == 'files.sheet_cells_write')
        file_change = next(row for row in root['record_changes'] if row['name'] == self.table)
        ordinary = next(change for change in file_change['data']['changes'] if change['field'] == '名称')
        self.assertEqual(ordinary['row_id'], self.row_id)
        self.assertEqual(ordinary['before'], {'type': 'text', 'value': '名称1'})
        self.assertEqual(ordinary['after'], {'type': 'text', 'value': '包内普通值'})
        self.assertNotIn('input_summary', root)
        self.assertEqual(detail['package']['record_count'], 2)
        self.assertEqual({row.log_no for row in self._targets()}, {receipt['audit']})
        self.assertEqual(get_action_request_status(child['idempotency_key'])['audit'], receipt['audit'])
        self.assertEqual(self.formal(self.row_id)['amount'], 81.5)

    def test_same_key_replay_adds_neither_log_nor_undo_ledger(self):
        payload = self._payload('replay')
        first = self._write(payload)
        frappe.db.commit()
        before = self._snapshot()
        replay = self._write(payload)
        frappe.db.commit()
        self.assertTrue(replay['idempotent'])
        self.assertEqual(replay['audit'], first['audit'])
        self.assertEqual(replay['result'], first['result'])
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(len(self._logs()), 1)
        self.assertEqual(len(self._ops()), 1)

    def test_undo_is_one_new_action_log_and_restores_both_value_kinds(self):
        payload = self._payload('undo-write')
        self._write(payload)
        frappe.db.commit()
        undone = self._execute('files.sheet_cells_undo',
            {'table': self.table, 'op_id': payload['op_id']}, self.key + ':undo-request')
        frappe.db.commit()
        self.assertEqual(undone['result']['applied'], 2)
        self.assertEqual(self.formal(self.row_id)['amount'], 10.5)
        workbook = load_workbook(BytesIO(sheet._content(self.doc())), data_only=False)
        self.assertEqual(workbook.active['C2'].value, '名称1')
        logs = self._logs()
        self.assertEqual(len(logs), 2)
        undo_log = next(row for row in logs if row.name == undone['audit'])
        self.assertEqual(undo_log.what_id, 'files.sheet_cells_undo')
        steps = json.loads(undo_log.detail_json)['package']['steps']
        self.assertEqual({step['action_id'] for step in steps},
                         {'files.sheet_cells_undo', 'platform.object.update_many'})
        self.assertEqual(len(self._ops()), 2)
        original = next(row for row in self._ops() if row.op_id == payload['op_id'])
        self.assertEqual(original.undone, 1)

    def _fail_after_save(self, payload):
        def fault(point):
            if point == 'post-save':
                raise RuntimeError('package post-save fault')
        # This is an actual parent Python caller that catches the public Action
        # error and commits its own transaction, not an outer full rollback.
        with mock.patch.object(sheet, '_fault', side_effect=fault):
            with self.assertRaisesRegex(RuntimeError, 'package post-save fault'):
                self._write(payload)

    def test_caught_post_save_failure_then_commit_restores_db_bytes_logs_and_targets(self):
        before = self._snapshot()
        payload = self._payload('failed')
        self._fail_after_save(payload)
        frappe.db.commit()
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(get_action_request_status(payload['op_id'])['status'], 'Failed')

    def test_success_a_then_failed_b_in_one_outer_transaction_keeps_a_checkpoint(self):
        payload_a = self._payload('A', amount=72.5, note='保留A')
        receipt_a = self._write(payload_a)
        after_a = self._snapshot()
        # No commit between A and B: B must restore its own checkpoint, while
        # the existing full-transaction journal continues to protect A.
        payload_b = self._payload('B', amount=93.5, note='回滚B')
        self._fail_after_save(payload_b)
        frappe.db.commit()
        self.assertEqual(self._snapshot(), after_a)
        self.assertEqual(self.formal(self.row_id)['amount'], 72.5)
        workbook = load_workbook(BytesIO(sheet._content(self.doc())), data_only=False)
        self.assertEqual(workbook.active['C2'].value, '保留A')
        self.assertEqual([row.name for row in self._logs()], [receipt_a['audit']])
        self.assertEqual(len(self._ops()), 1)
        self.assertEqual(get_action_request_status(payload_b['op_id'])['status'], 'Failed')
