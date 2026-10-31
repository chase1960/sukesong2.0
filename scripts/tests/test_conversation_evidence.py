"""签发验真、身份边界、请求范围清理：通过意味着客户端不能伪造日志所属会话。"""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

class Evidence(unittest.TestCase):
    def setUp(self):
        self.identity=SimpleNamespace(name='actor',enterprise_id='company')
        self.flags=SimpleNamespace()
        self.fr=SimpleNamespace(conf={'encryption_key':'synthetic-secret'},flags=self.flags,
            ValidationError=ValueError,PermissionError=PermissionError,
            throw=lambda msg,error: (_ for _ in ()).throw(error(msg)))
        scope=patch.dict(sys.modules,{'frappe':self.fr,'shangshu_core.identity':SimpleNamespace(get_identity=lambda:self.identity)})
        scope.start();self.addCleanup(scope.stop)
        path=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core/shangshu_core/conversation_evidence.py'
        spec=importlib.util.spec_from_file_location('conversation_actual',path)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
    def test_issue_verify_tamper_identity_expiry(self):
        issued=self.m.issue_conversation();token=issued['credential']
        self.assertEqual(self.m.verify_conversation(token),issued['conversation_key'])
        for bad in [issued['conversation_key'],token+'x','',None]:
            with self.assertRaises(PermissionError):self.m.verify_conversation(bad)
        self.identity.name='other'
        with self.assertRaises(PermissionError):self.m.verify_conversation(token)
        self.identity.name='actor';self.identity.enterprise_id='other-company'
        with self.assertRaises(PermissionError):self.m.verify_conversation(token)
        self.identity.enterprise_id='company'
        with patch.object(self.m.time,'time',return_value=issued['expires_at']):
            with self.assertRaises(PermissionError):self.m.verify_conversation(token)
    def test_request_cleanup_and_confirmed_proposal_pin_no_extra_query(self):
        issued=self.m.issue_conversation()
        with self.assertRaises(RuntimeError):
            with self.m.conversation_scope(issued['credential']):
                self.assertEqual(self.m.current_conversation_key(),issued['conversation_key'])
                self.flags.shangshu_resolving_proposal='proposal'
                self.flags.shangshu_resolving_conversation_key='original-conversation'
                self.assertEqual(self.m.current_conversation_key(),'original-conversation')
                raise RuntimeError()
        self.assertIsNone(self.flags.shangshu_conversation_key)
