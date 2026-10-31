"""Column-only edits preserve cell XML and every other ZIP part."""
import sys,unittest,zipfile,re
from pathlib import Path
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files'))
from shangshu_files import zipedit as z
from openpyxl import Workbook,load_workbook
class Widths(unittest.TestCase):
 def fixture(self):
  w=Workbook();s=w.active;s.append(['amount','calc']);s.append([12,'=A2+1'])
  s.column_dimensions.group('A','D',hidden=True);s.column_dimensions['A'].width=12
  s['XFD6526'].number_format='0.00';w.create_sheet('Other')['A1']='unchanged'
  b=BytesIO();w.save(b);return b.getvalue()
 def test_split_group_preserves_data_and_other_parts(self):
  before=self.fixture();after=z.edit_column_widths(before,'xl/worksheets/sheet1.xml',{'2':24,'6':18})
  with zipfile.ZipFile(BytesIO(before)) as a,zipfile.ZipFile(BytesIO(after)) as b:
   self.assertEqual(a.namelist(),b.namelist())
   for n in a.namelist():
    if n!='xl/worksheets/sheet1.xml':self.assertEqual(a.read(n),b.read(n),n)
   strip=lambda x:re.sub(rb'<cols\b.*?</cols>',b'',x,flags=re.S)
   self.assertEqual(strip(a.read('xl/worksheets/sheet1.xml')),strip(b.read('xl/worksheets/sheet1.xml')))
  s=load_workbook(BytesIO(after)).active
  self.assertEqual(s.column_dimensions['B'].width,24)
  self.assertTrue(s.column_dimensions['B'].hidden)
  self.assertEqual(s.column_dimensions['C'].max,4)
  self.assertEqual(s['B2'].value,'=A2+1')
 def test_no_cols_and_prefixed(self):
  data=self.fixture();part='xl/worksheets/sheet1.xml';xml=z.read_sheet(data,part)
  xml=re.sub(rb'<cols\b.*?</cols>',b'',xml,flags=re.S)
  raw=z.rebuild_zip(data,{part:xml});out=z.edit_column_widths(raw,part,{'3':19})
  self.assertEqual(load_workbook(BytesIO(out)).active.column_dimensions['C'].width,19)
  xml=xml.replace(b'<worksheet ',b'<m:worksheet xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ').replace(b'</worksheet>',b'</m:worksheet>').replace(b'<sheetData>',b'<m:sheetData>').replace(b'</sheetData>',b'</m:sheetData>')
  out=z.edit_column_widths(z.rebuild_zip(data,{part:xml}),part,{'3':19})
  self.assertEqual(load_workbook(BytesIO(out)).active.column_dimensions['C'].width,19)
 def test_invalid_is_rejected(self):
  data=self.fixture()
  for widths in [{0:10},{-1:10},{16385:10},{'1':float('nan')},{'1':float('inf')},{'1':0},{'1':True},{'1':256},{}]:
   with self.assertRaises(z.SurgeryError,msg=str(widths)):z.edit_column_widths(data,'xl/worksheets/sheet1.xml',widths)
if __name__=='__main__':unittest.main(verbosity=2)
