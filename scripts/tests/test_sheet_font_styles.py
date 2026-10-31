"""Real raw OOXML format helpers and handler boundaries; never resave workbooks for implementation."""
import ast,importlib.util,re,unittest,zipfile,json,copy,os,sys
from unittest.mock import patch
from pathlib import Path
from io import BytesIO
from types import SimpleNamespace
from openpyxl import Workbook,load_workbook
from openpyxl.styles import Font,PatternFill,Border,Side,Alignment
# 真 app 包进 sys.path —— sheet.py 的 _style_surgery 里有函数级
# `from shangshu_files.style_extra import ...`，包不在路径上就直接 ModuleNotFoundError。
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
install_real_environment()
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
spec=importlib.util.spec_from_file_location('zipedit',SOURCE.with_name('zipedit.py'));zipedit=importlib.util.module_from_spec(spec);spec.loader.exec_module(zipedit)
# 边框规则在 style_border.py（纯函数，不依赖 frappe）——
# sheet.py 的 _style_* 函数要用它，夹具得把它一起搬进来，
# 否则跑起来是 NameError: name 'normalize_border' is not defined（判据自己先坏，测不出产品好坏）。
spec_border=importlib.util.spec_from_file_location('style_border',SOURCE.with_name('style_border.py'));style_border=importlib.util.module_from_spec(spec_border);spec_border.loader.exec_module(style_border)
def helpers():
 tree=ast.parse(SOURCE.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and (n.name.startswith('_style_') or n.name in ('write_style','undo_cells','_check_versions'))]
 ctx={'re':re,'zipfile':zipfile,'BytesIO':BytesIO,'zipedit':zipedit,'json':json,'_PARSE_CACHE':{},'get_column_letter':zipedit.num_to_col,'coord_of':lambda c,r:zipedit.num_to_col(c)+str(r),
  'normalize_border':style_border.normalize_border,'build_border_xml':style_border.build_border_xml,'edges_for_cell':style_border.edges_for_cell,'verify_border_after':style_border.verify_border_after}
 exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),ctx);return ctx
def fixture():
 wb=Workbook();ws=wb.active;ws.title='样例';ws.append(['编号','日期','公式']);ws.append(['00123',12345678901234567,'=B2+1']);ws.append(['长编号XYZ',1.25,None]);ws['A2'].font=Font(name='Calibri',size=11,italic=True,color='FF123456');ws['A2'].fill=PatternFill('solid',fgColor='FFFF00');ws['A2'].number_format='00000';ws['A2'].alignment=Alignment(wrap_text=True);ws['A2'].border=Border(bottom=Side(style='thin'));buf=BytesIO();wb.save(buf)
 raw=buf.getvalue();z=zipfile.ZipFile(BytesIO(raw));sheet=z.read('xl/worksheets/sheet1.xml');sheet=re.sub(rb'(<c r="B2"[^>]*><v>)[^<]+',rb'\g<1>12345678901234567',sheet)
 return zipedit.rebuild_zip(raw,{'xl/worksheets/sheet1.xml':sheet})
