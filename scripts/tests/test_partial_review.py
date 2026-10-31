"""Run actual review selection/state logic with only Frappe I/O replaced."""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
# These suites isolate unrelated persistence; actual provenance has its own tests.
sys.modules['shangshu_core.action_provenance']=SimpleNamespace(
    current_action_provenance=lambda action_id,action_version=None:None,
    process_action_version=lambda action_id:None,
    project_action_provenance=lambda raw:{'status':'not_linked','trusted':False})
ROOT=Path(__file__).resolve().parents[2]
class Invalid(Exception): pass
class Denied(Exception): pass
class Stale(Exception): pass
class Missing(Exception): pass
def throw(message,error): raise error(message)
def load():
    fake=SimpleNamespace(throw=throw,ValidationError=Invalid,PermissionError=Denied,TimestampMismatchError=Stale,DoesNotExistError=Missing)
    sys.modules['frappe']=fake
    sys.modules['frappe.utils']=SimpleNamespace(now_datetime=lambda:'now')
    sys.modules['shangshu_core.domain_execution']=SimpleNamespace(resource_execution=lambda *a:lambda f:f)
    # 域注册表（PKG-033-T01）：动作的**保存方式**从这里读。
    # 这份夹具里的动作**没有声明保存方式** ⇒ 允许部分保存（老行为）——
    # 「不许部分保存」那一支由 scripts/tests/test_review_group_policy.py 单独断。
    sys.modules['shangshu_core.domains']=SimpleNamespace(raw_resource=lambda section,resource_id:(None,{}))
    path=ROOT/'frappe_apps/shangshu_core/shangshu_core/proposal_review.py'
    spec=importlib.util.spec_from_file_location('partial_under_test',path); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.m=load()
    def units(self):return [{'unit_id':'one','value':'A','current_value':'oldA'},{'unit_id':'two','value':'B','current_value':'oldB'}]
    def test_all_means_remaining_only(self):
        self.assertEqual(self.m.select_units(self.units(),{'one':{}},None,{}),['two'])
    def test_accepted_cannot_be_written_again_under_new_operation(self):
        with self.assertRaises(Invalid):self.m.select_units(self.units(),{'one':{}},['one'],{})
    def test_duplicate_unknown_and_empty_selection_reject(self):
        for value in [[],['one','one'],['invented'],'one']:
            with self.assertRaises(Invalid):self.m.select_units(self.units(),{},value,{})
    def test_edit_map_cannot_edit_unselected_or_target(self):
        for edit in [{'two':'x'},{'mail':'foreign'},['x']]:
            with self.assertRaises(Invalid):self.m.select_units(self.units(),{},['one'],edit)
    def test_fingerprint_ignores_json_property_order_but_not_candidate_or_selection(self):
        a=self.m.operation_fingerprint(['one'],{'one':{'type':'text','value':'x'}})
        self.assertEqual(a,self.m.operation_fingerprint(['one'],{'one':{'value':'x','type':'text'}}))
        self.assertNotEqual(a,self.m.operation_fingerprint(['one'],{'one':{'value':'y','type':'text'}}))
    def test_revision_tracks_formal_version_and_state(self):
        a=self.m.review_revision('p',{}, {'version':1})
        self.assertNotEqual(a,self.m.review_revision('p',{'sequence':1},{'version':1}))
        self.assertNotEqual(a,self.m.review_revision('p',{}, {'version':2}))
    def test_baselines_reject_changed_pending_but_ignore_accepted(self):
        self.m.check_baselines({'baselines':{'one':'oldA','two':'oldB'},'accepted':{'one':{}}},self.units(),['two'])
        changed=self.units();changed[1]['current_value']='human'
        with self.assertRaises(Stale):self.m.check_baselines({'baselines':{'one':'oldA','two':'oldB'}},changed,['two'])
    def test_first_version_guard_is_not_silently_rebased(self):
        self.m.check_initial_version({}, {'initial_version_matches':True})
        with self.assertRaises(Stale):self.m.check_initial_version({}, {'initial_version_matches':False})
        self.m.check_initial_version({'sequence':1},{'initial_version_matches':False})

