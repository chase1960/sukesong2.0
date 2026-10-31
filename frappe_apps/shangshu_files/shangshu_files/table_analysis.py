"""表格分析（普通 XLSX／数据库绑定表）：与受管记录**同一套**统计口径。

PKG-018-T06 第一阶段。计划 §9 的原话：

> 普通 XLSX 及数据库绑定表使用**同一套分析语义**。适配层负责：合法表格区域、表头、
> 稳定行／列身份、类型、权限和数据版本；**受管列读数据库权威值，普通列读原工作簿**。
> 正式值**不能**从可能滞后的 XLSX 投影读取。公式计算值、错误值／缓存过期、合计行与
> 合并表头须有明确处理，无法完整支持时**说清边界**。

**本模块就是那个「适配层」**：把一张表变成**与受管记录同样形状**的统计结果
（行数／去重／求和／分组），并且**每一列都标清值是从数据库来的还是从工作簿来的**。

⚠️ **口径不在这里** —— 在 `shangshu_core.analysis`（**只有一份**）：
受管记录（`platform.object.aggregate`）与本动作调的是**同一个** `analysis.compute`，
筛选规则（可用方式、类型兼容、上限）也是**同一份** `analysis.normalize_filters`。
本模块只做**适配**：把「一张表」变成「一批可统计的值」，并说清来源与边界。

边界（明说，不猜）：

| 情况 | 怎么办 |
| --- | --- |
| 表头行有合并单元格／第 1 行是标题（抬头前有标题行） | **拒**（解析阶段表头就不成立）并说清怎么改 |
| 多工作表 | **只分析主工作表**（唯一有固定行身份与受管绑定的那张）；点名别的表 ⇒ 拒 |
| 合计行 | **默认剔除**并报出剔了哪几行；可带 `include_total_rows` 保留 |
| 公式格 | 用本域公式引擎算出的值，并标 `value_kind=computed`；**没算出来的当空值**并计数 |
| 错误值（#DIV/0! 等） | **当空值**（不是 0、不是错误文本），并计数上报 |
| 受管列 | 值取**数据库权威值**；该行没有受管记录时**退回工作簿值**并逐列说清 |
| 权限 | 与 `files.sheet_read`／受管记录查询**同一套**（文件读权＋行级伴随授权＋字段 ACL） |
| 分析缓存 | **可丢弃的只读派生**：键里带来源版本，来源一变即失效；不产生第二份可写事实 |
"""

import hashlib
import json
from datetime import date, datetime

import frappe
from frappe.utils import now as _now

from shangshu_core.public_api import analysis, build_query_receipt

from shangshu_files import formulas as _formulas
from shangshu_files import promotion, read_merge, sheet
from shangshu_files.object_projection import read_access
from shangshu_files.working_file import content_revision

FILE = "Shangshu File Center File"
DOMAIN_ID = "com.shangshu.files"

#: Excel 错误值（openpyxl 读成文本，值域固定）—— **不当值用**（当空值 + 计数）。
ERROR_VALUES = ("#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!",
                 "#SPILL!", "#CALC!", "#GETTING_DATA")
#: 合计行的判定词（**第一列**的文本；大小写不敏感）。
TOTAL_ROW_LABELS = ("合计", "总计", "小计", "累计", "总额", "total", "subtotal")

#: 分析缓存：**可丢弃的只读派生**（不是第二份事实）。键里带来源版本 ⇒ 来源一变即失效。
CACHE_PREFIX = "fde:t06:table_aggregate:"
CACHE_TTL_SECONDS = 300


# ---------- 值与类型的口径 ----------

def _is_error(value):
    return isinstance(value, str) and value.strip() in ERROR_VALUES


def _effective_value(typed, date_like=False):
    """一格 ⇒ **可统计的值**。

    · 空 / 无权 / 错误值 ⇒ `None`（**不是 0、不是错误文本**）；
    · 公式格 ⇒ 本域公式引擎算出的值（没算出来 ⇒ `None`，由调用方计数上报）；
    · 日期 ⇒ `YYYY-MM-DD`（与受管记录那一侧同一形状）。
    """
    if not isinstance(typed, dict):
        return None
    kind = typed.get("type")
    if kind in (None, "empty", "hidden", "error"):
        return None
    value = typed.get("value")
    if kind == "date":
        return str(value)[:10] if value is not None else None
    if isinstance(value, (datetime, date)):
        return str(value)[:10]
    if date_like and isinstance(value, str) and len(value) > 10 and value[10] == "T":
        return value[:10]
    return value


def _value_kind_of(value):
    """一个**算出来的值**属于哪种类型（公式格算出来的值也要判）。"""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, (datetime, date)):
        return "date"
    return "text"


