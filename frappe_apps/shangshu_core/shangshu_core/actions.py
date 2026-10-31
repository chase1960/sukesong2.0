import inspect
import json
import re
import secrets
import time

import frappe
from frappe.utils import now_datetime

from shangshu_core.domains import assert_domain_enabled, platform_contributions, raw_resource
from shangshu_core.identity import get_identity
from shangshu_core.request_binding import assert_request_binding
from shangshu_core import action_requests
from shangshu_core.schema_validation import _validate_schema
from shangshu_core.domain_execution import resource_execution
from shangshu_core.replay_guard import invoke_replay_guard
from shangshu_core import unified_log, business_access, request_cache


def _assert_payload_matches_schema(value, schema, action_id, path="payload"):
    """**载荷与动作声明对不上 ⇒ 一律中文**（2026-10-29）。

    ⚠️ **为什么要有这一件**（用户原话：「新核心报『payload 有未声明字段』时
    抛**英文 TypeError** ⇒ 要中文错」）：
      校验器本身已经收紧了形状（`schema_validation._shape_gate`），
      但**将来又长出一种没见过的形状**时，裸 `TypeError` 会漏出去
      ⇒ HTTP 500 ＋ 英文栈 ⇒ 人看到的是「服务器坏了」，不是「你带的字段不对」。
    ⇒ 这里**兜一层**：任何不是 `ValidationError` 的异常 ⇒ 一律收成中文 417，
      并且**说清是哪个动作、哪一处**。
    """
    try:
        _validate_schema(value, schema, path)
    except frappe.ValidationError:
        raise
    except Exception as error:
        frappe.throw(
            "动作「%s」的%s与动作声明对不上，请核对本次要带的字段（%s）"
            % (action_id, path, error),
            frappe.ValidationError)


SENSITIVE_KEYS = {"password", "pwd", "token", "secret", "api_key", "content_base64", "raw_text"}
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def _json(value, default=None):
    if value in (None, ""):
        return default if default is not None else {}
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _trim_result_summary(summary, record_change):
    """结果摘要里混进**受管记录当前值**的那部分不许进日志（契约 `not_carries`）。

    日志记「这次操作涉及了什么值」；**不记「那条记录的当前值」**。
    变更前后值已经另存在 `record_changes` 里（那是证据，允许留），
    所以结果摘要里同名字段（= 当前值）要裁掉。
    返回：`(裁剪后的摘要, 是否裁过)`。
    """
    if not isinstance(summary, dict) or not record_change:
        return summary, False
    data = record_change.get("data") or {}
    changed = {item.get("field") for item in (data.get("changes") or []) if isinstance(item, dict)}
    if not changed:
        return summary, False
    trimmed = {key: item for key, item in summary.items() if key not in changed}
    return trimmed, len(trimmed) != len(summary)