class Styles(unittest.TestCase):
 def setUp(self):self.h=helpers();self.raw=fixture();self.part='xl/worksheets/sheet1.xml'
 def apply(self,cells=None,style=None):return self.h['_style_surgery'](self.raw,self.part,cells or ['A2'],style or {'bold':True})
 def test_font_change_is_real_and_preserves_other_font_and_xf_properties(self):
  saved,changes,index=self.apply(style={'font_size':18,'font_color':'#aabbcc','bold':True});ws=load_workbook(BytesIO(saved)).active;c=ws['A2'];self.assertEqual((c.font.sz,c.font.color.rgb,c.font.b,c.font.i),(18,'FFAABBCC',True,True));self.assertEqual((c.fill.fgColor.rgb,c.number_format,c.alignment.wrap_text,c.border.bottom.style),('00FFFF00','00000',True,'thin'));self.assertEqual(changes[0]['after']['font_size'],18)
 def test_non_target_parts_and_all_values_formulas_remain_byte_identical(self):
  saved,_,_=self.apply();a=zipfile.ZipFile(BytesIO(self.raw));b=zipfile.ZipFile(BytesIO(saved));self.assertEqual(a.namelist(),b.namelist())
  for name in a.namelist():
   if name not in (self.part,'xl/styles.xml'):self.assertEqual(a.read(name),b.read(name),name)
  strip=lambda xml:re.sub(rb'\ss="\d+"',b'',xml)
  self.assertEqual(strip(a.read(self.part)),strip(b.read(self.part)));self.assertIn(b'12345678901234567',b.read(self.part))
 def test_old_styles_and_namespace_declarations_stay_verbatim(self):
  z=zipfile.ZipFile(BytesIO(self.raw));styles=z.read('xl/styles.xml').replace(b'<styleSheet ',b'<styleSheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="urn:fixture-x14ac" mc:Ignorable="x14ac" ');self.raw=zipedit.rebuild_zip(self.raw,{'xl/styles.xml':styles});saved,_,_=self.apply();new=zipfile.ZipFile(BytesIO(saved)).read('xl/styles.xml')
  for tag in ['fonts','cellXfs']:
   old_match,old_children=self.h['_style_blocks'](styles,tag);_,new_children=self.h['_style_blocks'](new,tag);self.assertEqual(new_children[:len(old_children)],old_children)
  self.assertIn(b'xmlns:x14ac="urn:fixture-x14ac" mc:Ignorable="x14ac"',new)
 def test_formula_can_be_formatted_without_altering_formula_or_cached_value(self):
  saved,_,_=self.apply(['C2'],{'bold':True});a=zipfile.ZipFile(BytesIO(self.raw));b=zipfile.ZipFile(BytesIO(saved));strip=lambda xml:re.sub(rb'\ss="\d+"',b'',xml);self.assertEqual(strip(a.read(self.part)),strip(b.read(self.part)));self.assertEqual(load_workbook(BytesIO(saved)).active['C2'].value,'=B2+1')
 def test_missing_blank_cell_is_added_without_value_and_unrelated_cells_stay(self):
  saved,changes,index=self.apply(['C3'],{'font_size':20});ws=load_workbook(BytesIO(saved)).active;self.assertIsNone(ws['C3'].value);self.assertEqual(ws['C3'].font.sz,20);self.assertEqual(ws['A2'].value,'00123');self.assertEqual(len(changes),1)
 def test_style_only_undo_restores_old_style_and_keeps_later_value_edit(self):
  saved,changes,index=self.apply();value_edit=zipedit.edit_cells(saved,self.part,[('A2',{'type':'text','value':'later-human-value'})]);restored=self.h['_style_restore'](value_edit,self.part,[(changes[0]['coord'],changes[0]['before_style_id'])]);ws=load_workbook(BytesIO(restored)).active;self.assertEqual(ws['A2'].value,'later-human-value');self.assertFalse(ws['A2'].font.b);self.assertTrue(ws['A2'].font.i)
 def test_other_later_format_is_detectably_different_and_cannot_be_undone_by_old_snapshot(self):
  saved,changes,index=self.apply();again,changes2,index2=self.h['_style_surgery'](saved,self.part,['A2'],{'font_color':'#FF0000'});self.assertNotEqual(changes2[0]['after_style_id'],changes[0]['after_style_id']);self.assertEqual(self.h['_style_cell_ids'](zipedit.read_sheet(again,self.part),['A2'])['A2'],changes2[0]['after_style_id'])
 def test_invalid_style_batch_and_duplicate_targets_reject_without_output(self):
  for patch in [{},{'bold':'yes'},{'font_size':float('nan')},{'font_size':0},{'font_color':'red'},{'fill':'#ABCDEF'}]:
   with self.assertRaises((ValueError,zipedit.SurgeryError)):self.h['_style_surgery'](self.raw,self.part,['A2'],patch)
  with self.assertRaises((ValueError,zipedit.SurgeryError)):self.apply(['A2','A2'])
 def test_same_effective_style_is_noop_and_shared_style_is_cloned_not_mutated(self):
  saved,changes,index=self.apply(style={'bold':False});self.assertEqual(saved,self.raw);self.assertEqual(changes,[])
 def test_page_style_projection_defaults_and_style_dictionary(self):
  index=self.h['_style_index'](self.raw);ids=self.h['_style_cell_ids'](zipedit.read_sheet(self.raw,self.part),['A2','B2']);self.assertEqual(index['views'][ids['A2']]['font_color'],'#123456');self.assertEqual(index['views'][ids['A2']]['font_size'],11);self.assertFalse(index['views'][ids['A2']]['bold'])
 def test_indexed_font_color_from_existing_customer_palette_reads_real_rgb(self):
  view=self.h['_style_font_view'](b'<font><sz val="11"/><color indexed="3"/></font>');self.assertEqual(view['font_color'],'#00FF00');self.assertEqual(view['font_color_type'],'indexed')
 def test_read_cache_does_not_require_parsing_or_projecting_all_styles_each_page(self):
  cache=self.h['_style_read_cache'](self.raw,'样例');self.assertEqual(cache['font_styles'][cache['style_ids'][(2,1)]]['font_color'],'#123456');self.assertEqual(len(cache['font_styles']),2)
  reused={(2,1):1};fast=self.h['_style_read_cache'](self.raw,'样例',reused);self.assertIs(fast['style_ids'],reused);self.assertEqual(fast,cache)
 def test_inherited_column_and_explicit_zero_style_are_distinguished(self):
  xml=zipedit.read_sheet(self.raw,self.part).replace(b'<sheetData>',b'<cols><col min="1" max="3" style="1"/></cols><sheetData>').replace(b'<c r="B2" t="n">',b'<c r="B2" s="0" t="n">');raw=zipedit.rebuild_zip(self.raw,{self.part:xml});cache=self.h['_style_read_cache'](raw,'样例');self.assertEqual(cache['column_style_ids'][3],1);self.assertEqual(cache['style_ids'][(2,2)],0);ids=self.h['_style_cell_ids'](xml,['B2','C3']);self.assertEqual(ids,{'B2':0,'C3':1})

