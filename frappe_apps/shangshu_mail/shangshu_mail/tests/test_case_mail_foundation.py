"""真实独立库验证邮件正文、归属、线程和原确认；不接外部邮箱。"""
import uuid
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (
    execute_registered_action, invoke_domain_service, propose_registered_action,
    resolve_action_proposal, set_domain_enabled, list_action_proposals,
)
from shangshu_mail import service, delivery


class TestCaseMailFoundation(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.prefix=uuid.uuid4().hex

    def tearDown(self):
        frappe.set_user('Administrator')
        super().tearDown()

    def act(self,action,payload,key=None):
        return execute_registered_action(action,payload,confirmed=True,
            idempotency_key=key or uuid.uuid4().hex)['result']

    def draft(self,**extra):
        return self.act('mail.save_draft',{'subject':'案件邮件'+self.prefix,
            'body':'原正文','to':['client@example.invalid'],'cc':[],**extra})

    def incoming(self,parent):
        with service.writing():
            return frappe.get_doc({'doctype':'Shangshu Mail Message','subject':'客户回复',
                'body':'已核对','status':'Received','record_version':1,
                'reply_to_mail':parent,'to_json':'[]','cc_json':'[]'}).insert(ignore_permissions=True)

    def test_html_is_sanitized_and_survives_updates_without_implicit_conversion(self):
        body='<p onclick="steal()">核对</p><table><tr><td>A001</td><td>150.00</td></tr></table><img src="https://tracker.invalid/pixel" srcset="https://tracker.invalid/large 2x" onerror="steal()">'
        saved=self.draft(body=body,body_format='HTML')
        self.assertEqual(saved['body_format'],'HTML')
        self.assertNotIn('onclick',saved['body'])
        # CID support permits an inert img element; reject fetching/executable attributes.
        self.assertNotIn('tracker.invalid',saved['body'])
        self.assertNotIn('steal()',saved['body'])
        self.assertNotRegex(saved['body'],r'<img\b[^>]*\b(?:src|srcset|onerror)\s*=')
        self.assertIn('<table>',saved['body'])
        updated=self.draft(mail=saved['name'],expected_version=1,body=saved['body'],subject='修改主题')
        self.assertEqual(updated['body_format'],'HTML')
        self.assertEqual(updated['body'],saved['body'])
        plain=self.draft(body='<p>这是纯文本，不自动识别HTML</p>')
        self.assertEqual(plain['body_format'],'Text')
        self.assertEqual(plain['body'],'<p>这是纯文本，不自动识别HTML</p>')

    def test_thread_is_bounded_current_owner_only_and_reads_same_mail_facts(self):
        root=self.draft();reply=self.incoming(root['name']);second=self.incoming(reply.name)
        other=self.draft()
        thread=invoke_domain_service('mail.thread',{'mail':reply.name})
        self.assertEqual(thread['root'],root['name'])
        self.assertEqual({row['name'] for row in thread['rows']},{root['name'],reply.name,second.name})
        self.assertNotIn(other['name'],[row['name'] for row in thread['rows']])
        self.assertFalse(thread['has_more'])
        self.assertNotIn('body',thread['rows'][0])

    def test_other_employee_and_administrator_cannot_read_private_thread(self):
        email='mail-'+self.prefix+'@example.invalid'
        self.act('platform.identity.create',{'email':email,'display_name':'合成本人邮箱',
            'initial_password':'Isolated-only-2026!','roles':['staff']})
        frappe.set_user(email)
        draft=self.draft(body='<table><tr><td>私人资料</td></tr></table>',body_format='HTML')
        proposal=propose_registered_action('mail.save_draft',{'subject':'私有建议','body':'私人资料',
            'to':['client@example.invalid'],'cc':[]})
        frappe.set_user('Administrator')
        with self.assertRaises(frappe.PermissionError):
            invoke_domain_service('mail.thread',{'mail':draft['name']})
        # 合并说明（2026-10-21）：`list_action_proposals()` 的**回包形状按合并后的公共 API 读** ——
        # 新回包是 `{'items':[…], 'next_cursor':…, 'has_more':…}`（本分支那版，带分页）；
        # fast 那版直接回**列表**。这是公共 API 的口径，不是业务断言 ⇒ 按新契约改，
        # 下面「管理员看不到别人的私有提案」这条断言本身一条没动。
        self.assertNotIn(proposal['id'],[p['id'] for p in list_action_proposals()['items']])
        with self.assertRaises(frappe.PermissionError):
            resolve_action_proposal(proposal['id'],'rejected')

    def test_agent_reject_is_zero_write_confirm_and_replay_share_original_action(self):
        payload={'subject':'确认前不保存'+self.prefix,'body':'<p>客户材料</p>',
            'body_format':'HTML','to':['client@example.invalid'],'cc':[]}
        before=frappe.db.count('Shangshu Mail Message')
        proposal=propose_registered_action('mail.save_draft',payload)
        resolve_action_proposal(proposal['id'],'rejected')
        self.assertEqual(frappe.db.count('Shangshu Mail Message'),before)
        proposal=propose_registered_action('mail.save_draft',payload)
        resolve_action_proposal(proposal['id'],'confirmed')
        resolve_action_proposal(proposal['id'],'confirmed')
        self.assertEqual(frappe.db.count('Shangshu Mail Message'),before+1)

    def test_draft_rollback_and_stale_revision_preserve_original_mail(self):
        draft=self.draft()
        # Each failed public action rolls back the request transaction before recording failure.
        # The original mail belongs to a preceding successful request, not that transaction.
        frappe.db.commit()
        before=frappe.db.count('Shangshu Mail Message')
        original=service.projection
        def fail(doc,body=False):
            if body:frappe.throw('合成读回失败',frappe.ValidationError)
            return original(doc,body)
        with patch.object(service,'projection',side_effect=fail),self.assertRaises(frappe.ValidationError):
            self.draft(body_format='HTML',body='<p>回滚</p>')
        self.assertEqual(frappe.db.count('Shangshu Mail Message'),before)
        with self.assertRaises(frappe.TimestampMismatchError):
            self.draft(mail=draft['name'],expected_version=99)
        self.assertEqual(invoke_domain_service('mail.detail',{'mail':draft['name']})['mail']['body'],'原正文')

    def test_manual_revision_confirms_original_proposal_atomically_with_full_trace(self):
        original={'subject':'待人工核对','body':'原文'*450,'body_format':'Text',
                  'to':['client@example.invalid'],'cc':[]}
        proposal=propose_registered_action('mail.save_draft',original)
        before=frappe.db.count('Shangshu Mail Message')
        resolve_action_proposal(proposal['id'],'confirmed',
            edited_value={'type':'fields','value':{'subject':'已核对报价','body':'人工修订正文'}})
        self.assertEqual(frappe.db.count('Shangshu Mail Message'),before+1)
        saved=frappe.get_doc('Shangshu Action Proposal',proposal['id'])
        import json
        self.assertEqual(json.loads(saved.original_payload_json),original)
        self.assertEqual(saved.edited_by,'Administrator')
        payload=json.loads(saved.payload_json)
        self.assertEqual(payload['body'],'人工修订正文')
        self.assertEqual(payload['to'],original['to'])

    def test_complete_stop_rejects_thread_and_restoration_does_not_copy_mail(self):
        draft=self.draft();frappe.db.commit()
        set_domain_enabled('com.shangshu.mail',False,'合成线程停域测试',stop_mode='complete');frappe.db.commit()
        try:
            with self.assertRaises(frappe.PermissionError):invoke_domain_service('mail.thread',{'mail':draft['name']})
            with self.assertRaises(frappe.PermissionError):self.draft()
        finally:
            set_domain_enabled('com.shangshu.mail',True,'合成线程恢复');frappe.db.commit()
        self.assertEqual(invoke_domain_service('mail.thread',{'mail':draft['name']})['rows'][0]['name'],draft['name'])

    def test_attachment_import_status_keeps_files_as_optional_dependency(self):
        # 不安装/不启用文件域仍可读取邮件；这里只补入库状态，不影响原邮件附件。
        for domains in ([], [{'id':'com.shangshu.files','enabled':False}],
                        [{'id':'com.shangshu.files','enabled':True,'execution_stopped':True}],
                        [{'id':'com.shangshu.files','enabled':True,'health':{'status':'unavailable'}}],
                        [{'id':'com.shangshu.files','enabled':True,'contribution':{'services':[]}}]):
            with self.subTest(domains=domains), \
                    patch('shangshu_core.public_api.list_domains',return_value=domains), \
                    patch('shangshu_core.public_api.invoke_domain_service') as invoke:
                self.assertEqual(delivery.imported_of(['source-id']),{})
                invoke.assert_not_called()

    def test_attachment_import_status_preserves_available_service_result_and_permissions(self):
        domains=[{'id':'com.shangshu.files','enabled':True,
                  'contribution':{'services':[{'id':'files.imported_of'}]}}]
        item={'source_file':'source-id','imported':True,'restricted':True,'file_center_id':None}
        with patch('shangshu_core.public_api.list_domains',return_value=domains), \
                patch('shangshu_core.public_api.invoke_domain_service',return_value={'items':[item]}) as invoke:
            self.assertEqual(delivery.imported_of(['source-id']),{'source-id':item})
            invoke.assert_called_once_with('files.imported_of',{'source_files':['source-id']})
        with patch('shangshu_core.public_api.list_domains',return_value=domains), \
                patch('shangshu_core.public_api.invoke_domain_service',side_effect=frappe.PermissionError('拒绝')):
            with self.assertRaises(frappe.PermissionError):
                delivery.imported_of(['source-id'])
