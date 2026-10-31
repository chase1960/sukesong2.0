import re

DOMAIN = 'com.shangshu.recruitment'
ROLES = ['Recruitment Admin', 'Recruiter', 'Hiring Manager']
# 系统角色不进管理端应用角色：只授予同步/解析写回，不给人用登录界面。
SYSTEM_ROLES = ['Recruitment System User']


def text(title, maximum=140):
    return {'type': 'string', 'title': title, 'minLength': 1, 'maxLength': maximum}


def schema(properties, required):
    return {'type': 'object', 'properties': properties, 'required': required,
            'additionalProperties': False}


def reference(name_label):
    return {'name': text(name_label), 'revision': {
        'type': 'integer', 'title': '修订', 'minimum': 1}}


def contact_key(email=None, phone=None):
    """候选人归一化匹配键：邮箱优先，其次电话数字。仅存业务库，不进日志与 AI 上下文。"""
    email = (email or '').strip().lower()
    if email:
        return 'email:' + email
    digits = re.sub(r'\D', '', (phone or ''))
    if len(digits) > 11:
        digits = digits[-11:]
    if len(digits) >= 7:
        return 'phone:' + digits
    return ''
