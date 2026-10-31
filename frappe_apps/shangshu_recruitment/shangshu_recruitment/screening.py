import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.application import locked_application, require_revision
from shangshu_recruitment.common import reference, schema, text
from shangshu_recruitment.job import _access_context

SCREENING_DOCTYPE = 'Shangshu Recruitment Screening'
APPLICATION_DOCTYPE = 'Shangshu Recruitment Application'
RESUME_DOCTYPE = 'Shangshu Recruitment Resume'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}

CONCLUSION_OPTIONS = ['shortlist', 'reject']

# AI 只提案（propose 登记建议），结论必须由人 decide——AI 提案、人确认、统一执行。
SCREENING_ACTIONS = [
    ('recruitment.screening.propose', '登记简历筛选建议',
     ['Recruitment Admin', 'Recruiter', 'Recruitment System User'],
     schema({'application': text('申请编号'), 'resume': text('简历编号'),
             'summary': {'type': 'string', 'title': '建议摘要', 'minLength': 1, 'maxLength': 4000,
                         'multiline': True},
             'recommendation': {'type': 'string', 'title': '建议结论', 'enum': CONCLUSION_OPTIONS}},
            ['application', 'resume', 'summary', 'recommendation'])),
    ('recruitment.screening.decide', '决定简历筛选结果', ['Recruitment Admin', 'Recruiter'],
     schema({'screening': text('筛选编号'),
             'revision': reference('筛选')['revision'],
             'decision': {'type': 'string', 'title': '筛选结论', 'enum': CONCLUSION_OPTIONS},
             'reason': {'type': 'string', 'title': '原因', 'minLength': 1, 'maxLength': 2000,
                        'multiline': True}},
            ['screening', 'revision', 'decision', 'reason'])),
]


def execute_screening(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.screening.propose':
        return _propose(payload, ctx)
    if action_id == 'recruitment.screening.decide':
        return _decide(payload, ctx)
    frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)


def _propose(payload, ctx):
    application = locked_application(payload['application'], ctx['enterprise_id'])
    if application.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能再登记筛选建议',
                     frappe.ValidationError)
    resume = frappe.get_doc(RESUME_DOCTYPE, payload['resume'])
    if resume.enterprise_id != ctx['enterprise_id'] or resume.candidate != application.candidate:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 简历必须属于该申请的候选人', frappe.ValidationError)
    # 同一申请只挂一条筛选记录：未决前可覆盖建议（留最新），有结论后不可再提案。
    existing = frappe.db.get_value(SCREENING_DOCTYPE, {'enterprise_id': ctx['enterprise_id'],
                                                       'application': application.name}, 'name')
    if existing:
        doc = frappe.get_doc(SCREENING_DOCTYPE, existing, for_update=True)
        if doc.status != 'proposed':
            frappe.throw('RECRUITMENT_INVALID_STATE: 筛选已有结论，不能再登记建议', frappe.ValidationError)
        doc.resume = payload['resume']
        doc.summary = payload['summary'][:4000]
        doc.recommendation = payload['recommendation']
        doc.revision += 1
        doc.save(ignore_permissions=True)
    else:
        doc = frappe.get_doc({'doctype': SCREENING_DOCTYPE,
                              'enterprise_id': ctx['enterprise_id'],
                              'application': application.name,
                              'resume': payload['resume'],
                              'summary': payload['summary'][:4000],
                              'recommendation': payload['recommendation'],
                              'status': 'proposed', 'revision': 1})
        doc.insert(ignore_permissions=True)
    return _summary(doc)


def _decide(payload, ctx):
    doc = frappe.get_doc(SCREENING_DOCTYPE, payload['screening'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业筛选记录', frappe.PermissionError)
    require_revision(doc, payload.get('revision'))
    if doc.status == 'decided':
        frappe.throw('RECRUITMENT_INVALID_STATE: 筛选已有结论', frappe.ValidationError)
    application = locked_application(doc.application, ctx['enterprise_id'])
    if application.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能登记筛选结论',
                     frappe.ValidationError)
    doc.decision = payload['decision']
    doc.decision_reason = payload['reason']
    doc.decided_by = ctx['user_name']
    doc.decided_at = frappe.utils.now_datetime()
    doc.status = 'decided'
    doc.revision += 1
    doc.save(ignore_permissions=True)
    # 人确认的淘汰结论统一落到申请终态（同一业务事实单一落点）。
    if payload['decision'] == 'reject':
        application.outcome = 'rejected'
        application.outcome_reason = payload['reason']
        application.revision += 1
        application.save(ignore_permissions=True)
    return _summary(doc)


def _summary(doc):
    return {'screening': doc.name, 'application': doc.application, 'status': doc.status,
            'recommendation': doc.recommendation or '', 'decision': doc.decision or '',
            'revision': doc.revision}


def screening_permission(doc, user=None, permission_type=None):
    """筛选是招聘运营内部环节；Hiring Manager 经申请与面试环节看结果，不直接看筛选。"""
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return False
    return doc is None or doc.enterprise_id == ctx['enterprise_id']


def screening_permission_query(user=None):
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return '1=0'
    return 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
