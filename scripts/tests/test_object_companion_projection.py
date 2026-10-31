"""Execute production projection functions against real workbooks; no source DB replica."""
import ast,copy,datetime,types,unittest,sys
from pathlib import Path
from unittest.mock import patch
from openpyxl import Workbook
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'frappe_apps/shangshu_files/shangshu_files/object_projection.py'
def typed(c):
 if c.value is None:return {'type':'empty','value':None}
 return {'type':'number' if type(c.value) in (int,float) else 'text','value':c.value}
class Projection(unittest.TestCase):
 def setUp(self):
  tree=ast.parse(SOURCE.read_text());self.ns={'copy':copy,'datetime':datetime,'sheet':types.SimpleNamespace(cell_typed=typed)}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='apply_snapshot'],type_ignores=[]),str(SOURCE),'exec'),self.ns)
  self.apply=self.ns['apply_snapshot'];self.wb=Workbook();self.ws=self.wb.active;self.ws.append(['列1']);self.meta={}
  self.binding={'object_id':'orders.order','file_id':'companion','field_columns':[{'field_id':'title','header':'事项','type':'text'},{'field_id':'amount','header':'金额','type':'number'}],'definition_revision':1}
  self.records=[{'name':'ORDER-1','modified':'v1','values':{'title':'原记录','amount':800}},{'name':'ORDER-2','modified':'v2','values':{'title':'另一记录','amount':900}}]
 def test_initial_projects_actual_ids_without_formal_store(self):
  self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.assertEqual(self.meta['rows'],['ORDER-1','ORDER-2']);self.assertEqual(self.ws['B2'].value,800)
  self.assertNotIn('formal_values_json',self.meta);self.assertEqual(self.ws.max_row,3)
 def test_update_preserves_notes_and_format_by_identity(self):
  self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.ws['C1']='备注';self.ws['C2']='不覆盖';self.ws['C3']='另一备注';self.ws['B2'].number_format='#,##0.00'
  update=copy.deepcopy(self.records[0]);update['values']['amount']=1700;update['modified']='v3'
  self.apply(self.ws,self.meta,self.binding,[update])
  self.assertEqual(self.ws['B2'].value,1700);self.assertEqual(self.ws['B3'].value,900)
  self.assertEqual(self.ws['C2'].value,'不覆盖');self.assertEqual(self.ws['C3'].value,'另一备注');self.assertEqual(self.ws['B2'].number_format,'#,##0.00')
  self.assertEqual(self.meta['rows'],['ORDER-1','ORDER-2'])
 def test_new_source_record_appends_without_reusing_old_row(self):
  self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.apply(self.ws,self.meta,self.binding,[{'name':'ORDER-3','modified':'v1','values':{'title':'新原记录','amount':5}}])
  self.assertEqual(self.meta['rows'],['ORDER-1','ORDER-2','ORDER-3']);self.assertEqual(self.ws['A4'].value,'新原记录')
 def test_literal_formula_like_source_never_executed(self):
  self.records[0]['values']['title']='=WEBSERVICE("x")';self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.assertEqual(self.ws['A2'].data_type,'s')
 def test_nonempty_file_not_guessed_and_duplicate_identity_rejected(self):
  self.ws['A2']='已有备注'
  with self.assertRaises(ValueError):self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.ws['A2']=None
  with self.assertRaises(ValueError):self.apply(self.ws,self.meta,self.binding,self.records*2,True)
