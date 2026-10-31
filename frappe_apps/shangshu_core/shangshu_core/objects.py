import copy

import frappe
from shangshu_core.domain_execution import resource_execution

from shangshu_core.domains import assert_domain_enabled, raw_resource
from shangshu_core import model_records


def _definition(object_id):
    domain, item = raw_resource("objects", object_id)
    if not domain or not item:
        frappe.throw("对象未注册", frappe.DoesNotExistError)
    assert_domain_enabled(domain["id"])
    return domain, item


def _public(item, domain):
    result = copy.deepcopy(item)
    result.pop("doctype", None)
    result.pop("query", None)
    result.pop("execution_guard", None)
    result.pop("work_update_guard", None)
    result.pop("native_table", None)
    result["domain_id"] = domain["id"]
    result["domain_name"] = domain["name"]
    result["owner"] = domain["id"]
    result["permission_authority"] = "frappe"
    return result


# ---- 对象元数据六列（D-13 / PKG-001-T09，A 契约 §7.1.4）----
# **字段名与 `file_detail` 一字不差**（`shangshu_files/domain.py`）—— A 那边一份代码
# 读「文件那几行」和「业务对象那几行」，字段名不一样就得写两套。
#
# **值全部来自真实授权检查**，不编好看的值（T09-② 原话：「不是编一个好看的值」）。
# 判据 `test_t09_object_metadata.py`（T09-①②）。

_META_ATTRIBUTION_RESOLVERS = {}


def register_attribution_resolver(object_id, fn):
    """给某对象登记「归属该从哪来」的解析器。fn(object_id) →
    `{'level', 'department', 'department_title', 'owner_user'}` 或 None。

    **为什么留这个口**：契约说「已绑定数据库对象**引用 A 的归属**」（`接口契约.md:429`）。
    绑定关系在文件域（`meta['promotion']`），内核够不到 —— 该问领域。
    跟 `field_access.register_content_gate` 同一个路子：内核派发，领域自己答。

    **无解析器时不猜归属** —— 回「所属应用」这个**事实**（对象类型属于哪个应用），
    不发明 `enterprise`、不造空表（契约原话「不猜归属、不造空表、不报全过」）。
    """
    if not callable(fn):
        raise ValueError('attribution resolver 须是可调用的 fn(object_id)')
    _META_ATTRIBUTION_RESOLVERS[object_id] = fn


def _object_attribution(object_id, public_def):
    """对象的归属。**有解析器问解析器，没有就说事实**（属于哪个应用）。"""
    resolver = _META_ATTRIBUTION_RESOLVERS.get(object_id)
    if resolver is not None:
        value = resolver(object_id)
        if value:
            return value
    # 无伴随 A 的存量对象 / 未登记解析器：**不猜**，照实说「归属=所属应用」。
    # 非空（T09-① 要「不是 null、不是横杠」），但不冒充成部门/个人归属。
    app = public_def.get('owner') or public_def.get('domain_id') or ''
    return {'level': None, 'department': None, 'department_title': None, 'owner_user': None,
            'source': 'application', 'application': str(app),
            'note': '对象类型无伴随 A，归属=所属应用；接入 A 后改用 A 的归属'}


def _object_modified(public_def):
    """有效修改时间。**有真时间就用真时间**，没有就照实标，不编一个好看的时刻。"""
    for key in ('modified', 'last_modified', 'updated_at'):
        value = public_def.get(key)
        if value:
            return str(value)
    # 没时间戳的（native / 领域贡献）：用**修订号**当版本信号，照实说这不是时间。
    revision = public_def.get('revision')
    return 'rev-%s' % revision if revision else '未知'


def object_metadata(public_def):
    """给对象定义补上 A 契约的六列（`接口契约.md:429`「归属 / 有效修改时间 / 当前用户能力摘要」）。

    **能力摘要拆成四个布尔**（跟 `file_detail` 同形，不是单个 `can_edit` ——
    契约原话「不能只增加 `can_edit` 布尔值就声称字段鉴权完成」）：

    - `can_edit`     —— 能改值（`update` 在真实 `operations` 里）
    - `can_download` —— 能导出（`export.available`，真实角色检查算的）
    - `can_share`    —— 能转授权（`file_detail` 口径「仅归属人」→ 对象侧 = 只有
                        System Manager 能改对象级授权）
    - `can_structure`—— 能改结构（改值之上另要结构角色 → 对象侧 = 定义/结构改动是
                        设计期的活，只有 System Manager）

    **不做的事**：行级范围（`enforced_row_scope` 管）、字段级能力（`field_capabilities` 管）。
    本函数只给**资源维度**，跟 `file_detail` 一个粒度。
    """
    operations = set(public_def.get('operations') or [])
    manager = 'System Manager' in frappe.get_roles()
    export_ok = bool((public_def.get('export') or {}).get('available'))
    object_id = str(public_def.get('id') or '')
    return {
        'attribution': _object_attribution(object_id, public_def),
        'modified': _object_modified(public_def),
        'can_edit': 'update' in operations,
        'can_download': export_ok,
        'can_share': manager,
        'can_structure': manager,
    }


