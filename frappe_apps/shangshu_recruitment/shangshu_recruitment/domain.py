"""招聘域贡献聚合：岗位/JD/rubric + 收件到入职全链对象与数据集；执行统一走 service.execute。"""
from shangshu_core.public_api import query_object_records

from shangshu_recruitment.common import DOMAIN, ROLES
from shangshu_recruitment.job import JOB_ACTIONS, JOB_FIELDS
from shangshu_recruitment.revisions import REVISION_ACTIONS
from shangshu_recruitment.candidate import CANDIDATE_ACTIONS
from shangshu_recruitment.application import APPLICATION_ACTIONS
from shangshu_recruitment.intake import INTAKE_ACTIONS
from shangshu_recruitment.mailbox import MAILBOX_ACTIONS
from shangshu_recruitment.screening import SCREENING_ACTIONS
from shangshu_recruitment.interview import INTERVIEW_ACTIONS
from shangshu_recruitment.hire import HIRE_ACTIONS
from shangshu_recruitment.workbench import WORKBENCH_ACTIONS

HANDLER = 'shangshu_recruitment.service.execute'
ACTIONS = (JOB_ACTIONS + REVISION_ACTIONS + CANDIDATE_ACTIONS + APPLICATION_ACTIONS
           + INTAKE_ACTIONS + MAILBOX_ACTIONS + SCREENING_ACTIONS + INTERVIEW_ACTIONS + HIRE_ACTIONS + WORKBENCH_ACTIONS)
PROCESS_ID = DOMAIN + '.application'

STATUS = {'draft': '草稿', 'open': '招聘中', 'closed': '已关闭'}
REVISION_STATUS = {'draft': '草稿', 'published': '已发布', 'retired': '已退役'}
SOURCE = {'manual': '人工撰写', 'ai_assisted': 'AI 辅助'}
INTAKE_SOURCE = {'mail': '邮件', 'manual': '手工补录'}
INTAKE_STATUS = {'processing': '附件处理中', 'needs_manual': '待人工处理',
                 'converted': '已转申请', 'ignored': '已忽略'}
OUTCOME = {'active': '进行中', 'hired': '已入职', 'rejected': '已淘汰', 'withdrawn': '已撤回'}
SCREENING_RECOMMENDATION = {'shortlist': '建议通过', 'reject': '建议淘汰'}
SCREENING_STATUS = {'proposed': '待决定', 'decided': '已决定'}
INTERVIEW_STATUS = {'scheduled': '已安排', 'completed': '已完成', 'cancelled': '已取消'}
INTERVIEW_RESULT = {'pass': '通过', 'fail': '未通过'}
EVALUATION_CONCLUSION = {'recommend': '推荐', 'hold': '待定', 'no_recommend': '不推荐'}
OFFER_STATUS = {'proposed': '待审批', 'approved': '已审批', 'accepted': '已接受', 'declined': '已婉拒'}
ONBOARDING_STATUS = {'in_progress': '进行中', 'completed': '已完成'}
BOOLEAN = {'0': '否', 'false': '否', '1': '是', 'true': '是'}

JOB_OBJECT_FIELDS = [('name', '岗位编号', 'string'), ('job_code', '岗位编码', 'string'),
    ('title', '职位名称', 'string'), ('department', '所属部门', 'string'),
    ('hiring_manager', '负责人', 'identity'), ('headcount', '招聘人数', 'integer'),
    ('requirements', '任职要求', 'string'), ('location', '工作地点', 'string'),
    ('employment_type', '用工类型', 'string'), ('status', '岗位状态', 'enum'),
    ('current_jd_revision', '当前 JD 版本', 'string'), ('current_rubric_revision', '当前筛选标准版本', 'string'),
    ('revision', '修订', 'integer')]
