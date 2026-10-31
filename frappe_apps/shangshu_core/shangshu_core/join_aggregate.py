"""跨表 JOIN（PKG-018-T10）：只支持**已明确声明的关联**。

用户 2026-10-22 拍板的原话：

> 「一对多关联容易重复计数，两边权限也必须一起检查 ⇒ **先支持已明确声明的关联**；
> 让模型自由猜关联、任意拼表可以后放」

所以本模块**只认一种关联**：**受管对象定义里声明的引用字段**（`type=reference`，
带 `target`）。其它关联（猜出来的、自己拼的、临时对上的）**一律拒**。

**两条硬规矩**：

① **重复计数** —— 调用方**必须显式声明**这条关联的基数（`cardinality`），
   而且声明必须与**关联声明的方向**对得上，对不上 ⇒ 当场拒（不给出一个错的数）：

   · `declared_on=self`（左端的引用字段指向右端）：每行左端**至多**一行右端
     ⇒ 基数只能是 `one_to_one`；左端行数与配对数相同（**不膨胀**）。
   · `declared_on=target`（右端的引用字段指向左端）：一行左端可能对应**多行**右端
     ⇒ 基数只能是 `one_to_many`：**右端按展开算**，**左端每个行只算一次**（取一端）。
   · 回执写明：左右两端各自按什么算、基础行数、展开后的配对数、膨胀倍数。

② **两边权限** —— 左端、右端**都要查**（对象级、字段级、记录级）：
   · 读不到**关联对象** ⇒ 整条拒（不因为左端能读就放过另一侧）；
   · 右端某条记录看不到（记录范围＝只看本人）⇒ **剔除并报出条数**（不静默丢）；
   · 用了没权限的字段（任意一侧）⇒ 当场拒。

⚠️ **指标怎么算只有一份**（`shangshu_core.analysis`）—— 两边都用同一个
`plan_metrics` / `compute`，不另写一套。
"""

from pypika import Criterion
from pypika.functions import Count

import frappe

from shangshu_core import analysis
from shangshu_core import model_records
from shangshu_core import query_receipt

#: 一次关联统计最多几个指标（**左右合计**）—— 与普通统计同一把尺子。
MAX_JOIN_METRICS = analysis.MAX_AGGREGATE_METRICS
#: 反向关联时，左端行名进 `IN` 子句的上限（太大就别拼了，让人先缩小范围）。
MAX_JOIN_KEYS = 5000


def _side_of(item):
    return str(item.get("side") or "left")


def _plan(metrics, field_types, guard, side):
    """一侧的指标 ⇒ 归一化后的计划（口径只有一份）。"""
    try:
        return analysis.plan_metrics(metrics, field_types, guard=guard)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)


def _prefixed(plan, computed, side):
    """把一侧算出来的指标**加上侧别前缀**（`left_count_rows` / `right_sum_cost`）——
    两边同名字段不会撞。"""
    names = {item["name"]: "%s_%s" % (side, item["name"]) for item in plan}
    metrics = {names.get(key, "%s_%s" % (side, key)): value for key, value in computed["metrics"].items()}
    groups = []
    for group in computed["groups"]:
        groups.append({"group": group["group"],
                       "metrics": {names.get(key, "%s_%s" % (side, key)): value
                                   for key, value in group["metrics"].items()}})
    return metrics, groups