def _summary(value):
    if isinstance(value, dict):
        return {
            # 包含匹配：new_password / initial_password 等复合字段名同样必须脱敏，
            # 精确匹配曾让重置密码的明文落进审计表。
            key: "[已脱敏]" if any(s in key.lower() for s in SENSITIVE_KEYS) else _summary(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_summary(item) for item in value[:50]]
    if isinstance(value, str) and len(value) > 500:
        return value[:500] + "…"
    return value


def _definition(action_id, action_version=None):
    """动作定义 —— **同一请求内复用**（2026-10-27 夜 · PKG-132 性能线）。

    以前这里是「先查名字再取文档」两条查询，**每个动作执行都要走一遍**；
    批量写 500 行 ⇒ 1000 条查询只为读同一份「这个动作怎么定义」。
    ⇒ 改成**同一请求内读一次**（`request_cache`）。

    ⚠️ **动作被重新登记后必须清缓存**：`register_action` 会
    `request_cache.clear("action_def")` ⇒ 这次请求里不会拿到旧定义。
    """

    def _load():
        filters = {"action_id": action_id, "enabled": 1}
        if action_version:
            filters["action_version"] = action_version
        name = frappe.db.get_value(
            "Shangshu Action Definition",
            filters,
            "name",
            order_by="creation desc",
        )
        if not name:
            frappe.throw("动作未注册或已停用", frappe.DoesNotExistError)
        return frappe.get_doc("Shangshu Action Definition", name)

    return request_cache.get(("action_def", action_id, str(action_version or "")), _load)


def _assert_action_role(action):
    business_access.require_identity()
    roles = set(frappe.get_roles())
    allowed_roles = set(_json(action.allowed_roles_json, []))
    if not business_access.resource_is_open(action.action_id) and allowed_roles and "System Manager" not in roles and not allowed_roles.intersection(roles):
        frappe.throw("当前用户无权执行该动作", frappe.PermissionError)
    return roles


def list_registered_actions(tools_only=False):
    business_access.require_identity()
    contributed = platform_contributions()
    allowed = {item["id"] for item in contributed["tools" if tools_only else "actions"]}
    roles = set(frappe.get_roles())
    result = []
    seen = set()
    for row in frappe.get_all(
        "Shangshu Action Definition",
        filters={"enabled": 1},
        fields=[
            "action_id", "action_version", "title", "effect", "confirmation_policy",
            "allowed_roles_json", "input_schema_json", "output_schema_json",
            "timeout_seconds", "retry_policy", "creation",
        ],
        order_by="action_id asc, creation desc",
    ):
        if row.action_id not in allowed or row.action_id in seen:
            continue
        seen.add(row.action_id)
        allowed_roles = set(_json(row.allowed_roles_json, []))
        if not business_access.resource_is_open(row.action_id) and allowed_roles and "System Manager" not in roles and not allowed_roles.intersection(roles):
            continue
        domain, resource = raw_resource("actions", row.action_id)
        result.append(
            {
                "id": row.action_id,
                "version": row.action_version,
                "title": row.title,
                "effect": row.effect,
                "confirmation": row.confirmation_policy,
                "roles": _json(row.allowed_roles_json, []),
                "input_schema": _json(row.input_schema_json, {}),
                "output_schema": _json(row.output_schema_json, {}),
                "timeout_seconds": row.timeout_seconds,
                "retry_policy": row.retry_policy,
                "domain_id": domain["id"] if domain else "com.shangshu.core",
                "executable": bool(resource and resource.get("handler")),
            }
        )
    return result


def execute_registered_action(action_id, payload=None, confirmed=False, idempotency_key=None, source="user", action_version=None, execution_id=None):
    from shangshu_core.transaction_failure import assert_transaction_healthy
    assert_transaction_healthy()
    from shangshu_core import action_packages
    from shangshu_core import write_zones
    with write_zones.action_scope(action_id, payload, action_version), action_packages.call_guard():
        return _execute_registered_action(action_id, payload, confirmed, idempotency_key,
                                          source, action_version, execution_id)


@resource_execution('actions', 'action_id')
def _execute_registered_action(action_id, payload=None, confirmed=False, idempotency_key=None, source="user", action_version=None, execution_id=None):
    if execution_id:
        from shangshu_core.reference_work import authorize_execution
        authorize_execution(execution_id,confirmation=True)
    domain, resource = raw_resource("actions", action_id)
    if not domain or not resource:
        frappe.throw("动作没有领域所有者", frappe.DoesNotExistError)
    from shangshu_core.lifecycle import assert_declared_call
    assert_declared_call(domain['id'])
    assert_domain_enabled(domain["id"])
    key = str(idempotency_key or secrets.token_hex(24))
    prior = action_requests.find_request(key)
    # 重试仍检查当前角色和领域，但沿用该请求首次锁定的动作元数据版本。
    from shangshu_core.action_provenance import process_action_version
    from shangshu_core import action_packages
    package_parent = action_packages.current()
    process_version = None if package_parent is not None else process_action_version(action_id)
    pinned = action_version or process_version or (prior.action_version if prior else None)
    action = None
    rebind_version = False
    if pinned:
        try:
            action = _definition(action_id, pinned)
        except frappe.DoesNotExistError:
            # ⚠️ **钉住的那个版本已经不在了**（动作被重新登记过、版本进位）
            #   ⇒ 退回**当前版本**继续；不在这儿报「动作未注册或已停用」
            #   （那句话说的是**动作**没了，其实是**版本**没了 ⇒ 误导，且解不开）。
            #   ⇒ 那笔请求（若**没成功过**）允许**改绑**到当前版本
            #   （失败那次的副作用已整体回滚 ⇒ 重跑是干净的；成功过的不给这个口）。
            rebind_version = prior is not None and prior.status != "Succeeded"
            action = None
    if action is None:
        action = _definition(action_id)
    roles = _assert_action_role(action)
    action_packages.validate_child(action_id, action)
    value = payload or {}
    _assert_payload_matches_schema(value, _json(action.input_schema_json, {}), action_id)
    is_confirmed = str(confirmed).lower() in ("1", "true", "yes")
    if action.confirmation_policy == "required" and not is_confirmed:
        frappe.throw("该写操作必须经过确认卡确认", frappe.ValidationError)
    if action.effect not in ("read", "external/read", "extract") and not idempotency_key:
        frappe.throw("写操作必须提供幂等键", frappe.ValidationError)
    identity = get_identity()
    package_enabled = action_packages.package_enabled(action, resource, value)
    if prior is None or prior.status != 'Succeeded':
        action_packages.assert_new_version(action, resource, value)
    request, created = action_requests.reserve(
        key, identity, action_id, action.action_version, value,
        audit_keys=action_requests.audit_keys_of(
            (_json(action.input_schema_json, {}) or {}).get("properties")),
        allow_version_drift=rebind_version)
    action_packages.assert_new_child_request(created)
    if not created:
        # 重放守卫（B5）：同键重放取旧结果前按当前权限复核——撤权/调岗后旧回执
        # 不能换出带值结果。守卫由领域在动作资源上声明（replay_guard=公共入口路径）；
        # 未声明的动作维持原行为。断言绑定已保证重放载荷与原请求指纹一致。
        #
        # 守卫签名统一为 `guard(payload, request)`；只接一个参数的守卫继续可用
        # （shangshu_files 的格值守卫就是单参）。多给一个 request 是为了
        # **新建类**动作：载荷里还没有对象编号（对象是这次才建出来的），
        # 守卫要从请求缓存的结果里认出刚建的那个，才能复核「现在还归不归你」。
        # 派发约定本身在 shangshu_core.replay_guard，判据在 test_guard_dispatch.py。
        guard = resource.get("replay_guard")
        if guard:
            invoke_replay_guard(frappe.get_attr(guard), value, request)
        return action_requests.replay(request)
    if frappe.db.exists("Shangshu Action Execution Audit", {"idempotency_key": key, "status": "Succeeded"}):
        frappe.throw("该键仅有旧版审计，无法核实完整请求；请通过原业务记录核对结果，不要换键重做", frappe.ValidationError)
    from shangshu_core import action_packages
    with action_packages.execution_scope(action_id, key, action, resource, value, enabled=package_enabled) as package:
        point = "action_execute_" + frappe.generate_hash(length=12)
        frappe.db.savepoint(point)
        # ⚠️ **把 savepoint 挂出去**（内核的「独立迁移」口要按**同名**重建它）——
        #   DDL 的隐式提交会销毁这个 savepoint ⇒ 失败路径的
        #   `frappe.db.rollback(save_point=point)` 就没有落点
        #   （MySQL 1305：SAVEPOINT does not exist）⇒ 失败记账跑不到
        #   ⇒ **动作卡在 Running**、同键重试撞「该动作仍在执行或需要恢复」。
        #   挂的是**一条链**（由外到内）：外层动作的 savepoint 同样会被 DDL 销毁，
        #   一起重建才不会漏。
        previous_savepoints = getattr(frappe.flags, 'shangshu_action_savepoints', None)
        frappe.flags.shangshu_action_savepoints = [*(previous_savepoints or []), point]
        try:
            result = _execute_action_handler(action_id, action, domain, resource, identity, roles,
                                             value, key, source, is_confirmed)
            if package is not None and package.key == key:
                package.finish(unified_log.write_log)
            action_requests.succeed(request, result)
            if package is not None and package.key != key:
                package.remember_request(request)
            return result
        except Exception as error:
            from shangshu_core.transaction_failure import mark_transaction_failed, transaction_failure
            mark_transaction_failed(error)
            # 合并说明：两边各有改动，这里按语义合成 ——
            #  fast：只回滚到**本动作的 savepoint**（调用方可能捕获错误继续办理，
            #        不能撤它此前的写入或释放域锁）；失败回执不在这里提交，
            #        交给最外层 HTTP 边界另行持久化（persist_http_action_failure）。
            #  FDE ：伴随包里的**子动作**失败时只上抛，不落中间失败回执 ——
            #        整包由外层一次回滚 + 一次失败记账（不能在中途提交一条请求）。
            # 取 fast 的 savepoint 回滚（与 platform-api-v1.json 的
            #   "executor savepoint only; failure receipt persisted only at outer HTTP boundary" 一致），
            # 并保留 FDE 的伴随包守卫：子动作失败不写中间回执，只上抛。
            rollback_failure = None
            try:
                frappe.db.rollback(save_point=point)
            except Exception as rollback_error:
                mark_transaction_failed(rollback_error, rollback=True)
                if package is not None and transaction_failure() is None:
                    rollback_failure = action_packages.prevent_commit(
                        '原子包数据库回滚失败，禁止提交；请恢复事务后重试')
                    rollback_failure.__cause__ = rollback_error
                # 非包动作保留旧失败回执路径；包回滚失败显式阻止后续提交。
            atomic_parent = getattr(frappe.flags, 'shangshu_atomic_action_parent', None)
            # 死锁可能已回滚整个事务，request 已不存在。失效后不继续写失败
            # 回执或 pending，也不让后续 DoesNotExistError 覆盖原始数据库错误。
            error = transaction_failure() or error
            if not ((package is not None and package.key != key) or (atomic_parent and atomic_parent != key)):
                # 失败回执只能由最外层 HTTP 事务边界另行持久化；Python 组合调用不自行提交。
                error._ss_failed_action = (key, identity, action_id, action.action_version, value,
                                          action_requests.audit_keys_of(
                                              (_json(action.input_schema_json, {}) or {}).get("properties")))
                if transaction_failure() is None:
                    try:
                        action_requests.fail(request, _human_failure_reason(error))
                    except Exception as receipt_error:
                        receipt_error._ss_failed_action = error._ss_failed_action
                        from shangshu_core.transaction_failure import raise_if_transaction_failed
                        raise_if_transaction_failed(receipt_error)
                        raise error from receipt_error
            if rollback_failure is not None:
                if hasattr(error, '_ss_failed_action'):
                    rollback_failure._ss_failed_action = error._ss_failed_action
                raise rollback_failure
            if transaction_failure() is not None:
                raise error
            raise
        finally:
            frappe.flags.shangshu_action_savepoints = previous_savepoints


def _with_permission_message(error):
    """把这个失败**为什么**贴到异常上（**只有权限那一类**才贴）。

    为什么要有这一段（2026-10-24 夜班站上实测，证据在开发日志 77 号）：
    frappe 的**原生权限错不带文案** —— `raise_no_permission_to` 只把那句话放进
    `frappe.flags.error_message`，再抛一个**空异常**的 `PermissionError`；
    而 `_failure_reason()` 只看 `str(error)` ⇒ 那句人话被扔掉了
    ⇒ 审计表（`tabShangshu Action Request`）里那 **4822 条**失败记录，
    「失败原因」**全是空的** ⇒ 查账只能靠猜（「表不存在」？「应用没发布」？「没权限」？）。

    ⚠️ **为什么贴在异常上，而不是让 `_failure_reason()` 自己去读 frappe**：
    `_failure_reason()` 要**能被单独抽出来跑**（工具区有判据就是那么干的 ——
    它只 exec 这一个函数、不给别的名字）⇒ 它**只许认内置名和自己的参数**。
    ⇒ 认识 frappe 的那一段放在这里，**由调用处先贴一句**，它再照原样取用。
    """
    if isinstance(error, frappe.PermissionError):
        flag = str(getattr(frappe.flags, "error_message", "") or "").strip()
        if flag:
            error._ss_permission_message = re.sub(r"<[^>]+>", "", flag).strip()
    return error


def _failure_reason(error):
    # frappe.throw 的文案本来就是给用户看的（版本冲突、无权、必填等），原样留下；
    # frappe 各异常类没有公共基类，按抛出模块认。
    if type(error).__module__.startswith("frappe"):
        text = str(error).strip()
        if text:
            return text
        # **权限**那一类的 frappe 原生异常**不带文案** ⇒ 用调用处贴上来的那句
        #（`_with_permission_message()` 贴的）⇒ **不许是空串**：查账要看出为什么。
        hint = str(getattr(error, "_ss_permission_message", "") or "").strip()
        if hint:
            return hint
    return "动作执行失败，请联系管理员核查；未确认结果前不要重复新建操作。"


# ── 失败原因要是一句「人话」（用户 2026-10-24 12:0x 拍板「要换成中文」）─────────────
# frappe 自己那几句权限说明是**英文**（框架里的模板，不是我们写的）⇒
# 77 号那条把「失败原因不丢」修好了，可留在审计表里的**还是英文** ⇒ 人看不懂。
# 这里的规矩三条：
#   ① 认得出的英文模板 ⇒ 翻成**中文句式**，对象标识（DocType 名 ＋ 单号）原样保留；
#   ② 其它整句英文 ⇒ 套一句中文外壳，**原文不许丢**（查账还要靠它定位）；
#   ③ 已经有中文 ⇒ **原样留着**（域里自己写的中文文案一个字不改）。
# ⚠️ 这一段**刻意不放在 `_failure_reason()` 里** —— 那个函数只许认内置名和自己的参数
#    （工具区 `test_office_integration.py` 把它单独抽出来 exec、只给一个空环境）⇒
#    塞模块级名字进去会把那条既有判据弄红。
_PERMISSION_WORDS = {
    "read": "读取", "write": "写入", "create": "新建", "delete": "删除",
    "submit": "提交", "cancel": "撤销", "amend": "修改", "report": "查看",
    "email": "发信", "export": "导出", "import": "导入", "share": "共享",
}


def _chinese_reason(text):
    """把一句失败原因变成**一句中文**（原始信息不许丢）。"""
    original = str(text or "")
    plain = re.sub(r"<[^>]+>", "", original).strip()
    if not plain:
        return original
    matched = re.match(
        r"You need the '([^']+)' permission on (.+?) to perform this action\.$", plain)
    if matched:
        word = _PERMISSION_WORDS.get(matched.group(1).strip().lower(), matched.group(1))
        target = matched.group(2).strip()
        return f"没有「{target}」的{word}权限，这次操作没做成；请联系管理员开通权限，或换一个对象再试。"
    matched = re.match(r"No permission for (.+)$", plain)
    if matched:
        return f"没有「{matched.group(1).strip()}」的权限，这次操作没做成；请联系管理员开通权限，或换一个对象再试。"
    if plain.lower() in ("not permitted", "permission denied"):
        return "没有权限，这次操作没做成；请联系管理员开通权限，或换一个对象再试。"
    if not re.search(r"[\u4e00-\u9fff]", plain):
        return f"这次操作没做成（系统原文：{plain}）；请联系管理员核查。"
    return original


def _human_failure_reason(error):
    """给人看的那句失败原因：**一句中文**（先贴权限说明，再翻成中文）。

    ⚠️ **只有这一处是对外的口径** —— 动作失败回执（`action_requests.fail`）与
    提案失败（`proposal.error_message`）都走它 ⇒ 两边不许各写一套。
    """
    _with_permission_message(error)
    return _chinese_reason(_failure_reason(error))


def persist_http_action_failure(error):
    """仅 HTTP 顶层异常边界使用；绝不能从领域 handler/Service 内调用。"""
    failed = getattr(error, '_ss_failed_action', None)
    if not failed or getattr(frappe.flags, 'shangshu_domain_execution_depth', 0):
        return
    key, identity, action_id, version, value, audit_keys = failed
    try:
        frappe.db.rollback()
        request, _ = action_requests.reserve(key, identity, action_id, version, value, audit_keys=audit_keys)
        action_requests.fail(request, _human_failure_reason(error))
        frappe.db.commit()
    except Exception as receipt_error:
        # 顶层仍抛最初动作错误；回执失败不能把它替换成缺行/连接错误。
        from shangshu_core.transaction_failure import mark_transaction_failed
        mark_transaction_failed(receipt_error)
        error._ss_failure_receipt_error = receipt_error


def _execute_action_handler(action_id, action, domain, resource, identity, roles, value, key, source, is_confirmed):
    handler = resource.get("handler")
    if not handler:
        frappe.throw("该动作只声明了元数据，尚未注册公共执行器", frappe.ValidationError)
    from shangshu_core import action_packages
    context = {
        "atomic_package": action_packages.current() is not None,
        "identity_id": identity.identity_id,
        "enterprise_id": identity.enterprise_id,
        "user_name": frappe.session.user,
        "roles": list(roles),
        "domain_id": domain["id"],
        "action_version": action.action_version,
        "source": source,
        "idempotency_key": key,
        "confirmed": is_confirmed,
    }
    from shangshu_core.action_provenance import current_action_provenance
    from shangshu_core import action_packages
    package = action_packages.current()
    if package is not None and package.key != key:
        # 子动作来源是已授权根包的执行明细，不冒充另一个流程节点。
        provenance = package.provenance
    else:
        provenance = current_action_provenance(action_id, action.action_version)
        if package is not None:
            package.provenance = provenance
    started = time.monotonic()
    previous_pin = getattr(frappe.flags, "shangshu_action_pin", None)
    previous_domain = getattr(frappe.flags, 'shangshu_call_domain', None)
    frappe.flags.shangshu_call_domain = domain['id']
    frappe.flags.shangshu_action_pin = {"action_id": action_id, "action_version": action.action_version}
    try:
        guard = resource.get("execution_guard")
        if guard:
            owner = domain.get("owner_app") or (domain.get("contribution") or {}).get("owner_app")
            if not owner or not str(guard).startswith(str(owner) + "."):
                frappe.throw("动作执行守卫必须属于动作原域", frappe.PermissionError)
            # A guard consumes current authorized facts while locks remain held;
            # ordinary editing actions have no guard and are not gated as workflows.
            if frappe.get_attr(guard)(action_id, value, context) is not True:
                frappe.throw("动作执行条件未满足，本次未执行", frappe.ValidationError)
        from shangshu_core.action_provenance import action_origin_scope
        with action_origin_scope(action_id,key,frappe.session.user,source):
            result = frappe.get_attr(handler)(action_id, value, context)
            from shangshu_core.transaction_failure import assert_transaction_healthy
            assert_transaction_healthy()
    finally:
        frappe.flags.shangshu_action_pin = previous_pin
        frappe.flags.shangshu_call_domain = previous_domain
    _assert_payload_matches_schema(result or {}, _json(action.output_schema_json, {}), action_id, "result")
    # 兼容已在领域服务中写入审计的存量实现；公共入口不制造重复审计。
    existing = frappe.db.get_value("Shangshu Action Execution Audit", {"idempotency_key": key}, "name")
    from shangshu_core import action_packages
    package = action_packages.current()
    if package is not None:
        if existing:
            frappe.throw("原子包子动作不得自行写入旧审计", frappe.ValidationError)
        changes = context.get("record_changes") or ([context["record_change"]] if context.get("record_change") else [])
        entry = _action_audit_entry(action_id=action_id, action=action, domain=domain,
            identity=identity, value=value, result=result, record_change={},
            idempotency_key=key, source=source, is_confirmed=is_confirmed,
            provenance=provenance, started=started)
        # Preserve the existing rule against copying current record values into
        # summaries; actual before/after evidence remains complete in the step.
        changed_fields = {change.get("field") for row in changes
            for change in (row.get("data") or {}).get("changes", []) if isinstance(change, dict)}
        summary = entry["detail"]["result_summary"]
        if isinstance(summary, dict) and changed_fields.intersection(summary):
            summary = {name: item for name, item in summary.items() if name not in changed_fields}
            entry["detail"]["result_summary"] = summary
            entry["detail"]["legacy"]["result_summary_json"] = _canonical(summary)
            entry["detail"]["result_summary_trimmed"] = "结果摘要里混进了受管记录的当前值，按契约裁掉了"
        receipt = {"action_id": action_id, "action_version": action.action_version,
                   "result": result, "audit": None, "idempotent": False}
        package.collect(entry, changes, receipt)
        return receipt
    if existing:
        legacy = frappe.get_doc("Shangshu Action Execution Audit", existing)
        if legacy.action_id != action_id:
            frappe.throw("领域执行器写入了不匹配的动作审计", frappe.ValidationError)
        if legacy.action_version != action.action_version:
            frappe.throw("领域执行器没有按公共入口锁定的动作版本写入审计", frappe.ValidationError)
        # 域执行器自己写了旧审计（存量实现）：**不抄一份**进统一日志（不许双写）。
        # 这一行仍由读口合并进来（旧的查询口形状不变）。
        audit = legacy
    else:
        # **统一日志库**（PKG-020-T01）：动作执行审计只写统一表这一处。
        # 旧表保留表结构与历史行，不再新增。
        record_changes = context.get("record_changes")
        if record_changes:
            # **批量写（`platform.object.update_many`）**：**逐条一行审计**。
            # ⚠️ **粒度不变** —— 与今天「一行一次动作」写出来的行同形
            # （同一张受管记录、同一份前后值、同样能按案件看）。
            # 差别只在于「**动作框架走一次**」，审计**仍然一行一条**。
            #
            # ⚠️⚠️ **摘要只算一次**（2026-10-28 凌晨实测踩到的真凶）：
            #   `input_summary` / `result_summary` 是**整包**的摘要，
            #   而批量写有 N 条记录 ⇒ 若逐条各算一次，就是 **O(N²)**。
            #   实测（400 行撤回）：`_summary` 被调 **92,600 次**、JSON 解析 0.87s
            #   ⇒ 撤回比写入慢一大截，就是这来的。
            #   ⇒ 摘要**在循环外算一次**，逐条复用（**每行审计的内容一字不变**）。
            shared_input = _summary(value)
            shared_result = _summary(result or {})
            entries, audit_keys = [], set()
            for index, record_change in enumerate(record_changes):
                row_key = str(record_change.get("idempotency_key") or "")
                if not row_key:
                    # 公共 update_many 的行键可选；不能让 N 行共用父键而只留一行日志。
                    # 序号保留同一记录在一包内多次修改的事实，同包重试生成相同键。
                    import hashlib
                    row_key = "batch-audit:" + hashlib.sha256(_canonical(
                        [key, index, record_change.get("doctype"), record_change.get("name")]
                    ).encode("utf-8")).hexdigest()
                if row_key in audit_keys:
                    frappe.throw("批量记录的审计键重复，本包未保存", frappe.ValidationError)
                audit_keys.add(row_key)
                entries.append(_action_audit_entry(
                    action_id=action_id, action=action, domain=domain, identity=identity,
                    value=value, result=result, record_change=record_change,
                    idempotency_key=row_key,
                    source=source, is_confirmed=is_confirmed, provenance=provenance,
                    started=started, shared_input=shared_input, shared_result=shared_result))
            # 一条记录仍是一行完整审计；只把落库往返合批，不延迟到提交后补记。
            audits = unified_log.write_logs(entries)
            audit = audits[-1] if audits else None
        else:
            record_change = context.get("record_change") or {}
            audit = _write_action_audit(
                action_id=action_id, action=action, domain=domain, identity=identity,
                value=value, result=result, record_change=record_change,
                idempotency_key=key, source=source, is_confirmed=is_confirmed,
                provenance=provenance, started=started)
    return {
        "action_id": action_id,
        "action_version": action.action_version,
        "result": result,
        "audit": getattr(audit, "name", None),
        "idempotent": False,
    }


def _write_action_audit(**kwargs):
    return unified_log.write_log(**_action_audit_entry(**kwargs))


def _action_audit_entry(*, action_id, action, domain, identity, value, result,
                         record_change, idempotency_key, source, is_confirmed,
                         provenance, started, shared_input=None, shared_result=None):
    """构造同形审计载荷；单条与批量共用，不在这里落库。"""
    record_change = record_change or {}
    change_data = record_change.get("data") or {}
    # ⚠️ **摘要可以由调用方先算好**（批量写时整包只算一次 ⇒ 避免 O(N²)；
    #   每行审计的**内容一字不变** —— 复用同一份摘要而已）。
    input_summary = shared_input if shared_input is not None else _summary(value)
    base_result = shared_result if shared_result is not None else _summary(result or {})
    result_summary, trimmed = _trim_result_summary(base_result, record_change)
    confirmation_text = (("提案 " + str(frappe.flags.shangshu_review_context['proposal_id'])
        + " 逐项审核 " + str(len(frappe.flags.shangshu_review_context['units'])) + " 项")
        if getattr(frappe.flags, 'shangshu_review_context', None)
        else "由公共动作执行入口确认") if is_confirmed else ""
    legacy_row = {
        "action_id": action_id,
        "action_version": action.action_version,
        "actor_identity": identity.name,
        "actor_user": frappe.session.user,
        "executor_source": str(source or "user")[:20],
        "source_snapshot_json": _canonical(provenance) if provenance else None,
        "input_summary_json": _canonical(input_summary),
        "result_summary_json": _canonical(result_summary),
        **({"reference_doctype": record_change["doctype"],
            "reference_name": record_change["name"],
            "record_changes_json": _canonical(change_data)} if record_change else {}),
        # **挂到受管记录上**（2026-10-22）：与流程那个 `business_object_id` 同款思路 ——
        # 日志要能**按案件看**，就得知道这条审计动的是哪条受管记录。
        # 受管对象的记录写入会在 `record_change.data` 里带 `object_id`；
        # 普通 DocType 的写入没有 ⇒ 两列留空（**不硬凑**）。
        **({"business_object_id": str(change_data.get("object_id") or ""),
            "business_name": str(record_change["name"])}
           if record_change and change_data.get("object_id") else {}),
        "confirmed": 1 if is_confirmed else 0,
        "confirmation_text": confirmation_text,
        "idempotency_key": idempotency_key,
        "status": "Succeeded",
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    detail = {
        "input_summary": input_summary,
        "result_summary": result_summary,
        # 改了哪些字段的前后值（**证据**：不是那条记录的当前值）。
        "record_changes": change_data or None,
        "action_version": action.action_version,
        "executor_source": legacy_row["executor_source"],
        "confirmed": legacy_row["confirmed"],
        "confirmation_text": confirmation_text,
        "duration_ms": legacy_row["duration_ms"],
        "source_snapshot": provenance,
        # 旧形状快照：旧读口按它投影回去 ⇒ **既有返回形状不变**。
        "legacy": legacy_row,
    }
    if trimmed:
        # 结果摘要里混进了受管记录的当前值 ⇒ 那部分**不进日志**（契约优先于形状）。
        detail["result_summary_trimmed"] = "结果摘要里混进了受管记录的当前值，按契约裁掉了"
    return dict(
        kind="action", what_id=action_id, domain_id=domain["id"],
            actor_user=frappe.session.user, actor_identity=identity.name,
            trigger_source=source, result="Succeeded",
            business_object_id=legacy_row.get("business_object_id", ""),
            business_name=legacy_row.get("business_name", ""),
            reference_doctype=legacy_row.get("reference_doctype"),
            reference_name=legacy_row.get("reference_name"),
            idempotency_key=idempotency_key, detail=detail)


# **大提案不内联全文值**（D 2026-10-17 实测：20k 格提案让 ③ 回 1.98MB、
# 列表回 1.85MB，BASE44「整包拉」从这两个口又回来了）。
# 约定：③（可用性/恢复）**永不内联 payload**；②a 列表只在 ≤64KB 时内联
# （聊天确认卡要读 `payload` 显示，小候选照旧），超限只回摘要 + 明确标记。
_INLINE_PAYLOAD_LIMIT = 65536


def _payload_bytes(value):
    try:
        return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return 0


@resource_execution('actions', 'action_id')
def _project_proposal_payload(action_id, payload):
    _, resource = raw_resource('actions', action_id)
    handler = (resource or {}).get('proposal_projection')
    return frappe.get_attr(handler)(action_id, payload) if handler else {'payload':payload, 'redacted':False}


def _review_target(doc, payload):
    """这条提案**落在哪张表/哪一行**？（域的逐项审核声明里已经给了 ⇒ 内核只是把它取出来）

    ⚠️ **域的 descriptor 把 `module` 写成「域名」**（example 写 `example`），
    而内核 `target.module` 说的是**页面模块**（excel/mail）⇒ **有表就是 excel**；
    域名另存 `domain_module`，不丢信息、也不说假话。
    """
    from shangshu_core.proposal_review import locate_proposal_target
    located = locate_proposal_target(doc.action_id, payload,
                                     _json(doc.get('review_state_json'), {}), doc.actor_user)
    if not located:
        return None
    target = {k: v for k, v in located.items() if k != 'module'}
    module = str(located.get('module') or '')
    target['module'] = 'excel' if located.get('table') else module
    if module and module != target['module']:
        target['domain_module'] = module
    return target


def _proposal_public(doc, include_payload=True):
    from shangshu_core.action_provenance import project_action_provenance
    projection = _project_proposal_payload(doc.action_id, _json(doc.payload_json, {}))
    payload = projection['payload']
    entity_id = next(
        (str(payload.get(key)) for key in ("name", "claim", "invoice", "payable", "record_id") if payload.get(key)),
        doc.name,
    )
    payload_size = _payload_bytes(payload)
    original = _json(doc.original_payload_json, None)
    if original is not None:
        try:
            original = _project_proposal_payload(doc.action_id, original)['payload']
        except frappe.PermissionError:
            original = None
    original_size = _payload_bytes(original) if original is not None else 0
    inline = bool(include_payload and payload_size <= _INLINE_PAYLOAD_LIMIT)
    # **页面定位目标**（D 2026-10-17）：payload 被省掉后，卡仍需知道「去哪张表/哪封信」。
    # 和 `/review` 的 target 同形、只含不可变身份字段，不破坏「③ 不带全文值」。
    target = None
    if payload.get("table"):
        target = {"module": "excel", "table": payload.get("table")}
        if payload.get("sheet"):
            target["sheet"] = payload.get("sheet")
    elif payload.get("mail") or str(doc.action_id or "").startswith("mail."):
        target = {"module": "mail", "mail": payload.get("mail")}
    if target is None:
        # **载荷里定位不到**（example 那条载荷只有 `{"file": ...}`）⇒ 表格页按表过滤时看不见它。
        # ⇒ 问域要**表/行**（域的逐项审核声明里已经给了 `target.table` / `target.row_id`）。
        target = _review_target(doc, payload)
    result = {
        "id": doc.name,
        "capability": doc.action_id,
        "action_version": doc.action_version,
        "entity_type": str(payload.get("object_id") or doc.action_id.rsplit(".", 1)[0]),
        "entity_id": entity_id,
        # 页面定位目标（不可变身份）；payload 省掉时调用方靠它跳转/刷新审核视图。
        "target": target,
        "payload": payload if inline else None,
        # 明确说「没带，不是因为空」：调用方要全文值走 `/review`（逐项审核口）。
        "payload_omitted": not inline,
        "payload_bytes": payload_size,
        "summary": _summary(payload),
        "status": doc.status.lower(),
        "created_via": doc.created_via,
        "source_provenance": project_action_provenance(doc.get("source_snapshot_json")),
        "decision_by": doc.decision_by,
        "decision_at": doc.decision_at,
        "execution_audit": doc.execution_audit,
        # 「人改过」留痕 —— 让 `confirmed` 可辨，不冒领助手原稿。
        # `edited` 为真 = 载荷被人改过；`original_payload` 是改前完整原值（不截断）。
        # 调用方据此把 R5 从「原候选不许记成已采用」升级成「confirmed 但改动可辨」。
        "edited": bool(doc.edited_at) or any(item.get('edited') for item in
            _json(doc.get('review_state_json'),{}).get('accepted',{}).values()),
        "edited_by": doc.edited_by,
        "edited_at": doc.edited_at,
        # 合并说明：FDE 这边对 `edited_value`/`original_payload` 做了**投影脱敏 + 体积上限**，
        # fast 那边是原样回带 —— 取 FDE 的更严口径（不泄露不可见字段、不把大载荷塞进列表接口）。
        "edited_value": None if projection.get('redacted') else _json(doc.edited_value_json, None),
        "original_payload": original if (inline and original_size <= _INLINE_PAYLOAD_LIMIT) else None,
        "original_payload_omitted": bool(original is not None and (
            not inline or original_size > _INLINE_PAYLOAD_LIMIT)),
        "original_payload_bytes": original_size,
        # fast 新增：这条提案**能不能走逐项审核**（域声明了 review_handler 才算）。
        "review_supported": bool((raw_resource('actions',doc.action_id)[1] or {}).get('review_handler'))
            and (doc.action_id!='mail.save_draft' or bool(payload.get('mail')))
            and len(payload.get('cells') or payload.get('changes') or [None])<=100,
    }
    if doc.get('review_state_json'):
        state = _json(doc.review_state_json, {})
        visible_accepted = [k for k in state.get('accepted', {})
                            if projection.get('unit_ids') is None or k in projection['unit_ids']]
        result['review'] = {'partial': doc.status == 'Proposed' and bool(visible_accepted),
                            'accepted_count': sum(1 for k in state.get('accepted', {})
                                if projection.get('unit_ids') is None or k in projection['unit_ids']),
                            'bound_target': state.get('bound_target')}
    # 应用编辑已有只读差异服务；不复制编译器、不写入第二份差异事实。
    if doc.action_id == 'platform.application.configure' and doc.status == 'Proposed':
        from shangshu_core.application_delivery import inspect_delivery
        try:
            result['preview']={'status':'checked',**inspect_delivery(None,{'operation':'change_preview',**payload},None)}
        except (frappe.ValidationError,frappe.PermissionError,frappe.DoesNotExistError) as error:
            result['preview']={'status':'blocked','reason':str(error)}
    return result


def _assert_proposable(action_id):
    # Action 可供人工页面调用，不代表可把其原始参数持久化为 AI 提案。
    # 特别是邮箱授权配置：仅显式发布的 tools 才能进入该确认通道。
    if action_id not in {item['id'] for item in platform_contributions().get('tools', [])}:
        frappe.throw('该动作未开放给 Agent，请使用对应设置页面', frappe.PermissionError)


def propose_registered_action(action_id, payload=None, idempotency_key=None, source="ai", execution_id=None):
    """建立受管写提案；仅记录，不执行领域 handler。"""
    if execution_id:
        from shangshu_core.reference_work import authorize_execution
        authorize_execution(execution_id)
    domain, resource = raw_resource("actions", action_id)
    if not domain or not resource or not resource.get("handler"):
        frappe.throw("动作没有可用的公共执行器", frappe.DoesNotExistError)
    assert_domain_enabled(domain["id"])
    from shangshu_core.action_provenance import process_action_version
    action = _definition(action_id,process_action_version(action_id))
    _assert_action_role(action)
    _assert_proposable(action_id)
    value = payload or {}
    _assert_payload_matches_schema(value, _json(action.input_schema_json, {}), action_id)
    if action.effect in ("read", "external/read", "extract"):
        frappe.throw("只读工具无需创建确认提案", frappe.ValidationError)
    if action.confirmation_policy != "required":
        frappe.throw("AI 只能为内核强制确认的写动作创建提案", frappe.ValidationError)
    key = str(idempotency_key or secrets.token_hex(24))
    from shangshu_core.action_provenance import current_action_provenance
    from shangshu_core import action_packages
    package = action_packages.current()
    if package is not None and package.key != key:
        # 子动作来源是已授权根包的执行明细，不冒充另一个流程节点。
        provenance = package.provenance
    else:
        provenance = current_action_provenance(action_id, action.action_version)
        if package is not None:
            package.provenance = provenance
    existing = frappe.db.get_value("Shangshu Action Proposal", {"idempotency_key": key}, "name")
    identity = get_identity()
    if existing:
        proposal = frappe.get_doc("Shangshu Action Proposal", existing)
        if _json(proposal.get('source_snapshot_json'),{}) != (provenance or {}):
            frappe.throw('同一提案键的流程来源不同，请核对原提案',frappe.ValidationError)
        if (proposal.reference_execution or None)!=(execution_id or None):
            frappe.throw('同一提案键的来源执行不同，请核对原提案',frappe.ValidationError)
        assert_request_binding(
            proposal, identity, resource_field="action_id", resource_id=action_id,
            version_field="action_version", version=action.action_version, payload=value,
        )
        return _proposal_public(proposal)
    from shangshu_core.conversation_evidence import current_conversation_key
    definition_snapshot = _capture_proposal_definition(action_id, value)
    proposal = frappe.get_doc(
        {
            "doctype": "Shangshu Action Proposal",
            "action_id": action_id,
            "action_version": action.action_version,
            "actor_identity": identity.name,
            "actor_user": frappe.session.user,
            "enterprise_id": identity.enterprise_id,
            "reference_execution": execution_id,
            "conversation_key": current_conversation_key(),
            "payload_json": _canonical(value),
            "payload_summary_json": _canonical(_summary(value)),
            "definition_snapshot_json": _canonical(definition_snapshot),
            "status": "Proposed",
            "idempotency_key": key,
            "created_via": str(source or "ai")[:80],
            "source_snapshot_json": _canonical(provenance) if provenance else None,
        }
    ).insert(ignore_permissions=True)
    return _proposal_public(proposal)


@resource_execution('actions', 'action_id')
def _assert_proposal_target(action_id, payload, purpose, actor_user, state=None):
    _, resource = raw_resource('actions', action_id)
    guard = (resource or {}).get('proposal_guard')
    if guard:
        handler = frappe.get_attr(guard)
        # ⚠️ **把提案的状态一并带上**（2026-10-22 · PKG-037-T07）：
        # 域的闸有时要判「**这次提案里有没有带某个单元**」——
        # 例：example 的「材料审核结论」单元被采用 ⇒ 载荷里带 `conclude`，
        # **但载荷在 authorize 阶段还没有它**（那是 `prepare` 在提交阶段才加的）⇒
        # 只看载荷的闸**判不出来** ⇒ 状态（units）得给得到。
        # ⚠️ **向后兼容**：别的域的闸仍是**四个参数** ⇒ 按签名决定带不带。
        try:
            arity = len(inspect.signature(handler).parameters)
        except (TypeError, ValueError):
            arity = 0
        if arity >= 5:
            handler(action_id, payload, purpose, actor_user, state)
        else:
            handler(action_id, payload, purpose, actor_user)


@resource_execution('actions', 'action_id')
def _proposal_definition_hook(action_id, payload, purpose, snapshot=None):
    _, resource = raw_resource('actions', action_id)
    handler = (resource or {}).get('proposal_snapshot')
    if handler:
        return frappe.get_attr(handler)(action_id, payload, purpose, snapshot)
    return None


def _capture_proposal_definition(action_id, payload):
    # Independent, server-owned metadata. Never add it to action payloads:
    # that would change schema/idempotency and let clients replace the pin.
    return _proposal_definition_hook(action_id, payload, 'capture')


def _assert_proposal_definition(proposal, lock=True):
    _proposal_definition_hook(proposal.action_id, _json(proposal.payload_json, {}),
                              'validate' if lock else 'inspect',
                              _json(proposal.get('definition_snapshot_json'), None))


def _proposal_reviewer(proposal):
    """**指定审核人是谁** —— 目标资源的**表主**（`resource_owner`）。

    计划 §五 E01.4 要「**指定审核人资格**」，但全仓没有 designate 字段。
    **不新造字段**：候选的**目标**有天然的责任人 —— 表主。
    「谁的表，谁能裁」是**既有的归属语义**，不是本函数发明的口径。

    回 `None` = **算不出来**（无目标 / 目标没有表主 / 解析器没注册）——
    这时**只有 System Manager 与发起人**能看（fail-closed，不默认放给所有人）。
    """
    payload = _json(proposal.payload_json, {})
    target = payload.get('table') or payload.get('file')
    if not target:
        return None
    try:
        from shangshu_core.org_admin import resource_attribution, resource_owner
        attribution = resource_attribution(str(target))
        if attribution is not None:
            # Current ownership governs review after transfer. An attributed
            # resource without a custodian must not revive its historical creator.
            return str(attribution.get("owner_user") or "").strip() or None
        return resource_owner(str(target))
    except Exception:
        return None


def _proposal_eligible(proposal, roles):
    """列表、详情与裁决共用审核资格；目标读写权仍由各入口按用途检查。"""
    user = str(frappe.session.user or '')
    roles = set(roles or ())
    reviewer = _proposal_reviewer(proposal)
    return ("System Manager" in roles
                or str(proposal.actor_user or '').lower() == user.lower()
                or bool(reviewer and reviewer.lower() == user.lower()))


def _proposal_visible(proposal, roles):
    """提案对当前用户可见吗（跟 `list_action_proposals` 同一鉴权，三读口共用一份）。

    **「一份判定源两个粒度」** —— 列表/摘要/units 三个口的可见性判定**只在这里写一次**，
    不各写一套（10-15 那条「已有能力不重写」）。

    **计划 §五 E01.4 的「双重检查」两道都在**：

      1. **指定审核人资格**：**表主**（`_proposal_reviewer`）／System Manager／**发起人本人**。
         ⚠️ **不再「有动作角色就能看」** —— 那是 10/16 实测的泄露：
         普通员工能看到别人在**自己读不了的表**上的候选（表名/改动值都在载荷里）。
      2. **实际目标操作权**：过完第 1 道**还要**对提案目标当前有读权
         —— 走动作声明的那道 `proposal_guard`（`_assert_proposal_target(..., 'read', ...)`）。

    **两道都要**：表主也可能被撤掉目标读权；有目标读权的人也不该看**别人表**上的候选。

    ⚠️ **目标读不了时回 `False`，不抛** —— 这是**列表过滤**，一个不可见的提案不能
    让整个列表炸掉。真正的拒绝（带拒因）在裁决/执行那步，由 `proposal_guard` 抛。
    """
    if not _proposal_eligible(proposal, roles):
        return False
    # 发起人和管理员也须通过当前目标读权；历史资格不能绕过撤权。
    try:
        _assert_proposal_target(proposal.action_id, _json(proposal.payload_json, {}),
                                'read', proposal.actor_user)
        _project_proposal_payload(proposal.action_id, _json(proposal.payload_json, {}))
        return True
    except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
        return False


def _proposal_cursor_where(after):
    """cursor 分页：`after` 是上一页最后一条的 `name`（稳定，不随 creation 变）。

    **为什么用 `name` 不用 `creation`**：`creation` 可能同秒，`name` 唯一且稳定。
    """
    return {"name": ("<", after)} if after else {}


def count_action_proposals(status=None):
    """① 提案摘要（计数）—— **不带 units / 候选全文值**（BASE44 病根：重复大包）。

    **测试通过 =** 按 status 分组的计数，**跟 `list_action_proposals` 同一鉴权**：
    只数当前用户看得见的（System Manager | 本人发起 | 动作角色集含我）。
    """
    roles = set(frappe.get_roles())
    identity = get_identity()
    # 合并说明：fast 那边的 `action_proposal_summary` 只有一句「按 actor_user 过滤」的粗口径
    # 列表头（它原本是旧版 `list_action_proposals` 的开头，后面已被本分支的
    # keyset 分页实现接走，单独保留会引用未定义的 page_size）。
    # 本分支的 `action_proposal_summary` / `list_action_proposal_units` /
    # `_proposal_directory_item` / `list_action_proposals` 整体保留 ——
    # 它们的可见性判定 `_proposal_eligible` 已覆盖 fast 那句「只看本人发起的」
    # （发起人本人 | 指定审核人 | System Manager），再叠目标当前读权。
    counts = {}
    # ⚠️ **按 status 收窄**（2026-10-28 · PKG-132 · 审查报告 R17）：
    #   以前**不管传没传 status，三档都数一遍** ⇒ 摘要口在**装配全部历史提案**。
    #   ⇒ 传了 status 就**只数那一档**；不传才三档都数（既有口径不变）。
    wanted = [status] if status else ["Proposed", "Confirmed", "Rejected"]
    for st in wanted:
        rows = frappe.get_all(
            "Shangshu Action Proposal",
            filters={"enterprise_id": identity.enterprise_id, "status": st},
            # ⚠️ **一次取回判定要用的字段**（不再逐条 `frappe.get_doc` 装配提案）
            fields=["name", "actor_user", "action_id", "payload_json"],
            limit_page_length=0,
        )
        n = 0
        for row in rows:
            # 可见性判定仍是**同一份** `_proposal_visible`（表主／本人发起／管理员
            # ＋ 目标当前读权）—— 只换了「值怎么取」，**没换「怎么判」**。
            if _proposal_visible(row, roles):
                n += 1
        counts[st] = n
    return counts


def list_action_proposal_units(proposal_id, row_from=None, row_to=None, offset=None, limit=None):
    """②b 单提案 units（可随机定位）—— 带摘要、不带全文值。

    **返回形状对齐前端契约**（`real-chat.js`）：
    `{proposal, total, items:[{unit_id, label, target:{header,row_id}, value, status, cell_index}]}`。
    早先一版返回 `{total_units, items:[{row,col,header,value_kind,has_value}]}`，
    前端读不到 `label`/`target`/`total` —— 单元标题退化成 `c-0`、邮件卡 units 为空。
    """
    roles = set(frappe.get_roles())
    proposal = frappe.get_doc("Shangshu Action Proposal", proposal_id)
    if not _proposal_visible(proposal, roles):
        frappe.throw("无权读取该提案", frappe.PermissionError)
    payload = _project_proposal_payload(proposal.action_id, _json(proposal.payload_json, {}))['payload']
    units = []
    cells = payload.get("cells")
    if isinstance(cells, list):
        for idx, item in enumerate(cells):
            if not isinstance(item, dict):
                continue
            value = item.get("value") or {}
            units.append({
                "unit_id": str(item.get("unit_id") or "c-%d" % idx),
                "label": str(item.get("label") or item.get("header") or ""),
                "target": {"header": item.get("header"), "row_id": item.get("row_id")},
                "value": value if isinstance(value, dict) else {"type": "text", "value": value},
                "status": str(item.get("status") or "pending").lower(),
                "cell_index": idx,
            })
    matrix = payload.get("matrix")
    if isinstance(matrix, list):
        for r, line in enumerate(matrix):
            if not isinstance(line, list):
                continue
            for c, val in enumerate(line):
                units.append({
                    "unit_id": "m-%d-%d" % (r, c),
                    "label": "",
                    "target": {"header": None, "row_id": "r-%d" % r},
                    "value": (val if isinstance(val, dict) else {"type": "text", "value": val}),
                    "status": "pending",
                    "cell_index": r * 10000 + c,
                })
    total = len(units)
    if row_from is not None or row_to is not None:
        rf = int(row_from or 0)
        rt = int(row_to) if row_to is not None else total
        selected = [u for u in units if rf <= int(u["cell_index"]) < rt]
        off = rf
        lim = rt - rf
    else:
        try:
            off = max(0, int(offset or 0))
            lim = max(1, min(int(limit or 1), 200))
        except (TypeError, ValueError):
            frappe.throw("offset/limit 无效", frappe.ValidationError)
        selected = units[off:off + lim]
    return {"proposal": proposal.name, "total": total, "total_units": total,
            "offset": off, "limit": lim, "items": selected}

def _proposal_directory_item(proposal, roles):
    """Current authorization before a row enters pagination or the response."""
    if not _proposal_eligible(proposal, roles):
        return None
    try:
        _assert_proposal_target(proposal.action_id, _json(proposal.payload_json, {}), 'read', proposal.actor_user)
        _project_proposal_payload(proposal.action_id, _json(proposal.payload_json, {}))
        from shangshu_core.proposal_review import authorize_bound_review
        authorize_bound_review(proposal, 'read')
    except frappe.DoesNotExistError:
        if proposal.status != 'Proposed' or proposal.actor_user != frappe.session.user:
            return None
        from shangshu_core.proposal_review import supports_review, _load
        if not supports_review(proposal.action_id):
            return None
        try:
            _load(proposal.name, 'resolve', decision='rejected')
        except (frappe.PermissionError, frappe.DoesNotExistError, frappe.ValidationError):
            return None
        return _proposal_public(proposal) | {
            'review_access': 'reject_only',
            'review_blocked_reason': '目标记录已不存在，仅可放弃剩余建议；已保存内容保留。',
        }
    except (frappe.PermissionError, frappe.ValidationError):
        return None
    return _proposal_public(proposal)


def list_action_proposals(status="Proposed", after=None, limit=50):
    """Descending keyset pages of authorized proposals, without hidden-row counts."""
    roles = set(frappe.get_roles())
    identity = get_identity()
    page_size = max(1, min(int(limit or 50), 200))
    batch_size = max(50, page_size + 1)
    cursor = after
    result = []
    while len(result) <= page_size:
        rows = frappe.get_all(
            "Shangshu Action Proposal",
            filters={"enterprise_id": identity.enterprise_id,
                     **({"status": status} if status else {}),
                     **_proposal_cursor_where(cursor)},
            fields=["name"], order_by="name desc", limit_page_length=batch_size,
        )
        if not rows:
            break
        for row in rows:
            try:
                proposal = frappe.get_doc("Shangshu Action Proposal", row.name)
            except frappe.DoesNotExistError:
                continue
            item = _proposal_directory_item(proposal, roles)
            if item is not None:
                result.append(item)
                if len(result) > page_size:
                    break
        if len(rows) < batch_size:
            break
        cursor = rows[-1].name
    has_more = len(result) > page_size
    items = result[:page_size]
    return {"items": items, "next_cursor": items[-1]["id"] if has_more else None,
            "has_more": has_more}


def _apply_edited_value(proposal, edited_value):
    """把批准时的改进建议值写进提案载荷，再执行。

    **语义（改要同步改 `test_files_action_proposals.py` P-⑨ / `test_field_access.py` FA-17）**：
    两种形状，判定口径在纯函数 `shangshu_core.field_access.patch_edited_value`（脱离 frappe 可测）：

      · **单值改写** `{type, value}` —— 载荷有 `value` 键就换它；没有但 `cells` 恰好一条
        就换 `cells[0].value`；**多格提案明确拒绝，不猜要改哪一格**。
      · **多字段按名改写** `{字段名: {type, value}, …}` —— 按字段名逐个换（`mail.save_draft`
        的 subject/body 就是这个形状）。**字段名不在载荷里明确拒绝**，点名是哪个。

    裸值（不是带 `type` 的对象）、空对象、混形状一律明确拒绝。

    **为什么在内核做**：以前这一步在 `files/proposals.py` 里由领域模块
    `frappe.get_doc('Shangshu Action Proposal', …)` 直接改 `payload_json` +
    `save(ignore_permissions=True)` —— 领域直写内核表、还关掉权限检查（红线）。
    收进内核后领域模块只传参，权限检查照走。
    """
    from shangshu_core.field_access import patch_edited_value
    raw = _json(proposal.payload_json, {})
    # 合并说明：两边的 edited_value 线上格式**不同**，两种都接 ——
    #   fast ：{'type':'fields','value':{字段名: 值}}，域用 `proposal_editable_fields` 声明可改字段。
    #   FDE  ：{字段名: {'type':..,'value':..}}（或单值 {'type':..,'value':..}），由 patch_edited_value 判形状。
    # `proposal_editable_fields` 是**授权闸**（编号/版本/附件/权限范围不许跟着换），
    # patch_edited_value 是**形状闸**（判不出改哪一格就拒，不猜）——两道都过才改。
    domain, resource = raw_resource('actions', proposal.action_id)
    allowed = set((resource or {}).get('proposal_editable_fields') or [])
    if isinstance(edited_value, dict) and edited_value.get('type') == 'fields':
        updates = edited_value.get('value')
        if not allowed or not isinstance(updates, dict) or not updates or set(updates) - allowed:
            frappe.throw('提案包含未获准人工修改的字段', frappe.PermissionError)
        raw = dict(raw)
        raw.update(updates)
        action = _definition(proposal.action_id, proposal.action_version)
        _assert_payload_matches_schema(raw, _json(action.input_schema_json, {}), proposal.action_id)
    else:
        try:
            raw = patch_edited_value(raw, edited_value)
        except ValueError as error:
            frappe.throw(str(error), frappe.ValidationError)
        if allowed:
            changed = set(edited_value.keys()) if isinstance(edited_value, dict) else set()
            # 单值改写没有字段名可逐项核对（与 fast 的口径一致，不套白名单）；
            # 按字段名改写才逐个字段核对白名单。
            if 'type' not in changed and (not changed or changed - allowed):
                frappe.throw('提案包含未获准人工修改的字段', frappe.PermissionError)
    # **留痕（不许冒领）**：改 `payload_json` 是**覆盖**，而 doctype `track_changes=None`
    # （Frappe 版本历史没开）、`payload_summary_json` 又被 `_summary()` 截断到 500 字 + 脱敏 ——
    # 不另存就「助手原稿查不到、人改过不可辨」，等于**把人的改动冒领成『助手的稿被采用了』**。
    # 所以这里存：改前的**完整**原载荷（不截断）+ 谁改的/改成什么/什么时候。
    if not proposal.original_payload_json:
        proposal.original_payload_json = proposal.payload_json
    proposal.edited_value_json = json.dumps(edited_value, ensure_ascii=False, sort_keys=True)
    proposal.edited_by = frappe.session.user
    proposal.edited_at = now_datetime()
    proposal.payload_json = json.dumps(raw, ensure_ascii=False, sort_keys=True)
    proposal.payload_summary_json = _canonical(_summary(raw))
    proposal.save(ignore_permissions=True)


def get_action_proposal(proposal_id):
    """受管读取一条提案（010-T01 公共部分补缺口）。鉴权口径与 list_action_proposals 一致：
    同企业 + （System Manager | 本人发起 | 动作在自己角色集里）。

    **为什么要有**：list 只能按 status 全量列；按 ID 读单条要自己翻 ——
    前端点开详情、C 的邮件域按 ID 核提案状态都该有一个受管口，不该各自去查表。
    """
    identity = get_identity()
    proposal = frappe.get_doc("Shangshu Action Proposal", proposal_id)
    if proposal.enterprise_id != identity.enterprise_id:
        frappe.throw("当前用户无权读取该提案", frappe.PermissionError)
    roles = set(frappe.get_roles())
    if not _proposal_visible(proposal, roles):
        frappe.throw("当前用户无权读取该提案", frappe.PermissionError)
    # **③ 永不内联 payload**（D 2026-10-17 实测：20k 格提案 1.98MB）——
    # 它是「可用性/恢复」口，全文值只在 `/review` 逐项审核口或显式需要时另取。
    return {**_proposal_public(proposal, include_payload=False),
            **_proposal_review_state(proposal, roles)}


def _proposal_review_state(proposal, roles):
    """可用性头字段（D 2026-10-17 要的 10 个键）—— **不带 units**，只给「能不能审」。

    **为什么单独一坨**：聊天确认卡做「可用性核对 + 逐项步进」**只需要头字段**，
    拉全量 units 是「20000 候选时白拉 5MB」（D 原话）。

    **字段语义**（D 定的）：
      · `status` —— proposed/confirmed/rejected/failed
      · `remaining` / `accepted_count` —— 逐项步进的进度（从 payload 的 units 算）
      · `can_accept` / `can_reject` —— 现在能不能确认/拒绝
      · `accept_unavailable_reason` / `reject_unavailable_reason` —— 不能的话为什么
      · `review_access` / `review_blocked_reason` —— 能不能进审核
      · `review_revision` —— 审核视图的版本号（用于「刷新后不重拉整包」）
    """
    payload = _project_proposal_payload(proposal.action_id, _json(proposal.payload_json, {}))['payload']
    # **units 数量**：`cells`（单格/批量）或 `matrix`（粘贴二维）
    cells = payload.get("cells")
    matrix = payload.get("matrix")
    if isinstance(cells, list):
        total_units = len(cells)
    elif isinstance(matrix, list):
        total_units = sum(len(line) for line in matrix if isinstance(line, list))
    else:
        total_units = 1
    # **已接受数**：payload 里若有 `accepted`/`status` 标记就数；**没有就按状态推**
    # （`Confirmed` = 全部接受，`Proposed` = 0 接受）
    accepted = 0
    if isinstance(cells, list):
        accepted = sum(1 for c in cells if isinstance(c, dict) and str(c.get("status") or "").lower() in ("accepted", "confirmed"))
    if proposal.status == "Confirmed":
        accepted = total_units
    elif proposal.status == "Proposed":
        accepted = accepted   # 按标记数（没标记就是 0）
    remaining = max(0, total_units - accepted)

    # **能不能审**：跟 list 同一鉴权（`_proposal_visible` 已判过，这里只补理由）
    can_accept = proposal.status == "Proposed"
    can_reject = proposal.status == "Proposed"
    accept_reason = "" if can_accept else "提案状态是 %s，不能确认" % proposal.status
    reject_reason = "" if can_reject else "提案状态是 %s，不能拒绝" % proposal.status
    if can_accept:
        try:
            _assert_proposal_definition(proposal, lock=False)
        except (frappe.TimestampMismatchError, frappe.ValidationError):
            can_accept = False
            accept_reason = '字段定义或表结构已变化，或旧提案缺少快照，请重新提议'
    review_access = True   # `_proposal_visible` 已判（进来就是有权）
    review_blocked = "" if review_access else "无审核权限"

    return {
        "status": str(proposal.status or "").lower(),
        "total_units": total_units,
        "remaining": remaining,
        "accepted_count": accepted,
        "can_accept": can_accept,
        "can_reject": can_reject,
        "accept_unavailable_reason": accept_reason,
        "reject_unavailable_reason": reject_reason,
        "review_access": review_access,
        "review_blocked_reason": review_blocked,
        "review_revision": "%s:%s" % (proposal.name, proposal.modified or ""),
    }



def resolve_action_proposal(proposal_id, decision, edited_value=None):
    if decision not in ("confirmed", "rejected"):
        frappe.throw("decision 必须是 confirmed 或 rejected", frappe.ValidationError)
    if edited_value is not None and decision != 'confirmed':
        frappe.throw('edited_value 只在 confirmed 时有意义', frappe.ValidationError)
    proposal = frappe.get_doc("Shangshu Action Proposal", proposal_id, for_update=True)
    # 合并说明：本分支新增了「动作声明了 review_handler 就走逐项审核」的分流
    # （fast 那边没有这一路），它**包含** fast 的整单确认语义 ——
    # 整单确认在逐项审核里就是「确认剩余项」。这里保留本分支的分流。
    from shangshu_core.proposal_review import supports_review, resolve_review_proposal
    if supports_review(proposal.action_id) and (proposal.status == 'Proposed' or proposal.get('review_state_json')):
        return resolve_review_proposal(proposal_id, decision, edited_value)
    identity = get_identity()
    if (proposal.enterprise_id != identity.enterprise_id
            or proposal.actor_user != frappe.session.user):
        frappe.throw("当前用户无权处理该提案", frappe.PermissionError)
    if not _proposal_eligible(proposal, frappe.get_roles()):
        frappe.throw('当前用户无权处理该提案', frappe.PermissionError)
    action = _definition(proposal.action_id, proposal.action_version)
    _assert_action_role(action)
    _assert_proposal_target(proposal.action_id, _json(proposal.payload_json, {}), 'resolve', proposal.actor_user)
    if proposal.status != "Proposed":
        if proposal.status == 'Confirmed':
            raw = _json(proposal.payload_json, {})
            if edited_value is not None:
                from shangshu_core.proposal_edit import patch_edited_value
                try:
                    same = patch_edited_value(raw, edited_value) == raw
                except ValueError as error:
                    frappe.throw(str(error), frappe.ValidationError)
                if not same:
                    frappe.throw('该提案已确认，不能在重试时修改建议，请重新提议', frappe.ValidationError)
            # Recover a lost first response using the existing request and its current
            # domain replay guard. Never create a new action to recover a receipt.
            original_request = action_requests.find_request(proposal.idempotency_key)
            if not original_request or original_request.status != 'Succeeded':
                frappe.throw('已确认但没有可核实的原请求回执，请核对原业务记录', frappe.ValidationError)
            if proposal.reference_execution:
                from shangshu_core.reference_work import authorize_execution_receipt
                authorize_execution_receipt(proposal.reference_execution)
            recovered = execute_registered_action(
                proposal.action_id, raw, confirmed=True,
                idempotency_key=proposal.idempotency_key,
                source=proposal.created_via or 'ai', action_version=proposal.action_version,
                # Existing successful request is locked above; the call retains
                # current role/schema/binding/domain replay checks, without
                # treating a receipt read as another execution on the old lease.
                execution_id=None,
            )
            return _proposal_public(proposal) | {'result': None if _project_proposal_payload(
                proposal.action_id, raw).get('redacted') else recovered.get('result'), 'idempotent': True}
        return _proposal_public(proposal) | {"idempotent": True}
    if decision == 'confirmed':
        if _project_proposal_payload(proposal.action_id, _json(proposal.payload_json, {})).get('redacted'):
            frappe.throw('提案包含当前不可查看的字段，请重新提议可访问范围；本次未保存', frappe.PermissionError)
        _assert_proposal_definition(proposal)
    # 合并说明：fast 那边「已逐项采用过 → 整单确认只确认剩下的项」这一支，
    # 本分支由上面的 `resolve_review_proposal` 分流承担（它用**随序号变化的 op_id**
    # 调 accept_action_proposal_units，所以第二次整单确认仍会确认**新剩下**的项；
    # fast 写死的 op_id 'legacy-confirm-all' 在本分支实现里会被幂等判重而空转）。
    # 这里仍保留 fast 的分支作为兜底，但 op_id 交给 `resolve_review_proposal` 生成。
    if decision == 'confirmed' and _json(proposal.get('review_state_json'), {}).get('accepted'):
        if edited_value is not None:
            frappe.throw('已有逐项确认，请在原审核项中修改剩余值', frappe.ValidationError)
        from shangshu_core.proposal_review import resolve_review_proposal
        receipt = resolve_review_proposal(proposal_id, 'confirmed', None)
        proposal.reload()
        return _proposal_public(proposal) | {'review': receipt, 'result': receipt.get('result'), 'idempotent': False}
    if edited_value is not None:
        _apply_edited_value(proposal, edited_value)
    if decision == "rejected":
        proposal.status = "Rejected"
        proposal.decision_by = frappe.session.user
        proposal.decision_at = now_datetime()
        proposal.save(ignore_permissions=True)
        return _proposal_public(proposal) | {"idempotent": False}
    _assert_proposable(proposal.action_id)
    try:
        prior = getattr(frappe.flags, 'shangshu_resolving_proposal', None)
        conversation_prior = getattr(frappe.flags, 'shangshu_resolving_conversation_key', None)
        frappe.flags.shangshu_resolving_conversation_key = proposal.get('conversation_key') or ''
        frappe.flags.shangshu_resolving_proposal = proposal.name
        try:
            result = execute_registered_action(
                proposal.action_id,
                _json(proposal.payload_json, {}),
                confirmed=True,
                idempotency_key=proposal.idempotency_key,
                source=proposal.created_via or "ai",
                action_version=proposal.action_version,
                execution_id=proposal.reference_execution,
            )
        finally:
            frappe.flags.shangshu_resolving_conversation_key = conversation_prior
            frappe.flags.shangshu_resolving_proposal = prior
        proposal.status = "Confirmed"
        proposal.execution_audit = result.get("audit")
        proposal.error_message = ""
    except Exception as error:
        proposal.status = "Failed"
        proposal.error_message = _human_failure_reason(error)[:1000]
        proposal.decision_by = frappe.session.user
        proposal.decision_at = now_datetime()
        proposal.save(ignore_permissions=True)
        raise
    proposal.decision_by = frappe.session.user
    proposal.decision_at = now_datetime()
    proposal.save(ignore_permissions=True)
    return _proposal_public(proposal) | {"result": result.get("result"), "idempotent": False}


def action_proposal_summary(status=None):
    return {"allowed": True, "counts": count_action_proposals(status), "reason": ""}


def action_proposal_units(proposal_id, row_from=None, row_to=None, offset=None, limit=None):
    data = list_action_proposal_units(proposal_id, row_from=row_from, row_to=row_to, offset=offset, limit=limit)
    return {"allowed": True, **data, "reason": ""}


def get_proposal_validation_snapshot(proposal_id):
    """供领域重验的只读快照；复用提案可见性，不能绕过单条读取。"""
    get_action_proposal(proposal_id)
    proposal = frappe.get_doc("Shangshu Action Proposal", proposal_id)
    result = {key: proposal.get(key) for key in ("name", "action_id", "actor_user", "status")}
    result["payload_json"] = _canonical(_project_proposal_payload(
        proposal.action_id, _json(proposal.payload_json, {}))["payload"])
    return result
