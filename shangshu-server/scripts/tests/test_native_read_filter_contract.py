"""Offline production native query function contract; database boundary is captured.
The real-DB companion is core.tests.test_native_table's declared-read-filter test.
"""
import ast,json,re,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[3]
class ValidationError(Exception):pass
class PermissionError(Exception):pass
class ReadFilterTest(unittest.TestCase):
 def setUp(self):
  tree=ast.parse((ROOT/'frappe_apps/shangshu_core/shangshu_core/native_objects.py').read_text())
  selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'query_records','_gate_read','_order_by'}];assert len(selected)==3
  self.calls=[];self.roles={'Desk User'};self.readable={'name','status','title','modified'};self.item={'doctype':'Order','filter_fields':['name','status'],'fields':[{'id':v} for v in ['name','status','title']]};self.catalog={'name':{},'status':{},'title':{}}
  self.block={'fields':[{'id':'title'}],'read_roles':['Desk User'],'order_by':'modified desc'}
  def throw(message,error):raise error(message)
  def get_list(doctype,**kw):
   self.calls.append((doctype,kw));assert 'ignore_permissions' not in kw
   rows=[{'name':'order-a','status':'Draft','title':'synthetic','modified':'v1'}]
   rows=[r for r in rows if all(r.get(k)==v for k,v in kw['filters'].items())]
   if kw['fields']==['count(name) as count']:return [SimpleNamespace(count=len(rows))]
   return [{k:r[k] for k in kw['fields']} for r in rows]
  self.ns={'re':re,'frappe':SimpleNamespace(throw=throw,ValidationError=ValidationError,PermissionError=PermissionError,parse_json=json.loads,get_list=get_list),
   '_readable_fields':lambda _:self.readable,'_require':lambda _:({'id':'orders'},self.item,self.block,{},self.catalog),'_roles':lambda:self.roles,
   'definition':lambda _:{'fields':[{'id':'title'}],'input_schema':{'properties':{'title':{'type':'string'}}},'query':{'search_max_length':200,'sort_fields':['name','title'],'search_fields':['title']}}}
  exec(compile(ast.Module(body=selected,type_ignores=[]),'production-native-query','exec'),self.ns)
 def query(self,filters,**kw):return self.ns['query_records']('orders.order',filters,**kw)
 def test_declared_name_status_filter_and_unchanged_projection(self):
  result=self.query({'name':'order-a','status':'Draft'});self.assertEqual(result['total'],1)
  self.assertEqual(result['rows'],[{'name':'order-a','title':'synthetic','modified':'v1'}])
  self.assertEqual(len(self.calls),2);self.assertTrue(all(c[1]['filters']=={'name':'order-a','status':'Draft'} for c in self.calls))
  self.assertEqual(self.query({'name':'order-a','status':'Closed'})['total'],0)
 def test_object_projection_adds_read_only_fields_without_write_schema(self):
  result=self.query({'name':'order-a'},object_projection=True)
  self.assertEqual(result['rows'][0]['status'],'Draft')
  self.assertNotIn('status',result['object']['input_schema']['properties'])
 def test_hidden_fields_not_projected_filtered_or_sorted(self):
  self.readable.difference_update({'status','title'})
  result=self.query({'name':'order-a'},object_projection=True)
  self.assertNotIn('status',result['rows'][0]);self.assertNotIn('title',result['rows'][0]);self.assertEqual(result['object']['fields'],[]);self.calls.clear()
  with self.assertRaises(PermissionError):self.query({'status':'Draft'},object_projection=True)
  with self.assertRaises(ValidationError):self.query({'$sort':'title'},object_projection=True)
  with self.assertRaises(PermissionError):self.query({'$search':'synthetic'},object_projection=True)
  self.assertEqual(self.calls,[])
 def test_default_hidden_sort_falls_back_to_identity(self):
  self.block['order_by']='title desc, modified asc';self.readable.remove('title')
  self.query({});self.assertEqual(self.calls[0][1]['order_by'],'name asc')
  self.calls.clear();self.block['order_by']='modified desc'
  self.query({});self.assertEqual(self.calls[0][1]['order_by'],'modified desc')
 def test_explicit_identity_sort_does_not_fall_through_hidden_default(self):
  self.block['order_by']='title desc';self.readable.remove('title')
  self.query({'$sort':'name','$direction':'desc'})
  self.assertEqual(self.calls[0][1]['order_by'],'name desc, name asc')
 def test_existing_native_filter_still_works(self):self.assertEqual(self.query({'title':'synthetic'})['total'],1)
 def test_unlisted_or_invalid_declaration_never_queries(self):
  with self.assertRaises(ValidationError):self.query({'owner':'someone'})
  self.item['filter_fields']=['owner']
  with self.assertRaises(ValidationError):self.query({'owner':'someone'})
  self.assertEqual(self.calls,[])
 def test_read_permission_checked_before_filters_and_queries(self):
  self.roles=set()
  with self.assertRaises(PermissionError):self.query({'name':'order-a'})
  self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main(verbosity=2)
