"""公共「分析语义」：**受管记录**与**表格（XLSX／绑定表）**用**同一套**统计口径。

计划 §9（PKG-018-T06）的原话：「普通 XLSX 及数据库绑定表使用**同一套分析语义**。」
⇒ 口径（指标集、可用操作、类型兼容、上限、求和精度、分组截断）**只留一份**，放在这里；
两个适配层（受管记录＝数据库、表格＝工作簿）都从这里取，**不许两处各写一套**。

**本模块不依赖 frappe**（纯口径，可单独测；判据见 `tests/test_analysis.py`）。

两处**算的地方不同**（不是两套口径）：

· **受管记录**：条件交给数据库算（Query Builder），要用的列一次投影读回来在服务器里汇总；
· **表格**：表不是数据库表 ⇒ 条件在内存里逐行判（`matches`）。

**规则**（能用什么操作、什么类型能比、上限多少、null 怎么算、精度怎么保）
都在这里 —— 两边读同一份规则，不会各写一套慢慢走偏。

口径要点（与 PKG-018-T02 已有的受管记录口径**一字不改**）：

· 指标最多 3 个：行数 / 某字段去重计数（默认不计 null）/ 数值字段求和；
· 筛选最多 8 个 AND 条件；集合成员最多 50 个；**不接受任意 SQL/表达式片段**；
· 最多 1 个分组字段；分组显示最多 50 组（**全体指标在显示限额之前算**）；
· 求和用**十进制**；全空 ⇒ **null（不是 0）**；列里有不是数值的值 ⇒ 当场拒；
· 算不出的数量写 null，**不推算成 0**。
"""

import re
from decimal import Decimal, InvalidOperation

#: 日期筛选值的形状（**与受管记录那一侧一字相同**）：YYYY-MM-DD。
DATE_VALUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 指标集（受管记录与表格**同一份**）。
AGGREGATE_OPS = ("count_rows", "count_distinct", "sum")
# 上限（同一份）。
MAX_AGGREGATE_FILTERS = 8
#: **同一个字段**最多几个条件（`{"day":[{…},{…}]}` 那种区间写法）。
MAX_FIELD_CONDITIONS = 4
MAX_AGGREGATE_METRICS = 3
MAX_AGGREGATE_GROUPS = 50
MAX_SET_MEMBERS = 50
MAX_AGGREGATE_ROWS = 100000
# 字段类型口径（同一份）。`text` 家族含 choice/long_text（受管记录的选项/长文本）。
NUMERIC_FIELD_TYPES = ("number", "decimal", "integer", "currency", "percent", "float")
DATE_FIELD_TYPES = ("date", "datetime", "timestamp")
DISTINCT_FIELD_TYPES = ("text", "long_text", "choice", "number", "decimal", "integer",
                         "date", "boolean")
GROUPABLE_FIELD_TYPES = ("text", "long_text", "choice", "number", "decimal", "integer",
                         "date", "boolean")
# 筛选方式（同一份）：等值/不等/集合/大小/空与非空。**没有**任意表达式。
FILTER_OPS = ("eq", "ne", "in", "gt", "gte", "lt", "lte", "is_null", "not_null")

#: 「数量未知」的哨兵 —— 与 `None`（= 0 条）**不是一回事**。
#: 算不出来的数量写 null / UNKNOWN，**不推算成 0**。
UNKNOWN = object()


class AnalysisError(Exception):
    """口径错误。

    调用方把它翻成自己的异常类型：
    `field_denied` ⇒ 权限错误（frappe.PermissionError）；
    其余（`field_missing` / `invalid`）⇒ 校验错误（frappe.ValidationError）。
    """

    def __init__(self, message, code="invalid"):
        super().__init__(message)
        self.message = message
        self.code = code


def check_filter_value(field_type, value, field=""):
    """筛选值与字段类型**不兼容就当场拒**（不猜、不静默吞）。"""
    if field_type in NUMERIC_FIELD_TYPES:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AnalysisError("字段 %s 是数值字段，筛选值必须是数字" % field)
        return
    if field_type in DATE_FIELD_TYPES:
        if not isinstance(value, str) or not DATE_VALUE_RE.match(value):
            raise AnalysisError("字段 %s 是日期字段，筛选值要用 YYYY-MM-DD" % field)
        return
    if field_type == "boolean":
        if not isinstance(value, bool):
            raise AnalysisError("字段 %s 是布尔字段，筛选值必须是 true/false" % field)
        return
    if not isinstance(value, str):
        raise AnalysisError("字段 %s 是文本字段，筛选值必须是文字" % field)


