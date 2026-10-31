"""Actual provenance implementation, replacing only Frappe storage/runtime access."""
import importlib.util,sys,json,hashlib,unittest
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime,timedelta
ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception):pass
class Invalid(Exception):pass
class Missing(Exception):pass
class Doc(dict):
 def __getattr__(self,k):return self.get(k)
 def __setattr__(self,k,v):self[k]=v
def throw(m,k):raise k(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.allowed=True;self.node={'id':'write','type':'action','action_id':'mail.save_draft'};self.effect='write'
  self.instance=Doc(enterprise_id='enterprise',name='RUN-1',status='Running',current_node='write',definition_id='process',definition_version='VER-1',graph_hash='hash',origin_snapshot_json=json.dumps({'action_id':'start','request_id':'R1','actor_user':'alice','label':'ai-chat'}))
  self.execution=Doc(node_type='action',action_id='mail.save_draft',action_version='1.0.0',name='EXEC-1',process_instance='RUN-1',node_id='write',status='Running',execution_token_hash=hashlib.sha256(b'token').hexdigest(),token_expires_at=datetime.now()+timedelta(minutes=5))
  self.proposal=Doc(name='P1',action_id='mail.save_draft',actor_user='alice',idempotency_key='R1')
  self.participants=[{'name':'EXEC-AI','node_id':'extract','selected_tool':'document.extract'}]
  def get_doc(kind,name):
   if kind=='Shangshu Process Instance' and name=='RUN-1':return self.instance
   if kind=='Shangshu Node Execution' and name=='EXEC-1':return self.execution
   if kind=='Shangshu Action Proposal' and name=='P1':return self.proposal
   raise Missing('not found')
  self.fr=SimpleNamespace(get_doc=get_doc,get_all=lambda *a,**kw:self.participants,flags=SimpleNamespace(),throw=throw,PermissionError=Denied,ValidationError=Invalid,DoesNotExistError=Missing)
  self.identity=SimpleNamespace(enterprise_id='enterprise')
  sys.modules['shangshu_core.identity']=SimpleNamespace(get_identity=lambda:self.identity)
  sys.modules['frappe']=self.fr;sys.modules['frappe.utils']=SimpleNamespace(now_datetime=datetime.now)
  sys.modules['shangshu_core.runtime']=SimpleNamespace(_instance_access=lambda *a,**kw:self.allowed,_node_for_instance=lambda *a:({},self.node),_action_for_instance=lambda *a:SimpleNamespace(action_version='1.0.0'))
  sys.modules['shangshu_core.actions']=SimpleNamespace(_definition=lambda a,v=None:SimpleNamespace(effect=self.effect))
  spec=importlib.util.spec_from_file_location('provenance_actual',ROOT/'frappe_apps/shangshu_core/shangshu_core/action_provenance.py');self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def capture(self):
  with self.m.process_node_provenance('EXEC-1','token'):return self.m.current_action_provenance('mail.save_draft')
 def test_node_snapshot_freezes_existing_instance_version_node_and_llm_participation(self):
  snapshot=self.capture();self.participants.clear()
  self.assertEqual(snapshot['definition_version'],'VER-1');self.assertEqual(snapshot['node_execution'],'EXEC-1')
  self.assertEqual(snapshot['llm_participants'][0]['node_id'],'extract');self.assertNotIn('payload',snapshot)
  result=self.m.project_action_provenance(snapshot);self.assertTrue(result['trusted']);self.assertFalse(result['initiator']['trusted']);self.assertEqual(result['initiator']['kind'],'action')
 def test_client_source_label_without_scope_never_creates_proof(self):
  self.assertIsNone(self.m.current_action_provenance('mail.save_draft'))
  self.assertEqual(self.m.project_action_provenance(None),{'status':'not_linked','trusted':False})
 def test_empty_participants_remain_empty_array_and_process_pins_old_action_version(self):
  self.participants=[]
  with self.m.process_node_provenance('EXEC-1','token'):
   self.assertEqual(self.m.process_action_version('mail.save_draft'),'1.0.0')
   snapshot=self.m.current_action_provenance('mail.save_draft','1.0.0')
   self.assertEqual(snapshot['action_version'],'1.0.0')
   self.assertEqual(self.m.project_action_provenance(snapshot)['llm_participants'],[])
   with self.assertRaises(Invalid):self.m.current_action_provenance('mail.save_draft','2.0.0')
 def test_token_and_expiry_are_required(self):
  for token in ('forged',''):
   with self.assertRaises(Denied):
    with self.m.process_node_provenance('EXEC-1',token):pass
  self.execution.token_expires_at=datetime.now()-timedelta(seconds=1)
  with self.assertRaises(Denied):self.capture()
 def test_current_process_and_node_must_match(self):
  self.instance.current_node='other'
  with self.assertRaises(Invalid):self.capture()
 def test_wrong_action_cannot_borrow_node_proof(self):
  with self.m.process_node_provenance('EXEC-1','token'):
   with self.assertRaises(Denied):self.m.current_action_provenance('files.create')
 def test_ai_node_still_cannot_propose_write(self):
  self.node={'type':'ai_select','candidates':['mail.save_draft']};self.execution.node_type='ai_select'
  with self.m.process_node_provenance('EXEC-1','token'):
   with self.assertRaises(Denied):self.m.current_action_provenance('mail.save_draft')
   self.effect='extract';self.assertEqual(self.m.current_action_provenance('mail.save_draft')['executor_kind'],'llm')
 def test_permission_checked_at_capture_and_again_at_read(self):
  snapshot=self.capture();self.allowed=False
  self.identity.enterprise_id='other'
  with self.assertRaises(Denied):self.capture()
  self.assertEqual(self.m.project_action_provenance(snapshot),{'status':'unavailable','trusted':False})
 def test_missing_or_mismatched_runtime_does_not_leak_snapshot(self):
  snapshot=self.capture();snapshot['node_execution']='foreign'
  self.assertEqual(self.m.project_action_provenance(snapshot),{'status':'unavailable','trusted':False})
  snapshot=self.capture();self.instance.graph_hash='changed'
  self.assertEqual(self.m.project_action_provenance(snapshot),{'status':'unavailable','trusted':False})
 def test_confirmation_copies_stored_source_without_current_scope(self):
  snapshot=self.capture();self.proposal.source_snapshot_json=json.dumps(snapshot);self.fr.flags.shangshu_resolving_proposal='P1'
  self.assertEqual(self.m.current_action_provenance('mail.save_draft'),snapshot)
  self.assertIsNone(self.m.current_action_provenance('other'))
 def test_handler_origin_uses_original_request_and_actor_not_confirmer(self):
  self.fr.flags.shangshu_resolving_proposal='P1'
  with self.m.action_origin_scope('mail.save_draft','review-R2','approver','ai-chat'):
   origin=self.m.current_action_origin();self.assertEqual(origin['request_id'],'R1');self.assertEqual(origin['actor_user'],'alice');self.assertNotIn('trusted',origin)
  self.assertIsNone(self.m.current_action_origin())
 def test_scope_is_restored_after_exception(self):
  with self.assertRaises(RuntimeError):
   with self.m.process_node_provenance('EXEC-1','token'):raise RuntimeError('driver failed')
  self.assertIsNone(self.m.current_action_provenance('mail.save_draft'))
if __name__=='__main__':unittest.main()
