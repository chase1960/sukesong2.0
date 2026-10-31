import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.common import reference, schema, text
from shangshu_recruitment.job import _access_context

APPLICATION_DOCTYPE = 'Shangshu Recruitment Application'
RESUME_DOCTYPE = 'Shangshu Recruitment Resume'
JOB_DOCTYPE = 'Shangshu Recruitment Job'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}
READ_ROLES = WRITE_ROLES | {'Hiring Manager'}

TERMINAL_REASON = {'type': 'string', 'title': '原因', 'minLength': 1, 'maxLength': 2000, 'multiline': True}
APPLICATION_REFERENCE = {'application': text('申请编号'), 'revision': reference('申请')['revision']}
APPLICATION_ACTIONS = [
    ('recruitment.application.reject', '拒绝申请', ['Recruitment Admin', 'Recruiter'],
     schema({**APPLICATION_REFERENCE, 'reason': TERMINAL_REASON}, ['application', 'revision', 'reason'])),
    ('recruitment.application.withdraw', '登记候选人撤回', ['Recruitment Admin', 'Recruiter'],
     schema({**APPLICATION_REFERENCE, 'reason': TERMINAL_REASON}, ['application', 'revision', 'reason'])),
    ('recruitment.resume.primary.select', '设置主简历', ['Recruitment Admin', 'Recruiter'],
     schema({**APPLICATION_REFERENCE, 'resume': text('简历编号')}, ['application', 'revision', 'resume'])),
]


def locked_application(name, enterprise_id):
    doc = frappe.get_doc(APPLICATION_DOCTYPE, name, for_update=True)
    if doc.enterprise_id != enterprise_id:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业申请', frappe.PermissionError)
    return doc


def require_revision(doc, revision):
    if doc.revision != revision:
        frappe.throw('RECRUITMENT_REVISION_CONFLICT: 记录已更新，请刷新后重试', frappe.ValidationError)


def application_visible_to_manager(application, ctx):
    """Hiring Manager 行级可见性的统一口径：管理该申请对应岗位才可见（面试/入职等派生记录复用）。"""
    job = frappe.get_doc(JOB_DOCTYPE, application.job)
    return job.enterprise_id == ctx['enterprise_id'] and job.hiring_manager == ctx['user_name']


def execute_application(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.resume.primary.select':
        return _select_primary(payload, ctx)
    if action_id == 'recruitment.application.reject':
        return _close(payload, ctx, 'rejected')
    if action_id == 'recruitment.application.withdraw':
        return _close(payload, ctx, 'withdrawn')
    frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)


def _close(payload, ctx, outcome):
    doc = locked_application(payload['application'], ctx['enterprise_id'])
    require_revision(doc, payload.get('revision'))
    if doc.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能再修改结果', frappe.ValidationError)
    doc.outcome = outcome
    doc.outcome_reason = payload['reason']
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return {'application': doc.name, 'outcome': doc.outcome, 'revision': doc.revision}


def _select_primary(payload, ctx):
    doc = locked_application(payload['application'], ctx['enterprise_id'])
    require_revision(doc, payload.get('revision'))
    if doc.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能更换主简历', frappe.ValidationError)
    resume = frappe.get_doc(RESUME_DOCTYPE, payload['resume'])
    if resume.enterprise_id != ctx['enterprise_id'] or resume.candidate != doc.candidate:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 主简历必须属于该申请的候选人', frappe.ValidationError)
    for other in frappe.get_all(RESUME_DOCTYPE, filters={'candidate': doc.candidate,
                                                         'is_primary': 1}, pluck='name'):
        if other != resume.name:
            sibling = frappe.get_doc(RESUME_DOCTYPE, other, for_update=True)
            sibling.is_primary = 0
            sibling.revision += 1
            sibling.save(ignore_permissions=True)
    if not resume.is_primary:
        resume = frappe.get_doc(RESUME_DOCTYPE, resume.name, for_update=True)
        resume.is_primary = 1
        resume.revision += 1
        resume.save(ignore_permissions=True)
    doc.primary_resume = resume.name
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return {'application': doc.name, 'primary_resume': doc.primary_resume, 'revision': doc.revision}


def application_permission(doc, user=None, permission_type=None):
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    writing = permission_type in ('write', 'update')
    if writing and not roles.intersection(WRITE_ROLES):
        return False
    if not writing and not roles.intersection(READ_ROLES):
        return False
    if doc is None:
        return True
    if doc.enterprise_id != ctx['enterprise_id']:
        return False
    if roles.intersection(WRITE_ROLES):
        return True
    job = frappe.get_doc(JOB_DOCTYPE, doc.job)
    return job.enterprise_id == ctx['enterprise_id'] and job.hiring_manager == ctx['user_name']


def application_permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles.intersection(READ_ROLES):
        return '1=0'
    enterprise = frappe.db.escape(ctx['enterprise_id'])
    condition = 'enterprise_id=' + enterprise
    if not roles.intersection(WRITE_ROLES):
        condition += (' and job in (select name from `tabShangshu Recruitment Job`'
                      ' where enterprise_id=' + enterprise
                      + ' and hiring_manager=' + frappe.db.escape(ctx['user_name']) + ')')
    return condition
