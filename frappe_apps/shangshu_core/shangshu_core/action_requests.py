"""动作请求占位与完整结果；与业务写入同事务，不在 executor 内提交。

例外：失败记账在业务副作用已回滚后可单独提交（仅当进入本动作时事务干净），
让“这次试过、没成功”事后可查；嵌套调用不提交，随外层一起回滚。
"""

import hashlib
import json

import frappe
from frappe.utils.password import decrypt, encrypt


DOCTYPE = "Shangshu Action Request"


def request_name(key):
    return hashlib.sha256(str(key).encode("utf-8")).hexdigest()


# 业务关键字段 —— **永不进「可排除」名单**（§9.1）：含所有人、归属变更或授权效果的参数
# 是**业务内容**，不能当审计字段剔除；`attribution` 含归属层级/部门/所有人，影响授权判定。
# 没有这道闸，把业务字段起名叫 `client_timestamp` 就能绕过「是不是同一次」的比对。
BUSINESS_CRITICAL_KEYS = frozenset({
    "attribution", "owner", "owner_subject", "owner_subject_kind", "directory", "directory_id",
    "value", "cells", "file", "content", "subject", "body", "text",
    "target", "op_id", "action", "detail", "relations", "tags", "note",
})


def audit_keys_of(schema_properties):
    """从动作 schema 收「审计上下文」字段名：显式标了 `ss_role='audit'` 的那些。

    **不按名字猜** —— 名字带 `metadata`/`timestamp` 不算数，必须动作定义明说。
    未声明的动作 = 什么都不排除（保守默认：宁可多比对，不可漏比对）。
    """
    keys = set()
    for key, spec in (schema_properties or {}).items():
        if isinstance(spec, dict) and spec.get("ss_role") == "audit":
            # 双保险：业务关键字段即使被误标成 audit 也不许排除
            if key not in BUSINESS_CRITICAL_KEYS:
                keys.add(key)
    return frozenset(keys)


def fingerprint(payload, audit_keys=()):
    """业务指纹 —— 只哈希「要办的那半」。审计上下文随行落账、**不进比对**。

    口径（用户 2026-10-14 拍板）：
      ① 业务内容（附件/文字/值/目标/归属/授权效果…）→ **参与**，变了就是换了件事
      ② 审计上下文（谁操作的描述、几点、追踪号…）  → **不参与**，跟着走
      ③ 身份/权限作用域（actor_identity/enterprise/当前授权）→ **独立恒判**，不进指纹

    ⚠️ ③ 不在这里比，也不因为「不进指纹」就被移除 —— 见 `assert_binding`。
    """
    drop = frozenset(audit_keys) - BUSINESS_CRITICAL_KEYS
    try:
        trimmed = ({k: v for k, v in payload.items() if k not in drop}
                   if isinstance(payload, dict) and drop else payload)
        text = json.dumps(trimmed, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        frappe.throw("动作输入必须是有效 JSON", frappe.ValidationError)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def find_request(key):
    name = request_name(key)
    if frappe.db.exists(DOCTYPE, name):
        return frappe.get_doc(DOCTYPE, name, for_update=True)
    return None


def assert_binding(request, identity, action_id, version, payload, audit_keys=(), allow_version_drift=False):
    """校验「同一个键」是不是同一件事。**分层报因**，不许一律报「键被占用」。

    ③ 身份/权限作用域 **独立恒判** —— 跨人/跨企业不许重放、不许返回他人结果。
       「日志里的操作人描述不参与比对」**不等于**移除认证主体（§9.1）。

    ⚠️ **`allow_version_drift`**（2026-10-30 · PKG-133 · W2）：**只给「失败过的那次」用**。
       失败那次的业务副作用**整体回滚**了（见 `reserve` 的说明）⇒ 动作版本在这期间
       被重新登记过（版本进位）时，允许**改绑到当前版本**。
       ⇒ 否则一把旧键会被**永久**钉死在那个已经不存在的版本上 ⇒ 人看到的却是
       「动作未注册或已停用」（说的是**动作**，其实是**版本**）—— 误导，且解不开。
       ⚠️ **成功过的请求不给这个口**（`allow_version_drift=False`）⇒ 重放仍钉死原版本。
    """
    if request.actor_identity != identity.name or request.enterprise_id != identity.enterprise_id:
        frappe.throw("请求作用域不符（不是同一身份/企业），不得跨人重放", frappe.DuplicateEntryError)
    if request.action_id != action_id or request.action_version != version:
        # 混版报错要点名哪一侧旧（PKG-013-T05）：先前只说「版本不同」，排查得两头翻账。
        # 版本号不同能判谁旧就点名；是「换了动作」则分开说，别混成一句。
        if request.action_version != version:
            if not allow_version_drift:
                from shangshu_core.field_access import version_conflict_note
                frappe.throw(version_conflict_note(action_id, request.action_version, version),
                             frappe.DuplicateEntryError)
            # —— **失败过的那次**：允许改绑到当前版本（副作用已回滚 ⇒ 重新执行是干净的）。
            request.action_version = version
        else:
            frappe.throw("动作不同（库里 %s / 这次 %s），不是同一次请求" % (request.action_id, action_id),
                         frappe.DuplicateEntryError)
    if request.request_hash != fingerprint(payload, audit_keys):
        frappe.throw("业务内容已变化，请用新的操作号", frappe.DuplicateEntryError)


def reserve(key, identity, action_id, version, payload, audit_keys=(), allow_version_drift=False):
    """唯一主键在 handler 之前插入；并发竞争等待该业务事务提交或回滚。

    已失败的请求允许同一键重新执行：失败那次的业务副作用已整体回滚，没有任何写入落地。

    ⚠️ **`allow_version_drift`**（2026-10-30 · PKG-133 · W2）：**只给「钉在已经不存在的版本上」
       的请求**用（调用方已经查过：那个版本没注册了 ⇒ 这次请求**本来就不可能按原版本重放**）。
       ⇒ 允许改绑到当前版本 ⇒ 否则一把旧键会被**永久**钉死 ⇒ 人看到的却是
       「动作未注册或已停用」（说的是**动作**，其实是**版本**）—— 误导，且解不开。
       ⚠️ **成功过的请求不给这个口**（调用方也不会给：成功过的版本一定还在）。
    """
    from shangshu_core.transaction_failure import assert_transaction_healthy
    assert_transaction_healthy()
    existing = find_request(key)
    if existing:
        # ⚠️ **失败过/未完成的那次**允许改绑到当前版本（副作用已回滚或从未发生 ⇒ 重跑是干净的）；
        #   **成功过的**仍钉死原版本（重放不许悄悄换语义）。
        assert_binding(existing, identity, action_id, version, payload, audit_keys,
                       allow_version_drift=allow_version_drift and existing.status != "Succeeded")
        if existing.status == "Failed":
            existing.status = "Running"
            existing.failure_reason = ""
            existing.save(ignore_permissions=True)
            return existing, True
        return existing, False
    point = "action_reserve_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        request = frappe.get_doc({
            "doctype": DOCTYPE, "request_key": request_name(key),
            "action_id": action_id, "action_version": version,
            "actor_identity": identity.name, "enterprise_id": identity.enterprise_id,
            "request_hash": fingerprint(payload, audit_keys), "status": "Running",
        }).insert(ignore_permissions=True)
        return request, True
    except frappe.DuplicateEntryError:
        frappe.db.rollback(save_point=point)
        request = frappe.get_doc(DOCTYPE, request_name(key), for_update=True)
        assert_binding(request, identity, action_id, version, payload, audit_keys)
        return request, False


