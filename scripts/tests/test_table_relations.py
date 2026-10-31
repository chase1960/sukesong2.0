"""Behavioral tests for live-key relation resolution and direction/public isolation."""
import importlib.util,json,sys,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception):pass
class Invalid(Exception):pass
class D(dict):
 __getattr__=dict.get
 def __setattr__(self,k,v):self[k]=v
 def get(self,k,default=None):return super().get(k,default)
 def set(self,k,v):self[k]=v
 def save(self,**kw):return self
class Tests(unittest.TestCase):
 def setUp(self):
  def throw(message,kind):raise kind(message)
  self.fr=types.SimpleNamespace(throw=throw,PermissionError=Denied,ValidationError=Invalid,DoesNotExistError=KeyError,TimestampMismatchError=Invalid,session=D(user='a'),flags=D(),db=D())
  sys.modules['frappe']=self.fr
  self.org=types.SimpleNamespace(resource_attribution=lambda t:self.attrs[t],_attribution_enterprise=lambda a,r:a.get('enterprise'),_descendants=lambda d:{d,'child'} if d=='parent' else {d})
  sys.modules['shangshu_core']=types.SimpleNamespace(org_admin=self.org)
  sys.modules['shangshu_core.identity']=types.SimpleNamespace(get_identity=lambda u=None:D(user=u or 'a',enterprise_id='e'))
  self.attrs={'a':D(level='department',department='child',enterprise='e'),'b':D(level='department',department='parent',enterprise='e'),'c':D(level='department',department='child',enterprise='other')}
  self.public=set();self.fr.db.exists=lambda kind,f:f['resource'] in self.public
  self.fr.get_all=lambda *a,**k:[]
  self.p=self.load('public_resources','frappe_apps/shangshu_core/shangshu_core/public_resources.py')
  sys.modules['shangshu_core.public_api']=types.SimpleNamespace(assert_relation_direction=self.p.assert_relation_direction,public_resource_allows=self.p.public_resource_allows)
  sys.modules['shangshu_files']=types.SimpleNamespace(sheet=types.SimpleNamespace(),promotion=types.SimpleNamespace(_load_meta=lambda d:{}),formulas=types.SimpleNamespace())
  self.r=self.load('relations','frappe_apps/shangshu_files/shangshu_files/table_relations.py')
  self.values={('a','r1'):{'link':D(type='blank',value=None)},('b','r2'):{'name':D(type='text',value='old')}}
  self.config=D(source_table='a',source_header='link',target_table='b',target_header='name',links_json=json.dumps({'r1':'r2'}),revision=3)
  self.r._file=lambda table,**kw:D(name=table)
  self.r._header=lambda *a,**kw:None
  self.r._row=lambda t,r:({'content_version':7},{'values':self.values[(t,r)]})
  self.r._definition=lambda t,h,*a:self.config if (t,h)==('a','link') else None
  self.public.add('b')
 def load(self,name,path):
  spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def test_upstream_nonpublic_denied_even_caller_readable(self):
  self.public.clear()
  with self.assertRaises(Denied):self.p.assert_relation_direction('a','b')
 def test_public_upstream_allowed_but_other_enterprise_denied(self):
  self.assertTrue(self.p.assert_relation_direction('a','b'));self.public.add('c')
  with self.assertRaises(Denied):self.p.assert_relation_direction('a','c')
 def test_downward_nonpublic_allowed(self):
  self.public.clear();self.assertTrue(self.p.assert_relation_direction('b','a'))
 def test_keys_read_current_single_source(self):
  self.assertEqual(self.r.resolve('a','r1','link')['value']['value'],'old')
  self.values['b','r2']['name']['value']='updated'
  self.assertEqual(self.r.resolve('a','r1','link')['value']['value'],'updated')
  self.assertNotIn('updated',self.config.links_json)
 def test_public_revocation_immediate(self):
  self.r.resolve('a','r1','link');self.public.clear()
  with self.assertRaises(Denied):self.r.resolve('a','r1','link')
 def test_unavailable_read_does_not_leak_target_or_value(self):
  self.public.clear();self.r.definitions=lambda t:[self.config]
  out=self.r.read(None,{'table':'a','row_ids':['r1'],'headers':['link']})['values'][0]
  self.assertEqual(out,{'row_id':'r1','header':'link','status':'unavailable'})
 def test_stable_row_key_not_position(self):
  self.values['b','r3']={'name':D(type='text',value='different')}
  self.assertEqual(self.r.resolve('a','r1','link')['target']['row_id'],'r2')
 def test_direct_target_is_not_chain_terminal(self):
  end=D(source_table='b',source_header='name',target_table='a',target_header='terminal',links_json=json.dumps({'r2':'r1'}),revision=2)
  self.values['a','r1']['terminal']=D(type='text',value='end')
  self.r._definition=lambda t,h,*a:self.config if (t,h)==('a','link') else end if (t,h)==('b','name') else None
  self.r.assert_relation_direction=lambda *a:True
  value=self.r.resolve('a','r1','link')
  self.assertEqual(value['direct_target'],{'table':'b','row_id':'r2','header':'name'})
  self.assertEqual(value['target'],{'table':'a','row_id':'r1','header':'terminal'})
 def test_explicit_empty_rows_returns_definitions_only(self):
  self.r.definitions=lambda t:[self.config]
  self.r._view=lambda *a:(_ for _ in ()).throw(AssertionError('must not load rows'))
  out=self.r.read(None,{'table':'a','row_ids':[]})
  self.assertEqual(out['values'],[]);self.assertEqual(len(out['definitions']),1)
 def test_cycle_rejected_at_resolve(self):
  self.config.target_table='a';self.config.target_header='link';self.config.links_json=json.dumps({'r1':'r1'})
  with self.assertRaises(Invalid):self.r.resolve('a','r1','link')
 def test_decorates_readonly_current_value(self):
  self.r._formula_overlay=lambda result,configs:result  # formula evaluation covered separately/live
  self.r.definitions=lambda t:[self.config]
  out=self.r.decorate_response({'table':'a','rows':[{'row_id':'r1','values':{'link':D(type='blank',value=None)}}]})
  self.assertEqual(out['rows'][0]['values']['link']['value'],'old')
  self.assertTrue(out['rows'][0]['values']['link']['readonly'])
 def test_imported_formula_without_cached_metadata_uses_live_reference(self):
  import io,openpyxl
  wb=openpyxl.Workbook();ws=wb.active;ws.append(['link','total']);ws.append([None,'=SUM(A2:A2)'])
  stream=io.BytesIO();wb.save(stream)
  formula=self.load('actual_formulas','frappe_apps/shangshu_files/shangshu_files/formulas.py')
  sys.modules['shangshu_files']=types.SimpleNamespace(
   sheet=types.SimpleNamespace(_content=lambda d:stream.getvalue(),_headers_of=lambda ws:[c.value for c in ws[1]]),
   promotion=types.SimpleNamespace(_load_meta=lambda d:{'rows':['r1']},unreadable_headers=lambda d:set(),_load_formal=lambda d:{},load_definition=lambda d:{'columns':[]}),formulas=formula)
  self.values['b','r2']['name']=D(type='number',value=800)
  self.config.name='relation'
  out=self.r._formula_overlay({'table':'a','content_version':1,'rows':[{'row_id':'r1','values':{'total':D(type='formula',value=None,formula='=SUM(A2:A2)')}}]},[self.config])
  self.assertEqual(out['rows'][0]['values']['total']['value'],800)
  self.values['b','r2']['name']['value']=900
  out=self.r._formula_overlay(out,[self.config]);self.assertEqual(out['rows'][0]['values']['total']['value'],900)
 def test_actual_grant_document_validates_public_branch_and_scope(self):
  sys.modules['frappe.model.document']=types.SimpleNamespace(Document=D)
  model=self.load('grant_document','frappe_apps/shangshu_core/shangshu_core/shangshu_core/doctype/shangshu_org_grant/shangshu_org_grant.py')
  grant=model.ShangshuOrgGrant(kind='public',resource='b',access='read',grantee_enterprise='e')
  with self.assertRaises(Denied):grant.validate()
  self.fr.flags.shangshu_public_publish='b';grant.validate()
  grant.access='edit'
  with self.assertRaises(Invalid):grant.validate()
  grant.access='read';grant.grantee_user='a'
  with self.assertRaises(Invalid):grant.validate()
 def test_remove_keeps_audited_relation_identity_as_disabled(self):
  self.config.name='REL-1';self.config.binding_key='original';self.config.enabled=1
  self.fr.delete_doc=lambda *a,**kw:(_ for _ in ()).throw(AssertionError('must preserve audit reference'))
  context={};out=self.r.remove(None,{'table':'a','header':'link','expected_revision':3},context)
  self.assertTrue(out['removed']);self.assertEqual(self.config.enabled,0)
  self.assertEqual(self.config.binding_key,'removed:REL-1')
  self.assertEqual(context['record_change']['name'],'REL-1')
 def test_public_does_not_imply_other_enterprise(self):
  self.public.add('c');self.assertFalse(self.p.public_resource_allows('a','c'))
 def test_structure_undo_restores_relation_header_and_increments_revision(self):
  prior={'name':'link1','source_table':'a','source_header':'old','target_table':'b','target_header':'name','revision':1,'links_json':'{}'}
  after={**prior,'source_header':'new','revision':2}
  doc=D(**after);self.fr.get_doc=lambda *a,**kw:doc
  self.r.structure_snapshot=lambda *a,**kw:[after]
  self.r.restore_structure_relations('a',[prior],[after])
  self.assertEqual(doc.source_header,'old');self.assertEqual(doc.revision,3)
 def test_structure_undo_rejects_new_relation_changes(self):
  self.r.structure_snapshot=lambda *a,**kw:[{'name':'new-link'}]
  with self.assertRaises(Invalid):self.r.restore_structure_relations('a',[],[])
 def test_old_structure_snapshot_with_relations_fails_explicitly(self):
  self.r.structure_snapshot=lambda *a,**kw:[{'name':'new-link'}]
  with self.assertRaises(Invalid):self.r.restore_structure_relations('a',None,None)

if __name__=='__main__':unittest.main()
