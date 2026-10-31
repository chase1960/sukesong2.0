"""Actual audit authorization and fact source handling, without Frappe I/O."""
import importlib,importlib.util,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment,load_module_functions
# These suites isolate unrelated persistence; actual provenance has its own tests.
sys.modules['shangshu_core.action_provenance']=SimpleNamespace(
    current_action_provenance=lambda action_id,action_version=None:None,
    process_action_version=lambda action_id:None,
    project_action_provenance=lambda raw:{'status':'not_linked','trusted':False})
ROOT=Path(__file__).resolve().parents[2]
RECEIPTS=ROOT/'frappe_apps/shangshu_core/shangshu_core/receipts.py'
ORG_ADMIN=ROOT/'frappe_apps/shangshu_core/shangshu_core/org_admin.py'
install_real_environment()
# 内核模块在「frappe 还是桩」的时候先 import 一次：下面各支会把 `sys.modules['frappe']`
# 换成测试自己的假 frappe（那不是个包）⇒ 内核模块那时再 import 就找不着 `frappe.utils` 了。
for _name in ('shangshu_core.actions','shangshu_core.domains','shangshu_core.identity','shangshu_core.unified_log'):
    importlib.import_module(_name)
class Denied(Exception):pass
class Invalid(Exception):pass
def throw(m,e):raise e(m)
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def unified_log_stub(frappe):
    """统一日志表（落库那一层）这一支不接库 ⇒ 合并读口按老口径桩掉：
    计数走 `frappe.db.count`、取行走 `frappe.get_all`，**两者拿同一份 scope 过滤**。
    统一表里没有新行（这一支只有旧表的历史行）⇒ `unified_rows` 恒空。"""
    def merged_legacy_count(legacy_doctype,kind,filters=None,projector=None):
        return frappe.db.count(legacy_doctype,filters or {})
    def merged_legacy_rows(legacy_doctype,kind,filters=None,fields=None,
                           order_by='creation desc, name desc',limit_page_length=0,
                           limit_start=0,projector=None):
        return frappe.get_all(legacy_doctype,filters=filters or {},fields=fields or ['*'],
            order_by=order_by,limit_start=limit_start,limit_page_length=limit_page_length)
    def unified_rows(kind,filters=None,order_by='creation desc, name desc',
                     limit_page_length=0,limit_start=0):
        return []
    def project_action_row(row):return row
    class LegacyRow(dict):
        def __getattr__(self,item):
            try:return self[item]
            except KeyError:raise AttributeError(item)
    return SimpleNamespace(merged_legacy_count=merged_legacy_count,
        merged_legacy_rows=merged_legacy_rows,unified_rows=unified_rows,
        project_action_row=project_action_row,LegacyRow=LegacyRow,
        LOG_DOCTYPE='Shangshu Unified Log')