JD_OBJECT_FIELDS = [('name', '版本记录编号', 'string'), ('job', '岗位', 'string'),
    ('version_no', '版本号', 'integer'), ('content', 'JD 正文', 'string'), ('source', '来源', 'enum'),
    ('status', '状态', 'enum'), ('model_name', '模型名', 'string'), ('model_version', '模型版本', 'string'),
    ('published_by', '发布人', 'identity'), ('published_at', '发布时间', 'datetime'),
    ('revision', '修订', 'integer')]
RUBRIC_OBJECT_FIELDS = [('name', '版本记录编号', 'string'), ('job', '岗位', 'string'),
    ('version_no', '版本号', 'integer'), ('required_criteria', '必要条件', 'string'),
    ('preferred_criteria', '加分条件', 'string'), ('weights', '权重', 'string'),
    ('disallowed_criteria', '禁用条件', 'string'), ('status', '状态', 'enum'),
    ('published_by', '发布人', 'identity'), ('published_at', '发布时间', 'datetime'),
    ('revision', '修订', 'integer')]
# 候选人对象投影不含 PII：邮箱/电话/归并键按字段权限控制，默认不进对象层。
CANDIDATE_OBJECT_FIELDS = [('name', '候选人编号', 'string'), ('display_name', '展示名', 'string'),
    ('source', '来源', 'enum'), ('retention_until', '留存截止', 'date'),
    ('anonymized_at', '匿名化时间', 'datetime'), ('revision', '修订', 'integer')]
CANDIDATE_SOURCE = {'mail': '邮件', 'manual': '手工补录'}
RESUME_OBJECT_FIELDS = [('name', '简历编号', 'string'), ('candidate', '候选人', 'string'),
    ('file_reference', '文件中心引用', 'string'), ('file_sha256', '文件指纹', 'string'),
    ('parsed_profile', '解析结果', 'string'), ('parser_status', '解析状态', 'string'), ('is_primary', '是否主简历', 'boolean'),
    ('revision', '修订', 'integer')]
APPLICATION_OBJECT_FIELDS = [('name', '申请编号', 'string'), ('job', '岗位', 'string'),
    ('candidate', '候选人', 'string'), ('outcome', '结果', 'enum'), ('outcome_reason', '结果原因', 'string'),
    ('process_instance', '流程实例', 'string'), ('primary_resume', '主简历', 'string'),
    ('revision', '修订', 'integer')]
INTAKE_OBJECT_FIELDS = [('name', '收件编号', 'string'), ('source_type', '来源', 'enum'),
    ('status', '状态', 'enum'), ('failure_code', '失败码', 'string'),
    ('attempts', '重试次数', 'integer'), ('matched_job', '匹配岗位', 'string'),
    ('candidate', '候选人', 'string'), ('revision', '修订', 'integer')]
MAILBOX_OBJECT_FIELDS = [('name', '邮箱绑定编号', 'string'), ('mailbox_id', '共享邮箱标识', 'string'),
    ('sync_user', '同步账号', 'identity'), ('enabled', '启用', 'boolean'),
    ('revision', '修订', 'integer')]
SCREENING_OBJECT_FIELDS = [('name', '筛选编号', 'string'), ('application', '申请', 'string'),
    ('resume', '简历', 'string'), ('summary', '建议摘要', 'string'),
    ('recommendation', '建议结论', 'enum'), ('status', '状态', 'enum'),
    ('decision', '筛选结论', 'enum'), ('decision_reason', '结论原因', 'string'),
    ('decided_by', '决定人', 'identity'), ('decided_at', '决定时间', 'datetime'),
    ('revision', '修订', 'integer')]
INTERVIEW_OBJECT_FIELDS = [('name', '面试编号', 'string'), ('application', '申请', 'string'),
    ('round', '轮次', 'integer'), ('stage', '面试环节', 'string'),
    ('scheduled_at', '计划时间', 'datetime'), ('interviewer', '面试官', 'identity'),
    ('status', '状态', 'enum'), ('result', '结果', 'enum'), ('note', '备注', 'string'),
    ('completed_at', '完成时间', 'datetime'), ('revision', '修订', 'integer')]