class Invalid(Exception):pass
class Denied(Exception):pass
def harness():
 h=helpers();state=SimpleNamespace(content=fixture(),ops=[],writes=0,user='owner',allowed=True,fail_save=False,fail_record=False)
 doc=SimpleNamespace(name='table',status='Active',version_count=2)
 meta={'rows':['r1','r2'],'primary_sheet':'S-1','structure_version':1};entry={'headers':['编号','日期','公式'],'rows_raw':[('00123',12345678901234567,'=B2+1'),('长编号XYZ',1.25,None)],'sheet_title':'样例','readonly':None,**h['_style_read_cache'](state.content,'样例')}
 def throw(message,error):raise error(message)
 def writable(table):
  if not state.allowed:raise Denied('current permission')
  return doc
 def save(doc,content,note):
  if state.fail_save:raise RuntimeError('file write failed')
  state.content=content;state.writes+=1;doc.version_count+=1;return doc.version_count-1
 def record(doc,action,op_id,cells,version,context):
  if state.fail_record:raise RuntimeError('op record failed')
  state.ops.append(SimpleNamespace(name='op'+str(len(state.ops)),action_id=action,op_id=op_id,cells_json=json.dumps(cells),actor_user=state.user,undone=0))
 frappe=SimpleNamespace(ValidationError=Invalid,PermissionError=Denied,throw=throw,session=SimpleNamespace(user='owner'),get_all=lambda *a,**k:[o for o in state.ops if o.op_id==k['filters']['op_id']],db=SimpleNamespace(set_value=lambda *a,**k:None,exists=lambda dt,flt:any(o.op_id==flt['op_id'] for o in state.ops)))
 h.update({'frappe':frappe,'OP_DOCTYPE':'op','OP_ACTIONS':('files.sheet_style_write',),'_writable':writable,'_content':lambda *a,**k:state.content,'readonly_reason':lambda c:None,'_parsed':lambda d,c:(entry,{}),'_ensure_meta_rows':lambda *a,**k:meta,'_save_version':save,'_save_current':save,'content_revision':lambda d:d.version_count-1,'_record_op':record,'_save_meta':lambda *a:None,'_rekey_parse':lambda *a:None,'_invalidate_parse':lambda *a:None})
 payload={'table':'table','op_id':'format1','expected_content_version':1,'expected_structure_version':1,'cells':[{'row_id':'r1','header':'编号'}],'style':{'bold':True}}
 return h,state,doc,payload
