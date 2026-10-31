"""Real proposal-recovery and actor/enterprise/role guards, with storage boundaries substituted."""
import ast, importlib.util, json, sys, unittest
from copy import deepcopy
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
class Invalid(Exception):pass
class Denied(Exception):pass
class Missing(Exception):pass
class Doc(SimpleNamespace):
 def get(self,key):return getattr(self,key,None)
def throw(message,error):raise error(message)
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Tests(unittest.TestCase):
 def setUp(self):
  self.roles=['Desk User'];self.active=True;self.enabled=True;self.available=True;self.row_allowed=True;self.file_allowed=True;self.calls=[]
  self.payload={'object_id':'obj','expected_revision':3,'records':[{'name':'r1','expected_modified':'ORIGINAL','values':{'amount':0}}]}
  self.doc=Doc(name='p1',action_id='platform.object.update_many',action_version='1.1.0',status='Proposed',enterprise_id='enterprise',actor_user='owner',payload_json='')
  self.definition={'id':'obj','source':'managed','revision':99,'fields':[{'id':'amount','type':'integer'}], 'companion':{'file_id':'file','definition_revision':5,'field_columns':[{'header':'金额','field_id':'amount'}]}}
  self.file_rows=[{'row_id':'r1','values':{'金额':{'type':'number','value':777}}}]
  fake=SimpleNamespace(session=SimpleNamespace(user='owner'),get_roles=lambda:self.roles,throw=throw,PermissionError=Denied,ValidationError=Invalid,TimestampMismatchError=Invalid,DoesNotExistError=Missing)
  def getdoc(kind,name,**kw):
   self.assertEqual((kind,name),('Shangshu Action Proposal','p1'));self.calls.append(('proposal',name));return self.doc
  fake.get_doc=getdoc;self.frappe=fake
  def identity():
   if not self.active:raise Denied('disabled identity')
   return SimpleNamespace(enterprise_id='enterprise')
  def require_identity():identity()
  access=SimpleNamespace(require_identity=require_identity,resource_is_open=lambda action:False)
  action_ctx={'frappe':fake,'business_access':access,'get_identity':identity,'_proposal_reviewer':lambda doc:None,
    '_assert_proposal_target':lambda *a:None,'_project_proposal_payload':lambda action,payload:{'payload':payload},
    '_proposal_public':lambda doc,**kw:{'id':doc.name,'capability':doc.action_id,'status':doc.status.lower()},
    '_proposal_review_state':lambda *a:{},'json':json}
  path=ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py'
  names={'_json','_proposal_eligible','_proposal_visible','get_action_proposal','_assert_action_role'}
  nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),action_ctx)
  props={key:{} for key in ['object_id','expected_revision','records','file_id','definition_revision','expected_modified','expected_content_version','expected_structure_version','op_id','cells']}
  action=SimpleNamespace(action_id=self.doc.action_id,allowed_roles_json='["Desk User"]',input_schema_json=json.dumps({'type':'object','properties':props,'additionalProperties':False}))
  def action_definition(action_id,version=None):
   if not self.available:raise Denied('action unavailable')
   return action
  def getrecords(object_id,names,**kw):
   self.calls.append(('rows',object_id,names,kw))
   if not self.row_allowed:raise Denied('record outside current scope')
   return {name:{'name':name,'modified':'LATEST-MUST-NOT-REPLACE'} for name in names}
  def service(service_id,payload):
   self.calls.append(('service',service_id,payload))
   if not self.file_allowed:raise Denied('file revoked')
   return {'table':'file','rows':deepcopy(self.file_rows)}
  def raw(section,action_id):return ({'id':'core'},{'id':action_id,'handler':'handler'}) if self.available else (None,None)
  def enabled(domain):
   if not self.enabled:raise Denied('domain disabled')
  core=ModuleType('shangshu_core');core.__path__=[str(ROOT/'frappe_apps/shangshu_core/shangshu_core')];core.__version__='0.19.0'
  modules={'frappe':fake,'shangshu_core':core,'shangshu_core.actions':SimpleNamespace(**action_ctx,_definition=action_definition),
    'shangshu_core.domains':SimpleNamespace(raw_resource=raw,assert_domain_enabled=enabled,invoke_domain_service=service),
    'shangshu_core.objects':SimpleNamespace(get_object_definition=lambda obj:deepcopy(self.definition)),
    'shangshu_core.model_records':SimpleNamespace(get_records=getrecords),
    'shangshu_core.record_import_xlsx':SimpleNamespace(input_schema=lambda:{}),
    'shangshu_core.input_constraints':SimpleNamespace(input_schema=lambda:{}),
    'shangshu_core.record_values':SimpleNamespace(input_schema=lambda:{})}
  self.patcher=patch.dict(sys.modules,modules);self.patcher.start();self.addCleanup(self.patcher.stop)
  validation=module('recover_schema_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/schema_validation.py')
  modules['shangshu_core.actions']._validate_schema=validation._validate_schema
  self.m=module('proposal_recovery_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/proposal_values.py')
  self.domain=module('recover_domain_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/domain.py')
 def recover(self):
  self.doc.payload_json=json.dumps(self.payload,ensure_ascii=False)
  return self.m.read('platform.action_proposal.values',{'proposal_id':'p1'})
 def companion(self):
  self.doc.action_id='platform.object.companion_write'
  self.payload={'object_id':'obj','file_id':'file','definition_revision':5,'expected_revision':3,'expected_modified':{'r1':'ORIGINAL'},'expected_content_version':4,'expected_structure_version':2,'op_id':'op', 'cells':[{'row_id':'r1','header':'金额','value':{'type':'number','value':0}}]}
 def test_registration_is_explicit_read_and_not_an_agent_detail_directory(self):
  rows=[s for s in self.domain.get_contribution()['services'] if s['id']=='platform.action_proposal.values']
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['effect'],'read');self.assertNotIn(rows[0].get('purpose'),['detail','directory'])
  manifest=(ROOT/'frappe_apps/shangshu_core/shangshu-plugin.yml').read_text();self.assertEqual(manifest.count('    - platform.action_proposal.values\n'),1)
 def test_original_delta_and_versions_return_unchanged_without_current_record_values(self):
  result=self.recover();self.assertEqual(result,{'id':'p1','capability':self.doc.action_id,'payload':self.payload})
  self.assertEqual(self.calls[-1],('rows','obj',['r1'],{'fields':[],'read_scope':{'mode':'rows','purpose':'interactive'}}))
  self.assertEqual(result['payload']['records'][0]['expected_modified'],'ORIGINAL');self.assertNotIn('LATEST',json.dumps(result))
 def test_real_actor_enterprise_role_and_identity_guards_cannot_be_bypassed(self):
  cases=[('user','other'),('enterprise','other'),('roles',[]),('active',False),('enabled',False),('available',False)]
  for key,value in cases:
   with self.subTest(key=key):
    self.setUp()
    if key=='user':self.frappe.session.user=value
    elif key=='enterprise':self.doc.enterprise_id=value
    else:setattr(self,key,value)
    with self.assertRaises(Denied):self.recover()
 def test_hidden_unknown_fields_native_objects_and_row_revocation_are_rejected(self):
  self.payload['records'][0]['values']['secret']='private'
  with self.assertRaises(Denied):self.recover()
  self.payload['records'][0]['values'].pop('secret');self.definition['source']='native'
  with self.assertRaises(Invalid):self.recover()
  self.definition['source']='managed';self.row_allowed=False
  with self.assertRaises(Denied):self.recover()
 def test_rows_fields_and_cells_have_independent_budgets(self):
  for records in [[{'name':'r'+str(i),'expected_modified':'v','values':{'amount':i}} for i in range(51)],
                  [{'name':'r1','expected_modified':'v','values':{'f'+str(i):i for i in range(65)}}],
                  [{'name':'r'+str(i),'expected_modified':'v','values':{**{'f'+str(j):j for j in range(40)},**({'extra':1} if i==0 else {})}} for i in range(50)]]:
   with self.subTest(records=len(records)),self.assertRaises(Invalid):
    self.payload['records']=records;self.recover()
 def test_utf8_budget_is_bytes_and_extra_payload_keys_are_not_returned(self):
  self.payload['records'][0]['values']['amount']='汉'*400000
  with self.assertRaisesRegex(Invalid,'1MiB'):self.recover()
  self.payload['records'][0]['values']['amount']=0;self.payload['credential']='must-not-leak'
  with self.assertRaises(Invalid):self.recover()
 def test_other_action_and_unknown_status_are_not_recoverable(self):
  self.doc.action_id='mail.save_draft'
  with self.assertRaises(Invalid):self.recover()
  self.doc.action_id='platform.object.update_many';self.doc.status='Executing'
  with self.assertRaises(Invalid):self.recover()
 def test_terminal_history_keeps_original_delta_under_current_authority(self):
  self.doc.status='Confirmed';self.assertEqual(self.recover()['payload'],self.payload)
 def test_companion_rechecks_only_its_exact_targets_and_preserves_original_versions(self):
  self.companion();result=self.recover();self.assertEqual(result['payload'],self.payload)
  self.assertEqual(self.calls[-1],('service','files.sheet_read',{'table':'file','row_ids':['r1'],'headers':['金额']}))
  self.assertNotIn('777',json.dumps(result));self.assertEqual(result['payload']['expected_modified'],{'r1':'ORIGINAL'})
 def test_companion_binding_hidden_cell_missing_row_and_source_revocation_reject(self):
  for case in ['file','revision','source','hidden','row','permission']:
   with self.subTest(case=case):
    self.setUp();self.companion()
    if case=='file':self.definition['companion']['file_id']='other'
    elif case=='revision':self.definition['companion']['definition_revision']=6
    elif case=='source':self.definition['fields']=[]
    elif case=='hidden':self.file_rows[0]['values']['金额']={'type':'hidden','hidden':True,'value':None}
    elif case=='row':self.file_rows=[]
    else:self.file_allowed=False
    with self.assertRaises(Denied):self.recover()
 def test_input_is_one_explicit_proposal_and_complex_fields_do_not_leak_children(self):
  with self.assertRaises(Invalid):self.m.read(None,{'proposal_id':'p1','page':1})
  self.payload['records'][0]['values']['amount']={'secret_child':'no'}
  with self.assertRaises(Invalid):self.recover()
if __name__=='__main__':unittest.main()
