"""指标注册（PKG-018-T09）：**轻量**定义 ——「统计什么、按哪个日期、如何去重」。

用户 2026-10-22 拍板的原话：

> 「完整指标平台会扩大成建模、配置、版本和管理界面 ⇒ **先做轻量定义**，
> 由 FDE 配置『统计什么、按哪个日期、如何去重』；管理界面后放」。

所以本模块只做三件事：

· **登记**：FDE 写一条「指标名 → 口径」的轻量定义。
  **存哪**：**内核自己的一份表**（`Shangshu Metric Definition`）—— 域能用，
  **但不由域抄一份**（抄了就成两套口径）。
· **按名字跑**：定义登记后，用指标名就能跑出统计结果 ——
  走的是**同一套**统计口径（`shangshu_core.analysis` ＋ `model_records.aggregate_records`）。
· **口径变了看得出来**：每次结果都带**定义版本 ＋ 内容指纹**；定义一改，
  指纹就变、旧结果里带的是旧指纹；**之前发的结果集引用也会作废**（要求重新查询）。

**谁能登记**：**系统管理员**（`System Manager`）—— 这是配置面，不是人人能改的口径。
**谁能跑**：普通员工（`Desk User`）—— 跑的时候**照旧按调用方的权限算**
（无权字段不许用于筛选/分组/去重/求和）。

**不做**（用户明说后放）：建模、配置版本流、管理界面、指标目录治理、跨会话快照。
"""

import hashlib
import json
import re

import frappe

from shangshu_core import analysis
from shangshu_core import model_records
from shangshu_core.identity import get_identity

METRIC = "Shangshu Metric Definition"

#: 指标名：小写字母开头的字母数字下划线（与字段 ID 同一套规矩）。
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")

_CONTENT_KEYS = ("object_id", "metrics", "date_field", "distinct_field", "filters")


# ---------- 口径指纹 ----------

def definition_hash(content):
    """定义内容的**指纹**（口径变了它就变 —— 这是「口径变了看得出来」的凭据）。

    ⚠️ 指纹**只按存下来的内容**算（登记时存什么，这里就算什么）⇒
    表里的 `definition_hash` 与任何时候重算的结果**一致**。
    """
    payload = json.dumps({key: content.get(key) for key in _CONTENT_KEYS},
                         ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def stored_content(doc):
    """从**存下来的那条定义**取内容（指纹与登记时算的同一份）。"""
    return {"object_id": doc.object_id,
            "metrics": json.loads(doc.metrics_json or "[]"),
            "date_field": doc.date_field or None,
            "distinct_field": doc.distinct_field or None,
            "filters": json.loads(doc.filters_json or "{}")}


# ---------- 登记 ----------

def _require_manager():
    if "System Manager" not in set(frappe.get_roles()):
        frappe.throw("只有系统管理员能登记指标", frappe.PermissionError)


def _content_of(payload):
    """把登记载荷 ⇒ **定义内容**（只留口径本身；呈现类的字段不进内容）。"""
    metrics = payload.get("metrics") or [{"op": "count_rows"}]
    if not isinstance(metrics, list):
        frappe.throw("指标写法不对（要是一个列表）", frappe.ValidationError)
    filters = payload.get("filters") or {}
    if not isinstance(filters, dict):
        frappe.throw("固定条件写法不对（要是一个对象）", frappe.ValidationError)
    return {"object_id": str(payload.get("object_id") or "").strip(),
            "metrics": metrics,
            "date_field": str(payload.get("date_field") or "").strip() or None,
            "distinct_field": str(payload.get("distinct_field") or "").strip() or None,
            "filters": filters}


def _build_metrics(metrics, distinct_field):
    """定义里的指标 ＋ 「按哪个字段去重」自动带来的那条去重指标。"""
    plan = [dict(item) for item in (metrics or [])]
    if distinct_field and not any(item.get("op") == "count_distinct"
                                   and item.get("field") == distinct_field for item in plan):
        plan.append({"op": "count_distinct", "field": distinct_field})
    if len(plan) > analysis.MAX_AGGREGATE_METRICS:
        frappe.throw("一次最多 %d 个指标：这个指标加上「按 %s 去重」一共 %d 个；请调整指标"
                     % (analysis.MAX_AGGREGATE_METRICS, distinct_field, len(plan)),
                     frappe.ValidationError)
    return plan


def _validate(content):
    """登记**当场核**：字段存不存在、有没有权限、类型对不对（不把「无权」说成「没有」）。

    ⚠️ 口径规则**只有一份**（`shangshu_core.analysis`）—— 这里不另写一套指标规则。
    """
    object_id = content["object_id"]
    if not object_id:
        frappe.throw("请说明这个指标统计哪一个受管对象", frappe.ValidationError)
    used = []
    for item in content["metrics"]:
        if not isinstance(item, dict):
            frappe.throw("指标写法不对", frappe.ValidationError)
        if item.get("field"):
            used.append(item["field"])
    if content["date_field"]:
        used.append(content["date_field"])
    if content["distinct_field"]:
        used.append(content["distinct_field"])
    used.extend(content["filters"].keys())
    # 权限与「有没有这个字段」由内核那一侧分清（与统计同一把尺子）。
    field_types = model_records.check_fields_usable(object_id, used)
    if content["date_field"] and field_types.get(content["date_field"]) not in analysis.DATE_FIELD_TYPES:
        frappe.throw("「按哪个日期」指定的字段 %s 不是日期字段" % content["date_field"],
                     frappe.ValidationError)
    if content["distinct_field"] and field_types.get(content["distinct_field"]) not in analysis.DISTINCT_FIELD_TYPES:
        frappe.throw("「如何去重」指定的字段 %s 不能做去重计数" % content["distinct_field"],
                     frappe.ValidationError)
    plan = _build_metrics(content["metrics"], content["distinct_field"])

    def _guard(field):
        if field not in field_types:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)

    try:
        analysis.plan_metrics(plan, field_types, guard=_guard)
        analysis.normalize_filters(content["filters"], field_types, guard=_guard)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)
    return plan


