"""执行真实worker函数的隔离回归；不连接服务商，不替代实库权限验收。"""
import ast
from contextlib import nullcontext
import json
import mimetypes
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_mail/shangshu_mail/delivery.py'


class DeliveryTests(unittest.TestCase):
    def run_worker(self, revoke_at=None, attachments=False, status='Queued'):
        class Denied(Exception):
            pass
        phases=[];sent=[];saved=[];credentials=[]
        actor=SimpleNamespace(user='original')
        doc=SimpleNamespace(status=status,owner='owner',mailbox_id='department-box',
            binding_generation='g1',record_version=2,attachment_ids_json='["f1"]' if attachments else '[]',
            attachment_labels_json='{"f1":{"name":"报价.xlsx"}}',inline_resources_json='[]',
            subject='报价确认',body='表格',to_json='["client@example.invalid"]',cc_json='[]',
            message_id='<fixed>',in_reply_to='',name='message-1',get=lambda key:'HTML')
        binding=SimpleNamespace(binding_generation='g1',display_name='采购',provider='qq')
        commits=[]
        def require_right(mailbox,right,*args):
            self.assertEqual((mailbox,right),('department-box','send'))
            if revoke_at is not None and len(commits)>=revoke_at:raise Denied('已撤权')
        def message(name,lock=False):
            self.assertEqual(name,doc.name);self.assertTrue(lock);phases.append(name);return doc
        def transport(*args,**kwargs):
            sent.append((args,kwargs));return {'status':'Sent','error':'','rejected':[]}
        service=ModuleType('shangshu_mail.service');service.message=message
        env={'json':json,'mimetypes':mimetypes,'DOMAIN':'com.shangshu.mail','DOCTYPE':'Shangshu Mail Message',
            'domain_execution':lambda *args:nullcontext(),
            'get_record_attachments':lambda *args:[{'file':'f1','name':'原始报价.xlsx'}] if attachments else [],
            'now_datetime':lambda:'2026-10-20 12:00:00','_validate_actor':lambda:None,
            '_save':lambda value:saved.append(value.status),
            'account':SimpleNamespace(account_name=lambda owner:'personal-box',require_right=require_right,
                get_account=lambda **kwargs:binding,
                credentials=lambda value:credentials.append(value) or ('sender@example.invalid','not-a-secret')),
            'transport':SimpleNamespace(send_message=transport),
            'frappe':SimpleNamespace(PermissionError=Denied,session=actor,
                set_user=lambda user:setattr(actor,'user',user),
                get_doc=lambda *args:SimpleNamespace(file_name='原始报价.xlsx',get_content=lambda:b'xlsx'),
                db=SimpleNamespace(commit=lambda:commits.append(1),rollback=lambda:None))}
        tree=ast.parse(SOURCE.read_text())
        selected=[node for node in tree.body if isinstance(node,ast.FunctionDef)
                  and node.name in ('process_send','_has_send_right')]
        exec(compile(ast.Module(body=selected,type_ignores=[]),str(SOURCE),'exec'),env)
        with patch.dict(sys.modules,{'shangshu_mail.service':service}):
            env['process_send'](doc.name,'operator')
        self.assertEqual(actor.user,'original','worker结束须恢复原会话')
        return doc,sent,saved,credentials

    def test_revoke_before_worker_blocks_transport_and_credentials(self):
        doc,sent,saved,credentials=self.run_worker(revoke_at=0)
        self.assertEqual(sent,[])
        self.assertEqual(credentials,[])
        self.assertEqual(doc.status,'Failed')
        self.assertIn('权限',doc.delivery_error)

    def test_revoke_after_queued_commit_blocks_actual_send(self):
        doc,sent,saved,credentials=self.run_worker(revoke_at=1)
        self.assertEqual(sent,[])
        self.assertEqual(credentials,[])
        self.assertEqual(saved,['Sending','Failed'])
        self.assertEqual(doc.status,'Failed')

    def test_authorized_sends_once_and_freezes_final_state(self):
        doc,sent,saved,_=self.run_worker()
        self.assertEqual(len(sent),1)
        self.assertEqual(saved,['Sending','Sent'])
        self.assertEqual(doc.status,'Sent')

    def test_unknown_is_never_automatically_resent(self):
        doc,sent,saved,credentials=self.run_worker(status='Unknown')
        self.assertEqual((sent,saved,credentials),([],[],[]))
        self.assertEqual(doc.status,'Unknown')

    def test_attachment_mime_matches_actual_outgoing_filename(self):
        _,sent,_,_=self.run_worker(attachments=True)
        attachment=sent[0][0][4][0]
        self.assertEqual(attachment['name'],'报价.xlsx')
        self.assertEqual(attachment.get('mime_type'),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


if __name__=='__main__':unittest.main()
