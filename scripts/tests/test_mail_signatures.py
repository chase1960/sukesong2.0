"""Real signature domain functions with isolated account persistence; no site/network."""
import importlib.util
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[2]
class ValidationError(Exception):pass
class PermissionError(Exception):pass

class Signatures(TestCase):
    def setUp(self):
        frappe=ModuleType('frappe');frappe.flags=SimpleNamespace();frappe.session=SimpleNamespace(user='synthetic-owner')
        frappe.ValidationError=ValidationError;frappe.PermissionError=PermissionError
        def fail(message,kind=ValidationError):raise kind(message)
        frappe.throw=fail
        utils=ModuleType('frappe.utils');utils.now_datetime=lambda:'now'
        password=ModuleType('frappe.utils.password');password.remove_encrypted_password=Mock()
        package=ModuleType('shangshu_mail');package.transport=SimpleNamespace(PROVIDERS={})
        modules={'frappe':frappe,'frappe.utils':utils,'frappe.utils.password':password,'shangshu_mail':package}
        patched=patch.dict('sys.modules',modules);patched.start();self.addCleanup(patched.stop)
        spec=importlib.util.spec_from_file_location('signature_account',ROOT/'frappe_apps/shangshu_mail/shangshu_mail/account.py')
        self.account=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.account)
        self.doc=SimpleNamespace(signature_enabled=1,signature_html='<p>旧默认</p>',signature_resources='[]',signature_profiles='',
                                 default_signature_id='',signature_revision=0,email_account='bound',provider='qq',email_address='owner@example.invalid',
                                 display_name='合成员工',kind='personal',department='',enabled=1,connection_status='connected',last_error='',last_sync_at=None,last_tested_at=None)
        self.doc.save=Mock();self.account.get_account=Mock(return_value=self.doc);self.account.require_right=Mock()
        self.payload={'mailbox':'synthetic-box','enabled':True,'signature_revision':0,'default_signature_id':'a','signatures':[
            {'id':'a','name':'业务签名','html':'<p>业务</p>','resources':[]},
            {'id':'b','name':'简短签名','html':'<p>简短</p>','resources':[]}]}

    def save(self,payload=None):return self.account.signature('mail.account.signature',payload or self.payload,{'source':'user'})

    def test_legacy_projection_is_listed_without_writing_or_losing_old_default(self):
        state=self.account.signature_projection(self.doc,include_profiles=True)
        self.assertEqual(state['html'],'<p>旧默认</p>');self.assertEqual(len(state['signatures']),1)
        self.assertEqual(state['signatures'][0]['id'],state['default_signature_id']);self.doc.save.assert_not_called()

    def test_multiple_persist_default_and_managed_resources_in_one_save(self):
        resource={'content_id':'logo','file':'managed-file','source':{'ref_doctype':'Shangshu File Center File','ref_name':'logo-library','file':'managed-file'}}
        self.payload['signatures'][1]['resources']=[resource];self.payload['default_signature_id']='b'
        result=self.save();self.assertEqual(result['signature']['html'],'<p>简短</p>')
        self.assertEqual(self.doc.default_signature_id,'b');self.assertEqual(self.doc.signature_revision,1)
        self.assertEqual(json.loads(self.doc.signature_resources),[resource]);self.assertEqual(len(json.loads(self.doc.signature_profiles)),2)
        self.account.require_right.assert_called_once_with('synthetic-box','signature');self.doc.save.assert_called_once()

    def test_new_nondefault_does_not_replace_default(self):
        self.save();self.assertEqual(self.doc.signature_html,'<p>业务</p>')
        state=self.account.signature_projection(self.doc,include_profiles=True)
        self.assertEqual(state['default_signature_id'],'a');self.assertEqual(len(state['signatures']),2)

    def test_send_projection_does_not_expose_other_managed_profiles(self):
        self.save()
        state=self.account.signature_projection(self.doc)
        self.assertEqual(state['html'],'<p>业务</p>');self.assertNotIn('signatures',state)

    def test_stale_revision_rejected_before_write(self):
        self.doc.signature_revision=1
        with self.assertRaisesRegex(ValidationError,'更新|重新'):self.save()
        self.doc.save.assert_not_called();self.assertEqual(self.doc.signature_html,'<p>旧默认</p>')

    def test_invalid_default_duplicate_id_and_unsafe_nondefault_are_rejected(self):
        for change in ('missing-default','duplicate','unsafe','missing-revision'):
            payload=json.loads(json.dumps(self.payload))
            if change=='missing-default':payload['default_signature_id']='foreign'
            if change=='duplicate':payload['signatures'][1]['id']='a'
            if change=='unsafe':payload['signatures'][1]['html']='<img onerror="alert(1)">'
            if change=='missing-revision':payload.pop('signature_revision')
            with self.assertRaises(ValidationError,msg=change):self.save(payload)
        self.doc.save.assert_not_called()

    def test_legacy_write_updates_only_existing_default_and_keeps_other_signatures(self):
        self.save();self.doc.save.reset_mock()
        self.save({'mailbox':'synthetic-box','enabled':False,'html':'<p>兼容更新</p>'})
        profiles=json.loads(self.doc.signature_profiles)
        self.assertEqual(profiles[0]['html'],'<p>兼容更新</p>');self.assertEqual(profiles[1]['html'],'<p>简短</p>')
        self.assertEqual(self.doc.signature_enabled,0);self.assertEqual(self.doc.signature_revision,2)

    def test_denied_signature_right_never_saves_or_changes_send_grants(self):
        self.account.require_right.side_effect=PermissionError('no signature right')
        with self.assertRaises(PermissionError):self.save()
        self.doc.save.assert_not_called();self.account.get_account.assert_not_called()

if __name__=='__main__':main()