class Guard(unittest.TestCase):
 def setUp(self):
  Projection.setUp(self);self.apply(self.ws,self.meta,self.binding,self.records,True)
  self.ws['C1']='备注';self.ws['C2']='旧';self.old=copy.deepcopy(self.wb);self.oldmeta=copy.deepcopy(self.meta);self.calls=[]
  def throw(msg,exc):raise exc(msg)
  class Denied(Exception):pass
  class Invalid(Exception):pass
  self.denied=Denied;self.invalid=Invalid
  def auth(file,rows,fields,operation):
   self.calls.append((rows,operation))
   if 'ORDER-2' in rows:raise Denied('record unavailable')
  self.module=types.SimpleNamespace(authorize_companion_cells=auth)
  self.ns.update({'frappe':types.SimpleNamespace(throw=throw,PermissionError=Denied,ValidationError=Invalid),
   'system_projection_allows':lambda doc:False,'binding_for':lambda doc:self.binding,
   'sheet':types.SimpleNamespace(_load_meta=lambda doc:self.oldmeta,safe_open=lambda *a,**k:self.old,
      _content=lambda *a,**k:b'',cell_typed=typed,_typed_equal=lambda a,b:a==b)})
  tree=ast.parse(SOURCE.read_text());exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='before_save'],type_ignores=[]),str(SOURCE),'exec'),self.ns)
  self.doc=types.SimpleNamespace(name='companion')
 def guard(self):
  with patch.dict(sys.modules,{'shangshu_core.public_api':self.module}):self.ns['before_save'](self.doc,self.ws,self.meta)
 def test_ordinary_edit_reads_source_and_preserves_bound(self):
  self.ws['C2']='新';self.guard();self.assertIn((['ORDER-1'],'write'),self.calls)
 def test_direct_source_value_rejected(self):
  self.ws['B2']=999
  with self.assertRaises(self.denied):self.guard()
 def test_unreadable_record_ordinary_edit_rejected(self):
  self.ws['C3']='越权'
  with self.assertRaises(self.denied):self.guard()
 def test_new_file_row_not_new_source_record(self):
  self.meta['rows'].append('invented')
  with self.assertRaises(self.invalid):self.guard()
 def test_fast_cells_check_targets_without_opening_workbook(self):
  tree=ast.parse(SOURCE.read_text());exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='authorize_ordinary_cells'],type_ignores=[]),str(SOURCE),'exec'),self.ns)
  with patch.dict(sys.modules,{'shangshu_core.public_api':self.module}):
   self.ns['authorize_ordinary_cells'](self.doc,[{'row_id':'ORDER-1','header':'备注'}])
   self.assertEqual(self.calls,[(['ORDER-1'],'write')])
   with self.assertRaises(self.denied):self.ns['authorize_ordinary_cells'](self.doc,[{'row_id':'ORDER-1','header':'金额'}])
   with self.assertRaises(self.denied):self.ns['authorize_ordinary_cells'](self.doc,[{'row_id':'ORDER-2','header':'备注'}])
 def test_new_column_does_not_create_source_field(self):
  self.ws['D1']='新普通列';self.guard();self.assertIn(([],'structure'),self.calls)
  self.assertEqual(len(self.binding['field_columns']),2)
