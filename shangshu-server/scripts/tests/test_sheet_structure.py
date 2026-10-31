import importlib.util
from pathlib import Path
import unittest
from openpyxl import Workbook,load_workbook
from openpyxl.styles import Font
from io import BytesIO
p=Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files/shangshu_files/sheet_structure.py'
spec=importlib.util.spec_from_file_location('structure',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Structure(unittest.TestCase):
 def test_row_move_identity_style_dimensions(self):
  w=Workbook();s=w.active;s.append(['x','y']);s.append(['a',1]);s.append(['b',2]);s['A2'].font=Font(bold=True);s.row_dimensions[2].height=45
  m.permute(s,'row',{2:3,3:2})
  self.assertEqual(s['A3'].value,'a');self.assertTrue(s['A3'].font.bold);self.assertEqual(s.row_dimensions[3].height,45)
  out=BytesIO();w.save(out);self.assertEqual(load_workbook(BytesIO(out.getvalue())).active['A3'].value,'a')
 def test_insert_delete_columns_preserve_style_width(self):
  w=Workbook();s=w.active;s.append(['a','b']);s.append([10,20]);s.column_dimensions['B'].width=27;s['B2'].font=Font(bold=True)
  m.insert_axis(s,'column',2);s['B1']='new'
  self.assertEqual(s['C2'].value,20);self.assertEqual(s.column_dimensions['C'].width,27);self.assertTrue(s['C2'].font.bold)
  m.delete_column(s,2);self.assertEqual(s['B2'].value,20);self.assertEqual(s.column_dimensions['B'].width,27)
 def test_merge_conflict_rejected_before_mutation(self):
  w=Workbook();s=w.active;s['A1']='a';s.merge_cells('A1:B1')
  with self.assertRaises(ValueError):m.insert_axis(s,'column',2)
  self.assertEqual(s['A1'].value,'a');self.assertIn('A1:B1',str(s.merged_cells))
 def test_package_fingerprint_ignores_save_time_only(self):
  import zipfile
  w=Workbook();w.active['A1']='same';a=BytesIO();w.save(a)
  b=BytesIO()
  with zipfile.ZipFile(BytesIO(a.getvalue())) as source,zipfile.ZipFile(b,'w') as target:
   for info in source.infolist():
    info.date_time=(2020,1,1,0,0,0);target.writestr(info,source.read(info.filename))
  self.assertEqual(m.workbook_fingerprint(a.getvalue()),m.workbook_fingerprint(b.getvalue()))
  w.active['A1']='different';c=BytesIO();w.save(c)
  self.assertNotEqual(m.workbook_fingerprint(a.getvalue()),m.workbook_fingerprint(c.getvalue()))
 def test_text_value_keeps_formats_and_literal_identity(self):
  import ast,types,datetime
  source=p.with_name('sheet.py').read_text();tree=ast.parse(source)
  function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_apply_value')
  def fail(message,*args):raise ValueError(message)
  scope={'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError),'datetime':datetime,'PRECISION_LIMIT':10**15,'TYPE_LABEL':{},'_column_type':lambda *args:None}
  exec(compile(ast.Module(body=[function],type_ignores=[]),'_apply_value','exec'),scope)
  for format in ['General','0.00','yyyy-mm-dd','@']:
   for value in ['00123','=SUM(A1:A2)','plain text']:
    w=Workbook();ws=w.active;cell=ws['A2'];cell.number_format=format;cell.font=Font(bold=True)
    scope['_apply_value'](cell,{'type':'text','value':value},ws,1,column_type='text')
    out=BytesIO();w.save(out);actual=load_workbook(BytesIO(out.getvalue())).active['A2']
    self.assertEqual(actual.value,value);self.assertEqual(actual.data_type,'s');self.assertEqual(actual.number_format,format);self.assertTrue(actual.font.bold)
 def test_move_order(self):
  self.assertEqual(m.move_order(['a','b','c'],'a','c'),['b','a','c'])
  self.assertEqual(m.move_order(['a','b'],'a'),['b','a'])
if __name__=='__main__':unittest.main(verbosity=2)
