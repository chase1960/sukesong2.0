"""Raw URL and attachment-copy enforce the same source export policy."""
import importlib.util,sys,types,unittest
from contextlib import nullcontext
from pathlib import Path
class Denied(Exception):pass
class D(types.SimpleNamespace):pass
class ExportTests(unittest.TestCase):
 def setUp(self):
  def throw(msg,kind):raise kind(msg)
  self.fr=D(throw=throw,PermissionError=Denied,ValidationError=ValueError,DoesNotExistError=KeyError,flags=D(shangshu_call_domain='mail',shangshu_action_pin={'action_id':'mail.draft'}),session=D(user='a'))
  sys.modules['frappe']=self.fr
  class File:
   def is_downloadable(self):return True
  sys.modules['frappe.core.doctype.file.file']=D(File=File)
  sys.modules['shangshu_core.domain_execution']=D(domain_execution=lambda *a:nullcontext())
  sys.modules['shangshu_core.identity']=D(get_identity=lambda:True)
  sys.modules['shangshu_core.domains']=D(raw_resource=lambda *a:({'id':'mail'},{}))
  self.calls=[];self.allow=True;self.ready=True
  def gate(*args):
   self.calls.append(args)
   if not self.ready:raise Denied('hidden field')
  sys.modules['shangshu_core.field_access']=D(check_content_ready=gate)
  path=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core/shangshu_core/attachments.py'
  spec=importlib.util.spec_from_file_location('attachment_test',path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.m.can_read_reference=lambda *a:True
  self.m.can_download_reference=lambda *a:self.allow
  self.m._owners=lambda t:{'mail'}
  self.source=self.m.PlatformFile();self.source.name='blob';self.source.is_private=1;self.source.is_folder=0;self.source.file_url='/private/files/book.xlsx';self.source.file_name='book.xlsx';self.source.content_hash='immutable';self.source.attached_to_doctype='Source';self.source.attached_to_name='source'
  self.copied=False
  def copy(*a,**kw):self.copied=True;return D(name='copy',file_name='book.xlsx',file_size=10)
  self.source.create_attachment_copy=copy
  self.fr.get_doc=lambda dt,name,**kw:self.source if dt=='File' else D()
  self.fr.db=D(get_value=lambda *a:None)
 def test_raw_url_read_is_not_download(self):
  self.allow=False;self.assertFalse(self.source.is_downloadable());self.assertFalse(self.calls)
 def test_raw_url_hidden_field_current_or_history_denied(self):
  self.ready=False;self.assertFalse(self.source.is_downloadable());self.assertEqual(self.calls,[('Source','source','blob')])
 def test_immutable_copy_cannot_bypass_hidden_field(self):
  self.ready=False
  with self.assertRaises(Denied):self.m.bind_record_attachments('Mail','message',['blob'])
  self.assertFalse(self.copied)
 def test_immutable_copy_requires_export_not_just_source_read(self):
  self.allow=False
  with self.assertRaises(Denied):self.m.bind_record_attachments('Mail','message',['blob'])
  self.assertFalse(self.copied)
 def test_authorized_copy_remains_usable(self):
  result=self.m.bind_record_attachments('Mail','message',['blob'])
  self.assertTrue(self.copied);self.assertEqual(result[0]['file'],'copy');self.assertEqual(len(self.calls),1)
 def test_pending_content_validation_fails_closed(self):
  def fail(*a):raise ValueError('writeback pending')
  sys.modules['shangshu_core.field_access'].check_content_ready=fail
  with self.assertRaises(ValueError):self.source.is_downloadable()
  with self.assertRaises(ValueError):self.m.bind_record_attachments('Mail','message',['blob'])
  self.assertFalse(self.copied)
 def test_unattached_private_file_keeps_framework_policy(self):
  self.source.attached_to_doctype=None;self.source.attached_to_name=None
  self.allow=False
  self.assertTrue(self.source.is_downloadable());self.assertFalse(self.calls)
 def test_existing_snapshot_checks_target_not_historical_origin(self):
  self.source.attached_to_doctype='Mail';self.source.attached_to_name='delivered-message'
  self.assertTrue(self.source.is_downloadable())
  self.assertEqual(self.calls,[('Mail','delivered-message','blob')])

if __name__=='__main__':unittest.main()
