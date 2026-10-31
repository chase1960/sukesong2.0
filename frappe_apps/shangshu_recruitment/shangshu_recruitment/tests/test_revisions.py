import frappe
from unittest.mock import patch
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (execute_registered_action, propose_registered_action,
                                       resolve_action_proposal)


class TestRevisions(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        from shangshu_core.public_api import set_domain_enabled
        set_domain_enabled('com.shangshu.recruitment', True, '招聘用例准备：启用本域')
        self.suffix = frappe.generate_hash(length=10)
        self.users = {}
        # Synthetic fixture creation only; the production limiter is restored
        # before any action or permission assertion runs.
        with patch('frappe.core.doctype.user.user.throttle_user_creation'):
            for key, role in [('recruiter', 'Recruiter'), ('foreign', 'Recruiter'), ('outsider', None)]:
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
                'hiring_manager': self.users['recruiter'], 'headcount': 2,
                'requirements': '三年分布式系统经验', 'location': '北京', 'employment_type': 'full_time'}

    def jd_payload(self, job, content='负责数据平台的服务端开发与稳定性建设。'):
        return {'job': job, 'content': content, 'source': 'manual'}

    def rubric_payload(self, job, **overrides):
        # disallowed_criteria 是对本 rubric 显式声明的禁用属性（含受保护词本身），不参与命中扫描。
        payload = {'job': job, 'required_criteria': ['五年后端开发经验', '熟悉数据平台'],
                   'preferred_criteria': ['有开源项目贡献'], 'disallowed_criteria': ['gender', 'photo'],
                   'weights': {'五年后端开发经验': 2, '熟悉数据平台': 1, '有开源项目贡献': 0.5}}
        payload.update(overrides)
        return payload

    def test_published_revision_is_immutable_and_job_opens_after_both_publish(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        jd = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']))
        rubric = self.action('recruiter', 'recruitment.rubric.save', self.rubric_payload(job['job']))
        self.assertEqual((jd['version_no'], jd['status'], jd['document_revision']), (1, 'draft', 1))
        self.assertEqual((rubric['version_no'], rubric['status']), (1, 'draft'))
        self.action('recruiter', 'recruitment.jd.publish', {'revision_document': jd['revision_document'],
                                                             'revision': jd['document_revision']})
        self.action('recruiter', 'recruitment.rubric.publish', {'revision_document': rubric['revision_document'],
                                                                 'revision': rubric['document_revision']})
        opened = self.action('recruiter', 'recruitment.job.open', {'job': job['job'], 'revision': 1})
        self.assertEqual(opened['status'], 'open')
        self.assertEqual(opened['current_jd_revision'], jd['revision_document'])
        self.assertEqual(opened['current_rubric_revision'], rubric['revision_document'])
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_REVISION_IMMUTABLE'):
            self.action('recruiter', 'recruitment.jd.save', {'revision_document': jd['revision_document'],
                                                             'revision': 2, 'job': job['job'],
                                                             'content': '覆盖已发布版本', 'source': 'manual'})

    def test_ai_can_only_propose_jd_draft_not_publish_or_open(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        proposal = propose_registered_action('recruitment.jd.save', self.jd_payload(job['job']))
        self.assertEqual(proposal['status'], 'proposed')
        self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 0)
        for forbidden in ('recruitment.jd.publish', 'recruitment.job.open'):
            with self.assertRaises(frappe.PermissionError):
                propose_registered_action(forbidden, {})

    def test_proposed_jd_persists_only_after_human_confirmation(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        proposal = propose_registered_action('recruitment.jd.save', self.jd_payload(job['job']))
        self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 0)
        resolved = resolve_action_proposal(proposal['id'], 'confirmed')
        self.assertEqual(resolved['status'], 'confirmed')
        self.assertEqual(resolved['result']['job'], job['job'])
        self.assertEqual(resolved['result']['status'], 'draft')
        self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 1)

    def test_rubric_rejects_disallowed_criteria(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        # 大小写不敏感；必要/加分条件与权重键命中受保护属性一律拒绝，且不落任何记录。
        cases = [
            {'required_criteria': ['五年后端开发经验', 'Gender']},
            {'preferred_criteria': ['有开源项目贡献', 'marital_status']},
            {'required_criteria': ['Marital Status 敏感项']},  # 空格变体同样命中
            {'weights': {'五年后端开发经验': 1, 'EMAIL': 1}},
        ]
        for override in cases:
            with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_DISALLOWED_CRITERION'):
                self.action('recruiter', 'recruitment.rubric.save', self.rubric_payload(job['job'], **override))
        self.assertEqual(frappe.db.count('Shangshu Recruitment Screening Rubric', {'job': job['job']}), 0)

    def test_rubric_weights_must_reference_criteria_and_sum_positive(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_INVALID_WEIGHTS'):
            self.action('recruiter', 'recruitment.rubric.save',
                        self.rubric_payload(job['job'], weights={'不存在的条件': 1}))
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_INVALID_WEIGHTS'):
            self.action('recruiter', 'recruitment.rubric.save',
                        self.rubric_payload(job['job'], weights={'五年后端开发经验': 0, '熟悉数据平台': 0,
                                                                  '有开源项目贡献': 0}))
        with self.assertRaises(frappe.ValidationError):
            self.action('recruiter', 'recruitment.rubric.save',
                        self.rubric_payload(job['job'], weights={'五年后端开发经验': -1, '熟悉数据平台': 2}))

    def test_new_revision_versioning_and_draft_editing(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        first = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']))
        edited = self.action('recruiter', 'recruitment.jd.save', {'revision_document': first['revision_document'],
                                                                   'revision': first['document_revision'],
                                                                   'job': job['job'],
                                                                   'content': '改写后的草稿正文', 'source': 'manual'})
        self.assertEqual(edited['version_no'], 1)  # 编辑草稿不产生新版本号
        self.assertEqual(edited['document_revision'], 2)  # 乐观锁修订号进位
        second = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job'], content='第二版正文'))
        self.assertEqual((second['version_no'], second['document_revision']), (2, 1))
        self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 2)
        with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_REVISION_CONFLICT'):
            self.action('recruiter', 'recruitment.jd.save', {'revision_document': first['revision_document'],
                                                             'revision': 1, 'job': job['job'],
                                                             'content': '过期修订号', 'source': 'manual'})

    def test_revision_save_replay_returns_same_receipt(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        key = frappe.generate_hash()
        created = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']), key)
        self.assertEqual(self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']), key), created)
        self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 1)

    def test_revision_access_is_enterprise_and_role_gated(self):
        job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
        jd = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']))
        with self.assertRaises(frappe.PermissionError):
            self.action('foreign', 'recruitment.jd.save', self.jd_payload(job['job']))
        with self.assertRaises(frappe.PermissionError):
            self.action('foreign', 'recruitment.jd.publish', {'revision_document': jd['revision_document'],
                                                               'revision': jd['document_revision']})
        with self.assertRaises(frappe.PermissionError):
            self.action('outsider', 'recruitment.jd.save', self.jd_payload(job['job']))
