"""真实注册动作：目标结构逆操作不覆盖后来改值、不删除正式记录。"""
import base64,uuid
from io import BytesIO
from contextlib import ExitStack
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import load_workbook
from shangshu_files import sheet,service,promotion,sheet_structure
from shangshu_files.tests import promotion_fixture as fixture
from shangshu_files.tests.test_incremental_write_path import TestIncrementalWritePath


class TestIncrementalStructure(FrappeTestCase):
    _promote=TestIncrementalWritePath._promote
    _cleanup=TestIncrementalWritePath._cleanup
    setUp=TestIncrementalWritePath.setUp
    doc=TestIncrementalWritePath.doc
    pin=TestIncrementalWritePath.pin
    formal=TestIncrementalWritePath.formal

    def tearDown(self):
        frappe.set_user('Administrator');frappe.db.rollback();self._cleanup()
        super().tearDown()

    def _upload(self):
        book=load_workbook(BytesIO(fixture.workbook_bytes()));book.properties.identifier=uuid.uuid4().hex
        out=BytesIO();book.save(out)
        self.table=service.upload({'file_name':self.key+'.xlsx','content_base64':base64.b64encode(out.getvalue()).decode(),
                                   'attribution':{'level':'personal'}})['file']
        frappe.db.commit()

    def guard(self):
        stack=ExitStack()
        for name in ('safe_open','_save_with_gates'):
            stack.enter_context(mock.patch.object(sheet,name,side_effect=AssertionError('whole workbook path')))
        stack.enter_context(mock.patch.object(sheet_structure,'workbook_fingerprint',side_effect=AssertionError('global fingerprint')))
        return stack

    def execute(self,name,**payload):
        from shangshu_core.public_api import execute_registered_action
        from shangshu_core.public_api import domain_execution
        body=self.pin(**payload)
        with domain_execution('com.shangshu.files'):
            result=execute_registered_action(name,body,confirmed=True,idempotency_key=body['op_id'],source='user')
        frappe.db.commit()
        return result.get('result',result)

    def test_append_fill_value_undo_structure_undo_keeps_mapping_and_other_edits(self):
        original=sheet._load_meta(self.doc());oldrid=original['rows'][0]
        with self.guard():
            added=self.execute('files.sheet_row_append',count=1);rid=added['row_ids'][0]
            written=sheet.write_cells(self.pin(cells=[{'row_id':rid,'header':'金额','value':{'type':'number','value':42.5}},
                                                     {'row_id':rid,'header':'名称','value':{'type':'text','value':'temporary'}}]))
            frappe.db.commit();record=sheet._load_meta(self.doc())['promotion_binding']['records'][rid]
            sheet.undo_cells({'table':self.table,'op_id':written['op_id']});frappe.db.commit()
            sheet.write_cell(self.pin(row_id=oldrid,header='备注',value={'type':'text','value':'later-other-row'}));frappe.db.commit()
            undone=self.execute('files.sheet_structure_undo',undo_of=added['structure_undo_op_id'])
            self.assertTrue(undone['soft'])
            meta=sheet._load_meta(self.doc());self.assertIn(rid,meta['deleted_rows']);self.assertIn(rid,meta['rows'])
            self.assertEqual(meta['promotion_binding']['records'][rid],record)
            self.assertIsNone(self.formal(rid).get('amount'))
            ws=load_workbook(BytesIO(sheet._content(self.doc()))).active
            self.assertTrue(ws.row_dimensions[meta['rows'].index(rid)+2].hidden)
            self.assertEqual(ws['D2'].value,'later-other-row')
            self.execute('files.sheet_row_restore',row_id=rid)
            self.assertNotIn(rid,sheet._load_meta(self.doc())['deleted_rows'])
            self.assertEqual(sheet._load_meta(self.doc())['promotion_binding']['records'][rid],record)

    def test_soft_delete_leaves_one_blank_row_at_the_end(self):
        """**软删之后，末尾有一行空的**：人随时能接着填。

        **为什么要有这一条**（2026-10-29 用户口径）：软删只把行藏起来（身份、正式值都留着），
        可**末尾那一行被藏掉之后，整张表看上去就空了** —— 人连「往哪儿填」都没有。

        **测试通过 = 什么成立**：
        · 软删掉**最后一行**之后，末尾多了一行**空的、没被删的**行；
        · 那一行有**新的固定行身份**（不复用被删的那一行）、登记进 meta 的行表；
        · 那一行**不是受管记录**（没值就不建 —— 值是空的事实）；
        · 结构版本**只推进一次**；再读一次，行数和版本都**不再变**
          （补行是**一次动作**，不是每次读都补）。
        """
        meta = sheet._load_meta(self.doc())
        last = meta['rows'][-1]
        version_before = int(meta['structure_version'])
        with self.guard():
            self.execute('files.sheet_row_delete', row_id=last)
        after = sheet._load_meta(self.doc())
        self.assertEqual(len(after['rows']), len(meta['rows']) + 1, '末尾应当多出一行')
        fresh = after['rows'][-1]
        self.assertNotEqual(fresh, last, '补出来的行不能复用被删那一行的身份')
        self.assertNotIn(fresh, after.get('deleted_rows') or [], '补出来的空行是活的')
        self.assertIn(last, after.get('deleted_rows') or [], '被删的那一行仍然是软删（身份保留）')
        self.assertEqual(int(after['structure_version']), version_before + 1,
                         '结构版本只推进一次')
        self.assertNotIn(fresh, (after.get('promotion_binding') or {}).get('records') or {},
                         '补出来的空行没有值 ⇒ 不建受管记录')
        page = sheet.read_payload('files.sheet_read', {'table': self.table}, None)
        rows = {r['row_id']: r for r in page['rows']}
        self.assertIn(fresh, rows, '补出来的空行要出现在读回来的行里（人能往里填）')
        self.assertEqual(page['total_rows'], len(meta['rows']),
                         '删掉一行、补上一行空的 ⇒ 看到的行数不变')
        self.assertTrue(all((value.get('value') in (None, ''))
                            for value in rows[fresh]['values'].values()),
                        '补出来的那一行是空的')
        again = sheet.read_payload('files.sheet_read', {'table': self.table}, None)
        self.assertEqual(again['total_rows'], page['total_rows'], '再读一次不许重复补行')
        self.assertEqual(int(sheet._load_meta(self.doc())['structure_version']), version_before + 1,
                         '读一次不许推进结构版本')

    def test_delete_restore_and_inverse_only_patch_target_visibility(self):
        meta=sheet._load_meta(self.doc());rid=meta['rows'][0];mapping=dict(meta['promotion_binding']['records'])
        with self.guard():
            removed=self.execute('files.sheet_row_delete',row_id=rid)
            sheet.write_cell(self.pin(row_id=meta['rows'][1],header='备注',value={'type':'text','value':'keep-later'}));frappe.db.commit()
            self.execute('files.sheet_structure_undo',undo_of=removed['structure_undo_op_id'])
            self.assertNotIn(rid,sheet._load_meta(self.doc())['deleted_rows'])
            self.assertEqual(sheet._load_meta(self.doc())['promotion_binding']['records'],mapping)
            self.assertEqual(self.formal(rid)['amount'],10.5)
            self.assertEqual(load_workbook(BytesIO(sheet._content(self.doc()))).active['D3'].value,'keep-later')

    def test_created_row_with_real_zero_rejects_inverse_without_writing(self):
        with self.guard():
            added=self.execute('files.sheet_row_insert',before_row_id=sheet._load_meta(self.doc())['rows'][1],count=1)
            rid=added['row_ids'][0]
            sheet.write_cell(self.pin(row_id=rid,header='金额',value={'type':'number','value':0}));frappe.db.commit()
            before=sheet._content(self.doc());meta=sheet._load_meta(self.doc())
            with self.assertRaisesRegex(Exception,'仍有内容'):
                self.execute('files.sheet_structure_undo',undo_of=added['structure_undo_op_id'])
            frappe.db.rollback()
            self.assertEqual(sheet._content(self.doc()),before);self.assertEqual(sheet._load_meta(self.doc()),meta)
            self.assertEqual(self.formal(rid)['amount'],0)

    def test_inverse_file_fault_rolls_back_metadata_bytes_and_original_op(self):
        with self.guard():
            added=self.execute('files.sheet_row_append',count=1)
            before=sheet._content(self.doc());meta=sheet._load_meta(self.doc())
            def fault(point):
                if point=='post-save':raise RuntimeError('inverse-post-save')
            with mock.patch.object(sheet,'_fault',side_effect=fault),self.assertRaisesRegex(RuntimeError,'inverse-post-save'):
                self.execute('files.sheet_structure_undo',undo_of=added['structure_undo_op_id'])
            frappe.db.rollback()
            self.assertEqual(sheet._content(self.doc()),before);self.assertEqual(sheet._load_meta(self.doc()),meta)
            self.assertFalse(frappe.db.get_value(sheet.OP_DOCTYPE,{'file':self.table,'op_id':added['structure_undo_op_id']},'undone'))

    def test_insert_column_and_inverse_preserve_formal_values_and_personal_view(self):
        from shangshu_files import sheet_view
        before=sheet._load_meta(self.doc());rid=before['rows'][0]
        personal={'filters':[{'column':'备注','operator':'contains','value':'备注'}],
                  'freeze':{'rows':1,'columns':1},'sort':{'column':'金额','direction':'desc'}}
        sheet_view.save_view({'table':self.table,'expected_revision':0,
            'expected_structure_version':before['structure_version'],'view':personal});frappe.db.commit()
        with self.guard():
            added=self.execute('files.sheet_column_insert',header='临时列',before_header='金额')
            after=sheet._load_meta(self.doc())
            self.assertEqual(after['rows'],before['rows']);self.assertEqual(after['promotion_binding'],before['promotion_binding'])
            self.assertEqual(self.formal(rid)['amount'],10.5)
            view=sheet_view.read_view('files.sheet_view',{'table':self.table})
            self.assertNotIn('invalid_reason',view);self.assertEqual(view['view'],personal)
            sheet.write_cell(self.pin(row_id=rid,header='备注',value={'type':'text','value':'备注-later'}));frappe.db.commit()
            self.execute('files.sheet_structure_undo',undo_of=added['structure_undo_op_id'])
            ws=load_workbook(BytesIO(sheet._content(self.doc()))).active
            self.assertEqual(ws['A1'].value,'金额');self.assertEqual(ws['A2'].number_format,'#,##0.00')
            self.assertEqual(ws['D2'].value,'备注-later');self.assertEqual(self.formal(rid)['amount'],10.5)
            view=sheet_view.read_view('files.sheet_view',{'table':self.table})
            self.assertNotIn('invalid_reason',view);self.assertEqual(view['view'],personal)

    def test_new_column_with_later_values_refuses_inverse(self):
        with self.guard():
            added=self.execute('files.sheet_column_append',header='不能丢')
            rid=sheet._load_meta(self.doc())['rows'][0]
            sheet.write_cell(self.pin(row_id=rid,header='不能丢',value={'type':'text','value':'keep'}));frappe.db.commit()
            before=sheet._content(self.doc())
            with self.assertRaisesRegex(Exception,'新增列仍有内容'):
                self.execute('files.sheet_structure_undo',undo_of=added['structure_undo_op_id'])
            frappe.db.rollback();self.assertEqual(sheet._content(self.doc()),before)
