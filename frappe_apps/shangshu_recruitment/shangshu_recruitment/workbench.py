"""招聘证据、经验与异常闭环；唯一事实在 Frappe，审计复用内核 Action。"""
import json
import frappe
from shangshu_core.public_api import get_identity, get_request_context
from shangshu_recruitment.common import schema, text
from shangshu_recruitment.job import locked_job, permission, revision_permission_query, require_revision
from shangshu_recruitment.application import locked_application
from shangshu_recruitment.evidence_policy import canonical, criteria_rows, fingerprint, review_snapshot, validate_matrix

REVIEW = 'Shangshu Recruitment Review'
RULE = 'Shangshu Recruitment Rule'
TASK = 'Shangshu Recruitment Task'
FOLLOWUP = 'Shangshu Recruitment Followup'
WRITE = ['Recruitment Admin', 'Recruiter']
REV = {'type': 'integer', 'title': '记录修订', 'minimum': 1}


def long_text(title, maximum=8000):
    return {**text(title, maximum), 'multiline': True}


def json_text(title):
    return long_text(title + '（JSON）', 100000)


def seconds(title):
    return {'type': 'integer', 'title': title, 'minimum': 0, 'maximum': 86400}


REF = {'record': text('记录编号'), 'revision': REV}
WORKBENCH_ACTIONS = [
    ('recruitment.review.create', '保存候选人证据包', WRITE,
     schema({'application': text('申请编号'), 'context_hash': text('材料与标准指纹'),
             'source_text': long_text('已核对的原文转录', 100000), 'matrix': json_text('逐项证据'),
             'rule_versions': json_text('参考规则版本'), 'model_version': text('模型或人工来源'),
             'preparation_seconds': seconds('整理与核对耗时（秒）')},
            ['application', 'context_hash', 'source_text', 'matrix', 'rule_versions', 'model_version', 'preparation_seconds'])),
    ('recruitment.review.decide', '确认人工判断与理由', WRITE,
     schema({**REF, 'decision': {'type': 'string', 'title': '人工结论', 'enum': ['shortlist', 'hold', 'reject']},
             'reason': long_text('业务理由与证据依据', 2000), 'exceptions': long_text('例外与待验证假设（无则填无）', 2000),
             'review_seconds': seconds('判断与返工耗时（秒）')},
            [*REF, 'decision', 'reason', 'exceptions', 'review_seconds'])),
    ('recruitment.rule.create', '提交有适用边界的经验版本', WRITE,
     schema({'job': text('岗位编号'), 'previous': text('上一版本编号（修订或回滚时填写）'),
             'title': text('经验标题'), 'guidance': long_text('建议、适用情境与局限'),
             'rubric': text('适用标准版本'), 'evidence_reviews': json_text('支持案例编号列表'),
             'counterexamples': json_text('反例编号列表（没有则 []）'), 'limitations': long_text('证据不足与失效条件'),
             'expires_on': {'type': 'string', 'title': '失效日期', 'format': 'date'},
             'change_reason': long_text('新增、修订或回滚理由', 2000)},
            ['job', 'title', 'guidance', 'rubric', 'evidence_reviews', 'counterexamples', 'limitations', 'expires_on', 'change_reason'])),
    ('recruitment.rule.transition', '审阅发布或暂停经验版本', ['Recruitment Admin'],
     schema({**REF, 'state': {'type': 'string', 'title': '目标状态', 'enum': ['active', 'paused', 'retired']},
             'reason': long_text('审阅理由', 2000)}, [*REF, 'state', 'reason'])),
    ('recruitment.task.save', '分派招聘异常任务', WRITE,
     schema({**REF, 'job': text('岗位编号'), 'application': text('关联申请编号'), 'title': text('需要解决的问题'),
             'owner_user': text('责任人账号'), 'escalation_user': text('升级责任人账号'),
             'due_at': {'type': 'string', 'title': '截止时间', 'format': 'date-time'}},
            ['job', 'title', 'owner_user', 'escalation_user', 'due_at'])),
    ('recruitment.task.resolve', '记录任务回执或升级', WRITE,
     schema({**REF, 'state': {'type': 'string', 'title': '处理结果', 'enum': ['closed', 'escalated', 'open']},
             'receipt': long_text('实际处理回执', 4000)}, [*REF, 'state', 'receipt'])),
    ('recruitment.followup.record', '登记结果与复盘观察', WRITE,
     schema({'review': text('已决定的证据包编号'), 'observation': long_text('实际观察与反馈来源'),
             'observed_on': {'type': 'string', 'title': '观察日期', 'format': 'date'},
             'outcome': {'type': 'string', 'title': '观察结论', 'enum': ['confirmed', 'counterexample', 'inconclusive']},
             'rework_seconds': seconds('后续核对返工耗时（秒）')},
            ['review', 'observation', 'observed_on', 'outcome', 'rework_seconds'])),
]


