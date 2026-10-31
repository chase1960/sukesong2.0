"""Requires a migrated Frappe site; never counted as local unit validation."""
import json
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import get_request_context, execute_registered_action
from shangshu_recruitment.tests import test_job as job_fixtures
from shangshu_recruitment.workbench import context_service, REVIEW, RULE, TASK


class TestRecruitmentWorkbenchSite(FrappeTestCase):
    setUp = job_fixtures.TestJobs.setUp
    action = job_fixtures.TestJobs.action
    job_payload = job_fixtures.TestJobs.job_payload
    jd_payload = job_fixtures.TestJobs.jd_payload
    rubric_payload = job_fixtures.TestJobs.rubric_payload
    publish_pair = job_fixtures.TestJobs.publish_pair

    def test_task_receipt_replay_revision_and_enterprise_boundaries(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())['job']
        key = frappe.generate_hash(length=24)
        payload = {'job': job, 'title': '核实缺失材料', 'owner_user': self.users['recruiter'],
                   'escalation_user': self.users['recruiter'], 'due_at': str(frappe.utils.add_days(frappe.utils.now_datetime(), 1))}
        first = self.action('recruiter', 'recruitment.task.save', payload, key)
        self.assertEqual(first, self.action('recruiter', 'recruitment.task.save', payload, key))
        self.assertEqual(frappe.db.count(TASK, {'job': job}), 1)
        with self.assertRaises(frappe.PermissionError):
            self.action('foreign', 'recruitment.task.save', payload)
        with self.assertRaises(frappe.PermissionError):
            self.action('manager', 'recruitment.task.resolve', {'record': first['record'], 'revision': 1, 'state': 'closed', 'receipt': '越权'})
        done = self.action('recruiter', 'recruitment.task.resolve', {'record': first['record'], 'revision': 1, 'state': 'closed', 'receipt': '已核实并归档材料'})
        self.assertEqual(done['revision'], 2)
        with self.assertRaisesRegex(frappe.ValidationError, 'REVISION_CONFLICT'):
            self.action('recruiter', 'recruitment.task.resolve', {'record': first['record'], 'revision': 1, 'state': 'open', 'receipt': '旧版本'})

    def review_fixture(self):
        created = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        self.publish_pair(created['job'])
        opened = self.action('recruiter', 'recruitment.job.open', {'job': created['job'], 'revision': 1})
        frappe.set_user(self.users['recruiter'])
        ctx = get_request_context()
        old = getattr(frappe.flags, 'recruitment_write', False)
        frappe.flags.recruitment_write = True
        try:
            # Synthetic references only: file/mail service integrations have separate site tests.
            candidate = frappe.get_doc({'doctype': 'Shangshu Recruitment Candidate', 'enterprise_id': ctx['enterprise_id'],
                                        'display_name': '证据测试候选人', 'source': 'manual', 'revision': 1}).insert(ignore_permissions=True)
            intake = frappe.get_doc({'doctype': 'Shangshu Recruitment Intake', 'enterprise_id': ctx['enterprise_id'],
                                     'source_type': 'manual', 'idempotency_key': frappe.generate_hash(), 'status': 'converted',
                                     'received_at': frappe.utils.now_datetime(), 'revision': 1}).insert(ignore_permissions=True)
            resume = frappe.get_doc({'doctype': 'Shangshu Recruitment Resume', 'enterprise_id': ctx['enterprise_id'],
                                     'candidate': candidate.name, 'intake': intake.name, 'file_reference': 'synthetic-file',
                                     'file_sha256': 'a' * 64, 'source_type': 'manual', 'parser_status': 'needs_manual',
                                     'created_at': frappe.utils.now_datetime(), 'parse_attempts': 0, 'revision': 1}).insert(ignore_permissions=True)
            app = frappe.get_doc({'doctype': 'Shangshu Recruitment Application', 'enterprise_id': ctx['enterprise_id'],
                                  'job': created['job'], 'candidate': candidate.name, 'primary_resume': resume.name,
                                  'applied_at': frappe.utils.now_datetime(), 'outcome': 'active', 'revision': 1}).insert(ignore_permissions=True)
        finally:
            frappe.flags.recruitment_write = old
        return opened, app, ctx

    def test_evidence_quotes_decision_and_result_are_one_confirmed_chain(self):
        job, app, ctx = self.review_fixture()
        context = context_service('', {'application': app.name}, ctx)
        matrix = [{'criterion_id': c['id'], 'status': 'missing', 'citations': [], 'question': '请提供具体案例'} for c in context['snapshot']['criteria']]
        payload = {'application': app.name, 'context_hash': context['context_hash'], 'source_text': '候选人自述文本，尚待核实。',
                   'matrix': json.dumps(matrix, ensure_ascii=False), 'rule_versions': '[]', 'model_version': 'human', 'preparation_seconds': 30}
        review = self.action('recruiter', 'recruitment.review.create', payload)
        with self.assertRaises(frappe.ValidationError):
            self.action('recruiter', 'recruitment.review.create', {**payload, 'context_hash': 'stale'})
        decided = self.action('recruiter', 'recruitment.review.decide', {'record': review['record'], 'revision': 1, 'decision': 'reject',
                              'reason': '核实后必要条件不满足', 'exceptions': '无', 'review_seconds': 20})
        self.assertEqual(frappe.db.get_value('Shangshu Recruitment Application', app.name, 'outcome'), 'rejected')
        self.assertEqual(frappe.db.get_value(REVIEW, review['record'], 'state'), 'decided')
        self.assertEqual(frappe.db.count('Shangshu Recruitment Screening', {'application': app.name, 'decision': 'reject'}), 1)
        self.action('recruiter', 'recruitment.followup.record', {'review': review['record'], 'observed_on': frappe.utils.today(),
                    'outcome': 'inconclusive', 'observation': '尚未取得独立验证结果', 'rework_seconds': 10})
        rule_payload = {'job': job['job'], 'rubric': job['current_rubric_revision'], 'title': '核对交付案例', 'guidance': '先核对实际交付责任再形成判断',
                        'evidence_reviews': json.dumps([review['record']]), 'counterexamples': '[]', 'limitations': '单一案例不足以证明有效',
                        'expires_on': str(frappe.utils.add_days(frappe.utils.getdate(), 30)), 'change_reason': '案例提出的待验证建议'}
        rule = self.action('recruiter', 'recruitment.rule.create', rule_payload)
        self.action('sysadmin', 'recruitment.rule.transition', {'record': rule['record'], 'revision': 1, 'state': 'active', 'reason': '审阅边界与局限后试用'})
        self.assertEqual(frappe.db.get_value(RULE, rule['record'], 'state'), 'active')
        self.action('sysadmin', 'recruitment.rule.transition', {'record': rule['record'], 'revision': 2, 'state': 'paused', 'reason': '等待更多结果验证'})
        revised = self.action('recruiter', 'recruitment.rule.create', {**rule_payload, 'previous': rule['record'], 'change_reason': '补充边界后重新审阅'})
        self.assertEqual(frappe.db.get_value(RULE, revised['record'], 'version_no'), 2)