def _native(object_id):
    from shangshu_core import native_objects
    return native_objects.declared(object_id)


def list_object_definitions(search=None, *, page=None, page_length=20, summary=False, attribution_level=None):
    """对象目录清单。

    ⚠️ `search`：**服务端**按关键字筛（2026-10-28 · PKG-132 · 审查报告 R11）——
    以前是**前端**把整份目录拉回去再筛（「业务表那侧没有搜索参数，只能在取回的清单里筛」）
    ⇒ 搜索口径与分页/总数对不上。现在**服务端筛**，前端只拿命中的。
    """
    if page is not None:
        return _paged_object_definitions(search, page, page_length, summary, attribution_level)
    if attribution_level is not None:
        frappe.throw("归属筛选须显式指定目录页码", frappe.ValidationError)
    from shangshu_core.domains import list_domains
    from shangshu_core import native_objects

    result = []
    for domain in list_domains(include_disabled=False):
        for item in domain["contribution"].get("objects") or []:
            if isinstance(item, dict) and item.get("native_table"):
                title = item["native_table"].get("title") or item.get("name") or item["id"]
                if not _filter_object_definitions(
                        [{"id": item["id"], "name": title, "title": title}], search):
                    continue
                public = native_objects._public_definition(item["id"])
                if public:
                    result.append(_with_metadata(public))
                continue
            if not _filter_object_definitions([item], search):
                continue
            result.append(_with_metadata(_public(item, domain)))
    result += [_with_metadata(d) for d in model_records.list_definitions(search=search)]
    # ⚠️ **稳定排序**（2026-10-28 · PKG-132 · R11）：对象目录给一个**确定**的次序
    #   （标题 → 编号）⇒ 同样的数据每次读回来的顺序一样（读的人不会看到清单自己乱跳）。
    result.sort(key=lambda row: (str(row.get("title") or ""), str(row.get("id") or "")))
    return _filter_object_definitions(result, search)


def _paged_object_definitions(search, page, page_length, summary, attribution_level):
    from shangshu_core.domains import list_domains
    from shangshu_core import native_objects
    from shangshu_core import business_access
    import time
    started = time.perf_counter()
    if (isinstance(page, bool) or not isinstance(page, int) or page < 1 or
            isinstance(page_length, bool) or not isinstance(page_length, int) or not 1 <= page_length <= 100):
        frappe.throw("目录页码须为正整数，每页 1 至 100 条", frappe.ValidationError)
    if not isinstance(summary, bool):
        frappe.throw("summary 必须是布尔值", frappe.ValidationError)
    if attribution_level not in (None, "", "enterprise", "department", "personal"):
        frappe.throw("目录归属范围无效", frappe.ValidationError)
    candidates, registered, scanned = [], {}, 0
    with model_records.batch_state():
        for domain in list_domains(include_disabled=False):
            for item in domain["contribution"].get("objects") or []:
                scanned += 1
                if item.get("native_table"):
                    title = item["native_table"].get("title") or item.get("name") or item["id"]
                    candidate = {"id": item["id"], "name": title, "title": title,
                                 "owner": domain["id"], "source": "native"}
                    if not _filter_object_definitions([candidate], search):
                        continue
                    try:
                        _domain, _item, block, _write, _catalog = native_objects._require(item["id"])
                        native_objects._gate_read(block)
                    except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
                        continue
                else:
                    candidate = {"id": item["id"], "name": item.get("name"),
                                 "title": item.get("title") or item.get("name") or item["id"], "owner": domain["id"],
                                 "source": item.get("source") or "registered"}
                    if not _filter_object_definitions([candidate], search):
                        continue
                    # 注册对象复用其真实 DocType 读闸；不靠目录出现授予 CRUD 权限。
                    business_access.require_identity()
                    if (item.get("doctype") and not business_access.is_open() and
                            not frappe.has_permission(item["doctype"], "read")):
                        continue
                    registered[item["id"]] = (domain, item)
                candidates.append(candidate)
        managed_stats = {}
        managed = model_records.catalog_candidates(search=search, stats=managed_stats)
        scanned += managed_stats.get("scanned", len(managed))
        candidates += managed
        candidates = _filter_object_definitions(candidates, search)
        if attribution_level:
            candidates = [row for row in candidates if
                          _object_attribution(row["id"], row).get("level") == attribution_level]
        candidates.sort(key=lambda row: (str(row.get("title") or ""), str(row["id"])))
        total = len(candidates)
        selected = candidates[(page - 1) * page_length:page * page_length]
        rows = []
        for candidate in selected:
            if candidate["source"] == "managed":
                public = model_records.definition(candidate["id"])
                public["modified"] = candidate["modified"]
            elif candidate["source"] == "native":
                public = native_objects.definition(candidate["id"])
            else:
                domain, item = registered[candidate["id"]]
                public = _public(item, domain)
            public.setdefault("source", candidate["source"])
            public.setdefault("title", candidate["title"])
            public = _with_metadata(public)
            if summary:
                # 保留旧目录的真实能力/归属字段，绝不把完整schema/detail装进摘要回包。
                keys = {"id", "name", "title", "source", "owner", "domain_id", "domain_name",
                        "revision", "modified", "attribution", "can_edit", "can_download", "can_share",
                        "can_structure", "operations", "export", "companion"}
                public = {key: value for key, value in public.items() if key in keys}
            rows.append(public)
    frappe.logger("shangshu_core").info("object_catalog_page scanned=%d authorized=%d assembled=%d page=%d ms=%.1f",
        scanned, total, len(selected), page, (time.perf_counter() - started) * 1000)
    return {"list": rows, "total": total, "page": page, "page_length": page_length}


