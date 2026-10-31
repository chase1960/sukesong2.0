"""Actual companion coordinator with controlled source/file boundaries (no database claims)."""
import ast,copy,importlib.util,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager
from contextvars import ContextVar
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import load_module_functions
from _f_business_access_stub import make_business_access_stub as _business_access_stub
ROOT=Path(__file__).resolve().parents[2]
ACTIONS_PY=ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py'
class Invalid(Exception):pass
class Denied(Exception):pass
class Doc(dict):
 def __getattr__(self,k):return self.get(k)
@contextmanager
def domain(*args):yield
class Tests(unittest.TestCase):
 def setUp(self):
  self.calls=[];self.projects=[];self.fail_row=None;self.hidden=False
  self.managed=True;self.reads=[];self.source_reads=[];self.doc_reads=[];self.order=[];self.batch_result=None
  self.rows={n:Doc(name=n,modified='m0',title='old',calculated='derived-old',doctype='Source') for n in ('a','b')}
  self.binding=Doc(name='bind',object_id='obj',file_id='file')
  columns=[{'field_id':'title','header':'Title','type':'text'},{'field_id':'calculated','header':'Calculated','type':'text'}]
  public={'object_id':'obj','file_id':'file','definition_revision':'def','field_columns':columns}
  self.flags=SimpleNamespace(shangshu_action_pin={'action_id':'platform.object.companion_write'})
  def throw(msg,exc):raise exc(msg)
  def get_doc(kind,name,**kw):
   self.doc_reads.append((kind,name,kw));self.order.append(('doc',kind,name))
   return self.binding if kind=='Binding' else self.rows[name]
  def get_values(kind,filters,fieldname,**kw):
   self.source_reads.append((kind,copy.deepcopy(filters),list(fieldname),kw));self.order.append(('source',list(filters['name'][1])))
   return [Doc({field:self.rows[n].get(field) for field in fieldname}) for n in sorted(filters['name'][1]) if n in self.rows]
  fr=SimpleNamespace(flags=self.flags,local=SimpleNamespace(),throw=throw,ValidationError=Invalid,PermissionError=Denied,DoesNotExistError=KeyError,
       get_doc=get_doc,db=SimpleNamespace(get_values=get_values))
  self.fr=fr
  sys.modules['frappe']=fr
  def auth(file,names,fields,operation='read'):
   return {'allowed_record_ids':names,'readable_field_ids':[] if self.hidden else ['title']}
  def project(binding,records,event):
   self.projects.append((copy.deepcopy(records),copy.deepcopy(event)))
   return {'cells':[{'row_id':'a','header':'Title','after':{'type':'text','value':'new'}},{'row_id':'foreign','header':'Title','after':{'type':'text','value':'secret'}}],
           'row_ids':['a','b','foreign'],'source_versions':{n:'m1' for n in ['a','b','foreign']},'content_version':2}
  source_spec={'source_doctype':'Source','fields':[{'id':'title'},{'id':'calculated'}],'columns':{'title':'title','calculated':'calculated'}}
  self.source_spec=source_spec
  comps=SimpleNamespace(DOCTYPE='Binding',_find=lambda *a:self.binding,_current=lambda *a:{**source_spec,'source_kind':'managed' if self.managed else 'native'},
    _public=lambda d:public,authorize_companion_cells=auth,_project=project,
    _snapshot=lambda d,s:{'name':d.name,'modified':d.modified,'values':{field['id']:d.get(s['columns'][field['id']]) for field in s['fields']}})
  self.comps=comps
  def get_records(obj,names,*,fields=None):
   self.reads.append((obj,list(names),fields))
   return {n:{'name':n,'modified':self.rows[n].modified,**{f:self.rows[n][source_spec['columns'][f]] for f in fields}} for n in names}
  self.records=SimpleNamespace(is_managed=lambda o:self.managed,get_records=get_records)
  sys.modules['shangshu_core']=SimpleNamespace(request_cache=SimpleNamespace(get=lambda _k, _loader: _loader(), clear=lambda *a: None),object_companions=comps,native_objects=SimpleNamespace(declared=lambda o:(None,None,None,{'update_action':'native.update'},None)),model_records=self.records,business_access=_business_access_stub())
  # Load the real package collector as well as the real executor; only the
  # source/file persistence boundaries above are substituted by this fixture.
  package_path=ROOT/'frappe_apps/shangshu_core/shangshu_core/action_packages.py'
  package_spec=importlib.util.spec_from_file_location('shangshu_core.action_packages',package_path)
  package_module=importlib.util.module_from_spec(package_spec);package_spec.loader.exec_module(package_module)
  sys.modules['shangshu_core.action_packages']=package_module
  sys.modules['shangshu_core'].action_packages=package_module
  guard_spec=importlib.util.spec_from_file_location('shangshu_core.transaction_failure',package_path.with_name('transaction_failure.py'))
  guard_module=importlib.util.module_from_spec(guard_spec);guard_spec.loader.exec_module(guard_module)
  sys.modules['shangshu_core.transaction_failure']=guard_module
  zone_spec=importlib.util.spec_from_file_location('shangshu_core.write_zones',package_path.with_name('write_zones.py'))
  zone_module=importlib.util.module_from_spec(zone_spec);zone_spec.loader.exec_module(zone_module)
  sys.modules['shangshu_core.write_zones']=zone_module
  sys.modules['shangshu_core'].write_zones=zone_module
  sys.modules['shangshu_core.domain_execution']=SimpleNamespace(domain_execution=domain)
  sys.modules['shangshu_core.objects']=SimpleNamespace(get_object_definition=lambda o:{'revision':1},get_object_record=lambda o,n:{'record':dict(self.rows[n])})
  def execute(action,payload,**kw):
   self.calls.append((action,copy.deepcopy(payload),kw))
   assert self.flags.shangshu_atomic_action_parent=='parent'
   items=payload['records'] if action=='platform.object.update_many' else [payload]
   for item in items:
    if item['name']==self.fail_row:raise Invalid('original rule failed')
    self.rows[item['name']].update({source_spec['columns'][f]:v for f,v in item['values'].items()},modified='m1')
    self.rows[item['name']][source_spec['columns']['calculated']]='derived-'+str(item['values'].get('title'))
   result={'object_id':payload['object_id'],'revision':payload['expected_revision'],'written':len(items),'records':[i['name'] for i in items],'record_version_checked':True}
   return {'result':self.batch_result if self.batch_result is not None else result}
  sys.modules['shangshu_core.actions']=SimpleNamespace(execute_registered_action=execute,_definition=lambda a:SimpleNamespace(effect='write'))
  path=ROOT/'frappe_apps/shangshu_core/shangshu_core/companion_writes.py'
  spec=importlib.util.spec_from_file_location('companion_write_actual',path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.payload={'object_id':'obj','file_id':'file','definition_revision':'def','expected_revision':1,'expected_content_version':1,'expected_structure_version':1,'op_id':'op',
   'expected_modified':{'a':'m0','b':'m0'},'cells':[{'row_id':'a','header':'Title','value':{'type':'text','value':'new'}},{'row_id':'b','header':'Title','value':{'type':'text','value':'new2'}},{'row_id':'a','header':'Note','value':{'type':'text','value':'note'}}]}
  self.context={'confirmed':True,'idempotency_key':'parent','source':'user'}
 def runwrite(self):return self.m.write('platform.object.companion_write',self.payload,self.context)
 def test_managed_batch_uses_target_fields_one_action_and_complete_single_projection(self):
  out=self.runwrite();self.assertEqual(len(self.calls),1);self.assertEqual(len(self.projects),1)
  self.assertEqual(self.calls[0][0],'platform.object.update_many')
  self.assertEqual(self.reads,[('obj',['a','b'],['title'])])
  self.assertEqual(self.calls[0][1]['records'],[
   {'name':'a','values':{'title':'new'},'expected_modified':'m0','idempotency_key':self.row_key('a')},
   {'name':'b','values':{'title':'new2'},'expected_modified':'m0','idempotency_key':self.row_key('b')}])
  self.assertEqual([(kind,name) for kind,name,_ in self.doc_reads],[('Binding','bind')])
  self.assertEqual([r[2] for r in self.source_reads],[['name','modified'],['name','modified','title','calculated']])
  self.assertTrue(all(r[3]=={'as_dict':True,'order_by':'name asc','for_update':True} for r in self.source_reads))
  self.assertEqual(self.order[:2],[('source',['a','b']),('doc','Binding','bind')])
  self.assertEqual(self.projects[0][0][0]['values'],{'title':'new','calculated':'derived-new'})
  self.assertEqual(self.projects[0][1]['source_values'],[
   {'row_id':'a','header':'Title','before':'old','after':'new'},
   {'row_id':'b','header':'Title','before':'old','after':'new2'}])
  self.assertEqual(self.projects[0][1]['ordinary_cells'][0]['header'],'Note')
  self.assertEqual(len(self.projects[0][1]['source_targets']),2)
  self.assertEqual(out['row_ids'],['a','b']);self.assertNotIn('foreign',str(out));self.assertIsNone(self.flags.shangshu_atomic_action_parent)
 def row_key(self,name):
  import hashlib
  return 'companion-row-'+hashlib.sha256(('parent\0'+name).encode()).hexdigest()
 def test_native_keeps_declared_row_actions_and_document_snapshots(self):
  self.managed=False;self.runwrite()
  self.assertEqual([c[0] for c in self.calls],['platform.object.update']*2)
  self.assertEqual([c[2]['idempotency_key'] for c in self.calls],[self.row_key('a'),self.row_key('b')])
  self.assertEqual(self.reads,[]);self.assertEqual(self.source_reads,[])
  self.assertEqual([(k,n) for k,n,_ in self.doc_reads],[('Source','a'),('Source','b'),('Binding','bind'),('Source','a'),('Source','b')])
  self.assertEqual(len(self.projects),1)
 def test_managed_snapshot_uses_registered_physical_columns_but_event_keeps_field_ids(self):
  self.source_spec['columns'].update(title='f_title',calculated='f_calculated')
  for row in self.rows.values():
   row['f_title']=row.pop('title');row['f_calculated']=row.pop('calculated')
  self.runwrite()
  self.assertEqual(self.reads,[('obj',['a','b'],['title'])])
  self.assertEqual(self.source_reads[-1][2],['name','modified','f_title','f_calculated'])
  self.assertEqual(self.projects[0][0][0]['values'],{'title':'new','calculated':'derived-new'})
  self.assertEqual(self.projects[0][1]['source_values'][0],{'row_id':'a','header':'Title','before':'old','after':'new'})
 def test_managed_ordinary_only_and_no_change_source_skip_write_but_keep_projection(self):
  self.payload['cells']=[{'row_id':'a','header':'Note','value':{'type':'text','value':'note'}}]
  self.runwrite();self.assertEqual(self.calls,[]);self.assertEqual(self.reads,[('obj',['a'],[])])
  self.assertEqual(len(self.projects),1);self.assertEqual(self.projects[0][0][0]['values']['calculated'],'derived-old')
  self.projects.clear();self.payload['cells'][0]={'row_id':'a','header':'Title','value':{'type':'text','value':'old'}}
  self.runwrite();self.assertEqual(self.calls,[]);self.assertEqual(len(self.projects[0][1]['source_values']),1)
 def test_managed_rejects_unknown_or_partial_batch_receipt_without_projection_or_fallback(self):
  for invalid in ({},{'object_id':'obj','revision':1,'written':0,'records':[],'record_version_checked':True},
    {'object_id':'obj','revision':1,'written':2,'records':['a','foreign'],'record_version_checked':True},
    {'object_id':'obj','revision':1,'written':2,'records':['a','b'],'record_version_checked':False}):
   with self.subTest(result=invalid):
    self.setUp();self.batch_result=invalid
    with self.assertRaisesRegex(Invalid,'回执'):self.runwrite()
    self.assertEqual([c[0] for c in self.calls],['platform.object.update_many']);self.assertEqual(self.projects,[])
 def test_managed_read_error_or_missing_identity_stops_before_any_write(self):
  for exc in (Denied('hidden field'),Invalid('recycled row'),KeyError('missing row')):
   with self.subTest(error=exc):
    self.setUp()
    self.records.get_records=lambda *a,**kw:(_ for _ in ()).throw(exc)
    with self.assertRaises(type(exc)):self.runwrite()
    self.assertEqual(self.calls,[]);self.assertEqual(self.projects,[])
 def test_managed_public_before_version_must_match_locked_source(self):
  self.records.get_records=lambda *a,**kw:{n:{'name':n,'modified':'older','title':'stale'} for n in ('a','b')}
  with self.assertRaisesRegex(Invalid,'原记录已修改'):self.runwrite()
  self.assertEqual(self.calls,[]);self.assertEqual(self.projects,[])
 def test_many_managed_rows_are_locked_and_snapshotted_in_bounded_sorted_batches(self):
  names=['row-%04d'%i for i in range(1001)]
  self.rows={n:Doc(name=n,modified='m0',title='old',calculated='derived-old',doctype='Source') for n in names}
  self.payload['expected_modified']={n:'m0' for n in names}
  self.payload['cells']=[{'row_id':n,'header':'Title','value':{'type':'text','value':'new'}} for n in reversed(names)]
  self.runwrite()
  self.assertEqual(len(self.calls),1);self.assertEqual(len(self.calls[0][1]['records']),1001)
  self.assertEqual([len(r[1]['name'][1]) for r in self.source_reads],[500,500,1,500,500,1])
  self.assertEqual([n for r in self.source_reads[:3] for n in r[1]['name'][1]],names)
  self.assertEqual(self.order[3],('doc','Binding','bind'))
  self.assertEqual(len(self.projects),1);self.assertEqual(len(self.projects[0][0]),1001)
 def test_native_external_action_remains_rejected_before_write(self):
  self.managed=False;sys.modules['shangshu_core.actions']._definition=lambda a:SimpleNamespace(effect='external/write')
  with self.assertRaisesRegex(Invalid,'外部副作用'):self.runwrite()
  self.assertEqual(self.calls,[]);self.assertEqual(self.projects,[])
 def test_projection_failure_restores_outer_flags_and_propagates(self):
  outer={'object_id':'outer','file_id':'other'}
  self.flags.shangshu_atomic_action_parent='outer';self.flags.shangshu_companion_deferred=outer
  self.comps._project=lambda *a:(_ for _ in ()).throw(Invalid('projection failed'))
  with self.assertRaisesRegex(Invalid,'projection failed'):self.runwrite()
  self.assertEqual(len(self.calls),1);self.assertEqual(self.flags.shangshu_atomic_action_parent,'outer')
  self.assertIs(self.flags.shangshu_companion_deferred,outer)
 def test_undo_refuses_overwritten_source_or_changed_locked_operation(self):
  op={'cells':[{'row_id':'a','header':'Title','before':{'type':'text','value':'before'},'after':{'type':'text','value':'overwritten'}}],'source_versions':{'a':'m0'}}
  self.m._operation=lambda *a,**kw:copy.deepcopy(op);self.payload['undo_of']='original'
  with self.assertRaisesRegex(Invalid,'其他操作更改'):self.m.write('platform.object.companion_undo',self.payload,self.context)
  self.assertEqual(self.calls,[])
  self.m._operation=lambda *a,**kw:copy.deepcopy(op) if not kw.get('lock') else {**op,'source_versions':{'a':'new'}}
  with self.assertRaisesRegex(Invalid,'撤回快照已变化'):self.m.write('platform.object.companion_undo',self.payload,self.context)
  self.assertEqual(self.calls,[]);self.assertEqual(self.projects,[])
 def test_original_failure_propagates_without_file_save(self):
  self.fail_row='b'
  with self.assertRaises(Invalid):self.runwrite()
  self.assertEqual(self.projects,[]);self.assertIsNone(self.flags.shangshu_companion_deferred)
 def test_stale_display_rejected_before_any_original_write(self):
  self.rows['b']['modified']='later'
  with self.assertRaises(Invalid):self.runwrite()
  self.assertEqual(self.calls,[])
 def test_duplicate_or_formula_business_target_rejected(self):
  self.payload['cells'].append(copy.deepcopy(self.payload['cells'][0]))
  with self.assertRaises(Invalid):self.runwrite()
  self.payload['cells'].pop();self.payload['cells'][0]['value']={'type':'formula','formula':'=1+1'}
  with self.assertRaises(Invalid):self.runwrite()
  self.assertEqual(self.calls,[])
 def test_undo_uses_stored_before_and_locks_recheck(self):
  op={'cells':[{'row_id':'a','header':'Title','before':{'type':'text','value':'before'},'after':{'type':'text','value':'old'}}],'source_versions':{'a':'m0'}}
  locks=[];self.m._operation=lambda b,o,**kw:locks.append(kw.get('lock',False)) or copy.deepcopy(op)
  self.payload.update(undo_of='original');self.m.write('platform.object.companion_undo',self.payload,self.context)
  self.assertEqual(locks,[False,True]);self.assertEqual(self.calls[0][1]['records'][0]['values'],{'title':'before'})
  self.assertEqual(self.projects[0][1]['kind'],'mixed_undo')
 def test_output_derived_field_hidden_when_current_acl_changed(self):
  self.hidden=True;out=self.runwrite();self.assertEqual(out['cells'],[])
 def test_schema_requires_display_versions_and_undo_source(self):
  self.assertIn('expected_modified',self.m.input_schema()['required'])
  self.assertIn('undo_of',self.m.input_schema(True)['required'])
 def test_undo_does_not_confuse_zero_false_and_empty(self):
  from decimal import Decimal
  self.assertTrue(self.m._source_equal(0,Decimal('0'),{'type':'decimal'}))
  for value in (None,'',False):
   self.assertFalse(self.m._source_equal(0,value,{'type':'decimal'}))
  self.assertFalse(self.m._source_equal(None,'',{'type':'text'}))
  self.assertFalse(self.m._source_equal(False,'',{'type':'boolean'}))
 def test_undo_preserves_persisted_raw_source_value(self):
  op={'cells':[{'row_id':'a','header':'Title','before':{'type':'empty','value':None},'after':{'type':'text','value':'old'},'source_raw_before':None,'source_raw_after':'old'}],'source_versions':{'a':'m0'}}
  self.m._operation=lambda *a,**kw:copy.deepcopy(op)
  self.payload['undo_of']='original';self.m.write('platform.object.companion_undo',self.payload,self.context)
  self.assertIsNone(self.calls[0][1]['records'][0]['values']['title'])
 def test_domain_dispatch_and_migration_registration_match_real_handlers(self):
  base=ROOT/'frappe_apps/shangshu_core/shangshu_core'
  tree=ast.parse((base/'domain.py').read_text())
  contribution=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='get_contribution')
  definition=next(n.value for n in contribution.body if isinstance(n,ast.Return))
  # Tools repeat action IDs without handlers; inspect only the real action registry.
  actions=ast.literal_eval(next(value for key,value in zip(definition.keys,definition.values)
                               if isinstance(key,ast.Constant) and key.value=='actions'))
  self.assertEqual(len(actions),len({entry['id'] for entry in actions}))
  entries={entry['id']:entry for entry in actions if entry['id'].startswith('platform.object.companion_')}
  self.assertEqual(entries['platform.object.companion_write']['handler'],'shangshu_core.companion_writes.write')
  self.assertEqual(entries['platform.object.companion_undo']['handler'],'shangshu_core.companion_writes.write')
  self.assertEqual(entries['platform.object.companion_bind']['handler'],'shangshu_core.object_companions.bind_action')
  # Execute the actual migration loop against a registration collector, not a grep.
  tree=ast.parse((base/'install.py').read_text());loops=[n for n in ast.walk(tree) if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='undo']
  calls=[];env={'register_action':lambda *a:calls.append(a),'companion_schema':self.m.input_schema}
  exec(compile(ast.Module(body=loops,type_ignores=[]),str(base/'install.py'),'exec'),env)
  self.assertEqual({c[0] for c in calls},{'platform.object.companion_write','platform.object.companion_undo'})
  for c in calls:self.assertEqual(c[4],'required');self.assertEqual(c[5],['Desk User']);self.assertIn('expected_revision',c[6]['required'])
 def test_actual_executor_rolls_back_all_siblings_once_on_child_failure(self):
  scoped=patch.dict(sys.modules,{'shangshu_core.action_provenance':SimpleNamespace(process_action_version=lambda action:None,current_action_origin=lambda:None,_node=ContextVar('test_companion_node',default=None))});scoped.start();self.addCleanup(scoped.stop)
  state=[];events=[];requests=[];marks={}
  self.fr.generate_hash=lambda **k:'point%d'%(len(marks)+1)
  # 事务桩照真 frappe 的形状来（真 API 就是 rollback(save_point=…)）：
  # savepoint 级回滚**只撤这一段之后**的写入；整事务回滚才全撤，
  # 并把**没提交**的失败回执行撤掉（回执行是数据库行）。
  # 'rollback'/'commit' 是事务事实、回滚撤不掉 ⇒「回滚只发生一次」数得出来。
  def savepoint(point):marks[point]=(len(state),len(requests))
  def rollback(save_point=None,**kwargs):
   if save_point is None:
    state.clear();requests.clear()
    events[:]=[e for e in events if not e.startswith('failed:')]
    events.append('rollback');return
   mark=marks.get(save_point,(0,0));del state[mark[0]:];del requests[mark[1]:]
  self.fr.db=SimpleNamespace(exists=lambda *a:False,savepoint=savepoint,rollback=rollback,commit=lambda:events.append('commit'))
  def reserve(key,*a,**kw):
   requests.append(key);return SimpleNamespace(key=key),True
  req=SimpleNamespace(find_request=lambda k:None,reserve=reserve,audit_keys_of=lambda p:[],succeed=lambda r,v:None,fail=lambda r,m:events.append('failed:'+r.key))
  action=SimpleNamespace(action_version='1',input_schema_json='{}',confirmation_policy='required',effect='write')
  sys.modules['shangshu_core.lifecycle']=SimpleNamespace(assert_declared_call=lambda d:None)
  def handler(*args):
   key=args[7]
   if key=='parent':
    with self.m._atomic({'idempotency_key':'parent'},{'object_id':'obj','file_id':'file'}):
     env['execute_registered_action']('child',{},True,'first')
     env['execute_registered_action']('child',{},True,'second')
   elif key=='first':state.append('first-row')
   else:raise Invalid('second row denied')
   return {'result':{},'audit':key}
  env=load_module_functions(ACTIONS_PY,['execute_registered_action','persist_http_action_failure'],
   stubs={'frappe':self.fr,'now_datetime':lambda:'now','assert_domain_enabled':lambda d:None,
     'platform_contributions':lambda:{},'raw_resource':lambda *a:({'id':'com.shangshu.core'},{'handler':'x'}),
    'get_identity':lambda:SimpleNamespace(name='actor'),'assert_request_binding':lambda *a:None,
    'action_requests':req,'_validate_schema':lambda *a:None,'resource_execution':lambda *a:lambda f:f,
    'invoke_replay_guard':lambda *a:None,'unified_log':SimpleNamespace()})
  # 这三个真函数要碰数据库/角色/真 handler —— 由测试自己控，别让真实现顶掉。
  env.update({'_execute_action_handler':handler,'_definition':lambda *a:action,'_assert_action_role':lambda a:[]})
  # 生产里失败回执由**最外层 HTTP 边界**落库（public_api/http.py）——
  # 这里照同样形状把边界接上，'failed:parent'/'commit' 才有出处。
  executor=env['execute_registered_action']
  def execute(*args,**kwargs):
   try:return executor(*args,**kwargs)
   except Exception as error:
    env['persist_http_action_failure'](error);raise
  env['execute_registered_action']=execute
  with self.assertRaises(Invalid):env['execute_registered_action']('package',{},True,'parent')
  self.assertEqual(state,[]);self.assertEqual(requests,['parent'])
  self.assertEqual(events,['rollback','failed:parent','commit'])
if __name__=='__main__':unittest.main()
