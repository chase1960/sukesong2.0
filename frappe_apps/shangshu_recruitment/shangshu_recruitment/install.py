import frappe

from shangshu_core.public_api import (ensure_registered_domains, publish_portal_definition,
                                      register_action, register_domain_process_definition)
from shangshu_recruitment.common import DOMAIN, ROLES, SYSTEM_ROLES
from shangshu_recruitment.domain import ACTIONS

PROCESS_DEFINITION = DOMAIN + '.application'
# 招聘申请主线：两节点人工流。筛选是常驻人工环节；办结节点 auto_complete
# 跟随申请终态（rejected/withdrawn/hired），实际状态由申请记录唯一承载。
PROCESS_GRAPH = {
    'schema_version': 2,
    'definition_id': PROCESS_DEFINITION,
    'business_object': 'recruitment.application',
    'nodes': [
        {'id': DOMAIN + '.node.screening', 'type': 'human_task', 'title': '简历筛选',
         'start': True, 'allowed_roles': ['Recruiter', 'Recruitment Admin']},
        {'id': DOMAIN + '.node.finish', 'type': 'human_task', 'title': '流程办结',
         'terminal': True, 'auto_complete': True},
    ],
    'edges': [{'id': DOMAIN + '.edge.screening_to_finish',
               'source': DOMAIN + '.node.screening', 'target': DOMAIN + '.node.finish'}],
}


def setup():
    # 先登记域贡献（对象/数据集/工具声明），再补角色、动作定义与唯一索引；
    # 动作定义变更必须升版本，注册器拒同 key 改定义。
    ensure_registered_domains()
    for role in list(ROLES) + list(SYSTEM_ROLES):
        if not frappe.db.exists('Role', role):
            frappe.get_doc({'doctype': 'Role', 'role_name': role}).insert(ignore_permissions=True)
    for action, title, roles, input_schema in ACTIONS:
        register_action(action, '1.0.0', title, 'write', 'required', roles, input_schema, {})
    frappe.db.add_unique('Shangshu Recruitment Rule', ['enterprise_id', 'lineage', 'version_no'],
                         'unique_recruitment_rule_lineage_version')
    # 唯一键：编码/版本号/收件幂等键/简历指纹/邮箱绑定/面试官评价各按业务事实唯一。
    frappe.db.add_unique('Shangshu Recruitment Job', ['enterprise_id', 'job_code'],
                         'unique_recruitment_job_enterprise_code')
    frappe.db.add_unique('Shangshu Recruitment JD Revision', ['enterprise_id', 'job', 'version_no'],
                         'unique_recruitment_jd_enterprise_job_version')
    frappe.db.add_unique('Shangshu Recruitment Screening Rubric', ['enterprise_id', 'job', 'version_no'],
                         'unique_recruitment_rubric_enterprise_job_version')
    frappe.db.add_unique('Shangshu Recruitment Intake', ['enterprise_id', 'idempotency_key'],
                         'unique_recruitment_intake_idempotency')
    frappe.db.add_unique('Shangshu Recruitment Resume', ['enterprise_id', 'candidate', 'file_sha256'],
                         'unique_recruitment_resume_fingerprint')
    frappe.db.add_unique('Shangshu Recruitment Mailbox', ['enterprise_id', 'mailbox_id'],
                         'unique_recruitment_mailbox_binding')
    frappe.db.add_unique('Shangshu Recruitment Interview Evaluation', ['interview', 'evaluator'],
                         'unique_recruitment_evaluation_once')
    # 流程定义已存在时注册器不覆盖（幂等迁移）；新建时才发布门户草稿。
    created = register_domain_process_definition(PROCESS_DEFINITION, '招聘申请',
                                                 'recruitment.application', PROCESS_GRAPH)
    if created and created.get('created'):
        publish_portal_definition(PROCESS_DEFINITION, created.get('draft_revision'))
