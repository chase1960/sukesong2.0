"""邮件草稿的逐项审核与整单确认。

合并说明（2026-10-21）：本文件来自 fast 那条线，`accept_action_proposal_units(...)` 的
**位置参数按合并后的公共 API 重排** —— 新签名是
`(proposal_id, op_id, expected_review_revision, units, edited_value)`（本分支那版；
fast 那版是 `(proposal_id, units, edited_value, review_revision, op_id)`）。
参数顺序是内核公共 API 的口径，不是业务断言 ⇒ 按新契约改，断言与取值一条没动。
"""
import uuid
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (execute_registered_action,propose_registered_action,
    get_action_proposal_review,accept_action_proposal_units,resolve_action_proposal,invoke_domain_service)


class TestMailOfficeReview(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator');self.token=uuid.uuid4().hex
        self.user='mail-review-'+self.token+'@example.invalid'
        self.act('platform.identity.create',{'email':self.user,'display_name':'邮件审核',
            'initial_password':'Isolated-review-2026!','roles':['staff']})
        frappe.set_user(self.user)
        self.draft=self.act('mail.save_draft',{'subject':'原主题','body':'原正文',
            'to':['recipient@example.invalid'],'cc':[]})

    def tearDown(self):frappe.set_user('Administrator');super().tearDown()
    def act(self,name,payload):
        return execute_registered_action(name,payload,confirmed=True,idempotency_key=uuid.uuid4().hex)['result']
    def read(self):return invoke_domain_service('mail.detail',{'mail':self.draft['name']})['mail']
    def propose(self):
        draft=self.read()
        return propose_registered_action('mail.save_draft',{'mail':draft['name'],'expected_version':draft['record_version'],
            'subject':'候选主题','body':'候选正文','to':draft['to'],'cc':draft['cc']})['id']

    def test_subject_edit_then_body_accept_same_original_draft(self):
        proposal=self.propose();review=get_action_proposal_review(proposal)
        first=accept_action_proposal_units(proposal, 'subject-one', review['review_revision'], ['subject'], {'subject':'人工主题'})
        self.assertEqual(self.read()['subject'],'人工主题');self.assertEqual(self.read()['body'],'原正文')
        accept_action_proposal_units(proposal, 'body-two', first['review_revision'], ['body'], {})
        self.assertEqual(self.read()['body'],'候选正文')
        self.assertEqual(resolve_action_proposal(proposal,'rejected')['status'],'rejected')
        self.assertEqual(self.read()['subject'],'人工主题')

    def test_recipients_cannot_be_manually_forged_via_edit_value(self):
        proposal=self.propose();review=get_action_proposal_review(proposal);before=self.read()
        with self.assertRaises(frappe.PermissionError):
            accept_action_proposal_units(proposal, 'bad-recipient', review['review_revision'], ['to'], {'to':['other@example.invalid']})
        self.assertEqual(self.read()['record_version'],before['record_version'])
        self.assertEqual(self.read()['to'],before['to'])

    def test_new_draft_retains_legacy_whole_confirmation(self):
        proposal=propose_registered_action('mail.save_draft',{'subject':'新草稿','body':'正文','to':[],'cc':[]})
        self.assertFalse(proposal['review_supported'])
        self.assertEqual(resolve_action_proposal(proposal['id'],'confirmed')['result']['subject'],'新草稿')

    def test_read_only_shared_member_cannot_edit_or_move_source_draft(self):
        from shangshu_mail import account
        owner=self.user
        with account.writing():
            frappe.get_doc({'doctype':account.DOCTYPE,'account_key':account.account_name(owner),
                'kind':'personal'}).insert(ignore_permissions=True)
        frappe.set_user('Administrator')
        other='mail-reader-'+self.token+'@example.invalid'
        self.act('platform.identity.create',{'email':other,'display_name':'只读同事',
            'initial_password':'Isolated-review-2026!','roles':['staff']})
        with account.access_writing():
            frappe.get_doc({'doctype':account.ACCESS,'mailbox':account.account_name(owner),
                'user':other,'can_read':1,'can_edit_draft':0}).insert(ignore_permissions=True)
        frappe.set_user(other)
        before=self.read()
        for target in (None,account.account_name(other)):
            payload={'mail':before['name'],'expected_version':before['record_version'],
                'subject':'不应保存','body':before['body'],'to':before['to'],'cc':before['cc']}
            if target:payload['mailbox']=target
            with self.assertRaises(frappe.PermissionError):self.act('mail.save_draft',payload)
            self.assertEqual(self.read()['record_version'],before['record_version'])
            self.assertEqual(self.read()['subject'],before['subject'])