def plan_metrics(metrics, field_types, guard=None):
    """指标归一化 ＋ 口径校验。

    `metrics`    `[{"op": "count_rows"}]` 或 `[{"op": "sum", "field": "金额"}]`
    `field_types` `{字段: 类型}` —— **调用方已保证这些字段当前身份可读**
    `guard`      可选：`(field) -> None`，在字段被使用前再核一次「能不能用」
                  （无权 → 调用方自己抛权限错误；这里不吞）。

    返回 `[{op, name, field}]`（`name` ＝ 指标名，字段指标带字段名）。
    """
    metrics = metrics or [{"op": "count_rows"}]
    if not isinstance(metrics, list) or not metrics or len(metrics) > MAX_AGGREGATE_METRICS:
        raise AnalysisError("一次最多 %d 个指标" % MAX_AGGREGATE_METRICS)
    plan = []
    for item in metrics:
        if not isinstance(item, dict):
            raise AnalysisError("指标写法不对")
        op = str(item.get("op") or "")
        if op not in AGGREGATE_OPS:
            raise AnalysisError("不支持的指标：%s（可用：%s）" % (op, "、".join(AGGREGATE_OPS)))
        field = item.get("field")
        if op == "count_rows":
            plan.append({"op": op, "name": "count_rows", "field": None})
            continue
        if not field:
            raise AnalysisError("%s 指标必须说明按哪个字段" % op)
        if guard is not None:
            guard(field)
        field_type = field_types.get(field)
        if field_type is None:
            raise AnalysisError("没有这个字段：%s" % field, code="field_missing")
        if op == "count_distinct" and field_type not in DISTINCT_FIELD_TYPES:
            raise AnalysisError("字段 %s 不能做去重计数" % field)
        if op == "sum" and field_type not in NUMERIC_FIELD_TYPES:
            raise AnalysisError("字段 %s 不是数值字段，不能求和" % field)
        plan.append({"op": op, "name": "%s_%s" % (op, field), "field": field})
    return plan


def check_groupable(field, field_type):
    """能不能拿这个字段分组（口径同一份）。"""
    if field_type not in GROUPABLE_FIELD_TYPES:
        raise AnalysisError("字段 %s 不能做分组" % field)


def normalize_filters(filters, field_types, guard=None):
    """筛选条件归一化 ＋ 口径校验 ⇒ `[(字段, 方式, 值)]`。

    `field_types` `{字段: 类型}`；`guard` 同 `plan_metrics`（调用方先核「能不能用」）。
    **不接受任意 SQL/表达式片段** —— 方式只有 `FILTER_OPS` 里那些。

    ⚠️ **同一个字段可以给多个条件**（给一个**列表**）：`{"day": [{"op":"gte",…},{"op":"lte",…}]}`
    —— 「按某个日期字段取一个区间」要的就是这个（PKG-018-T09 的指标按日期区间跑）。
    条件**总数**仍受 `MAX_AGGREGATE_FILTERS` 限制（不是每个字段各算一份上限）。
    """
    raw = {key: value for key, value in (filters or {}).items()
           if not str(key).startswith("$")}
    if len(raw) > MAX_AGGREGATE_FILTERS:
        raise AnalysisError("筛选条件最多 %d 个" % MAX_AGGREGATE_FILTERS)
    out = []
    for field, spec in raw.items():
        if guard is not None:
            guard(field)
        field_type = field_types.get(field)
        if field_type is None:
            raise AnalysisError("没有这个字段：%s" % field, code="field_missing")
        specs = spec if isinstance(spec, list) else [spec]
        if not specs or len(specs) > MAX_FIELD_CONDITIONS:
            raise AnalysisError("同一个字段最多 %d 个条件" % MAX_FIELD_CONDITIONS)
        for item in specs:
            op, value = _condition(item)
            if op not in FILTER_OPS:
                raise AnalysisError("不支持的筛选方式：%s" % op)
            if op in ("is_null", "not_null"):
                out.append((field, op, None))
                continue
            if op == "in":
                if not isinstance(value, list) or not value or len(value) > MAX_SET_MEMBERS:
                    raise AnalysisError("集合筛选的值最多 %d 个" % MAX_SET_MEMBERS)
                for member in value:
                    check_filter_value(field_type, member, field)
                out.append((field, op, list(value)))
                continue
            if op in ("gt", "gte", "lt", "lte"):
                if field_type not in NUMERIC_FIELD_TYPES + DATE_FIELD_TYPES:
                    raise AnalysisError("字段 %s 不是可比较的数值或日期字段" % field)
                check_filter_value(field_type, value, field)
                out.append((field, op, value))
                continue
            check_filter_value(field_type, value, field)
            out.append((field, op, value))
    if len(out) > MAX_AGGREGATE_FILTERS:
        raise AnalysisError("筛选条件最多 %d 个" % MAX_AGGREGATE_FILTERS)
    return out


def _condition(item):
    """一条条件 ⇒ `(方式, 值)`。"""
    if isinstance(item, dict):
        return str(item.get("op") or "eq"), item.get("value")
    return "eq", item


