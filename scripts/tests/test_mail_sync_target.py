"""Actual delivery selector: no transport/network, strict target and permission boundary."""
import ast,unittest
from pathlib import Path
from types import SimpleNamespace
class Denied(Exception):pass
class Invalid(Exception):pass
class Tests(unittest.TestCase):
 def setUp(self):
  self.calls=[];self.allowed=True;self.connected=True
  def right(box,kind):
   self.calls.append(('right',box,kind))
   if not self.allowed:raise Denied()
  def get(**kw):
   self.calls.append(('get',kw))
   if kw.get('mailbox')=='missing':raise Invalid()
   return SimpleNamespace(connection_status='connected' if self.connected else 'paused',account_key=kw.get('mailbox','personal'))
  tree=ast.parse((Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_mail/shangshu_mail/delivery.py').read_text())
  code=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='sync_account'],type_ignores=[])
  def throw(msg,kind):raise kind(msg)
  ns={'account':SimpleNamespace(require_right=right,get_account=get),'frappe':SimpleNamespace(throw=throw,ValidationError=Invalid)};exec(compile(code,'delivery.py','exec'),ns);self.run_sync=ns['sync_account']
 def test_shared_exact_read_only(self):
  self.assertEqual(self.run_sync({'mailbox_id':'shared'}).account_key,'shared');self.assertEqual(self.calls,[('right','shared','read'),('get',{'lock':True,'required':True,'mailbox':'shared'})])
 def test_revoked_before_credentials(self):
  self.allowed=False
  with self.assertRaises(Denied):self.run_sync({'mailbox_id':'shared'})
  self.assertEqual(len(self.calls),1)
 def test_missing_no_fallback(self):
  with self.assertRaises(Invalid):self.run_sync({'mailbox_id':'missing'})
  self.assertEqual(len(self.calls),2)
 def test_disconnected_denied(self):
  self.connected=False
  with self.assertRaises(Invalid):self.run_sync({'mailbox_id':'shared'})
 def test_legacy_personal_only(self):
  self.assertEqual(self.run_sync({}).account_key,'personal');self.assertEqual(self.calls,[('get',{'lock':True,'required':True})])
if __name__=='__main__':unittest.main()
