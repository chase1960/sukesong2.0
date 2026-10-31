"""应用与对象设计共用的内部守卫；不是业务 App 公共接口。"""
import hashlib
import json

import frappe

from shangshu_core.identity import get_identity


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def content_hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def require_designer():
    identity = get_identity()
    from shangshu_core import business_access
    if not business_access.is_open() and "System Manager" not in frappe.get_roles():
        frappe.throw("需要应用设计权限", frappe.PermissionError)
    return identity


def require_application(application_id, identity, lock=False):
    if lock == 'shared':
        rows = frappe.db.sql('SELECT * FROM `tabShangshu Application Definition` '
                            'WHERE name=%s LOCK IN SHARE MODE', (application_id,), as_dict=True)
        if not rows:
            frappe.throw('应用不存在', frappe.DoesNotExistError)
        doc = frappe.get_doc({'doctype': 'Shangshu Application Definition', **dict(rows[0])})
        doc.set('__islocal', False)
    else:
        doc = frappe.get_doc("Shangshu Application Definition", application_id, for_update=lock)
    if doc.enterprise_id != identity.enterprise_id:
        frappe.throw("当前企业无权访问该应用", frappe.PermissionError)
    return doc


def lock_lifecycle():
    # 与域启停使用同一锁顺序，不能分别检查后并发改变依赖。
    from shangshu_core.domains import DOMAIN_DOCTYPE, CORE_DOMAIN_ID
    frappe.db.get_value(DOMAIN_DOCTYPE, CORE_DOMAIN_ID, "name", for_update=True)
