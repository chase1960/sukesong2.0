import json
import re

import frappe

from shangshu_core.public_api import (get_request_context, invoke_domain_service,
                                      start_process)
from shangshu_recruitment.common import contact_key, schema, text
from shangshu_recruitment.job import JOB_DOCTYPE, _access_context, locked_job

INTAKE_DOCTYPE = 'Shangshu Recruitment Intake'
CANDIDATE_DOCTYPE = 'Shangshu Recruitment Candidate'
RESUME_DOCTYPE = 'Shangshu Recruitment Resume'
APPLICATION_DOCTYPE = 'Shangshu Recruitment Application'
DOMAIN = 'com.shangshu.recruitment'
PROCESS_DEFINITION = DOMAIN + '.application'

# 附件入库是 mail.sync 提交之后的异步队列（import_mail_attachments），
# 收件首轮常拿不到文件中心编号。processing 态由调度自动重试，
# 超过该次数仍不就绪就转 needs_manual —— 自动化不能是唯一路径。
MAX_AUTO_ATTEMPTS = 10

SOURCE_TYPE = {'type': 'string', 'title': '来源', 'enum': ['mail', 'manual']}
ATTACHMENT_ITEM = {'type': 'object', 'title': '附件',
                   'properties': {'file': text('来源附件编号'),
                                  'file_center': text('文件中心编号'),
                                  'name': text('附件名')},
                   'additionalProperties': False}
INTAKE_FIELDS = {
    'source_type': SOURCE_TYPE,
    'mail_message': text('来源邮件'),
    'mail_account': text('邮箱账号'),
    'sender_email': {'type': 'string', 'title': '发件邮箱', 'maxLength': 320},
    'subject': {'type': 'string', 'title': '邮件主题', 'maxLength': 500},
    'candidate_name': text('候选人姓名'),
    'candidate_email': {'type': 'string', 'title': '候选人邮箱', 'maxLength': 320},
    'candidate_phone': {'type': 'string', 'title': '候选人电话', 'maxLength': 40},
    'job_code': text('岗位编码', 80),
    'request_id': text('客户端请求号'),
    'file_reference': text('文件中心编号'),
    'file_name': text('文件名'),
    'attachments': {'type': 'array', 'title': '附件', 'items': ATTACHMENT_ITEM},
}
INTAKE_ACTIONS = [
    ('recruitment.application.intake', '登记招聘收件',
     ['Recruitment Admin', 'Recruiter', 'Recruitment System User'],
     schema(INTAKE_FIELDS, ['source_type'])),
    ('recruitment.intake.assign', '指派收件岗位', ['Recruitment Admin', 'Recruiter'],
     schema({'intake': text('收件编号'), 'job': text('岗位编号')}, ['intake', 'job'])),
    ('recruitment.intake.ignore', '忽略收件', ['Recruitment Admin', 'Recruiter'],
     schema({'intake': text('收件编号'),
             'reason': {'type': 'string', 'title': '原因', 'minLength': 1, 'maxLength': 2000,
                        'multiline': True}}, ['intake', 'reason'])),
    ('recruitment.intake.retry', '重试收件处理',
     ['Recruitment Admin', 'Recruiter', 'Recruitment System User'],
     schema({'intake': text('收件编号')}, ['intake'])),
]

JOB_CODE_PATTERN = re.compile(r'\[JOB:([A-Za-z0-9_\-]{1,80})\]')


def extract_job_codes(subject):
    """主题里的 [JOB:code] 标记 → 候选岗位编码列表（0 个=没写，>1 个=含糊）。"""
    return [item.strip() for item in JOB_CODE_PATTERN.findall(subject or '') if item.strip()]


def execute_intake(action_id, payload):
    ctx = get_request_context()
    if action_id == 'recruitment.application.intake':
        return _intake(payload, ctx)
    if action_id == 'recruitment.intake.assign':
        return _assign(payload, ctx)
    if action_id == 'recruitment.intake.ignore':
        return _ignore(payload, ctx)
    if action_id == 'recruitment.intake.retry':
        return _retry(payload, ctx)
    frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)