def _is_total_row(values, first_header):
    """这一行是不是**合计行**（第一列的文本是「合计/总计/…」）。

    ⚠️ 这是**一条写死的判定规则**（不是猜）：只认第一列，且只认「词」或「词＋冒号」，
    命中就**默认剔除**并把行号报出来（用户可以用 `include_total_rows` 保留）。
    """
    typed = (values or {}).get(first_header)
    if not isinstance(typed, dict) or typed.get("hidden"):
        return False
    text = str(typed.get("value") or "").strip().lower()
    if not text:
        return False
    for label in TOTAL_ROW_LABELS:
        if text == label or text.startswith(label + "：") or text.startswith(label + ":"):
            return True
    return False


def _field_type(declared, value_kinds):
    """一列的**字段类型**（筛选值类型校验、能不能求和都用它）。

    受管列用**定义里声明的类型**（那是权威）；普通列用**实际存下来的值**推出来的。
    """
    mapping = {"number": "number", "decimal": "number", "integer": "number",
               "currency": "number", "percent": "number", "float": "number",
               "date": "date", "datetime": "date", "timestamp": "date",
               "boolean": "boolean", "text": "text", "long_text": "text", "choice": "text"}
    if declared:
        return mapping.get(declared, "text")
    kinds = set(value_kinds or ())
    if not kinds:
        return "text"
    if len(kinds) == 1:
        return mapping.get(next(iter(kinds)), "text")
    if "text" in kinds:
        return "text"
    return "number" if "number" in kinds else "date"


# ---------- 动作 ----------

