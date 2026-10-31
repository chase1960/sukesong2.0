"""Upload validates real XLSX before any persistent insert; read-only features allowed."""
import ast
import os
import types
import sys
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference

ROOT=Path(__file__).resolve().parents[2]
class Invalid(Exception): pass
class ReachedPersistence(Exception): pass

def production_function(path, name, env):
    tree=ast.parse((ROOT/path).read_text())
    node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),env)
    return env[name]

class UploadValidation(unittest.TestCase):
    def setUp(self):
        self.events=[]
        def throw(message, kind): raise kind(message)
        self.frappe=types.SimpleNamespace(throw=throw,ValidationError=Invalid)
        self.safe=production_function('frappe_apps/shangshu_files/shangshu_files/sheet.py','safe_open',dict(frappe=self.frappe,zipfile=zipfile,BytesIO=BytesIO,MAX_FILE_BYTES=20*1024*1024,MAX_ZIP_UNCOMPRESSED=512*1024*1024,load_workbook=load_workbook))
        def resolve(payload):
            self.events.append('directory-resolution');raise ReachedPersistence()
        self.env=dict(frappe=self.frappe,os=os,_safe_name=lambda x:x,_read_content=lambda *_:(self.content,'sha'),directories=types.SimpleNamespace(resolve=resolve))
        self.upload=production_function('frappe_apps/shangshu_files/shangshu_files/service.py','upload',self.env)
    def run_upload(self, content):
        self.content=content
        with patch.dict(sys.modules,{'shangshu_files.sheet':types.SimpleNamespace(safe_open=self.safe)}):
            return self.upload({'file_name':'controlled.xlsx'})
    def test_plain_text_rejected_before_any_resource_or_file_write(self):
        with self.assertRaisesRegex(Invalid,'未创建文件'):self.run_upload(b'not an xlsx')
        self.assertEqual(self.events,[])
    def test_zip_with_fake_workbook_parts_rejected_before_write(self):
        out=BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            z.writestr('xl/workbook.xml','<bad/>');z.writestr('[Content_Types].xml','<bad/>')
        with self.assertRaises(Invalid):self.run_upload(out.getvalue())
        self.assertEqual(self.events,[])
    def test_corrupt_sheet_xml_rejected_before_write(self):
        raw=self.valid();out=BytesIO()
        with zipfile.ZipFile(BytesIO(raw)) as src,zipfile.ZipFile(out,'w') as dst:
            for name in src.namelist():dst.writestr(name,b'<broken' if name=='xl/worksheets/sheet1.xml' else src.read(name))
        with self.assertRaises(Invalid):self.run_upload(out.getvalue())
        self.assertEqual(self.events,[])
    def valid(self):
        wb=Workbook();ws=wb.active;ws.append(['number','formula']);ws.append([2,'=A2+1']);chart=BarChart();chart.add_data(Reference(ws,min_col=1,min_row=1,max_row=2),titles_from_data=True);ws.add_chart(chart,'D1');ws.merge_cells('A4:B4');ws['A4']='merged';out=BytesIO();wb.save(out);return out.getvalue()
    def test_legal_formula_chart_and_merged_workbook_reaches_normal_upload(self):
        with self.assertRaises(ReachedPersistence):self.run_upload(self.valid())
        self.assertEqual(self.events,['directory-resolution'])

if __name__=='__main__':unittest.main()
