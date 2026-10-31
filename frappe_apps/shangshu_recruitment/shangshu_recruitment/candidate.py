import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.common import contact_key, reference, schema, text
from shangshu_recruitment.job import _access_context

CANDIDATE_DOCTYPE = 'Shangshu Recruitment Candidate'
APPLICATION_DOCTYPE = 'Shangshu Recruitment Application'
JOB_DOCTYPE = 'Shangshu Recruitment Job'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}
READ_ROLES = WRITE_ROLES | {'Hiring Manager'}

CANDIDATE_FIELDS = {
    'display_name': text('姓名'),
    'primary_email': {'type': 'string', 'title': '邮箱', 'minLength': 1, 'maxLength': 320},
    'primary_phone': {'type': 'string', 'title': '电话', 'minLength': 1, 'maxLength': 40},
    'retention_until': {'type': 'string', 'title': '保留期限', 'minLength': 1, 'maxLength': 10},
}
CANDIDATE_REFERENCE = {'candidate': text('候选人编号'), 'revision': reference('候选人')['revision']}
CANDIDATE_ACTIONS = [
    ('recruitment.candidate.save', '保存候选人', ['Recruitment Admin', 'Recruiter'],
     schema({**CANDIDATE_REFERENCE, **CANDIDATE_FIELDS}, [])),
    ('recruitment.candidate.anonymize', '匿名化候选人', ['Recruitment Admin'],
     schema(CANDIDATE_REFERENCE, list(CANDIDATE_REFERENCE))),
]


def _require_retention_date(value):
    try:
        frappe.utils.getdate(value)
    except Exception:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 保留期限必须是 YYYY-MM-DD 日期', frappe.ValidationError)


def _apply_contact_key(doc, enterprise_id):
    """联系方式变更后重算匹配键；键冲突说明已有候选人，人工编辑应直接改旧档。"""
    key = contact_key(doc.primary_email, doc.primary_phone)
    if key and key != doc.normalized_contact_key:
        existing = frappe.db.exists(CANDIDATE_DOCTYPE, {
            'enterprise_id': enterprise_id, 'normalized_contact_key': key, 'name': ['!=', doc.name]})
        if existing:
            frappe.throw('RECRUITMENT_DUPLICATE_CANDIDATE: 该联系方式已存在候选人 ' + existing,
                         frappe.ValidationError)
    doc.normalized_contact_key = key


def execute_candidate(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.candidate.anonymize':
        return _anonymize(payload, ctx)
    if action_id != 'recruitment.candidate.save':
        frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)
    return _save(payload, ctx)


def _save(payload, ctx):
    if payload.get('candidate'):
        doc = frappe.get_doc(CANDIDATE_DOCTYPE, payload['candidate'], for_update=True)
        if doc.enterprise_id != ctx['enterprise_id']:
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权修改其他企业候选人', frappe.PermissionError)
        if doc.revision != payload.get('revision'):
            frappe.throw('RECRUITMENT_REVISION_CONFLICT: 记录已更新，请刷新后重试', frappe.ValidationError)
        values = {key: payload[key] for key in CANDIDATE_FIELDS if key in payload}
        if not values:
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 至少修改一个候选人字段', frappe.ValidationError)
        if 'retention_until' in values:
            _require_retention_date(values['retention_until'])
        doc.update(values)
        _apply_contact_key(doc, ctx['enterprise_id'])
        doc.revision += 1
        doc.save(ignore_permissions=True)
    else:
        if not payload.get('display_name'):
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 新建候选人必须提供姓名', frappe.ValidationError)
        if not (payload.get('primary_email') or payload.get('primary_phone')):
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 邮箱与电话至少提供一项', frappe.ValidationError)
        if payload.get('retention_until'):
            _require_retention_date(payload['retention_until'])
        doc = frappe.get_doc({'doctype': CANDIDATE_DOCTYPE,
                              'display_name': payload['display_name'],
                              'primary_email': payload.get('primary_email', ''),
                              'primary_phone': payload.get('primary_phone', ''),
                              'retention_until': payload.get('retention_until', ''),
                              'source': 'manual', 'enterprise_id': ctx['enterprise_id'], 'revision': 1})
        _apply_contact_key(doc, ctx['enterprise_id'])
        doc.insert(ignore_permissions=True)
    return {'candidate': doc.name, 'display_name': doc.display_name, 'revision': doc.revision,
            'has_contact_key': bool(doc.normalized_contact_key), 'anonymized_at': doc.anonymized_at or ''}


def _anonymize(payload, ctx):
    doc = frappe.get_doc(CANDIDATE_DOCTYPE, payload['candidate'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权匿名化其他企业候选人', frappe.PermissionError)
    if doc.anonymized_at:
        return {'candidate': doc.name, 'anonymized_at': doc.anonymized_at, 'revision': doc.revision}
    if doc.revision != payload.get('revision'):
        frappe.throw('RECRUITMENT_REVISION_CONFLICT: 记录已更新，请刷新后重试', frappe.ValidationError)
    active = frappe.db.exists(APPLICATION_DOCTYPE, {'candidate': doc.name, 'outcome': 'active'})
    if active:
        frappe.throw('RECRUITMENT_INVALID_STATE: 候选人存在进行中的申请，先终止申请再匿名化',
                     frappe.ValidationError)
    doc.display_name = '已匿名候选人'
    doc.primary_email = ''
    doc.primary_phone = ''
    doc.normalized_contact_key = ''
    doc.anonymized_at = frappe.utils.now()
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return {'candidate': doc.name, 'anonymized_at': doc.anonymized_at, 'revision': doc.revision}


def _hiring_manager_job_names(ctx):
    return frappe.get_all(JOB_DOCTYPE, filters={'enterprise_id': ctx['enterprise_id'],
                                                 'hiring_manager': ctx['user_name']}, pluck='name')


def candidate_permission(doc, user=None, permission_type=None):
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
    jobs = _hiring_manager_job_names(ctx)
    if not jobs:
        return False
    return bool(frappe.db.exists(APPLICATION_DOCTYPE,
                                 {'candidate': doc.name, 'job': ['in', jobs]}))


def candidate_permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles.intersection(READ_ROLES):
        return '1=0'
    condition = 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
    if not roles.intersection(WRITE_ROLES):
        condition += (' and name in (select candidate from `tabShangshu Recruitment Application`'
                      ' where job in (select name from `tabShangshu Recruitment Job`'
                      ' where enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
                      + ' and hiring_manager=' + frappe.db.escape(ctx['user_name']) + '))')
    return condition


# 简历与候选人同一可见性口径：Hiring Manager 只能读到自己岗位申请人的简历。
RESUME_DOCTYPE = 'Shangshu Recruitment Resume'


def resume_permission(doc, user=None, permission_type=None):
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
    candidate = frappe.get_doc(CANDIDATE_DOCTYPE, doc.candidate)
    return candidate_permission(candidate, user=user, permission_type='read')


def resume_permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles.intersection(READ_ROLES):
        return '1=0'
    condition = 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
    if not roles.intersection(WRITE_ROLES):
        condition += (' and candidate in (select candidate from `tabShangshu Recruitment Application`'
                      ' where job in (select name from `tabShangshu Recruitment Job`'
                      ' where enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
                      + ' and hiring_manager=' + frappe.db.escape(ctx['user_name']) + '))')
    return condition
