import json
import math
import re

import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.common import reference, schema, text
from shangshu_recruitment.job import locked_job, require_revision

JD_DOCTYPE = 'Shangshu Recruitment JD Revision'
RUBRIC_DOCTYPE = 'Shangshu Recruitment Screening Rubric'
REVISION_REFERENCE = {
    'revision_document': text('版本记录编号'),
    'revision': reference('版本')['revision'],
}
JSON_ARRAY = {'type': ['array', 'string'], 'title': '条件列表',
              'items': {'type': 'string', 'minLength': 1, 'maxLength': 500}, 'maxItems': 100}
JSON_WEIGHTS = {'type': ['object', 'string'], 'title': '筛选权重',
                'additionalProperties': {'type': 'number', 'minimum': 0}}
JD_EDIT_FIELDS = {
    'content': {'type': 'string', 'title': 'JD 正文', 'minLength': 1, 'maxLength': 50000,
                'multiline': True},
    'source': {'type': 'string', 'title': '来源', 'enum': ['manual', 'ai_assisted'],
               'enumNames': ['人工撰写', 'AI 辅助']},
    'model_name': text('模型名'),
    'model_version': text('模型版本'),
}
RUBRIC_EDIT_FIELDS = {
    'required_criteria': {**JSON_ARRAY, 'title': '必要条件'},
    'preferred_criteria': {**JSON_ARRAY, 'title': '加分条件'},
    'weights': JSON_WEIGHTS,
    'disallowed_criteria': {**JSON_ARRAY, 'title': '禁用条件'},
}
REVISION_ACTIONS = [
    ('recruitment.jd.save', '保存 JD 版本', ['Recruitment Admin', 'Recruiter'],
     schema({**REVISION_REFERENCE, 'job': text('岗位编号'), **JD_EDIT_FIELDS}, [])),
    ('recruitment.jd.publish', '发布 JD 版本', ['Recruitment Admin', 'Recruiter'],
     schema(REVISION_REFERENCE, list(REVISION_REFERENCE))),
    ('recruitment.rubric.save', '保存筛选标准版本', ['Recruitment Admin', 'Recruiter'],
     schema({**REVISION_REFERENCE, 'job': text('岗位编号'), **RUBRIC_EDIT_FIELDS}, [])),
    ('recruitment.rubric.publish', '发布筛选标准版本', ['Recruitment Admin', 'Recruiter'],
     schema(REVISION_REFERENCE, list(REVISION_REFERENCE))),
]

DISALLOWED_CRITERIA = (
    'gender', 'sex', 'ethnicity', 'race', 'religion', 'marital_status', 'pregnancy',
    'photo', 'name', 'email', 'phone',
)
_DISALLOWED_PATTERN = re.compile(
    r'(?<![a-z0-9])(?:' + '|'.join(DISALLOWED_CRITERIA) + r')(?![a-z0-9])', re.IGNORECASE)
_DISALLOWED_CHINESE = ('性别', '民族', '种族', '宗教', '婚姻', '婚育', '怀孕', '照片', '姓名', '邮箱', '电话')


def _invalid(message):
    frappe.throw('RECRUITMENT_INVALID_RUBRIC: ' + message, frappe.ValidationError)


def _json_value(value, expected, field):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            _invalid(field + ' 必须是合法 JSON')
    if not isinstance(value, expected):
        _invalid(field + ' 的 JSON 类型不正确')
    return value


def _string_list(value, field):
    items = _json_value(value, list, field)
    if len(items) > 100:
        _invalid(field + ' 最多 100 项')
    result = []
    for item in items:
        if not isinstance(item, str) or not item.strip() or len(item.strip()) > 500:
            _invalid(field + ' 必须是非空文本列表')
        item = item.strip()
        if item in result:
            _invalid(field + ' 不能包含重复项')
        result.append(item)
    return result


def _criteria(value, field):
    result = _string_list(value, field)
    if any(_disallowed(item) for item in result):
        frappe.throw('RECRUITMENT_DISALLOWED_CRITERION: 筛选条件包含受保护或无关属性',
                     frappe.ValidationError)
    return result


def _disallowed(value):
    return bool(_DISALLOWED_PATTERN.search(value)) or any(term in value for term in _DISALLOWED_CHINESE)


def _weights(value, required, preferred):
    def invalid(message):
        frappe.throw('RECRUITMENT_INVALID_WEIGHTS: ' + message, frappe.ValidationError)

    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            invalid('weights 必须是合法 JSON 对象')
    if not isinstance(value, dict):
        invalid('weights 必须是对象')
    if len(value) > 100:
        invalid('最多 100 项')
    weights = value
    allowed = set(required + preferred)
    result = {}
    total = 0.0
    for key, weight in weights.items():
        if not isinstance(key, str) or not key.strip():
            invalid('键必须是非空文本')
        key = key.strip()
        if key in result:
            invalid('规范化后不能有重复键')
        if key not in allowed:
            invalid('键必须出现在 required_criteria 或 preferred_criteria 中')
        if _disallowed(key):
            frappe.throw('RECRUITMENT_DISALLOWED_CRITERION: 筛选权重包含受保护或无关属性',
                         frappe.ValidationError)
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight < 0:
            invalid('值必须是有限非负数')
        result[key] = weight
        total += weight
    if not math.isfinite(total) or total <= 0:
        invalid('总和必须大于 0')
    return result


