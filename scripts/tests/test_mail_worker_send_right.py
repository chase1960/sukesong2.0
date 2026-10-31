"""Run the real worker with isolated Frappe I/O; never access SMTP or a site."""
import importlib
import importlib.util
import sys
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
# 真 app 包进 sys.path —— delivery.py 顶部有
# `from shangshu_mail import account, transport` / `from shangshu_mail.domain import DOMAIN, DOCTYPE`
# / `from shangshu_mail.external_assets import ...`，
# 手搓的裸模块 shangshu_mail 不是包 ⇒ 这些子模块一个都找不到。
install_real_environment()
import shangshu_mail.account
import shangshu_mail.service
import shangshu_mail.transport

ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception):pass

class WorkerSendRight(TestCase):
    def setUp(self):
        self.allowed=True;self.commits=[];self.revoke_after_claim=False
        self.doc=SimpleNamespace(name='synthetic-draft',owner='author',mailbox_id='shared-box',status='Queued',
            record_version=2,binding_generation='generation-1',to_json='["receiver@example.invalid"]',cc_json='[]',
            subject='合成邮件',body='正文',body_format='Text',message_id='<synthetic@example.invalid>',in_reply_to='',
            attachment_ids_json='[]',inline_resources_json='[]',attachment_labels_json='{}')
        self.doc.get=lambda key,default=None:getattr(self.doc,key,default)
        self.doc.save=Mock()
        def commit():
            self.commits.append(self.doc.status)
            if self.revoke_after_claim and len(self.commits)==1:self.allowed=False
        def require_right(mailbox,right):
            self.assertEqual((mailbox,right),('shared-box','send'))
            if not self.allowed:raise Denied('synthetic revoked permission')
        self.require_right=Mock(side_effect=require_right)
        binding=SimpleNamespace(binding_generation='generation-1',display_name='合成共享邮箱',email_address='sender@example.invalid',provider='qq')
        self.credentials=Mock(return_value=('sender@example.invalid','synthetic-only'))
        self.smtp=Mock(return_value={'status':'Sent','error':'','rejected':[]})
        fake=ModuleType('frappe');fake.session=SimpleNamespace(user='original-worker');fake.set_user=lambda user:setattr(fake.session,'user',user)
        fake.db=SimpleNamespace(commit=commit,rollback=Mock());fake.clear_messages=Mock();fake.PermissionError=Denied
        core=ModuleType('shangshu_core');api=ModuleType('shangshu_core.public_api')
        for name,value in dict(domain_execution=lambda *a:nullcontext(),get_request_context=lambda:True,
                               get_record_attachments=lambda *a:[],require_roles=lambda *a:True).items():setattr(api,name,value)
        # 账号／投递／正文服务走**真 mail 包里的真模块**，测试要控的那几个点用 Mock 顶掉
        # （凭据与 SMTP 全程不碰真东西）。原来挂的是手搓的裸模块 shangshu_mail，
        # delivery.py 顶部的 `from shangshu_mail import ...` / `from shangshu_mail.domain import ...`
        # / `from shangshu_mail.external_assets import ...` 一个都取不到。
        account=shangshu_mail.account
        account.get_account=Mock(return_value=binding)
        account.credentials=self.credentials
        account.require_right=self.require_right
        account.account_name=lambda user:'personal:'+user
        transport=shangshu_mail.transport
        transport.send_message=self.smtp
        service=shangshu_mail.service
        service.message=lambda *a,**kw:self.doc
        service.writing=lambda:nullcontext()
        modules={'frappe':fake,'frappe.utils':SimpleNamespace(now_datetime=lambda:'now'),
            'shangshu_core':core,'shangshu_core.public_api':api}
        self.modules=patch.dict('sys.modules',modules);self.modules.start();self.addCleanup(self.modules.stop)
        spec=importlib.util.spec_from_file_location('candidate_delivery',ROOT/'frappe_apps/shangshu_mail/shangshu_mail/delivery.py')
        self.delivery=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.delivery)
        self.frappe=fake

    def test_revoke_send_but_keep_read_before_worker_prevents_credentials_and_smtp(self):
        self.allowed=False;self.delivery.process_send(self.doc.name,'author')
        self.credentials.assert_not_called();self.smtp.assert_not_called()
        self.assertEqual(self.doc.status,'Failed');self.assertIn('权限',self.doc.delivery_error)
        self.assertIn('未发送',self.doc.delivery_error);self.assertEqual(self.commits,['Failed'])
        self.assertEqual(self.frappe.session.user,'original-worker')

    def test_revoke_after_sending_claim_is_rechecked_before_credentials_or_smtp(self):
        self.revoke_after_claim=True;self.delivery.process_send(self.doc.name,'author')
        self.credentials.assert_not_called();self.smtp.assert_not_called()
        self.assertEqual(self.commits,['Sending','Failed']);self.assertEqual(self.require_right.call_count,2)
        self.delivery.process_send(self.doc.name,'author');self.smtp.assert_not_called()

    def test_authorized_worker_sends_once_and_terminal_retry_cannot_send_again(self):
        self.delivery.process_send(self.doc.name,'author');self.delivery.process_send(self.doc.name,'author')
        self.assertEqual(self.doc.status,'Sent');self.assertEqual(self.commits,['Sending','Sent'])
        self.credentials.assert_called_once();self.smtp.assert_called_once()
        self.assertEqual(self.require_right.call_count,2)

if __name__=='__main__':main()
