"""Actual private Mail/Files hooks: record and authority boundaries are substitutes."""
import importlib,importlib.util,json,sys,unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
# 真 app 包进 sys.path —— mail 的 proposal_review.py 顶部有
# `from shangshu_mail import account` / `from shangshu_mail.domain import EDITABLE_FIELDS`
# / `from shangshu_core.public_api import get_record_attachments`，
# 手搓的裸模块 shangshu_mail 不是包 ⇒ 这些子模块一个都找不到。
install_real_environment()
# 真模块在**装好路径之后、测试替换 sys.modules 之前**先 import：
# public_api 的 import 链要真内核模块（替身只管被测的那几个函数）。
import shangshu_core.public_api
import shangshu_mail.account
import shangshu_mail.service
ROOT=Path(__file__).resolve().parents[2]
class Invalid(Exception):pass
class Denied(Exception):pass
class Stale(Exception):pass
class Missing(Exception):pass
class Doc(SimpleNamespace):
 def get(self,key):return getattr(self,key,None)
def throw(m,e):raise e(m)
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Mail(unittest.TestCase):
 def setUp(self):
  self.allowed=True;self.doc=None;self.calls=[]
  self.frappe=SimpleNamespace(session=SimpleNamespace(user='owner'),throw=throw,ValidationError=Invalid,PermissionError=Denied,TimestampMismatchError=Stale,DoesNotExistError=Missing,
    db=SimpleNamespace(exists=lambda doctype,name:bool(self.doc and self.doc.name==name)))
  sys.modules['frappe']=self.frappe
  def guard(*a):
   self.calls.append(a)
   if not self.allowed:raise Denied('revoked')
  account=SimpleNamespace(account_name=lambda user:'personal:'+user,require_right=lambda box,right:guard('right',box,right))
  # 协作者改成**真模块上的替换**：mail 的 proposal_review 顶部绑的是
  # `from shangshu_mail import account` / `from shangshu_core.public_api import get_record_attachments`，
  # 换掉真模块上的那几个点，控制力不变。
  shangshu_mail.account.account_name=account.account_name
  shangshu_mail.account.require_right=account.require_right
  shangshu_core.public_api.get_record_attachments=lambda *a:[]
  def message(name,lock=False):
   guard('actual-record',name,lock)
   if not self.doc or self.doc.name!=name:raise Missing('wrong-target')
   return self.doc
  shangshu_mail.service.message=message
  shangshu_mail.service.require_draft_edit=lambda d:guard('edit',d.name)
  shangshu_mail.service.proposal_guard=guard
  self.m=module('mail_review_actual',ROOT/'frappe_apps/shangshu_mail/shangshu_mail/proposal_review.py')
  self.payload={'subject':'candidate subject','body':'<p>candidate body</p>','body_format':'HTML','to':['x@example.invalid'],'cc':[]}
 def runhook(self,op,units=None,edits=None,state=None):
  return self.m.review('mail.save_draft',self.payload,state or {},{'operation':op,'purpose':'resolve','units':units or [],'edited_value':edits or {}},'owner')
 def existing(self):
  self.doc=Doc(name='draft',status='Draft',record_version=7,owner='owner',mailbox_id='personal:owner',subject='human subject',body='human body',body_format='Text',to_json='[]',cc_json='[]',attachment_ids_json='[]',inline_resources_json='[]',attachment_labels_json='{}',reply_to_mail='')
  return {'bound_target':{'module':'mail','mail':'draft'},'sequence':1}
 def test_describe_new_is_no_record_creation_and_body_one_whole_unit(self):
  s=self.runhook('describe');self.assertIsNone(self.doc);self.assertEqual([u['unit_id'] for u in s['units']],['subject','to','cc','body']);self.assertEqual(next(u for u in s['units'] if u['unit_id']=='body')['kind'],'html')
 def test_subject_accept_does_not_include_body_recipients_or_html_candidates(self):
  p=self.runhook('prepare',['subject'])['payload'];self.assertEqual((p['subject'],p['body'],p['body_format'],p['to'],p['cc']),('candidate subject','','Text',[],[]));self.assertNotIn('mail',p)
 def test_existing_body_only_preserves_later_human_subject_and_binds_actual_record(self):
  state=self.existing();p=self.runhook('prepare',['body'],{'body':'<b>edited</b>'},state)['payload'];self.assertEqual((p['subject'],p['body'],p['body_format'],p['mail'],p['expected_version']),('human subject','<b>edited</b>','HTML','draft',7))
 def test_shared_new_target_cannot_be_silently_accepted_with_subject(self):
  self.payload['mailbox']='shared'
  with self.assertRaises(Invalid):self.runhook('prepare',['subject'])
  p=self.runhook('prepare',['mailbox','subject'])['payload'];self.assertEqual(p['mailbox'],'shared')
  self.assertTrue(next(u for u in self.runhook('describe')['units'] if u['unit_id']=='mailbox')['requires_with_content'])
 def test_bound_target_authorization_is_real_record_not_original_unbound_payload(self):
  state=self.existing();self.runhook('authorize',state=state);self.assertIn(('actual-record','draft',True),self.calls)
  self.allowed=False
  with self.assertRaises(Denied):self.runhook('authorize',state=state)
 def test_body_bundle_conflict_comparison_tracks_format_resource_and_reply(self):
  state=self.existing();before=next(u for u in self.runhook('describe',state=state)['units'] if u['unit_id']=='body')['comparison_value'];self.doc.body_format='HTML';after=next(u for u in self.runhook('describe',state=state)['units'] if u['unit_id']=='body')['comparison_value'];self.assertNotEqual(before,after)
 def test_legacy_target_or_untyped_edits_reject(self):
  for edit in [{'mail':{'type':'text','value':'other'}},{'subject':'raw'}]:
   with self.assertRaises(Invalid):self.m.review('mail.save_draft',self.payload,{}, {'operation':'legacy_edit','purpose':'resolve','edited_value':edit},'owner')
 def test_own_missing_target_can_only_be_discarded_without_reading_mail(self):
  self.payload['mail']='wrong-mailbox-id'
  self.m.review('mail.save_draft',self.payload,{}, {'operation':'authorize','purpose':'resolve','decision':'rejected'},'owner')
  self.assertEqual(self.calls,[('right','personal:owner','edit_draft')])
  for op in ('authorize','describe','prepare'):
   with self.assertRaises(Missing):self.runhook(op,['subject'])
 def test_missing_target_reject_requires_original_actor_and_current_mailbox_permission(self):
  self.payload.update(mail='gone',mailbox='shared')
  self.frappe.session.user='other'
  with self.assertRaises(Denied):self.m.review('mail.save_draft',self.payload,{}, {'operation':'authorize','purpose':'resolve','decision':'rejected'},'owner')
  self.assertEqual(self.calls,[])
  self.frappe.session.user='owner';self.allowed=False
  with self.assertRaises(Denied):self.m.review('mail.save_draft',self.payload,{}, {'operation':'authorize','purpose':'resolve','decision':'rejected'},'owner')
  self.assertIn(('right','shared','edit_draft'),self.calls)
 def test_existing_or_partial_target_reject_still_checks_actual_edit_authority(self):
  state=self.existing();self.allowed=False
  with self.assertRaises(Denied):self.m.review('mail.save_draft',self.payload,state, {'operation':'authorize','purpose':'resolve','decision':'rejected'},'owner')
  self.allowed=True;self.doc=None;self.calls=[];state['result']={'name':'draft','mailbox_id':'shared'}
  self.m.review('mail.save_draft',self.payload,state, {'operation':'authorize','purpose':'resolve','decision':'rejected'},'owner')
  self.assertEqual(self.calls,[('right','shared','edit_draft')])

