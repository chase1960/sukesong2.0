"""Core companion boundary tests; DB/provider I/O replaced, actual authorization/dispatch runs."""
import importlib.util,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception):pass
class Invalid(Exception):pass
class Missing(Exception):pass
class Doc(dict):
 def __getattr__(self,k):return self.get(k)
def fail(msg,exc):raise exc(msg)
@contextmanager
def domain(*args):yield
class Tests(unittest.TestCase):
 def setUp(self):
  self.roles=[];self.readable={'one'};self.projected=[]
  self.binding=Doc(name='binding',object_id='orders.order',file_id='file',enterprise_id='e',source_doctype='Order',definition_revision='rev',field_columns_json='[{"field_id":"title","header":"Title","type":"text"}]')
  self.fr=SimpleNamespace(throw=fail,ValidationError=Invalid,PermissionError=Denied,DoesNotExistError=Missing,
    flags=SimpleNamespace(shangshu_companion_projection=None),get_roles=lambda:self.roles,
    get_meta=lambda d:SimpleNamespace(has_field=lambda f:d=='Order'),
    db=SimpleNamespace(exists=lambda *a:True),get_all=lambda *a,**k:['binding'],get_doc=lambda *a,**k:self.binding,
    get_hooks=lambda *a,**k:['shangshu_files.object_projection.project'],get_attr=lambda p:self.project)
  sys.modules['frappe']=self.fr
  sys.modules['shangshu_core.domain_execution']=SimpleNamespace(domain_execution=domain)
  sys.modules['shangshu_core.identity']=SimpleNamespace(get_identity=lambda:SimpleNamespace(enterprise_id='e'))
  sys.modules['shangshu_core.domains']=SimpleNamespace(assert_domain_enabled=lambda d:None)
  def get_record(object_id,name):
   if name not in self.readable:raise Denied('record')
   return {'record':{'name':name,'title':'current'}}
  sys.modules['shangshu_core.objects']=SimpleNamespace(get_object_record=get_record,get_object_definition=lambda o:{'fields':[{'id':'title'},{'id':'hidden'}]})
  def identity_records(object_id,names,*,fields):
   self.assertEqual(fields,[])
   return {name:{'name':get_record(object_id,name)['record']['name']} for name in names}
  native=SimpleNamespace(_readable_fields=lambda *a:{'title'},
    query_records=lambda object_id,filters,**kw:{'rows':[{'name':name} for name in filters['name'][1] if name in self.readable]})
  sys.modules['shangshu_core']=SimpleNamespace(request_cache=SimpleNamespace(get=lambda _k,_loader:_loader(),clear=lambda *a:None),
    model_records=SimpleNamespace(get_records=identity_records),native_objects=native)

  spec=importlib.util.spec_from_file_location('companions_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/object_companions.py')
  self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.real_spec=self.m._spec
  self.m._find=lambda *a:self.binding
  self.m._spec=lambda *a,**k:{'definition_revision':'rev','source_doctype':'Order','fields':[{'id':'title'}],'columns':{'title':'title'},'enterprise_field':'enterprise_id'}
 def project(self,binding,records,event):
  self.projected.append((binding,records,event,self.fr.flags.shangshu_companion_projection.copy()))
  return {'applied':1}
 def test_read_filters_records_and_fields_using_original_permission(self):
  out=self.m.authorize_companion_cells('file',['one','other'],['title','hidden'])
  self.assertEqual(out,{'allowed_record_ids':['one'],'readable_field_ids':['title']})
 def test_normal_note_write_requires_source_read_not_source_write(self):
  self.assertEqual(self.m.authorize_companion_cells('file',['one'],[],operation='write')['allowed_record_ids'],['one'])
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',['one','other'],[],operation='write')
 def test_structure_does_not_follow_share_read(self):
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',[],[],operation='structure')
 def test_definition_drift_and_cross_enterprise_deny(self):
  self.binding.definition_revision='changed';self.binding['definition_revision']='changed'
  with self.assertRaises(Invalid):self.m.get_file_companion('file')
  self.binding['definition_revision']='rev';self.binding.definition_revision='rev';self.binding['enterprise_id']='foreign';self.binding.enterprise_id='foreign'
  with self.assertRaises(Denied):self.m.get_file_companion('file')
 def test_context_only_during_actual_provider_and_restored(self):
  self.fr.flags.shangshu_companion_projection={'outer':True}
  self.m._project(self.m._public(self.binding),[],'initial')
  self.assertEqual(self.projected[0][3],{'object_id':'orders.order','file_id':'file'})
  self.assertEqual(self.fr.flags.shangshu_companion_projection,{'outer':True})
 def test_provider_exception_propagates_and_restores_scope(self):
  def bad(*a):raise Invalid('write failed')
  self.fr.get_attr=lambda p:bad
  with self.assertRaises(Invalid):self.m._project(self.m._public(self.binding),[],'update')
  self.assertIsNone(self.fr.flags.shangshu_companion_projection)
 def test_client_cannot_select_provider(self):
  self.fr.get_hooks=lambda *a,**k:['evil.run']
  with self.assertRaises(Invalid):self.m._project(self.m._public(self.binding),[],'update')
 def test_hook_current_values_only_and_enterprise_scope(self):
  doc=Doc(name='one',doctype='Order',title='new',modified='now',enterprise_id='e')
  self.m.sync_source_document(doc)
  self.assertEqual(self.projected[0][1],[{'name':'one','modified':'now','values':{'title':'new'}}])
  doc['enterprise_id']='foreign';self.m.sync_source_document(doc);self.assertEqual(len(self.projected),1)
 def test_binding_fde_only_and_delete_not_silently_drops_notes(self):
  with self.assertRaises(Denied):self.m.bind_object_companion('orders.order','file',[])
  with self.assertRaises(Invalid):self.m.guard_source_delete(Doc(doctype='Order'))
 def test_unknown_file_not_reinterpreted_as_business_object(self):
  self.m._find=lambda *a:None
  self.assertIsNone(self.m.authorize_companion_cells('ordinary',[],[]))
 def test_managed_spec_uses_compiled_physical_mapping(self):
  model=Doc(physical_doctype='SSM actual',active_revision=2,enterprise_id='e')
  compiled={'kind':'record','fields':[{'id':'logical','type':'text','deprecated':False}], 'doctype':{'fields':[{'fieldname':'physical'}]}}
  sys.modules['shangshu_core']=SimpleNamespace(request_cache=SimpleNamespace(get=lambda _k, _loader: _loader(), clear=lambda *a: None),model_records=SimpleNamespace(is_managed=lambda o:True,_load=lambda o:(model,compiled,[])),native_objects=SimpleNamespace(SCALAR_TYPES=('text',)))
  spec=self.real_spec('model')
  self.assertEqual(spec['columns'],{'logical':'physical'});self.assertEqual(spec['source_doctype'],'SSM actual')
  self.assertIsNone(spec['enterprise_field']);self.assertEqual(spec['enterprise_id'],'e')
  original=spec['definition_revision'];model['active_revision']=3
  self.assertNotEqual(self.real_spec('model')['definition_revision'],original)
 def test_managed_detail_refused_without_creating_mirror(self):
  model=Doc(physical_doctype='SSM actual',active_revision=2,enterprise_id='e')
  sys.modules['shangshu_core']=SimpleNamespace(request_cache=SimpleNamespace(get=lambda _k, _loader: _loader(), clear=lambda *a: None),model_records=SimpleNamespace(is_managed=lambda o:True,_load=lambda o:(model,{'kind':'detail'},[])),native_objects=SimpleNamespace(SCALAR_TYPES=('text',)))
  with self.assertRaises(Invalid):self.real_spec('detail')
 def test_delete_guard_only_blocks_matching_native_enterprise(self):
  observed=[]
  def exists(kind,filters=None):
   if kind=='DocType':return True
   observed.append(filters)
   return filters=={'source_doctype':'Order','enterprise_id':'e'}
  self.fr.db.exists=exists
  self.m.guard_source_delete(Doc(doctype='Order',enterprise_id='other'))
  self.m.guard_source_delete(Doc(doctype='Order',enterprise_id=None))
  with self.assertRaises(Invalid):self.m.guard_source_delete(Doc(doctype='Order',enterprise_id='e'))
  self.assertEqual(observed[0],{'source_doctype':'Order','enterprise_id':'other'})
 def test_update_query_filters_enterprise_before_definition_validation(self):
  observed=[]
  self.fr.get_all=lambda kind,**kw:observed.append(kw['filters']) or []
  self.m.sync_source_document(Doc(doctype='Order',enterprise_id='other'))
  self.assertEqual(observed,[{'source_doctype':'Order','enterprise_id':'other'}])
 def test_attribution_uses_actual_personal_department_model_no_enterprise_guess(self):
  att={'level':'personal','owner_user':'worker'}
  sys.modules['shangshu_core.org_admin']=SimpleNamespace(resource_attribution=lambda f:att)
  calls=[]
  self.fr.db.get_value=lambda *args:calls.append(args) or 'e'
  self.assertEqual(self.m._file_enterprise('file'),'e')
  self.assertEqual(calls[-1],('Shangshu Identity',{'user':'worker'},'enterprise_id'))
  att.clear();att.update(level='department',department='d')
  self.assertEqual(self.m._file_enterprise('file'),'e')
  self.assertEqual(calls[-1],('Shangshu Department','d','enterprise_id'))
  att.clear();att.update(level='enterprise',owner_user='worker')
  with self.assertRaises(Invalid):self.m._file_enterprise('file')
 def test_bind_dispatcher_passes_three_arguments(self):
  received=[]
  self.m.bind_object_companion=lambda *a:received.append(a) or {'bound':True}
  result=self.m.bind_action('platform.object.companion_bind',{'object_id':'obj','file_id':'file','field_columns':[]},{'confirmed':True})
  self.assertEqual(result,{'bound':True});self.assertEqual(received,[('obj','file',[])])
 def test_first_bind_filters_recycled_without_an_enterprise_column(self):
  import sqlite3
  class ReadComplete(Exception):pass
  self.roles=['System Manager'];self.m._find=lambda *a:None
  self.m._file_enterprise=lambda _file:'e'
  self.m._spec=lambda *_a,**_k:{'definition_revision':'rev','source_doctype':'Order',
    'enterprise_field':None,'enterprise_id':'e','fields':[{'id':'title','type':'text'}]}
  db=sqlite3.connect(':memory:')
  db.execute('CREATE TABLE `tabOrder` (name TEXT, ss_recycled INTEGER)')
  db.executemany('INSERT INTO `tabOrder` VALUES (?,?)',[('active',0),('old',None),('recycled',1)])
  observed=[]
  def sql(query,params):
   observed.extend(db.execute(query.removesuffix(' FOR UPDATE'),params).fetchall())
   raise ReadComplete()
  self.fr.db.sql=sql
  try:
   for managed in (True,False):
    with self.subTest(managed=managed):
     observed.clear();revoked=[]
     object_id='managed.object' if managed else 'native.object'
     def is_managed(candidate):
      self.assertEqual(candidate,object_id)
      return managed
     with patch.dict(sys.modules,{
       'shangshu_core.model_records':SimpleNamespace(is_managed=is_managed),
       'shangshu_core.write_zone_schema':SimpleNamespace(revoke_certification=revoked.append)}):
      with self.assertRaises(ReadComplete):
       self.m.bind_object_companion(object_id,'file',[{'field_id':'title','header':'Title'}])
     self.assertEqual(observed,[('active',),('old',)])
     self.assertEqual(revoked,[object_id] if managed else [])
  finally:db.close()
 def test_companion_download_uses_source_field_rights_and_revocation(self):
  spec=importlib.util.spec_from_file_location('shangshu_core.field_access',ROOT/'frappe_apps/shangshu_core/shangshu_core/field_access.py')
  policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy);sys.modules['shangshu_core.field_access']=policy
  self.roles=['Desk User'];source=self.m._spec(None);source['source_kind']='managed';self.m._spec=lambda *a,**kw:source
  # Current read does not imply export; absent declaration denies.
  self.assertEqual(self.m.authorize_companion_cells('file',['one'],['title'])['allowed_record_ids'],['one'])
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',['one'],['title'],operation='download')
  source['fields'][0]['download_roles']=['Desk User']
  self.assertEqual(self.m.authorize_companion_cells('file',['one'],['title'],operation='download')['downloadable_field_ids'],['title'])
  self.readable.clear()
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',['one'],['title'],operation='download')
  self.readable.add('one');source['fields'][0]['download_roles']=[]
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',['one'],['title'],operation='download')
 def test_native_companion_calls_original_export_gate(self):
  sys.modules['shangshu_core.field_access']=SimpleNamespace(field_allows_roles=lambda *a:True)
  source=self.m._spec(None);source['source_kind']='native';self.m._spec=lambda *a,**kw:source
  def deny():raise Denied('native bulk export gate')
  sys.modules['shangshu_core.native_objects']=SimpleNamespace(require_export_permission=deny)
  with self.assertRaises(Denied):self.m.authorize_companion_cells('file',['one'],['title'],operation='download')

 def test_snapshot_projects_declared_booleans_without_turning_zero_or_null_into_other_values(self):
  spec={'fields':[{'id':'flag','type':'boolean'},{'id':'amount','type':'decimal'},{'id':'code','type':'text'}],
        'columns':{'flag':'flag','amount':'amount','code':'code'}}
  for raw,expected in [(0,False),(1,True),(None,None)]:
   record=Doc(name='one',modified='v1',flag=raw,amount=0,code='001')
   values=self.m._snapshot(record,spec)['values']
   self.assertIs(values['flag'],expected)
   self.assertIs(type(values['amount']),int)
   self.assertEqual(values['code'],'001')

if __name__=='__main__':unittest.main()