class MixedProvider(unittest.TestCase):
 def setUp(self):
  from test_incremental_daily_write import DailyEntries
  self.harness=DailyEntries('test_plain_single_and_mixed_batch_only_zip');self.harness.setUp()
  self.addCleanup(self.harness.doCleanups)
  h=self.harness;self.doc=h.doc;self.doc.formal_values_json='{}';self.doc.check_permission=lambda _:None
  self.binding={'object_id':'orders','file_id':self.doc.name,'field_columns':[{'field_id':'amount','header':'金额'}]}
  h.meta['object_companion']=copy.deepcopy(self.binding)
  h.meta['companion_source_versions']={'r-000001':'v1','r-000002':'v2'}
  h.frappe.get_doc=lambda dt,name,**kw:next(log for log in h.logs if log.name==name) if dt==h.h['OP_DOCTYPE'] else self.doc
  h.frappe.db.exists=lambda doctype,where:any(log.op_id==where.get('op_id') for log in h.logs)
  h.frappe.db.get_value=lambda doctype,where,field:next((log.name for log in h.logs if log.op_id==where.get('op_id')),None)
  h.frappe.db.set_value=lambda dt,name,field,value,**kw:setattr(next(log for log in h.logs if log.name==name),field,value)
  self.events={'kind':'mixed','op_id':'op','expected_content_version':1,'expected_structure_version':1,
   'ordinary_cells':[{'row_id':'r-000001','header':'备注','value':{'type':'text','value':'新'}}],
   'source_targets':[{'row_id':'r-000001','header':'金额'}],
   'source_values':[{'row_id':'r-000001','header':'金额','before':800,'after':1000}]}
  self.records=[{'name':'r-000001','modified':'after-write','values':{'amount':1000}}]
  self.ns={'copy':copy,'json':__import__('json'),'frappe':h.frappe,'sheet':types.SimpleNamespace(**h.h),
   '_scope':lambda _:None,'authorize_rows':lambda *a:None}
  tree=ast.parse(SOURCE.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('project','_project_existing_values','get_operation')]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),self.ns)
 def project(self):
  with patch.dict(sys.modules,{'shangshu_files.service':types.SimpleNamespace(_can_write=lambda d:True)}):
   return self.ns['project'](self.binding,self.records,self.events)
 def test_source_and_ordinary_saved_once_with_real_inverse_snapshots(self):
  h=self.harness;result=self.project();self.assertEqual(len(h.saves),1);self.assertEqual(len(h.logs),1)
  self.assertEqual((h.sheet()['B2'].value,h.sheet()['C2'].value),(1000,'新'))
  self.assertEqual(h.sheet()['B2'].number_format,'#,##0.00')
  self.assertEqual(h.sheet()['C3'].value,'other')
  changes={c['header']:c for c in result['cells']}
  self.assertEqual(changes['金额']['before']['value'],800);self.assertEqual(changes['备注']['before']['value'],'old')
  self.assertTrue(changes['金额']['input_target']);self.assertEqual(changes['金额']['source_modified'],'after-write')
  self.assertEqual((changes['金额']['source_raw_before'],changes['金额']['source_raw_after']),(800,1000))
  self.assertEqual(h.logs[0].action_id,'platform.object.companion_write')
 def test_invalid_ordinary_never_saves_projected_source(self):
  self.events['ordinary_cells'][0]['value']={'type':'invalid'}
  with self.assertRaises(ValueError):self.project()
  self.assertEqual(self.harness.saves,[]);self.assertEqual(self.harness.logs,[])
 def test_bound_field_cannot_sneak_through_ordinary_cells(self):
  self.events['ordinary_cells'][0]['header']='金额'
  with self.assertRaises(PermissionError):self.project()
  self.assertEqual(self.harness.saves,[])
 def test_noop_keeps_all_input_audit_and_versions_without_rewriting_xlsx(self):
  h=self.harness;before=h.content
  self.records[0]['values']['amount']=800
  self.events['source_values'][0]['after']=800
  self.events['ordinary_cells'][0]['value']['value']='old'
  result=self.project()
  self.assertEqual(h.content,before);self.assertEqual(h.saves,[]);self.assertEqual(len(h.logs),1)
  self.assertEqual(len(result['cells']),2)
  self.assertEqual(h.meta['companion_source_versions']['r-000001'],'after-write')
  with self.assertRaises(ValueError):self.project()
  self.assertEqual(len(h.logs),1)
 def test_unchanged_source_target_survives_changed_ordinary_audit(self):
  self.records[0]['values']['amount']=800;self.events['source_values'][0]['after']=800
  result=self.project();self.assertEqual(len(self.harness.saves),1)
  self.assertEqual(len(result['cells']),2)
  source=next(c for c in result['cells'] if c['header']=='金额')
  self.assertEqual(source['before'],source['after']);self.assertTrue(source['input_target'])
  self.assertEqual(source['source_raw_before'],800)
 def test_mixed_undo_restores_values_preserves_other_row_and_marks_original(self):
  h=self.harness;self.project()
  self.events.update(kind='mixed_undo',op_id='undo',undo_of='op',expected_content_version=h.doc.revision)
  self.events['ordinary_cells'][0]['value']['value']='old'
  self.events['source_values'][0].update(before=1000,after=800)
  self.records[0].update(modified='after-undo',values={'amount':800})
  self.project()
  self.assertEqual((h.sheet()['B2'].value,h.sheet()['C2'].value),(800,'old'))
  self.assertEqual(h.sheet()['C3'].value,'other');self.assertEqual(h.logs[0].undone,1)
  self.assertEqual(h.logs[1].action_id,'platform.object.companion_undo')
 def test_stale_workbook_version_is_zero_write(self):
  self.events['expected_content_version']=0
  with self.assertRaises(ValueError):self.project()
  self.assertEqual(self.harness.saves,[]);self.assertEqual(self.harness.logs,[])
 def test_undo_checks_only_targets_and_rejects_their_later_overwrite(self):
  h=self.harness;self.project()
  h.h['write_cell'](h.payload(row_id='r-000002',header='备注',value={'type':'text','value':'someone else'}))
  with patch.dict(sys.modules,{'shangshu_files.service':types.SimpleNamespace(_can_write=lambda d:True)}):
   snapshot=self.ns['get_operation'](self.binding,'op')
   self.assertEqual(len(snapshot['cells']),2)
   h.h['write_cell'](h.payload(row_id='r-000001',header='备注',value={'type':'text','value':'newer'}))
   before=h.content
   with self.assertRaises(ValueError):self.ns['get_operation'](self.binding,'op')
  self.assertEqual(h.content,before)
  self.assertEqual(h.sheet()['C3'].value,'someone else')

 def test_failure_before_save_is_zero_file_and_audit_write(self):
  def fail(point):
   if point=='companion-before-save':raise RuntimeError('injected')
  self.ns['sheet']._fault=fail
  before=self.harness.content
  with self.assertRaises(RuntimeError):self.project()
  self.assertEqual(self.harness.content,before);self.assertEqual(self.harness.logs,[])

class DownloadIntersection(unittest.TestCase):
 setUp=Guard.setUp
 def test_download_calls_source_export_not_read_and_requires_downloadable_fields(self):
  tree=ast.parse(SOURCE.read_text());exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='require_download'],type_ignores=[]),str(SOURCE),'exec'),self.ns)
  calls=[]
  def auth(file,rows,fields,operation):
   calls.append(operation)
   return {'allowed_record_ids':rows,'readable_field_ids':fields}
  self.module.authorize_companion_cells=auth
  with patch.dict(sys.modules,{'shangshu_core.public_api':self.module}):
   with self.assertRaises(self.denied):self.ns['require_download'](self.doc)
  self.assertEqual(calls,['download'])

if __name__=='__main__':unittest.main(verbosity=2)
