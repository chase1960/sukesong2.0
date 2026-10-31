import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.application import (application_visible_to_manager, locked_application,
                                              require_revision)
from shangshu_recruitment.common import reference, schema, text
from shangshu_recruitment.job import _access_context

INTERVIEW_DOCTYPE = 'Shangshu Recruitment Interview'
EVALUATION_DOCTYPE = 'Shangshu Recruitment Interview Evaluation'
APPLICATION_DOCTYPE = 'Shangshu Recruitment Application'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}
READ_ROLES = WRITE_ROLES | {'Hiring Manager'}

RESULT_OPTIONS = ['pass', 'fail']
CONCLUSION_OPTIONS = ['recommend', 'hold', 'no_recommend']

INTERVIEW_ACTIONS = [
    ('recruitment.interview.schedule', '安排面试', ['Recruitment Admin', 'Recruiter'],
     schema({'application': text('申请编号'),
             'round': {'type': 'integer', 'title': '轮次', 'minimum': 1},
             'stage': text('面试环节', 80),
             'scheduled_at': {'type': 'string', 'title': '计划时间', 'minLength': 1, 'maxLength': 40},
             'interviewer': text('面试官账号')},
            ['application', 'round', 'stage', 'scheduled_at', 'interviewer'])),
    ('recruitment.interview.complete', '完成面试', ['Recruitment Admin', 'Recruiter'],
     schema({'interview': text('面试编号'), 'revision': reference('面试')['revision'],
             'result': {'type': 'string', 'title': '结果', 'enum': RESULT_OPTIONS},
             'note': {'type': 'string', 'title': '备注', 'maxLength': 2000, 'multiline': True}},
            ['interview', 'revision', 'result'])),
    # 每位面试官对每场面试只提交一次独立评价，提交后不可改（独立评价不被覆盖）。
    ('recruitment.evaluation.submit', '提交面试评价', ['Recruitment Admin', 'Recruiter', 'Hiring Manager'],
     schema({'interview': text('面试编号'), 'revision': reference('面试')['revision'],
             'conclusion': {'type': 'string', 'title': '结论', 'enum': CONCLUSION_OPTIONS},
             'comment': {'type': 'string', 'title': '评语', 'minLength': 1, 'maxLength': 4000,
                         'multiline': True}},
            ['interview', 'revision', 'conclusion', 'comment'])),
]


def execute_interview(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.interview.schedule':
        return _schedule(payload, ctx)
    if action_id == 'recruitment.interview.complete':
        return _complete(payload, ctx)
    if action_id == 'recruitment.evaluation.submit':
        return _submit_evaluation(payload, ctx)
    frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)


def _schedule(payload, ctx):
    application = locked_application(payload['application'], ctx['enterprise_id'])
    if application.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能安排面试', frappe.ValidationError)
    if not frappe.db.exists('User', payload['interviewer']):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 面试官账号不存在', frappe.ValidationError)
    doc = frappe.get_doc({'doctype': INTERVIEW_DOCTYPE,
                          'enterprise_id': ctx['enterprise_id'],
                          'application': application.name,
                          'round': payload['round'],
                          'stage': payload['stage'][:80],
                          'scheduled_at': frappe.utils.get_datetime(payload['scheduled_at']),
                          'interviewer': payload['interviewer'][:140],
                          'status': 'scheduled', 'revision': 1})
    doc.insert(ignore_permissions=True)
    return _summary(doc)


def _complete(payload, ctx):
    doc = frappe.get_doc(INTERVIEW_DOCTYPE, payload['interview'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业面试', frappe.PermissionError)
    require_revision(doc, payload.get('revision'))
    if doc.status != 'scheduled':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有已安排的面试可以完成', frappe.ValidationError)
    # 淘汰与否不在这里改申请终态：申请结果统一由人显式决定（screening.decide / application.reject）。
    doc.result = payload['result']
    if payload.get('note'):
        doc.note = payload['note'][:2000]
    doc.completed_at = frappe.utils.now_datetime()
    doc.status = 'completed'
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return _summary(doc)


def _submit_evaluation(payload, ctx):
    interview = frappe.get_doc(INTERVIEW_DOCTYPE, payload['interview'])
    if interview.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业面试', frappe.PermissionError)
    require_revision(interview, payload.get('revision'))
    if interview.status == 'cancelled':
        frappe.throw('RECRUITMENT_INVALID_STATE: 已取消的面试不能提交评价', frappe.ValidationError)
    if interview.interviewer and interview.interviewer != ctx['user_name'] \
            and not set(ctx['roles']) & {'System Manager', 'Recruitment Admin'}:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 只有本场面试官或招聘管理员可以提交评价',
                     frappe.PermissionError)
    if frappe.db.exists(EVALUATION_DOCTYPE, {'interview': interview.name,
                                             'evaluator': ctx['user_name']}):
        frappe.throw('RECRUITMENT_DUPLICATE_EVALUATION: 该面试官已提交过评价', frappe.ValidationError)
    doc = frappe.get_doc({'doctype': EVALUATION_DOCTYPE,
                          'enterprise_id': ctx['enterprise_id'],
                          'interview': interview.name,
                          'evaluator': ctx['user_name'],
                          'conclusion': payload['conclusion'],
                          'comment': payload['comment'][:4000],
                          'submitted_at': frappe.utils.now_datetime(),
                          'revision': 1})
    doc.insert(ignore_permissions=True)
    return {'evaluation': doc.name, 'interview': interview.name, 'conclusion': doc.conclusion,
            'revision': doc.revision}


def _summary(doc):
    return {'interview': doc.name, 'application': doc.application, 'status': doc.status,
            'result': doc.result or '', 'revision': doc.revision}


def interview_permission(doc, user=None, permission_type=None):
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    writing = permission_type in ('write', 'update')
    if writing and not roles & WRITE_ROLES:
        return False
    if not writing and not roles & READ_ROLES:
        return False
    if doc is None:
        return True
    if doc.enterprise_id != ctx['enterprise_id']:
        return False
    if roles & WRITE_ROLES:
        return True
    application = frappe.get_doc(APPLICATION_DOCTYPE, doc.application)
    return application_visible_to_manager(application, ctx)


def interview_permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles & READ_ROLES:
        return '1=0'
    enterprise = frappe.db.escape(ctx['enterprise_id'])
    if roles & WRITE_ROLES:
        return 'enterprise_id=' + enterprise
    return ('enterprise_id=' + enterprise
            + ' and application in (select name from `tabShangshu Recruitment Application` app'
              ' join `tabShangshu Recruitment Job` job on app.job=job.name'
              ' where job.enterprise_id=' + enterprise
              + ' and job.hiring_manager=' + frappe.db.escape(ctx['user_name']) + ')')


# 评价可见性按角色粗粒度控制（框架级）：面试官之间的保密细分留待后续迭代。
def evaluation_permission(doc, user=None, permission_type=None):
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles & READ_ROLES:
        return False
    if doc is None:
        return True
    if doc.enterprise_id != ctx['enterprise_id']:
        return False
    if roles & WRITE_ROLES:
        return True
    interview = frappe.get_doc(INTERVIEW_DOCTYPE, doc.interview)
    application = frappe.get_doc(APPLICATION_DOCTYPE, interview.application)
    return application_visible_to_manager(application, ctx)


def evaluation_permission_query(user=None):
    return interview_permission_query(user)
