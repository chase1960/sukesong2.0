"""Unit boundaries only; database/transaction behavior belongs to test_workbench_site."""
import copy
import datetime
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch


class TestWorkbenchBoundaries(unittest.TestCase):
    def setUp(self):
        self.frappe = types.ModuleType('frappe')
        self.frappe.__path__ = []
        self.frappe.ValidationError = ValueError
        self.frappe.PermissionError = PermissionError
        self.frappe.throw = lambda message, error: (_ for _ in ()).throw(error(message))
        self.frappe.get_doc = Mock()
        self.frappe.get_all = Mock(return_value=[])
        self.frappe.db = types.SimpleNamespace(exists=Mock(return_value=False))
        self.frappe.flags = types.SimpleNamespace(recruitment_write=True)
        self.frappe.utils = types.SimpleNamespace(today=lambda: '2026-11-01', now_datetime=lambda: datetime.datetime(2026, 11, 1),
                                                 getdate=lambda value=None: datetime.date.fromisoformat(str(value)[:10]) if value else datetime.date(2026, 11, 1))
        api = types.ModuleType('shangshu_core.public_api')
        api.__getattr__ = lambda name: Mock()
        core = types.ModuleType('shangshu_core'); core.__path__ = []; core.public_api = api
        self.modules = patch.dict(sys.modules, {'frappe': self.frappe, 'shangshu_core': core, 'shangshu_core.public_api': api})
        self.modules.start()
        self.paths = patch.object(sys, 'path', [str(Path(__file__).parents[2]), *sys.path]); self.paths.start()
        for name in list(sys.modules):
            if name.startswith('shangshu_recruitment'):
                sys.modules.pop(name)
        self.w = importlib.import_module('shangshu_recruitment.workbench')
        self.ctx = {'enterprise_id': 'E', 'user_name': 'reviewer', 'roles': ['Recruitment Admin']}

    def tearDown(self):
        for name in list(sys.modules):
            if name.startswith('shangshu_recruitment'):
                sys.modules.pop(name)
        self.paths.stop(); self.modules.stop()

    def test_foreign_enterprise_record_denied_even_if_role_permission_claims_true(self):
        self.frappe.get_doc.return_value = types.SimpleNamespace(enterprise_id='FOREIGN', job='J')
        with patch.object(self.w, 'record_permission', return_value=True), self.assertRaises(PermissionError):
            self.w.locked_record(self.w.REVIEW, 'R', self.ctx)

    def test_job_permissions_cannot_be_replaced_by_role_only(self):
        with patch.object(self.w, 'permission', return_value=False), self.assertRaises(PermissionError):
            self.w.readable_job('J', self.ctx)

    def test_changed_context_rejects_review_without_inserting(self):
        app, job = types.SimpleNamespace(outcome='active', name='A'), types.SimpleNamespace(name='J')
        with patch.object(self.w, 'evidence_context', return_value=(app, job, {})), patch.object(self.w, 'insert_record') as insert:
            with self.assertRaisesRegex(ValueError, '已变化'):
                self.w.create_review({'application': 'A', 'context_hash': 'stale'}, self.ctx)
            insert.assert_not_called()

    def test_paused_or_foreign_rule_version_cannot_be_attached_to_review(self):
        snapshot = {'rule_versions': []}
        app, job = types.SimpleNamespace(outcome='active', name='A'), types.SimpleNamespace(name='J')
        payload = {'application': 'A', 'context_hash': self.w.fingerprint(snapshot), 'rule_versions': '[{"name":"foreign","version_no":1}]'}
        with patch.object(self.w, 'evidence_context', return_value=(app, job, snapshot)), self.assertRaisesRegex(ValueError, '规则已失效'):
            self.w.create_review(payload, self.ctx)

    def test_stale_decision_revision_rejected(self):
        doc = types.SimpleNamespace(revision=2)
        with patch.object(self.w, 'locked_record', return_value=doc), self.assertRaisesRegex(ValueError, 'REVISION_CONFLICT'):
            self.w.decide_review({'record': 'R', 'revision': 1}, self.ctx)

    def test_changed_resume_or_standards_blocks_decision(self):
        doc = types.SimpleNamespace(revision=1, state='draft', application='A', context_hash='old')
        with patch.object(self.w, 'locked_record', return_value=doc), patch.object(self.w, 'evidence_context', return_value=(types.SimpleNamespace(outcome='active'), None, {'new': 1})), self.assertRaisesRegex(ValueError, '发生变化'):
            self.w.decide_review({'record': 'R', 'revision': 1}, self.ctx)

    def test_rule_author_cannot_self_publish(self):
        doc = types.SimpleNamespace(revision=1, state='draft', job='J', rubric='S', expires_on='2027-01-01', owner='reviewer')
        with patch.object(self.w, 'locked_record', return_value=doc), patch.object(self.w, 'readable_job', return_value=types.SimpleNamespace(current_rubric_revision='S')), self.assertRaisesRegex(ValueError, '另一位'):
            self.w.transition_rule({'record': 'R', 'revision': 1, 'state': 'active'}, self.ctx)

    def test_expired_rule_and_retired_version_cannot_activate(self):
        for state, expires in [('paused', '2026-10-01'), ('retired', '2027-01-01')]:
            doc = types.SimpleNamespace(revision=1, state=state, job='J', rubric='S', expires_on=expires, owner='someone')
            with patch.object(self.w, 'locked_record', return_value=doc), patch.object(self.w, 'readable_job', return_value=types.SimpleNamespace(current_rubric_revision='S')), self.assertRaises(ValueError):
                self.w.transition_rule({'record': 'R', 'revision': 1, 'state': 'active'}, self.ctx)

    def test_unassigned_recruiter_cannot_close_someone_elses_task(self):
        doc = types.SimpleNamespace(revision=1, owner_user='owner', escalation_user='lead', state='open')
        with patch.object(self.w, 'locked_record', return_value=doc), self.assertRaises(PermissionError):
            self.w.resolve_task({'record': 'T', 'revision': 1, 'state': 'closed', 'receipt': '处理了'}, {**self.ctx, 'roles': ['Recruiter']})

    def test_published_rule_content_and_decided_evidence_are_immutable(self):
        for doctype, old_state in [(self.w.RULE, 'active'), (self.w.REVIEW, 'decided'), (self.w.FOLLOWUP, '')]:
            old = {'enterprise_id': 'E', 'job': 'J', 'state': old_state, 'source_text': 'original'}
            previous = types.SimpleNamespace(state=old_state, get=lambda k: old.get(k))
            changed = {**old, 'source_text': 'altered'}
            doc = types.SimpleNamespace(doctype=doctype, get_doc_before_save=lambda: previous, get=lambda k: changed.get(k),
                                        meta=types.SimpleNamespace(fields=[types.SimpleNamespace(fieldname=k) for k in changed]))
            with self.assertRaisesRegex(ValueError, 'IMMUTABLE'):
                self.w.validate_record(doc)


if __name__ == '__main__':
    unittest.main()