def _intake(payload, ctx):
    source = payload.get('source_type')
    if source == 'mail':
        return _intake_from_mail(payload, ctx)
    if source == 'manual':
        return _intake_manual(payload, ctx)
    frappe.throw('RECRUITMENT_INVALID_PAYLOAD: source_type 只支持 mail 或 manual', frappe.ValidationError)


def _intake_from_mail(payload, ctx):
    mail_message = (payload.get('mail_message') or '').strip()
    mail_account = (payload.get('mail_account') or '').strip()
    if not mail_message or not mail_account:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 邮件路径必须提供来源邮件与邮箱账号',
                     frappe.ValidationError)
    # 双保险：动作幂等键之外，同一封邮件全库只登记一条收件（邮件名全局唯一）。
    existing = frappe.db.get_value(INTAKE_DOCTYPE, {'mail_message': mail_message}, 'name')
    if existing:
        return _summary(existing)
    sender = (payload.get('sender_email') or '').strip().lower()[:320]
    subject = (payload.get('subject') or '')[:500]
    attachments = _clean_attachments(payload.get('attachments'))
    codes = extract_job_codes(subject)
    doc = frappe.get_doc({
        'doctype': INTAKE_DOCTYPE,
        'enterprise_id': ctx['enterprise_id'],
        'source_type': 'mail',
        'idempotency_key': 'mail:%s:%s' % (mail_account, mail_message),
        'created_by': ctx['user_name'],
        'mail_account': mail_account,
        'mail_message': mail_message,
        'sender_email': sender,
        'subject': subject,
        'candidate_name': (payload.get('candidate_name') or '').strip()[:140],
        'candidate_email': sender,
        'candidate_phone': '',
        'job_code': codes[0] if len(codes) == 1 else '',
        'attachments_json': json.dumps(attachments, ensure_ascii=False) if attachments else '',
        'status': 'received',
        'attempts': 0,
        'received_at': frappe.utils.now_datetime(),
        'revision': 1,
    })
    doc.insert(ignore_permissions=True)
    if len(codes) > 1:
        _mark(doc, 'needs_assignment', 'RECRUITMENT_INTAKE_JOB_AMBIGUOUS')
    elif not attachments:
        _mark(doc, 'ignored', '', '邮件没有附件，未生成简历')
    else:
        _convert(doc, ctx)
    return _summary(doc.name)


def _intake_manual(payload, ctx):
    request_id = (payload.get('request_id') or '').strip()
    display_name = (payload.get('candidate_name') or '').strip()
    email = (payload.get('candidate_email') or '').strip().lower()
    phone = (payload.get('candidate_phone') or '').strip()
    file_reference = (payload.get('file_reference') or '').strip()
    job_code = (payload.get('job_code') or '').strip()
    if not request_id:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 手工录入必须提供客户端请求号',
                     frappe.ValidationError)
    if not display_name:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 手工录入必须提供候选人姓名',
                     frappe.ValidationError)
    if not contact_key(email, phone):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 候选人邮箱与电话至少提供一项有效联系方式',
                     frappe.ValidationError)
    if not file_reference:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 手工录入必须提供文件中心简历编号',
                     frappe.ValidationError)
    key = 'manual:%s:%s' % (ctx['user_name'], request_id)
    existing = frappe.db.get_value(INTAKE_DOCTYPE, {'idempotency_key': key}, 'name')
    if existing:
        return _summary(existing)
    # 手工路径文件必须当场可用（文件域公开版本口：查不到/无权/无哈希都直接拒绝）。
    _, code = _resolve_attachments([{'file_center': file_reference}])
    if code:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 简历文件不存在或暂不可用（%s）' % code,
                     frappe.ValidationError)
    doc = frappe.get_doc({
        'doctype': INTAKE_DOCTYPE,
        'enterprise_id': ctx['enterprise_id'],
        'source_type': 'manual',
        'idempotency_key': key,
        'request_id': request_id,
        'created_by': ctx['user_name'],
        'sender_email': '',
        'subject': '',
        'candidate_name': display_name[:140],
        'candidate_email': email[:320],
        'candidate_phone': phone[:40],
        'job_code': job_code[:80],
        'attachments_json': json.dumps([{'file_center': file_reference,
                                         'name': (payload.get('file_name') or '').strip()[:140]}],
                                        ensure_ascii=False),
        'status': 'received',
        'attempts': 0,
        'received_at': frappe.utils.now_datetime(),
        'revision': 1,
    })
    doc.insert(ignore_permissions=True)
    _convert(doc, ctx)
    return _summary(doc.name)


