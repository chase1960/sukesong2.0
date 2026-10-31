"""服务端签发的动作会话凭据；只定位，不授予任何业务或日志权限。"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from contextlib import contextmanager
import frappe
from shangshu_core.identity import get_identity


def _secret():
    key = frappe.conf.get("encryption_key")
    if not key:
        frappe.throw("站点未配置会话签发密钥", frappe.ValidationError)
    return str(key).encode()


def _signature(body):
    return hmac.new(_secret(), b"shangshu-conversation-v1\0" + body.encode("ascii"), hashlib.sha256).hexdigest()


def issue_conversation():
    identity = get_identity()
    claims = {"key": "CONV-" + secrets.token_hex(24), "actor": identity.name,
              "enterprise": identity.enterprise_id, "expires": int(time.time()) + 86400}
    body = base64.urlsafe_b64encode(json.dumps(claims, sort_keys=True).encode()).decode()
    signature = _signature(body)
    return {"conversation_key": claims["key"], "credential": body + "." + signature,
            "expires_at": claims["expires"]}


def verify_conversation(credential):
    identity = get_identity()
    try:
        if not isinstance(credential, str) or len(credential) > 2048:
            raise ValueError()
        body, signature = credential.split(".")
        expected = _signature(body)
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(body))
        if (claims["actor"] != identity.name or claims["enterprise"] != identity.enterprise_id
                or claims["expires"] <= time.time()):
            raise ValueError()
        return claims["key"]
    except (ValueError, KeyError, TypeError):
        frappe.throw("会话凭据无效、过期或不属于当前身份", frappe.PermissionError)


@contextmanager
def conversation_scope(credential=None):
    previous = getattr(frappe.flags, "shangshu_conversation_key", None)
    key = verify_conversation(credential) if credential is not None else previous
    frappe.flags.shangshu_conversation_key = key
    try:
        yield key
    finally:
        frappe.flags.shangshu_conversation_key = previous


def current_conversation_key():
    # 延后确认从服务器保存的提案恢复；不接受确认请求自报会话覆盖原提案。
    proposal_id = getattr(frappe.flags, "shangshu_resolving_proposal", None)
    if proposal_id:
        return getattr(frappe.flags, "shangshu_resolving_conversation_key", None) or ""
    return getattr(frappe.flags, "shangshu_conversation_key", None) or ""
