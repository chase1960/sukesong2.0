"""Isolated-site regression: committed formal value plus failed XLSX projection.

Creates its own 10-row fixture; never run against an acceptance/customer site.
"""
import json
import uuid
from io import BytesIO
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import load_workbook

from shangshu_core.public_api import read_registered_service
from shangshu_files import promotion, service, sheet
from shangshu_files.tests import promotion_fixture as fixture
from shangshu_files.tests import test_promotion_managed as promotion_tests


class TestSheetReadAuthorityLive(FrappeTestCase):
    _upload = promotion_tests.TestPromotionWriteChain._upload
    _promote = promotion_tests.TestPromotionWriteChain._promote
    _cleanup = fixture.cleanup_created_models

    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'read-authority-' + uuid.uuid4().hex
        self.table = None; self.created = []
        self._upload(); self._promote(fixture.PROMOTED + fixture.ORDINARY)

    def tearDown(self):
        frappe.set_user('Administrator')
        frappe.db.rollback(); self._cleanup()
        super().tearDown()

    def test_public_page_uses_formal_values_and_logs_them_while_projection_is_pending(self):
        doc = frappe.get_doc(promotion.FILE, self.table)
        rid = sheet._load_meta(doc)['rows'][0]
        old_content = sheet._content(doc)
        self.assertNotEqual(load_workbook(BytesIO(old_content)).active['A2'].value, 555.5)
        with mock.patch.object(promotion, '_writeback', side_effect=RuntimeError('isolated projection failure')):
            outcome = promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                'op_id': self.key + ':write', 'value': {'type': 'number', 'value': 555.5}})
        self.assertTrue(outcome['formal_written']); self.assertFalse(outcome['sheet_written'])
        self.assertTrue(outcome['pending']); frappe.db.commit()
        doc = frappe.get_doc(promotion.FILE, self.table)
        self.assertEqual(sheet._content(doc), old_content)
        copy_id = self.key + ':copy'
        result = read_registered_service('files.sheet_read', {'table': self.table, 'row_ids': [rid],
                                         'headers': ['金额', '备注'], 'op_id': copy_id})
        row = result['rows'][0]
        self.assertEqual(row['values']['金额']['value'], 555.5)
        self.assertEqual(row['values']['备注']['value'], fixture.row_values(1)[3])
        state = promotion.formal_state_for_rows(doc, [rid], fields=['amount'])
        self.assertEqual(row['record_version'], state['versions'][rid])
        cells = json.loads(frappe.db.get_value(sheet.OP_DOCTYPE,
                           {'file': self.table, 'op_id': copy_id}, 'cells_json'))
        self.assertEqual(next(cell for cell in cells if cell['header'] == '金额')['before'], 555.5)
        ranged = service._range_read({'table': self.table, 'row_ids': [rid], 'headers': ['金额']})
        self.assertEqual(ranged['rows'][0]['values']['金额']['value'], 555.5)
        self.assertEqual(ranged['rows'][0]['record_version'], row['record_version'])
        with self.assertRaisesRegex(frappe.ValidationError, '搜索.*恢复|恢复.*搜索'):
            read_registered_service('files.sheet_read', {'table': self.table, 'search': '10.5'})