def _convert(doc, ctx, job_name=None):
    """收件 → 候选人归并 → 简历 → 岗位路由 → 申请 + 流程实例。

    任何一步走不下去都停在可人工介入的状态，不丢收件：
    needs_assignment（岗位问题）、processing（附件未就绪，调度自动重试）、
    needs_manual（其余，人来看）。已 converted/ignored 的收件不再动。
    """
    if doc.status in ('converted', 'ignored'):
        return
    doc.attempts = (doc.attempts or 0) + 1
    candidate = _ensure_candidate(doc, ctx)
    if not candidate:
        _mark(doc, 'needs_manual', 'RECRUITMENT_CONTACT_REQUIRED')
        return
    doc.candidate = candidate
    resolved, code = _resolve_attachments(json.loads(doc.attachments_json or '[]'))
    if resolved is None:
        if code == 'RECRUITMENT_ATTACHMENT_NOT_READY' and doc.attempts <= MAX_AUTO_ATTEMPTS:
            _mark(doc, 'processing', code)
        else:
            _mark(doc, 'needs_manual', code)
        return
    resumes = [_ensure_resume(doc, center, name, sha) for center, name, sha in resolved]
    if not job_name:
        job_name, code = _resolve_job(doc, ctx)
        if not job_name:
            _mark(doc, 'needs_assignment', code)
            return
    doc.matched_job = job_name
    application, reused = _ensure_application(doc, ctx, job_name, resumes)
    _mark(doc, 'converted')
    return application, reused


def _ensure_candidate(doc, ctx):
    """按归一化联系键归并候选人；不存在则建档。返回候选人编号或空串。"""
    email = (doc.candidate_email or '').strip().lower()
    phone = (doc.candidate_phone or '').strip()
    key = contact_key(email, phone)
    if not key:
        return ''
    existing = frappe.db.get_value(CANDIDATE_DOCTYPE, {'enterprise_id': ctx['enterprise_id'],
                                                        'normalized_contact_key': key}, 'name')
    if existing:
        return existing
    fallback = doc.candidate_name or email.split('@')[0] or '未具名候选人'
    candidate = frappe.get_doc({'doctype': CANDIDATE_DOCTYPE,
                                'enterprise_id': ctx['enterprise_id'],
                                'display_name': fallback[:140],
                                'primary_email': email[:320],
                                'primary_phone': phone[:40],
                                'source': doc.source_type, 'revision': 1})
    candidate.normalized_contact_key = key
    candidate.insert(ignore_permissions=True)
    return candidate.name


