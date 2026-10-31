import frappe

from shangshu_core.public_api import get_identity, get_request_context
from shangshu_recruitment.common import reference, schema, text

JOB_DOCTYPE = 'Shangshu Recruitment Job'
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}
READ_ROLES = WRITE_ROLES | {'Hiring Manager'}

JOB_FIELDS = {
    'job_code': text('岗位编码', 80),
    'title': text('职位名称'),
    'department': text('所属部门'),
    'hiring_manager': text('负责人'),
    'headcount': {'type': 'integer', 'title': '招聘人数', 'minimum': 1, 'maximum': 100000},
    'requirements': {'type': 'string', 'title': '任职要求', 'minLength': 1, 'maxLength': 20000,
                     'multiline': True},
    'location': text('工作地点'),
    'employment_type': text('用工类型', 80),
}
JOB_REFERENCE = {'job': text('岗位编号'), 'revision': reference('岗位')['revision']}
JOB_ACTIONS = [
    ('recruitment.job.save', '保存岗位', ['Recruitment Admin', 'Recruiter'],
     schema({**JOB_REFERENCE, **JOB_FIELDS}, [])),
    ('recruitment.job.open', '开放岗位', ['Recruitment Admin', 'Recruiter'],
     schema(JOB_REFERENCE, list(JOB_REFERENCE))),
    ('recruitment.job.close', '关闭岗位', ['Recruitment Admin', 'Recruiter'],
     schema(JOB_REFERENCE, list(JOB_REFERENCE))),
]


def locked_job(name, enterprise_id):
    doc = frappe.get_doc(JOB_DOCTYPE, name, for_update=True)
    if doc.enterprise_id != enterprise_id:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业岗位', frappe.PermissionError)
    return doc


def require_revision(doc, revision):
    if doc.revision != revision:
        frappe.throw('RECRUITMENT_REVISION_CONFLICT: 记录已更新，请刷新后重试', frappe.ValidationError)


def require_status(doc, *allowed):
    if doc.status not in allowed:
        frappe.throw('RECRUITMENT_INVALID_STATE: 当前状态不允许执行该动作', frappe.ValidationError)


def execute_job(action_id, payload):
    from shangshu_recruitment.revisions import latest_published, require_published_revisions

    ctx = get_request_context()
    creating = action_id == 'recruitment.job.save' and not payload.get('job')
    if creating:
        missing = [key for key in JOB_FIELDS if key not in payload]
        if missing:
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 新建岗位缺少字段 ' + missing[0], frappe.ValidationError)
        values = {key: payload[key] for key in JOB_FIELDS}
        if get_identity(values['hiring_manager']).enterprise_id != ctx['enterprise_id']:
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 负责人必须属于当前企业', frappe.ValidationError)
        doc = frappe.get_doc({'doctype': JOB_DOCTYPE, **values, 'enterprise_id': ctx['enterprise_id'],
                              'status': 'draft', 'current_jd_revision': '', 'current_rubric_revision': '',
                              'revision': 1})
        doc.insert(ignore_permissions=True)
    else:
        doc = locked_job(payload['job'], ctx['enterprise_id'])
        require_revision(doc, payload['revision'])
        if action_id == 'recruitment.job.save':
            require_status(doc, 'draft')
            values = {key: payload[key] for key in JOB_FIELDS if key in payload}
            if not values:
                frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 至少修改一个岗位字段', frappe.ValidationError)
            if ('hiring_manager' in values
                    and get_identity(values['hiring_manager']).enterprise_id != ctx['enterprise_id']):
                frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 负责人必须属于当前企业', frappe.ValidationError)
            doc.update(values)
        elif action_id == 'recruitment.job.open':
            require_status(doc, 'draft', 'closed')
            require_published_revisions(doc.name)
            doc.status = 'open'
            doc.current_jd_revision = latest_published('Shangshu Recruitment JD Revision', doc.name)
            doc.current_rubric_revision = latest_published('Shangshu Recruitment Screening Rubric', doc.name)
        elif action_id == 'recruitment.job.close':
            require_status(doc, 'open')
            doc.status = 'closed'
        else:
            frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)
        doc.revision += 1
        doc.save(ignore_permissions=True)
    return {'job': doc.name, 'status': doc.status, 'revision': doc.revision,
            'current_jd_revision': doc.current_jd_revision or '',
            'current_rubric_revision': doc.current_rubric_revision or ''}


def _access_context(user=None):
    if not user or user == frappe.session.user:
        return get_request_context()
    identity = get_identity(user)
    return {'enterprise_id': identity.enterprise_id, 'user_name': user, 'roles': frappe.get_roles(user)}


def permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles.intersection(READ_ROLES):
        return '1=0'
    condition = 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
    if not roles.intersection(WRITE_ROLES):
        condition += ' and hiring_manager=' + frappe.db.escape(ctx['user_name'])
    return condition


def revision_permission_query(user=None):
    ctx = _access_context(user)
    roles = set(ctx['roles'])
    if not roles.intersection(READ_ROLES):
        return '1=0'
    enterprise = frappe.db.escape(ctx['enterprise_id'])
    condition = 'enterprise_id=' + enterprise
    if not roles.intersection(WRITE_ROLES):
        condition += (' and job in (select name from `tabShangshu Recruitment Job` '
                      'where enterprise_id=' + enterprise
                      + ' and hiring_manager=' + frappe.db.escape(ctx['user_name']) + ')')
    return condition


def permission(doc, user=None, permission_type=None):
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
    if getattr(doc, 'doctype', JOB_DOCTYPE) != JOB_DOCTYPE:
        doc = frappe.get_doc(JOB_DOCTYPE, doc.job)
        if doc.enterprise_id != ctx['enterprise_id']:
            return False
    if writing or roles.intersection(WRITE_ROLES):
        return True
    return doc.hiring_manager == ctx['user_name']
