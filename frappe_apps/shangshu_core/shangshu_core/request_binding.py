"""重复请求必须绑定主体及完整内容；不以幂等键代替授权。"""

import json

import frappe


def assert_request_binding(doc, identity, *, resource_field, resource_id,
                           version_field, version, payload, correlation_id=None):
    """适用于仍保存完整 payload_json 的提案与事件，不适用于审计摘要。"""
    matches = (
        doc.actor_identity == identity.name
        and doc.enterprise_id == identity.enterprise_id
        and getattr(doc, resource_field) == resource_id
        and getattr(doc, version_field) == version
    )
    try:
        # 用 JSON 文本比较保持 bool/number 等类型区别，且不受对象键顺序影响。
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"),
                                             ensure_ascii=False, allow_nan=False)
        matches = matches and canonical(json.loads(doc.payload_json)) == canonical(payload)
    except (ValueError, TypeError):
        matches = False
    if correlation_id is not None:
        matches = matches and doc.correlation_id == str(correlation_id)
    if not matches:
        frappe.throw("幂等键已被不同请求使用，请检查请求内容", frappe.DuplicateEntryError)
