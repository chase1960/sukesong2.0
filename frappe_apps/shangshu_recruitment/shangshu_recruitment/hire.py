import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.application import (application_visible_to_manager, locked_application,
                                              require_revision)
from shangshu_recruitment.common import reference, schema, text
from shangshu_recruitment.job import _access_context

OFFER_DOCTYPE = 'Shangshu Recruitment Offer'
ONBOARDING_DOCTYPE = 'Shangshu Recruitment Onboarding'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}
READ_ROLES = WRITE_ROLES | {'Hiring Manager'}
REPLY_OPTIONS = ['accepted', 'declined']

HIRE_ACTIONS = [
    # Offer 条款（含薪资等敏感信息）只存业务库、按 DocType 权限控制，不进 AI 上下文与日志。
    ('recruitment.offer.create', '创建 Offer 提案', ['Recruitment Admin', 'Recruiter'],
     schema({'application': text('申请编号'),
             'terms': {'type': 'string', 'title': '条款摘要', 'minLength': 1, 'maxLength': 4000,
                       'multiline': True},
             'effective_date': {'type': 'string', 'title': '生效日期', 'minLength': 1, 'maxLength': 40}},
            ['application', 'terms', 'effective_date'])),
    ('recruitment.offer.approve', '审批 Offer', ['Recruitment Admin'],
     schema({'offer': text('Offer 编号'), 'revision': reference('Offer')['revision']},
            ['offer', 'revision'])),
    # 发送走邮件域现有界面；回执状态未知不自动重发（人工核实原则），本域只登记人的回复。
    ('recruitment.offer.record_reply', '登记 Offer 回复', ['Recruitment Admin', 'Recruiter'],
     schema({'offer': text('Offer 编号'), 'revision': reference('Offer')['revision'],
             'reply': {'type': 'string', 'title': '回复', 'enum': REPLY_OPTIONS},
             'note': {'type': 'string', 'title': '备注', 'maxLength': 2000, 'multiline': True}},
            ['offer', 'revision', 'reply'])),
    ('recruitment.onboarding.start', '发起入职', ['Recruitment Admin', 'Recruiter'],
     schema({'offer': text('Offer 编号'),
             'planned_date': {'type': 'string', 'title': '计划入职日', 'minLength': 1, 'maxLength': 40}},
            ['offer', 'planned_date'])),
    ('recruitment.onboarding.complete', '完成入职', ['Recruitment Admin', 'Recruiter'],
     schema({'onboarding': text('入职编号'), 'revision': reference('入职')['revision'],
             'note': {'type': 'string', 'title': '备注', 'maxLength': 2000, 'multiline': True}},
            ['onboarding', 'revision'])),
]


def execute_hire(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.offer.create':
        return _offer_create(payload, ctx)
    if action_id == 'recruitment.offer.approve':
        return _offer_approve(payload, ctx)
    if action_id == 'recruitment.offer.record_reply':
        return _offer_reply(payload, ctx)
    if action_id == 'recruitment.onboarding.start':
        return _onboarding_start(payload, ctx)
    return _onboarding_complete(payload, ctx)


def _offer_create(payload, ctx):
    application = locked_application(payload['application'], ctx['enterprise_id'])
    if application.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能创建 Offer',
                     frappe.ValidationError)
    if frappe.db.exists(OFFER_DOCTYPE, {'enterprise_id': ctx['enterprise_id'],
                                        'application': application.name,
                                        'status': ['!=', 'declined']}):
        frappe.throw('RECRUITMENT_DUPLICATE_OFFER: 该申请已有进行中的 Offer', frappe.ValidationError)
    doc = frappe.get_doc({'doctype': OFFER_DOCTYPE,
                          'enterprise_id': ctx['enterprise_id'],
                          'application': application.name,
                          'terms': payload['terms'][:4000],
                          'effective_date': frappe.utils.get_datetime(payload['effective_date']).date(),
                          'status': 'proposed', 'revision': 1})
    doc.insert(ignore_permissions=True)
    return _offer_summary(doc)


