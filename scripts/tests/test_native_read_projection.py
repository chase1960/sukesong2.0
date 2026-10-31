"""Native query executes real scope/filter/SQL construction; storage is a counting boundary."""
import ast, copy, types, unittest
from pathlib import Path
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment
install_real_environment('shangshu_core')
from shangshu_core import read_scope
ROOT=Path(__file__).resolve().parents[2]
CORE=ROOT/'frappe_apps/shangshu_core/shangshu_core'
def fail(message,kind=ValueError):raise kind(message)
class NativeProjection(unittest.TestCase):
 def setUp(self):
  fields=[{'id':'title','type':'text'},{'id':'amount','type':'decimal'},{'id':'note','type':'long_text'},{'id':'secret','type':'text'}]
  self.item={'id':'native','doctype':'Invoice','fields':fields+[{'id':'status'},{'id':'modified'}], 'filter_fields':['status'],'operations':['read']}
  self.block={'fields':fields,'title':'原生表','search_fields':['title','note'],'order_by':'modified desc'}
  self.readable={'name','modified','title','amount','note','status'}
  self.public={'name':'原生表','fields':fields,'input_schema':{'properties':{f['id']:{} for f in fields}},'query':{'search_fields':['title','note'],'sort_fields':['name','title','amount','secret'],'search_max_length':200}}
  self.define=Mock(side_effect=lambda _:copy.deepcopy(self.public))
  self.query=Mock(side_effect=lambda dt,**kw:[types.SimpleNamespace(count=1)] if kw['fields']==['count(name) as count'] else [{'name':'n1','modified':'v1','title':'title','amount':2,'note':'needle','secret':'never','status':'Open'}])
  self.ns={'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError,PermissionError=PermissionError,parse_json=__import__('json').loads),
   '_require':lambda _:( {'id':'domain'},self.item,self.block,{}, {f['id']:f for f in self.item['fields']}),
   '_gate_read':Mock(),'_readable_fields':lambda *a:self.readable,'definition':self.define,
   'query_receipt':types.SimpleNamespace(build_receipt=lambda **kw:kw),'re':__import__('re')}
  path=CORE/'native_objects.py';tree=ast.parse(path.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('query_records','_order_by','_query_capabilities','_fail')]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),self.ns)
  mods=patch.dict('sys.modules',{'shangshu_core.business_access':types.SimpleNamespace(authorized_get_list=self.query)})
  mods.start();self.addCleanup(mods.stop)
  import shangshu_core
  access=patch.object(shangshu_core,'business_access',types.SimpleNamespace(authorized_get_list=self.query),create=True)
  access.start();self.addCleanup(access.stop)
  scope=patch.object(read_scope,'frappe',self.ns['frappe']);scope.start();self.addCleanup(scope.stop)
 def read(self,filters=None,**kwargs):return self.ns['query_records']('native',filters,**kwargs)
 def test_requested_column_is_sql_projection_and_schema_is_not_built(self):
  out=self.read(fields=['amount'],include_definition=False)
  self.assertEqual(self.query.call_args_list[0].kwargs['fields'],['amount','name','modified'])
  self.assertEqual(out['rows'],[{'amount':2,'name':'n1','modified':'v1'}])
  self.assertNotIn('object',out);self.define.assert_not_called()
  self.assertEqual(out['receipt']['object_name'],'原生表')
 def test_display_projection_does_not_remove_search_filter_or_sort_dependencies(self):
  out=self.read({'$search':'needle','$sort':'title','status':'Open'},fields=['amount'],include_definition=False)
  query=self.query.call_args_list[0].kwargs
  self.assertEqual(set(query['or_filters']),{'title','note'})
  self.assertEqual(query['filters'],{'status':'Open'})
  self.assertEqual(query['order_by'],'title asc, name asc')
  self.assertEqual(set(out['rows'][0]),{'name','modified','amount'})
 def test_hidden_or_undeclared_display_field_rejected_before_sql(self):
  for fields in (['secret'],['unknown']):
   with self.subTest(fields=fields),self.assertRaises((PermissionError,ValueError)):self.read(fields=fields,include_definition=False)
  self.query.assert_not_called()
 def test_empty_projection_keeps_only_identity_and_version(self):
  result=self.read(fields=[],include_definition=False)
  self.assertEqual(result['rows'],[{'name':'n1','modified':'v1'}])
 def test_legacy_default_projection_and_definition_are_preserved(self):
  result=self.read()
  self.assertEqual(set(result['rows'][0]),{'name','modified','title','amount','note'})
  self.assertIn('object',result);self.define.assert_called_once()
 def test_scope_modes_and_conflicting_fields_fail_before_sql(self):
  for scope,fields in (({'mode':'all','purpose':'export'},None),({'mode':'rows'},None),({'fields':['title']},['amount'])):
   with self.subTest(scope=scope),self.assertRaises(ValueError):self.read(read_scope=scope,fields=fields,include_definition=False)
  self.query.assert_not_called()

 def test_projection_does_not_bypass_original_source_read_gate(self):
  self.ns['_gate_read'].side_effect=PermissionError('source denied')
  with self.assertRaises(PermissionError):self.read(fields=[],include_definition=False)
  self.query.assert_not_called()

