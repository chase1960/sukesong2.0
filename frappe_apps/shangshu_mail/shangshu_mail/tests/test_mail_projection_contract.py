"""Public mail projections preserve the actual mailbox; no database writes needed."""
from unittest import TestCase
from unittest.mock import patch

import frappe
from shangshu_mail import service


class TestMailProjectionContract(TestCase):
    def test_list_and_detail_preserve_mailbox_independent_of_owner(self):
        document=frappe._dict(name='projection-contract',owner='operator@example.invalid',
            mailbox_id='shared-mailbox',status='Draft',record_version=3,
            subject='contract',body='body',to_json='[]',cc_json='[]',attachment_ids_json='[]')
        with patch.object(service,'get_record_attachments',return_value=[]):
            for include_body in (False,True):
                result=service.projection(document,body=include_body,state={})
                self.assertEqual(result['mailbox_id'],'shared-mailbox')
                self.assertEqual(result['owner'],'operator@example.invalid')
                self.assertEqual(result['name'],document.name)
