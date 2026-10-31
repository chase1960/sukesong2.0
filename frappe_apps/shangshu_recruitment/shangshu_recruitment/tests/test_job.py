import frappe
from unittest.mock import patch
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import execute_registered_action

from shangshu_recruitment.job import permission, permission_query


class TestJobs(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        from shangshu_core.public_api import set_domain_enabled
        set_domain_enabled('com.shangshu.recruitment', True, '招聘用例准备：启用本域')
        self.suffix = frappe.generate_hash(length=10)
        self.users = {}
        fixtures = [('recruiter', 'Recruiter'), ('manager', 'Hiring Manager'),
                    ('other_manager', 'Hiring Manager'), ('sysadmin', 'System Manager'),
                    ('foreign', 'Recruiter'), ('outsider', None)]
        # Synthetic fixture creation only; the production limiter is restored
        # before any action or permission assertion runs.
        with patch('frappe.core.doctype.user.user.throttle_user_creation'):
            for key, role in fixtures:
                user = key + self.suffix + '@example.invalid'
                frappe.get_doc({'doctype': 'User', 'email': user, 'first_name': key, 'send_welcome_email': 0,
                                'roles': [{'role': role}] if role else []}).insert(ignore_permissions=True)
                self.users[key] = user
                from shangshu_core.public_api import get_identity
                get_identity(user)  # Login provisions identity before an action request.
        # 另一 enterprise 的可见性夹具：越权断言用真实登录用户，不用 Administrator 冒充。
        from shangshu_core.public_api import get_identity
        frappe.db.set_value('Shangshu Identity', get_identity(self.users['foreign']).name,
                            'enterprise_id', 'foreign-' + self.suffix)
        frappe.local.shangshu_business_identities = {}

    def action(self, user, action, payload, key=None):
        frappe.db.commit()  # Prior requests/fixtures are durable before this action can roll back.
        frappe.set_user(self.users[user])
        return execute_registered_action(action, payload, confirmed=True,
                                         idempotency_key=key or frappe.generate_hash(length=24))['result']

    def job_payload(self):
        return {'job_code': 'ENG-' + self.suffix, 'title': '后端工程师', 'department': '平台部',
                'hiring_manager': self.users['manager'], 'headcount': 2,
                'requirements': '三年分布式系统经验', 'location': '北京', 'employment_type': 'full_time'}

    def jd_payload(self, job):
        return {'job': job, 'content': '负责数据平台的服务端开发与稳定性建设。', 'source': 'manual'}

    def rubric_payload(self, job):
        return {'job': job, 'required_criteria': ['五年后端开发经验'],
                'preferred_criteria': ['有开源项目贡献'], 'disallowed_criteria': ['gender', 'photo'],
                'weights': {'五年后端开发经验': 2, '有开源项目贡献': 0.5}}

    def publish_pair(self, job):
        jd = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job))
        rubric = self.action('recruiter', 'recruitment.rubric.save', self.rubric_payload(job))
        self.action('recruiter', 'recruitment.jd.publish', {'revision_document': jd['revision_document'],
                                                             'revision': jd['document_revision']})
        self.action('recruiter', 'recruitment.rubric.publish', {'revision_document': rubric['revision_document'],
                                                                 'revision': rubric['document_revision']})
        return jd, rubric

    def test_job_requires_confirmation_and_open_requires_published_revisions(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        self.assertEqual((job['status'], job['revision']), ('draft', 1))
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_JD_OR_RUBRIC_NOT_PUBLISHED'):
            self.action('recruiter', 'recruitment.job.open', {'job': job['job'], 'revision': job['revision']})
        frappe.set_user(self.users['recruiter'])
        with self.assertRaisesRegex(frappe.ValidationError, '确认'):
            execute_registered_action('recruitment.job.close', {'job': job['job'], 'revision': job['revision']},
                                      confirmed=False, idempotency_key=frappe.generate_hash())

    def test_job_partial_update_open_close_and_reopen(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        updated = self.action('recruiter', 'recruitment.job.save', {
            'job': job['job'], 'revision': job['revision'], 'title': '高级后端工程师'})
        self.assertEqual((updated['status'], updated['revision']), ('draft', 2))
        jd, rubric = self.publish_pair(job['job'])
        opened = self.action('recruiter', 'recruitment.job.open', {
            'job': job['job'], 'revision': updated['revision']})
        self.assertEqual(opened['current_jd_revision'], jd['revision_document'])
        self.assertEqual(opened['current_rubric_revision'], rubric['revision_document'])
        closed = self.action('recruiter', 'recruitment.job.close', {
            'job': job['job'], 'revision': opened['revision']})
        self.assertEqual(closed['status'], 'closed')
        reopened = self.action('recruiter', 'recruitment.job.open', {
            'job': job['job'], 'revision': closed['revision']})
        self.assertEqual(reopened['status'], 'open')
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_INVALID_STATE'):
            self.action('recruiter', 'recruitment.job.save', {
                'job': job['job'], 'revision': reopened['revision'], 'title': '开放岗位不可编辑'})

    def test_job_replay_revision_conflict_and_cross_enterprise_denial(self):
        key = frappe.generate_hash()
        created = self.action('recruiter', 'recruitment.job.save', self.job_payload(), key)
        self.assertEqual(self.action('recruiter', 'recruitment.job.save', self.job_payload(), key), created)
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_REVISION_CONFLICT'):
            self.action('recruiter', 'recruitment.job.close', {'job': created['job'], 'revision': 2})
        for user in ('foreign', 'outsider'):
            with self.assertRaises(frappe.PermissionError):
                self.action(user, 'recruitment.job.save', {
                    'job': created['job'], 'revision': created['revision'], 'title': '越权修改'})
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_INVALID_PAYLOAD'):
            self.action('recruiter', 'recruitment.job.save', {
                **self.job_payload(), 'job_code': 'BAD-MANAGER-' + self.suffix,
                'hiring_manager': self.users['foreign']})
        frappe.set_user(self.users['foreign'])
        doc = frappe.get_doc('Shangshu Recruitment Job', created['job'])
        self.assertFalse(permission(doc, permission_type='read'))
        self.assertFalse(permission(doc, permission_type='write'))

    def test_hiring_manager_and_system_manager_respect_visibility_boundaries(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        other = self.action('recruiter', 'recruitment.job.save', {
            **self.job_payload(), 'job_code': 'OTHER-' + self.suffix,
            'hiring_manager': self.users['other_manager']})
        doc = frappe.get_doc('Shangshu Recruitment Job', job['job'])
        other_doc = frappe.get_doc('Shangshu Recruitment Job', other['job'])
        frappe.set_user(self.users['manager'])
        self.assertTrue(permission(doc, permission_type='read'))
        self.assertFalse(permission(doc, permission_type='write'))
        self.assertFalse(permission(other_doc, permission_type='read'))
        self.assertIn(self.users['manager'], permission_query())
        foreign_job = self.action('foreign', 'recruitment.job.save', {
            **self.job_payload(), 'job_code': 'FOREIGN-' + self.suffix,
            'hiring_manager': self.users['foreign']})
        foreign_doc = frappe.get_doc('Shangshu Recruitment Job', foreign_job['job'])
        frappe.set_user(self.users['sysadmin'])
        self.assertTrue(permission(doc, permission_type='write'))
        self.assertFalse(permission(foreign_doc, permission_type='write'))
        self.assertNotIn('hiring_manager=', permission_query())
        with self.assertRaises(frappe.PermissionError):
            self.action('sysadmin', 'recruitment.job.save', {
                'job': foreign_job['job'], 'revision': foreign_job['revision'], 'title': '跨企业修改'})

    def test_job_replay_rechecks_current_write_permission(self):
        key = frappe.generate_hash()
        created = self.action('recruiter', 'recruitment.job.save', self.job_payload(), key)
        with self.assertRaises(frappe.PermissionError):
            self.action('outsider', 'recruitment.job.save', self.job_payload(), key)
        self.assertEqual(frappe.db.count('Shangshu Recruitment Job', {'job_code': 'ENG-' + self.suffix}), 1)