class MailToolSchema(unittest.TestCase):
 def test_new_draft_schema_explains_distinct_mail_and_mailbox_without_requiring_mail(self):
  domain=module('mail_schema_actual',ROOT/'frappe_apps/shangshu_mail/shangshu_mail/domain.py')
  definition=next(schema for action,title,schema in domain.ACTIONS if action=='mail.save_draft')
  self.assertEqual(definition['required'],['subject','body','to','cc'])
  self.assertIn('省略',definition['properties']['mail']['description'])
  self.assertIn('邮箱',definition['properties']['mailbox']['description'])
  self.assertIn('新建',definition['description'])
class Files(unittest.TestCase):
 def setUp(self):
  self.calls=[];self.allowed=True
  sys.modules['frappe']=SimpleNamespace(throw=throw,ValidationError=Invalid,PermissionError=Denied,TimestampMismatchError=Stale)
  def guard(*a):
   self.calls.append(a)
   if not self.allowed:raise Denied('no write')
  sys.modules['shangshu_files.service']=SimpleNamespace(proposal_guard=guard)
  sys.modules['shangshu_files.proposal_projection']=SimpleNamespace(project=lambda a,p:{'payload':deepcopy(p),'redacted':False})
  self.snapshot={'rows':[{'row_id':'r1','values':{'编号':{'type':'text','value':'00123'},'费用':{'type':'number','value':800}}}], 'content_version':9,'structure_version':1,'writable':True}
  def read(_s,p,c):self.calls.append(('read',p,c));return deepcopy(self.snapshot)
  sys.modules['shangshu_files.sheet']=SimpleNamespace(read_payload=read)
  self.m=module('files_review_actual',ROOT/'frappe_apps/shangshu_files/shangshu_files/proposal_review.py')
  self.payload={'table':'t','expected_content_version':9,'expected_structure_version':1,'cells':[{'row_id':'r1','header':'编号','value':{'type':'text','value':'candidate'}},{'row_id':'r1','header':'费用','value':{'type':'number','value':900}}]}
 def hook(self,op,**kw):
  if op=='prepare' and 'snapshot' not in kw:kw['snapshot']=self.hook('describe')
  return self.m.review('files.sheet_cells_write',self.payload,{}, {'operation':op,'purpose':'resolve',**kw},'owner')
 def test_stable_units_match_targets_and_read_never_persists_metadata(self):
  s=self.hook('describe');self.assertEqual(s['units'][0]['target'],{'row_id':'r1','header':'编号'});self.assertEqual(self.calls[-1][2],{'review_readonly':True});self.assertTrue(s['initial_version_matches'])
 def test_one_selected_cell_only_reuses_registered_cells_write_shape(self):
  s=self.hook('describe');uid=s['units'][1]['unit_id'];p=self.hook('prepare',units=[uid],edited_value={uid:{'type':'number','value':1000}},op_id='review-key')['payload'];self.assertEqual(len(p['cells']),1);self.assertEqual(p['cells'][0],{'row_id':'r1','header':'费用','value':{'type':'number','value':1000}});self.assertEqual((p['expected_content_version'],p['op_id']),(9,'review-key'))
 def test_duplicate_same_cell_and_missing_position_fail_whole_plan(self):
  self.payload['cells'].append(deepcopy(self.payload['cells'][0]))
  with self.assertRaises(Invalid):self.hook('describe')
  self.payload['cells']=self.payload['cells'][:1];self.payload['cells'][0]['header']='changed'
  with self.assertRaises(Stale):self.hook('describe')
 def test_old_proposal_version_detected_and_current_auth_rechecked(self):
  self.payload['expected_content_version']=8;self.assertFalse(self.hook('describe')['initial_version_matches']);self.allowed=False
  with self.assertRaises(Denied):self.hook('describe')
if __name__=='__main__':unittest.main()