# Additional tests use the actual orchestration, replacing only the persistence
# and existing registered-action executor. Real Frappe transactions are covered
# separately against the deployed synthetic QA fixtures.
class Orchestration(unittest.TestCase):
    def setUp(self):
        self.definition_current=True;self.definition_checks=0
        self.m=load();self.values={'one':'oldA','two':'oldB'};self.version=1;self.allowed=True;self.eligible=True;self.fail=False;self.writes=0;self.cache={}
        class Proposal(SimpleNamespace):
            def get(obj,key):return getattr(obj,key,None)
            def save(obj,**kwargs):return obj
        self.p=Proposal(name='p',action_id='fixture.write',action_version='1.0.0',enterprise_id='e',actor_user='owner',payload_json='{}',status='Proposed',created_via='ai',reference_execution=None,execution_audit=None,review_state_json=None)
        self.m.frappe=SimpleNamespace(get_doc=lambda *a,**kw:self.p,session=SimpleNamespace(user='owner'),get_roles=lambda:['Desk User'],flags=SimpleNamespace(),throw=throw,ValidationError=Invalid,PermissionError=Denied,TimestampMismatchError=Stale,DoesNotExistError=Missing)
        def execute(action,payload,**kwargs):
            if not self.allowed:raise Denied('revoked')
            key=kwargs['idempotency_key']
            if key in self.cache:return {**self.cache[key],'idempotent':True}
            if self.fail:raise Invalid('write failed')
            for key,value in payload['changes'].items():self.values[key]=value
            self.version+=1;self.writes+=1
            r={'result':{'name':'target','version':self.version},'audit':'audit-'+str(self.writes)};self.cache[kwargs['idempotency_key']]=r;return r
        def check_definition(proposal, lock=True):
            self.definition_checks+=1
            if not self.definition_current:raise Stale('definition changed')
        sys.modules['shangshu_core.actions']=SimpleNamespace(_assert_proposal_definition=check_definition,_proposal_eligible=lambda *a:self.eligible,_definition=lambda *a:None,_assert_action_role=lambda *a:None,_assert_proposal_target=lambda *a:None,_json=lambda s,d:json.loads(s),execute_registered_action=execute)
        sys.modules['shangshu_core.identity']=SimpleNamespace(get_identity=lambda:SimpleNamespace(enterprise_id='e'))
        def hook(action,payload,state,request,actor):
            if not self.allowed:raise Denied('revoked')
            op=request['operation']
            if op=='authorize':return
            if op=='bind':return {'fixture':'target'}
            units=[{'unit_id':k,'value':v,'current_value':self.values[k]} for k,v in [('one','A'),('two','B')]]
            if op=='describe':return {'units':units,'target':{'fixture':'target'},'version':self.version,'initial_version_matches':self.version==1}
            if op=='prepare':return {'payload':{'changes':{k:request['edited_value'].get(k,dict(one='A',two='B')[k]) for k in request['units']}}}
            if op=='legacy_edit':return request['edited_value']
            raise AssertionError(op)
        self.m._hook=hook
    def test_hidden_pending_unit_is_not_marked_confirmed_by_visible_acceptance(self):
        original=self.m._hook
        def projected(action,payload,state,request,actor):
            result=original(action,payload,state,request,actor)
            if request['operation']=='describe':
                result={**result,'units':[u for u in result['units'] if u['unit_id']=='one'],
                        'all_unit_ids':['one','two'],'review_scope':'currently_readable'}
            return result
        self.m._hook=projected
        revision=self.m.review_revision('p',{},self.version)
        response=self.m.accept_action_proposal_units('p','visible',revision)
        self.assertEqual(self.p.status,'Proposed')
        self.assertEqual(self.values,{'one':'A','two':'oldB'})
        self.assertEqual(response['remaining'],0)
        self.assertEqual(response['accepted_count'],1)
        self.assertIsNone(response['result'])
        with self.assertRaises(Invalid):
            self.m.accept_action_proposal_units('p','hidden',self.m.review_revision('p',self.m.read_state(self.p),self.version),['two'])
        self.assertEqual(self.writes,1)

    def test_definition_change_blocks_remaining_without_undoing_saved(self):
        revision=self.m.review_revision('p',{},self.version)
        self.m.accept_action_proposal_units('p','first',revision,['one'])
        self.definition_current=False
        state=self.m.read_state(self.p)
        revision=self.m.review_revision('p',state,self.version)
        with self.assertRaises(Stale):self.m.accept_action_proposal_units('p','second',revision,['two'])
        self.assertEqual(self.values,{'one':'A','two':'oldB'})
        self.assertEqual(self.writes,1)

    def test_success_receipt_replay_after_definition_change_does_not_reexecute(self):
        revision=self.m.review_revision('p',{},self.version)
        self.m.accept_action_proposal_units('p','first',revision,['one'])
        self.definition_current=False
        receipt=self.m.accept_action_proposal_units('p','first',revision,['one'])
        self.assertTrue(receipt['idempotent'])
        self.assertEqual(self.writes,1)

    def test_stale_definition_can_still_be_rejected(self):
        self.definition_current=False
        self.m.resolve_review_proposal('p','rejected')
        self.assertEqual(self.p.status,'Rejected')
        self.assertEqual(self.writes,0)

    def test_readable_target_without_review_eligibility_cannot_read_or_decide(self):
        self.eligible=False
        with self.assertRaises(Denied):self.descriptor()
        with self.assertRaises(Denied):self.m.accept_action_proposal_units('p','denied','rev',['one'])
        with self.assertRaises(Denied):self.m.resolve_review_proposal('p','rejected')
        self.assertEqual(self.writes,0)
        self.assertEqual(self.p.status,'Proposed')
    def descriptor(self):return self.m.get_action_proposal_review('p')
    def accept(self,op,units=None,edits=None,revision=None):
        return self.m.accept_action_proposal_units('p',op,revision or self.descriptor()['review_revision'],units,edits)
    def test_read_is_zero_write_then_single_then_remaining_preserves_later_accepted_human_value(self):
        self.descriptor();self.assertEqual(self.writes,0);self.assertIsNone(self.p.review_state_json)
        first=self.accept('first',['one']);self.assertEqual((first['status'],first['remaining'],self.values),('proposed',1,{'one':'A','two':'oldB'}))
        self.values['one']='later-human';self.version+=1
        final=self.accept('all');self.assertEqual((final['status'],final['remaining'],self.values),('confirmed',0,{'one':'later-human','two':'B'}));self.assertEqual(self.writes,2)
    def test_edited_candidate_and_same_op_replay_returns_first_result_without_new_write(self):
        rev=self.descriptor()['review_revision'];r=self.accept('first',['one'],{'one':'edited'},rev)
        replay=self.accept('first',['one'],{'one':'edited'},rev)
        self.assertEqual((self.values['one'],self.writes,replay['result'],replay['idempotent']),('edited',1,r['result'],True))
        with self.assertRaises(Invalid):self.accept('first',['one'],{'one':'different'},rev)
        self.assertEqual(self.writes,1)
    def test_revoked_cannot_read_or_replay_or_reject(self):
        self.accept('first',['one']);before=self.p.review_state_json;self.allowed=False
        for f in [self.descriptor,lambda:self.accept('first',['one']),lambda:self.m.resolve_review_proposal('p','rejected')]:
            with self.assertRaises(Denied):f()
        self.assertEqual(self.p.review_state_json,before);self.assertEqual(self.writes,1)
    def test_stale_review_and_changed_pending_are_zero_write(self):
        rev=self.descriptor()['review_revision'];self.accept('first',['one'])
        with self.assertRaises(Stale):self.accept('second',['two'],revision=rev)
        self.values['two']='human';self.version+=1
        with self.assertRaises(Stale):self.accept('second',['two'])
        self.assertEqual((self.values['two'],self.writes),('human',1))
    def test_registered_action_failure_keeps_original_pending_state(self):
        self.fail=True;before=self.p.review_state_json
        with self.assertRaises(Invalid):self.accept('first',['one'])
        self.assertEqual((self.values,self.writes,self.p.status,self.p.review_state_json),({'one':'oldA','two':'oldB'},0,'Proposed',before))
    def test_reject_remaining_keeps_accepted_formal_value_and_old_confirm_is_remaining_only(self):
        self.accept('first',['one']);r=self.m.resolve_review_proposal('p','rejected');self.assertEqual((r['status'],r['accepted_count'],self.values,self.writes),('rejected',1,{'one':'A','two':'oldB'},1))
        self.setUp();self.accept('first',['one']);self.values['one']='human';self.version+=1
        r=self.m.resolve_review_proposal('p','confirmed');self.assertEqual((r['status'],self.values,self.writes),('confirmed',{'one':'human','two':'B'},2))
    def test_reject_does_not_depend_on_old_row_header_still_existing(self):
        self.accept('first',['one'])
        original=self.m._hook
        def broken(action,payload,state,request,actor):
            if request['operation']=='describe':raise Stale('original header renamed')
            if request['operation']=='target':return {'fixture':'target'}
            return original(action,payload,state,request,actor)
        self.m._hook=broken
        result=self.m.resolve_review_proposal('p','rejected')
        self.assertEqual((result['status'],result['remaining'],self.writes,self.values['one']),('rejected',0,1,'A'))

    def test_all_selected_preflight_failure_has_no_partial_accept(self):
        with self.assertRaises(Invalid):self.accept('all',['one','invented'])
        self.assertEqual((self.writes,self.p.review_state_json),(0,None))
    def test_reject_missing_target_skips_confirmation_preflight_but_keeps_domain_authorization(self):
        self.accept('first',['one']);before=self.p.review_state_json;original=self.m._hook;checks=[]
        def broken_guard(*args):raise Missing('target no longer exists')
        sys.modules['shangshu_core.actions']._assert_proposal_target=broken_guard
        def hook(action,payload,state,request,actor):
            if request['operation']=='describe':raise Missing('target no longer exists')
            if request['operation']=='target':return {'fixture':'target'}
            checks.append(request.copy());result=original(action,payload,state,request,actor)
            return {'rejection_authorized':True} if request.get('decision')=='rejected' else result
        self.m._hook=hook
        for call in (self.descriptor,lambda:self.accept('new',['two'])):
            with self.assertRaises(Missing):call()
        result=self.m.resolve_review_proposal('p','rejected')
        self.assertEqual((result['status'],result['accepted_count'],result['remaining'],self.writes,self.values['one']),('rejected',1,0,1,'A'))
        self.assertTrue(result['current_values_unavailable']);self.assertEqual(self.p.review_state_json,before)
        self.assertTrue(any(check.get('decision')=='rejected' and check['operation']=='authorize' for check in checks))
    def test_missing_target_reject_does_not_bypass_tenant_or_domain_permission(self):
        self.p.enterprise_id='foreign'
        with self.assertRaises(Denied):self.m.resolve_review_proposal('p','rejected')
        self.p.enterprise_id='e';self.allowed=False
        with self.assertRaises(Denied):self.m.resolve_review_proposal('p','rejected')
        self.assertEqual((self.p.status,self.writes),('Proposed',0))
    def test_rejection_without_domain_opt_in_keeps_original_target_guard(self):
        def deny(*args):raise Denied('original resource permission denied')
        sys.modules['shangshu_core.actions']._assert_proposal_target=deny
        with self.assertRaises(Denied):self.m.resolve_review_proposal('p','rejected')
        self.assertEqual((self.p.status,self.writes),('Proposed',0))
    def test_reject_confirmed_missing_target_never_rolls_back_accepted_state(self):
        self.accept('all');state=self.p.review_state_json;original=self.m._hook
        def hook(action,payload,state,request,actor):
            if request['operation']=='describe':raise Missing('gone')
            if request['operation']=='target':return {'fixture':'target'}
            return original(action,payload,state,request,actor)
        self.m._hook=hook
        result=self.m.resolve_review_proposal('p','rejected')
        self.assertEqual((self.p.status,result['status'],result['accepted_count'],self.writes,self.p.review_state_json),('Confirmed','confirmed',2,1,state))

    # ── FIX-04 / A17：逐项放弃（部分拒绝）——只把项标成「不采用」，不写任何正式值 ──
    def reject(self,op,units=None,revision=None):
        return self.m.reject_action_proposal_units('p',op,revision or self.descriptor()['review_revision'],units)

    def test_reject_one_unit_keeps_formal_value_and_lets_the_other_be_adopted(self):
        self.descriptor()
        r=self.reject('drop-two',['two'])
        self.assertEqual(self.values,{'one':'oldA','two':'oldB'})
        self.assertEqual(self.writes,0)
        self.assertEqual(r['rejected_units'],['two'])
        self.assertEqual(r['remaining'],1)
        self.assertEqual([u['status'] for u in r['units']],['pending','rejected'])
        after=self.accept('one',['one'])
        self.assertEqual(self.values,{'one':'A','two':'oldB'})
        self.assertEqual(self.writes,1)
        self.assertEqual((after['status'],after['remaining'],after['accepted_count'],after['rejected_count']),('confirmed',0,1,1))

    def test_rejected_unit_cannot_be_adopted_afterwards(self):
        self.descriptor()
        self.reject('drop-two',['two'])
        with self.assertRaises(Invalid):self.accept('two',['two'])
        self.assertEqual(self.writes,0)
        self.assertEqual(self.values,{'one':'oldA','two':'oldB'})

    def test_reject_is_zero_write_and_replayable_by_op_id(self):
        rev=self.descriptor()['review_revision']
        self.reject('drop-two',['two'],rev)
        replay=self.reject('drop-two',['two'],rev)
        self.assertTrue(replay['idempotent'])
        self.assertEqual(replay['rejected_units'],['two'])
        self.assertEqual((self.writes,self.values),(0,{'one':'oldA','two':'oldB'}))

    def test_reject_unknown_or_already_handled_unit_is_refused(self):
        rev=self.descriptor()['review_revision']
        with self.assertRaises(Invalid):self.reject('bad',['invented'],rev)
        self.accept('first',['one'])
        with self.assertRaises(Invalid):self.reject('bad2',['one'],self.descriptor()['review_revision'])
        self.assertEqual(self.writes,1)
        self.assertEqual(self.values,{'one':'A','two':'oldB'})

    def test_reject_without_permission_is_zero_write(self):
        self.allowed=False
        with self.assertRaises(Denied):self.reject('drop-two',['two'],'rev')
        self.assertEqual((self.writes,self.p.status,self.p.review_state_json),(0,'Proposed',None))

    def test_reject_all_leaves_proposal_rejected_and_nothing_written(self):
        r=self.reject('drop-all',['one','two'])
        self.assertEqual((r['status'],r['remaining'],self.p.status,self.writes),('rejected',0,'Rejected',0))
        self.assertEqual(self.values,{'one':'oldA','two':'oldB'})

    def test_accept_remaining_skips_rejected_units(self):
        self.reject('drop-two',['two'])
        after=self.accept('all')
        self.assertEqual(self.values,{'one':'A','two':'oldB'})
        self.assertEqual((after['status'],after['remaining'],after['rejected_count'],self.writes),('confirmed',0,1,1))

if __name__=='__main__':unittest.main()
