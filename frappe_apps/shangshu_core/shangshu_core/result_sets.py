"""结果集引用（PKG-018-T08）：会话内的「继续统计刚才那 126 条」。

用户 2026-10-22 拍板的原话：

> 「继续统计刚才那 126 条」涉及数据更新、撤权和过期，**不能只发一个编号** ⇒
> **先做会话内的结果引用与有效性检查；数据变化时明确重新查询**。

所以本模块**不是**「发个编号」—— 编号背后有一份**服务端记录**，用编号时**必须重新核**：

· **存哪**：`frappe.cache`（Redis 缓存，带 TTL）—— **不是数据库表**：
  不落库、不做长期保存、不做跨会话快照；缓存清掉/过期即失效（这是有意的）。
  存的内容是**范围定义**（对象＋筛选＋口径＋当时的行数），**不是结果快照**。
· **怎么防伪**：编号 = `rs_<随机 id>.<内容指纹>`。
  ① 随机 id（128 位）**猜不中** —— 编一个编号，服务端根本没有这条记录；
  ② 内容指纹（sha256）—— 编号被改过一个字节就对不上，当场拒；
  ③ **归属绑定** —— 只有**创建它的那个身份、同一个企业**能用；别人拿到编号也用不了。
  ⚠️ 这里**不用** HMAC 签名：引用要能跨 Web worker 用（不同请求可能落到不同进程），
  进程内密钥会让另一个进程验不过。真正的凭据是**服务端那条记录**，编号只是句柄。
· **怎么失效**：① 数据变了（同一授权同一筛选下**重新计数**，行数对不上就作废）
  ② 权限被撤（重新走一遍受管对象授权，撤了当场拒）
  ③ 受管对象定义升版（修订号对不上就作废）④ 过期（TTL 到点）⑤ 编号被改过 ⑥ 不是你的。

**作废时一律明确说「请重新查询」** —— 不许拿旧结果当新结果，也不许静默按新数据重算。
"""

import hashlib
import hmac
import json
import secrets
import time

import frappe

from shangshu_core import query_receipt
from shangshu_core.identity import get_identity

#: 引用有效期（秒）。引用是**会话内**的短命句柄 —— 不是长期保存、不是跨会话快照。
REF_TTL_SECONDS = 1800
#: 缓存键前缀（**可丢弃的派生**，不是事实表）。
CACHE_PREFIX = "fde:t08:result_set:"

_FINGERPRINT_KEYS = ("owner", "enterprise_id", "object_id", "revision", "kind",
                     "criteria", "matched_total", "created_at", "extra")


def _canonical(entry):
    return json.dumps({key: entry.get(key) for key in _FINGERPRINT_KEYS},
                      ensure_ascii=False, sort_keys=True, default=str)


def _fingerprint(entry):
    """内容指纹：编号里带的那一截。**改一个字节就对不上** ⇒ 编号被改过能当场发现。"""
    return hashlib.sha256(_canonical(entry).encode("utf-8")).hexdigest()[:12]


def _note(based_on=None):
    return {
        "expires_in_seconds": REF_TTL_SECONDS,
        "based_on": based_on,
        "note": "这是会话内的结果范围引用：数据变了、权限被撤、对象定义升版或过期都会作废；"
                "作废时请重新查询（不要沿用旧数字）",
    }


