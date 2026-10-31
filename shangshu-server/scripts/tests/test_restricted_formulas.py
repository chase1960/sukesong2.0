"""Behavior checks against actual interpreter and OOXML caches, no Frappe mock engine."""
import sys,unittest,datetime
from pathlib import Path
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files'))
from shangshu_files import formulas as f
from openpyxl import Workbook,load_workbook
class Formulas(unittest.TestCase):
 def test_styled_xfd_extent_does_not_materialize_empty_rectangle(self):
  wb=Workbook();ws=wb.active;ws.append(['amount','result']);ws.append([5,'=A2+1'])
  ws.cell(6526,16384).number_format='0.00'
  count=len(ws._cells)
  self.assertEqual([c.coordinate for c in f.formula_cells(ws)],['B2'])
  self.assertEqual(len(ws._cells),count)
  values=f.recalculate(ws,{'rows':['r'+str(i) for i in range(6525)]},{},{})
  self.assertEqual(values['B2'],6)
  # Reading headers may instantiate one row, never the 106-million-cell rectangle.
  self.assertLess(len(ws._cells),17000)
 def test_math_and_lazy_if(self):
  self.assertEqual(f.evaluate(f.parse('=IF(2>1,SUM(800,900),1/0)'),lambda r:None),1700)
  self.assertEqual(f.evaluate(f.parse('=(8+2)*3/5'),lambda r:None),6)
  self.assertEqual(f.evaluate(f.parse('=COUNT(A2:A4)'),lambda r: {'A2':1,'A3':'text','A4':2}[r]),2)
 def test_dates(self):
  self.assertEqual(f.evaluate(f.parse('=DATEDIF("2026-10-01","2026-10-19","D")'),lambda r:None),18)
  self.assertEqual(f.evaluate(f.parse('=DAYS("2026-10-19","2026-10-01")'),lambda r:None),18)
  self.assertEqual(f.evaluate(f.parse('=A2-A3'),lambda r:{'A2':'2026-10-19','A3':datetime.date(2026,10,1)}[r]),18)
 def test_no_code_or_external(self):
  for text in ['=__import__("os")','=WEBSERVICE("https://x")','=Sheet2!A2','=SUM([x]A2)','=A1;DROP TABLE','='+'1+'*600+'1']:
   with self.assertRaises(f.FormulaError,msg=text):f.parse(text)
 def fixture(self):
  wb=Workbook();ws=wb.active;ws.append(['金额','计算','链']);ws.append([999,'=SUM(A2:A3)','=B2+1']);ws.append([999,None,None]);meta={'rows':['r1','r2']};definition={'columns':[{'header':'金额','field':'amount','promoted':True}]};return wb,ws,meta,definition
 def test_formal_not_stale_projection_and_export(self):
  wb,ws,meta,definition=self.fixture();values=f.recalculate(ws,meta,{'r1':{'amount':800},'r2':{'amount':900}},definition)
  self.assertEqual(values,{'B2':1700,'C2':1701})
  b=BytesIO();wb.save(b);saved=f.write_cached_values(b.getvalue(),ws.title,values)
  self.assertEqual(load_workbook(BytesIO(saved),data_only=True).active['B2'].value,1700)
  self.assertEqual(load_workbook(BytesIO(saved),data_only=False).active['B2'].value,'=SUM(A2:A3)')
  values=f.recalculate(ws,meta,{'r1':{'amount':1000},'r2':{'amount':900}},definition);self.assertEqual(values['C2'],1901)
  typed={'链':{'type':'formula','formula':'=B2+1'}};f.decorate_values(typed,'r1',meta,4,{'金额'});self.assertTrue(typed['链']['hidden'])
 def test_cached_xml_cold_parser_and_old_prefixed_file(self):
  import ast,re,time,zipfile,xml.etree.ElementTree as ET
  source=Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
  tree=ast.parse(source.read_text());ns={'re':re,'time':time,'_literal_text':str,'_dominant_type':lambda values:None,'_assert_table_headers':lambda headers:headers}
  node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_entry_fast')
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),ns)
  wb,ws,meta,d=self.fixture();values=f.recalculate(ws,meta,{'r1':{'amount':1},'r2':{'amount':2}},d)
  b=BytesIO();wb.save(b);saved=f.write_cached_values(b.getvalue(),ws.title,values)
  cold=ns['_entry_fast'](saved,None)
  self.assertEqual(len(cold['rows_raw']),2);self.assertEqual(cold['headers'],['金额','计算','链'])
  self.assertEqual(cold['rows_raw'][0][1],'=SUM(A2:A3)')
  # Old versions used ElementTree's ns0 tags; never accept an empty parse as data.
  out=BytesIO()
  with zipfile.ZipFile(BytesIO(saved)) as z,zipfile.ZipFile(out,'w') as dest:
   for info in z.infolist():
    data=z.read(info.filename)
    if info.filename=='xl/worksheets/sheet1.xml':
     ET.register_namespace('old','http://schemas.openxmlformats.org/spreadsheetml/2006/main')
     data=ET.tostring(ET.fromstring(data))
    dest.writestr(info,data)
  with self.assertRaisesRegex(ValueError,'XML-aware'):ns['_entry_fast'](out.getvalue(),None)
  reopened=load_workbook(BytesIO(out.getvalue()),data_only=False)
  self.assertEqual(reopened.active.max_row,3);self.assertEqual(reopened.active['B2'].value,'=SUM(A2:A3)')
 def test_structure_relocation_preserves_referenced_identities(self):
  import copy
  wb,ws,meta,d=self.fixture();formal={'r1':{'amount':10},'r2':{'amount':20}};f.recalculate(ws,meta,formal,d);old=copy.deepcopy(meta)
  ws.insert_rows(3);meta['rows']=['r1','new','r2'];f.relocate(ws,meta,old)
  self.assertEqual(ws['B2'].value,'=SUM(A2,A4)');self.assertEqual(f.recalculate(ws,meta,formal,d)['C2'],31)
  old=copy.deepcopy(meta);ws.insert_cols(1);f.relocate(ws,meta,old)
  self.assertEqual(ws['C2'].value,'=SUM(B2,B4)');self.assertEqual(f.recalculate(ws,meta,formal,d)['D2'],31)
  old=copy.deepcopy(meta);ws.delete_cols(2)
  with self.assertRaisesRegex(f.FormulaError,'仍被公式引用'):f.relocate(ws,meta,old)
 def test_cycle_zero_and_stable_identity(self):
  wb,ws,meta,d=self.fixture();f.recalculate(ws,meta,{'r1':{'amount':1}},d)
  ws.insert_rows(2);meta['rows']=['new','r1','r2']
  with self.assertRaises(f.FormulaError):f.recalculate(ws,meta,{},d)
  wb,ws,meta,d=self.fixture();ws['B2']='=C2';ws['C2']='=B2'
  with self.assertRaises(f.FormulaError):f.recalculate(ws,meta,{},d)
  ws['B2']='=1/0'
  with self.assertRaises(f.FormulaError):f.recalculate(ws,meta,{},d)
 def test_sparse_same_engine_and_zip_cache(self):
  from shangshu_files import zipedit
  import copy
  wb,ws,meta,definition=self.fixture();ws['B2'].number_format='0.00';ws['B2'].font=__import__('openpyxl').styles.Font(bold=True)
  entry={'headers':['金额','计算','链'],'rows_raw':[(999,'=SUM(A2:A3)','=B2+1'),(999,None,None)]}
  original=copy.deepcopy(entry['rows_raw'])
  edits=f.recalculate_index(entry,meta,{(2,1):123},{'r1':{'amount':800},'r2':{'amount':900}},definition)
  self.assertEqual(dict(edits)['C2']['value'],1701)
  self.assertEqual(entry['rows_raw'],original)
  b=BytesIO();wb.save(b);part=zipedit.sheet_part_by_title(b.getvalue(),ws.title)
  saved=zipedit.edit_cells(b.getvalue(),part,edits)
  f.verify_cached_nodes(zipedit.cell_nodes(zipedit.read_sheet(saved,part),dict(edits)),edits)
  read=load_workbook(BytesIO(saved),data_only=True).active
  self.assertEqual(read['B2'].value,1700);self.assertTrue(read['B2'].font.bold);self.assertEqual(read['B2'].number_format,'0.00')
  self.assertEqual(load_workbook(BytesIO(saved),data_only=False).active['C2'].value,'=B2+1')
  self.assertEqual(f.recalculate_index(entry,meta,{(2,1):123},{},{} )[0][1]['value'],1122)
  corrupt=zipedit.cell_nodes(zipedit.read_sheet(saved,part),dict(edits));corrupt['B2']=__import__('re').sub(rb'<v>.*?</v>',b'<v>1702</v>',corrupt['B2'])
  with self.assertRaises(f.FormulaError):f.verify_cached_nodes(corrupt,edits)
 def test_sparse_dates_literal_and_new_index(self):
  class Literal(str):pass
  entry={'headers':['日期','计算','文本'],'rows_raw':[(datetime.datetime(2026,10,19),'=DAYS(A2,A3)',Literal('=not a formula')),(datetime.datetime(2026,10,1),None,None)]}
  meta={'rows':['r1','r2']}
  self.assertEqual(f.recalculate_index(entry,meta,{}, {},{})[0][1]['value'],18)
  self.assertEqual(len(meta['formula_results']),1)
  self.assertEqual(f.recalculate_index(entry,meta,{(2,1):datetime.date(2026,10,20)}, {},{})[0][1]['value'],19)
  # Full formula add/remove/structure saves invalidate the old parse entry and warm
  # a new one. Positions must be derived from that new index, never old metadata.
  fresh={'headers':entry['headers'],'rows_raw':[(datetime.date(2026,10,19),None,'=COUNT(A2:A3)'),entry['rows_raw'][1]]}
  edited=f.recalculate_index(fresh,meta,{}, {},{})
  self.assertEqual([coord for coord,_ in edited],['C2'])
 def test_sparse_cycle_rejected_without_index_mutation(self):
  entry={'headers':['A','B'],'rows_raw':[(1,'=B2')]};meta={'rows':['r']}
  with self.assertRaises(f.FormulaError):f.recalculate_index(entry,meta,{(2,1):5},{},{})
  self.assertEqual(entry['rows_raw'][0][0],1)
 def test_import_pending_propagates_preserves_and_clears_shared_caches(self):
  import zipfile,re
  from shangshu_files import zipedit
  w=Workbook();a=w.active;a.title='Main';a.append(['值','旧公式','依赖','查找','今天']);a.append([8,'=TEXT(A2,"0")','=B2','=VLOOKUP(A2,A2:B3,2,FALSE)','=TODAY()']);a.append([9,'=TEXT(A3,"0")',None,None,None]);b=w.create_sheet('Other');b['A1']='=Main!B2'
  buf=BytesIO();w.save(buf);part=zipedit.sheet_part_by_title(buf.getvalue(),'Main')
  with zipfile.ZipFile(BytesIO(buf.getvalue())) as z:
   raw=z.read(part);raw=raw.replace(b'<f>TEXT(A2,"0")</f>',b'<f t="shared" si="0" ref="B2:B3">TEXT(A2,"0")</f>').replace(b'<f>TEXT(A3,"0")</f>',b'<f t="shared" si="0"/>').replace(b'<v></v>',b'<v>999999</v>')
  imported=zipedit.rebuild_zip(buf.getvalue(),{part.encode() if isinstance(part,str) else part:raw})
  clean=f.invalidate_imported_caches(imported)
  with zipfile.ZipFile(BytesIO(clean)) as z:
   xml=z.read(part);self.assertIn(b'<f t="shared" si="0" ref="B2:B3">',xml);self.assertIn(b'<f t="shared" si="0"/>',xml);self.assertNotIn(b'999999',xml)
   self.assertIn(b'fullCalcOnLoad="1"',z.read('xl/workbook.xml'))
  reopened=load_workbook(BytesIO(clean));self.assertEqual(reopened['Main']['B3'].value,'=TEXT(A3,"0")')
  m={'rows':['r1','r2']};values=f.recalculate(reopened['Main'],m,{},{});self.assertIsNone(values['C2'])
  self.assertTrue(m['formula_results']['r1\0旧公式']['pending']);self.assertTrue(m['formula_results']['r1\0依赖']['pending'])
  saved=f.write_cached_values(clean,'Main',values);cached=load_workbook(BytesIO(saved),data_only=True)
  self.assertIsNone(cached['Main']['B2'].value);self.assertIsNone(cached['Other']['A1'].value)
  v=f.decorate_values({'依赖':{'type':'formula','formula':'B2','value':999999}},'r1',m,3,set())
  self.assertIsNone(v['依赖']['value']);self.assertTrue(v['依赖']['calculation_pending'])
  self.assertTrue(f.decorate_values({'依赖':{'type':'formula','formula':'B2'}},'r1',m,3,{'值'})['依赖']['hidden'])
  for unsupported in ['=TEXT(A2,"0")','=VLOOKUP(A2,A2:B3,2,FALSE)','=TODAY()','=Other!A1']:
   with self.assertRaises(f.FormulaError):f.parse(unsupported) # new-input gate unchanged
 def test_daily_write_requires_explicit_formula_migration(self):
  # The retired compatibility helper is intentionally absent. The public entry
  # preserves original formulas and refuses daily edits until explicit migration.
  import sys
  sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts/tests'))
  import test_incremental_daily_write as daily
  case=daily.DailyEntries();case.setUp()
  try:
   case.test_formula_workbook_refuses_without_replacing_original()
  finally:
   case.doCleanups()
 def test_cache_initialization_prefixed_and_noncanonical_fallback(self):
  import zipfile
  from shangshu_files import zipedit
  w=Workbook();w.active.append(['A','B']);w.active.append([7,'=A2']);buf=BytesIO();w.save(buf)
  with zipfile.ZipFile(BytesIO(buf.getvalue())) as z:source=z.read('xl/worksheets/sheet1.xml')
  for node in [b'<c r="B2"><v>999</v><f>A2</f></c>',b'<x:c xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" r="B2"> <x:f>A2</x:f><x:v>999</x:v></x:c>']:
   raw=source.replace(b'<c r="B2"><f>A2</f><v></v></c>',node)
   self.assertIn(node,raw)
   changed=zipedit.rebuild_zip(buf.getvalue(),{b'xl/worksheets/sheet1.xml':raw});clean=f.invalidate_imported_caches(changed)
   with zipfile.ZipFile(BytesIO(clean)) as z:
    output=z.read('xl/worksheets/sheet1.xml');self.assertNotIn(b'999',output);self.assertIn(b'A2</',output);self.assertIn(b'<v>7</v>',output)
 def test_single_pass_row_splice_matches_ordered_reference(self):
  from shangshu_files import zipedit
  import random
  rng=random.Random(967)
  for iteration in range(80):
   existing=sorted(rng.sample(range(1,36),15));targets=sorted(rng.sample(range(1,36),12))
   row=b'<row r="2">'+b''.join(('<c r="%s2" s="3"><v>%d</v></c>'%(zipedit.num_to_col(c),c)).encode() for c in existing)
   edits=[(c,zipedit.num_to_col(c)+'2',{'type':'number','value':iteration+c}) for c in targets]
   self.assertEqual(zipedit._splice_row(row,edits),zipedit._splice_row_missing(row,edits))
  row=b'<row r="2"><c r="A2"><f>1+1</f><v>2</v></c>'
  with self.assertRaises(zipedit.SurgeryError):zipedit._splice_row(row,[(1,'A2',{'type':'number','value':3})])
  self.assertEqual(zipedit._splice_row(b'<row r="2"/>',[(1,'A2',{'type':'number','value':3})]),b'<row r="2"><c r="A2"><v>3</v></c></row>')
 def test_pending_cache_noop_preserves_formula_but_new_pending_clears(self):
  entry={'headers':['A','B','C'],'rows_raw':[(1,'=TEXT(A2,"0")','=B2')]}
  meta={'rows':['r'],'formula_compat_ready':True}
  self.assertEqual(f.recalculate_index(entry,meta,{(2,1):2},{},{}),[])
  self.assertTrue(meta['formula_results']['r\0C']['pending'])
  # This C2 previously held a computed 9; dependency becoming pending must
  # clear that stale cache, even though B2 is already safely pending.
  meta['formula_results']['r\0C']={'formula':'=B2','value':9}
  edits=f.recalculate_index(entry,meta,{(2,1):3},{},{})
  self.assertEqual([(c,t['value']) for c,t in edits],[('C2',None)])
  # Explicit restore of a legacy formula remains a real XML write.
  edits=f.recalculate_index(entry,meta,{(2,2):'=TEXT(A2,"0")'},{},{})
  self.assertEqual([c for c,t in edits],['B2'])
  # Supported results are not frozen, even when all imported nodes stay pending.
  edits=f.recalculate_index(entry,meta,{(2,3):'=A2+1'},{},{},strict_coordinates=['C2'])
  self.assertEqual([(c,t['value']) for c,t in edits],[('C2',2)])
 def test_sparse_graph_add_replace_remove_and_inverse(self):
  entry={'headers':['值','算'],'rows_raw':[(5,None),(7,None)]};meta={'rows':['r1','r2']}
  added=f.recalculate_index(entry,meta,{(2,2):'=SUM(A2:A3)'},{},{})
  self.assertEqual(added[0][1]['value'],12)
  entry['rows_raw'][0]=(5,'=SUM(A2:A3)');entry['formula_positions']=[(2,2)]
  replaced=f.recalculate_index(entry,meta,{(2,2):'=A2*3'},{},{})
  self.assertEqual(replaced[0][1]['value'],15)
  removed=f.recalculate_index(entry,meta,{(2,2):9},{},{})
  self.assertEqual(removed,[]);self.assertEqual(meta['formula_results'],{})
  inverse=f.recalculate_index(entry,meta,{(2,2):'=SUM(A2:A3)'},{},{})
  self.assertEqual(inverse[0][1]['value'],12)
 def test_import_invalid_refs_and_new_input_strict_budget(self):
  entry={'headers':['A','B'],'rows_raw':[(1,'=A1'),(2,'=A999')]};m={'rows':['r1','r2']}
  self.assertEqual([v['value'] for _,v in f.recalculate_index(entry,m,{}, {},{})],[None,None])
  with self.assertRaises(f.FormulaError):f.recalculate_index(entry,m,{(2,2):'=A1'}, {},{},strict_coordinates=['B2'])
  with self.assertRaises(f.FormulaError):f.recalculate_index(entry,m,{(2,2):'=TEXT(A2,"0")'}, {},{},strict_coordinates=['B2'])
  many={'headers':['A'],'rows_raw':[('=1',) for _ in range(2001)]};mm={'rows':['r'+str(i) for i in range(2001)]}
  f.recalculate_index(many,mm,{}, {},{});self.assertTrue(mm['formula_results']['r2000\0A']['pending'])
  with self.assertRaises(f.FormulaError):f.recalculate_index(many,mm,{(2,1):'=2'}, {},{},strict_coordinates=['A2'])
  unknown=f.decorate_values({'A':{'type':'formula','formula':'=X2','value':999}},'r',{},1,{'X'})
  self.assertTrue(unknown['A']['hidden']);self.assertNotIn('formula',unknown['A'])
 def test_surgical_verifier_decodes_quoted_formula_and_text(self):
  import ast
  from shangshu_files import zipedit
  source=Path(__file__).resolve().parents[3]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
  tree=ast.parse(source.read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_node_typed');ns={}
  exec(compile(ast.Module([node],type_ignores=[]),str(source),'exec'),ns)
  formula='=TEXT(A2,"0")';raw=zipedit._serialize_value('B2',{'type':'formula','formula':formula,'value':None},'').encode()
  self.assertEqual(ns['_node_typed'](raw)['formula'],formula[1:])
  text='a "quote" & <value>';raw=zipedit._serialize_value('A2',{'type':'text','value':text},'').encode()
  self.assertEqual(ns['_node_typed'](raw)['value'],text)
if __name__=='__main__':unittest.main(verbosity=2)
