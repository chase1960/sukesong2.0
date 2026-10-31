"""文件工作簿接入实库回归；合成身份只在独立回归站使用。"""
import base64
from io import BytesIO
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook
from shangshu_core.public_api import (
    execute_registered_action, invoke_domain_service, query_dataset,
    propose_registered_action, resolve_action_proposal, set_domain_enabled,
)


class TestOfficeIntegration(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.prefix=uuid.uuid4().hex
        self.user='office-'+self.prefix+'@example.invalid'
        self.act('platform.identity.create',{'email':self.user,'display_name':'办公回归员工',
            'initial_password':'Isolated-only-2026!','roles':['staff']})
        frappe.set_user(self.user)

    def tearDown(self):
        frappe.set_user('Administrator')
        super().tearDown()

    def act(self,action,payload,key=None):
        return execute_registered_action(action,payload,confirmed=True,
            idempotency_key=key or uuid.uuid4().hex)['result']

    def create(self):
        return self.act('files.create',{'file_name':'办公验收-'+self.prefix,
            'attribution':{'level':'personal'}})['file']

    def read(self,name):
        return invoke_domain_service('files.sheet_read',{'table':name})

    def pin(self,name):
        data=self.read(name)
        return {k:data[k] for k in ('table','sheet')} | {
            'expected_content_version':data['content_version'],
            'expected_structure_version':data['structure_version']}

    def test_staff_create_structure_bulk_write_undo_and_stale_conflict(self):
        name=self.create()
        self.act('files.sheet_column_append',{**self.pin(name),'header':'数量'})
        self.act('files.sheet_row_append',{**self.pin(name),'count':2})
        data=self.read(name);old=self.pin(name)
        rows=[r['row_id'] for r in data['rows']]
        self.assertEqual(len(rows),2)
        cells=[{'row_id':rows[0],'header':'列1','value':{'type':'text','value':'客户A'}},
               {'row_id':rows[1],'header':'数量','value':{'type':'number','value':150}}]
        op='edit-'+self.prefix
        result=self.act('files.sheet_cells_write',{**old,'cells':cells,'op_id':op})
        self.assertEqual(result['applied'],2)
        written=self.read(name)
        self.assertEqual(written['content_version'],data['content_version']+1)
        self.assertEqual(written['rows'][1]['values']['数量']['value'],150)
        with self.assertRaisesRegex(frappe.ValidationError,'版本冲突'):
            self.act('files.sheet_cells_write',{**old,'cells':cells})
        undone=self.act('files.sheet_cells_undo',{'table':name,'op_id':op})
        self.assertEqual(undone['applied'],2)
        self.assertNotEqual(self.read(name)['rows'][1]['values']['数量'].get('value'),150)

    def test_new_workbook_cannot_masquerade_as_pdf_or_docx(self):
        for suffix in ('.pdf','.docx'):
            created=self.act('files.create',{'file_name':'报价-'+self.prefix+suffix,
                'attribution':{'level':'personal'}})
            self.assertTrue(created['file_name'].endswith('.xlsx'))
            self.assertEqual(self.read(created['file'])['headers'],['列1'])

    def test_xlsx_recycle_restore_and_other_employee_is_denied(self):
        name=self.create()
        self.act('files.recycle',{'file':name})
        trash=query_dataset('files.file',{'scope':'trash'})
        self.assertIn(name,[r['name'] for r in trash['rows']])
        self.act('files.restore',{'file':name})
        self.assertTrue(self.read(name)['writable'])
        frappe.set_user('Administrator')
        other='office-other-'+self.prefix+'@example.invalid'
        self.act('platform.identity.create',{'email':other,'display_name':'另一员工',
            'initial_password':'Isolated-only-2026!','roles':['staff']})
        frappe.set_user(other)
        with self.assertRaises(frappe.PermissionError):self.read(name)
        with self.assertRaises(frappe.PermissionError):
            invoke_domain_service('files.action_proposals',{'table':name})
        with self.assertRaises(frappe.PermissionError):
            self.act('files.recycle',{'file':name})

    def test_upload_preserves_original_bytes_and_duplicate_xlsx_creates_new_table(self):
        wb=Workbook();ws=wb.active;ws.append(['客户','客户']);ws.append(['甲','乙'])
        output=BytesIO();wb.save(output);content=output.getvalue()
        # 合并说明（2026-10-21）：**按新契约补上归属** —— 用户 2026-10-15 原话
        # 「尚书是单例，没有企业归属」+「上传必填归属」⇒ `files.upload` 不传归属直接拒
        # （NO_ATTRIBUTION）。这条口径比 fast 那边的测试新，**改测试不改生产代码**：
        # 个人归属即可，下面两条断言一条没删。
        payload={'file_name':'自由工作簿-'+self.prefix+'.xlsx',
                 'attribution':{'level':'personal'},
                 'content_base64':base64.b64encode(content).decode()}
        first=self.act('files.upload',payload)
        doc=frappe.get_doc('Shangshu File Center File',first['file'])
        from shangshu_files.sheet import _content
        self.assertEqual(_content(doc),content)
        # 存量字段 version_count 保存的是下一个可分配号，版本真相在 Version 记录。
        self.assertEqual(first['version'],1)
        self.assertEqual(doc.version_count,2)
        with self.assertRaisesRegex(frappe.ValidationError,'文件中心'):self.read(first['file'])
        # **同名 xlsx ⇒ 恒为新表**（表格没有版本，只有多张表；Excel 交互契约 §2）。
        # 合并 fast 那条线时，这条规则被加了 `new_resource` 的前提
        # （同名默认追版本、显式声明才另存），**被我们改回来** ——
        # 用户 2026-10-20 原话：「这个 excel 以后会有版本的说法吗？不是只有多种表格吗？」
        # 断言改成「另存新表」，**没有删断言**（原来那两条断言的是另一条口径）。
        second=self.act('files.upload',payload)
        self.assertNotEqual(second['file'],first['file'],
            '同名 xlsx 上传必须另存新表，不能在原表上追版本（表格没有版本这回事）')
        self.assertEqual(second['version'],1,'新表从第 1 版起，不是接着旧表第 2 版')
        independent=self.act('files.upload',{**payload,'new_resource':True})
        self.assertNotEqual(independent['file'],first['file'],
            '显式声明 new_resource 也是新表 —— 这条规则本来就是默认口径')

    def test_same_name_ordinary_file_appends_version_while_xlsx_creates_new_table(self):
        """同名两条口径钉死（各自的反面各钉一次）：

        · **普通文件**（txt）同目录同名重传 ⇒ **追版本**（同一份文件、版本 +1）；
        · **表格**（xlsx）同名上传 ⇒ **恒为新表**（新文件身份、版本从 1 起）。

        改之前（合并 fast 那条线之后）这两条被混成一条：xlsx 默认也追版本。
        """
        txt='同名口径-'+self.prefix+'.txt'
        payload={'file_name':txt,'attribution':{'level':'personal'},
                 'content_base64':base64.b64encode('第一版'.encode()).decode()}
        first=self.act('files.upload',payload)
        self.assertEqual(first['version'],1)
        second=self.act('files.upload',{**payload,'content_base64':base64.b64encode('第二版'.encode()).decode()})
        self.assertEqual(second['file'],first['file'],'普通文件同名重传应当追同一个文件的版本')
        self.assertEqual(second['version'],2,'普通文件同名重传应当是第 2 版')
        wb=Workbook();ws=wb.active;ws.append(['列1'])
        output=BytesIO();wb.save(output)
        sheet={'file_name':'同名口径-'+self.prefix+'.xlsx','attribution':{'level':'personal'},
               'content_base64':base64.b64encode(output.getvalue()).decode()}
        one=self.act('files.upload',sheet)
        two=self.act('files.upload',sheet)
        self.assertNotEqual(two['file'],one['file'],'表格同名上传必须是新表')
        self.assertEqual(two['version'],1)

    def test_agent_reject_zero_write_then_confirmed_same_action(self):
        name=self.create()
        self.act('files.sheet_row_append',{**self.pin(name),'count':1})
        before=self.read(name)
        payload={**self.pin(name),'cells':[{'row_id':before['rows'][0]['row_id'],
            'header':'列1','value':{'type':'text','value':'确认后才写入'}}]}
        proposal=propose_registered_action('files.sheet_cells_write',payload)
        resolve_action_proposal(proposal['id'],'rejected')
        self.assertEqual(self.read(name)['content_version'],before['content_version'])
        proposal=propose_registered_action('files.sheet_cells_write',payload)
        resolve_action_proposal(proposal['id'],'confirmed')
        resolve_action_proposal(proposal['id'],'confirmed')
        data=self.read(name)
        self.assertEqual(data['content_version'],before['content_version']+1)
        self.assertEqual(data['rows'][0]['values']['列1']['value'],'确认后才写入')

    def test_complete_stop_blocks_workbook_but_not_unrelated_mail(self):
        name=self.create();frappe.db.commit()
        frappe.set_user('Administrator')
        set_domain_enabled('com.shangshu.files',False,'独立办公回归',stop_mode='complete')
        frappe.db.commit()
        try:
            frappe.set_user(self.user)
            with self.assertRaises(frappe.PermissionError):self.read(name)
            draft=self.act('mail.save_draft',{'subject':'停文件域仍可存草稿','body':'正文',
                'to':['client@example.invalid'],'cc':[]})
            self.assertTrue(draft['name'])
        finally:
            frappe.set_user('Administrator')
            set_domain_enabled('com.shangshu.files',True,'独立办公回归恢复')
            frappe.db.commit()
        frappe.set_user(self.user)
        self.assertTrue(self.read(name)['writable'])
