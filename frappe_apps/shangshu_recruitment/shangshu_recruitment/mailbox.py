import frappe

from shangshu_core.public_api import get_request_context
from shangshu_recruitment.common import SYSTEM_ROLES, schema, text
from shangshu_recruitment.job import _access_context

MAILBOX_DOCTYPE = 'Shangshu Recruitment Mailbox'
ADMIN_ROLES = {'Recruitment Admin', 'System Manager'}

# 绑定动作：创建路径收 mailbox_id + sync_user；既有绑定只接受 enabled 开关。
# 换箱/换账号必须新建绑定（旧绑定停用留审计）——来源身份不能漂移。
MAILBOX_ACTIONS = [
    ('recruitment.mailbox.save', '绑定或停用招聘收件邮箱', ['Recruitment Admin'],
     schema({
         'mailbox': text('邮箱绑定编号'),
         'revision': {'type': 'integer', 'title': '修订', 'minimum': 1},
         'mailbox_id': text('共享邮箱标识', 200),
         'sync_user': text('同步账号'),
         'enabled': {'type': 'boolean', 'title': '是否启用'},
     }, [])),
]


def execute_mailbox(action_id, payload):
    if action_id != 'recruitment.mailbox.save':
        frappe.throw('RECRUITMENT_UNKNOWN_ACTION', frappe.ValidationError)
    ctx = get_request_context()
    if payload.get('mailbox'):
        return _save_existing(payload, ctx)
    return _create(payload, ctx)


def _create(payload, ctx):
    mailbox_id = (payload.get('mailbox_id') or '').strip()
    sync_user = (payload.get('sync_user') or '').strip()
    if not mailbox_id or not sync_user:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 新建绑定必须提供共享邮箱标识与同步账号',
                     frappe.ValidationError)
    # 共享邮箱由人在邮件域配好并授权同步账号读信；招聘域只记标识，凭据不出邮件域。
    _require_sync_user(sync_user)
    if frappe.db.exists(MAILBOX_DOCTYPE, {'enterprise_id': ctx['enterprise_id'],
                                          'mailbox_id': mailbox_id}):
        frappe.throw('RECRUITMENT_DUPLICATE_MAILBOX: 该共享邮箱已绑定', frappe.ValidationError)
    doc = frappe.get_doc({'doctype': MAILBOX_DOCTYPE,
                          'enterprise_id': ctx['enterprise_id'],
                          'mailbox_id': mailbox_id[:200],
                          'sync_user': sync_user[:140],
                          'enabled': 1 if payload.get('enabled', True) else 0,
                          'revision': 1})
    doc.insert(ignore_permissions=True)
    return _summary(doc)


def _save_existing(payload, ctx):
    doc = frappe.get_doc(MAILBOX_DOCTYPE, payload['mailbox'], for_update=True)
    if doc.enterprise_id != ctx['enterprise_id']:
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 无权修改其他企业的邮箱绑定', frappe.PermissionError)
    if doc.revision != payload.get('revision'):
        frappe.throw('RECRUITMENT_REVISION_CONFLICT: 邮箱绑定已被更新，请刷新后重试', frappe.ValidationError)
    if 'enabled' not in payload:
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 绑定创建后只允许停用或启用', frappe.ValidationError)
    doc.enabled = 1 if payload.get('enabled') else 0
    doc.revision += 1
    doc.save(ignore_permissions=True)
    return _summary(doc)


def _require_sync_user(sync_user):
    """同步账号必须是专职系统身份（Recruitment System User），与人工招聘角色隔离。

    前提（部署方准备，不在本域内复制）：该账号已在邮件域对共享邮箱具备 read
    权限并已签发 business identity；本域只校验角色形态。
    """
    if not frappe.db.exists('User', sync_user):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 同步账号不存在', frappe.ValidationError)
    if not set(frappe.get_roles(sync_user)) & set(SYSTEM_ROLES):
        frappe.throw('RECRUITMENT_INVALID_PAYLOAD: 同步账号必须具备 Recruitment System User 角色',
                     frappe.ValidationError)


def _summary(doc):
    return {'mailbox': doc.name, 'mailbox_id': doc.mailbox_id, 'sync_user': doc.sync_user,
            'enabled': bool(doc.enabled), 'revision': doc.revision}


def mailbox_permission(doc, user=None, permission_type=None):
    """邮箱绑定只对招聘管理员可见；停用的绑定保留审计，不删。"""
    if permission_type not in (None, 'read', 'select', 'write', 'update'):
        return False
    ctx = _access_context(user)
    if not set(ctx['roles']) & ADMIN_ROLES:
        return False
    return doc is None or doc.enterprise_id == ctx['enterprise_id']


def mailbox_permission_query(user=None):
    ctx = _access_context(user)
    if not set(ctx['roles']) & ADMIN_ROLES:
        return '1=0'
    return 'enterprise_id=' + frappe.db.escape(ctx['enterprise_id'])
