"""UI101 production structure handlers: stable field identity, inverse, ACL history."""
import ast, copy, importlib.util, json, sys, types, unittest, zipfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
ROOT=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files'
def module(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
zipedit=module('zipedit');structure=module('sheet_structure');formulas=module('formulas')
def functions(file,names,ns):
 tree=ast.parse((ROOT/file).read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
 assert len(nodes)==len(names);exec(compile(ast.Module(body=nodes,type_ignores=[]),file,'exec'),ns)
class Row(dict):
 def __getattr__(self,key):
  if key.startswith("__"):raise AttributeError(key)
  return self.get(key)
class Rename(unittest.TestCase):
 def setUp(self):
  self.doc=types.SimpleNamespace(name='file',status='Active',sheet_meta_json='',formal_values_json='{"r1":{"amount":12}}',reload=lambda:None,check_permission=lambda _:None)
  self.meta={'rows':['r1'],'primary_sheet':'S-1','sheet_name':'Sheet','structure_version':1,'ss_clean':True,'promotion':{'definition_version':'1','structure_version':1,'columns':[{'header':'金额','field':'amount','promoted':True,'type':'number','rules':{'min':0},'read_roles':['Accountant'],'write_roles':['Accountant']} ]}}
  self.version=1;self.logs=[];self.hidden=set();self.slow=False
  wb=Workbook();ws=wb.active;ws.append(['金额','普通']);ws.append([12,'00123']);ws['A2'].number_format='0.00';ws['A2'].font=Font(bold=True);b=BytesIO();wb.save(b);self.content=b.getvalue()
  def fail(msg,*args):raise ValueError(msg)
  self.frappe=types.SimpleNamespace(ValidationError=ValueError,PermissionError=ValueError,throw=fail,session=types.SimpleNamespace(user='alice'),get_all=self.get_all,get_doc=lambda *args,**kw:self.doc if args[0]=='file' else next(r for r in self.logs if r.name==args[1]),db=types.SimpleNamespace(set_value=lambda dt,name,key,value,**kw:next(r for r in self.logs if r.name==name).__setitem__(key,value)))
  self.ns={'json':json,'frappe':self.frappe,'zipedit':zipedit,'DOCTYPE':'file','OP_DOCTYPE':'op','META_FIELD':'sheet_meta_json','coord_of':lambda c,r:get_column_letter(c)+str(r),
   '_Seg':lambda:types.SimpleNamespace(mark=lambda *a:None,note=lambda *a:None,out=lambda:{}),'_writable':lambda _:self.doc,'_require_structure':lambda _:None,'_content':lambda *a,**k:self.content,'content_revision':lambda _:self.version,
   '_fast_ctx':self.context,'_save_meta':self.save_meta,'_save_current':self.save,'_rekey_parse':lambda *a:None,'_invalidate_parse':lambda *a:None,'_fault':lambda *a:None,'_structure_relation_checks':lambda *a:None,'_record_op':self.record,
   'value_typed':lambda v:{'type':'text','value':v},'_stamp_versions':lambda d:('1',self.meta['structure_version'])}
  functions('sheet.py',['_rename_promoted_header','_bump_structure','_check_versions','_fast_structure','header_rename','_load_meta','read_ops'],self.ns)
  self.sheet=types.SimpleNamespace(**self.ns)
  promo=types.SimpleNamespace(unreadable_headers=lambda _:self.hidden,load_definition=lambda _:copy.deepcopy(self.meta['promotion']))
  relations=types.SimpleNamespace(structure_snapshot=lambda *a,**kw:[],restore_structure_relations=lambda *a:None)
  self.modules=patch.dict(sys.modules,{'frappe':self.frappe,'shangshu_files':types.SimpleNamespace(sheet=self.sheet,promotion=promo),'shangshu_files.table_relations':relations,'shangshu_files.object_projection':types.SimpleNamespace(read_access=lambda _:None,binding_for=lambda _:None,reject_bound_targets=lambda *a:None)})
  self.modules.start();self.addCleanup(lambda:sys.modules.pop('shangshu_files.sheet',None));self.addCleanup(self.modules.stop);self.save_meta(self.doc,self.meta)
 def save_meta(self,doc,meta):self.meta=copy.deepcopy(meta);doc.sheet_meta_json=json.dumps(meta,ensure_ascii=False)
 def save(self,doc,content,**kw):self.content=content;self.version+=1;return self.version
 def get_all(self,dt,**kw):
  if kw.get('pluck'):return [r.name for r in self.logs if r.op_id==kw['filters']['op_id']]
  return copy.deepcopy(self.logs)
 def record(self,doc,action,op,cells,version,context):self.logs.append(Row(name=str(len(self.logs)),op_id=op,action_id=action,cells_json=json.dumps(cells),actor_user='alice',undone=0))
 def context(self,*a,**kw):
  ws=load_workbook(BytesIO(self.content)).active
  return {'meta':copy.deepcopy(self.meta),'entry':{'headers':[c.value for c in ws[1]],'rows_raw':list(ws.iter_rows(min_row=2,values_only=True))},'part':'xl/worksheets/sheet1.xml','sheet_xml':zipedit.read_sheet(self.content,'xl/worksheets/sheet1.xml')}
 def payload(self,**kw):return {'table':'file','expected_content_version':self.version,'expected_structure_version':self.meta['structure_version'],**kw}
 def rename(self,old='金额',new='收入',op='rename'):
  return structure.execute('files.sheet_header_rename',self.payload(from_header=old,to_header=new,op_id=op),{},self.ns['header_rename'])
 def test_fast_rename_keeps_field_values_rows_styles_and_exact_inverse(self):
  before=self.content;original=copy.deepcopy(self.meta['promotion']['columns'][0]);formal=self.doc.formal_values_json
  self.rename();column=self.meta['promotion']['columns'][0]
  self.assertEqual(column,{**original,'header':'收入'});self.assertEqual(self.doc.formal_values_json,formal);self.assertEqual(self.meta['rows'],['r1']);self.assertEqual(self.meta['promotion']['structure_version'],2)
  ws=load_workbook(BytesIO(self.content)).active;self.assertEqual(ws['A1'].value,'收入');self.assertEqual(ws['A2'].value,12);self.assertTrue(ws['A2'].font.bold);self.assertEqual(ws['A2'].number_format,'0.00');self.assertEqual(ws['B2'].value,'00123')
  original_log=self.logs[0].cells_json
  self.rename('收入','净收入','second')
  structure.undo(self.payload(undo_of='second',op_id='undo2'))
  structure.undo(self.payload(undo_of='rename',op_id='undo1'))
  self.assertEqual(self.content,before);self.assertEqual(self.meta['promotion']['columns'][0],original);self.assertEqual(self.meta['promotion']['structure_version'],5);self.assertEqual(self.logs[0].cells_json,original_log);self.assertEqual(self.doc.formal_values_json,formal)
  self.assertEqual(self.meta['promotion_header_fields'],{'金额':['amount'],'收入':['amount'],'净收入':['amount']})
 def test_old_structure_and_changed_definition_cannot_overwrite(self):
  ns={'json':json,'ACCESS_KEY':'access'};functions('promotion.py',['_definition_fingerprint'],ns);before_sha=ns['_definition_fingerprint'](self.meta)
  stale=self.payload(from_header='金额',to_header='旧请求');self.rename();self.assertNotEqual(ns['_definition_fingerprint'](self.meta),before_sha);before=(self.content,self.doc.sheet_meta_json)
  with self.assertRaisesRegex(ValueError,'版本冲突'):self.ns['header_rename'](stale)
  self.assertEqual((self.content,self.doc.sheet_meta_json),before)
  changed=copy.deepcopy(self.meta);changed['promotion']['columns'][0]['read_roles']=[];self.save_meta(self.doc,changed)
  with self.assertRaisesRegex(ValueError,'已有变化'):structure.undo(self.payload(undo_of='rename',op_id='bad'))
  self.assertEqual(self.content,before[0])
 def test_ordinary_append_does_not_promote(self):
  before=copy.deepcopy(self.meta['promotion']);self.ns['_fast_structure'](self.doc,self.content,self.payload(header='新增'),{},self.ns['_Seg'](),'column_append');self.assertEqual(self.meta['promotion'],before)
 def test_history_acl_uses_identity_aliases_and_survives_inverse(self):
  for field in ('amount',None):self.logs.append(Row(name=str(len(self.logs)),cells_json=json.dumps([{'header':'金额','row_id':'r1','before':{'value':'secret'},**({'formal_field':field} if field else {})}]),op_id='old'+str(field),actor_user='alice',undone=0))
  originals=[r.cells_json for r in self.logs];self.rename();self.hidden={'收入'}
  result=self.ns['read_ops'](None,{'table':'file'});self.assertTrue(all(not op['cells'] for op in result['ops']));self.assertEqual([r.cells_json for r in self.logs[:2]],originals)
  self.hidden=set();result=self.ns['read_ops'](None,{'table':'file'});self.assertEqual(len(result['ops'][0]['cells']),1)
  # An operation made under the renamed display name remains protected after inverse.
  structure.undo(self.payload(undo_of='rename',op_id='undo'))
  self.logs.append(Row(name='post',cells_json=json.dumps([{'header':'收入','row_id':'r1','after':{'value':'secret'}}])))
  self.hidden={'金额'};self.assertTrue(all(not op['cells'] for op in self.ns['read_ops'](None,{'table':'file'})['ops'] if op.get('name')!='3'))
 def test_formula_relocation_uses_new_binding_and_formal_value(self):
  wb=Workbook();ws=wb.active;ws.append(['金额','结果']);ws.append([0,'=A2+1']);meta=copy.deepcopy(self.meta)
  formulas.recalculate(ws,meta,{'r1':{'amount':12}},meta['promotion']);previous=copy.deepcopy(meta);ws['A1']='收入';self.ns['_bump_structure'](meta);self.ns['_rename_promoted_header'](meta,'金额','收入');formulas.relocate(ws,meta,previous,{'金额':'收入'});values=formulas.recalculate(ws,meta,{'r1':{'amount':12}},meta['promotion'])
  self.assertEqual(values['B2'],13);self.assertEqual(meta['formula_results']['r1\0结果']['bindings']['A2']['header'],'收入')
 def test_incremental_rename_updates_inbound_relation_without_reserializing_values(self):
  before=self.content
  relation=Row(name='rel',source_table='other',source_header='链接',target_table='file',target_header='金额',revision=1)
  relation.set=lambda key,value:relation.__setitem__(key,value);relation.save=lambda **kw:None
  relation_ns={'frappe':types.SimpleNamespace(get_all=lambda *a,**kw:[Row(name='rel')],get_doc=lambda *a,**kw:relation,throw=self.frappe.throw,ValidationError=ValueError,PermissionError=ValueError),'hashlib':__import__('hashlib'),'DOCTYPE':'relation'}
  self.sheet._headers_of=lambda ws:[cell.value for cell in ws[1]]
  sys.modules['shangshu_files.sheet']=self.sheet
  functions('table_relations.py',['before_save'],relation_ns)
  relations=sys.modules['shangshu_files.table_relations'];relations.has_relations=lambda *_:True;relations.definitions=lambda *_:[];relations.before_save=relation_ns['before_save']
  sys.modules['shangshu_files'].table_relations=relations
  functions('sheet.py',['_structure_relation_checks'],self.ns)
  self.ns['header_rename'](self.payload(from_header='金额',to_header='收入'))
  self.assertEqual(relation.target_header,'收入');self.assertEqual(relation.revision,2)
  self.assertEqual(self.meta['promotion']['columns'][0]['field'],'amount')
  with zipfile.ZipFile(BytesIO(before)) as old,zipfile.ZipFile(BytesIO(self.content)) as new:
   for coord in ['A2','B2']:
    self.assertEqual(zipedit.cell_node(old.read('xl/worksheets/sheet1.xml'),coord),zipedit.cell_node(new.read('xl/worksheets/sheet1.xml'),coord))
 def test_deleted_field_and_reused_display_name_do_not_expose_old_log(self):
  self.rename();self.meta['promotion']['columns']=[{'header':'金额','field':'other','promoted':True}];self.save_meta(self.doc,self.meta)
  self.logs=[Row(name='old',cells_json=json.dumps([{'header':'金额','formal_field':'amount','before':{'value':'secret'}},{'header':'金额','before':{'value':'legacy secret'}}]))]
  self.assertEqual(self.ns['read_ops'](None,{'table':'file'})['ops'][0]['cells'],[])
 def test_value_inverse_resolves_formal_field_without_rewriting_history(self):
  self.rename();original=json.dumps([{'header':'金额','formal_field':'amount','row_id':'r1','before':{'type':'number','value':10},'after':{'type':'number','value':12}}]);self.logs=[Row(name='value',action_id='files.sheet_cell_write',cells_json=original,actor_user='alice',undone=0)];self.doc.status='Active'
  seen=[];promo=sys.modules['shangshu_files'].promotion
  promo.column_by_header=lambda definition,header:seen.append(header) or next((c for c in definition['columns'] if c['header']==header),None)
  class Located(Exception):pass
  def stop(*args,**kwargs):raise Located()
  self.ns.update({'OP_ACTIONS':{'files.sheet_cell_write'},'_fast_ctx':stop})
  functions('sheet.py',['undo_cells'],self.ns)
  with self.assertRaises(Located):self.ns['undo_cells']({'table':'file','op_id':'value'})
  self.assertEqual(seen,['收入']);self.assertEqual(self.logs[0].cells_json,original)
if __name__=='__main__':unittest.main(verbosity=2)
