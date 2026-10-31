import ast,importlib.util,re,sys,unittest,zipfile
from io import BytesIO
from pathlib import Path
from openpyxl import Workbook,load_workbook
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import import_context,placeholder_module,install_real_environment
# 真 app 包装进 sys.path —— sheet.py 顶层 `from shangshu_files.style_border import ...`
# 要能**真导入**（style_border 是纯函数模块，只 import re）。
# 不再给 'shangshu_files' 造假包：假包会把真子模块挡住。
install_real_environment('shangshu_files')
SOURCE=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
spec=importlib.util.spec_from_file_location('zipedit',SOURCE.with_name('zipedit.py'));z=importlib.util.module_from_spec(spec);spec.loader.exec_module(z)
nodes=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in ('_row_height_surgery','_title_for_part','_row_heights_from_xml')]
# 上下文按 sheet.py 顶层真 import 自动配齐 —— 不再手抄（手抄过时就不再漏名字）。
# zipedit 用真模块；frappe 与兄弟模块只在路过处占位（被测函数不依赖它们的行为）。
h=import_context(SOURCE,stubs={'zipedit':z,'frappe':placeholder_module('frappe'),'shangshu_files.sheet_search':placeholder_module('shangshu_files.sheet_search'),'shangshu_files.service':placeholder_module('shangshu_files.service'),'shangshu_files.working_file':placeholder_module('shangshu_files.working_file')});exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),h)
class RowHeights(unittest.TestCase):
 def setUp(self):
  wb=Workbook();ws=wb.active;ws.title='Sheet';ws.append(['ID','Date']);ws.append(['00123',123456789]);ws['B2'].number_format='yyyy-mm-dd';out=BytesIO();wb.save(out);self.raw=out.getvalue();self.part='xl/worksheets/sheet1.xml'
 def test_drag_height_persists_and_raw_cells_styles_other_parts_do_not_change(self):
  saved=h['_row_height_surgery'](self.raw,self.part,{'2':48})
  a=zipfile.ZipFile(BytesIO(self.raw));b=zipfile.ZipFile(BytesIO(saved))
  for coord in ['A1','A2','B1','B2']:self.assertEqual(z.cell_node(a.read(self.part),coord),z.cell_node(b.read(self.part),coord))
  for name in a.namelist():
   if name!=self.part:self.assertEqual(a.read(name),b.read(name))
  self.assertEqual(h['_row_heights_from_xml'](saved,'Sheet')['2'],48)
 def test_empty_row_layout_without_creating_any_value(self):
  saved=h['_row_height_surgery'](self.raw,self.part,{'9':60});xml=z.read_sheet(saved,self.part)
  self.assertIn(b'<row r="9" ht="60" customHeight="1"></row>',xml);self.assertIsNone(z.cell_node(xml,'A9'))
 def test_invalid_batch_has_no_result(self):
  for payload in [{},{'1':20},{'2':float('nan')},{'2':500},{'2':True},{'abc':30}]:
   with self.assertRaises(ValueError):h['_row_height_surgery'](self.raw,self.part,payload)
 def test_empty_workbook_accepts_row_height(self):
  wb=Workbook();out=BytesIO();wb.save(out)
  self.assertEqual(h['_row_heights_from_xml'](h['_row_height_surgery'](out.getvalue(),self.part,{'3':25}),'Sheet')['3'],25)
if __name__=='__main__':unittest.main()