def fail(request, reason):
    """标记该次尝试失败；业务副作用已在 savepoint 回滚，没有任何写入需要保留。"""
    from shangshu_core.transaction_failure import assert_transaction_healthy
    assert_transaction_healthy()
    request.status = "Failed"
    request.failure_reason = str(reason or "").strip()[:500]
    request.result_ciphertext = ""
    request.execution_audit = None
    request.save(ignore_permissions=True)


def replay(request):
    if request.status != "Succeeded":
        frappe.throw("该动作仍在执行或需要恢复，请勿重复执行", frappe.ValidationError)
    # 完整结果加密保存；不能从截断/脱敏审计反推执行结果。
    result = json.loads(decrypt(request.result_ciphertext))
    return {"action_id": request.action_id, "action_version": request.action_version,
            "result": result, "audit": request.execution_audit, "idempotent": True}


def peek_result(request):
    """给重放守卫用：只读出缓存结果，**不**当作响应放行。

    新建类动作（比如「保存草稿」首次建一封）的载荷里没有对象编号 —— 对象是那次
    才建出来的。守卫要复核「现在还归不归你」，就得先认出刚建的那个是谁，
    所以需要这一条窥视通道。结果本身仍然不给未授权方：守卫判无权就整请求拒。
    """
    if request is None or request.status != "Succeeded" or not request.result_ciphertext:
        return None
    try:
        return json.loads(decrypt(request.result_ciphertext))
    except Exception:
        return None


def succeed(request, result):
    from shangshu_core.transaction_failure import assert_transaction_healthy
    assert_transaction_healthy()
    from frappe.utils.response import json_handler

    serialized = json.dumps(result["result"], ensure_ascii=False, allow_nan=False, default=json_handler)
    request.result_ciphertext = encrypt(serialized)
    request.execution_audit = result["audit"]
    request.status = "Succeeded"
    request.save(ignore_permissions=True)
    # 使用与 HTTP 一致的 JSON 值，日期/Decimal 首次和重试也保持一致。
    result["result"] = json.loads(serialized)