def _same(left, right):
    """等值比较：数字按数值比，其余按文本比（日期是 ISO 文本，字典序即时间序）。"""
    if isinstance(left, bool) or isinstance(right, bool):
        return left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) < 1e-9
    if left is None or right is None:
        return left is right
    return str(left) == str(right)


def matches(value, op, expected):
    """**内存里**判一行符不符合一个条件（表格侧用；受管记录侧交给数据库算）。

    ⚠️ 这不是「第二套口径」：可用的方式、类型兼容规则都在 `normalize_filters` 里定过；
    这里只是把那条已定好的条件落到一个具体值上。
    """
    if op == "is_null":
        return value in (None, "")
    if op == "not_null":
        return value not in (None, "")
    if op == "eq":
        return _same(value, expected)
    if op == "ne":
        return not _same(value, expected)
    if op == "in":
        return any(_same(value, item) for item in (expected or []))
    if value in (None, ""):
        return False
    if op == "gt":
        return value > expected
    if op == "gte":
        return value >= expected
    if op == "lt":
        return value < expected
    if op == "lte":
        return value <= expected
    return False


def decimal_sum(values):
    """求和：**十进制**（不靠模型算，也不静默把文本当数值）。全空 ⇒ None（不是 0）。"""
    total = Decimal("0")
    seen = False
    for value in values:
        if value is None or value == "":
            continue
        try:
            total += Decimal(str(value))
            seen = True
        except (InvalidOperation, ValueError):
            raise AnalysisError("这一列里有不是数值的值，不能求和")
    return (total, seen) if seen else (None, False)


def compute(rows, plan, group_by=None, index=None, row_count=UNKNOWN,
            max_groups=MAX_AGGREGATE_GROUPS):
    """在一组**已投影的行**上算指标（受管记录与表格**同一个函数**）。

    `rows`      `[tuple, ...]` —— 每行只含要用的列（列序见 `index`）
    `index`     `{字段: 该字段在 tuple 里的位置}`
    `plan`      `plan_metrics` 的结果
    `group_by`  分组字段（最多 1 个）
    `row_count` 全体行数；`UNKNOWN`（默认）＝ `len(rows)`；`None` ＝ **数量未知**（不是 0）

    返回 `{"metrics": {...}, "groups": [...], "exceptions": [...], "group_truncation": {...}}`。
    """
    index = index or {}
    total_rows = len(rows) if row_count is UNKNOWN else row_count
    values = {}
    exceptions = []
    groups = []
    group_totals = {}
    if group_by:
        position = index[group_by]
        buckets = {}
        for row in rows:
            key = row[position]
            key = None if key in (None, "") else key
            buckets.setdefault(key, []).append(row)
        total_groups = len(buckets)
        ordered = sorted(buckets.items(), key=lambda entry: (-len(entry[1]), str(entry[0])))
        for key, rows_in_group in ordered[:max_groups]:
            groups.append({"group": "未填写" if key is None else str(key), "_rows": rows_in_group})
        if total_groups > len(groups):
            exceptions.append({"code": "group_truncated",
                               "message": "共 %d 组，只返回前 %d 组；全体指标仍按全部 %d 组计算"
                                          % (total_groups, len(groups), total_groups)})
        group_totals = {"total_groups": total_groups, "returned_groups": len(groups)}
    for item in plan:
        if item["op"] == "count_rows":
            values[item["name"]] = total_rows
            continue
        field = item["field"]
        position = index[field]
        column = [row[position] for row in rows]
        if item["op"] == "count_distinct":
            values[item["name"]] = len({value for value in column if value not in (None, "")})
            continue
        total, seen = decimal_sum(column)
        if not seen:
            values[item["name"]] = None
            exceptions.append({"code": "sum_no_numeric_values",
                               "message": "字段 %s 这一列没有有效数值，求和结果为 null（不是 0）" % field})
        else:
            values[item["name"]] = format(total, "f")
    result_groups = []
    for item in groups:
        rows_in_group = item.pop("_rows")
        metrics_for_group = {}
        for metric in plan:
            if metric["op"] == "count_rows":
                metrics_for_group[metric["name"]] = len(rows_in_group)
                continue
            position = index[metric["field"]]
            if metric["op"] == "count_distinct":
                metrics_for_group[metric["name"]] = len(
                    {row[position] for row in rows_in_group if row[position] not in (None, "")})
                continue
            total, seen = decimal_sum([row[position] for row in rows_in_group])
            metrics_for_group[metric["name"]] = format(total, "f") if seen else None
        result_groups.append({"group": item["group"], "metrics": metrics_for_group})
    return {"metrics": values, "groups": result_groups, "exceptions": exceptions,
            "group_truncation": {"total_groups": group_totals.get("total_groups", 0),
                                  "returned_groups": group_totals.get("returned_groups", 0),
                                  "complete": not any(item.get("code") == "group_truncated"
                                                     for item in exceptions)}}
