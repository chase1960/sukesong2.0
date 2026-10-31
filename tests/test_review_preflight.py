"""Isolated pure preflight contract: real functions, no DB/action execution."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

class Denied(Exception): pass
class Stale(Exception): pass
class Invalid(Exception): pass
source=Path(__file__).resolve().parents[1]/'frappe_apps/shangshu_core/shangshu_core/proposal_review.py'
names={'get_action_proposal_review','check_initial_version','check_baselines'}
code=compile(ast.Module(body=[n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(source),'exec')

class Preflight(unittest.TestCase):
 def run_check(self,deny=False,stale=False,sequence=0,writable=True,status='Proposed',baseline=False,reject_deny=False):
  calls=[]
  def throw(message,kind): raise kind(message)
  state={'sequence':sequence,'accepted':{'done':{}},'baselines':{'left':'old'} if baseline else {}}
  snap={'units':[{'unit_id':'done','current_value':'saved'},{'unit_id':'left','current_value':'new'}],'initial_version_matches':not stale,'writable':writable}
  def load(pid,purpose,decision=None):
   calls.append(purpose)
   if purpose=='resolve' and (deny or (reject_deny and decision=='rejected')): raise Denied('hidden resource detail')
   return SimpleNamespace(status=status),{},state
  env={'frappe':SimpleNamespace(PermissionError=Denied,TimestampMismatchError=Stale,ValidationError=Invalid,throw=throw),'_load':load,'_snapshot':lambda *args:snap,'_public':lambda *args,**kw:kw,'canonical':repr}
  exec(code,env)
  return env['get_action_proposal_review']('p'),calls
 def test_read_is_not_write(self):
  result,calls=self.run_check(deny=True);self.assertFalse(result['can_accept']);self.assertFalse(result['can_reject']);self.assertNotIn('hidden',result['accept_unavailable_reason']);self.assertEqual(calls,['read','resolve','resolve'])
 def test_rejection_has_independent_authority(self):
  result,_=self.run_check(reject_deny=True);self.assertTrue(result['can_accept']);self.assertFalse(result['can_reject'])
 def test_stale_initial_rejected(self):self.assertFalse(self.run_check(stale=True)[0]['can_accept'])
 def test_partial_accept_does_not_reject_old_initial_version(self):self.assertTrue(self.run_check(stale=True,sequence=1)[0]['can_accept'])
 def test_changed_remaining_baseline_rejected(self):self.assertFalse(self.run_check(sequence=1,baseline=True)[0]['can_accept'])
 def test_readonly_workbook_rejected(self):self.assertFalse(self.run_check(writable=False)[0]['can_accept'])
 def test_terminal_no_resolve_check(self):
  result,calls=self.run_check(status='Confirmed');self.assertFalse(result['can_accept']);self.assertEqual(calls,['read'])
if __name__=='__main__':unittest.main()