class ScopeTests(unittest.TestCase):
 def setUp(self):
  self.roles=[];self.calls=[];self.org={'owned_enterprises':[],'head_departments':[]}
  self.identities=[{'name':'i','user':'me','identity_id':'i','collaboration_key':'local-me'},
                   {'name':'staff-a','user':'a','identity_id':'staff-a','collaboration_key':'local-a'},
                   {'name':'staff-child','user':'child','identity_id':'staff-child','collaboration_key':'local-child'},
                   {'name':'staff-b','user':'b','identity_id':'staff-b','collaboration_key':'local-b'}]
  def get_all(kind,**kw):
   self.calls.append((kind,kw))
   if kind=='Shangshu Identity':return self.identities
   if kind=='Shangshu Org Member':return ['a','child']
   raise AssertionError(kind)
  self.fr=SimpleNamespace(session=SimpleNamespace(user='me'),get_roles=lambda:self.roles,throw=throw,PermissionError=Denied,ValidationError=Invalid,get_all=get_all)
  sys.modules['frappe']=self.fr
  sys.modules['shangshu_core.identity']=SimpleNamespace(get_identity=lambda:SimpleNamespace(name='i',identity_id='i',collaboration_key='local-me',enterprise_id='enterprise-A'))
  sys.modules['shangshu_core.org_admin']=SimpleNamespace(org_context=lambda u:self.org)
  self.m=module('audit_access_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/audit_access.py')
 def test_self_cannot_inject_other_actor(self):
  with self.assertRaises(Denied):self.m.audit_query_filters({'actor_user':'someone'},'self')
  self.assertEqual(self.calls,[])
 def test_self_bound_to_immutable_identity(self):
  self.assertEqual(self.m.audit_query_filters({},'self'),{'actor_user':'me','actor_identity':['in',['i']]})
 def test_resource_manager_role_does_not_authorize_global_logs(self):
  self.roles=['Desk User','Manager']
  with self.assertRaises(Denied):self.m.audit_query_filters({},'all')
 def test_ordinary_managed_query_is_still_only_self(self):
  self.assertEqual(self.m.audit_query_filters({},'managed')['actor_identity'],['in',['i']])
  with self.assertRaises(Denied):self.m.authorize_audit_actor('a')
 def test_operations_all_is_limited_to_authenticated_enterprise(self):
  self.roles=['System Manager'];out=self.m.audit_query_filters({},'all')
  self.assertEqual(out['actor_identity'],['in',['i','staff-a','staff-child','staff-b']])
  self.assertEqual(self.calls[0][1]['filters'],{'enterprise_id':'enterprise-A'})
 def test_company_owner_read_is_not_system_manager_bypass(self):
  self.org['owned_enterprises']=['enterprise-A']
  self.assertEqual(self.m.authorize_audit_actor('b')['collaboration_key'],'local-b')
 def test_department_head_scope_includes_child_not_neighbor(self):
  self.org['head_departments']=['dept-A','dept-child']
  self.assertEqual(self.m.audit_query_filters({},'managed')['actor_identity'],['in',['i','staff-a','staff-child']])
  self.assertEqual(self.m.authorize_audit_actor('child')['user'],'child')
  with self.assertRaises(Denied):self.m.authorize_audit_actor('b')
 def test_revoking_appointment_takes_effect_next_call(self):
  self.org['head_departments']=['dept-A'];self.m.authorize_audit_actor('a')
  self.org['head_departments']=[]
  with self.assertRaises(Denied):self.m.authorize_audit_actor('a')
 def test_owner_of_other_enterprise_gets_no_current_enterprise_expansion(self):
  self.org['owned_enterprises']=['enterprise-B']
  with self.assertRaises(Denied):self.m.authorize_audit_actor('a')
 def test_outside_enterprise_target_rejected(self):
  self.roles=['System Manager']
  with self.assertRaises(Denied):self.m.audit_query_filters({'actor_user':'foreign'},'all')
 def test_actor_filter_cannot_be_operator_injection(self):
  with self.assertRaises(Invalid):self.m.audit_query_filters({'actor_user':['!=','me']},'all')

class SourceTests(unittest.TestCase):
 def test_source_comes_from_execution_context_never_claimed_detail(self):
  fr=SimpleNamespace(session=SimpleNamespace(user='real'),get_roles=lambda:['Desk User'],throw=throw,ValidationError=Invalid)
  sys.modules['frappe']=fr
  sys.modules['shangshu_core.public_api']=SimpleNamespace(current_actor_organization_snapshot=lambda:{'user':'real','departments':[{'id':'dep-A','title':'原部门'}]})
  m=module('facts_source_actual',ROOT/'frappe_apps/shangshu_files/shangshu_files/facts.py');m._find_by_op=lambda op:None
  payload={'op_id':'op','action':'copy.range','detail':{'source':'user','identity':{'user':'forged'}}}
  for source in ('ai','scheduler','user'):
   result=m.action_fact(payload,{'source':source})
   self.assertEqual(result['identity']['source'],source)
   self.assertEqual(result['identity']['user'],'real')
   self.assertEqual(result['identity']['departments'],[{'id':'dep-A','title':'原部门'}])
  self.assertEqual(m.action_fact(payload,None)['identity']['source'],'unknown')

