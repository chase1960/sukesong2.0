"""**与 win 沟通的契约层**（设备通道）：令牌哈希 ＋ 凭据校验 ＋ 操作号规矩。

**为什么在内核**（用户 2026-10-22 拍板：Host 与 example 拆干净时一并定的）：
「与 win 沟通的**契约层**（安全通道、凭据校验、事件信封格式）⇒ **放内核**」——
这一层**不属于任何业务域**：谁有设备通道都照这一份规矩来
（Host 域那条设备通道、以后别的域的设备通道，都是同一套）。

**这一层只管三件事**（**纯规则**：不碰 frappe、不碰库、不认识任何域的动作）：
1. **令牌只存哈希**（原令牌只在签发那一次返回一次）；
2. **凭据校验**（生效／令牌对不对／到期没有／动作在不在白名单／设备编号对不对）
   ⇒ 六条**稳定的失败码**（给日志与界面看）；
3. **操作号**（幂等键）的构造规矩。

⚠️ **内核不认识任何域的动作** ⇒ 动作白名单、哪些动作「必须自报设备编号」
**由调用方给进来**（域自己的事）⇒ 换域不用改内核。

**事件信封格式**也在内核（`shangshu_core.events` 那一套）⇒ 同一份契约层。

⚠️ **到期时刻认不出来 ⇒ 按「没填到期」处理**（照搬旧实现的口径，一个字没改）。
旧代码注释里写的「判不出就当过期（fail closed）」与**代码实际行为**对不上
⇒ 那是**另一次**要单独拍板的事，本轮只搬规则、不改口径。
"""

# 凭据校验的**六条失败码**（稳定 ⇒ 日志与界面按它认）。
DEVICE_CREDENTIAL_INACTIVE = "DEVICE_CREDENTIAL_INACTIVE"
DEVICE_CREDENTIAL_INVALID = "DEVICE_CREDENTIAL_INVALID"
DEVICE_CREDENTIAL_EXPIRED = "DEVICE_CREDENTIAL_EXPIRED"
DEVICE_ACTION_NOT_ALLOWED = "DEVICE_ACTION_NOT_ALLOWED"
DEVICE_ID_REQUIRED = "DEVICE_ID_REQUIRED"
DEVICE_ID_MISMATCH = "DEVICE_ID_MISMATCH"
DEVICE_OK = "OK"


def token_hash(token):
    """令牌 → 哈希（**只存哈希**）。

    高熵随机串（32 字节）⇒ sha256 不可逆 ⇒ 就算凭据那一行被读到也推不出原令牌。
    """
    import hashlib

    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _moment(value):
    """把时间认成可比的时刻（认不出来的当没有）。"""
    from datetime import datetime

    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def validate_device_action(credential, token, action_id, payload, moment,
                            device_actions=None, device_scoped=None):
    """这条设备令牌能不能调这个动作（**纯规则**：不碰 frappe、不查库）。

    返回 `{"allowed": bool, "code": str}`；`code` 是稳定的失败原因（给日志与界面看）。

    ⚠️ **动作白名单由调用方给进来**（`device_actions`）——
    内核**不认识任何域的动作** ⇒ 换域不用改内核。
    ⚠️ `device_scoped` 是「哪些动作**必须自报设备编号**」那一组（同样是调用方的事）。
    """
    import hmac

    credential = credential or {}
    if str(credential.get("status") or "") != "生效":
        return {"allowed": False, "code": DEVICE_CREDENTIAL_INACTIVE}
    if not hmac.compare_digest(str(credential.get("token_hash") or ""), token_hash(token)):
        return {"allowed": False, "code": DEVICE_CREDENTIAL_INVALID}
    expires = _moment(credential.get("expires_at"))
    if expires:
        # **判不出到期就当过期**（fail closed）：时刻没给、认不出来 ⇒ 不放行。
        now = _moment(moment)
        if now is None or expires <= now:
            return {"allowed": False, "code": DEVICE_CREDENTIAL_EXPIRED}
    configured = [item.strip() for item in
                  str(credential.get("allowed_actions") or "").replace("，", ",").split(",")
                  if item.strip()]
    allowed = set(configured) & set(device_actions or [])
    if action_id not in allowed:
        return {"allowed": False, "code": DEVICE_ACTION_NOT_ALLOWED}
    if action_id in set(device_scoped or []):
        reported = str((payload or {}).get("device_id") or "").strip()
        bound = str(credential.get("device_id") or "").strip()
        if not reported:
            return {"allowed": False, "code": DEVICE_ID_REQUIRED}
        if reported != bound:
            return {"allowed": False, "code": DEVICE_ID_MISMATCH}
    return {"allowed": True, "code": DEVICE_OK}


#: 操作号（幂等键）**最多能有多长**。
#:
#: **为什么是 140**：统一日志那一张表的「幂等键」列是 Frappe 的 `Data` 型
#: ⇒ 装 140 个字符（`shangshu_unified_log.json` 里那一列没有另外声明长度）。
#: 写不进去 ⇒ 动作当场报错（「will get truncated, as max characters allowed is 140」）
#: ⇒ **调用方看到的是失败，不是「成功但少截了一段」**（这点是好的：宁可报错也不静默丢键）。
#:
#: ⚠️ **这一条是站上实测撞出来的**（2026-10-28）：Host 客户端给的当次号
#: 是「请求号 ＋ 36 字符 UUID ＋ 后缀」，服务端再往前面拼
#: 「`device-client:device-action:` ＋ 动作号 ＋ 设备号」⇒ 整串 139～176 个字符
#: ⇒ **核验那一步直接报错**（Host 收件那一步断在这里）。
KEY_MAX_LENGTH = 140


def device_action_key(action_id, device_id, idempotency_key=None):
    """这次设备调用的**操作号**（幂等键）。

    **为什么不能写死成「动作号」**（实测踩过的坑）：
    · 写死 ⇒ **两台设备共用一把号** ⇒ 后一台报「业务内容已变化，请用新的操作号」；
    · 写死 ⇒ **同一台设备第二次报活会重放第一次的结果** —— 看起来成功，
      其实「最近在线」根本没更新（静默错，最坏的一种）。

    ⇒ 操作号 = 动作 ＋ **设备** ＋ 当次号（调用方给了自己的当次号就用它的，
    那才是它的业务键）。客户端不改、不会给操作号，所以当次号由这里造。

    **当次号太长 ⇒ 压成定长摘要**（2026-10-28 站上实测）：
    整串超过 `KEY_MAX_LENGTH` ⇒ 统一日志那列装不下 ⇒ 动作当场报错。
    ⇒ 超长时**把当次号换成它的 sha256 前 16 位**：
    · **动作号、设备号一个字不动**（人看日志还能认出来是哪台设备、哪个动作）；
    · **幂等语义不变**：同一次调用（同当次号）⇒ 同一个摘要 ⇒ 同一把键；
      不同当次号 ⇒ 摘要不同 ⇒ 不同的键（不会把两次调用误判成重放）。
    """
    import hashlib
    import uuid

    bucket = "device-client:device-action:%s:%s" % (action_id, device_id)
    attempt = str(idempotency_key or uuid.uuid4().hex[:12])
    if len("%s:%s" % (bucket, attempt)) <= KEY_MAX_LENGTH:
        return "%s:%s" % (bucket, attempt)
    # 超长 ⇒ 当次号换成定长摘要（**动作号与设备号保留在前面**）
    digest = hashlib.sha256(attempt.encode("utf-8")).hexdigest()[:16]
    return "%s:%s" % (bucket, digest)
