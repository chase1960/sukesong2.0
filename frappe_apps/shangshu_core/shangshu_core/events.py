import copy
import json
import secrets

import frappe
from shangshu_core.domain_execution import domain_execution, resource_execution
from frappe.utils import now_datetime, get_datetime

from shangshu_core.domains import assert_domain_enabled, list_domains, raw_resource
from shangshu_core.identity import get_identity
from shangshu_core.request_binding import assert_request_binding
from shangshu_core.schema_validation import _validate_schema
from shangshu_core import unified_log


SENSITIVE_KEYS = {"password", "pwd", "token", "secret", "api_key", "content_base64", "raw_text"}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _json(value, default=None):
    if value in (None, ""):
        return default if default is not None else {}
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def _assert_no_sensitive(value, path="payload"):
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in SENSITIVE_KEYS:
                frappe.throw(f"事件载荷禁止包含敏感字段：{path}.{key}", frappe.ValidationError)
            _assert_no_sensitive(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _assert_no_sensitive(item, f"{path}[{index}]")


def _assert_roles(resource):
    allowed = set(resource.get("roles") or [])
    roles = set(frappe.get_roles())
    if allowed and "System Manager" not in roles and not allowed.intersection(roles):
        frappe.throw("当前用户无权发布该事件", frappe.PermissionError)


def list_registered_events():
    result = []
    for domain in list_domains(include_disabled=False):
        for event in domain["contribution"].get("events") or []:
            value = copy.deepcopy(event)
            value["domain_id"] = domain["id"]
            result.append(value)
    return result


def _subscriptions(event_id, event_version):
    result = []
    for domain in list_domains(include_disabled=False):
        for item in domain["contribution"].get("subscriptions") or []:
            versions = item.get("versions") or [item.get("event_version") or event_version]
            if item.get("event_id") == event_id and event_version in versions:
                _raw_domain, raw = raw_resource("subscriptions", item.get("id"))
                if raw:
                    result.append((domain, raw))
    return result


def _deliver(envelope, only_failed=False, requested_by=None):
    previous = {item["subscription_id"]: item for item in _json(envelope.deliveries_json, [])}
    deliveries = []
    active = set()
    for domain, subscription in _subscriptions(envelope.event_id, envelope.event_version):
        subscription_id = subscription["id"]
        if previous and subscription_id not in previous:
            continue  # 重试不能把发布之后新增的订阅补入旧事件。
        active.add(subscription_id)
        old = previous.get(subscription_id)
        if only_failed and old and old.get("status") == "Delivered":
            deliveries.append(old)
            continue
        handler = subscription.get("handler")
        row = {
            "subscription_id": subscription_id,
            "domain_id": domain["id"],
            "attempts": int((old or {}).get("attempts") or 0) + 1,
            "requested_by": requested_by or frappe.session.user,
        }
        # 隔离每个消费者的数据库写入；保留其他成功投递与失败审计。
        # handler 不得自行提交事务；外部副作用仍须目标幂等键/对账。
        savepoint = "event_delivery_" + secrets.token_hex(12)
        frappe.db.savepoint(savepoint)
        previous_domain = getattr(frappe.flags, "shangshu_call_domain", None)
        try:
            frappe.flags.shangshu_call_domain = domain["id"]
            if not handler:
                raise frappe.ValidationError("订阅没有公共 handler")
            context = {
                "envelope_id": envelope.name,
                "event_id": envelope.event_id,
                "event_version": envelope.event_version,
                "enterprise_id": envelope.enterprise_id,
                "correlation_id": envelope.correlation_id,
                "delivery_key": f"{envelope.name}:{subscription_id}",
            }
            with domain_execution(domain['id']):
                result = frappe.get_attr(handler)(_json(envelope.payload_json, {}), context)
            row.update({"status": "Delivered", "result": result or {}})
        except Exception as error:
            frappe.db.rollback(save_point=savepoint)
            row.update({"status": "Failed", "error": str(error)[:500]})
        finally:
            frappe.flags.shangshu_call_domain = previous_domain
        deliveries.append(row)
    # 订阅升级或停用后仍保留已经形成的投递审计，不能改写历史信封。
    for subscription_id, old in previous.items():
        if subscription_id not in active:
            deliveries.append(old)
    envelope.deliveries_json = _canonical(deliveries)
    envelope.last_attempt_at = now_datetime()
    failed = [row for row in deliveries if row["status"] != "Delivered"]
    if not deliveries:
        envelope.status = "Delivered"
    elif len(failed) == len(deliveries):
        envelope.status = "Failed"
    elif failed:
        envelope.status = "Partial"
    else:
        envelope.status = "Delivered"
    envelope.save(ignore_permissions=True)
    _log_delivery(envelope, deliveries)
    return envelope


def _log_delivery(envelope, deliveries):
    """**统一日志库**（PKG-020-T01）：投递结论落一行痕迹。

    信封是**活队列**（重试要靠它、业务判断结论也住在它里面）⇒ 它继续存在；
    统一日志这里只留「谁在什么时候把这条事件送到了谁、成没成、为什么失败」的痕迹，
    **不抄**业务判断值（载荷与结论仍只在信封那一份）。
    """
    status = envelope.status
    result = {"Delivered": "Succeeded", "Failed": "Failed"}.get(status, "Delivering")
    unified_log.write_log(
        kind="event", what_id=envelope.event_id, domain_id=envelope.owner_domain,
        actor_user=frappe.session.user, actor_identity=unified_log.current_actor_identity(),
        trigger_source="system", result=result,
        business_object_id=envelope.get("business_object_id"), business_name=envelope.get("business_name"),
        idempotency_key="%s:delivery:%s" % (envelope.idempotency_key, envelope.last_attempt_at),
        source_doctype="Shangshu Event Envelope", source_name=envelope.name,
        detail={
            "event_id": envelope.event_id,
            "event_version": envelope.event_version,
            "envelope": envelope.name,
            "status": status,
            "deliveries": [{"subscription_id": row.get("subscription_id"),
                             "domain_id": row.get("domain_id"),
                             "status": row.get("status"),
                             "attempts": row.get("attempts"),
                             "error": row.get("error")} for row in deliveries],
            "note": "投递结论（不含业务判断值：载荷与结论仍只在信封那一份）",
        })


def _public(envelope):
    return {
        "id": envelope.name,
        "event_id": envelope.event_id,
        "event_version": envelope.event_version,
        "owner_domain": envelope.owner_domain,
        "enterprise_id": envelope.enterprise_id,
        "correlation_id": envelope.correlation_id,
        "status": envelope.status,
        "deliveries": _json(envelope.deliveries_json, []),
        "published_at": envelope.published_at,
        "last_attempt_at": envelope.last_attempt_at,
    }


@resource_execution('events', 'event_id')
def publish_event(event_id, payload=None, idempotency_key=None, correlation_id=None,
                  business_object_id=None, business_name=None):
    """发布一个事件。

    `business_object_id` / `business_name`（2026-10-22 新增）：
    把这个事件**挂到某条受管记录上**（与流程那个 `business_object_id` 同款思路）——
    没有它，日志块**按案件看**就无从谈起（只能看全局流水）。
    只记「这件事跟哪条受管记录有关」，**不把业务值抄一份到信封里**。
    """
    domain, resource = raw_resource("events", event_id)
    if not domain or not resource:
        frappe.throw("事件未注册", frappe.DoesNotExistError)
    assert_domain_enabled(domain["id"])
    _assert_roles(resource)
    value = payload or {}
    _assert_no_sensitive(value)
    _validate_schema(value, resource.get("payload_schema") or {})
    key = str(idempotency_key or secrets.token_hex(24))
    business_object_id = str(business_object_id or "").strip()
    business_name = str(business_name or "").strip()
    existing = frappe.db.get_value("Shangshu Event Envelope", {"idempotency_key": key}, "name")
    identity = get_identity()
    if existing:
        envelope = frappe.get_doc("Shangshu Event Envelope", existing)
        assert_request_binding(
            envelope, identity, resource_field="event_id", resource_id=event_id,
            version_field="event_version", version=resource.get("version") or "1.0.0",
            payload=value, correlation_id=correlation_id or None,
        )
        # 幂等命中：**业务挂载只能补上，不能改**（同一件事有两种说法是不行的）。
        if business_object_id and not envelope.get("business_object_id"):
            envelope.business_object_id = business_object_id
            envelope.business_name = business_name
            envelope.save(ignore_permissions=True)
        return _public(envelope) | {"idempotent": True}
    envelope = frappe.get_doc(
        {
            "doctype": "Shangshu Event Envelope",
            "event_id": event_id,
            "event_version": resource.get("version") or "1.0.0",
            "owner_domain": domain["id"],
            "actor_identity": identity.name,
            "actor_user": frappe.session.user,
            "enterprise_id": identity.enterprise_id,
            "payload_json": _canonical(value),
            "idempotency_key": key,
            "correlation_id": str(correlation_id or frappe.generate_hash(length=24)),
            "status": "Published",
            "business_object_id": business_object_id,
            "business_name": business_name,
            "deliveries_json": _canonical([{"subscription_id": sub["id"], "domain_id": owner["id"],
                                             "status": "Pending", "attempts": 0}
                                            for owner, sub in _subscriptions(event_id, resource.get("version") or "1.0.0")]),
            "published_at": now_datetime(),
        }
    ).insert(ignore_permissions=True)
    # **统一日志库**（PKG-020-T01）：事件发出这一行痕迹落统一表。
    # 信封本身是活队列（重试与业务判断结论都住在它里面）⇒ 继续存在；
    # 统一日志只留痕迹，不抄载荷与判断值。
    unified_log.write_log(
        kind="event", what_id=event_id, domain_id=domain["id"],
        actor_user=frappe.session.user, actor_identity=identity.name,
        trigger_source="user", result="Delivering",
        business_object_id=business_object_id, business_name=business_name,
        idempotency_key=key,
        source_doctype="Shangshu Event Envelope", source_name=envelope.name,
        detail={
            "event_id": event_id,
            "event_version": resource.get("version") or "1.0.0",
            "owner_domain": domain["id"],
            "correlation_id": envelope.correlation_id,
            "envelope": envelope.name,
            "subscriptions": [{"subscription_id": item["id"], "domain_id": owner["id"], "status": "Pending"}
                              for owner, item in _subscriptions(event_id, resource.get("version") or "1.0.0")],
            "payload_fields": sorted(value.keys()) if isinstance(value, dict) else [],
            "note": "事件载荷与业务判断结论住在信封（活队列），这里只留痕迹",
        })
    # 外部副作用声明 after_commit：信封与发布方事务一起落库，由调度器扫描。
    # 旧同步消费者保持库内事务语义，不在这里擅自 commit。
    if not _json(envelope.deliveries_json, []):
        envelope.status = "Delivered"
        envelope.save(ignore_permissions=True)
    elif resource.get("delivery") != "after_commit":
        _deliver(envelope)
    return _public(envelope) | {"idempotent": False}


def retry_event_delivery(envelope_id):
    if "System Manager" not in frappe.get_roles():
        frappe.throw("只有系统管理员可以重试事件投递", frappe.PermissionError)
    envelope = frappe.get_doc("Shangshu Event Envelope", envelope_id, for_update=True)
    if envelope.status not in ("Published", "Failed", "Partial"):
        return _public(envelope) | {"retried": False}
    caller = frappe.session.user
    try:
        if not frappe.db.get_value("User", envelope.actor_user, "enabled"):
            frappe.throw("发布用户已停用，需人工处理事件", frappe.PermissionError)
        frappe.set_user(envelope.actor_user)
        if get_identity().enterprise_id != envelope.enterprise_id:
            frappe.throw("发布用户企业已变化，禁止跨企业重试", frappe.PermissionError)
        assert_domain_enabled(envelope.owner_domain)
        _deliver(envelope, only_failed=True, requested_by=caller)
    finally:
        frappe.set_user(caller)
    return _public(envelope) | {"retried": True}


def recover_event_deliveries():
    """Frappe scheduler 入口：只扫已提交信封，单条事务，最多自动尝试五次。"""
    caller = frappe.session.user
    frappe.set_user("Administrator")
    try:
        # 游标翻页，达到人工处理阈值的旧事件不能饿死后面的新事件。
        def candidates():
            cursor = ""
            while True:
                rows = frappe.get_all("Shangshu Event Envelope", filters={"name": [">", cursor], "status": ["in", ["Published", "Failed", "Partial"]]},
                                      fields=["name", "deliveries_json", "last_attempt_at"], order_by="name asc", limit_page_length=100)
                if not rows:
                    return
                yield from rows
                cursor = rows[-1].name
        attempted = 0
        for row in candidates():
            deliveries = _json(row.deliveries_json, [])
            if any(int(item.get("attempts") or 0) >= 5 for item in deliveries if item.get("status") != "Delivered"):
                continue
            if row.last_attempt_at and (now_datetime() - get_datetime(row.last_attempt_at)).total_seconds() < 60:
                continue
            attempted += 1
            try:
                retry_event_delivery(row.name)
                frappe.db.commit()
            except Exception as error:
                frappe.db.rollback()
                # 身份失效等投递前错误同样计入失败次数，避免毒事件无限抢占扫描配额。
                envelope = frappe.get_doc("Shangshu Event Envelope", row.name, for_update=True)
                if envelope.status in ("Published", "Failed", "Partial"):
                    deliveries = _json(envelope.deliveries_json, [])
                    for item in deliveries:
                        if item.get("status") != "Delivered":
                            item.update(status="Failed", attempts=int(item.get("attempts") or 0) + 1,
                                        error=str(error)[:500], requested_by="Administrator")
                    envelope.deliveries_json = _canonical(deliveries)
                    envelope.last_attempt_at = now_datetime()
                    envelope.status = "Partial" if any(item.get("status") == "Delivered" for item in deliveries) else "Failed"
                    envelope.save(ignore_permissions=True)
                    frappe.db.commit()
                frappe.log_error(title="事件恢复失败", message=frappe.get_traceback())
            if attempted >= 100:
                break
    finally:
        frappe.set_user(caller)