def _filter_object_definitions(rows, search=None):
    """按关键字（标题/编号/名字）筛对象目录 —— **服务端**筛。"""
    term = str(search or '').strip()
    if not term:
        return list(rows)
    needle = term.lower()
    out = []
    for row in rows:
        haystack = " ".join(str(row.get(key) or '') for key in ("title", "name", "id"))
        if needle in haystack.lower():
            out.append(row)
    return out


def _with_metadata(public_def):
    """给一条对象定义补六列元数据（A 契约 §7.1.4），三条路径统一走这一个口。"""
    if isinstance(public_def, dict):
        public_def.update(object_metadata(public_def))
        from shangshu_core.object_companions import get_object_companion
        public_def["companion"] = get_object_companion(public_def["id"])
    return public_def


def find_managed_object_definition(title, namespace=None):
    """Find one current-enterprise model, then reuse its normal authorization path.

    None means no active model matched. Ambiguity, disabled applications and
    permission failures are errors, never an invitation to create another model.
    """
    object_id = model_records.resolve_object_id(title, namespace=namespace)
    return get_object_definition(object_id) if object_id else None


def get_object_definition(object_id):
    if model_records.is_managed(object_id):
        result = model_records.definition(object_id)
    elif _native(object_id):
        from shangshu_core import native_objects
        result = native_objects.definition(object_id)
    else:
        domain, item = _definition(object_id)
        result = _public(item, domain)
    from shangshu_core.object_companions import get_object_companion
    result['companion'] = get_object_companion(object_id)
    return result


@resource_execution('objects', 'object_id')
def get_object_record(object_id, name):
    """详情只输出声明字段，关联流程仍经过每实例权限检查。"""
    if model_records.is_managed(object_id):
        return model_records.get_record(object_id,name)
    domain, item = _definition(object_id)
    if "read" not in set(item.get("operations") or ["read"]):
        frappe.throw("该对象不允许查询", frappe.PermissionError)
    doc = frappe.get_doc(item["doctype"], name)
    # 试用开放口径（PKG-132）：角色档位不再阻断建模对象详情；
    # **可读字段仍＝对象自己声明的字段**，不放宽到未声明列。
    from shangshu_core import business_access
    business_access.require_identity()
    if business_access.is_open():
        permitted = {field["id"] for field in item.get("fields") or [] if field.get("id")}
    else:
        doc.check_permission("read")
        from frappe.model import get_permitted_fields
        permitted = set(get_permitted_fields(doc.doctype, user=frappe.session.user, permission_type="read"))
    from shangshu_core.runtime import get_instance_replay
    from shangshu_core.actions import list_registered_actions
    related = []
    for process in frappe.get_all("Shangshu Process Instance", filters={"business_doctype":doc.doctype, "business_name":doc.name}, pluck="name"):
        try:
            replay = get_instance_replay(process)
            related.append(replay["instance"])
        except frappe.PermissionError:
            continue
    available = {row["id"]: row for row in list_registered_actions() if row["executable"]}
    actions = []
    # 只有领域明确声明绑定的动作出现；不能靠字段名猜测或让通用页直接改表。
    for binding in item.get("record_actions") or []:
        action = available.get(binding.get("action_id"))
        if not action or action["domain_id"] != domain["id"]:
            continue
        conditions = binding.get("when") or {}
        if not set((binding.get("bindings") or {}).values()).issubset(permitted):
            continue
        if any(doc.get(field) != value for field, value in conditions.items()):
            continue
        # 只控制详情页入口可见性；Action 仍须独立校验本人/他人和状态。
        actor_rule = binding.get("when_actor") or {}
        if actor_rule:
            field = actor_rule.get("field")
            relation = actor_rule.get("relation")
            if not field or relation not in ("self", "other"):
                continue
            if (doc.get(field) == frappe.session.user) != (relation == "self"):
                continue
        values = {parameter: doc.get(field) for parameter, field in (binding.get("bindings") or {}).items()}
        hidden = {key: values[key] for key in binding.get("hidden", []) if key in values}
        actions.append({**action, "values": values, "hidden": hidden})
    public = _public(item, domain)
    public["fields"] = [field for field in item.get("fields") or [] if field["id"] in permitted]
    record = {field["id"]: doc.get(field["id"]) for field in public["fields"]}
    # name/modified 是所有对象详情的固定尾注（与受管 get_record 同形状）：modified 是保存
    # 并发闩（「记录已被修改」）的比对源，缺了它前端/测试都做不了防覆盖。
    record["name"] = doc.name
    record["modified"] = str(doc.modified)
    if _native(object_id):
        from shangshu_core import native_objects
        public = native_objects.definition(object_id)   # 与对象清单同形状（含 revision）
    return {"object":public, "record":record,
            "processes":related, "actions":actions}


