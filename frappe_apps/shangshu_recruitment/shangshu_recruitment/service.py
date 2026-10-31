import frappe

from shangshu_core.public_api import peek_result, require_roles
from shangshu_recruitment.job import JOB_ACTIONS, execute_job, permission, permission_query, revision_permission_query
from shangshu_recruitment.revisions import REVISION_ACTIONS, execute_revision
from shangshu_recruitment.candidate import CANDIDATE_ACTIONS, CANDIDATE_DOCTYPE, execute_candidate, candidate_permission
from shangshu_recruitment.application import (APPLICATION_ACTIONS, APPLICATION_DOCTYPE, execute_application,
                                              application_permission)
from shangshu_recruitment.intake import INTAKE_ACTIONS, INTAKE_DOCTYPE, execute_intake, intake_permission
from shangshu_recruitment.mailbox import MAILBOX_ACTIONS, MAILBOX_DOCTYPE, execute_mailbox, mailbox_permission
from shangshu_recruitment.screening import (SCREENING_ACTIONS, SCREENING_DOCTYPE, execute_screening,
                                            screening_permission)
from shangshu_recruitment.interview import (INTERVIEW_ACTIONS, INTERVIEW_DOCTYPE, execute_interview,
                                            interview_permission)
from shangshu_recruitment.hire import (HIRE_ACTIONS, OFFER_DOCTYPE, ONBOARDING_DOCTYPE, execute_hire,
                                       offer_permission, onboarding_permission)

# 各阶段动作族 → 执行器；service 只做统一闸门（角色/确认/空白串/写标志），路由到各模块。
_FAMILIES = (
    (JOB_ACTIONS, execute_job),
    (REVISION_ACTIONS, execute_revision),
    (CANDIDATE_ACTIONS, execute_candidate),
    (APPLICATION_ACTIONS, execute_application),
    (INTAKE_ACTIONS, execute_intake),
    (MAILBOX_ACTIONS, execute_mailbox),
    (SCREENING_ACTIONS, execute_screening),
    (INTERVIEW_ACTIONS, execute_interview),
    (HIRE_ACTIONS, execute_hire),
)
ACTIONS = [action for family, _ in _FAMILIES for action in family]
_ROUTES = {action[0]: handler for family, handler in _FAMILIES for action in family}

# 重放复核：action → (载荷键, DocType, 权限函数)。旧回执里的编号优先于新载荷。
_REPLAY_TARGETS = {
    'recruitment.candidate.save': ('candidate', CANDIDATE_DOCTYPE, candidate_permission),
    'recruitment.candidate.anonymize': ('candidate', CANDIDATE_DOCTYPE, candidate_permission),
    'recruitment.application.reject': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.application.withdraw': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.resume.primary.select': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.intake.assign': ('intake', INTAKE_DOCTYPE, intake_permission),
    'recruitment.intake.ignore': ('intake', INTAKE_DOCTYPE, intake_permission),
    'recruitment.intake.retry': ('intake', INTAKE_DOCTYPE, intake_permission),
    'recruitment.mailbox.save': ('mailbox', MAILBOX_DOCTYPE, mailbox_permission),
    'recruitment.screening.propose': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.screening.decide': ('screening', SCREENING_DOCTYPE, screening_permission),
    'recruitment.interview.schedule': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.interview.complete': ('interview', INTERVIEW_DOCTYPE, interview_permission),
    'recruitment.evaluation.submit': ('interview', INTERVIEW_DOCTYPE, interview_permission),
    'recruitment.offer.create': ('application', APPLICATION_DOCTYPE, application_permission),
    'recruitment.offer.approve': ('offer', OFFER_DOCTYPE, offer_permission),
    'recruitment.offer.record_reply': ('offer', OFFER_DOCTYPE, offer_permission),
    'recruitment.onboarding.start': ('offer', OFFER_DOCTYPE, offer_permission),
    'recruitment.onboarding.complete': ('onboarding', ONBOARDING_DOCTYPE, onboarding_permission),
}


def execute(action_id, payload, context):
    declaration = next((item for item in ACTIONS if item[0] == action_id), None)
    if declaration is None:
        frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)
    require_roles(*declaration[2], 'System Manager')
    if not context.get('confirmed'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘写入必须确认', frappe.PermissionError)
    if any(isinstance(value, str) and not value.strip() for value in payload.values()):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 文本字段不能只填写空格', frappe.ValidationError)
    previous = getattr(frappe.flags, 'recruitment_write', False)
    frappe.flags.recruitment_write = True
    try:
        return _ROUTES[action_id](action_id, payload)
    finally:
        frappe.flags.recruitment_write = previous


def replay_guard(payload, request=None):
    """同键重放仍按当前企业和记录写权复核，再从内核返回旧回执（重放不制造新写入）。"""
    result = peek_result(request) if request is not None else None
    action_id = request.get('action_id') if request is not None else ''
    data = dict(payload or {})
    for key, value in (result or {}).items():
        if value and not data.get(key):
            data[key] = value
    target = _REPLAY_TARGETS.get(action_id)
    if target is None:
        if action_id in {item[0] for item in JOB_ACTIONS} \
                or action_id.startswith('recruitment.jd.') or action_id.startswith('recruitment.rubric.'):
            _guard_job(data, action_id)
            return
        # 收件登记等无单记录目标的动作：按动作声明角色复核即可。
        declaration = next((item for item in ACTIONS if item[0] == action_id), None)
        if declaration is None:
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 未知招聘动作', frappe.PermissionError)
        require_roles(*declaration[2], 'System Manager')
        return
    key, doctype, permission_fn = target
    name = data.get(key)
    if not name:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无法核实重放目标', frappe.PermissionError)
    try:
        doc = frappe.get_doc(doctype, name)
    except frappe.DoesNotExistError:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 重放目标不存在', frappe.PermissionError)
    if not permission_fn(doc, permission_type='write'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 当前身份无权重放该招聘动作', frappe.PermissionError)


def _guard_job(data, action_id):
    job = data.get('job')
    try:
        if action_id.startswith('recruitment.jd.') or action_id.startswith('recruitment.rubric.'):
            revision_document = data.get('revision_document')
            if not revision_document:
                raise frappe.PermissionError('RECRUITMENT_PERMISSION_DENIED: 无法核实重放版本')
            doctype = ('Shangshu Recruitment JD Revision' if action_id.startswith('recruitment.jd.')
                       else 'Shangshu Recruitment Screening Rubric')
            revision = frappe.get_doc(doctype, revision_document)
            job = revision.job
        if not job:
            raise frappe.PermissionError('RECRUITMENT_PERMISSION_DENIED: 无法核实重放岗位')
        doc = frappe.get_doc('Shangshu Recruitment Job', job)
    except frappe.DoesNotExistError:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 重放目标不存在', frappe.PermissionError)
    if not permission(doc, permission_type='write'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 当前身份无权重放该招聘动作', frappe.PermissionError)


__all__ = ['execute', 'permission', 'permission_query', 'revision_permission_query', 'replay_guard']
