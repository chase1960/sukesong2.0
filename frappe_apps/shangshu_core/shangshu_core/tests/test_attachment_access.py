"""基础附件的窄范围契约回归，不需要业务库。"""
import unittest
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from shangshu_core import attachments


class AttachmentAccessTest(unittest.TestCase):
    def setUp(self):
        for target, kwargs in [
            ('session', {'new': SimpleNamespace(user='worker@example.invalid')}),
            ('get_all', {'return_value': [SimpleNamespace(domain_id='com.example.files', contribution_json='{"objects":[{"doctype":"Example File"}]}')]}),
            ('has_permission', {'return_value': False}),
        ]:
            mock = patch.object(frappe, target, **kwargs)
            mock.start()
            self.addCleanup(mock.stop)
        identity = patch.object(attachments, 'get_identity')
        identity.start()
        self.addCleanup(identity.stop)

    def test_registered_attachment_enters_owner_before_permission(self):
        document = SimpleNamespace(doctype='Example File', name='record-1')
        @contextmanager
        def enter(owner):
            self.assertEqual(owner, 'com.example.files')
            with patch.object(frappe, 'has_permission', return_value=True) as permission:
                yield
                permission.assert_called_once_with('Example File', 'read', doc=document)
        with patch.object(attachments, 'domain_execution', side_effect=enter), patch.object(frappe, 'get_doc', return_value=document) as read:
            self.assertTrue(attachments.can_read_reference('Example File', 'record-1'))
            read.assert_called_once_with('Example File', 'record-1')

    def test_stopped_domain_never_calls_business_permission(self):
        with patch.object(attachments, 'domain_execution', side_effect=frappe.PermissionError):
            self.assertFalse(attachments.can_read_reference('Example File', 'record-1'))
        frappe.has_permission.assert_not_called()

    def test_attached_private_file_does_not_fall_back_to_owner(self):
        file = SimpleNamespace(is_private=1, attached_to_doctype='Example File', attached_to_name='record-1')
        with patch.object(attachments, 'can_read_reference', return_value=False), patch.object(attachments.File, 'is_downloadable', return_value=True) as original:
            self.assertFalse(attachments.PlatformFile.is_downloadable(file))
            original.assert_not_called()

    def test_unattached_and_public_files_keep_frappe_rules(self):
        for values in [(1, None, None), (0, 'Example File', 'record-1')]:
            file = object.__new__(attachments.PlatformFile)
            file.is_private, file.attached_to_doctype, file.attached_to_name = values
            with patch.object(attachments.File, 'is_downloadable', return_value=True) as original:
                self.assertTrue(file.is_downloadable())
                original.assert_called_once()

    def test_guest_and_missing_reference_are_denied(self):
        self.assertFalse(attachments.can_read_reference('', 'record-1'))
        with patch.object(frappe, 'session', SimpleNamespace(user='Guest')):
            self.assertFalse(attachments.can_read_reference('Example File', 'record-1'))
        frappe.get_all.assert_not_called()

    def test_binding_requires_active_action_and_matching_target_owner(self):
        from shangshu_core import domains
        for pin, owner in [({}, None), ({'action_id':'mail.save'}, {'id':'com.example.mail'})]:
            with patch.object(frappe, 'flags', SimpleNamespace(shangshu_call_domain='com.example.mail',shangshu_action_pin=pin)), \
                 patch.object(domains, 'raw_resource', return_value=(owner, {})), \
                 patch.object(frappe, 'throw', side_effect=frappe.PermissionError), \
                 patch.object(frappe, 'get_doc') as read:
                with self.assertRaises(frappe.PermissionError):
                    attachments.bind_record_attachments('Example File', 'record-1', ['file-1'])
                read.assert_not_called()

    def test_attachment_projection_rejects_wrong_record(self):
        file = SimpleNamespace(attached_to_doctype='Example File', attached_to_name='other-record')
        with patch.object(attachments, 'domain_execution', return_value=nullcontext()), \
             patch.object(attachments, 'can_read_reference', return_value=True), \
             patch.object(frappe, 'get_doc', return_value=file), \
             patch.object(frappe, 'throw', side_effect=frappe.PermissionError):
            with self.assertRaises(frappe.PermissionError):
                attachments.get_record_attachments('Example File', 'record-1', ['file-1'])

    def test_public_attachment_metadata_proxies_source_authorization_through_core(self):
        file = SimpleNamespace(name='file-1',file_name='报价.txt',file_size=4,
            attached_to_doctype='Example File',attached_to_name='record-1',is_private=1,is_folder=0)
        with patch.object(attachments, 'domain_execution', return_value=nullcontext()) as boundary, \
             patch.object(attachments, 'can_read_reference', return_value=True), \
             patch.object(frappe, 'get_doc', return_value=file):
            self.assertEqual(attachments.get_record_attachments('Example File','record-1',['file-1'])[0]['name'], '报价.txt')
            boundary.assert_called_once_with('com.shangshu.core')

    def test_reference_input_is_bounded_before_any_business_read(self):
        for files in ['file-1', ['file-1']*21, [''], [None]]:
            with patch.object(frappe, 'throw', side_effect=frappe.ValidationError), \
                 patch.object(attachments, 'can_read_reference') as permission:
                with self.assertRaises(frappe.ValidationError):
                    attachments.get_record_attachments('Example File','record-1',files)
                permission.assert_not_called()