def _offer_approve(payload, ctx):
    doc = _locked_offer(payload['offer'], ctx)
    require_revision(doc, payload.get('revision'))
    if doc.status != 'proposed':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有待审批的 Offer 可以审批', frappe.ValidationError)
    doc.status = 'approved'
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return _offer_summary(doc)


def _offer_reply(payload, ctx):
    doc = _locked_offer(payload['offer'], ctx)
    require_revision(doc, payload.get('revision'))
    if doc.status != 'approved':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有已审批的 Offer 可以登记回复', frappe.ValidationError)
    doc.status = payload['reply']
    if payload.get('note'):
        doc.reply_note = payload['note'][:2000]
    doc.revision += 1
    doc.save(ignore_permissions=True)
    if payload['reply'] == 'declined':
        application = locked_application(doc.application, ctx['enterprise_id'])
        if application.outcome == 'active':
            application.outcome = 'withdrawn'
            application.outcome_reason = payload.get('note') or '候选人婉拒 Offer'
            application.revision += 1
            application.save(ignore_permissions=True)
    return _offer_summary(doc)


def _onboarding_start(payload, ctx):
    offer = _locked_offer(payload['offer'], ctx)
    if offer.status != 'accepted':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有已接受的 Offer 可以发起入职', frappe.ValidationError)
    application = locked_application(offer.application, ctx['enterprise_id'])
    if application.outcome != 'active':
        frappe.throw('RECRUITMENT_INVALID_STAGE_TRANSITION: 申请已终止，不能发起入职', frappe.ValidationError)
    if frappe.db.exists(ONBOARDING_DOCTYPE, {'offer': offer.name}):
        frappe.throw('RECRUITMENT_DUPLICATE_ONBOARDING: 该 Offer 已发起过入职', frappe.ValidationError)
    doc = frappe.get_doc({'doctype': ONBOARDING_DOCTYPE,
                          'enterprise_id': ctx['enterprise_id'],
                          'application': offer.application,
                          'offer': offer.name,
                          'planned_date': frappe.utils.get_datetime(payload['planned_date']).date(),
                          'status': 'in_progress', 'revision': 1})
    doc.insert(ignore_permissions=True)
    return _onboarding_summary(doc)


def _onboarding_complete(payload, ctx):
    doc = frappe.get_doc(ONBOARDING_DOCTYPE, payload['onboarding'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业入职记录', frappe.PermissionError)
    require_revision(doc, payload.get('revision'))
    if doc.status != 'in_progress':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有进行中的入职可以完成', frappe.ValidationError)
    doc.status = 'completed'
    if payload.get('note'):
        doc.note = payload['note'][:2000]
    doc.completed_at = frappe.utils.now_datetime()
    doc.revision += 1
    doc.save(ignore_permissions=True)
    # 入职完成 = 招聘域内闭环终点，申请落 hired 终态（唯一落点）。
    application = locked_application(doc.application, ctx['enterprise_id'])
    if application.outcome == 'active':
        application.outcome = 'hired'
        application.outcome_reason = payload.get('note') or '完成入职'
        application.revision += 1
        application.save(ignore_permissions=True)
    return _onboarding_summary(doc)


def _locked_offer(name, ctx):
    doc = frappe.get_doc(OFFER_DOCTYPE, name, for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业 Offer', frappe.PermissionError)
    return doc


def _offer_summary(doc):
    return {'offer': doc.name, 'application': doc.application, 'status': doc.status,
            'revision': doc.revision}


def _onboarding_summary(doc):
    return {'onboarding': doc.name, 'offer': doc.offer, 'status': doc.status,
            'revision': doc.revision}


def offer_permission(doc, user=None, permission_type=None):
    """Offer 含敏感条款：只对招聘运营角色开放，Hiring Manager 不直接看 Offer。"""
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return False
    return doc is None or doc.enterprise_id == ctx['enterprise_id']


def offer_permission_query(user=None):
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return '1=0'
    return 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])


def onboarding_permission(doc, user=None, permission_type=None):
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
    application = frappe.get_doc('Shangshu Recruitment Application', doc.application)
    return application_visible_to_manager(application, ctx)


def onboarding_permission_query(user=None):
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