class OrganizationSnapshotTests(unittest.TestCase):
 def test_snapshot_uses_authenticated_user_and_all_direct_appointments(self):
  calls=[]
  def org(user):
   calls.append(user);return {'member_of':['b','a','a'],'head_departments':['foreign-descendant']}
  # 真模块装载：`org_context`／`department_title` 这些**同文件兄弟自动跟着进来**，
  # 本支自己给的两份桩（任职集合、部门名）随后覆盖上去。
  ctx=load_module_functions(ORG_ADMIN,['current_actor_organization_snapshot'],
      stubs={'frappe':SimpleNamespace(session=SimpleNamespace(user='real'))})
  ctx.update({'org_context':org,'department_title':lambda key:{'a':'旧部门','b':'兼任部门'}[key]})
  saved=ctx['current_actor_organization_snapshot']()
  self.assertEqual(calls,['real'])
  self.assertEqual(saved,{'user':'real','departments':[{'id':'a','title':'旧部门'},{'id':'b','title':'兼任部门'}]})
 def test_read_uses_saved_snapshot_not_current_department(self):
  import json
  saved={'user':'real','department':'旧部门','departments':[{'id':'a','title':'旧部门'}]}
  rows=[{'name':'audit1','input_summary_json':'{"op_id":"op"}','result_summary_json':json.dumps({'identity':saved})},
        {'name':'old-audit','input_summary_json':'{}'}]
  sys.modules['shangshu_core.public_api']=SimpleNamespace(query_action_fact_audits=lambda *a:rows)
  sys.modules['frappe']=SimpleNamespace()
  m=module('facts_snapshot_read',ROOT/'frappe_apps/shangshu_files/shangshu_files/facts.py')
  out=m._rows_for({},'self')
  self.assertEqual(out[0]['identity'],saved)
  self.assertIsNone(out[1]['identity']) # historical missing evidence is not invented

class QueryTests(unittest.TestCase):
 def setUp(self):
  self.scope=['own'];self.calls=[]
  self.rows=[{'name':'A1','actor_identity':'own','actor_user':'me','action_id':'files.cell_write','executor_source':'ai','input_summary_json':'{"op_id":"op1"}','result_summary_json':'{"saved":true}','confirmation_text':'提案 APROP-2026-00001 逐项审核 1 项'},
             {'name':'A2','actor_identity':'other','actor_user':'colleague','action_id':'mail.save_draft','input_summary_json':'{}','result_summary_json':'{}'}]
  def scoped(filters,scope):
   if filters.get('actor_user')=='foreign':raise Denied('outside')
   return {**filters,'actor_identity':['in',list(self.scope)]}
  def matching(filters):return [r for r in self.rows if r['actor_identity'] in filters['actor_identity'][1] and all(r.get(k)==v for k,v in filters.items() if k!='actor_identity')]
  def count(kind,filters):self.calls.append(('count',filters));return len(matching(filters))
  def get_all(kind,**kw):
   self.calls.append(('rows',kw['filters']))
   return matching(kw['filters'])[kw['limit_start']:kw['limit_start']+kw['limit_page_length']]
  sys.modules['shangshu_core.audit_access']=SimpleNamespace(audit_query_filters=scoped)
  fr=SimpleNamespace(throw=throw,ValidationError=Invalid,db=SimpleNamespace(count=count),get_all=get_all)
  # 真模块装载：`_audit_row`／`_audit_row_by_idempotency` 这些**同文件兄弟自动跟着进来**。
  self.ctx=load_module_functions(RECEIPTS,['query_action_audits'],
      stubs={'frappe':fr,'unified_log':unified_log_stub(fr)})
 def test_all_action_types_have_same_pre_pagination_scope(self):
  out=self.ctx['query_action_audits']({},1,1)
  self.assertEqual(out['total'],1);self.assertFalse(out['has_more'])
  self.assertEqual(out['items'][0]['action_id'],'files.cell_write')
  self.assertEqual(self.calls[0][1],self.calls[1][1])
  self.scope=['own','other'];out=self.ctx['query_action_audits']({},2,1)
  self.assertEqual(out['total'],2);self.assertEqual(out['items'][0]['action_id'],'mail.save_draft')
 def test_source_and_proposal_reference_do_not_invent_dialogue(self):
  out=self.ctx['query_action_audits']()['items'][0]
  self.assertEqual(out['source'],'ai');self.assertEqual(out['op_id'],'op1')
  self.assertEqual(out['proposal_reference'],'APROP-2026-00001')
  self.assertEqual(out['conversation_evidence'],{'status':'not_linked','reference':None})
  self.rows[0]['executor_source']=None
  self.assertEqual(self.ctx['query_action_audits']()['items'][0]['source'],'unknown')
 def test_filter_operator_and_invalid_page_rejected_before_query(self):
  for filters in ({'actor_identity':'other'},{'status':['!=','Failed']}):
   with self.assertRaises(Invalid):self.ctx['query_action_audits'](filters)
  for p,size in [(0,1),(1,201),(True,20)]:
   with self.assertRaises(Invalid):self.ctx['query_action_audits']({},p,size)
  self.assertEqual(self.calls,[])
 def test_conversation_filter_and_evidence_are_persisted(self):
  self.rows[0]['conversation_key']='conv-test'
  out=self.ctx['query_action_audits']({'conversation_key':'conv-test'})
  self.assertEqual(out['total'],1)
  self.assertEqual(out['items'][0]['conversation_evidence'],{'status':'linked','reference':'conv-test'})
 def test_out_of_scope_actor_refused_before_count(self):
  with self.assertRaises(Denied):self.ctx['query_action_audits']({'actor_user':'foreign'})
  self.assertEqual(self.calls,[])