def _rubric_values(payload):
    required = _criteria(payload['required_criteria'], 'required_criteria')
    preferred = _criteria(payload['preferred_criteria'], 'preferred_criteria')
    weights = _weights(payload['weights'], required, preferred)
    disallowed = _string_list(payload.get('disallowed_criteria', []), 'disallowed_criteria')
    return {'required_criteria': _canonical(required), 'preferred_criteria': _canonical(preferred),
            'weights': _canonical(weights), 'disallowed_criteria': _canonical(disallowed)}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _locked_revision(doctype, name, enterprise_id):
    doc = frappe.get_doc(doctype, name, for_update=True)
    if doc.enterprise_id != enterprise_id:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权处理其他企业版本', frappe.PermissionError)
    return doc


def execute_revision(action_id, payload):
    ctx = get_request_context()
    if action_id.startswith('recruitment.jd.'):
        doctype, edit_fields = JD_DOCTYPE, JD_EDIT_FIELDS
    elif action_id.startswith('recruitment.rubric.'):
        doctype, edit_fields = RUBRIC_DOCTYPE, RUBRIC_EDIT_FIELDS
    else:
        frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)

    if action_id.endswith('.publish'):
        doc = _locked_revision(doctype, payload['revision_document'], ctx['enterprise_id'])
        require_revision(doc, payload['revision'])
        if doc.status != 'draft':
            frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 只有草稿版本可以发布', frappe.ValidationError)
        doc.status = 'published'
        doc.published_by = ctx['user_name']
        doc.published_at = frappe.utils.now_datetime()
        doc.revision += 1
        doc.save(ignore_permissions=True)
        return _receipt(doc)

    creating = not payload.get('revision_document')
    if creating:
        required_fields = ('job', 'content', 'source') if doctype == JD_DOCTYPE else (
            'job', 'required_criteria', 'preferred_criteria', 'weights')
        missing = [key for key in required_fields if key not in payload]
        if missing:
            frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 新版本缺少字段 ' + missing[0], frappe.ValidationError)
        job = locked_job(payload['job'], ctx['enterprise_id'])
        values = ({key: payload.get(key, '') for key in edit_fields} if doctype == JD_DOCTYPE
                  else _rubric_values(payload))
        version_no = frappe.db.count(doctype, {'enterprise_id': ctx['enterprise_id'], 'job': job.name}) + 1
        doc = frappe.get_doc({'doctype': doctype, **values, 'enterprise_id': ctx['enterprise_id'],
                              'job': job.name, 'version_no': version_no, 'status': 'draft',
                              'published_by': '', 'published_at': None, 'revision': 1})
        doc.insert(ignore_permissions=True)
        return _receipt(doc)

    doc = _locked_revision(doctype, payload['revision_document'], ctx['enterprise_id'])
    require_revision(doc, payload['revision'])
    if doc.status != 'draft':
        frappe.throw('RECRUITMENT_REVISION_IMMUTABLE: 已发布或退役版本不可修改', frappe.ValidationError)
    if payload.get('job') and payload['job'] != doc.job:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 版本不得转移到其他岗位', frappe.ValidationError)
    if not any(key in payload for key in edit_fields):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 至少修改一个版本字段', frappe.ValidationError)
    if doctype == JD_DOCTYPE:
        doc.update({key: payload[key] for key in edit_fields if key in payload})
    else:
        merged = {key: payload.get(key, getattr(doc, key)) for key in RUBRIC_EDIT_FIELDS}
        doc.update(_rubric_values(merged))
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return _receipt(doc)


def _receipt(doc):
    return {'revision_document': doc.name, 'job': doc.job, 'version_no': doc.version_no,
            'status': doc.status, 'document_revision': doc.revision}


def published_revision_exists(doctype, job):
    if doctype not in (JD_DOCTYPE, RUBRIC_DOCTYPE):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 未知版本类型', frappe.ValidationError)
    ctx = get_request_context()
    return bool(frappe.db.exists(doctype, {'enterprise_id': ctx['enterprise_id'], 'job': job,
                                           'status': 'published'}))


def latest_published(doctype, job):
    if doctype not in (JD_DOCTYPE, RUBRIC_DOCTYPE):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 未知版本类型', frappe.ValidationError)
    ctx = get_request_context()
    return frappe.db.get_value(doctype, {'enterprise_id': ctx['enterprise_id'], 'job': job,
                                         'status': 'published'}, 'name', order_by='version_no desc') or ''


def require_published_revisions(job):
    if not (published_revision_exists(JD_DOCTYPE, job)
            and published_revision_exists(RUBRIC_DOCTYPE, job)):
        frappe.throw('RECRUITMENT_JD_OR_RUBRIC_NOT_PUBLISHED: 岗位必须同时具有已发布 JD 和筛选标准',
                     frappe.ValidationError)
