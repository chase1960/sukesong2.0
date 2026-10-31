"""Exercise real proposal visibility/read functions with current permission changes."""
import ast,json,unittest
from pathlib import Path
from types import SimpleNamespace

SOURCE=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core/shangshu_core/actions.py'
class Denied(Exception):pass
class ProposalReads(unittest.TestCase):
 def setUp(self):
  self.allowed=True;self.reviewer='owner';self.user='reader';self.roles={'Desk User'}
  self.proposal=SimpleNamespace(actor_user='author',enterprise_id='one',action_id='files.write',payload_json='{}')
  def throw(*_):raise Denied()
  def guard(*_):
   if not self.allowed:raise Denied()
  frappe=SimpleNamespace(session=SimpleNamespace(user=self.user),PermissionError=Denied,ValidationError=Denied,DoesNotExistError=Denied,
    get_doc=lambda *a:self.proposal,get_roles=lambda:self.roles,throw=throw)
  self.ctx=dict(_project_proposal_payload=lambda a,p:{'payload':p,'redacted':False},frappe=frappe,_proposal_reviewer=lambda p:self.reviewer,_assert_proposal_target=guard,_json=lambda s,d:json.loads(s),
    get_identity=lambda:SimpleNamespace(enterprise_id='one'),_proposal_public=lambda *a,**k:{'id':'p'},_proposal_review_state=lambda *a:{})
  funcs={'_proposal_eligible','_proposal_visible','get_action_proposal','get_proposal_validation_snapshot'}
  nodes=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in funcs]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),self.ctx)
 def test_same_action_role_is_not_review_eligibility(self):
  self.assertFalse(self.ctx['_proposal_visible'](self.proposal,self.roles))
  with self.assertRaises(Denied):self.ctx['get_action_proposal']('p')
  with self.assertRaises(Denied):self.ctx['get_proposal_validation_snapshot']('p')
 def test_owner_can_read_only_with_current_target_read(self):
  self.ctx['frappe'].session.user='owner'
  self.assertEqual(self.ctx['get_action_proposal']('p'),{'id':'p'})
  self.allowed=False
  with self.assertRaises(Denied):self.ctx['get_action_proposal']('p')
 def test_author_or_manager_does_not_bypass_revoked_target(self):
  for user,roles in [('author',{'Desk User'}),('admin',{'System Manager'})]:
   self.ctx['frappe'].session.user=user;self.roles=roles;self.allowed=False
   with self.assertRaises(Denied):self.ctx['get_action_proposal']('p')
 def test_other_enterprise_denied_before_return(self):
  self.ctx['frappe'].session.user='author';self.proposal.enterprise_id='other'
  with self.assertRaises(Denied):self.ctx['get_action_proposal']('p')
if __name__=='__main__':unittest.main()