class ProposalEvidenceTests(unittest.TestCase):
 def setUp(self):
  self.allowed=True;self.reads=0
  class Proposal(SimpleNamespace):
   def get(obj,key):return getattr(obj,key,None)
  self.p=Proposal(name='p',actor_user='worker',enterprise_id='e',action_id='files.write',action_version='1',status='Confirmed',execution_audit='audit-1',review_state_json='{"accepted":{"u":{"by":"reviewer","at":"today","audit":"audit-1"}}}',payload_json='secret candidate')
  def authorize(user):
   if not self.allowed:raise Denied('outside')
   return {'user':'worker','enterprise_id':'e'}
  def get_doc(*a):self.reads+=1;return self.p
  sys.modules['shangshu_core.audit_access']=SimpleNamespace(authorize_audit_actor=authorize)
  fr=SimpleNamespace(get_doc=get_doc,throw=throw,ValidationError=Invalid,PermissionError=Denied,
      get_all=lambda *a,**kw:[{'name':'audit-1','actor_user':'reviewer','status':'Succeeded','action_id':'files.write'}])
  # 真模块装载：同文件兄弟函数自动跟着进来；统一日志读口按老口径桩掉（这一支不接库）。
  self.ctx=load_module_functions(RECEIPTS,['get_audit_proposal'],
      stubs={'frappe':fr,'unified_log':unified_log_stub(fr)})
 def test_authorized_manager_gets_decision_not_candidate_or_review_capability(self):
  out=self.ctx['get_audit_proposal']('worker','p')
  self.assertEqual(out['proposal']['status'],'confirmed');self.assertEqual(out['accepted_count'],1)
  self.assertEqual(out['receipts'][0]['audit'],'audit-1')
  self.assertFalse(out['can_confirm']);self.assertFalse(out['payload_included'])
  self.assertNotIn('secret candidate',str(out))
 def test_actor_authorization_runs_before_proposal_lookup(self):
  self.allowed=False
  with self.assertRaises(Denied):self.ctx['get_audit_proposal']('worker','p')
  self.assertEqual(self.reads,0)
 def test_authorized_actor_cannot_select_another_actor_proposal(self):
  self.p.actor_user='another'
  with self.assertRaises(Denied):self.ctx['get_audit_proposal']('worker','p')
 def test_same_user_other_enterprise_proposal_denied(self):
  self.p.enterprise_id='other'
  with self.assertRaises(Denied):self.ctx['get_audit_proposal']('worker','p')


