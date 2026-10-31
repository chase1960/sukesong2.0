"""UI008 constrained style additions, actual OOXML roundtrip and original-style undo."""
import unittest,zipfile,re,copy,sys
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.styles import Border,Side,Alignment
# 真 app 包进 sys.path —— sheet.py 的 _style_surgery 里有函数级
# `from shangshu_files.style_extra import ...`，包不在路径上就直接 ModuleNotFoundError。
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
install_real_environment()
from test_sheet_font_styles import helpers,fixture,zipedit,harness,Denied,Invalid
import test_sheet_font_styles as font_tests
class ExtendedStyles(unittest.TestCase):
 def setUp(self):self.h=helpers();self.raw=fixture();self.part='xl/worksheets/sheet1.xml'
 def apply(self,patch,coords=None):return self.h['_style_surgery'](self.raw,self.part,coords or ['A2'],patch)
 def test_number_wrap_border_roundtrip_preserves_values_and_other_cells(self):
  saved,changes,index=self.apply({'number_format':'#,##0.00','wrap_text':False,'border':'all'})
  ws=load_workbook(BytesIO(saved)).active
  self.assertEqual(ws['A2'].value,'00123');self.assertEqual(ws['A2'].number_format,'#,##0.00');self.assertFalse(ws['A2'].alignment.wrap_text)
  for side in ('top','bottom','left','right'):
   edge=getattr(ws['A2'].border,side);self.assertEqual(edge.style,'thin');self.assertEqual(edge.color.rgb,'FFD1D5DB')
  a=zipfile.ZipFile(BytesIO(self.raw));b=zipfile.ZipFile(BytesIO(saved))
  self.assertEqual(re.sub(rb'\ss="\d+"',b'',a.read(self.part)),re.sub(rb'\ss="\d+"',b'',b.read(self.part)))
  for block in ('fonts','borders','cellXfs'):
   old=self.h['_style_blocks'](a.read('xl/styles.xml'),block)[1];new=self.h['_style_blocks'](b.read('xl/styles.xml'),block)[1];self.assertEqual(new[:len(old)],old)
  self.assertEqual(changes[0]['after']['number_format'],'#,##0.00');self.assertTrue(changes[0]['before']['wrap_text'])
 def test_date_custom_format_adds_record_and_preserves_existing_custom_format(self):
  saved,changes,_=self.apply({'number_format':'yyyy-mm-dd hh:mm:ss'})
  self.assertEqual(load_workbook(BytesIO(saved)).active['A2'].number_format,'yyyy-mm-dd hh:mm:ss')
  restored=self.h['_style_restore'](saved,self.part,[('A2',changes[0]['before_style_id'])])
  self.assertEqual(load_workbook(BytesIO(restored)).active['A2'].number_format,'00000')
 def test_complex_border_alignment_and_protection_restore_exact_old_xf(self):
  wb=load_workbook(BytesIO(self.raw));cell=wb.active['A2'];cell.border=Border(left=Side(style='double',color='FF112233'),diagonal=Side(style='dashed',color='FF998877'),diagonalUp=True);cell.alignment=Alignment(horizontal='right',textRotation=30,wrap_text=True);buf=BytesIO();wb.save(buf);self.raw=buf.getvalue()
  original=load_workbook(BytesIO(self.raw)).active['A2']
  saved,changes,_=self.apply({'border':'none','wrap_text':False,'number_format':'0%'})
  restored=self.h['_style_restore'](saved,self.part,[('A2',changes[0]['before_style_id'])]);actual=load_workbook(BytesIO(restored)).active['A2']
  self.assertEqual(actual._style,original._style);self.assertEqual(copy.copy(actual.border),copy.copy(original.border));self.assertEqual(copy.copy(actual.alignment),copy.copy(original.alignment))
 def test_non_border_patch_keeps_complex_border_byte_exact(self):
  saved,_,_=self.apply({'wrap_text':False,'number_format':'0.00'})
  a=zipfile.ZipFile(BytesIO(self.raw));b=zipfile.ZipFile(BytesIO(saved));self.assertEqual(self.h['_style_blocks'](a.read('xl/styles.xml'),'borders')[0].group(),self.h['_style_blocks'](b.read('xl/styles.xml'),'borders')[0].group())
 def test_invalid_types_formats_and_arbitrary_xml_rejected_atomically(self):
  for patch in ({'wrap_text':1},{'wrap_text':'true'},{'border':'thin'},{'border':{}},{'number_format':'<evil/>'},{'number_format':'[Red]0'},{'number_format':None}):
   with self.subTest(patch=patch),self.assertRaises(zipedit.SurgeryError):self.apply(patch,['A2','B2'])
 def test_full_read_paths_agree(self):
  wb=load_workbook(BytesIO(self.raw));fast=self.h['_style_index'](self.raw)['views'];normal=self.h['_style_views_from_wb'](wb)
  for a,b in zip(fast,normal):
   for k in ('number_format','wrap_text','border'):self.assertEqual(a[k],b[k])
class ExtendedHandlers(unittest.TestCase):
 setUp=font_tests.Handlers.setUp
 def test_extended_snapshot_and_undo_preserve_exact_original_style(self):
  h,state,doc,p=harness();before=load_workbook(BytesIO(state.content)).active['A2']._style
  p['style']={'number_format':'0.00%','wrap_text':False,'border':'all'}
  r=h['write_style'](p);self.assertEqual(state.writes,1);self.assertEqual(r['cells'][0]['after']['number_format'],'0.00%')
  h['undo_cells']({'table':'table','op_id':'format1'})
  self.assertEqual(load_workbook(BytesIO(state.content)).active['A2']._style,before)
 def test_extended_styles_denied_current_resource_write_zero_mutation(self):
  h,state,doc,p=harness();before=state.content;state.allowed=False;p['style']={'border':'all','wrap_text':True,'number_format':'0.00'}
  with self.assertRaises(Denied):h['write_style'](p)
  self.assertEqual((state.content,state.writes,state.ops),(before,0,[]))
 def test_valid_first_target_invalid_later_target_is_atomic(self):
  h,state,doc,p=harness();before=state.content;p['style']={'border':'all','wrap_text':False};p['cells'].append({'row_id':'missing','header':'编号'})
  with self.assertRaises(Invalid):h['write_style'](p)
  self.assertEqual((state.content,state.writes,state.ops),(before,0,[]))
if __name__=='__main__':unittest.main()
