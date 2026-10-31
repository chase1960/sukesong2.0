"""普通文件结构、排序、样式：真实公共Action与真实XLSX，不创建业务字段。"""
import base64
from io import BytesIO
import uuid
import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook, load_workbook
from shangshu_core.public_api import execute_registered_action, invoke_domain_service


class TestOfficeOperations(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.token=uuid.uuid4().hex
        self.user='ops-'+self.token+'@example.invalid'
        self.act('platform.identity.create',{'email':self.user,'display_name':'办公回归',
            'initial_password':'Isolated-office-2026!','roles':['staff']})
        frappe.set_user(self.user)
        wb=Workbook();ws=wb.active;ws.title='报价'
        ws.append(['客户','数量']);ws.append(['乙',20]);ws.append(['甲',10])
        output=BytesIO();wb.save(output)
        # 合并说明（2026-10-21）：**按新契约补上归属** —— 用户 2026-10-15 原话
        # 「尚书是单例，没有企业归属」+「上传必填归属」⇒ `files.upload` 不传归属直接拒
        # （NO_ATTRIBUTION）。这条口径比 fast 那边的测试新，**改测试不改生产代码**：
        # 个人归属即可，断言一条没删。
        self.name=self.act('files.upload',{'file_name':self.token+'.xlsx',
            'attribution':{'level':'personal'},
            'content_base64':base64.b64encode(output.getvalue()).decode()})['file']

    def tearDown(self):
        frappe.set_user('Administrator');super().tearDown()

    def act(self,name,payload):
        return execute_registered_action(name,payload,confirmed=True,idempotency_key=uuid.uuid4().hex)['result']

    def read(self):return invoke_domain_service('files.sheet_read',{'table':self.name})

    def pin(self):
        value=self.read()
        return {'table':self.name,'expected_content_version':value['content_version'],
                'expected_structure_version':value['structure_version']}

    def workbook(self):
        from shangshu_files.sheet import _content
        return load_workbook(BytesIO(_content(frappe.get_doc('Shangshu File Center File',self.name))))

    def test_insert_delete_keeps_stable_ids_and_never_reuses_deleted_identity(self):
        before=self.read();old_ids=[row['row_id'] for row in before['rows']]
        self.act('files.sheet_structure',{**self.pin(),'operation':'row_insert','before_row_id':old_ids[1]})
        inserted=self.read();ids=[row['row_id'] for row in inserted['rows']]
        self.assertEqual((ids[0],ids[2]),tuple(old_ids))
        self.assertNotIn(ids[1],old_ids)
        self.act('files.sheet_structure',{**self.pin(),'operation':'row_delete','row_ids':[ids[1]]})
        self.act('files.sheet_row_append',{**self.pin(),'count':1})
        self.assertNotEqual(self.read()['rows'][-1]['row_id'],ids[1])

    def test_sort_moves_entire_rows_with_ids_and_stale_edit_is_rejected(self):
        old=self.pin();before=self.read()
        result=self.act('files.sheet_sort',{**old,'header':'数量','direction':'asc'})
        after=self.read()
        self.assertEqual([row['values']['数量']['value'] for row in after['rows']],[10,20])
        self.assertEqual(after['rows'][0]['row_id'],before['rows'][1]['row_id'])
        self.assertEqual(after['rows'][0]['values']['客户']['value'],'甲')
        self.assertEqual(result['applied'],2)
        with self.assertRaises(frappe.ValidationError):
            self.act('files.sheet_sort',{**old,'header':'数量','direction':'desc'})

    def test_style_changes_only_requested_format_and_is_a_new_file_version(self):
        before=self.read();row=before['rows'][0]['row_id']
        self.act('files.sheet_style',{**self.pin(),'cells':[{'row_id':row,'header':'数量'}],
            'style':{'number_format':'#,##0.00','bold':True,'wrap_text':True,'border':'all'}})
        wb=self.workbook();cell=wb.active['B2']
        self.assertEqual(cell.value,20)
        self.assertEqual(cell.number_format,'#,##0.00')
        self.assertTrue(cell.font.bold);self.assertTrue(cell.alignment.wrap_text)
        self.assertEqual(cell.border.top.style,'thin')
        self.assertEqual(wb.active['A2'].value,'乙')
        self.assertEqual(self.read()['content_version'],before['content_version']+1)
        projected=self.read()['rows'][0]['styles']['数量']
        self.assertEqual(projected['number_format'],'#,##0.00')
        self.assertTrue(projected['bold'])

    def test_empty_cell_format_survives_cold_reopen(self):
        row=self.read()['rows'][0]['row_id']
        self.act('files.sheet_cells_write',{**self.pin(),'cells':[{'row_id':row,'header':'数量','value':{'type':'empty','value':None}}]})
        self.act('files.sheet_style',{**self.pin(),'cells':[{'row_id':row,'header':'数量'}],'style':{'bold':True,'border':'all'}})
        from shangshu_files.sheet import _PARSE_CACHE
        _PARSE_CACHE.clear()
        projected=self.read()['rows'][0]['styles']['数量']
        self.assertTrue(projected.get('bold'));self.assertEqual(projected['border']['top']['style'],'thin')

    def test_source_partial_border_is_readable(self):
        from openpyxl.styles import Border,Side
        wb=self.workbook();wb.active['B2'].border=Border(top=Side(style='thin'))
        output=BytesIO();wb.save(output)
        self.act('files.new_version',{'file':self.name,'content_base64':base64.b64encode(output.getvalue()).decode()})
        style=self.read()['rows'][0]['styles']['数量']
        self.assertEqual(style['border']['top']['style'],'thin');self.assertIsNone(style['border']['left']['style'])

    def test_paste_empty_numeric_false_and_date_have_explicit_types(self):
        import datetime
        wb=Workbook();ws=wb.active;ws.append(['金额','确认','日期']);ws.append([100,True,datetime.date(2026,1,1)])
        output=BytesIO();wb.save(output)
        # 同上：新建文件必须带归属（用户 2026-10-15「上传必填归属」）。
        self.name=self.act('files.upload',{'file_name':self.token+'-types.xlsx',
            'attribution':{'level':'personal'},
            'content_base64':base64.b64encode(output.getvalue()).decode()})['file']
        self.act('files.sheet_paste_apply',{**self.pin(),'op_id':'paste-'+self.token,'start_row':0,'start_col':0,
            'matrix':[['','false','2026-10-20']],'matrix_types':[['empty','boolean','date']]})
        values=self.read()['rows'][0]['values'];self.assertEqual(values['金额']['type'],'empty')
        self.assertEqual(values['确认']['value'],False);self.assertTrue(values['日期']['value'].startswith('2026-10-20'))

    def test_paste_receipt_replay_rechecks_current_file_access(self):
        key='paste-replay-'+self.token;payload={**self.pin(),'op_id':key,'start_row':0,'start_col':1,
            'matrix':[[23]],'matrix_types':[['number']]}
        execute_registered_action('files.sheet_paste_apply',payload,confirmed=True,idempotency_key=key)
        # 合并说明（2026-10-21）：**按本分支的归属模型转移原件** ——
        # 本分支的读权走**归属记录**（`Shangshu Org Attribution`，域建表时登记的
        # personal/department 归属），**不是** Frappe 的 `owner` 字段 ⇒ 只改 `owner`
        # 字段**不构成**转移（读权还在，那条「重放必须被拒」就永远测不到）。
        # 下面把**归属人**换成 Administrator（另加回收态），这才是本分支的「原件转手」，
        # 后面两条断言（`check_permission('read')` 拒、同键重放拒）一条没删。
        frappe.db.set_value('Shangshu Org Attribution',{'resource':self.name},'owner_user','Administrator')
        frappe.db.set_value('Shangshu File Center File',self.name,{'owner':'Administrator','status':'Recycled'})
        with self.assertRaises(frappe.PermissionError):
            frappe.get_doc('Shangshu File Center File',self.name).check_permission('read')
        with self.assertRaises(frappe.PermissionError):
            execute_registered_action('files.sheet_paste_apply',payload,confirmed=True,idempotency_key=key)

    def test_invalid_structure_does_not_change_values_or_version(self):
        before=self.read()
        with self.assertRaises(frappe.ValidationError):
            self.act('files.sheet_structure',{**self.pin(),'operation':'column_delete','headers':['客户','数量']})
        self.assertEqual(self.read()['content_version'],before['content_version'])
        self.assertEqual(self.read()['rows'],before['rows'])

    def test_column_insert_delete_keeps_values_and_nonowner_is_denied(self):
        old=self.pin()
        self.act('files.sheet_structure',{**old,'operation':'column_insert','before_header':'数量','header':'备注'})
        self.assertEqual(self.read()['headers'],['客户','备注','数量'])
        self.assertEqual(self.workbook().active['C2'].value,20)
        self.act('files.sheet_structure',{**self.pin(),'operation':'column_delete','headers':['备注']})
        self.assertEqual(self.workbook().active['B2'].value,20)
        pin=self.pin();before=self.read()
        frappe.set_user('Administrator')
        other='ops-other-'+self.token+'@example.invalid'
        self.act('platform.identity.create',{'email':other,'display_name':'只读回归',
            'initial_password':'Isolated-office-2026!','roles':['staff']})
        frappe.set_user(other)
        with self.assertRaises(frappe.PermissionError):
            self.act('files.sheet_sort',{**pin,'header':'数量','direction':'asc'})
        frappe.set_user(self.user)
        self.assertEqual(self.read()['content_version'],before['content_version'])
        self.assertEqual(self.read()['rows'],before['rows'])
