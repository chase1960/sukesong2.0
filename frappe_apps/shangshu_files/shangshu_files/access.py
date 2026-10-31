"""目录可见范围：祖先取交集，文件读写共用；不复制平台人员和角色事实。"""
import json

import frappe
from frappe.utils import get_datetime
from shangshu_core.public_api import get_identity, list_collaboration_people, business_access
from shangshu_files.directories import DOCTYPE, ROOT, _require_manager, lock_tree


def _values(raw):
    try:
        values = json.loads(raw or '[]')
        return values if isinstance(values, list) else []
    except (ValueError, TypeError):
        return []


def visible_directories(user=None):
    user = user or frappe.session.user
    if not user or user == 'Guest':
        return set()
    identity = get_identity(user)
    lock_tree()
    # 当前锁定读：不能用取得目录锁前的事务快照放行已撤销的授权。
    rows = frappe.db.sql('SELECT name,parent_directory,access_mode,allowed_identities_json,allowed_groups_json '
                         'FROM `tabShangshu File Directory` LOCK IN SHARE MODE', as_dict=True)
    if business_access.is_open(user) or 'System Manager' in frappe.get_roles(user):
        return {row.name for row in rows}
    # 不跨请求缓存，撤销目录授权或变更协作分组后新请求立即重新判定。
    by_name = {row.name: row for row in rows}
    allowed, denied = set(), set()
    def permits(name, visiting):
        if name in allowed:
            return True
        if name in denied or name not in by_name or name in visiting:
            return False
        row = by_name[name]
        parent_ok = name == ROOT or permits(row.parent_directory, visiting | {name})
        mode = row.access_mode or 'inherit'
        self_ok = mode == 'inherit' or mode == 'restricted' and (
            identity.identity_id in _values(row.allowed_identities_json)
            or bool(identity.collaboration_group) and identity.collaboration_group in _values(row.allowed_groups_json))
        (allowed if parent_ok and self_ok else denied).add(name)
        return parent_ok and self_ok
    for name in by_name:
        permits(name, set())
    return allowed


def can_read(directory, user=None):
    return directory in visible_directories(user)


def query_condition(table, field, user=None):
    names = visible_directories(user)
    if not names:
        return '1=0'
    return f'`tab{table}`.`{field}` in (' + ','.join(frappe.db.escape(name) for name in sorted(names)) + ')'


def permission_query(user=None):
    return query_condition(DOCTYPE, 'name', user)


def has_permission(doc=None, ptype='read', user=None):
    business_access.require_identity(user)
    return doc is None or ptype == 'read' and can_read(doc.name, user)


def configure(payload):
    _require_manager()
    doc = frappe.get_doc(DOCTYPE, payload.get('directory'), for_update=True)
    if get_datetime(payload.get('expected_modified')) != get_datetime(doc.modified):
        frappe.throw('目录已变化，请刷新后核对权限', frappe.ValidationError)
    people = list_collaboration_people()
    identities = payload.get('identities', [])
    groups = payload.get('groups', [])
    if set(identities) - {p['identity_id'] for p in people} or set(groups) - {p['group'] for p in people if p['group']}:
        frappe.throw('所选人员或分组已不可用，请刷新后核对', frappe.ValidationError)
    mode = payload['mode']
    if mode == 'inherit' and (identities or groups):
        frappe.throw('继承父级时不要提交额外授权', frappe.ValidationError)
    doc.access_mode = mode
    doc.allowed_identities_json = json.dumps(sorted(set(identities)), ensure_ascii=False)
    doc.allowed_groups_json = json.dumps(sorted(set(groups)), ensure_ascii=False)
    doc.save(ignore_permissions=True)
    return {'directory': doc.name, 'modified': str(doc.modified), 'mode': mode,
            'identities': identities, 'groups': groups}