class CompanionIdentityReads(unittest.TestCase):
 def setUp(self):
  self.rows=Mock(return_value={'r1':{'name':'r1','modified':'v1'}})
  self.native_query=Mock(return_value={'rows':[{'name':'r1','modified':'v1'}],'total':1})
  self.kind='managed'
  self.native=types.SimpleNamespace(query_records=self.native_query,_readable_fields=lambda *a:{'title'})
  self.model=types.SimpleNamespace(get_records=self.rows)
  self.ns={'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError,PermissionError=PermissionError,DoesNotExistError=LookupError,get_roles=lambda:[]),
   '_find':lambda *a:types.SimpleNamespace(object_id='o'),
   '_current':lambda b:{'source_kind':self.kind,'source_doctype':'Native','fields':[{'id':'title'}]},
   'domain_execution':lambda *a:__import__('contextlib').nullcontext(), 'RECYCLED_MESSAGE':'记录已回收','AUTHORIZE_BATCH':500}
  path=CORE/'object_companions.py';tree=ast.parse(path.read_text());names={'authorize_companion_cells','_read_authorized_batch','_identity_records','_chunks','_fail'}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(path),'exec'),self.ns)
  import shangshu_core
  self.patches=[patch.object(shangshu_core,'model_records',self.model,create=True),patch.object(shangshu_core,'native_objects',self.native,create=True),
   patch.dict('sys.modules',{'shangshu_core.objects':types.SimpleNamespace(get_object_definition=lambda _:{'fields':[{'id':'title'}]},get_object_record=Mock(side_effect=AssertionError('full record forbidden')))})]
  for p in self.patches:p.start();self.addCleanup(p.stop)
 def test_identity_only_preserves_readable_field_capabilities(self):
  out=self.ns['authorize_companion_cells']('file',['r1'],['title'])
  self.rows.assert_called_once_with('o',['r1'],fields=[])
  self.assertEqual(out,{'allowed_record_ids':['r1'],'readable_field_ids':['title']})
 def test_partial_denial_rechecks_identity_only_and_never_calls_full_detail(self):
  def read(o,names,*,fields):
   self.assertEqual(fields,[])
   if len(names)>1 or names==['denied']:raise PermissionError('denied')
   return {names[0]:{'name':names[0]}}
  self.rows.side_effect=read
  out=self.ns['authorize_companion_cells']('file',['r1','denied'],['title'])
  self.assertEqual(out['allowed_record_ids'],['r1'])
 def test_non_permission_validation_is_not_swallowed(self):
  self.rows.side_effect=ValueError('定义损坏')
  with self.assertRaisesRegex(ValueError,'定义损坏'):self.ns['authorize_companion_cells']('file',['r1'],['title'])
 def test_native_identity_uses_original_authorized_query_and_rejects_missing_write_target(self):
  self.kind='native'
  out=self.ns['authorize_companion_cells']('file',['r1','missing'],['title'])
  self.assertEqual(out['allowed_record_ids'],['r1']);self.rows.assert_not_called()
  self.assertEqual(self.native_query.call_args.kwargs['fields'],[])
  self.assertFalse(self.native_query.call_args.kwargs['include_definition'])
  self.assertEqual(self.native_query.call_args.args[1],{'name':['in',['r1','missing']]})
  with self.assertRaises(PermissionError):self.ns['authorize_companion_cells']('file',['r1','missing'],[],operation='write')

 def test_native_identity_limits_each_query_to_its_named_hundred(self):
  self.kind='native'
  self.native_query.side_effect=lambda object_id,filters,**kw:{'rows':[{'name':name} for name in filters['name'][1]]}
  names=['r'+str(i) for i in range(205)]
  out=self.ns['_identity_records']('o',names,'native')
  self.assertEqual(len(out),205)
  self.assertEqual([len(call.args[1]['name'][1]) for call in self.native_query.call_args_list],[100,100,5])
  self.assertTrue(all(call.kwargs['fields']==[] and call.kwargs['page']==1 for call in self.native_query.call_args_list))

if __name__=='__main__':unittest.main()