def issue(*, object_id, revision, criteria, matched_total, kind="aggregate", based_on=None,
          extra=None):
    """发一个可引用的编号（**范围定义**，不是结果快照）。

    `criteria` —— 这次的范围口径：`{"filters": {...}, "scope": "active"}`。
    `matched_total` —— 这次范围里的行数（**用来判断数据有没有变**）。
    `extra` —— 随引用一起记下的**附加口径**（例如指标定义的指纹）：
      它变了 ⇒ 引用也作废（口径变了，旧引用不能继续用）。
    """
    identity = get_identity()
    entry = {
        "id": secrets.token_urlsafe(16),
        "owner": identity.user,
        "enterprise_id": identity.enterprise_id,
        "object_id": object_id,
        "revision": revision,
        "kind": str(kind or "aggregate"),
        "criteria": criteria or {},
        "matched_total": matched_total,
        "created_at": int(time.time()),
        "extra": extra or None,
    }
    entry["fingerprint"] = _fingerprint(entry)
    frappe.cache.set_value(CACHE_PREFIX + entry["id"], entry, expires_in_sec=REF_TTL_SECONDS)
    block = {"ref": "rs_%s.%s" % (entry["id"], entry["fingerprint"]),
             "object_id": object_id, "kind": entry["kind"],
             "matched_total": matched_total,
             "created_at": entry["created_at"]}
    block.update(_note(based_on))
    return block


def _parse(ref):
    if not isinstance(ref, str) or not ref.startswith("rs_") or "." not in ref:
        frappe.throw("结果集引用格式不对（要用统计结果里返回的 rs_… 编号）；请重新查询",
                     frappe.ValidationError)
    body, fingerprint = ref[3:].split(".", 1)
    if not body or not fingerprint:
        frappe.throw("结果集引用格式不对（要用统计结果里返回的 rs_… 编号）；请重新查询",
                     frappe.ValidationError)
    return body, fingerprint


def lookup(ref):
    """按编号取出**服务端那条记录**（不核数据是否变了）。

    这一步核的是：**编号存在吗／被改过吗／是你的吗／过期了吗**。
    """
    body, fingerprint = _parse(ref)
    entry = frappe.cache.get_value(CACHE_PREFIX + body)
    if not entry:
        frappe.throw("这个结果集引用不存在或已过期；请重新查询", frappe.ValidationError)
    if not hmac.compare_digest(str(entry.get("fingerprint") or ""), fingerprint):
        frappe.throw("这个结果集引用的内容对不上（可能被改过）；请重新查询", frappe.ValidationError)
    identity = get_identity()
    if entry.get("owner") != identity.user:
        frappe.throw("这个结果集引用不是你的，不能用；请自己重新查询", frappe.PermissionError)
    if entry.get("enterprise_id") != identity.enterprise_id:
        frappe.throw("这个结果集引用属于别的企业，不能用；请重新查询", frappe.PermissionError)
    if int(time.time()) - int(entry.get("created_at") or 0) > REF_TTL_SECONDS:
        frappe.throw("这个结果集引用已过期；请重新查询", frappe.ValidationError)
    return entry


def assert_fresh(entry):
    """**有效性检查**：数据变了／定义升版／权限被撤 ⇒ 引用作废，要求重新查询。

    ⚠️ 这里的「重新计数」走的是**同一套授权与筛选**（`model_records.count_matching`）
    ⇒ 数出来的行数和当初那个数**同口径**，对得上才说明范围没变。
    """
    from shangshu_core import model_records
    object_id = entry.get("object_id")
    try:
        state = model_records.object_state(object_id)
    except frappe.PermissionError as error:
        frappe.throw("这个结果集引用作废了（权限已变或已撤销：%s）；请重新查询" % error,
                     frappe.PermissionError)
    if str(state.get("revision")) != str(entry.get("revision")):
        frappe.throw("这个结果集引用作废了（受管对象的定义已升版：原来第 %s 版，现在是第 %s 版）；"
                     "请重新查询" % (entry.get("revision"), state.get("revision")),
                     frappe.ValidationError)
    criteria = entry.get("criteria") or {}
    # ⚠️ **口径要和签发时一模一样**（2026-10-27 夜 · PKG-132 · 审查报告 R22）：
    #   签发时把搜索词**单独**存进 `criteria["search"]`（不在 filters 里），
    #   这里若只按 filters 计数 ⇒ 拿「这个范围的总数」去比「刚才那 10 条」
    #   ⇒ **误判成「数据已变化」**（或反过来，把变了的数据说成没变）。
    #   ⇒ 把搜索词**按同一形状**放回条件里再数（与 `query_records` 的合并同一条路）。
    filters = dict(criteria.get("filters") or {})
    search = criteria.get("search")
    if search and not filters.get("$search"):
        filters["$search"] = search
    try:
        count = model_records.count_matching(object_id, filters,
                                              criteria.get("scope"))
    except frappe.PermissionError as error:
        frappe.throw("这个结果集引用作废了（权限已变或已撤销：%s）；请重新查询" % error,
                     frappe.PermissionError)
    original = entry.get("matched_total")
    if count is not None and original is not None and int(count) != int(original):
        frappe.throw("这个结果集引用作废了（数据已变化：原来这个范围是 %s 条，现在是 %s 条）；"
                     "请重新查询后再统计" % (original, count), frappe.ValidationError)
    _assert_extra_fresh(entry)
    return entry


