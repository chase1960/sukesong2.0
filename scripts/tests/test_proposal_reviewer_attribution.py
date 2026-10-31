"""Real reviewer and eligibility functions follow authoritative ownership."""
import ast,json,sys,unittest
from pathlib import Path
from types import SimpleNamespace,ModuleType
from unittest.mock import patch
SOURCE=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core/shangshu_core/actions.py'
class ReviewerAttribution(unittest.TestCase):
 def setUp(self):
  self.att={'level':'personal','owner_user':'new-owner'};self.lookups=[]
  module=ModuleType('shangshu_core.org_admin')
  module.resource_attribution=lambda target:self.att
  def legacy(target):self.lookups.append(target);return 'old-owner'
  module.resource_owner=legacy
  self.modules=patch.dict(sys.modules,{'shangshu_core':ModuleType('shangshu_core'),'shangshu_core.org_admin':module});self.modules.start();self.addCleanup(self.modules.stop)
  self.ctx={'_json':lambda s,d:json.loads(s),'frappe':SimpleNamespace(session=SimpleNamespace(user='new-owner'))}
  nodes=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in {'_proposal_reviewer','_proposal_eligible'}]
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),self.ctx)
  self.proposal=SimpleNamespace(payload_json='{"table":"table-1"}',actor_user='different-author')
 def eligible(self,user):
  self.ctx['frappe'].session.user=user
  return self.ctx['_proposal_eligible'](self.proposal,['Desk User'])
 def test_transfer_moves_review_eligibility(self):
  self.assertTrue(self.eligible('new-owner'));self.assertFalse(self.eligible('old-owner'));self.assertEqual(self.lookups,[])
 def test_attributed_without_owner_never_revives_creator(self):
  for level in ['personal','department','enterprise']:
   self.att={'level':level,'owner_user':None}
   self.assertIsNone(self.ctx['_proposal_reviewer'](self.proposal));self.assertFalse(self.eligible('old-owner'))
  self.assertEqual(self.lookups,[])
 def test_department_only_named_custodian_not_member_or_head(self):
  self.att={'level':'department','owner_user':'custodian','department':'a'}
  self.assertTrue(self.eligible('custodian'))
  for user in ['old-owner','member','head']:self.assertFalse(self.eligible(user))
 def test_only_legacy_without_attribution_falls_back(self):
  self.att=None;self.assertTrue(self.eligible('old-owner'));self.assertEqual(self.lookups,['table-1'])
 def test_missing_target_fails_closed(self):
  self.proposal.payload_json='{}';self.assertIsNone(self.ctx['_proposal_reviewer'](self.proposal));self.assertEqual(self.lookups,[])
if __name__=='__main__':unittest.main()
