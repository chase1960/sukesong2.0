"""Real ZIP surgery for absent physical rows; fixed metadata can already name those rows."""
from pathlib import Path
from io import BytesIO
import importlib.util,re,unittest,zipfile
from openpyxl import Workbook,load_workbook
ROOT=Path(__file__).resolve().parents[2];P=ROOT/'frappe_apps/shangshu_files/shangshu_files/zipedit.py';spec=importlib.util.spec_from_file_location('zipedit',P);z=importlib.util.module_from_spec(spec);spec.loader.exec_module(z)
PART='xl/worksheets/sheet1.xml'
def raw(rows):
 wb=Workbook();ws=wb.active
 for coord,value in rows.items():ws[coord]=value
 stream=BytesIO();wb.save(stream);return stream.getvalue()
class Tests(unittest.TestCase):
 def test_new_empty_table_row_append_then_column_append_materializes_missing_header_row(self):
  before=raw({'A2':' '});out=z.edit_cells(before,PART,[('B1',{'type':'text','value':'验收新增列'})]);ws=load_workbook(BytesIO(out)).active;self.assertEqual(ws['B1'].value,'验收新增列');self.assertEqual(ws['A2'].value,' ');self.assertIsNone(ws['A1'].value)
 def test_empty_sheetdata_accepts_first_header_without_whole_workbook_rewrite(self):
  out=z.edit_cells(raw({}),PART,[('B1',{'type':'text','value':'first'})]);self.assertEqual(load_workbook(BytesIO(out)).active['B1'].value,'first')
 def test_selfclosing_sheetdata_is_opened_without_changing_its_attributes(self):
  before=raw({});archive=zipfile.ZipFile(BytesIO(before));xml=archive.read(PART).replace(b'<sheetData></sheetData>',b'<sheetData/>');before=z.rebuild_zip(before,{PART:xml});out=z.edit_cells(before,PART,[('A1',{'type':'text','value':'first'})]);self.assertEqual(load_workbook(BytesIO(out)).active['A1'].value,'first')
 def test_missing_middle_row_is_inserted_in_order_and_existing_rows_byte_exact(self):
  before=raw({'A2':'before','A4':'after'});old=zipfile.ZipFile(BytesIO(before)).read(PART);out=z.edit_cells(before,PART,[('C3',{'type':'number','value':1.25})]);xml=zipfile.ZipFile(BytesIO(out)).read(PART);self.assertEqual(re.findall(rb'<row r="(\d+)"',xml),[b'2',b'3',b'4']);self.assertIn(re.search(rb'<row r="2".*?</row>',old).group(0),xml);self.assertIn(re.search(rb'<row r="4".*?</row>',old).group(0),xml)
 def test_multiple_targets_create_one_row_in_column_order(self):
  out=z.edit_cells(raw({'A2':' '}),PART,[('D1',{'type':'text','value':'D'}),('B1',{'type':'text','value':'B'})]);xml=zipfile.ZipFile(BytesIO(out)).read(PART);self.assertEqual(len(re.findall(rb'<row r="1"',xml)),1);row=re.search(rb'<row r="1".*?</row>',xml).group(0);self.assertLess(row.index(b'B1'),row.index(b'D1'))
 def test_other_parts_and_dangerous_number_cell_remain_byte_identical(self):
  before=raw({'A2':' ','B2':1});archive=zipfile.ZipFile(BytesIO(before));xml=archive.read(PART).replace(b'<v>1</v>',b'<v>12345678901234567</v>');before=z.rebuild_zip(before,{PART:xml});out=z.edit_cells(before,PART,[('B1',{'type':'text','value':'new'})]);a=zipfile.ZipFile(BytesIO(before));b=zipfile.ZipFile(BytesIO(out))
  for name in a.namelist():
   if name!=PART:self.assertEqual(a.read(name),b.read(name),name)
  self.assertIn(re.search(rb'<c r="B2".*?</c>',xml).group(0),b.read(PART))
 def test_formula_and_duplicate_target_rejections_are_unchanged(self):
  for before,edits in [(raw({'A2':'=1+1'}),[('A2',{'type':'number','value':3})]),(raw({}),[('A1',{'type':'text','value':'x'}),('A1',{'type':'text','value':'y'})])]:
   with self.assertRaises(z.SurgeryError):z.edit_cells(before,PART,edits)
if __name__=='__main__':unittest.main()
