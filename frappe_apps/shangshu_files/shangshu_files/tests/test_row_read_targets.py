"""隔离站真实受管记录：定行定列读不能全扫对象或打开 XLSX。"""
import base64
from io import BytesIO
import uuid
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import load_workbook
from shangshu_core import model_records
from shangshu_core.public_api import invoke_domain_service
from shangshu_files import promotion, service, sheet
from shangshu_files.tests import promotion_fixture as fixture
from shangshu_files.tests.test_promotion_managed import TestPromotionWriteChain


class TestRowReadTargets(FrappeTestCase):
    _promote = TestPromotionWriteChain._promote
    _cleanup = fixture.cleanup_created_models

    def setUp(self):
        frappe.set_user('Administrator');self.key='row-target-'+uuid.uuid4().hex;self.created=[]
        book=load_workbook(BytesIO(fixture.workbook_bytes()));book.properties.identifier=self.key
        content=BytesIO();book.save(content)
        self.table=service.upload({'file_name':self.key+'.xlsx','content_base64':base64.b64encode(content.getvalue()).decode(),
                                   'attribution':{'level':'personal'}})['file'];frappe.db.commit()
        self._promote(fixture.PROMOTED+fixture.ORDINARY)
        self.meta=promotion._load_meta(frappe.get_doc(promotion.FILE,self.table));self.rid=self.meta['rows'][0]

    def tearDown(self):
        frappe.set_user('Administrator');frappe.db.rollback();self._cleanup();super().tearDown()

    def read(self,**extra):
        return invoke_domain_service('files.row_read',{'table':self.table,'row_id':self.rid,**extra})

    def test_one_managed_column_reads_one_record_without_workbook_or_query(self):
        with mock.patch.object(model_records,'query_records',side_effect=AssertionError('must not list object')), \
                mock.patch.object(sheet,'read_payload',side_effect=AssertionError('must not open workbook')), \
                mock.patch.object(model_records,'get_records',wraps=model_records.get_records) as get:
            result=self.read(headers=['金额'])
        self.assertEqual(list(result['cells']),['金额']);self.assertEqual(result['cells']['金额']['value'],10.5)
        self.assertEqual(result['source']['金额'],'database');self.assertEqual(result['row_status'],'ready')
        self.assertTrue(result['record_version']);self.assertEqual(result['sheet'],'S-1')
        self.assertGreaterEqual(result['content_version'],1);self.assertEqual(get.call_count,1)
        self.assertEqual(get.call_args.args[1],[self.meta['promotion_binding']['records'][self.rid]])
        # row_status 仍校验本行完整就绪依赖；读 amount/day，不读整表或其他行。
        self.assertEqual(get.call_args.kwargs['fields'], ['amount', 'day'])

    def test_mixed_and_omitted_headers_keep_real_values(self):
        with mock.patch.object(model_records,'query_records',side_effect=AssertionError('must not list object')):
            selected=self.read(headers=['金额','名称']);full=self.read()
        self.assertEqual(set(selected['cells']),{'金额','名称'});self.assertEqual(selected['cells']['名称']['value'],'名称1')
        self.assertEqual(full['cells']['日期']['value'],'2026-10-01');self.assertEqual(len(full['cells']),4)

    def test_invalid_header_unknown_row_missing_mapping_and_guest_cannot_read(self):
        for headers in ([],['金额','金额'],['不存在'],['amount']):
            with self.subTest(headers=headers),self.assertRaises(frappe.ValidationError):self.read(headers=headers)
        with self.assertRaises(frappe.DoesNotExistError):self.read(row_id='r-unknown',headers=['金额'])
        doc=frappe.get_doc(promotion.FILE,self.table);meta=promotion._load_meta(doc)
        del meta['promotion_binding']['records'][self.rid];promotion._save_meta(doc,meta)
        with self.assertRaises(frappe.ValidationError):self.read(headers=['金额'])
        frappe.db.rollback();frappe.set_user('Guest')
        with self.assertRaises(frappe.PermissionError):self.read(headers=['金额'])