class TraceTests(unittest.TestCase):
 def setUp(self):
  class Doc(dict):
   def __getattr__(self,k):return self.get(k)
  self.allowed=True;self.calls=[]
  self.p=Doc(name='APROP-1',actor_user='worker',actor_identity='i',enterprise_id='e',action_id='files.write',idempotency_key='request',execution_audit='audit',review_state_json='{}')
  self.a=Doc(name='audit',actor_user='reviewer',actor_identity='r',action_id='files.write',idempotency_key='review-key',confirmation_text='')
  self.rows={'Shangshu Action Proposal':[self.p],'Shangshu Action Execution Audit':[self.a]}
  def auth(user):
   if not self.allowed:raise Denied('scope')
   return {'user':'worker','identity_id':'i','enterprise_id':'e'}
  def query(kind,**kw):
   self.calls.append((kind,kw))
   return [r['name'] for r in self.rows[kind] if all(r.get(k)==v for k,v in kw['filters'].items())][:kw['limit_page_length']]
  def doc(kind,name):return next(r for r in self.rows[kind] if r['name']==name)
  def value(kind,name,fields,as_dict=False):
   self.calls.append((kind,{'name':name}))
   row=next((r for r in self.rows.get(kind,[]) if r['name']==name),None)
   return Doc({field:row.get(field) for field in fields}) if row else None
  fr=SimpleNamespace(throw=throw,ValidationError=Invalid,PermissionError=Denied,get_all=query,get_doc=doc,
      db=SimpleNamespace(exists=lambda k,n:any(r['name']==n for r in self.rows.get(k,[])),get_value=value))
  sys.modules['shangshu_core.audit_access']=SimpleNamespace(authorize_audit_actor=auth)
  # 真模块装载：`_audit_row`／`_audit_row_by_idempotency` 这些**同文件兄弟自动跟着进来**；
  # 统一日志读口按老口径桩掉（这一支不接库）。
  ctx=load_module_functions(RECEIPTS,['get_audit_trace'],
      stubs={'frappe':fr,'unified_log':unified_log_stub(fr)});self.trace=ctx['get_audit_trace']
 def test_pending_request_recovers_proposal_without_executing(self):
  self.p.execution_audit=None;self.p['execution_audit']=None
  out=self.trace('worker',request_id='request');self.assertEqual(out['proposal_id'],'APROP-1');self.assertIsNone(out['operation_id']);self.assertFalse(out['can_confirm'])
 def test_actual_review_audit_recovers_original_request(self):
  out=self.trace('worker',operation_id='audit');self.assertEqual(out['request_id'],'request');self.assertEqual(out['actor_user'],'worker')
 def test_partial_audit_requires_real_stored_reference(self):
  self.p['execution_audit']=None;self.a['confirmation_text']='提案 APROP-1 逐项审核 1 项'
  with self.assertRaises(Denied):self.trace('worker',operation_id='audit')
  self.p['review_state_json']='{"accepted":{"u":{"audit":"audit"}}}'
  self.assertEqual(self.trace('worker',operation_id='audit')['proposal_id'],'APROP-1')
 def test_direct_actor_audit_and_unknown_key(self):
  self.rows['Shangshu Action Proposal']=[];self.a.update(actor_user='worker',actor_identity='i')
  self.assertEqual(self.trace('worker',request_id='review-key')['operation_id'],'audit')
  self.assertEqual(self.trace('worker',request_id='unknown')['status'],'not_linked')
 def test_foreign_actor_and_enterprise_not_recovered(self):
  self.p['enterprise_id']='foreign'
  with self.assertRaises(Denied):self.trace('worker',operation_id='audit')
  self.assertEqual(self.trace('worker',request_id='request')['status'],'not_linked')
 def test_request_and_operation_mutually_exclusive_and_authorize_first(self):
  with self.assertRaises(Invalid):self.trace('worker',operation_id='audit',request_id='request')
  self.allowed=False
  with self.assertRaises(Denied):self.trace('worker',request_id='request')
  self.assertEqual(self.calls,[])
 def test_action_mismatch_never_links(self):
  self.a['action_id']='mail.send'
  with self.assertRaises(Invalid):self.trace('worker',operation_id='audit')
 def child_request(self):
  import hashlib
  self.rows['Shangshu Action Proposal']=[]
  self.a.update(actor_user='worker',actor_identity='i',action_id='files.sheet_cells_write',idempotency_key='root-key',
      package={'version':1,'steps':[{'action_id':'platform.object.update_many','action_version':'1.1.0','idempotency_key':'child-key'}]})
  row={'name':hashlib.sha256(b'child-key').hexdigest(),'actor_identity':'i','enterprise_id':'e',
       'action_id':'platform.object.update_many','action_version':'1.1.0','status':'Succeeded','execution_audit':'audit'}
  self.rows['Shangshu Action Request']=[row]
  return row
 def test_child_request_resolves_root_log_without_returning_package(self):
  self.child_request();out=self.trace('worker',request_id='child-key')
  self.assertEqual(out['operation_id'],'audit');self.assertEqual(out['request_id'],'child-key')
  self.assertEqual(out['action_id'],'platform.object.update_many');self.assertFalse(out['can_confirm'])
  self.assertNotIn('package',out)
 def test_child_key_from_other_identity_or_enterprise_is_denied(self):
  row=self.child_request()
  for key in ('actor_identity','enterprise_id'):
   before=row[key];row[key]='foreign'
   with self.assertRaises(Denied):self.trace('worker',request_id='child-key')
   row[key]=before
 def test_child_request_cannot_link_other_actor_root_or_unlisted_step(self):
  self.child_request();self.a['actor_identity']='foreign'
  with self.assertRaises(Denied):self.trace('worker',request_id='child-key')
  self.a['actor_identity']='i';self.a['package']['steps'][0]['idempotency_key']='other-key'
  with self.assertRaises(Invalid):self.trace('worker',request_id='child-key')

