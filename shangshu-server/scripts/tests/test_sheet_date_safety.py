#!/usr/bin/env python3
"""Original OOXML numeric cell must never become an error after a slow save."""
import ast,io,importlib.util,types,unittest,zipfile
from pathlib import Path
from openpyxl import Workbook,load_workbook
SOURCE=Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
s=importlib.util.spec_from_file_location('ze',SOURCE.with_name('zipedit.py'));ze=importlib.util.module_from_spec(s);s.loader.exec_module(ze)
class Rejected(Exception):pass
class FakeFrappe:
 ValidationError=Rejected
 @staticmethod
 def throw(message,kind=Rejected):raise kind(message)
def fixture(explicit_error=False):
 w=Workbook();ws=w.active;ws['A1']='编号';ws['A2']='#VALUE!' if explicit_error else 15058300000;ws['A2'].number_format='m/d/yy';b=io.BytesIO();w.save(b);return b.getvalue()
class SlowSaveSafety(unittest.TestCase):
 def setUp(self):
  self.env={'frappe':FakeFrappe,'zipfile':zipfile,'BytesIO':io.BytesIO,'zipedit':ze,'load_workbook':load_workbook,'MAX_FILE_BYTES':20*1024*1024,'MAX_ZIP_UNCOMPRESSED':200*1024*1024,'WRITE_DENY_PARTS':(),'STRIP_PARTS':(),'_parts_in':lambda *a:[],'_drawings_verdict':lambda *a:None,'_extract_comments':lambda *a:(0,False,0,0)}
  astree=ast.parse(SOURCE.read_text());nodes=[x for x in astree.body if isinstance(x,ast.FunctionDef) and x.name in {'safe_open','_assert_no_numeric_parse_loss'}];exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),self.env)
 def test_original_numeric_xml_cannot_be_silently_saved_as_error(self):
  b=fixture();raw=zipfile.ZipFile(io.BytesIO(b)).read('xl/worksheets/sheet1.xml');self.assertIn(b'<v>15058300000</v>',raw);self.assertNotIn(b't="e"',raw)
  with self.assertRaisesRegex(Rejected,'原有数值|原始数值'):
   self.env['safe_open'](b,for_write=True)
  self.assertIn(b'<v>15058300000</v>',zipfile.ZipFile(io.BytesIO(b)).read('xl/worksheets/sheet1.xml'))
 def test_explicit_original_error_is_not_a_numeric_loss(self):
  w=self.env['safe_open'](fixture(True),for_write=True);self.assertEqual(w.active['A2'].value,'#VALUE!')
if __name__=='__main__':unittest.main(verbosity=2)