EVALUATION_OBJECT_FIELDS = [('name', '评价编号', 'string'), ('interview', '面试', 'string'),
    ('evaluator', '评价人', 'identity'), ('conclusion', '结论', 'enum'),
    ('comment', '评语', 'string'), ('submitted_at', '提交时间', 'datetime'),
    ('revision', '修订', 'integer')]
OFFER_OBJECT_FIELDS = [('name', 'Offer 编号', 'string'), ('application', '申请', 'string'),
    ('terms', '条款摘要', 'string'), ('effective_date', '生效日期', 'date'),
    ('status', '状态', 'enum'), ('reply_note', '回复备注', 'string'), ('revision', '修订', 'integer')]
ONBOARDING_OBJECT_FIELDS = [('name', '入职编号', 'string'), ('application', '申请', 'string'),
    ('offer', 'Offer', 'string'), ('planned_date', '计划入职日', 'date'),
    ('status', '状态', 'enum'), ('note', '备注', 'string'), ('completed_at', '完成时间', 'datetime'),
    ('revision', '修订', 'integer')]


def _object_fields(rows, labels):
    return [{'id': key, 'label': label, 'type': type_, **({'value_labels': labels[key]} if key in labels else {})}
            for key, label, type_ in rows]


def _simple_object(object_id, name, doctype, fields, labels=None, filter_fields=None):
    """只读对象（收件到入职各阶段）：写入一律走受管动作，对象层只投影。"""
    return {'id': object_id, 'name': name, 'doctype': doctype, 'version': '1.0.0',
            'schema_version': 1, 'operations': ['read'],
            'filter_fields': filter_fields or [key for key, _, _ in fields[:2]],
            'fields': _object_fields(fields, labels or {})}


def _job_record_actions():
    # job.save 编辑=部分更新：业务字段预填、主键版本隐藏，仅草稿可改（orders.edit 同款口径）。
    actions = [{'action_id': 'recruitment.job.save', 'hidden': ['job', 'revision'],
                'bindings': {'job': 'name', 'revision': 'revision', **{key: key for key in JOB_FIELDS}},
                'when': {'status': 'draft'}}]
    # draft/closed 都可再次开放（关闭后重开须重新校验当前发布版本）。
    for state in ['draft', 'closed']:
        actions.append({'action_id': 'recruitment.job.open', 'hidden': ['job', 'revision'],
                        'bindings': {'job': 'name', 'revision': 'revision'}, 'when': {'status': state}})
    actions.append({'action_id': 'recruitment.job.close', 'hidden': ['job', 'revision'],
                    'bindings': {'job': 'name', 'revision': 'revision'}, 'when': {'status': 'open'}})
    return actions


def _revision_record_actions(save_action, publish_action, editable):
    # 版本化文档：draft 可改可发布；published/retired 只读（不可变由服务端闸守卫）。
    return [{'action_id': save_action, 'hidden': ['revision_document', 'revision', 'job'],
             'bindings': {'revision_document': 'name', 'revision': 'revision', 'job': 'job', **editable},
             'when': {'status': 'draft'}},
            {'action_id': publish_action, 'hidden': ['revision_document', 'revision'],
             'bindings': {'revision_document': 'name', 'revision': 'revision'}, 'when': {'status': 'draft'}}]