class ProcessQueryTests(unittest.TestCase):
 def setUp(self):
  import sqlite3,json
  self.scope=['own'];self.calls=[];self.extensions=[];self.decoded=[];self.deny=False
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
  self.addCleanup(self.db.close)
  self.db.execute('CREATE TABLE `tabShangshu Unified Log` (name TEXT, log_no TEXT, occurred_at TEXT, creation TEXT, actor_identity TEXT, actor_user TEXT, what_kind TEXT, domain_id TEXT, what_id TEXT, result TEXT, trigger_source TEXT, business_object_id TEXT, business_name TEXT, detail_json TEXT)')
  self.rows=[]
  for i in range(13):
   self.add(name='L%02d'%i,occurred_at='2026-10-28 12:00:%02d'%i,actor_identity='own')
  self.add(name='foreign-newest',occurred_at='2099-01-01',actor_identity='foreign')
  self.add(name='other-record',occurred_at='2099-01-02',actor_identity='own',business_name='other')
  self.add(name='other-object',occurred_at='2099-01-03',actor_identity='own',business_object_id='foreign-object')
  self.add(name='other-kind',occurred_at='2099-01-04',actor_identity='own',what_kind='action')
  def scoped(filters,scope):
   self.calls.append(('authorize',scope))
   if self.deny:raise Denied('独立日志权限拒绝')
   return {'actor_identity':['in',self.scope]}
  def sql(query,values=(),as_dict=False):
   self.calls.append(('sql',query,tuple(values)))
   return [dict(row) for row in self.db.execute(query.replace('%s','?'),values)]
  def old_rows(kind,filters=None,**kw):
   self.calls.append(('full-read',kind,filters,kw))
   return [dict(row) for row in self.rows if row['what_kind']==kind and all(row.get(k)==v for k,v in (filters or {}).items())]
  def extension(log_no):self.extensions.append(log_no);return {'marker':log_no}
  sys.modules['shangshu_core.audit_access']=SimpleNamespace(audit_query_filters=scoped)
  fr=SimpleNamespace(throw=throw,ValidationError=Invalid,db=SimpleNamespace(sql=sql))
  self.ctx=load_module_functions(ROOT/'frappe_apps/shangshu_core/shangshu_core/process_log.py', ['query_process_records'],
      stubs={'frappe':fr,'unified_log':SimpleNamespace(unified_rows=old_rows,read_extension=extension,LOG_DOCTYPE='Shangshu Unified Log')})
  self.query=self.ctx['query_process_records']
 def add(self,**values):
  import json
  row={'name':'L','log_no':values['name'],'occurred_at':None,'creation':'2026-10-01 00:00:00',
       'actor_identity':'own','actor_user':'me','what_kind':'process','domain_id':'domain',
       'what_id':'work.done','result':'Succeeded','trigger_source':'user',
       'business_object_id':'object','business_name':'record','detail_json':json.dumps({'name':values['name']})}
  row.update(values);self.rows.append(row)
  self.db.execute('INSERT INTO `tabShangshu Unified Log` VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
 def test_authorized_page_only_loads_current_details_and_extensions(self):
  import json
  from unittest.mock import patch
  for i in range(1000):self.add(name='history-%04d'%i,occurred_at='2020-01-01 00:00:00')
  loads=json.loads
  def decode(raw):self.decoded.append(raw);return loads(raw)
  with patch('json.loads',side_effect=decode):out=self.query('object','record',page=2,page_length=3)
  self.assertEqual([row['log_no'] for row in out['items']],['L09','L08','L07'])
  self.assertEqual(self.extensions,['L09','L08','L07'])
  self.assertEqual(len(self.decoded),3)
  self.assertEqual(self.calls[0],('authorize','managed'))
  self.assertEqual([row[0] for row in self.calls],['authorize','sql'])
  self.assertEqual(out['page'],2);self.assertEqual(out['page_length'],3)
  self.assertEqual(out['scope'],'managed');self.assertEqual(out['llm_calls'],0)
  self.assertEqual(out['items'][0]['detail'],{'name':'L09'})
  self.assertEqual(out['items'][0]['domain_fields'],{'marker':'L09'})
 def test_effective_time_fallback_stable_ties_and_no_offpage_extensions(self):
  self.add(name='T1',occurred_at=None,creation='2026-10-30 00:00:00')
  self.add(name='T2',occurred_at='2026-10-30 00:00:00',creation='2000-01-01')
  self.add(name='T3',occurred_at='2026-10-29 00:00:00',creation='2099-01-01')
  out=self.query('object','record',page=1,page_length=2)
  self.assertEqual([row['log_no'] for row in out['items']],['T2','T1'])
  self.assertEqual(self.extensions,['T2','T1'])
  self.extensions.clear()
  second=self.query('object','record',page=2,page_length=2)
  self.assertEqual([row['log_no'] for row in second['items']],['T3','L12'])
  self.assertEqual(self.extensions,['T3','L12'])
  self.assertEqual(second['items'][0]['time'],'2026-10-29 00:00:00')
 def test_empty_scope_and_denial_do_not_query_or_expand(self):
  self.scope=[];self.assertEqual(self.query('object')['items'],[])
  self.assertEqual(self.calls,[('authorize','managed')]);self.assertEqual(self.extensions,[])
  self.calls.clear();self.scope=['',None,1]
  self.assertEqual(self.query('object')['items'],[])
  self.assertEqual(self.calls,[('authorize','managed')])
  self.calls.clear();self.deny=True
  with self.assertRaises(Denied):self.query('object')
  self.assertEqual(self.calls,[('authorize','managed')])
 def test_out_of_range_page_does_not_expand_or_decode_other_rows(self):
  self.assertEqual(self.query('object','record',page=99,page_length=3)['items'],[])
  self.assertEqual(self.extensions,[])
 def test_business_identifier_is_literal_and_revocation_applies_next_read(self):
  self.assertEqual(self.query("object' OR 1=1 --",'record')['items'],[])
  self.assertEqual(self.extensions,[])
  sql=[call for call in self.calls if call[0]=='sql']
  self.assertEqual(len(sql),1);self.assertNotIn("object' OR",sql[0][1]);self.assertIn("object' OR 1=1 --",sql[0][2])
  self.calls.clear();self.scope=['foreign']
  self.assertEqual([row['log_no'] for row in self.query('object','record')['items']],['foreign-newest'])
  self.scope=[];self.calls.clear();self.extensions.clear()
  self.assertEqual(self.query('object','record')['items'],[])
  self.assertEqual(self.calls,[('authorize','managed')]);self.assertEqual(self.extensions,[])
 def test_invalid_pagination_or_record_name_fails_before_authorization_or_sql(self):
  for kw in ({'page':0},{'page':True},{'page_length':201},{'business_name':' '},{'object_id':''}):
   with self.subTest(kw=kw),self.assertRaises(Invalid):self.query(**{'object_id':'object',**kw})
  self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