@resource_execution('objects', 'object_id')
def query_object_records(object_id, filters=None, page=1, page_length=30, result_set=None,
                         *, fields=None, read_scope=None, include_definition=True):
    from shangshu_core.read_scope import normalize_read_scope
    scope = normalize_read_scope(read_scope, fields=fields, default_mode='query')
    if scope['mode'] != 'query':
        frappe.throw('对象查询必须使用分页查询范围', frappe.ValidationError)
    if model_records.is_managed(object_id) or result_set:
        # ⚠️ 结果集引用（PKG-018-T08）只对**受管对象**发 ⇒ 带引用时按受管对象那条路走。
        if result_set and not model_records.is_managed(object_id):
            frappe.throw("结果集引用只支持受管对象；请重新查询", frappe.ValidationError)
        return model_records.query_records(object_id, filters, page, page_length, result_set,
            fields=scope['fields'], read_scope=read_scope, include_definition=include_definition)
    if _native(object_id):
        from shangshu_core import native_objects
        return native_objects.query_records(object_id, filters, page, page_length, object_projection=True,
            fields=scope['fields'], read_scope=read_scope, include_definition=include_definition)
    domain, item = _definition(object_id)
    if "read" not in set(item.get("operations") or ["read"]):
        frappe.throw("该对象不允许通用查询", frappe.PermissionError)
    doctype = item.get("doctype")
    declared_fields = [field["id"] for field in item.get("fields") or [] if field.get("id")]
    if not doctype or not declared_fields:
        frappe.throw("对象缺少受管 DocType 或字段定义", frappe.ValidationError)
    from shangshu_core import business_access
    readable = set(declared_fields) | {'name', 'modified'}
    if not business_access.is_open():
        from frappe.model import get_permitted_fields
        readable &= set(get_permitted_fields(doctype, user=frappe.session.user, permission_type='read')) | {'name', 'modified'}
    selected = scope['fields'] if scope['fields'] is not None else declared_fields
    for field in selected:
        if field not in set(declared_fields) | {'name', 'modified'}:
            frappe.throw('没有这个字段：%s' % field, frappe.ValidationError)
        if field not in readable:
            frappe.throw('没有该字段的读取权限：%s' % field, frappe.PermissionError)
    projection = list(dict.fromkeys([*selected, 'name', 'modified']))
    raw_filters = filters if isinstance(filters, dict) else frappe.parse_json(filters or "{}")
    allowed_filters = set(item.get("filter_fields") or declared_fields) | {'name'}
    if not isinstance(raw_filters, dict) or set(raw_filters) - allowed_filters:
        frappe.throw('筛选只能使用对象声明的字段', frappe.ValidationError)
    if set(raw_filters) - readable:
        frappe.throw('没有筛选字段的读取权限', frappe.PermissionError)
    safe_filters = {key: value for key, value in (raw_filters or {}).items() if key in allowed_filters and value not in (None, "")}
    length = min(max(int(page_length), 1), 100)
    start = max(int(page) - 1, 0) * length
    rows = business_access.authorized_get_list(
        doctype,
        fields=projection,
        filters=safe_filters,
        order_by=item.get("order_by") or "modified desc",
        limit_start=start,
        limit_page_length=length,
    )
    total = business_access.authorized_get_list(
        doctype, filters=safe_filters, fields=["count(name) as count"])[0].count
    return {
        "object_id": object_id,
        "domain_id": domain["id"],
        "rows": rows,
        "total": total,
        "page": int(page),
        "page_length": length,
    }