def define(payload):
    """登记/改一条指标定义（**系统管理员**）。"""
    _require_manager()
    payload = payload or {}
    name = str(payload.get("metric_name") or "").strip()
    if not NAME_RE.match(name):
        frappe.throw("指标名要用小写字母开头的字母数字下划线（例如 amount_total）",
                     frappe.ValidationError)
    content = _content_of(payload)
    plan = _validate(content)
    identity = get_identity()
    existing = frappe.db.exists(METRIC, name)
    doc = frappe.get_doc(METRIC, name) if existing else frappe.get_doc({
        "doctype": METRIC, "metric_name": name, "definition_version": 0})
    doc.title = str(payload.get("title") or "").strip() or doc.get("title") or name
    doc.object_id = content["object_id"]
    doc.metrics_json = json.dumps(plan, ensure_ascii=False, sort_keys=True)
    doc.definition_hash = ""
    doc.date_field = content["date_field"]
    doc.distinct_field = content["distinct_field"]
    doc.filters_json = json.dumps(content["filters"], ensure_ascii=False, sort_keys=True)
    doc.active = 1 if payload.get("active", True) else 0
    doc.definition_version = int(doc.definition_version or 0) + 1
    doc.owner_user = identity.user
    doc.enterprise_id = identity.enterprise_id
    if existing:
        doc.save(ignore_permissions=True)
    else:
        doc.insert(ignore_permissions=True)
    stored = stored_content(doc)
    return {"metric_name": name, "title": doc.title, "object_id": doc.object_id,
            "definition_version": int(doc.definition_version),
            "definition_hash": definition_hash(stored), "active": int(doc.active or 0),
            "metrics": plan, "date_field": doc.date_field, "distinct_field": doc.distinct_field,
            "created": not existing}


# ---------- 读 ----------

def load(metric_name):
    """按名字取一条定义（**不存在/停用** ⇒ 明确报错，不静默当空）。"""
    name = str(metric_name or "").strip()
    if not name:
        frappe.throw("请给出指标名", frappe.ValidationError)
    if not frappe.db.exists(METRIC, name):
        frappe.throw("没有这个指标：%s（请先登记，或换个名字）" % name, frappe.ValidationError)
    doc = frappe.get_doc(METRIC, name)
    if not int(doc.active or 0):
        frappe.throw("这个指标已停用：%s" % name, frappe.ValidationError)
    content = stored_content(doc)
    return {"metric_name": name, "title": doc.title, "definition_version": int(doc.definition_version or 1),
            "definition_hash": definition_hash(content), "owner_user": doc.owner_user,
            "content": content}