def join_aggregate(payload):
    """按**声明过的关联**做跨对象统计。"""
    payload = payload or {}
    left_id = str(payload.get("object_id") or "").strip()
    join = payload.get("join") or {}
    right_id = str(join.get("target_object_id") or "").strip()
    field = str(join.get("field") or "").strip()
    declared_on = str(join.get("declared_on") or "").strip()
    cardinality = str(payload.get("cardinality") or "").strip()
    if not left_id or not right_id or not field:
        frappe.throw("请说清左端对象、关联对象与关联字段", frappe.ValidationError)
    if declared_on not in ("self", "target"):
        frappe.throw("请说清这条关联声明在哪一侧（declared_on=self 指左端声明，target 指右端声明）",
                     frappe.ValidationError)
    if cardinality not in ("one_to_one", "one_to_many"):
        frappe.throw("请声明这条关联的基数（one_to_one 或 one_to_many）：口径不说清就会把数算错",
                     frappe.ValidationError)
    if left_id == right_id:
        frappe.throw("左右两端不能是同一个对象", frappe.ValidationError)

    scope = payload.get("scope") or "active"
    left_filters = payload.get("filters") or {}
    right_filters = payload.get("right_filters") or {}

    # ---------- ① 两端授权（**都查**） ----------
    left = model_records._aggregate_prepare(left_id, left_filters, scope)
    try:
        right = model_records._aggregate_prepare(right_id, right_filters, scope)
    except frappe.PermissionError as error:
        frappe.throw("关联对象（%s）你没有读取权限，不能用它做关联统计：%s" % (right_id, error),
                     frappe.PermissionError)
    # ⚠️ 右端的「只看本人」**不在 SQL 里过滤** —— 那样就数不出被剔除了几条；
    #    这里取回来后在 Python 里判（剔除了几条要**报出来**）。
    right["own"] = False
    left_conditions = model_records._aggregate_conditions(left)
    right_conditions = model_records._aggregate_conditions(right)

    # ---------- ② 关联必须是**声明过的引用** ----------
    if declared_on == "self":
        spec = {f["id"]: f for f in left["compiled"]["fields"]}.get(field)
        if not spec or spec.get("type") != "reference":
            frappe.throw("左端的 %s 不是引用字段 —— 本能力只支持**声明过的引用关联**" % field,
                         frappe.ValidationError)
        if spec.get("target") != right_id:
            frappe.throw("左端的 %s 指向的是 %s，不是 %s —— 关联对象对不上" %
                         (field, spec.get("target"), right_id), frappe.ValidationError)
        if field not in left["visible"]:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)
    else:
        spec = {f["id"]: f for f in right["compiled"]["fields"]}.get(field)
        if not spec or spec.get("type") != "reference":
            frappe.throw("右端的 %s 不是引用字段 —— 本能力只支持**声明过的引用关联**" % field,
                         frappe.ValidationError)
        if spec.get("target") != left_id:
            frappe.throw("右端的 %s 指向的是 %s，不是 %s —— 关联对象对不上" %
                         (field, spec.get("target"), left_id), frappe.ValidationError)
        if field not in right["visible"]:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)

    expected = "one_to_one" if declared_on == "self" else "one_to_many"
    if cardinality != expected:
        if declared_on == "self":
            frappe.throw("这条关联是外键方向（左端每行至多对应一行右端），不能按一对多展开算；"
                         "请声明 one_to_one，或换一条声明过的关联", frappe.ValidationError)
        frappe.throw("这条关联是反向声明（右端多行可以指向同一行左端），按一对一算会把右端**算小**；"
                     "请声明 one_to_many（左端取一端、右端按展开，两边算法回执里写明）",
                     frappe.ValidationError)

    # ---------- ③ 指标：分左右两侧（字段权限各自核） ----------
    metrics = payload.get("metrics") or [{"op": "count_rows"}]
    if not isinstance(metrics, list) or len(metrics) > MAX_JOIN_METRICS:
        frappe.throw("一次最多 %d 个指标（左右合计）" % MAX_JOIN_METRICS, frappe.ValidationError)
    left_metrics = [item for item in metrics if _side_of(item) == "left"]
    right_metrics = [item for item in metrics if _side_of(item) == "right"]
    group = payload.get("group_by") or None
    group_side = _side_of(group) if group else None

    def _left_guard(name):
        if name not in left["visible"]:
            frappe.throw("没有该字段的读取权限：%s（左端）" % name, frappe.PermissionError)

    def _right_guard(name):
        if name not in right["visible"]:
            frappe.throw("没有该字段的读取权限：%s（关联对象）" % name, frappe.PermissionError)

    left_types = {f["id"]: f.get("type") for f in left["compiled"]["fields"] if f["id"] in left["visible"]}
    right_types = {f["id"]: f.get("type") for f in right["compiled"]["fields"] if f["id"] in right["visible"]}
    left_plan = _plan(left_metrics, left_types, _left_guard, "left")
    right_plan = _plan(right_metrics, right_types, _right_guard, "right")
    if group:
        if group_side == "left":
            _left_guard(group.get("field"))
            analysis.check_groupable(group.get("field"), left_types.get(group.get("field")))
        else:
            _right_guard(group.get("field"))
            analysis.check_groupable(group.get("field"), right_types.get(group.get("field")))

    # ---------- ④ 左端行（与普通统计**同一套**授权与筛选） ----------
    left_table, left_columns = left["table"], left["columns"]
    left_query = left["query"]
    if left_conditions:
        left_query = left_query.where(Criterion.all(left_conditions))
    base_rows = None if left["empty_search"] else left_query.select(Count("*")).run()[0][0]
    if base_rows is not None and base_rows > analysis.MAX_AGGREGATE_ROWS:
        frappe.throw("匹配 %d 行，超过一次统计 %d 行的上限；请缩小筛选范围"
                     % (base_rows, analysis.MAX_AGGREGATE_ROWS), frappe.ValidationError)
    left_need = []
    if declared_on == "self":
        left_need.append(field)
    for item in left_plan:
        if item["field"] and item["field"] not in left_need:
            left_need.append(item["field"])
    if group and group_side == "left" and group["field"] not in left_need:
        left_need.append(group["field"])
    left_projection = left_query.select(
        left_table.name, *[left_table[left_columns[name]] for name in left_need]).run()
    left_index = {name: position + 1 for position, name in enumerate(left_need)}

    # ---------- ⑤ 右端行（**只取关联到的那些**；记录级权限在 Python 里判） ----------
    right_table, right_columns = right["table"], right["columns"]
    right_need = []
    if declared_on == "target":
        right_need.append(field)
    for item in right_plan:
        if item["field"] and item["field"] not in right_need:
            right_need.append(item["field"])
    if group and group_side == "right" and group["field"] not in right_need:
        right_need.append(group["field"])
    right_query = right["query"]
    if right_conditions:
        right_query = right_query.where(Criterion.all(right_conditions))
    right_projection = []
    if declared_on == "self":
        wanted = []
        for row in left_projection:
            value = row[left_index[field]]
            if value and value not in wanted:
                wanted.append(value)
        if wanted:
            right_query = right_query.where(right_table.name.isin(wanted))
        else:
            right_query = right_query.where(right_table.name.isin(["\x00none\x00"]))
    else:
        left_names = [row[0] for row in left_projection]
        if len(left_names) > MAX_JOIN_KEYS:
            frappe.throw("左端匹配 %d 行，超过一次关联 %d 行的上限；请缩小筛选范围"
                         % (len(left_names), MAX_JOIN_KEYS), frappe.ValidationError)
        right_query = right_query.where(right_table[right_columns[field]].isin(left_names or ["\x00none\x00"]))
    right_projection = right_query.select(
        right_table.name, right_table.owner, *[right_table[right_columns[name]] for name in right_need]).run()
    right_index = {name: position + 2 for position, name in enumerate(right_need)}
    right_by_name = {row[0]: row for row in right_projection}
    right_own = model_records._own(right["compiled"], right["roles"])

    def _right_readable(row):
        if right_own and row[1] != frappe.session.user:
            return False
        return True

    # ---------- ⑥ 配对（**口径在这里落地**） ----------
    pairs = []              # (左端行下标, 右端行)
    excluded_by_permission = 0
    excluded_unlinked = 0
    if declared_on == "self":
        for position, row in enumerate(left_projection):
            target = row[left_index[field]]
            found = right_by_name.get(target) if target else None
            if found is None:
                excluded_unlinked += 1
                continue
            if not _right_readable(found):
                excluded_by_permission += 1
                continue
            pairs.append((position, found))
    else:
        by_key = {}
        for row in right_projection:
            by_key.setdefault(row[right_index[field]], []).append(row)
        for position, row in enumerate(left_projection):
            matched = by_key.get(row[0]) or []
            for found in matched:
                if not _right_readable(found):
                    excluded_by_permission += 1
                    continue
                pairs.append((position, found))
    left_positions = {position for position, _row in pairs}
    left_rows = [left_projection[position] for position in sorted(left_positions)]

    # ---------- ⑦ 算指标（**口径只有一份**） ----------
    left_values = [tuple(row[left_index[name]] for name in left_need) for row in left_rows]
    left_computed = analysis.compute(left_values, left_plan,
                                     group["field"] if group and group_side == "left" else None,
                                     {name: position for position, name in enumerate(left_need)},
                                     row_count=len(left_rows))
    right_values = [tuple(row[right_index[name]] for name in right_need) for _, row in pairs]
    right_computed = analysis.compute(right_values, right_plan,
                                      group["field"] if group and group_side == "right" else None,
                                      {name: position for position, name in enumerate(right_need)},
                                      row_count=len(pairs))
    left_metrics_out, left_groups = _prefixed(left_plan, left_computed, "left")
    right_metrics_out, right_groups = _prefixed(right_plan, right_computed, "right")
    values = {}
    values.update(left_metrics_out)
    values.update(right_metrics_out)
    groups = left_groups if group and group_side == "left" else right_groups

    # ---------- ⑧ 口径自证（**回执**） ----------
    exceptions = list(left_computed["exceptions"]) + list(right_computed["exceptions"])
    notes = []
    if cardinality == "one_to_one":
        notes.append("外键方向：左端每行至多对应一行右端 ⇒ 左端行数与配对数相同（不会被放大）")
        notes.append("右端的「行数」是**配对数**（左端行数），不是右端记录数；"
                     "要看右端有多少条记录请用右端的去重计数")
    else:
        notes.append("反向声明：一行左端可能对应多行右端 ⇒ **右端按展开算**，**左端每个行只算一次**（取一端）")
        notes.append("左端的任何指标都不会被放大；要看展开后的规模看右端的行数")
    if excluded_by_permission:
        notes.append("右端有 %d 条记录当前身份看不到（已剔除，不计入任何指标）" % excluded_by_permission)
    if excluded_unlinked:
        notes.append("左端有 %d 行没有关联到可用的右端记录（引用为空、目标已删或被右端条件筛掉）"
                     % excluded_unlinked)
    if cardinality == "one_to_many":
        exceptions.append({"code": "one_to_many_expanded",
                           "message": "左端 %d 行按这条关联展开成 %d 对（%s 倍）；"
                                      "左端指标按行算（不放大），右端指标按展开后的 %d 行算"
                                      % (len(left_rows), len(pairs), expansion(len(left_rows), len(pairs)),
                                         len(pairs))})
    join_block = {
        "target_object_id": right_id,
        "declared_on": declared_on,
        "field": field,
        "cardinality": cardinality,
        "counting": {"left": "distinct_left_rows", "right": "joined_rows"},
        "base_rows": base_rows,
        "left_rows_paired": len(left_rows),
        "joined_rows": len(pairs),
        "unpaired_left_rows": (base_rows - len(left_rows)) if base_rows is not None else None,
        "excluded_by_permission": excluded_by_permission,
        "excluded_unlinked": excluded_unlinked,
        "expansion_ratio": expansion(len(left_rows), len(pairs)),
        "group_side": group_side,
        "notes": "；".join(notes),
    }
    receipt = query_receipt.build_receipt(
        object_id=left_id, object_name=(model_records.definition(left_id) or {}).get("name"),
        domain_id=left["model"].application, matched_total=base_rows, returned_rows=len(pairs),
        page=1, page_length=None, filters=left_filters, search=left["search"], sort="", direction="",
        scope=scope, counting="joined_rows" if cardinality == "one_to_many" else "row",
        exact=base_rows is not None, details_complete=True,
        aggregate_complete=base_rows is not None, exceptions=exceptions)
    receipt["criteria"].update({"group_by": (group or {}).get("field") if group else None,
                                 "group_side": group_side,
                                 "join": {"target_object_id": right_id, "field": field,
                                          "declared_on": declared_on, "cardinality": cardinality,
                                          "right_filters": right_filters}})
    receipt["join"] = join_block
    return {"receipt": receipt, "metrics": values, "groups": groups,
            "group_truncation": (left_computed if group and group_side == "left" else right_computed)["group_truncation"],
            "join": join_block}


def expansion(left_rows, joined_rows):
    """膨胀倍数（`5/3`）—— 说清「放大了多少」。"""
    if not left_rows:
        return None
    return "%d/%d" % (joined_rows, left_rows)
