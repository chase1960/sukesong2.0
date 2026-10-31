"""Real ZIP tail rows, stale dimensions, streaming read and stable metadata IDs."""
import copy,datetime,importlib.util,re,sys,unittest,zipfile
from pathlib import Path
from io import BytesIO
from types import SimpleNamespace
from openpyxl import Workbook,load_workbook
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import load_module_functions,placeholder_module,install_real_environment
# 真 app 包装进 sys.path —— sheet.py 顶层 `from shangshu_files.style_border import ...`
# 要能**真导入**（style_border 是纯函数模块，只 import re）。
# 不再给 'shangshu_files' 造假包：假包会把真子模块挡住。
install_real_environment('shangshu_files')
ROOT=Path(__file__).resolve().parents[2];P=ROOT/'frappe_apps/shangshu_files/shangshu_files';spec=importlib.util.spec_from_file_location('row_zipedit',P/'zipedit.py');z=importlib.util.module_from_spec(spec);spec.loader.exec_module(z);PART='xl/worksheets/sheet1.xml'
def raw():
 # A1 也写上表头：**2026-10-21 起三条读路径过同一道表头闸**（`_assert_table_headers`：
 # 空白／重复表头明确拒绝 —— 空白表头的工作簿**不是业务表**）。
 # 这条夹具原来留着一个空 A1 ⇒ 会被表头闸**先拒掉**，压根走不到「整簿回落／读物理行尾」那一段。
 # 同仓先例：`test_sheet_cold_read.py` 就是为这道闸把夹具表头补成非空唯一值（测的还是同一件事）。
 wb=Workbook();ws=wb.active;ws['A1']='第一列';ws['B1']='第二列';ws['C1']='第三列';ws['A2']=' ';ws['A3']=' ';stream=BytesIO();wb.save(stream);content=stream.getvalue();xml=zipfile.ZipFile(BytesIO(content)).read(PART);xml=re.sub(rb'<dimension ref="[^"]+"',b'<dimension ref="A2:A2"',xml);return z.rebuild_zip(content,{PART:xml})
def helpers():
 names=('_entry_streaming','_entry_streaming_openpyxl','_entry_fast','_raw_numeric_read_values','_dominant_type','value_typed','_literal_text','_ensure_meta_rows','_new_row_ids')
 # 上下文按 sheet.py 顶层真 import 自动配齐 —— 不再手抄（手抄漏过 `time`，2026-10-15 就这么红的）。
 # zipedit 用真模块；frappe 与兄弟模块只在路过处占位（被测函数不依赖它们的行为）。
 # 用公共夹具 load_module_functions：**连被测函数用到的同文件兄弟函数一起抠** ——
 # 手抄的函数名单漏过 `_assert_table_headers`（`_entry_fast` 第一行就调它 ⇒ NameError）。
 return load_module_functions(P/'sheet.py',names,stubs={'zipedit':z,'frappe':placeholder_module('frappe'),'shangshu_files.sheet_search':placeholder_module('shangshu_files.sheet_search'),'shangshu_files.service':placeholder_module('shangshu_files.service'),'shangshu_files.working_file':placeholder_module('shangshu_files.working_file')},overrides={'_style_read_cache':lambda *a:{'style_ids':{},'font_styles':[]}})
class Invalid(Exception):pass
class Tests(unittest.TestCase):
 def test_stream_reads_existing_physical_tail_beyond_stale_declared_dimension(self):
  entry=helpers()['_entry_streaming'](raw(),None);self.assertEqual(entry['headers'],['第一列','第二列','第三列']);self.assertEqual(len(entry['rows_raw']),2);self.assertEqual(entry['rows_raw'][1][0],' ')
 def test_append_expands_dimension_to_all_existing_cells_plus_new_row(self):
  before=raw();out=z.append_rows(before,PART,[(4,[(1,{'type':'text','value':' '})])]);a=zipfile.ZipFile(BytesIO(before));b=zipfile.ZipFile(BytesIO(out));xml=b.read(PART);self.assertIn(b'<dimension ref="A1:C4"',xml);ro=load_workbook(BytesIO(out),read_only=True).active;self.assertEqual(len(list(ro.iter_rows(max_col=3))),4)
  for name in a.namelist():
   if name!=PART:self.assertEqual(a.read(name),b.read(name),name)
  for old in re.findall(rb'<row\b.*?</row>',a.read(PART),re.S):self.assertIn(old,xml)
 def test_reappend_existing_or_duplicate_or_out_of_order_rows_is_rejected(self):
  for rows in [[(3,[(1,{'type':'text','value':'x'})])],[(4,[]),(4,[])],[(5,[]),(4,[])]]:
   with self.assertRaises(z.SurgeryError):z.append_rows(raw(),PART,rows)
 def test_meta_growth_retains_original_ids_and_other_metadata(self):
  h=helpers();stored={'primary_sheet':'S-1','sheet_name':'Sheet','structure_version':4,'rows':['pinned-old-id'],'ss_clean':True,'style_row_floor':1};saved=[];h.update({'_load_meta':lambda d:copy.deepcopy(stored),'_save_meta':lambda d,m:saved.append(m),'frappe':SimpleNamespace(throw=lambda m,e:(_ for _ in ()).throw(e(m)),ValidationError=Invalid)})
  m=h['_ensure_meta_rows'](object(),3,'Sheet');self.assertEqual(m['rows'],['pinned-old-id','r-000002','r-000003']);self.assertTrue(m['ss_clean']);self.assertEqual(m['structure_version'],4)
 def test_new_ids_skip_paste_created_gaps_without_reusing_any_old_identity(self):
  h=helpers();old=['r-000001','r-000003','r-000005'];new=h['_new_row_ids'](old,3);self.assertEqual(new,['r-000004','r-000006','r-000007']);self.assertEqual(len(set(old+new)),6);self.assertEqual(old,['r-000001','r-000003','r-000005'])
 def test_short_read_does_not_shrink_or_replace_persisted_ids(self):
  h=helpers();saved=[];h.update({'_load_meta':lambda d:{'primary_sheet':'S-1','sheet_name':'Sheet','structure_version':4,'rows':['first-stable','second-stable']},'_save_meta':lambda d,m:saved.append(m),'frappe':SimpleNamespace(throw=lambda m,e:(_ for _ in ()).throw(e(m)),ValidationError=Invalid)})
  with self.assertRaises(Invalid):h['_ensure_meta_rows'](object(),1,'Sheet')
  self.assertEqual(saved,[])
if __name__=='__main__':unittest.main()