def _resolve_attachments(entries):
    """附件清单 → [(文件中心编号, 文件名, sha256)]。

    邮件附件存的是来源附件编号（Frappe File id），要经文件域公开口
    `files.imported_of` 批量反查文件中心编号；哈希经 `files.versions` 取。
    返回 (None, 失败码) 表示本轮不可解析：
    · RECRUITMENT_ATTACHMENT_NOT_READY —— 队列还没把附件送进文件中心（可等）；
    · 其余 —— 权限/文件缺失等，转人工。
    """
    entries = [item for item in (entries or []) if isinstance(item, dict)]
    lazy = [str(item.get('file') or '').strip() for item in entries
            if not item.get('file_center')]
    by_source = {}
    if lazy:
        try:
            reply = invoke_domain_service('files.imported_of', {'source_files': lazy}) or {}
            by_source = {str(item.get('source_file')): item
                         for item in reply.get('items') or []}
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            return None, 'RECRUITMENT_FILE_SERVICE_UNAVAILABLE'
    resolved = []
    for item in entries:
        file_name = str(item.get('name') or '').strip()[:140]
        center = str(item.get('file_center') or '').strip()
        if not center:
            info = by_source.get(str(item.get('file') or '').strip()) or {}
            if not info.get('imported'):
                return None, 'RECRUITMENT_ATTACHMENT_NOT_READY'
            center = str(info.get('file_center_id') or '')
            if not center:
                return None, 'RECRUITMENT_FILE_RESTRICTED'
        try:
            versions = invoke_domain_service('files.versions', {'file': center}) or {}
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            return None, 'RECRUITMENT_FILE_NOT_READABLE'
        current = versions.get('current') or {}
        sha = str(current.get('sha256') or '')
        if not sha:
            return None, 'RECRUITMENT_FILE_NOT_READABLE'
        resolved.append((center, file_name, sha))
    return resolved, ''


def _ensure_resume(doc, center, file_name, sha):
    """同一候选人同一文件（sha256）只建一份简历；首份自动为主简历。"""
    existing = frappe.db.get_value(RESUME_DOCTYPE, {'enterprise_id': doc.enterprise_id,
                                                    'candidate': doc.candidate,
                                                    'file_sha256': sha}, 'name')
    if existing:
        return existing
    primary = not frappe.db.exists(RESUME_DOCTYPE, {'candidate': doc.candidate,
                                                    'is_primary': 1})
    resume = frappe.get_doc({'doctype': RESUME_DOCTYPE,
                             'enterprise_id': doc.enterprise_id,
                             'candidate': doc.candidate,
                             'intake': doc.name,
                             'file_reference': center,
                             'file_name': file_name,
                             'file_sha256': sha,
                             'source_type': doc.source_type,
                             'parser_status': 'pending',
                             'parse_attempts': 0,
                             'is_primary': 1 if primary else 0,
                             'created_at': frappe.utils.now_datetime(),
                             'revision': 1})
    resume.insert(ignore_permissions=True)
    return resume.name


def _resolve_job(doc, ctx):
    code = (doc.job_code or '').strip()
    if not code:
        return '', 'RECRUITMENT_INTAKE_JOB_REQUIRED'
    job = frappe.db.get_value(JOB_DOCTYPE, {'enterprise_id': ctx['enterprise_id'],
                                            'job_code': code}, ['name', 'status'], as_dict=True)
    if not job:
        return '', 'RECRUITMENT_JOB_NOT_FOUND'
    if job.status != 'open':
        return '', 'RECRUITMENT_JOB_NOT_OPEN'
    return job.name, ''


def _ensure_application(doc, ctx, job_name, resumes):
    """同一候选人同一岗位只挂一条进行中申请；新申请绑定流程实例（一次性写入）。"""
    active = frappe.db.get_value(APPLICATION_DOCTYPE, {'job': job_name,
                                                       'candidate': doc.candidate,
                                                       'outcome': 'active'}, 'name')
    if active:
        return active, True
    locked_job(job_name, ctx['enterprise_id'])  # 行锁下复核岗位开放，防并发开闸
    active = frappe.db.get_value(APPLICATION_DOCTYPE, {'job': job_name,
                                                       'candidate': doc.candidate,
                                                       'outcome': 'active'}, 'name')
    if active:
        return active, True
    job = frappe.db.get_value(JOB_DOCTYPE, job_name, 'status')
    if job != 'open':
        frappe.throw('RECRUITMENT_JOB_NOT_OPEN: 岗位不是开放状态，不能创建申请',
                     frappe.ValidationError)
    primary = frappe.db.get_value(RESUME_DOCTYPE, {'candidate': doc.candidate,
                                                   'is_primary': 1}, 'name')
    recruiter = ctx['user_name'] if doc.source_type == 'manual' else ''
    application = frappe.get_doc({'doctype': APPLICATION_DOCTYPE,
                                  'enterprise_id': ctx['enterprise_id'],
                                  'job': job_name,
                                  'candidate': doc.candidate,
                                  'primary_resume': primary or (resumes[0] if resumes else ''),
                                  'source_intake': doc.name,
                                  'recruiter': recruiter,
                                  'applied_at': frappe.utils.now_datetime(),
                                  'outcome': 'active',
                                  'revision': 1})
    application.insert(ignore_permissions=True)
    # 流程实例要先有申请名（business_name）才能启动 → 插入后一次性绑定。
    instance = start_process(PROCESS_DEFINITION, application.doctype, application.name,
                             enterprise_id=ctx['enterprise_id'])
    application.process_instance = instance.name
    application.process_revision = instance.definition_version
    application.save(ignore_permissions=True)
    return application.name, False