def invalid(message):
    frappe.throw('RECRUITMENT_INVALID_EVIDENCE: ' + message, frappe.ValidationError)


def readable_job(name, ctx, write=False):
    job = locked_job(name, ctx['enterprise_id']) if write else frappe.get_doc('Shangshu Recruitment Job', name)
    if not permission(job, permission_type='write' if write else 'read'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED', frappe.PermissionError)
    return job


def record_permission(doc, user=None, permission_type=None):
    if not permission(doc, user, permission_type):
        return False
    if doc and doc.doctype == REVIEW:
        candidate = frappe.db.get_value('Shangshu Recruitment Application', doc.application, 'candidate')
        return candidate_material_available(candidate)
    return True


def candidate_material_available(candidate):
    row = frappe.db.get_value('Shangshu Recruitment Candidate', candidate,
                              ['anonymized_at', 'retention_until'], as_dict=True)
    return bool(row is not None and not row.anonymized_at and
                (not row.retention_until or str(row.retention_until) >= frappe.utils.today()))


def review_permission_query(user=None):
    # Apply the same lifecycle restriction to generic object/list APIs, not just the detail service.
    return (revision_permission_query(user) +
            ' and application in (select a.name from `tabShangshu Recruitment Application` a'
            ' inner join `tabShangshu Recruitment Candidate` c on c.name=a.candidate'
            " where c.anonymized_at is null and (c.retention_until is null or c.retention_until >= CURRENT_DATE))")


def record_permission_query(user=None):
    return revision_permission_query(user)


def locked_record(doctype, name, ctx):
    doc = frappe.get_doc(doctype, name)
    if doc.enterprise_id != ctx['enterprise_id'] or not record_permission(doc, permission_type='write'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED', frappe.PermissionError)
    # 岗位先锁，所有本模块写入遵循同一顺序。
    readable_job(doc.job, ctx, True)
    return frappe.get_doc(doctype, name, for_update=True)


def json_value(raw, expected):
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        invalid('JSON 格式错误')
    if not isinstance(value, expected):
        invalid('JSON 类型错误')
    return value


def insert_record(doctype, ctx, **values):
    doc = frappe.get_doc({'doctype': doctype, 'enterprise_id': ctx['enterprise_id'], 'revision': 1, **values})
    doc.insert(ignore_permissions=True)
    return doc


def active_rules(job):
    return frappe.get_list(RULE, filters={'job': job.name, 'rubric': job.current_rubric_revision,
                                         'state': 'active', 'expires_on': ['>=', frappe.utils.today()]},
                           fields=['name', 'version_no', 'guidance', 'limitations', 'expires_on'],
                           order_by='name asc', limit_page_length=100)


def evidence_context(application_name, ctx, write=False):
    app = frappe.get_doc('Shangshu Recruitment Application', application_name)
    if app.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED', frappe.PermissionError)
    if not candidate_material_available(app.candidate):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 候选人已匿名化或材料保留期限已过', frappe.PermissionError)
    job = readable_job(app.job, ctx, write)
    if write:
        app = locked_application(app.name, ctx['enterprise_id'])
    if not app.primary_resume or not job.current_rubric_revision or not job.current_jd_revision:
        invalid('先选择主简历并开放已发布标准的岗位')
    resume = frappe.get_doc('Shangshu Recruitment Resume', app.primary_resume, for_update=write)
    rubric = frappe.get_doc('Shangshu Recruitment Screening Rubric', job.current_rubric_revision)
    if (resume.enterprise_id != ctx['enterprise_id'] or resume.candidate != app.candidate
            or rubric.enterprise_id != ctx['enterprise_id'] or rubric.job != job.name or rubric.status != 'published'):
        invalid('简历或标准归属不一致')
    criteria = criteria_rows(rubric.required_criteria, rubric.preferred_criteria)
    rules = [dict(row) for row in active_rules(job)]
    snapshot = review_snapshot(app, job, resume, rubric, criteria, rules)
    # 日期序列化固定，服务返回前后可重建相同指纹。
    snapshot = json.loads(json.dumps(snapshot, ensure_ascii=False, default=str))
    return app, job, snapshot


def context_service(_service, payload, ctx):
    _, _, snapshot = evidence_context(payload['application'], ctx)
    return {'snapshot': snapshot, 'context_hash': fingerprint(snapshot),
            'provenance': 'human_transcription', 'notice': '粘贴原文件的已核对文本；逐字引用只证明来自转录，能力真实性仍需核实。'}


def create_review(p, ctx):
    app, job, snapshot = evidence_context(p['application'], ctx, True)
    if app.outcome != 'active' or p['context_hash'] != fingerprint(snapshot):
        invalid('申请、材料或标准已变化，请重新整理')
    used = json_value(p['rule_versions'], list)
    allowed = {r['name']: r['version_no'] for r in snapshot['rule_versions']}
    if any(not isinstance(r, dict) or set(r) != {'name', 'version_no'}
           or allowed.get(r['name']) != r['version_no'] for r in used):
        invalid('参考规则已失效或不属于本岗位标准')
    try:
        matrix = validate_matrix(snapshot['criteria'], p['source_text'], json_value(p['matrix'], list))
    except ValueError as error:
        invalid(str(error))
    return insert_record(REVIEW, ctx, job=job.name, application=app.name, resume=snapshot['resume'],
                         rubric=snapshot['rubric'], snapshot_json=canonical(snapshot), source_text=p['source_text'],
                         source_hash=fingerprint(p['source_text']), context_hash=p['context_hash'],
                         matrix_json=canonical(matrix), rule_versions=canonical(used), provenance='human_transcription',
                         model_version=p['model_version'], preparation_seconds=p['preparation_seconds'], state='draft')


def decide_review(p, ctx):
    # 与原 screening 动作保持 application → screening 顺序；岗位锁避免本模块并发判断。
    doc = locked_record(REVIEW, p['record'], ctx)
    require_revision(doc, p['revision'])
    if doc.state != 'draft':
        invalid('判断已确认，证据包不可覆盖')
    app, _, snapshot = evidence_context(doc.application, ctx, True)
    if app.outcome != 'active' or fingerprint(snapshot) != doc.context_hash:
        invalid('主简历、标准或经验版本发生变化，须创建新证据包')
    if frappe.db.exists('Shangshu Recruitment Screening', {'application': app.name, 'status': 'decided'}):
        invalid('申请已有正式筛选结论，请在后续环节登记观察')
    doc.update({'decision': p['decision'], 'reason': p['reason'], 'exceptions': p['exceptions'],
                'review_seconds': p['review_seconds'], 'decided_by': ctx['user_name'],
                'decided_at': frappe.utils.now_datetime(), 'state': 'decided'})
    if p['decision'] in ('shortlist', 'reject'):
        # 正式筛选事实复用既有 Screening；Review 是不可变的判断材料。
        from shangshu_recruitment.screening import _propose, _decide
        screening = _propose({'application': app.name, 'resume': doc.resume,
                              'summary': '人工证据包 ' + doc.name, 'recommendation': p['decision']}, ctx)
        _decide({'screening': screening['screening'], 'revision': screening['revision'],
                 'decision': p['decision'], 'reason': p['reason']}, ctx)
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return doc


def case_ids(raw, job, ctx):
    ids = json_value(raw, list)
    if len(ids) > 50 or any(not isinstance(v, str) for v in ids) or len(set(ids)) != len(ids):
        invalid('案例须为最多 50 个不重复编号')
    for name in ids:
        review = locked_record(REVIEW, name, ctx)
        if review.job != job.name or review.state != 'decided':
            invalid('经验案例必须为本岗位已确认的判断')
    return ids


def create_rule(p, ctx):
    job = readable_job(p['job'], ctx, True)
    rubric = frappe.get_doc('Shangshu Recruitment Screening Rubric', p['rubric'])
    if rubric.job != job.name or rubric.enterprise_id != ctx['enterprise_id'] or rubric.status != 'published':
        invalid('经验必须绑定本岗位的已发布标准')
    from shangshu_recruitment.revisions import _disallowed
    if _disallowed(p['guidance']):
        invalid('经验包含禁用属性，请重新审阅')
    evidence = case_ids(p['evidence_reviews'], job, ctx)
    counters = case_ids(p['counterexamples'], job, ctx)
    if not evidence or set(evidence) & set(counters):
        invalid('至少一个支持案例，且支持与反例不能重复')
    if frappe.utils.getdate(p['expires_on']) <= frappe.utils.getdate():
        invalid('经验失效日必须在未来')
    previous = locked_record(RULE, p['previous'], ctx) if p.get('previous') else None
    if previous and previous.job != job.name:
        invalid('不能跨岗位修订经验')
    lineage = (previous.lineage or previous.name) if previous else frappe.generate_hash(length=24)
    versions = frappe.get_all(RULE, filters={'job': job.name, 'lineage': lineage}, pluck='version_no') if lineage else []
    doc = insert_record(RULE, ctx, job=job.name, rubric=rubric.name, title=p['title'], guidance=p['guidance'],
                        limitations=p['limitations'], expires_on=p['expires_on'], evidence_reviews=canonical(evidence),
                        counterexamples=canonical(counters), change_reason=p['change_reason'], previous=p.get('previous'),
                        lineage=lineage, version_no=max(versions or [0]) + 1, state='draft')
    return doc


def transition_rule(p, ctx):
    doc = locked_record(RULE, p['record'], ctx)
    require_revision(doc, p['revision'])
    transitions = {'draft': {'active', 'retired'}, 'active': {'paused', 'retired'},
                   'paused': {'active', 'retired'}, 'retired': set()}
    if p['state'] not in transitions.get(doc.state, set()):
        invalid('经验状态转换无效；回滚须从历史版本新建并重新审阅')
    if p['state'] == 'active':
        job = readable_job(doc.job, ctx, True)
        if str(doc.expires_on) < frappe.utils.today() or doc.rubric != job.current_rubric_revision:
            invalid('经验已过期或标准不适用')
        if doc.owner == ctx['user_name']:
            invalid('经验须由另一位招聘管理员审阅后发布')
        for other in frappe.get_all(RULE, filters={'lineage': doc.lineage, 'state': 'active'}, pluck='name'):
            old = locked_record(RULE, other, ctx)
            old.state = 'paused'
            old.revision += 1
            old.save(ignore_permissions=True)
    doc.state, doc.review_reason, doc.reviewed_by = p['state'], p['reason'], ctx['user_name']
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return doc


def save_task(p, ctx):
    job = readable_job(p['job'], ctx, True)
    for user in (p['owner_user'], p['escalation_user']):
        if get_identity(user).enterprise_id != ctx['enterprise_id'] or not set(frappe.get_roles(user)) & set(WRITE):
            invalid('责任人须为本企业招聘人员')
    if frappe.utils.get_datetime(p['due_at']) <= frappe.utils.now_datetime():
        invalid('截止时间必须在未来')
    if p.get('application'):
        app = locked_application(p['application'], ctx['enterprise_id'])
        if app.job != job.name:
            invalid('任务申请不属于该岗位')
    values = {key: p.get(key) for key in ('job', 'application', 'title', 'owner_user', 'escalation_user', 'due_at')}
    if not p.get('record'):
        return insert_record(TASK, ctx, **values, state='open')
    doc = locked_record(TASK, p['record'], ctx)
    require_revision(doc, p.get('revision'))
    if doc.job != job.name or doc.state == 'closed':
        invalid('不能转移岗位或修改已关闭任务')
    doc.update(values)
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return doc


def resolve_task(p, ctx):
    doc = locked_record(TASK, p['record'], ctx)
    require_revision(doc, p['revision'])
    if ctx['user_name'] not in (doc.owner_user, doc.escalation_user) and 'Recruitment Admin' not in ctx['roles']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 由责任人或升级负责人登记回执', frappe.PermissionError)
    if doc.state == 'closed' and p['state'] != 'open':
        invalid('已关闭任务只能明确重新打开')
    doc.state, doc.receipt = p['state'], p['receipt']
    doc.resolved_at = frappe.utils.now_datetime() if doc.state == 'closed' else None
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return doc


def followup(p, ctx):
    review = locked_record(REVIEW, p['review'], ctx)
    if review.state != 'decided':
        invalid('仅能复盘已经确认的人工判断')
    if not frappe.utils.getdate(review.decided_at) <= frappe.utils.getdate(p['observed_on']) <= frappe.utils.getdate():
        invalid('观察日期须介于决定日期和今天之间')
    return insert_record(FOLLOWUP, ctx, job=review.job, review=review.name, observation=p['observation'],
                         outcome=p['outcome'], observed_on=p['observed_on'], rework_seconds=p['rework_seconds'])


HANDLERS = dict(zip([a[0] for a in WORKBENCH_ACTIONS],
                    [create_review, decide_review, create_rule, transition_rule, save_task, resolve_task, followup]))


def execute_workbench(action_id, payload):
    doc = HANDLERS[action_id](payload, get_request_context())
    return {'record': doc.name, 'revision': doc.revision, 'job': doc.job}


def workspace(_service, payload, ctx):
    job = readable_job(payload['job'], ctx)
    result = {'job': {key: job.get(key) for key in ('name', 'title', 'status', 'revision',
                                                   'current_jd_revision', 'current_rubric_revision')},
              'collections': {}, 'truncated': [], 'restricted': [], 'as_of': str(frappe.utils.now_datetime())}
    definitions = {
        'standards': ('Shangshu Recruitment Screening Rubric', ['name', 'version_no', 'status', 'required_criteria', 'preferred_criteria', 'revision']),
        'jd': ('Shangshu Recruitment JD Revision', ['name', 'version_no', 'status', 'content', 'revision']),
        'applications': ('Shangshu Recruitment Application', ['name', 'candidate', 'primary_resume', 'outcome', 'revision']),
        'reviews': (REVIEW, ['name', 'application', 'rubric', 'state', 'decision', 'reason', 'exceptions', 'decided_by', 'decided_at', 'preparation_seconds', 'review_seconds', 'rule_versions', 'revision']),
        'rules': (RULE, ['name', 'title', 'guidance', 'limitations', 'rubric', 'version_no', 'previous', 'state', 'expires_on', 'evidence_reviews', 'counterexamples', 'change_reason', 'revision']),
        'tasks': (TASK, ['name', 'title', 'application', 'owner_user', 'escalation_user', 'due_at', 'state', 'receipt', 'revision']),
        'followups': (FOLLOWUP, ['name', 'review', 'observed_on', 'outcome', 'observation', 'rework_seconds']),
    }
    for key, (doctype, fields) in definitions.items():
        if not frappe.has_permission(doctype, 'read'):
            result['restricted'].append(key)
            result['collections'][key] = []
            continue
        rows = frappe.get_list(doctype, filters={'job': job.name}, fields=fields, order_by='creation desc', limit_page_length=101)
        if len(rows) > 100:
            result['truncated'].append(key)
        result['collections'][key] = [dict(row) for row in rows[:100]]
    applications = [row['name'] for row in result['collections']['applications']]
    pipeline = []
    for kind, doctype in [('screening', 'Shangshu Recruitment Screening'),
                          ('interview', 'Shangshu Recruitment Interview'),
                          ('offer', 'Shangshu Recruitment Offer'),
                          ('onboarding', 'Shangshu Recruitment Onboarding')]:
        if not frappe.has_permission(doctype, 'read'):
            result['restricted'].append(kind)
            continue
        rows = frappe.get_list(doctype, filters={'application': ['in', applications]},
                               fields=['name', 'application', 'status', 'revision'],
                               order_by='creation desc', limit_page_length=101) if applications else []
        if len(rows) > 100:
            result['truncated'].append(kind)
        pipeline.extend({'kind': kind, **dict(row)} for row in rows[:100])
    result['collections']['pipeline'] = pipeline
    # Intakes have enterprise-wide recruiter access; hiring managers cannot see unassigned mail.
    intake_type = 'Shangshu Recruitment Intake'
    if frappe.has_permission(intake_type, 'read'):
        rows = frappe.get_list(intake_type, filters={'enterprise_id': ctx['enterprise_id']},
                               or_filters=[['matched_job', '=', job.name], ['matched_job', 'is', 'not set']],
                               fields=['name', 'matched_job', 'status', 'received_at', 'candidate', 'failure_code', 'revision'],
                               order_by='creation desc', limit_page_length=101)
        result['collections']['intakes'] = [dict(row) for row in rows[:100]]
        if len(rows) > 100:
            result['truncated'].append('intakes')
    else:
        result['restricted'].append('intakes')
    candidates = [row['candidate'] for row in result['collections']['applications']]
    if candidates and frappe.has_permission('Shangshu Recruitment Resume', 'read'):
        rows = frappe.get_list('Shangshu Recruitment Resume', filters={'candidate': ['in', candidates]},
                               fields=['name', 'candidate', 'file_reference', 'parser_status', 'revision'],
                               order_by='creation desc', limit_page_length=101)
        result['collections']['resumes'] = [dict(row) for row in rows[:100]]
        if len(rows) > 100:
            result['truncated'].append('resumes')
    return result


def detail(_service, payload, ctx):
    doc = frappe.get_doc(REVIEW, payload['record'])
    if doc.enterprise_id != ctx['enterprise_id'] or not record_permission(doc, permission_type='read'):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED', frappe.PermissionError)
    fields = ('name', 'application', 'job', 'resume', 'rubric', 'source_text', 'source_hash', 'snapshot_json',
              'matrix_json', 'rule_versions', 'state', 'decision', 'reason', 'exceptions', 'revision', 'provenance',
              'model_version', 'preparation_seconds', 'review_seconds')
    return {'review': {key: doc.get(key) for key in fields}}


def replay_guard(payload, request):
    from shangshu_core.public_api import peek_result
    ctx = get_request_context()
    data = {**payload, **(peek_result(request) or {})}
    action = request.get('action_id')
    kind = REVIEW if action.startswith('recruitment.review.') else RULE if action.startswith('recruitment.rule.') else TASK
    if action == 'recruitment.followup.record':
        kind = FOLLOWUP
    if data.get('record'):
        locked_record(kind, data['record'], ctx)
    elif data.get('job'):
        readable_job(data['job'], ctx, True)
    elif data.get('application'):
        evidence_context(data['application'], ctx, True)
    elif data.get('review'):
        locked_record(REVIEW, data['review'], ctx)
    else:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无法核实重放目标', frappe.PermissionError)


def validate_record(doc, method=None):
    if not getattr(frappe.flags, 'recruitment_write', False):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 仅允许受管动作写入', frappe.PermissionError)
    old = doc.get_doc_before_save()
    if not old:
        return
    immutable = ['enterprise_id', 'job']
    if doc.doctype in (REVIEW, RULE, FOLLOWUP):
        mutable = ({'state', 'decision', 'reason', 'exceptions', 'review_seconds', 'decided_by', 'decided_at', 'revision'}
                   if doc.doctype == REVIEW and old.state == 'draft' else
                   {'state', 'review_reason', 'reviewed_by', 'revision'} if doc.doctype == RULE else set())
        immutable += [f.fieldname for f in doc.meta.fields if f.fieldname not in mutable]
    for field in set(immutable):
        if old.get(field) != doc.get(field):
            frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: ' + field, frappe.ValidationError)


def prevent_delete(doc, method=None):
    frappe.throw('RECRUITMENT_PERMISSION_DENIED: 历史记录不可删除', frappe.PermissionError)