def _assert_extra_fresh(entry):
    """**附加口径变了**（例如指标定义改版）⇒ 引用作废，要求重新查询。"""
    extra = entry.get("extra") or {}
    metric = extra.get("metric")
    if not metric:
        return
    from shangshu_core import metric_registry
    state = metric_registry.current_state(metric.get("metric_name"))
    if state is None:
        frappe.throw("这个结果集引用作废了（它依赖的指标 %s 已停用或被删）；请重新查询"
                     % metric.get("metric_name"), frappe.ValidationError)
    if state["definition_hash"] != metric.get("definition_hash"):
        frappe.throw("这个结果集引用作废了（指标 %s 的定义已改版：原来第 %s 版，现在是第 %s 版）；"
                     "请重新查询" % (metric.get("metric_name"), metric.get("definition_version"),
                                    state["definition_version"]),
                     frappe.ValidationError)


def resolve(ref, check_fresh=True):
    """把编号还原成**范围定义**（并核有效性）。作废时当场抛错并要求重新查询。"""
    entry = lookup(ref)
    if check_fresh:
        assert_fresh(entry)
    return entry


def describe(ref):
    """单独问一句「这个编号还准不准」（**不抛错**，返回状态与原因）。

    ⚠️ 这是**检查口**：用来告诉调用方「要重新查了」；**用它去查数据时仍然会拒**
    （`resolve` 那条路才拿数据）。
    """
    status = {"ref": ref, "valid": False, "reason": "", "object_id": None, "kind": None,
              "matched_total": None, "criteria": None, "created_at": None,
              "expires_in_seconds": REF_TTL_SECONDS}
    try:
        entry = resolve(ref)
    except frappe.ValidationError as error:
        status["reason"] = str(error)
        return _with_receipt(status)
    except frappe.PermissionError as error:
        status["reason"] = str(error)
        return _with_receipt(status)
    status.update({"valid": True, "reason": "引用有效：范围、数据与权限都还对得上",
                   "object_id": entry.get("object_id"), "kind": entry.get("kind"),
                   "matched_total": entry.get("matched_total"),
                   "criteria": entry.get("criteria"),
                   "created_at": entry.get("created_at")})
    return _with_receipt(status)


def _with_receipt(status):
    """状态也带回执（与其它查询同一套结构：查到了什么、什么口径、什么异常）。"""
    exceptions = []
    if not status.get("valid"):
        exceptions.append({"code": "result_set_unusable",
                           "message": status.get("reason") or "这个结果集引用不能用了；请重新查询"})
    receipt = query_receipt.build_receipt(
        object_id=status.get("object_id") or "", object_name="", domain_id="com.shangshu.core",
        matched_total=status.get("matched_total"), returned_rows=0, page=1, page_length=None,
        filters={}, search="", sort="", direction="", scope="active", counting="row",
        exact=status.get("valid"), details_complete=None, aggregate_complete=None,
        exceptions=exceptions)
    receipt["criteria"]["result_set"] = {"ref": status.get("ref"), "valid": bool(status.get("valid"))}
    status["receipt"] = receipt
    return status