def _assign(payload, ctx):
    doc = frappe.get_doc(INTAKE_DOCTYPE, payload['intake'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业收件', frappe.PermissionError)
    if doc.status != 'needs_assignment':
        frappe.throw('RECRUITMENT_INVALID_STATE: 只有待指派收件可以指派岗位', frappe.ValidationError)
    job = locked_job(payload['job'], ctx['enterprise_id'])
    if job.status != 'open':
        frappe.throw('RECRUITMENT_JOB_NOT_OPEN: 只能指派到开放岗位', frappe.ValidationError)
    _convert(doc, ctx, job_name=job.name)
    return _summary(doc.name)


def _ignore(payload, ctx):
    doc = frappe.get_doc(INTAKE_DOCTYPE, payload['intake'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业收件', frappe.PermissionError)
    if doc.status == 'converted':
        frappe.throw('RECRUITMENT_INVALID_STATE: 已生成申请的收件不能忽略，请处理申请本身',
                     frappe.ValidationError)
    if doc.status == 'ignored':
        return _summary(doc.name)
    doc.ignore_reason = payload['reason']
    _mark(doc, 'ignored')
    return _summary(doc.name)


def _retry(payload, ctx):
    doc = frappe.get_doc(INTAKE_DOCTYPE, payload['intake'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业收件', frappe.PermissionError)
    if doc.status not in ('processing', 'needs_assignment', 'needs_manual', 'failed'):
        frappe.throw('RECRUITMENT_INVALID_STATE: 该状态的收件不需要重试', frappe.ValidationError)
    doc.failure_code = ''
    _convert(doc, ctx, job_name=doc.matched_job or None)
    return _summary(doc.name)


def _mark(doc, status, failure_code='', ignore_reason=''):
    doc.status = status
    doc.failure_code = failure_code or ''
    doc.ignore_reason = ignore_reason if ignore_reason is not None else (doc.ignore_reason or '')
    doc.revision += 1
    doc.save(ignore_permissions=True)


def _clean_attachments(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        entry = {}
        if str(item.get('file') or '').strip():
            entry['file'] = str(item.get('file')).strip()
        if str(item.get('file_center') or '').strip():
            entry['file_center'] = str(item.get('file_center')).strip()
        if entry and str(item.get('name') or '').strip():
            entry['name'] = str(item.get('name')).strip()[:140]
        if entry:
            out.append(entry)
    return out


def _summary(name):
    doc = frappe.get_doc(INTAKE_DOCTYPE, name)
    return {'intake': doc.name, 'status': doc.status, 'failure_code': doc.failure_code or '',
            'ignore_reason': doc.ignore_reason or '', 'attempts': doc.attempts or 0,
            'candidate': doc.candidate or '', 'matched_job': doc.matched_job or '',
            'revision': doc.revision}


# 收件是运营内部环节：Hiring Manager 不看收件队列，看的是申请之后的数据。
WRITE_ROLES = {'System Manager', 'Recruitment Admin', 'Recruiter'}


def intake_permission(doc, user=None, permission_type=None):
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return False
    return doc is None or doc.enterprise_id == ctx['enterprise_id']


def intake_permission_query(user=None):
    ctx = _access_context(user)
    if not set(ctx['roles']) & WRITE_ROLES:
        return '1=0'
    return 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