class Handlers(unittest.TestCase):
 def setUp(self):
  self.auth_calls=[]
  reasons=next(ast.literal_eval(n.value) for n in ast.parse(SOURCE.with_name("promotion.py").read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="REVALIDATION_REASONS" for t in n.targets))
  modules=patch.dict(sys.modules,{"shangshu_files.promotion":SimpleNamespace(REVALIDATION_REASONS=reasons),"shangshu_files.object_projection":SimpleNamespace(authorize_rows=lambda doc,rows:self.auth_calls.append((doc.name,rows)))})
  modules.start();self.addCleanup(modules.stop)
 def test_source_row_permission_denial_still_precedes_style_write(self):
  h,state,doc,payload=harness()
  def deny(*args):raise Denied('source record revoked')
  sys.modules['shangshu_files.object_projection'].authorize_rows=deny
  with self.assertRaises(Denied):h['write_style'](payload)
  self.assertEqual(state.writes,0);self.assertEqual(state.ops,[])
 def test_registered_style_schema_uses_actual_core_supported_subset(self):
  domain=run_domain();schema=next(a[3] for a in domain['ACTIONS'] if a[0]=='files.sheet_style_write');path=ROOT/'frappe_apps/shangshu_core/shangshu_core/schema_validation.py';tree=ast.parse(path.read_text());nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.Import,ast.ImportFrom)) and not (isinstance(n,ast.Import) and any(x.name=='frappe' for x in n.names))];ctx={'frappe':SimpleNamespace(ValidationError=Invalid,throw=lambda m,e:(_ for _ in ()).throw(e(m)))};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),ctx);_,_,_,payload=harness();ctx['_validate_schema'](payload,schema)
 def test_action_records_server_snapshot_once_and_page_cache_sees_real_style(self):
  h,s,d,p=harness();r=h['write_style'](p);self.assertEqual((r['kind'],r['applied'],r['content_version'],s.writes,len(s.ops)),('style',1,2,1,1));self.assertEqual(r['cells'][0]['before']['font_color'],'#123456');self.assertTrue(h['_style_read_cache'](s.content,'样例')['font_styles'][r['cells'][0]['after_style_id']]['bold'])
 def test_noop_is_zero_writes_and_zero_undo_step(self):
  h,s,d,p=harness();p['style']={'bold':False};r=h['write_style'](p);self.assertEqual((r['applied'],r['cells'],r['content_version'],s.writes,len(s.ops)),(0,[],1,0,0))
 def test_stale_content_or_structure_and_invalid_target_zero_write(self):
  for key,value in [('expected_content_version',0),('expected_structure_version',0),('cells',[{'row_id':'missing','header':'编号'}])]:
   h,s,d,p=harness();p[key]=value
   with self.assertRaises(Invalid):h['write_style'](p)
   self.assertEqual((s.writes,len(s.ops)),(0,0))
 def test_current_write_permission_required(self):
  h,s,d,p=harness();s.allowed=False
  with self.assertRaises(Denied):h['write_style'](p)
  self.assertEqual(s.writes,0)
 def test_file_failure_is_not_reported_as_success_or_recorded(self):
  h,s,d,p=harness();s.fail_save=True
  with self.assertRaisesRegex(RuntimeError,'file write failed'):h['write_style'](p)
  self.assertEqual((s.writes,len(s.ops)),(0,0))
 def test_undo_is_server_side_and_current_owner_only(self):
  h,s,d,p=harness();r=h['write_style'](p);h['frappe'].session.user='someone-else'
  with self.assertRaises(Denied):h['undo_cells']({'table':'table','op_id':'format1','before':{'bold':False}})
  self.assertEqual(s.writes,1)
 def test_undo_preserves_later_value_and_ignores_forged_client_snapshot(self):
  h,s,d,p=harness();r=h['write_style'](p);s.content=zipedit.edit_cells(s.content,'xl/worksheets/sheet1.xml',[('A2',{'type':'text','value':'later-value'})]);r=h['undo_cells']({'table':'table','op_id':'format1','before':{'bold':True}});self.assertEqual((r['kind'],r['applied'],r['content_version']),('style',1,3));ws=load_workbook(BytesIO(s.content)).active;self.assertEqual(ws['A2'].value,'later-value');self.assertFalse(ws['A2'].font.b)
 def test_undo_skips_other_later_format_and_no_new_version_when_all_skipped(self):
  h,s,d,p=harness();h['write_style'](p);s.content,_,_=h['_style_surgery'](s.content,'xl/worksheets/sheet1.xml',['A2'],{'font_size':20});before=s.content;r=h['undo_cells']({'table':'table','op_id':'format1'});self.assertEqual((r['applied'],r['skipped'][0]['reason'],s.writes),(0,'changed',1));self.assertEqual(s.content,before)
 def test_undo_rechecks_current_permission_after_revoke(self):
  h,s,d,p=harness();h['write_style'](p);s.allowed=False
  with self.assertRaises(Denied):h['undo_cells']({'table':'table','op_id':'format1'})
  self.assertEqual(s.writes,1)
def run_domain():
 tree=ast.parse(Path(os.environ.get('_SS_FONT_SCHEMA_FILE') or SOURCE.with_name('domain.py')).read_text());nodes=[]
 for n in tree.body:
  if isinstance(n,ast.ImportFrom) and n.module=='shangshu_files.working_file':continue # service-only dependency, not part of the schema fixture
  if not (isinstance(n,ast.Import) and any(x.name=='frappe' for x in n.names)):nodes.append(n)
  if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ACTIONS' for t in n.targets):break
 ctx={};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE.with_name('domain.py')),'exec'),ctx);return ctx
if __name__=='__main__':unittest.main()
