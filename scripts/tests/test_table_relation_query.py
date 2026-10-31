"""Current relation search and request-local batching, including authorization loss."""
import json,sys,types,unittest
import test_table_relations as fixtures
from test_table_relations import D, Denied, Invalid

class QueryTests(unittest.TestCase):
 def setUp(self):
  f=fixtures.Tests();f.setUp();self.f=f;self.r=f.r;self.fr=f.fr
  sys.modules['shangshu_files'].table_relations=self.r
  self.q=f.load('relation_query','frappe_apps/shangshu_files/shangshu_files/table_relation_query.py')
  sys.modules['shangshu_files'].promotion.unreadable_headers=lambda doc:[]
  self.calls=[]
  def view(table,ids):
   self.calls.append((table,list(ids)))
   return {'content_version':7,'rows':[{'row_id':rid,'row_index':i+2,'values':json.loads(json.dumps(f.values[table,rid]))} for i,rid in enumerate(ids) if (table,rid) in f.values]}
  self.r._view=view
 def test_batch_reuses_shared_target_once_per_request(self):
  self.f.values['a','r3']={'link':D(type='blank',value=None)};self.f.config.links_json='{"r1":"r2","r3":"r2"}'
  cache=self.q.Resolver();cache.prime('a',['r1','r3'],['link'])
  self.assertEqual(cache.resolve('a','r1','link')['value']['value'],'old')
  self.assertEqual(cache.resolve('a','r3','link')['value']['value'],'old')
  self.assertEqual(len(self.calls),2)
  self.assertEqual(self.calls[1],('b',['r2']))
 def test_fresh_request_rechecks_values_and_permission(self):
  first=self.q.Resolver();self.assertEqual(first.resolve('a','r1','link')['value']['value'],'old')
  self.f.values['b','r2']['name']['value']='fresh'
  self.assertEqual(self.q.Resolver().resolve('a','r1','link')['value']['value'],'fresh')
  self.f.public.clear()
  with self.assertRaises(Denied):self.q.Resolver().resolve('a','r1','link')
 def test_denied_row_not_fetched_through_plain_value(self):
  del self.f.values['b','r2'];cache=self.q.Resolver();cache.prime('a',['r1'],['link'])
  with self.assertRaises(Denied):cache.resolve('a','r1','link')
 def search(self,query,hidden=(),target_allowed=True):
  self.r.definitions=lambda t:[self.f.config] if t=='a' else []
  sheet=sys.modules['shangshu_files'].sheet
  sheet.read_payload=lambda *a:{'table':'a','headers':['link','label'],'total_rows':1,'content_version':7,'rows':[{'row_id':'r1','row_index':2,'values':{'link':D(type='blank',value=None),'label':D(type='text',value='ordinary')}}]}
  sys.modules['shangshu_files'].promotion.unreadable_headers=lambda doc:list(hidden)
  self.r._formula_overlay=lambda result,configs,**kw:result
  if not target_allowed:self.f.public.clear()
  return self.q.search_payload(None,{'table':'a','search':query,'page_length':1})
 def test_search_matches_current_reference_not_blank_placeholder(self):
  result=self.search('old');self.assertEqual(result['total_rows'],1)
  self.assertEqual(result['rows'][0]['matches'],[{'header':'link','cell':'A2'}])
 def test_search_hidden_or_revoked_reference_does_not_affect_counts(self):
  self.assertEqual(self.search('old',hidden=['link'])['total_rows'],0)
  self.assertEqual(self.search('old',target_allowed=False)['total_rows'],0)
 def test_search_zero_and_false_are_values(self):
  self.f.values['b','r2']['name']=D(type='number',value=0)
  self.assertEqual(self.search('0')['total_rows'],1)
  self.f.values['b','r2']['name']=D(type='boolean',value=False)
  self.assertEqual(self.search('false')['total_rows'],1)
 def test_no_search_leaves_existing_path_alone(self):
  self.r.definitions=lambda t:(_ for _ in ()).throw(AssertionError('no query'))
  self.assertIsNone(self.q.search_payload(None,{'table':'a'}))
 def test_internal_flag_restored_on_backend_error(self):
  self.r.definitions=lambda t:[self.f.config]
  sys.modules['shangshu_files'].sheet.read_payload=lambda *a:(_ for _ in ()).throw(Invalid('backend unavailable'))
  with self.assertRaises(Invalid):self.q.search_payload(None,{'table':'a','search':'x'})
  self.assertFalse(self.fr.flags.shangshu_raw_relation_read)

 def test_stream_search_over_original_15517_rows_and_paginate_after_filter(self):
  self.r.definitions=lambda t:[self.f.config]
  self.q.Resolver.prime=lambda *a:None
  self.r.decorate_response=lambda result,**kw:result
  sys.modules['shangshu_files'].promotion.unreadable_headers=lambda doc:[]
  calls=[]
  def page(service,payload,context):
   calls.append(payload['page']);start=(payload['page']-1)*500
   return {'table':'a','headers':['label'],'total_rows':15517,'rows':[{'row_id':str(i),'row_index':i+2,'values':{'label':{'type':'text','value':'needle' if i%2==0 else 'other','formula':'SECRET_DEPENDENCY'}}} for i in range(start,min(start+500,15517))]}
  sys.modules['shangshu_files'].sheet.read_payload=page
  result=self.q.search_payload(None,{'table':'a','search':'needle','page':2,'page_length':3})
  self.assertEqual(result['total_rows'],7759);self.assertEqual([r['row_id'] for r in result['rows']],['6','8','10'])
  self.assertEqual(len(calls),32)
  self.assertEqual(self.q.search_payload(None,{'table':'a','search':'SECRET_DEPENDENCY'})['total_rows'],0)

 def test_search_explicit_empty_row_ids_does_not_mean_all_rows(self):
  self.r.definitions=lambda t:[self.f.config]
  self.r._formula_overlay=lambda result,configs,**kw:result
  sys.modules['shangshu_files'].sheet.read_payload=lambda *a:{'table':'a','headers':['label'],'total_rows':15517,'rows':[{'row_id':'r1','row_index':2,'values':{'label':{'type':'text','value':'secret'}}}]}
  result=self.q.search_payload(None,{'table':'a','search':'secret','row_ids':[]})
  self.assertEqual(result['rows'],[]);self.assertEqual(result['total_rows'],0)
 def test_prime_bounds_deep_graph_before_resolve(self):
  self.r.assert_relation_direction=lambda *a:True
  self.r._definition=lambda table,header:D(target_table=str(int(table)+1),target_header='v',links_json='{"r":"r"}',revision=1)
  self.r._view=lambda table,ids:{'rows':[{'row_id':'r','values':{'v':{'value':None}}}]}
  with self.assertRaises(Invalid):self.q.Resolver().prime('0',['r'],['v'])

if __name__=='__main__':unittest.main()