def current_hash(metric_name):
    """当前定义的内容指纹（**停用/不存在** ⇒ None）—— 引用失效检查用。"""
    state = current_state(metric_name)
    return state["definition_hash"] if state else None


def current_state(metric_name):
    """当前定义的**版本与指纹**（**停用/不存在** ⇒ None）。"""
    try:
        definition = load(metric_name)
    except (frappe.ValidationError, frappe.DoesNotExistError):
        return None
    return {"definition_version": definition["definition_version"],
            "definition_hash": definition["definition_hash"]}


def list_definitions():
    """指标清单（**只给口径摘要**，不含任何业务数据）。"""
    result = []
    for row in frappe.get_all(METRIC, fields=["name", "title", "object_id", "definition_version",
                                              "date_field", "distinct_field", "active",
                                              "owner_user"],
                              order_by="metric_name asc"):
        content = {"object_id": row.object_id, "metrics": [], "date_field": row.date_field,
                   "distinct_field": row.distinct_field, "filters": {}}
        try:
            content = stored_content(frappe.get_doc(METRIC, row.name))
        except Exception:
            pass
        result.append({"metric_name": row.name, "title": row.title, "object_id": row.object_id,
                       "definition_version": int(row.definition_version or 1),
                       "definition_hash": definition_hash(content),
                       "date_field": row.date_field, "distinct_field": row.distinct_field,
                       "active": int(row.active or 0), "owner_user": row.owner_user})
    return result


# ---------- 跑 ----------

def run(payload):
    """按名字跑一个指标（**普通员工可跑**，但结果照旧按调用方的权限算）。"""
    payload = payload or {}
    definition = load(payload.get("metric_name"))
    content = definition["content"]
    filters = dict(content.get("filters") or {})
    for key, value in (payload.get("filters") or {}).items():
        if key in filters and filters[key] != value:
            frappe.throw("本次条件与指标定义里的固定条件冲突（%s：定义里是 %s，本次是 %s）；"
                         "请改条件或改定义" % (key, filters[key], value), frappe.ValidationError)
        filters[key] = value
    date_from = payload.get("date_from")
    date_to = payload.get("date_to")
    if date_from or date_to:
        date_field = content.get("date_field")
        if not date_field:
            frappe.throw("这个指标没有声明「按哪个日期」；不能按日期区间统计。"
                         "请重新登记指标或换个口径", frappe.ValidationError)
        if date_field in filters:
            frappe.throw("这个指标已经带了 %s 的固定条件；不能同时再按日期区间统计；"
                         "请改条件或改定义" % date_field, frappe.ValidationError)
        # ⚠️ 一个字段**可以带多个条件**（区间）—— 口径规则在 `shangshu_core.analysis` 里。
        conditions = []
        if date_from:
            conditions.append({"op": "gte", "value": date_from})
        if date_to:
            conditions.append({"op": "lte", "value": date_to})
        filters[date_field] = conditions
    metrics = _build_metrics(content.get("metrics"), content.get("distinct_field"))
    result = model_records.aggregate_records(
        content["object_id"], filters, metrics, payload.get("group_by") or None,
        payload.get("scope") or None, payload.get("result_set") or None,
        ref_extra={"metric": {"metric_name": definition["metric_name"],
                              "definition_hash": definition["definition_hash"],
                              "definition_version": definition["definition_version"]}})
    block = {"metric_name": definition["metric_name"], "title": definition["title"],
             "definition_version": definition["definition_version"],
             "definition_hash": definition["definition_hash"],
             "date_field": content.get("date_field"),
             "distinct_field": content.get("distinct_field"),
             "metrics": metrics,
             "note": "口径自证：这次用的是第 %s 版定义（指纹 %s）；定义一改指纹就变"
                     % (definition["definition_version"], definition["definition_hash"])}
    result["receipt"]["metric"] = block
    result["metric"] = block
    if isinstance(result.get("result_set"), dict):
        result["result_set"]["metric"] = {"metric_name": block["metric_name"],
                                           "definition_hash": block["definition_hash"],
                                           "definition_version": block["definition_version"]}
        if isinstance(result["receipt"].get("result_set"), dict):
            result["receipt"]["result_set"]["metric"] = result["result_set"]["metric"]
    return result