def get_contribution():
    job = {'id': 'recruitment.job', 'name': '岗位', 'doctype': 'Shangshu Recruitment Job',
           'version': '1.0.0', 'schema_version': 1, 'operations': ['read'],
           'filter_fields': ['job_code', 'title', 'department', 'status'],
           'fields': _object_fields(JOB_OBJECT_FIELDS, {'status': STATUS}),
           'record_actions': _job_record_actions()}
    jd = {'id': 'recruitment.jd_revision', 'name': 'JD 版本', 'doctype': 'Shangshu Recruitment JD Revision',
          'version': '1.0.0', 'schema_version': 1, 'operations': ['read'],
          'filter_fields': ['job', 'status'],
          'fields': _object_fields(JD_OBJECT_FIELDS, {'status': REVISION_STATUS, 'source': SOURCE}),
          'record_actions': _revision_record_actions('recruitment.jd.save', 'recruitment.jd.publish',
                                                     {'content': 'content', 'source': 'source'})}
    rubric = {'id': 'recruitment.screening_rubric', 'name': '筛选标准',
              'doctype': 'Shangshu Recruitment Screening Rubric',
              'version': '1.0.0', 'schema_version': 1, 'operations': ['read'],
              'filter_fields': ['job', 'status'],
              'fields': _object_fields(RUBRIC_OBJECT_FIELDS, {'status': REVISION_STATUS}),
              'record_actions': _revision_record_actions(
                  'recruitment.rubric.save', 'recruitment.rubric.publish',
                  {'required_criteria': 'required_criteria', 'preferred_criteria': 'preferred_criteria',
                   'weights': 'weights', 'disallowed_criteria': 'disallowed_criteria'})}
    objects = [job, jd, rubric,
               _simple_object('recruitment.candidate', '候选人', 'Shangshu Recruitment Candidate',
                              CANDIDATE_OBJECT_FIELDS, {'source': CANDIDATE_SOURCE},
                              ['source', 'retention_until']),
               _simple_object('recruitment.resume', '简历', 'Shangshu Recruitment Resume',
                              RESUME_OBJECT_FIELDS, None, ['candidate', 'is_primary']),
               _simple_object('recruitment.application', '申请', 'Shangshu Recruitment Application',
                              APPLICATION_OBJECT_FIELDS, {'outcome': OUTCOME}, ['job', 'outcome']),
               _simple_object('recruitment.intake', '收件', 'Shangshu Recruitment Intake',
                              INTAKE_OBJECT_FIELDS,
                              {'source_type': INTAKE_SOURCE, 'status': INTAKE_STATUS},
                              ['source_type', 'status', 'matched_job']),
               _simple_object('recruitment.mailbox', '招聘邮箱', 'Shangshu Recruitment Mailbox',
                              MAILBOX_OBJECT_FIELDS, {'enabled': BOOLEAN}, ['mailbox_id', 'enabled']),
               _simple_object('recruitment.screening', '简历筛选', 'Shangshu Recruitment Screening',
                              SCREENING_OBJECT_FIELDS,
                              {'recommendation': SCREENING_RECOMMENDATION, 'status': SCREENING_STATUS,
                               'decision': SCREENING_RECOMMENDATION},
                              ['application', 'status']),
               _simple_object('recruitment.interview', '面试', 'Shangshu Recruitment Interview',
                              INTERVIEW_OBJECT_FIELDS,
                              {'status': INTERVIEW_STATUS, 'result': INTERVIEW_RESULT},
                              ['application', 'status']),
               _simple_object('recruitment.interview_evaluation', '面试评价',
                              'Shangshu Recruitment Interview Evaluation', EVALUATION_OBJECT_FIELDS,
                              {'conclusion': EVALUATION_CONCLUSION}, ['interview', 'conclusion']),
               _simple_object('recruitment.offer', 'Offer', 'Shangshu Recruitment Offer',
                              OFFER_OBJECT_FIELDS, {'status': OFFER_STATUS}, ['application', 'status']),
               _simple_object('recruitment.onboarding', '入职', 'Shangshu Recruitment Onboarding',
                              ONBOARDING_OBJECT_FIELDS, {'status': ONBOARDING_STATUS},
                              ['application', 'status'])]
    workbench_objects = [
        ('review', '判断证据包', 'Review', [('application', '申请', 'string'), ('rubric', '标准版本', 'string'),
          ('state', '状态', 'string'), ('decision', '人工判断', 'string'), ('reason', '理由', 'string'),
          ('exceptions', '例外与假设', 'string'), ('rule_versions', '参考经验版本', 'string'),
          ('preparation_seconds', '整理核对秒数', 'integer'), ('review_seconds', '判断返工秒数', 'integer')]),
        ('rule', '经验版本', 'Rule', [('title', '标题', 'string'), ('guidance', '建议', 'string'),
          ('rubric', '适用标准', 'string'), ('version_no', '版本', 'integer'), ('previous', '上一版本', 'string'),
          ('state', '状态', 'string'), ('expires_on', '失效日', 'date'), ('limitations', '局限', 'string'),
          ('evidence_reviews', '支持案例', 'string'), ('counterexamples', '反例', 'string')]),
        ('task', '招聘异常', 'Task', [('title', '问题', 'string'), ('owner_user', '责任人', 'identity'),
          ('escalation_user', '升级责任人', 'identity'), ('due_at', '期限', 'datetime'),
          ('state', '状态', 'string'), ('receipt', '回执', 'string')]),
        ('followup', '结果观察', 'Followup', [('review', '判断证据包', 'string'), ('observed_on', '观察日', 'date'),
          ('outcome', '观察结论', 'string'), ('observation', '观察与来源', 'string'), ('rework_seconds', '返工秒数', 'integer')]),
    ]
    for key, title, suffix, fields in workbench_objects:
        objects.append(_simple_object('recruitment.' + key, title, 'Shangshu Recruitment ' + suffix,
                       [('name', '编号', 'string'), ('job', '岗位', 'string')] + fields + [('revision', '修订', 'integer')],
                       filter_fields=['job']))
    columns = [{'field': key, 'label': label} for key, label, _ in JOB_OBJECT_FIELDS
               if key in ('job_code', 'title', 'department', 'hiring_manager', 'headcount', 'employment_type')]
    columns.append({'field': 'status', 'label': '岗位状态', 'value_labels': STATUS})
    job_filters = [{'field': 'job_code', 'label': '岗位编码', 'type': 'text'},
                   {'field': 'title', 'label': '职位名称', 'type': 'text'},
                   {'field': 'department', 'label': '所属部门', 'type': 'text'},
                   {'field': 'status', 'label': '岗位状态', 'type': 'select',
                    'options': [{'value': '', 'label': '全部'}]
                               + [{'value': key, 'label': value} for key, value in STATUS.items()]}]
    outcome_labels = {'field': 'outcome', 'label': '申请结果', 'value_labels': OUTCOME}
    datasets = [
        {'id': 'recruitment.job', 'object_id': 'recruitment.job', 'name': '岗位',
         'query': 'shangshu_recruitment.domain.query', 'roles': ROLES, 'columns': columns,
         'collection_actions': ['recruitment.job.save'],
         'filters': job_filters},
        {'id': 'recruitment.application', 'object_id': 'recruitment.application', 'name': '招聘申请',
         'query': 'shangshu_recruitment.domain.query', 'roles': ROLES,
         'columns': [{'field': 'job', 'label': '岗位'}, {'field': 'candidate', 'label': '候选人'},
                     outcome_labels, {'field': 'primary_resume', 'label': '主简历'}],
         'collection_actions': ['recruitment.application.intake'],
         'filters': [{'field': 'job', 'label': '岗位', 'type': 'text'},
                     {'field': 'outcome', 'label': '申请结果', 'type': 'select',
                      'options': [{'value': '', 'label': '全部'}]
                                 + [{'value': key, 'label': value} for key, value in OUTCOME.items()]}]},
        {'id': 'recruitment.intake', 'object_id': 'recruitment.intake', 'name': '简历收件',
         'query': 'shangshu_recruitment.domain.query', 'roles': ROLES,
         'columns': [{'field': 'source_type', 'label': '来源', 'value_labels': INTAKE_SOURCE},
                     {'field': 'status', 'label': '状态', 'value_labels': INTAKE_STATUS},
                     {'field': 'matched_job', 'label': '匹配岗位'},
                     {'field': 'candidate', 'label': '候选人'}],
         'collection_actions': [], 'filters': [
             {'field': 'source_type', 'label': '来源', 'type': 'select',
              'options': [{'value': '', 'label': '全部'}]
                         + [{'value': key, 'label': value} for key, value in INTAKE_SOURCE.items()]},
             {'field': 'status', 'label': '状态', 'type': 'select',
              'options': [{'value': '', 'label': '全部'}]
                         + [{'value': key, 'label': value} for key, value in INTAKE_STATUS.items()]}]},
        {'id': 'recruitment.candidate', 'object_id': 'recruitment.candidate', 'name': '候选人',
         'query': 'shangshu_recruitment.domain.query', 'roles': ROLES,
         'columns': [{'field': 'display_name', 'label': '展示名'},
                     {'field': 'source', 'label': '来源', 'value_labels': CANDIDATE_SOURCE}],
         'collection_actions': [], 'filters': []},
    ]
    for key, title, _, fields in workbench_objects:
        datasets.append({'id': 'recruitment.' + key, 'object_id': 'recruitment.' + key, 'name': title,
                         'query': 'shangshu_recruitment.domain.query', 'roles': ROLES,
                         'columns': [{'field': 'name', 'label': '编号'}, {'field': 'job', 'label': '岗位'}]
                                    + [{'field': f, 'label': label} for f, label, _ in fields[:5]],
                         'collection_actions': [], 'filters': [{'field': 'job', 'label': '岗位', 'type': 'text'}]})
    return {'id': DOMAIN, 'name': '招聘', 'owner_app': 'shangshu_recruitment', 'version': '0.2.0',
            'platform_api': '>=1.0 <2.0', 'default_enabled': True,
            'applications': [{'id': DOMAIN + '.management', 'title': '招聘管理', 'icon': '聘', 'roles': ROLES,
                              'home': 'generated.overview', 'processes_ids': [PROCESS_ID]}],
            'objects': objects,
            'datasets': datasets,
            'actions': [{'id': action, 'handler': HANDLER,
                         'replay_guard': 'shangshu_recruitment.service.replay_guard'}
                        for action, _, _, _ in ACTIONS],
            # AI 只能提案 jd.save；publish/open/screening 等不进 tools（服务端同样只认 jd.save）。
            'tools': [{'id': 'recruitment.jd.save'}],
            # 流程定义走 install 的 register_domain_process_definition（已存在不覆盖）。
            'processes': [], 'roles': [], 'services': [
                {'id': 'recruitment.workspace', 'handler': 'shangshu_recruitment.workbench.workspace',
                 'roles': ROLES, 'effect': 'read', 'input_schema': {'type': 'object', 'properties': {'job': {'type': 'string', 'minLength': 1}}, 'required': ['job'], 'additionalProperties': False},
                 'output_schema': {'type': 'object'}},
                {'id': 'recruitment.evidence.context', 'handler': 'shangshu_recruitment.workbench.context_service',
                 'roles': ROLES, 'effect': 'read', 'input_schema': {'type': 'object', 'properties': {'application': {'type': 'string', 'minLength': 1}}, 'required': ['application'], 'additionalProperties': False},
                 'output_schema': {'type': 'object'}},
                {'id': 'recruitment.review.detail', 'handler': 'shangshu_recruitment.workbench.detail',
                 'roles': ROLES, 'effect': 'read', 'input_schema': {'type': 'object', 'properties': {'record': {'type': 'string', 'minLength': 1}}, 'required': ['record'], 'additionalProperties': False},
                 'output_schema': {'type': 'object'}},
            ], 'events': [], 'subscriptions': [],
            'navigation': [], 'pages': [], 'workbench': []}


def query(dataset_id, filters=None, page=1, page_length=30):
    return query_object_records(dataset_id, filters, page, page_length)