def aggregate(payload, _context=None):
    """`files.table_aggregate`：一张表（普通 XLSX 或数据库绑定表）的程序统计。

    **与受管记录同一形状**：行数／去重计数／求和，最多 1 个分组；
    **额外**说清每列的值来自数据库还是工作簿、数据版本是哪一版。
    """
    payload = payload or {}
    table = str(payload.get("table") or "").strip()
    if not table:
        frappe.throw("缺少表身份", frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw("表不存在：%s" % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table)
    # ① **权限先于一切**（与 `files.sheet_read` 同一把尺子：文件读权 → 回收态 → 行级授权）。
    doc.check_permission("read")
    if doc.status == "Recycled":
        frappe.throw("该表在回收站，恢复后才能读取", frappe.PermissionError)

    meta = sheet._load_meta(doc)
    content = sheet._content(doc)
    try:
        entry, _diag = sheet._parsed(doc, content)
    except frappe.ValidationError as error:
        # 表头行不成立（空列名/重复列名）——**最常见的两条原因都点名**，不替用户猜。
        if "表头" in str(error):
            frappe.throw(
                "这张表第 1 行不是可用的表头行：常见原因是第 1 行是标题（表头上方有标题行）、"
                "或表头行有合并单元格。请把表头放到第 1 行、每列一个不重复的名字后重试。",
                frappe.ValidationError)
        raise
    # ② **工作表**：只分析主工作表（唯一有固定行身份与受管绑定的那张）。
    primary = meta.get("primary_sheet") or entry.get("sheet_title")
    sheet_param = str(payload.get("sheet") or "").strip()
    if sheet_param and sheet_param not in (primary, entry.get("sheet_title"), ""):
        if sheet_param in (entry.get("sheet_titles") or []):
            frappe.throw("本表只分析主工作表 %s；其它工作表没有固定行身份与受管绑定，不做分析"
                         % primary, frappe.ValidationError)
        frappe.throw("工作表不存在：" + sheet_param, frappe.ValidationError)

    headers = list(entry.get("headers") or [])
    rows_raw = entry.get("rows_raw") or []
    registered = sheet._ensure_meta_rows(doc, len(rows_raw), entry["sheet_title"], persist=False)
    all_ids = list((registered or {}).get("rows") or [])
    # ③ **稳定列身份**：列名去掉首尾空格后必须唯一（否则说不清哪一列是哪一列）。
    column_keys = []
    for position, header in enumerate(headers):
        key = str(header or "").strip()
        if not key:
            frappe.throw("第 %d 列没有列名，无法作为列身份" % (position + 1), frappe.ValidationError)
        if key in column_keys:
            frappe.throw("有两列的名字去掉空格后相同（%s），无法区分列身份" % key, frappe.ValidationError)
        column_keys.append(key)
    if not column_keys:
        frappe.throw("这张表没有表头，无法分析", frappe.ValidationError)

    # ④ **行身份与授权范围**（行级伴随授权 ＋ 已软删的行 —— 与 `files.sheet_read` 同一套）。
    access = read_access(doc, all_ids)
    allowed = set(access["allowed_record_ids"]) if access else set(all_ids)
    allowed -= set(meta.get("deleted_rows") or [])
    hidden_headers = {str(name).strip() for name in promotion.unreadable_headers(doc)}

    definition = promotion.load_definition(doc)
    promoted = read_merge.promoted_by_header(definition.get("columns") or [])
    binding = promotion._managed_binding(doc)
    state = promotion.formal_state_full(doc, purpose='analysis')
    formal = state.get("values") or {}

    # ⑤ **取值**：工作簿值 → 本域公式引擎算出的值 → 受管列换成**数据库权威值**。
    rows = []
    for position, row_id in enumerate(all_ids):
        raw = rows_raw[position] if position < len(rows_raw) else ()
        values = {}
        for index, key in enumerate(column_keys):
            raw_value = raw[index] if index < len(raw) else None
            values[key] = sheet.value_typed(raw_value)
        _formulas.decorate_values(values, row_id, meta, content_revision(doc), hidden_headers)
        for key, typed in list(values.items()):
            if typed.get("type") == "text" and _is_error(typed.get("value")):
                values[key] = {"type": "error", "value": None, "error": typed.get("value")}
        rows.append({"row_id": row_id, "values": values})
    merged_rows, sources = read_merge.merge_rows(rows, formal, promoted, denied=hidden_headers)

    # ⑥ **合计行**：默认剔除并报出；可显式保留。
    include_total = bool(payload.get("include_total_rows"))
    data_rows = []
    total_rows = []
    for row in merged_rows:
        if row["row_id"] not in allowed:
            continue
        if _is_total_row(row["values"], column_keys[0]):
            total_rows.append(row)
        else:
            data_rows.append(row)
    if include_total:
        data_rows = data_rows + total_rows
        total_rows = []

    exceptions = []
    if total_rows:
        exceptions.append({"code": "total_rows_excluded",
                           "message": "已剔除 %d 个合计行（第一列写着「合计/总计/…」的行）：%s；"
                                      "要保留它们请带 include_total_rows=true"
                                      % (len(total_rows),
                                         "、".join(row["row_id"] for row in total_rows[:20]))})
    if binding and definition.get("binding_current") is False:
        exceptions.append({"code": "binding_stale",
                           "message": "这张表的受管绑定对不上当前结构版本（表结构改过），"
                                      "本次统计里受管列的正式值可能对不上工作簿行，请重新核对绑定"})

    # ⑦ **每列说清来源**（数据库权威值 ／ 工作簿值 ／ 混的）与**值口径**（一趟算完）。
    stats = {key: {"kinds": set(), "value_kinds": set(), "database": 0, "workbook": 0,
                   "denied": 0, "formula_pending": 0, "error": 0} for key in column_keys}
    for row in data_rows:
        values = row["values"]
        row_sources = sources.get(row["row_id"], {})
        for key in column_keys:
            stat = stats[key]
            origin = row_sources.get(key)
            if origin == "database":
                stat["database"] += 1
            elif origin == "denied":
                stat["denied"] += 1
            else:
                stat["workbook"] += 1
            typed = values.get(key)
            if not isinstance(typed, dict):
                continue
            kind = typed.get("type")
            if kind in (None, "empty", "hidden"):
                continue
            if kind == "formula":
                stat["kinds"].add("formula")
                if typed.get("value") is None:
                    stat["formula_pending"] += 1
                else:
                    stat["value_kinds"].add(_value_kind_of(typed.get("value")))
                continue
            if kind == "error":
                stat["kinds"].add("error")
                stat["error"] += 1
                continue
            stat["kinds"].add(kind)
            stat["value_kinds"].add(kind)

    columns = []
    field_types = {}
    for index, key in enumerate(column_keys):
        stat = stats[key]
        column = promoted.get(key)
        managed = bool(column and column.get("field"))
        if stat["database"] and stat["workbook"]:
            origin = "mixed"
        elif stat["database"]:
            origin = "database"
        else:
            origin = "workbook"
        kinds = stat["kinds"]
        if "formula" in kinds:
            kind = "formula"
        elif "error" in kinds:
            kind = "error"
        elif not kinds:
            kind = "empty"
        elif len(kinds) == 1:
            kind = next(iter(kinds))
        else:
            kind = "mixed"
        declared = str((column or {}).get("type") or "") if managed else ""
        field_type = _field_type(declared, stat["value_kinds"])
        field_types[key] = field_type
        notes = []
        if managed:
            notes.append("受管列：正式值在数据库（对象 %s，修订 %s）"
                         % (binding.get("object_id"), (binding or {}).get("revision")))
            if stat["workbook"]:
                notes.append("其中 %d 行没有对应的受管记录，用的是工作簿里的值（不是正式值）"
                             % stat["workbook"])
        else:
            notes.append("普通列：值只存在于工作簿里（没有数据库正式值）")
        if kind == "formula":
            notes.append("这一列有公式格：值是本域公式引擎算出来的，不是存下来的正式值")
        if kind == "error":
            notes.append("这一列有错误值（如 #DIV/0!）：按空值处理（不是 0）")
        if stat["denied"]:
            notes.append("其中 %d 行这一列无权查看（值不给）" % stat["denied"])
        columns.append({
            "column": key, "index": index + 1, "kind": kind,
            "value_kind": "computed" if kind == "formula" else "stored",
            "field_type": field_type, "managed": managed,
            "field": (column or {}).get("field") if managed else None,
            "origin": origin, "authoritative": origin == "database",
            "readable": key not in hidden_headers,
            "rows": {"database": stat["database"], "workbook": stat["workbook"],
                     "denied": stat["denied"]},
            "notes": "；".join(notes),
        })
    pending_columns = [(key, stats[key]["formula_pending"]) for key in column_keys
                        if stats[key]["formula_pending"]]
    if pending_columns:
        exceptions.append({"code": "formula_values_pending",
                           "message": "这些列有没算出来的公式格（按空值算，不是 0）：%s"
                                      % "、".join("%s %d 个" % (key, count)
                                                 for key, count in pending_columns)})
    error_columns = [(key, stats[key]["error"]) for key in column_keys if stats[key]["error"]]
    if error_columns:
        exceptions.append({"code": "error_values",
                           "message": "这些列有错误值（如 #DIV/0!），按空值算（不是 0、不是错误文本）：%s"
                                      % "、".join("%s %d 个" % (key, count)
                                                 for key, count in error_columns)})

    # ⑧ **筛选与指标**：口径只有一份（`shangshu_core.analysis`）。
    known = set(column_keys)

    def _guard(field):
        if field not in known:
            raise analysis.AnalysisError("没有这个列：%s" % field, code="field_missing")
        if field in hidden_headers:
            raise analysis.AnalysisError("没有该列的读取权限：%s" % field, code="field_denied")

    def _translate(error):
        if getattr(error, "code", "") == "field_denied":
            frappe.throw(str(error), frappe.PermissionError)
        frappe.throw(str(error), frappe.ValidationError)

    filters = payload.get("filters") or {}
    if not isinstance(filters, dict):
        frappe.throw("筛选参数无效", frappe.ValidationError)
    try:
        normalized = analysis.normalize_filters(filters, field_types, guard=_guard)
    except analysis.AnalysisError as error:
        _translate(error)
        raise
    try:
        plan = analysis.plan_metrics(payload.get("metrics"), field_types, guard=_guard)
    except analysis.AnalysisError as error:
        _translate(error)
        raise
    group_by = payload.get("group_by") or None
    if group_by:
        try:
            _guard(group_by)
            analysis.check_groupable(group_by, field_types.get(group_by))
        except analysis.AnalysisError as error:
            _translate(error)
            raise

    # ⑨ **筛选**：在内存里逐行判（表不是数据库表）—— 规则与受管记录同源。
    search = str(filters.get("$search") or "").strip().lower()
    matched = [row for row in data_rows
               if _row_matches(row, normalized, search, hidden_headers, field_types)]

    need_columns = []
    for item in plan:
        if item["field"] and item["field"] not in need_columns:
            need_columns.append(item["field"])
    if group_by and group_by not in need_columns:
        need_columns.append(group_by)
    projection = [tuple(_effective_value(row["values"].get(key),
                                         field_types.get(key) == "date")
                         for key in need_columns)
                  for row in matched]
    index = {key: position for position, key in enumerate(need_columns)}
    try:
        computed = analysis.compute(projection, plan, group_by, index)
    except analysis.AnalysisError as error:
        _translate(error)
        raise
    exceptions.extend(computed["exceptions"])

    # ⑩ **数据版本与来源**（每个结果都要带：哪个文件、哪个版本、什么时候读的）。
    read_at = _now()
    source = {
        "kind": "file+database" if binding else "file",
        "file": {"table": table, "file_name": doc.file_name,
                 "content_revision": content_revision(doc),
                 "structure_version": int(meta.get("structure_version") or 1),
                 "content_sha256": str(doc.current_sha256 or ""),
                 "read_at": read_at},
        "database": ({"object_id": binding.get("object_id"),
                       "revision": binding.get("revision"),
                       "records": len(formal),
                       "read_at": read_at} if binding else None),
    }

    # ⑪ **分析缓存**：可丢弃的只读派生（键里带来源版本 ⇒ 来源一变即失效）。
    # ⚠️ `expires=True`：frappe 的 `get_value` 在**没命中**时会把 `None` 塞进
    #    `frappe.local.cache`（进程内缓存）⇒ 同一进程里后面再取永远是 None。
    #    本键**带过期时间**，按 frappe 的约定就别进进程内缓存（`expires=True`）。
    cache_key = _cache_key(doc, meta, definition, binding, payload)
    cached = frappe.cache.get_value(cache_key, expires=True)
    if cached:
        computed = cached["computed"]
        source = cached["source"]
        cache_block = {"hit": True, "key": cache_key, "ttl_seconds": CACHE_TTL_SECONDS,
                       "computed_at": cached.get("computed_at"),
                       "note": "本次结果来自可丢弃的派生缓存（只读，按来源版本命中）"}
    else:
        computed = dict(computed)
        computed["exceptions"] = exceptions
        cache_block = {"hit": False, "key": cache_key, "ttl_seconds": CACHE_TTL_SECONDS,
                       "computed_at": read_at,
                       "note": "本次结果现算；派生缓存可丢弃，来源版本一变即失效"}
        frappe.cache.set_value(cache_key,
                                {"computed": computed, "source": source, "computed_at": read_at},
                                expires_in_sec=CACHE_TTL_SECONDS)
    exceptions = computed.get("exceptions") or exceptions

    # ⑫ **回执**（与受管记录同一套结构：查到了什么、什么口径、什么边界）。
    receipt = build_query_receipt(
        object_id=table, object_name=doc.file_name, domain_id=DOMAIN_ID,
        matched_total=len(matched), returned_rows=len(matched), page=1, page_length=None,
        filters={key: value for key, value in filters.items() if not str(key).startswith("$")},
        search=search, sort="", direction="", scope="active", counting="row", exact=True,
        details_complete=True,
        aggregate_complete=not any(item.get("code") in ("formula_values_pending", "error_values")
                                   for item in exceptions),
        exceptions=exceptions)
    receipt["criteria"].update({
        "group_by": group_by or None,
        "distinct_field": next((item["field"] for item in plan if item["op"] == "count_distinct"), None),
        "sum_field": next((item["field"] for item in plan if item["op"] == "sum"), None),
        "include_total_rows": include_total,
    })
    return {
        "table": table, "file_name": doc.file_name,
        "sheet": primary, "sheet_title": entry.get("sheet_title"),
        "sheets": entry.get("sheet_titles") or [],
        "bound": bool(binding), "binding_current": definition.get("binding_current"),
        "columns": columns,
        "rows": {"total": len(data_rows) + len(total_rows), "analyzed": len(matched),
                 "excluded_total_rows": [row["row_id"] for row in total_rows],
                 "excluded_by_permission": len(all_ids) - len(allowed)},
        "metrics": computed["metrics"], "groups": computed["groups"],
        "group_truncation": computed["group_truncation"],
        "source": source, "cache": cache_block, "receipt": receipt,
    }


# ---------- 内部 ----------

def _row_matches(row, normalized, search, hidden_headers, field_types):
    """一行符不符合条件（**在内存里**判；表不是数据库表）。

    规则与受管记录同源（`analysis.matches`）；`$search` 用**本域的搜索口径**
    （任一可见格的文本/公式含这个词，大小写不敏感 —— 与 `files.sheet_read` 一致）。
    """
    for field, op, value in normalized:
        typed = (row["values"] or {}).get(field)
        if not analysis.matches(_effective_value(typed, field_types.get(field) == "date"),
                                op, value):
            return False
    if search:
        for key, typed in (row["values"] or {}).items():
            if key in hidden_headers:
                continue
            if not isinstance(typed, dict):
                continue
            haystack = "%s %s" % (typed.get("value") if typed.get("value") is not None else "",
                                  typed.get("formula") or "")
            if search in haystack.lower():
                return True
        return False
    return True


def _cache_key(doc, meta, definition, binding, payload):
    """派生缓存的键：**必须含来源版本** —— 来源一变即失效（不返回陈旧数字）。"""
    parts = [doc.name, str(content_revision(doc)), str(doc.current_sha256 or ""),
             str(meta.get("structure_version") or 1),
             str(definition.get("definition_version") or ""),
             str((binding or {}).get("object_id") or ""), str((binding or {}).get("revision") or ""),
             str(frappe.session.user), ",".join(sorted(frappe.get_roles() or ())),
             json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)]
    return CACHE_PREFIX + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
