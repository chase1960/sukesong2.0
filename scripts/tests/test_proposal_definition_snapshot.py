"""Actual proposal snapshot/capture code, with only Frappe persistence replaced."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions
# These suites isolate unrelated persistence; actual provenance has its own tests.
sys.modules['shangshu_core.action_provenance']=SimpleNamespace(
    current_action_provenance=lambda action_id,action_version=None:None,
    process_action_version=lambda action_id:None,
    project_action_provenance=lambda raw:{'status':'not_linked','trusted':False})
ROOT=Path(__file__).resolve().parents[2]
ACTIONS_PY=ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py'
# 真 app 包装进 sys.path + 框架桩 —— 真模块才 import 得进来。
install_real_environment()
# **真** _json：null/空串返回默认值、dict/list 原样返回、其余按 JSON 解析。
# 假 _json（json.loads(s)）在提案没带 review_state_json 时拿 None 去 loads，直接炸。
REAL_JSON=load_module_functions(ACTIONS_PY,['_json'])['_json']
class Stale(Exception): pass
class Denied(Exception): pass
class Invalid(Exception): pass
class Doc(dict):
    def __getattr__(self,key):return self.get(key)
    def check_permission(self,*_):
        if self.get('denied'):raise Denied('revoked')
    def insert(self,**_):return self

def load_funcs(path,names,context):
    nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names]
    for n in nodes:n.decorator_list=[]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),context)

def throw(message,kind):raise kind(message)
class Tests(unittest.TestCase):
    def setUp(self):
        self.meta={'structure_version':1,'promotion':{'structure_version':1,'columns':[{'header':'金额','field':'amount','promoted':True,'rules':{'min':0}}]}}
        self.doc=Doc(name='t');self.locks=[];self.rule_checks=[]
        def get_doc(kind,name,**kw):self.locks.append(kw.get('for_update'));return self.doc
        frappe=SimpleNamespace(throw=throw,ValidationError=Invalid,TimestampMismatchError=Stale,get_doc=get_doc)
        promotion=SimpleNamespace(require_package_rules_ok=lambda doc,items,definition=None:self.rule_checks.append(copy.deepcopy(items)),_load_meta=lambda d:copy.deepcopy(self.meta),_definition_fingerprint=lambda m:hashlib.sha256(json.dumps(m.get('promotion',{}).get('columns',[]),sort_keys=True).encode()).hexdigest())
        sys.modules['shangshu_files']=SimpleNamespace(promotion=promotion)
        self.ctx={'_project_proposal_payload':lambda a,p:{'payload':p,'redacted':False},'frappe':frappe,'DOCTYPE':'File'}
        load_funcs(ROOT/'frappe_apps/shangshu_files/shangshu_files/service.py',{'proposal_snapshot'},self.ctx)
        self.hook=self.ctx['proposal_snapshot']
    def test_unchanged_definition_passes_under_row_lock(self):
        pin=self.hook('files.cell_write',{'table':'t'},'capture')
        self.assertEqual(self.hook('files.cell_write',{'table':'t'},'validate',pin),pin)
        self.assertEqual(self.locks,[True,True])
    def test_legal_candidate_still_rejected_after_definition_semantics_change(self):
        pin=self.hook('files.cell_write',{'table':'t','header':'金额','value':{'type':'number','value':100}},'capture')
        self.meta['promotion']['columns'][0]['rules']['min']=50 # 100 remains legal
        with self.assertRaises(Stale):self.hook('files.cell_write',{'table':'t','header':'金额','value':{'type':'number','value':100}},'validate',pin)
    def test_client_supplied_snapshot_is_not_used_for_capture(self):
        pin=self.hook('files.cell_write',{'table':'t','promotion_definition_sha':'forged','definition_snapshot_json':'forged'},'capture')
        self.assertNotIn('forged',json.dumps(pin))
    def test_missing_old_snapshot_rejected(self):
        for old in (None,{},'fake',{'version':99}):
            with self.assertRaises(Stale):self.hook('files.cell_write',{'table':'t'},'validate',old)
    def test_unpromoted_to_promoted_is_drift(self):
        original=copy.deepcopy(self.meta);self.meta.pop('promotion')
        pin=self.hook('files.cell_write',{'table':'t'},'capture');self.meta=original
        with self.assertRaises(Stale):self.hook('files.cell_write',{'table':'t'},'validate',pin)
    def test_structure_change_rejects(self):
        pin=self.hook('files.cell_write',{'table':'t'},'capture');self.meta['structure_version']=2
        with self.assertRaises(Stale):self.hook('files.cell_write',{'table':'t'},'validate',pin)
    def test_capture_current_permission_required(self):
        self.doc['denied']=True
        with self.assertRaises(Denied):self.hook('files.cell_write',{'table':'t'},'capture')
    def test_non_table_action_does_not_get_new_requirement(self):
        self.assertIsNone(self.hook('files.create',{},'capture'))
        self.assertIsNone(self.hook('files.create',{},'validate'))
    def test_core_creation_stores_server_snapshot_outside_unchanged_payload(self):
        captured=[];payload={'table':'t','value':100}
        action=SimpleNamespace(input_schema_json='{}',effect='write',confirmation_policy='required',action_version='1')
        class DB:
            def get_value(self,*_):return None
        frappe=SimpleNamespace(session=SimpleNamespace(user='u'),db=DB(),get_doc=lambda d:Doc(d),throw=throw,PermissionError=Denied,ValidationError=Invalid,DoesNotExistError=Invalid)
        ctx={'frappe':frappe,'raw_resource':lambda *a:({'id':'files'},{'handler':'h'}),'assert_domain_enabled':lambda *a:None,'_definition':lambda *a:action,'_assert_action_role':lambda *a:None,'_assert_proposable':lambda *a:None,'_validate_schema':lambda *a:None,'_json':REAL_JSON,'get_identity':lambda:SimpleNamespace(name='i',enterprise_id='e'),'_canonical':lambda v:json.dumps(v,sort_keys=True),'_summary':lambda v:v,'_capture_proposal_definition':lambda a,v:captured.append(copy.deepcopy(v)) or {'trusted':'server'},'_proposal_public':lambda p:p}
        load_funcs(ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py',{'propose_registered_action'},ctx)
        p=ctx['propose_registered_action']('files.cell_write',payload,idempotency_key='k')
        self.assertEqual(json.loads(p.payload_json),payload)
        self.assertEqual(json.loads(p.definition_snapshot_json),{'trusted':'server'})
        self.assertEqual(captured,[payload])
        # A newly registered 2.0 schema must not replace the process's 1.0 pin.
        versions=[]
        def definition(action_id,version=None):
            versions.append(version)
            return SimpleNamespace(input_schema_json='{}',effect='write',confirmation_policy='required',action_version=version or '2.0.0')
        ctx['_definition']=definition
        provenance=sys.modules['shangshu_core.action_provenance']
        old=provenance.process_action_version
        provenance.process_action_version=lambda _: '1.0.0'
        try:
            pinned=ctx['propose_registered_action']('files.cell_write',payload,idempotency_key='process-key')
            self.assertEqual(pinned.action_version,'1.0.0');self.assertEqual(versions,['1.0.0'])
        finally:provenance.process_action_version=old

class WholeProposalTests(unittest.TestCase):
    def setUp(self):
        self.current=True;self.calls=[];self.eligible=True
        class Proposal(SimpleNamespace):
            def get(obj,key):return getattr(obj,key,None)
            def save(obj,**kw):return obj
        self.p=Proposal(name='p',action_id='fixture.write',action_version='1',enterprise_id='e',actor_user='u',payload_json='{}',status='Proposed',idempotency_key='key',created_via='ai',reference_execution=None)
        def guard(p):
            self.calls.append('definition')
            if not self.current:raise Stale('changed')
        def execute(*a,**kw):self.calls.append('execute');return {'result':{'saved':True},'audit':'a'}
        frappe=SimpleNamespace(get_doc=lambda *a,**kw:self.p,get_roles=lambda:[],session=SimpleNamespace(user='u'),flags=SimpleNamespace(),throw=throw,ValidationError=Invalid,PermissionError=Denied)
        self.ctx={'_project_proposal_payload':lambda a,p:{'payload':p,'redacted':False},'frappe':frappe,'get_identity':lambda:SimpleNamespace(enterprise_id='e'),'_proposal_eligible':lambda *a:self.eligible,'_definition':lambda *a:None,'_assert_action_role':lambda *a:None,'_assert_proposal_target':lambda *a:None,'_json':REAL_JSON,'_proposal_public':lambda p:{'status':p.status},'_assert_proposal_definition':guard,'_assert_proposable':lambda *a:None,'execute_registered_action':execute,'now_datetime':lambda:'now','action_requests':SimpleNamespace(find_request=lambda k:SimpleNamespace(status='Succeeded'))}
        sys.modules['shangshu_core.proposal_review']=SimpleNamespace(supports_review=lambda a:False,resolve_review_proposal=lambda *a:None)
        load_funcs(ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py',{'resolve_action_proposal'},self.ctx)
    def test_stale_whole_proposal_cannot_execute_or_edit(self):
        self.current=False
        with self.assertRaises(Stale):self.ctx['resolve_action_proposal']('p','confirmed',{'value':3})
        self.assertEqual(self.calls,['definition']);self.assertEqual(self.p.status,'Proposed')
    def test_stale_whole_proposal_can_be_discarded(self):
        self.current=False
        self.assertEqual(self.ctx['resolve_action_proposal']('p','rejected')['status'],'Rejected')
        self.assertEqual(self.calls,[])
    def test_unchanged_whole_proposal_checks_before_execute(self):
        self.assertEqual(self.ctx['resolve_action_proposal']('p','confirmed')['status'],'Confirmed')
        self.assertEqual(self.calls,['definition','execute'])
    def test_confirmed_receipt_uses_existing_replay_without_new_definition_requirement(self):
        self.p.status='Confirmed';self.current=False
        self.assertTrue(self.ctx['resolve_action_proposal']('p','confirmed')['idempotent'])
        self.assertEqual(self.calls,['execute'])
    def test_no_snapshot_check_can_grant_reviewer_rights(self):
        self.eligible=False
        with self.assertRaises(Denied):self.ctx['resolve_action_proposal']('p','confirmed')
        self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
