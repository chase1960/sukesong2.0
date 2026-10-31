"""Execute actual domain guards; replace only record/permission boundary, not the guard logic."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception): pass
class Invalid(Exception): pass
class Doc:
 def __init__(self,allowed=True,box='shared',owner='owner'): self.allowed=allowed;self.mailbox_id=box;self.owner=owner
 def check_permission(self,ptype):
  if not self.allowed: raise Denied('no read')
 def get(self,key): return getattr(self,key,None)
def guard(domain,context):
 path=ROOT/'frappe_apps'/('shangshu_'+domain)/('shangshu_'+domain)/'service.py'
 node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='proposal_guard')
 exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),context)
 return context['proposal_guard']
def throw(message,error): raise error(message)
def files(allowed=True,writable=True,user='viewer',manager=False):
 calls=[];doc=Doc(allowed=allowed)
 def write(target):
  calls.append(('write_check',target));doc.check_permission('read')
  if not writable: raise Denied('no write')
  return doc
 ctx={'frappe':SimpleNamespace(session=SimpleNamespace(user=user),PermissionError=Denied,ValidationError=Invalid,throw=throw,get_doc=lambda kind,target:(calls.append(('read_check',target)) or doc)),
      'DOCTYPE':'file','_writable':write,'_manager':lambda:manager,'directories':SimpleNamespace(resolve=lambda payload:calls.append(('directory',payload)))}
 return guard('files',ctx),calls
def mail(rights=None,user='viewer',readable=True):
 calls=[];rights=rights or {}
 def require(box,right):
  calls.append((box,right))
  if box=='personal:'+user or rights.get((box,right)): return
  raise Denied('no '+right)
 def message(name,lock=False):
  calls.append(('message',name,lock))
  if not readable: raise Denied('no read')
  return Doc(box='shared',owner='owner')
 account=SimpleNamespace(account_name=lambda user:'personal:'+user,require_right=require)
 ctx={'frappe':SimpleNamespace(session=SimpleNamespace(user=user),PermissionError=Denied,ValidationError=Invalid,throw=throw),'account':account,'message':message,
      'require_draft_edit':lambda doc:require(doc.get('mailbox_id') or account.account_name(doc.owner),'edit_draft')}
 return guard('mail',ctx),calls
class Tests(unittest.TestCase):
 def test_files_unreadable_cannot_read_candidate(self):
  g,c=files(allowed=False)
  with self.assertRaises(Denied):g('files.sheet_cells_write',{'table':'private'},'read','owner')
  self.assertEqual(c,[('read_check','private')])
 def test_files_read_does_not_give_reject_or_confirm(self):
  g,c=files(writable=False);g('files.sheet_cells_write',{'table':'t'},'read','owner')
  with self.assertRaises(Denied):g('files.sheet_cells_write',{'table':'t'},'resolve','owner')
 def test_files_resolve_reuses_existing_current_write_gate(self):
  g,c=files();g('files.sheet_cells_write',{'table':'t','file':'forged'},'resolve','owner');self.assertEqual(c,[('write_check','t')])
 def test_new_file_without_resource_does_not_become_reviewers_own(self):
  g,c=files()
  with self.assertRaises(Denied):g('files.create',{},'read','owner')
  self.assertEqual(c,[]);g('files.create',{},'resolve','viewer');self.assertEqual(c[0],('directory',{}))
 def test_file_target_actions_also_use_original_file(self):
  g,c=files();g('files.update_meta',{'file':'file1'},'read','owner');self.assertEqual(c,[('read_check','file1')])
 def test_shared_read_only_cannot_write_or_send(self):
  g,c=mail();g('mail.save_draft',{'mail':'draft'},'read','owner')
  for action in ['mail.save_draft','mail.send']:
   with self.assertRaises(Denied):g(action,{'mail':'draft'},'resolve','owner')
 def test_forged_target_mailbox_cannot_skip_actual_source(self):
  g,c=mail()
  with self.assertRaises(Denied):g('mail.save_draft',{'mail':'draft','mailbox':'personal:viewer'},'resolve','owner')
  self.assertIn(('shared','edit_draft'),c)
 def test_editor_and_sender_rights_are_independent(self):
  g,c=mail({('shared','edit_draft'):True});g('mail.save_draft',{'mail':'draft'},'resolve','owner')
  with self.assertRaises(Denied):g('mail.send',{'mail':'draft'},'resolve','owner')
  g,c=mail({('shared','send'):True});g('mail.send',{'mail':'draft'},'resolve','owner')
 def test_actual_source_unreadable_not_even_target_can_rescue_it(self):
  g,c=mail(readable=False)
  with self.assertRaises(Denied):g('mail.save_draft',{'mail':'draft','mailbox':'personal:viewer'},'read','owner')
 def test_new_explicit_shared_draft_uses_read_and_edit_rights(self):
  g,c=mail({('shared','read'):True});g('mail.save_draft',{'mailbox':'shared'},'read','owner')
  with self.assertRaises(Denied):g('mail.save_draft',{'mailbox':'shared'},'resolve','owner')
 def test_unbound_new_draft_uses_trusted_actor_not_payload_or_reviewer(self):
  g,c=mail();g('mail.save_draft',{},'resolve','viewer')
  for purpose in ['read','resolve']:
   with self.assertRaises(Denied):g('mail.save_draft',{'actor_user':'viewer'},purpose,'owner')
  self.assertIn(('personal:owner','read'),c)
 def test_sync_is_original_persons_action(self):
  g,c=mail();g('mail.sync',{},'resolve','viewer')
  with self.assertRaises(Denied):g('mail.sync',{},'read','owner')
 def test_bad_purpose_is_explicit_no_auth_fallback(self):
  for g,c in [files(),mail()]:
   with self.assertRaises(Invalid):g('unknown',{},'unknown','viewer')
   self.assertEqual(c,[])
if __name__=='__main__':unittest.main()
