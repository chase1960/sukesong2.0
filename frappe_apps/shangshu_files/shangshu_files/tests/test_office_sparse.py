"""XFD残留样式 + 真实公式：有界读／列宽保存不展开空矩形，原件公式不被改写。"""
import base64,time,uuid
from io import BytesIO
import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook,load_workbook
from openpyxl.styles import Font
from shangshu_core.public_api import execute_registered_action,invoke_domain_service


class TestOfficeSparse(FrappeTestCase):
    def test_sparse_xfd_read_layout_search_preserve_formula_and_other_values(self):
        frappe.set_user('Administrator');token=uuid.uuid4().hex
        def act(name,payload):return execute_registered_action(name,payload,confirmed=True,idempotency_key=uuid.uuid4().hex)['result']
        wb=Workbook();ws=wb.active;ws.title='稀疏报价';ws.append(['客户','数量','单价','合计'])
        for i in range(1000):ws.append(['客户-'+str(i),i+1,18.5,None])
        ws['D2']='=SUM(B2:B1001)';ws['XFD6000'].font=Font(bold=True)
        out=BytesIO();wb.save(out)
        # 合并说明（2026-10-21）：**按新契约补上归属** —— 用户 2026-10-15 原话
        # 「尚书是单例，没有企业归属」+「上传必填归属」⇒ `files.upload` 不传归属直接拒
        # （NO_ATTRIBUTION）。这条口径比 fast 那边的测试新，**改测试不改生产代码**。
        t=time.monotonic();name=act('files.upload',{'file_name':'稀疏-'+token+'.xlsx',
            'attribution':{'level':'personal'},
            'content_base64':base64.b64encode(out.getvalue()).decode()})['file'];upload=time.monotonic()-t
        def read(**extra):return invoke_domain_service('files.sheet_read',{'table':name,**extra})
        from shangshu_files.sheet import _PARSE_CACHE
        _PARSE_CACHE.clear()  # 上传可能预热；冷开必须真的重新解析原文件。
        t=time.monotonic();data=read();cold=time.monotonic()-t
        self.assertEqual(data['headers'],['客户','数量','单价','合计']);self.assertEqual(data['total_rows'],1000)
        t=time.monotonic();read();warm=time.monotonic()-t
        t=time.monotonic();act('files.sheet_layout_update',{'table':name,'expected_content_version':data['content_version'],
            'expected_structure_version':data['structure_version'],'column_widths':{'1':180}});layout=time.monotonic()-t
        from shangshu_files.sheet import _content
        saved=load_workbook(BytesIO(_content(frappe.get_doc('Shangshu File Center File',name))))
        self.assertEqual(saved.active['D2'].value,'=SUM(B2:B1001)');self.assertTrue(saved.active['XFD6000'].font.bold)
        self.assertEqual(saved.active['B1001'].value,1000)
        self.assertLess(len(saved.active._cells),5000)
        print('OFFICE_PERF',{'sample':'1000 rows/4 data columns/XFD6000 style/one SUM',
            'upload':round(upload,3),'cold':round(cold,3),'warm':round(warm,3),'layout':round(layout,3)},flush=True)
