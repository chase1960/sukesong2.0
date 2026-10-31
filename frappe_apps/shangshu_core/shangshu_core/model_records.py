"""受管对象的逻辑记录适配；复用对象读入口和公共动作，不提供任意表操作。"""
import json
import time
from contextlib import contextmanager
from contextvars import ContextVar

import frappe
from pypika import Criterion, Order
from pypika.functions import Count, Coalesce

from shangshu_core.identity import get_identity
from shangshu_core.design_support import require_application
from shangshu_core.model_schema import record_schema
from shangshu_core.schema_validation import _validate_schema, _without_optional_nulls
from shangshu_core import analysis
from shangshu_core import subject_access, business_access

MODEL = "Shangshu Object Model"


def _write_restriction(object_id):
    if frappe.db.exists("Shangshu Schema Change", {"object_model":object_id,"status":["in",["Running","Failed"]]}):
        return "对象迁移尚未完成，暂不可写入"
    return None


def compiled_definition(object_id):
    """受管对象的**正式定义**（compiled／active 那一份）—— **权威那份**。

    ⚠️ 与 `definition(object_id)` 的**区别**（别混用）：
      · `definition()` 是**给页面用的投影**（按当前用户的读权限过滤过字段 ＋ 算过可写标记）；
      · **判定**要用**这一份** —— 未经投影的**正式定义**（字段 ＋ 表级 access）。

    ⚠️ 这里**不做**「应用有没有发布／这个人能不能用这个应用」那些检查
    —— 那是 `definition()`／读口那一层的事；这里只回答「**正式定义是什么**」。

    ⚠️ **取不到就回 `None`**（对象行不在／没有生效修订）—— **不编**。
    """
    if not object_id or not frappe.db.exists(MODEL, object_id):
        return None
    model = frappe.get_doc(MODEL, object_id)
    if not model.active_revision:
        return None
    try:
        return json.loads(model.active_json or "{}")
    except (TypeError, ValueError):
        return None


def is_managed(object_id):
    return isinstance(object_id,str) and object_id.startswith("com.shangshu.app.") and ".object." in object_id


def physical_doctype_for(object_id):
    # 受管对象的**物理表类型**（业务域不需要知道它）。
    # 为什么要有这个口：受管记录把底层表类型**藏起来**了（这是设计），
    # 但流程实例的业务链接（Dynamic Link）历史上要的是「表类型 ＋ 名字」⇒
    # 业务域拿不到表类型，只能绕行。**内核自己解析** ⇒ 域里传「受管对象 id ＋ 记录名」就行。
    # 权限照旧按**当前调用者**判（_load 里的角色/应用/对象检查都跑一遍）—— 拿不到就是拿不到。
    model, _compiled, _roles = _load(object_id)
    return model.physical_doctype


# ---- 批量读/写：**一次装配、整批复用**（2026-10-27 Excel 写路径性能线） ----
#
# 为什么有它（站上 cProfile 实测）：批量写 200 行时，**每一行**都要重新装配一遍
# 「模型 ＋ 定义 ＋ 角色 ＋ 主体上下文」（`get_doc` ＋ `get_roles` ＋ 任职部门查询）
# ⇒ 200 行就是 200 遍同样的取数（实测 11027 次 `db.get_value` ＋ 13047 次 `db.sql`）。
# ⇒ 这里让**一次批量读/写**里只装配一次。
#
# ⚠ **作用域＝「这一批」，不是「这个进程」**：出上下文即失效 ⇒
#   撤权/调岗后**下一包**立刻是新结论（与内核「不缓存」的全局约定一致）。
# ⚠ **不缓存授权结论本身**：角色/主体/归属的判定一字未改，
#   复用的只是**装配出来的模型/定义/角色/主体上下文**。
_BATCH_STATE = ContextVar('shangshu_record_batch_state', default=None)


@contextmanager
def batch_state():
    """一次批量读/写里，模型装配与主体上下文**只算一次**（可重入）。"""
    current = _BATCH_STATE.get()
    if current is not None:
        yield current
        return
    token = _BATCH_STATE.set({"loads": {}, "subjects": {}})
    try:
        yield _BATCH_STATE.get()
    finally:
        _BATCH_STATE.reset(token)


def _load(object_id, write=False, *, _prefetched=None):
    if _prefetched is not None and write:
        frappe.throw("写入不能使用目录预取上下文", frappe.ValidationError)
    state = _BATCH_STATE.get()
    cache = state["loads"] if state is not None else None
    key = (object_id, bool(write))
    if cache is not None:
        hit = cache.get(key)
        if hit is not None:
            return hit
    # 目录批量读取可预取原始授权元数据；判断仍是下面同一套，绝不用于写入锁路径。
    identity = _prefetched["identity"] if _prefetched is not None else get_identity()
    model = _prefetched["model"] if _prefetched is not None else frappe.get_doc(MODEL, object_id)
    # 仍统一应用→模型。仅受信、已核验的纯DB直接批写可用App S，其他均App X。
    if _prefetched is None:
        lock = write
        if write:
            from shangshu_core.write_zones import application_lock_mode
            if application_lock_mode(object_id) == 'shared':
                lock = 'shared'
        app = require_application(model.application, identity,lock=lock)
    else:
        app = _prefetched["application"]
        if app is None or app.enterprise_id != identity.enterprise_id:
            frappe.throw("当前企业无权访问该应用", frappe.PermissionError)
    if write:
        model=frappe.get_doc(MODEL,object_id,for_update=True)
        from shangshu_core.write_zone_schema import assert_model_writable
        assert_model_writable(model)
        if model.application != app.name:
            frappe.throw('对象归属已变化，请重新读取', frappe.TimestampMismatchError)
    if model.enterprise_id != identity.enterprise_id or not model.active_revision:
        frappe.throw("对象尚未生效或不可访问", frappe.PermissionError)
    compiled = (_prefetched["compiled"] if _prefetched is not None else json.loads(model.active_json))
    if write:
        from shangshu_core.write_zones import assert_locked_model
        assert_locked_model(model, compiled)
    check_references(compiled, revisions=_prefetched["reference_revisions"] if _prefetched is not None else None)
    roles = _prefetched["roles"] if _prefetched is not None else set(frappe.get_roles())
    if "System Manager" not in roles:
        if app.status != "Published" or not app.published_revision:
            frappe.throw("应用尚未发布或已停用", frappe.PermissionError)
        published = (_prefetched["published"] if _prefetched is not None else
                     json.loads(frappe.get_doc("Shangshu Application Revision", app.published_revision).definition_json))
        if published is None:
            frappe.throw("应用发布修订不存在", frappe.PermissionError)
        if (not business_access.is_open() and not roles.intersection(published["allowed_roles"])) or not any(b["resource_id"] == object_id and b["version"] == str(model.active_revision) for b in published["bindings"]):
            frappe.throw("对象不在可使用应用中", frappe.PermissionError)
        access = compiled.get("access", {"read_roles":["Desk User"],"write_roles":["Desk User"],"record_scope":"own"})
        if business_access.is_open():
            pass  # 当前试用资格全开；应用发布/企业与迁移状态仍由上下文检查。
        elif subject_access.is_subject_access(access):
            # ---- 受管表链：按**表级主体范围**判（PKG-117-T01）----
            # 部门级表 ⇒ 表外的人**整张表都读不到**（不只是读不到列）。
            from shangshu_core.org_admin import subject_context
            op = "write" if write else "read"
            try:
                scope = subject_access.resolve_op_scope({}, access, op)
            except ValueError as error:
                frappe.throw("对象权限未声明完整：%s" % error, frappe.PermissionError)
            context = _prefetched["subject"] if _prefetched is not None else subject_context(frappe.session.user)
            if not subject_access.subject_allows(scope, context):
                frappe.throw("没有对象读写权限", frappe.PermissionError)
        elif not roles.intersection(access["write_roles" if write else "read_roles"]):
            frappe.throw("没有对象读写权限", frappe.PermissionError)
    if write and (reason := _write_restriction(object_id)):
        frappe.throw(reason, frappe.ValidationError)
    if compiled["kind"] != "record":
        frappe.throw("明细只随主记录操作", frappe.PermissionError)
    # **字段权限声明的配置期硬闸**（PKG-001-T09 ①）：单边声明（只写 read_roles
    # 没写 write_roles，或反过来）当场拒加载。漏写 = 不限是既有约定，所以
    # 「声明了一半」多半是想限制却漏写 —— 一放过去就是 fail-open。
    # 闸必须装在**加载路径**上，不能只留个函数等人手动调 —— 手动调就是提示，不是闸。
    # 判据 test_field_access.py FA-12 + 「没接线就红」那条。
    from shangshu_core.field_access import assert_well_declared
    try:
        assert_well_declared(compiled.get("fields") or [])
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    result = (model, compiled, roles)
    if cache is not None:
        # ⚠ **写侧与读侧分开缓存**：写侧带 `for_update` 锁与「迁移中不许写」那道闸，
        #   不许被读侧那次装配顶掉。
        cache[key] = result
    return result

def _subject(compiled, roles):
    """这份定义要判「主体范围」时，取当前用户的**主体上下文**。

    ⚠️ **按需取**：只有这份定义里**真的出现**新形状（列级或表级 `access`
    是主体范围）才查库 —— 建模对象链（角色键）**一个字都不改**，
    也不会平白多一次查库。

    ⚠️ **批量里复用一次**（`batch_state` 生效时）：主体上下文是**这个人**的
    任职/管辖事实 —— 一次批量（同一请求、同一事务）里不会变 ⇒ 逐行重取是
    **纯重复开销**。出批量即失效（下一包现取，同全局约定）。
    """
    state = _BATCH_STATE.get()
    if state is not None:
        hit = state["subjects"].get(id(compiled))
        if hit is not None:
            return hit[0]
    value = _subject_now(compiled, roles)
    if state is not None and len(state["subjects"]) < 32:
        # ⚠ **连同 compiled 一起留着**（强引用）⇒ 它的 id 不会被回收后复用
        #   ⇒ 不会把**另一份定义**的主体上下文认错。
        state["subjects"][id(compiled)] = (value, compiled)
    return value


def _subject_now(compiled, roles):
    """主体上下文的**现取**实现（不缓存的那一份）。"""
    from shangshu_core.org_admin import subject_context
    if business_access.is_open() or "System Manager" in roles:
        return None  # 管理员旁路（既有语义），不走主体判定
    access = compiled.get("access") or {}
    if subject_access.is_subject_access(access):
        return subject_context(frappe.session.user)
    for field in compiled.get("fields") or []:
        if subject_access.is_subject_access(field.get("access")):
            return subject_context(frappe.session.user)
    return None


def _table_access(compiled):
    """表级主体范围声明（新形状才有；旧形状 ⇒ None ⇒ 走角色键那条链）。"""
    access = compiled.get("access") or {}
    return access if subject_access.is_subject_access(access) else None


def _fields_for_op(compiled, roles, op, subject=None):
    """某一列在这一维上「这个人有没有」—— **分流按「表级形状」，不按「列上有没有 access」**。

    · **表级是主体范围**（**受管表链**）⇒ **每一列**都走主体范围那条路
      （列没声明这个操作 ⇒ 继承表级；表级也没声明 ⇒ 拒）；
    · **表级不是主体范围**（**建模对象链**）⇒ 走角色键那条路（口径一字未改）；
      但其中**某一列带 `access`** ⇒ 那一列仍走主体范围那条路（边界情况，照旧）。

    **不写回落分支**：形状决定走哪条，不猜。
    """
    if business_access.is_open():
        return [field for field in compiled["fields"] if not field["deprecated"]]
    from shangshu_core.field_access import field_allows_roles
    if subject is None:
        subject = _subject(compiled, roles)
    table_access = _table_access(compiled)
    out = []
    for field in compiled["fields"]:
        if field["deprecated"]:
            continue
        # ⚠️ **分流按「表级形状」，不按「列上有没有 access」**。
        # **为什么**：这张表**整张**是受管表（表级声明了主体范围）⇒ 列没声明
        # **就是继承表级**，不是「不受限」。若按列分流，没声明 `access` 的列会掉进
        # 角色键那条路 ⇒ 旧链「读未声明＝不限」⇒ **部门级的表里，没声明的列对
        # 表外员工仍然可见**（与契约「列没声明 ⇒ 继承表级」相抵触）。
        # ⇒ 判据：表级是主体范围 ⇒ 本表**每一列**都走主体范围那条路。
        if table_access is not None or subject_access.is_subject_access(field.get("access")):
            if "System Manager" in roles:
                out.append(field)  # 管理员旁路（既有语义）
                continue
            try:
                if not subject_access.field_allows_subject(field, subject, op, table_access):
                    continue
            except ValueError:
                continue  # 表级也没声明 ⇒ 拒（fail-closed），不放行
            out.append(field)
            continue
        # 旧形状（建模对象链）：read/write 未声明 = 不限制，download 零声明 = 拒。
        # ⚠️ 降维后**没有「筛」这个操作**了（筛并进「读」）⇒ 这里**只有三个**维度。
        need = op
        if field_allows_roles(field, roles, "read") and (
                need == "read" or field_allows_roles(field, roles, need)):
            out.append(field)
    return out


def _fields(compiled, roles, write=False):
    # 字段级规则只留一份 —— 建模对象链在 shangshu_core.field_access，
    # 受管表链在 shangshu_core.subject_access（都是纯模块，可脱离 frappe 测）。
    # 这里只是把它套到 compiled["fields"] 上；**旧链的语义一字未改**。
    subject = _subject(compiled, roles)
    allowed = {field["id"] for field in _fields_for_op(compiled, roles, "read", subject)}
    if write:
        allowed &= {field["id"] for field in _fields_for_op(compiled, roles, "write", subject)}
    return [field for field in compiled["fields"] if field["id"] in allowed]


def check_references(compiled, *, revisions=None):
    for target, revision in compiled.get("reference_revisions", {}).items():
        current = revisions.get(target) if revisions is not None else frappe.db.get_value(MODEL, target, "active_revision")
        if current != revision:
            frappe.throw("明细表字段已更新，请在应用设计中重新检查并确认主表，再发布应用", frappe.ValidationError)


def _references(compiled):
    result = {}
    for field in compiled["fields"]:
        if field["type"] == "detail":
            child = frappe.get_doc(MODEL, field["target"])
            if child.application != compiled["owner"] or not child.active_revision:
                frappe.throw("明细定义不可用", frappe.ValidationError)
            revision = compiled.get("reference_revisions", {}).get(child.name, child.active_revision)
            frozen = frappe.db.get_value("Shangshu Schema Change", {"object_model":child.name,
                "target_revision":revision,"status":"Applied"}, "compiled_json")
            result[field["target"]] = json.loads(frozen or child.active_json)
    return result


def _own(compiled, roles):
    return not business_access.is_open() and "System Manager" not in roles and compiled.get("access", {}).get("record_scope", "own") == "own"


def _record(model, compiled, roles, name, include_recycled=False, for_update=False):
    doc = frappe.get_doc(model.physical_doctype, name,for_update=for_update)
    if _own(compiled, roles) and doc.owner != frappe.session.user:
        frappe.throw("只能访问本人记录", frappe.PermissionError)
    if doc.get('ss_recycled'):
        if not include_recycled:frappe.throw('记录已回收，请在回收站恢复后操作',frappe.ValidationError)
        from shangshu_core.record_lifecycle import require_access
        require_access(model,compiled,roles,subject=_subject(compiled,roles))
    return doc


def _reference_label(target_id, value, cache=None):
    """关联字段的显示名（**带一次显示缓存** ⇒ 批量读时不逐行重复取关联记录）。

    取不到（无权/不存在/已回收）⇒ 一律显示「关联记录不可访问」（既有口径）。
    """
    key = (target_id, str(value))
    if cache is not None and key in cache:
        return cache[key]
    try:
        target, target_schema, target_roles = _load(target_id)
        linked = _record(target,target_schema,target_roles,value)
        title = next((f for f in _fields(target_schema,target_roles) if f["type"]=="text"),None)
        column = next((c["fieldname"] for f,c in zip(target_schema["fields"],target_schema["doctype"]["fields"])
                       if title and f["id"]==title["id"]),None)
        label = linked.get(column) if column else None
        text = label or linked.name
    except (frappe.PermissionError,frappe.ValidationError,frappe.DoesNotExistError):
        text = "关联记录不可访问"
    if cache is not None:
        cache[key] = text
    return text


def _prime_reference_labels(compiled, rows, selected, cache):
    """只批量取本页、所选关联列实际引用的标签；不可访问目标维持原占位。"""
    columns = {f["id"]: c["fieldname"] for f, c in zip(compiled["fields"], compiled["doctype"]["fields"])}
    targets = {}
    for field in selected:
        if field["type"] != "reference":
            continue
        values = targets.setdefault(field["target"], set())
        values.update(str(row.get(columns[field["id"]])) for row in rows if row.get(columns[field["id"]]))
    for target_id, names in targets.items():
        names = sorted(name for name in names if (target_id, name) not in cache)
        if not names:
            continue
        for name in names:
            cache[(target_id, name)] = "关联记录不可访问"
        try:
            target, schema, roles = _load(target_id)
            title = next((f for f in _fields(schema, roles) if f["type"] == "text"), None)
            column = next((c["fieldname"] for f, c in zip(schema["fields"], schema["doctype"]["fields"])
                           if title and f["id"] == title["id"]), None)
            from shangshu_core.record_lifecycle import available
            fields = ["name", "owner"] + (["ss_recycled"] if available(target.physical_doctype) else [])
            if column:
                fields.append(column)
            owned = _own(schema, roles)
            for row in _bulk_rows(target.physical_doctype, names, fields):
                if row.get("ss_recycled") or (owned and row.get("owner") != frappe.session.user):
                    continue
                cache[(target_id, str(row["name"]))] = (row.get(column) if column else None) or row["name"]
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            continue


def _values(doc, compiled, roles, row_ids=True, getter=None, display_cache=None, selected_fields=None):
    """一条记录的正式值。

    `getter` 是**批量读口**给的取值器（`物理列名 → 值`）——
    批量取回的行不必再逐条 `get_doc`；口径与逐条读**一字不差**
    （同一份字段可见性、同一份类型归一、同一份关联显示名）。
    """
    columns = {f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])}
    selected = _fields(compiled,roles) if selected_fields is None else selected_fields
    refs = _references({**compiled, "fields": selected}) if any(f["type"] == "detail" for f in selected) else {}
    result = {}
    for field in selected:
        value = getter(columns[field["id"]]) if getter else doc.get(columns[field["id"]])
        if field["type"] == "detail":
            value = [{**_values(row,refs[field["target"]],roles,row_ids,display_cache=display_cache),
                      **({"_row_id":row.name} if row_ids and row.name else {})} for row in value or []]
        elif field["type"] == "boolean" and value is not None:
            value = bool(value)
        elif field["type"] == "date" and value:
            value = str(value)
        result[field["id"]] = value
        if row_ids and field["type"] == "reference" and value:
            result.setdefault("_display",{})[field["id"]] = _reference_label(
                field["target"], value, display_cache)
    return result


def definition(object_id):
    model, compiled, roles = _load(object_id)
    visible = [{**f, **({"children":_fields(_references(compiled)[f["target"]],roles)} if f["type"] == "detail" else {})}
               for f in _fields(compiled,roles)]
    editable = _fields(compiled,roles,True)
    projected = {**compiled,"fields":editable}
    references = {key:{**value,"fields":_fields(value,roles,True)} for key,value in _references(compiled).items()}
    # 物理映射不发给页面；表单读取逻辑 schema，权限不依赖前端隐藏。
    # ⚠️ **可写**也按各自那条链判：受管表链按**表级主体范围的 write 维度**，
    # 建模对象链按 `write_roles`（照旧）。
    access = compiled.get("access", {})
    if business_access.is_open():
        writable = not _write_restriction(object_id)
    elif subject_access.is_subject_access(access):
        writable = "System Manager" in roles
        if not writable:
            try:
                scope = subject_access.resolve_op_scope({}, access, "write")
                writable = subject_access.subject_allows(scope, _subject(compiled, roles))
            except ValueError:
                writable = False
        writable = bool(writable) and not _write_restriction(object_id)
    else:
        writable = ("System Manager" in roles or bool(roles.intersection(access.get("write_roles",["Desk User"])))) and not _write_restriction(object_id)
    from shangshu_core.record_lifecycle import available,allowed
    recyclable=writable and available(model.physical_doctype) and allowed(compiled,roles,subject=_subject(compiled,roles))
    reference_fields = {}
    for field in editable:
        if field["type"] == "reference": reference_fields[field["id"]] = field["target"]
        if field["type"] == "detail":
            for child in _fields(_references(compiled)[field["target"]],roles,True):
                if child["type"] == "reference": reference_fields[field["id"]+"."+child["id"]] = child["target"]
    return {"id":model.name,"name":compiled["title"],"title":compiled["title"],
            "owner":model.application,"source":"managed","revision":model.active_revision,
            "fields":visible,"input_schema":record_schema(projected,references),"reference_fields":reference_fields,
            "unique_keys":compiled.get("unique_keys",[]),
            "query":_query_capabilities(compiled,roles),
            "history":{"version":1,"service":"platform.object.history"},
            "import":{"version":1,"service":"platform.object.import_preview","action":"platform.object.import",
                      "available":writable and (business_access.is_open() or "System Manager" in roles) and not any(f['type'] in {'reference','detail'} for f in editable),
                      "max_bytes":10485760,"max_rows":500},
            "lifecycle":{"version":1,"available":bool(recyclable),"scopes":["active","trash"],"auto_purge":False},
            "export":{"version":1,"service":"platform.object.export","format":"xlsx",
                      "available":(business_access.is_open() or "System Manager" in roles) and not any(f['type']=='detail' for f in visible),
                      "max_rows":5000},
            "operations":["read",*(["create","update"] if writable else []),*(["recycle","restore"] if recyclable else [])],"record_actions":[]}


def _open_by_default(fields):
    """「默认开放」清单（PKG-001-T09 ②）。薄包装，规则只留一份在 field_access。"""
    from shangshu_core.field_access import open_by_default
    return open_by_default(fields)


def design_capabilities(model):
    """仅供已授权的应用设计响应；不模拟员工、不另存能力清单。"""
    if not model.active_revision:
        return {"status":"unavailable","revision":0,"operations":[],"reason":"尚未建表，草稿没有运行能力"}
    compiled = json.loads(model.active_json)
    from shangshu_core.record_lifecycle import available
    access = compiled.get("access", {})
    result = {"status":"checked","revision":model.active_revision,"source":"managed",
              "fields":[{k:v for k,v in field.items() if k not in {"fieldname"}} for field in compiled["fields"]],
              # **「默认开放」清单**（PKG-001-T09 ②）：哪些字段的哪些维度是「人人可做」的。
              # 漏写 = 不限是既有约定，所以「人人可做」必须**看得见、数得出来**，
              # 不许只活在函数返回值里。配置方在这里就能对账，不用另开页面。
              "open_by_default": _open_by_default(compiled.get("fields") or []),
              # `read_roles`/`write_roles` 是**建模对象链**（角色键）的键 ——
              # **受管表链**（主体范围）没有这两个键。⚠️ 这里**保持原样**
              # （前端契约不动），受管表链的真相在下面的 `access`（原始声明）里，
              # **别拿这两个键当受管表链的权限口径**。
              "read_roles":access.get("read_roles",["Desk User"]),
              "write_roles":access.get("write_roles",["Desk User"]),
              "access":access,
              "record_scope":access.get("record_scope","own"),
              "recycle_roles":access.get('recycle_roles',[]),
              "unique_keys":compiled.get('unique_keys',[]),
              "deletion":{"supported":compiled['kind']=='record' and available(compiled['doctype']['name']),"mode":"recycle","auto_purge":False},"operations":[]}
    if compiled["kind"] == "detail":
        result.update(status="unavailable",reason="明细随主记录读写，没有独立记录操作")
        return result
    try:
        result["operations"] = definition(model.name)["operations"]
        result["reason"] = _write_restriction(model.name)
    except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError) as error:
        result.update(status="unavailable",reason=str(error))
    return result


def dataset(object_id):
    public = definition(object_id)
    fields = [field for field in public["fields"] if field["type"] != "detail"]
    return {"id":object_id,"object_id":object_id,"name":public["title"],"source":"managed",
            "columns":[{"field":f["id"],"label":f["label"]} for f in fields] or [{"field":"name","label":"记录"}],
            "filters":[{"field":f["id"],"label":f["label"],"type":"text"} for f in fields if f["type"]!="reference"][:3]}


def resolve_object_id(title, namespace=None):
    """Resolve only a candidate; the public caller must still load its authorized definition.

    A name lookup must not expand every active model's permissions/references. Titles
    live in active_json, so filter that existing definition in SQL, within the
    current enterprise. Two matches are sufficient to reject an ambiguous name.
    No process cache: a rename, disable or access change must take effect next call.
    """
    if not isinstance(title, str) or not title.strip():
        frappe.throw("受管对象标题必填", frappe.ValidationError)
    if namespace is not None and (not isinstance(namespace, str) or not namespace.strip()):
        frappe.throw("受管对象命名空间不能为空", frappe.ValidationError)
    identity = get_identity()
    values = {"enterprise_id": identity.enterprise_id, "title": title}
    namespace_filter = ""
    if namespace is not None:
        values["namespace"] = namespace
        namespace_filter = " AND BINARY a.namespace = %(namespace)s"
    matches = frappe.db.sql("""
        SELECT m.name, a.status
        FROM `tabShangshu Object Model` m
        LEFT JOIN `tabShangshu Application Definition` a ON a.name = m.application
        WHERE m.enterprise_id = %(enterprise_id)s AND m.active_revision > 0
          AND BINARY JSON_UNQUOTE(JSON_EXTRACT(m.active_json, '$.title')) = %(title)s
        """ + namespace_filter + " LIMIT 2", values, as_dict=True)
    if len(matches) > 1:
        frappe.throw("受管对象「%s」有多份，请指定唯一命名空间，不可猜测" % title,
                     frappe.ValidationError)
    if not matches:
        return None
    if matches[0].get("status") == "Disabled":
        # The catalog already excluded disabled applications. Do not turn this
        # positive-but-unavailable match into permission to create a duplicate.
        frappe.throw("受管对象所属应用已停用", frappe.PermissionError)
    return matches[0]["name"]


def catalog_candidates(search=None, *, stats=None):
    """批量读取目录授权元数据，复用 _load 准入；不装配公开字段/明细/input_schema。"""
    identity, roles = get_identity(), set(frappe.get_roles())
    term = str(search or "").strip().lower()
    values = {"enterprise_id": identity.enterprise_id}
    search_sql = ""
    if term:
        values["search"] = term
        search_sql = """ AND LOCATE(%(search)s, LOWER(CONCAT(
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.active_json, '$.title')), ''), ' ',
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.active_json, '$.title')), ''), ' ', m.name))) > 0"""
    models = frappe.db.sql("""
        SELECT m.name, m.application, m.enterprise_id, m.active_revision,
               m.physical_doctype, m.modified, m.active_json
        FROM `tabShangshu Object Model` m
        JOIN `tabShangshu Application Definition` a
          ON a.name = m.application AND a.enterprise_id = m.enterprise_id
        WHERE m.enterprise_id = %(enterprise_id)s AND m.active_revision > 0
          AND a.status != 'Disabled'
        """ + search_sql, values, as_dict=True)
    if stats is not None:
        stats["scanned"] = len(models)
    if not models:
        return []
    applications = {row.name: row for row in frappe.get_all("Shangshu Application Definition",
        filters={"name": ["in", sorted({m.application for m in models})],
                 "enterprise_id": identity.enterprise_id},
        fields=["name", "enterprise_id", "status", "published_revision"], limit_page_length=0)}
    published_ids = sorted({a.published_revision for a in applications.values() if a.published_revision})
    published = ({row.name: json.loads(row.definition_json) for row in frappe.get_all(
        "Shangshu Application Revision", filters={"name": ["in", published_ids]},
        fields=["name", "definition_json"], limit_page_length=0)}
        if published_ids and "System Manager" not in roles else {})
    compiled = {m.name: json.loads(m.active_json) for m in models}
    targets = sorted({target for schema in compiled.values() for target in schema.get("reference_revisions", {})})
    reference_revisions = ({row.name: row.active_revision for row in frappe.get_all(MODEL,
        filters={"name": ["in", targets]}, fields=["name", "active_revision"], limit_page_length=0)} if targets else {})
    subject = None
    if ("System Manager" not in roles and not business_access.is_open() and
            any(subject_access.is_subject_access(schema.get("access")) for schema in compiled.values())):
        from shangshu_core.org_admin import subject_context
        subject = subject_context(frappe.session.user)
    result = []
    for model in models:
        app = applications.get(model.application)
        if app is None or app.status == "Disabled":
            continue
        try:
            _load(model.name, _prefetched={"model": model, "compiled": compiled[model.name],
                "application": app, "published": published.get(app.published_revision),
                "identity": identity, "roles": roles, "subject": subject,
                "reference_revisions": reference_revisions})
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            continue
        title = compiled[model.name]["title"]
        result.append({"id": model.name, "name": title, "title": title,
            "owner": model.application, "source": "managed", "revision": model.active_revision,
            "modified": str(model.modified)})
    return result


def list_definitions(search=None):
    identity = get_identity()
    result = []
    term = str(search or '').strip().lower()
    if term:
        # 只在轻量目录元数据上找候选；不为未命中项加载模型、规则、引用或权限。
        # 标题同时是公开定义的 title/name，保持原目录三项拼接的包含语义。
        # LOCATE 将 %、_ 当普通字符；命中后仍逐对象走 definition 的原授权。
        models = frappe.db.sql("""
            SELECT m.name, m.application, m.modified
            FROM `tabShangshu Object Model` m
            LEFT JOIN `tabShangshu Application Definition` a
              ON a.name = m.application AND a.enterprise_id = m.enterprise_id
            WHERE m.enterprise_id = %(enterprise_id)s AND m.active_revision > 0
              AND (a.status IS NULL OR a.status != 'Disabled')
              AND LOCATE(%(search)s, LOWER(CONCAT(
                  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.active_json, '$.title')), ''), ' ',
                  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.active_json, '$.title')), ''), ' ', m.name))) > 0
        """, {"enterprise_id": identity.enterprise_id, "search": term}, as_dict=True)
    else:
        # 日常工作目录不展示停用应用；管理员设计端仍可按明确ID检查历史数据。
        disabled = set(frappe.get_all("Shangshu Application Definition",
            filters={"enterprise_id":identity.enterprise_id,"status":"Disabled"},pluck="name"))
        models = [model for model in frappe.get_all(MODEL,
            filters={"enterprise_id":identity.enterprise_id,"active_revision":[">",0]},
            fields=["name","application","modified"]) if model.application not in disabled]
    for model in models:
        try:
            row = definition(model.name)
            # 「有效修改时间」用真实时间戳（A 契约 §7.1.4 / D-13）；不编一个好看的时刻。
            row["modified"] = str(model.modified)
            result.append(row)
        except (frappe.PermissionError, frappe.ValidationError): continue
    return result


def get_record(object_id, name):
    model, compiled, roles = _load(object_id)
    doc = _record(model,compiled,roles,name)
    # 固定尾注＝**name／modified／creation**：
    #   name ＝ 行 ID；modified ＝ **最后写入**的时间（防覆盖的比对源）；
    #   creation ＝ **这条记录进到这个受管对象的时间**（PKG-068-T01：所有域都自带这一列）。
    return {"object":definition(object_id),"record":{**_values(doc,compiled,roles),"name":doc.name,
            "modified":str(doc.modified),"creation":str(doc.creation)},"processes":[],"actions":[]}


def _bulk_rows(doctype, names, fields, chunk=500):
    """一次取回这些行（`name IN (...)`）。分块只为不让 IN 列表过长。"""
    rows = []
    for start in range(0, len(names), chunk):
        part = names[start:start+chunk]
        rows.extend(frappe.get_all(doctype, filters={"name": ["in", part]},
                                    fields=fields, limit_page_length=0))
    return rows


def _read_fields(compiled, roles, fields):
    """调用者只声明输出列；授权所需内部列由读取器追加，不进入输出。"""
    readable = _fields(compiled, roles)
    if fields is None:
        return readable
    if not isinstance(fields, (list, tuple)) or any(not isinstance(f, str) or not f for f in fields):
        frappe.throw("读取字段必须是字段 ID 列表", frappe.ValidationError)
    known = {f["id"] for f in compiled["fields"]}
    allowed = {f["id"] for f in readable}
    metadata_fields = {"name", "modified", "creation"}
    for field in fields:
        if field in metadata_fields:
            continue  # 固定身份/版本尾注始终返回；不是业务字段，也不扩大内部列读取。
        if field not in known:
            frappe.throw("没有这个字段：%s" % field, frappe.ValidationError)
        if field not in allowed:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)
    wanted = set(fields)
    return [f for f in readable if f["id"] in wanted]


def _read_details(model, compiled, roles, names, selected, columns, display_cache=None):
    """只装配明确请求的明细列；子表继承已核验的父记录范围。"""
    details = [field for field in selected if field["type"] == "detail"]
    if not details:
        return {}
    references = _references({**compiled, "fields": details})
    result = {name: {} for name in names}
    for field in details:
        child = references[field["target"]]
        allowed = {f["id"] for f in _fields(child, roles)}
        child_fields = ["name", "parent", "idx"] + [column["fieldname"]
            for spec, column in zip(child["fields"], child["doctype"]["fields"]) if spec["id"] in allowed]
        column = columns[field["id"]]
        for name in names:
            result[name][column] = []
        for start in range(0, len(names), 500):
            rows = frappe.get_all(child["doctype"]["name"],
                filters={"parent": ["in", names[start:start + 500]],
                         "parenttype": model.physical_doctype, "parentfield": column},
                fields=child_fields, order_by="parent asc, idx asc, name asc", limit_page_length=0)
            if display_cache is not None:
                _prime_reference_labels(child, rows, _fields(child, roles), display_cache)
            for row in rows:
                result[row.parent][column].append(row)
    return result


def get_records(object_id, names, *, fields=None, read_scope=None):
    """**一次批量取回**若干条受管记录（正式值 ＋ 记录版本）。

    ⚠️ **与 `get_record` 同一口径**（一个都不许少）：
    · 字段权限 —— 取的是**这个人读得到的字段**（`_fields` 同一份判定）；
    · 记录范围 —— 「只看本人」的表里，别人的行**当场拒**（`PermissionError`）；
    · 回收态 —— 已回收的记录**当场拒**（`ValidationError`），不进正式值；
    · 记录不存在 —— 当场拒（`DoesNotExistError`）。

    区别只在**取法**：模型/定义/角色/字段可见性**整批装配一次**，
    取行**一次 `name IN (...)`** —— 而不是每行重装配 + 每行一次查询
    （站上实测：目标行读回 600 行 = 600 次逐行装配 ⇒ 3.1 秒）。

    返回 `{记录名: {"name":…, "modified":…, "creation":…, 字段 id: 值}}`
    —— 与 `get_record(...)["record"]` **同形**。
    """
    from shangshu_core.read_scope import normalize_read_scope
    plan = normalize_read_scope(read_scope, rows=names, fields=fields, default_mode="rows")
    if plan["mode"] != "rows":
        frappe.throw("按记录读取必须使用 rows 范围", frappe.ValidationError)
    names, fields = plan["rows"], plan["fields"]
    model, compiled, roles = _load(object_id)
    if not isinstance(names, (list, tuple)) or any(not isinstance(name, str) or not name for name in names):
        frappe.throw("读取记录必须指定记录 ID 列表", frappe.ValidationError)
    wanted = list(dict.fromkeys(names))
    readable = _read_fields(compiled, roles, fields)
    if not wanted:
        return {}
    return _read_record_batch(model, compiled, roles, wanted, readable)


def _read_record_batch(model, compiled, roles, wanted, readable, *, scope="active"):
    """已定位记录共用装配器；读取范围仍复核归属和生命周期，不能靠投影绕过。"""
    from shangshu_core.record_lifecycle import available, require_access, metadata
    if not wanted:
        return {}
    if scope == "trash":
        require_access(model, compiled, roles, subject=_subject(compiled, roles))
    columns = {f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])}
    physical_fields = ["name", "modified", "creation", "owner"]
    if available(model.physical_doctype):
        physical_fields.append("ss_recycled")
        if scope == "trash":
            physical_fields += ["ss_recycled_at", "ss_recycled_by"]
    physical_fields += [columns[field["id"]] for field in readable if field["type"] != "detail"]
    by_name = {str(row.get("name")): row for row in _bulk_rows(model.physical_doctype, wanted, physical_fields)}
    own = _own(compiled, roles)
    display_cache = {}
    out = {}
    for name in wanted:
        row = by_name.get(name)
        if row is None:
            frappe.throw("受管记录不存在：%s" % name, frappe.DoesNotExistError)
        if own and str(row.get("owner") or "") != str(frappe.session.user or ""):
            frappe.throw("只能访问本人记录", frappe.PermissionError)
        if bool(row.get("ss_recycled")) != (scope == "trash"):
            frappe.throw("记录回收状态已变化，请刷新后重试" if scope == "trash" else
                         "记录已回收，请在回收站恢复后操作", frappe.ValidationError)
    _prime_reference_labels(compiled, list(by_name.values()), readable, display_cache)
    details = _read_details(model, compiled, roles, wanted, readable, columns, display_cache)
    for name in wanted:
        row = by_name[name]
        data = {**row, **details.get(name, {})}
        out[name] = {"name": name,
                     "modified": str(row.get("modified") or ""),
                     "creation": str(row.get("creation") or ""),
                     **_values(None, compiled, roles,
                               getter=lambda fieldname: data.get(fieldname),
                               display_cache=display_cache, selected_fields=readable)}
        if scope == "trash":
            out[name]["_lifecycle"] = metadata(frappe._dict(row))
    return out


def _record_scope_query(model, compiled, roles, scope="active"):
    """列表与显式全量绑定读取共用范围：当前身份的归属及生命周期。"""
    from shangshu_core.record_lifecycle import available, require_access
    if scope not in ("active", "trash"):
        frappe.throw("记录范围无效", frappe.ValidationError)
    if scope == "trash":
        require_access(model, compiled, roles, subject=_subject(compiled, roles))
    table = frappe.qb.DocType(model.physical_doctype)
    query = frappe.qb.from_(table)
    if available(model.physical_doctype):
        query = query.where(Coalesce(table.ss_recycled, 0) == int(scope == "trash"))
    if _own(compiled, roles):
        query = query.where(table.owner == frappe.session.user)
    return table, query


def _available_bound_records(object_id, names, *, fields=None):
    """工程全量读仍只查绑定行；延续列表跳过已回收/不可读/已不存在行的语义。"""
    from shangshu_core.read_scope import normalize_read_scope
    plan = normalize_read_scope(rows=names, fields=fields)
    with batch_state():
        model, compiled, roles = _load(object_id)
        selected = _read_fields(compiled, roles, plan["fields"])
        table, query = _record_scope_query(model, compiled, roles)
        out = {}
        for start in range(0, len(plan["rows"]), 500):
            chunk = plan["rows"][start:start + 500]
            available_names = query.where(table.name.isin(chunk)).select(table.name).run(pluck=True)
            if available_names:
                out.update(_read_record_batch(model, compiled, roles, available_names, selected))
        return out


# ---------- **按业务标识找行**（2026-10-22 收进内核的公共能力） ----------
#
# 为什么要有这个口（用户 2026-10-22 原话）：
#   「没有『按业务编号找行』的公共能力 ⇒ example 自己写了一遍 `example.case_row.find_by_identity`。
#     你的原话『UC02 关联费用也用同一个办法』还没做到——该收进内核。」
#
# 这个口是**按受管列的正式值**找行（不是按技术行 ID）：
#   · 业务编号（我司案号、客户编号、费用单号 …）是**人认的那个身份**；
#   · 技术行 ID（工作簿固定行 ID）会随重新导入而变，不能当业务身份。
#
# 授权：**与 query_records 同一套**（同角色、同字段可见性、同归属范围）——
# 找行不是后门，不许比列表读得更宽。
#
# 返回（说清，不猜）：
#   · 命中一行   ⇒ `found=True` ＋ `rows`（那一行的正式值）＋ `record_name`；
#   · 对上多行   ⇒ `ambiguous=True` ＋ `candidates`（**不决定是哪一行**，交人工）；
#   · 没找到     ⇒ `found=False` ＋ `hint`（说清为什么）。

def find_record_by_identity(object_id, field, value, limit=50):
    """按**业务标识**（某个受管列的正式值）找那一行。

    `field` 是**受管字段 id**（如 `code`）；不是受管列 ⇒ 当场拒
    （不拿普通列凑 —— 普通列的值没有权威性，找到了也是假的）。
    """
    model, compiled, roles = _load(object_id)
    field = str(field or "").strip()
    if not field:
        frappe.throw("请指定用哪一列作业务标识", frappe.ValidationError)
    columns = {f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])}
    if field not in columns:
        frappe.throw("这一列不是受管列，不能用来认行", frappe.ValidationError)
    if value is None or (isinstance(value,str) and not value.strip()):
        frappe.throw("业务标识不能为空", frappe.ValidationError)
    # 与 query_records 同一授权边界：字段要**对当前角色可见**。
    visible = {f["id"] for f in _fields(compiled,roles) if f["type"] != "detail"}
    if field not in visible:
        frappe.throw("无权按这一列认行", frappe.PermissionError)
    from shangshu_core.record_lifecycle import available
    lifecycle = available(model.physical_doctype)
    table = frappe.qb.DocType(model.physical_doctype)
    query = frappe.qb.from_(table)
    if lifecycle:
        query = query.where(Coalesce(table.ss_recycled,0)==0)
    query = query.where(table[columns[field]]==value)
    if _own(compiled,roles):
        query = query.where(table.owner==frappe.session.user)
    names = query.select(table.name).orderby(table.name).limit(int(limit)+1).run(pluck=True)
    ambiguous = len(names) > 1
    names = names[:int(limit)]
    rows = []
    for name in names:
        doc = frappe.get_doc(model.physical_doctype,name)
        rows.append({**_values(doc,compiled,roles),"name":name,"modified":str(doc.modified),
                     "creation":str(doc.creation)})
    result = {"object_id":object_id,"object":definition(object_id),"field":field,"value":value,
              "found":False,"ambiguous":ambiguous,"rows":[],"candidates":[]}
    if ambiguous:
        result["candidates"] = [{"record_name":row["name"],"value":row.get(field)} for row in rows]
        result["hint"] = "这个业务标识对上了 %d 行，不敢决定是哪一行（请人工指定）" % len(rows)
        return result
    if not rows:
        result["hint"] = "业务标识 %s 在这个受管对象里没有对应的行" % value
        return result
    row = rows[0]
    result["found"] = True
    result["rows"] = rows
    result["record_name"] = row["name"]
    result["value"] = row.get(field)
    return result

from shangshu_core import query_receipt


def _query_capabilities(compiled, roles):
    """查询能力清单 —— **「筛」并进了「读」**（用户 2026-10-27 06:2x 口径）。

    ⚠️ **降维后只有三个操作**（读／写／下载）⇒ **能读就能筛**：
    `filterable_fields` 与 `search_fields` / `groupable_fields` / `summable_fields`
    / `sort_fields` **同一份判定**（都按 `read` 维度）。
    ⇒ 「看得见但不许筛」**不再能表达**（也不需要表达：筛是读的一部分）。
    """
    subject = _subject(compiled, roles)
    fields = _fields_for_op(compiled, roles, "read", subject)
    comparable=("text","long_text","choice","number","decimal","integer","date","boolean")
    return {"version":1,"search_fields":[f["id"] for f in fields if f["type"] in ("text","long_text","choice")],
            # 统计/筛选能用哪些字段：**明说**，省掉模型试错（PKG-018-T02）。
            # ⚠️ **筛选按 `read` 维度**（降维后「筛」并进了「读」）。
            "filterable_fields":[f["id"] for f in fields if f["type"] in comparable],
            "groupable_fields":[f["id"] for f in fields if f["type"] in comparable],
            "summable_fields":[f["id"] for f in fields if f["type"] in ("number","decimal","integer","currency","percent","float")],
            # name 是行 ID，不是业务字段，但它不可变，是唯一稳定的排序键；
            # 允许按它排序，调用方才敢把“第几行”当坐标用（翻页/定位不会串行）。
            "sort_fields":["name"]+[f["id"] for f in fields if f["type"] in ("text","choice","integer","decimal","date","boolean")],
            "search_max_length":200}


def object_state(object_id):
    """受管对象的**授权后状态**（修订号＋归属）—— 结果集引用的有效性检查用。

    ⚠️ 走 `_load` ⇒ **权限照旧判**（撤权当场 PermissionError，不给旧结果）。
    """
    model, compiled, roles = _load(object_id)
    return {"object_id": model.name, "revision": model.active_revision,
            "enterprise_id": model.enterprise_id, "kind": compiled.get("kind")}


def count_matching(object_id, filters=None, scope=None):
    """同一授权、同一筛选下的**匹配行数** —— 结果集引用核「数据有没有变」用。

    ⚠️ 与 `aggregate_records` **同一套**授权与筛选准备（`_aggregate_prepare`/
    `_aggregate_conditions`）⇒ 数出来的行数与当初那个数**同口径**，对得上才说明范围没变。
    """
    prepared = _aggregate_prepare(object_id, filters, scope)
    conditions = _aggregate_conditions(prepared)
    query = prepared["query"]
    if conditions:
        query = query.where(Criterion.all(conditions))
    if prepared["empty_search"]:
        return None
    return query.select(Count("*")).run()[0][0]


def check_fields_usable(object_id, field_ids):
    """核这些字段当前身份**能不能用**，并返回**可读字段的类型表**。

    ⚠️ 与统计那一侧**同一把尺子**（`_aggregate_conditions` 的守卫）：
    没有这个字段 ⇒ 校验错；**有但没权限** ⇒ 权限错（不把「无权」说成「没有」）。
    """
    model, compiled, roles = _load(object_id)
    visible = {f["id"] for f in _fields(compiled, roles)}
    known = {f["id"] for f in compiled["fields"]}
    for field in field_ids or ():
        if field in visible:
            continue
        if field in known:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)
        frappe.throw("没有这个字段：%s" % field, frappe.ValidationError)
    return {f["id"]: f.get("type") for f in compiled["fields"] if f["id"] in visible}


def _merge_filters(base, extra):
    """把**引用里的范围**与**本次的条件**合并（AND）。

    ⚠️ 同一个字段给了两个**不一样**的值 ⇒ 当场拒（不静默取其一、不覆盖）。
    """
    merged = dict(base or {})
    for key, value in (extra or {}).items():
        if key in merged and merged[key] != value:
            frappe.throw("本次条件与结果集引用里的条件冲突（%s：引用里是 %s，本次是 %s）；"
                         "请重新查询或改条件" % (key, merged[key], value), frappe.ValidationError)
        merged[key] = value
    return merged


def _scope_filters(filters):
    """只留**条件**（去掉排序/范围这类呈现选项）；`$search` 留着（它是范围的一部分）。"""
    return {key: value for key, value in (filters or {}).items()
            if key not in ("$sort", "$direction", "$scope")}


def query_records(object_id, filters=None, page=1, page_length=30, result_set=None, *, fields=None, read_scope=None, include_definition=True):
    if not isinstance(include_definition, bool):
        frappe.throw("include_definition 必须是布尔值", frappe.ValidationError)
    from shangshu_core.read_scope import normalize_read_scope
    plan = normalize_read_scope(read_scope, fields=fields, default_mode="query")
    if plan["mode"] != "query":
        frappe.throw("条件查询必须使用 query 范围", frappe.ValidationError)
    fields = plan["fields"]
    from shangshu_core import result_sets
    base_ref = None
    if result_set is not None:
        # ⚠️ **先核有效性**（数据变了/权限被撤/定义升版/过期/不是你的 ⇒ 当场拒），
        #    再把引用还原成范围；不许拿旧结果当新结果。
        entry = result_sets.resolve(result_set)
        base_ref = result_set
        base = entry.get("criteria") or {}
        base_object = entry.get("object_id")
        if object_id and object_id != base_object:
            frappe.throw("这个结果集引用指向的对象和本次请求的对象不是同一个；请重新查询",
                         frappe.ValidationError)
        object_id = base_object
        filters = _merge_filters(base.get("filters") or {}, _scope_filters(filters))
        if base.get("search") and not filters.get("$search"):
            filters["$search"] = base["search"]
    if not object_id:
        frappe.throw("请给对象编号，或给一个结果集引用（rs_…）", frappe.ValidationError)
    model, compiled, roles = _load(object_id)
    requested_fields = _read_fields(compiled, roles, fields)
    filters = frappe.parse_json(filters) if isinstance(filters,str) else filters or {}
    columns = {f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])}
    subject = _subject(compiled, roles)
    visible = {f["id"] for f in _fields_for_op(compiled, roles, "read", subject) if f["type"] != "detail"}
    # ⚠️ **筛选条件按「读」维度**判（降维后「筛」并进了「读」：能读就能筛）。
    filterable = {f["id"] for f in _fields_for_op(compiled, roles, "read", subject) if f["type"] != "detail"}
    options = {"$search","$sort","$direction","$scope"}
    if not isinstance(filters,dict) or set(filters)-filterable-options or any(isinstance(v,(list,dict)) for v in filters.values()):
        frappe.throw("筛选只能使用有权限字段的明确值", frappe.ValidationError)
    search,sort,direction = filters.get("$search",""),filters.get("$sort",""),filters.get("$direction","asc")
    capabilities = _query_capabilities(compiled,roles)
    if not isinstance(search,str) or len(search)>capabilities["search_max_length"] or not isinstance(sort,str) or (sort and sort not in capabilities["sort_fields"]) or direction not in ("asc","desc"):
        frappe.throw("搜索或排序无效，请使用有权限字段和 asc/desc 方向",frappe.ValidationError)
    safe = {columns[k]:v for k,v in filters.items() if k not in options and v not in (None,"")}
    scope=filters.get('$scope','active')
    if scope not in ('active','trash'):frappe.throw('记录范围无效',frappe.ValidationError)
    if _own(compiled,roles): safe["owner"] = frappe.session.user
    # 关键字是字面包含，不让 % / _ 意外扩大查询；不扫描隐藏字段或关联目标。
    term=search.strip().replace("\\","\\\\").replace("%","\\%").replace("_","\\_")
    empty_search=bool(term and not capabilities["search_fields"])
    page = max(1,int(page)); length = min(100,max(1,int(page_length)))
    # 这里沿用上方受管对象的角色/字段/归属授权；物理列来自冻结映射，不接受 SQL 表达式。
    # Query Builder 参数绑定避免框架 LIKE 二次转义，数据行与计数复用同一条件。
    table, query = _record_scope_query(model, compiled, roles, scope)
    if safe:query=query.where(Criterion.all([table[key]==value for key,value in safe.items()]))
    if term and not empty_search:query=query.where(Criterion.any([table[columns[field]].like('%'+term+'%') for field in capabilities['search_fields']]))
    # name（行 ID）可作排序键：它不在 fields 里，单独走 table.name，不查 columns 映射。
    sort_column = table.name if sort == 'name' else (table[columns[sort]] if sort else table.modified)
    names=[] if empty_search else query.select(table.name).orderby(sort_column,
        order=Order.desc if (direction=='desc' or not sort) else Order.asc).orderby(table.name,order=Order.asc).limit(length).offset((page-1)*length).run(pluck=True)
    rows = []
    # 分页先按授权/筛选定位行，再共用精确字段批读；回收站也不逐行展开文档。
    with batch_state():
        records = _read_record_batch(model, compiled, roles, names, requested_fields, scope=scope)
        rows = [records[name] for name in names]
    total=None if empty_search else query.select(Count('*')).run()[0][0]
    # ⚠️ **定义只装配一次**（R14）：页头、回执、返回三处都要定义 ⇒ 以前装配三遍。
    object_definition = definition(object_id) if include_definition else None
    # 查询回执（PKG-018-T01）：把「查到了什么」随结果一起给模型 ——
    # 总量、这次返回几条、计数是否精确、**明细有没有完整返回**、实际口径、范围、时间、异常。
    receipt=query_receipt.build_receipt(
        object_id=object_id, object_name=(object_definition or {}).get("name") or compiled.get("title"),
        domain_id=model.application, matched_total=total, returned_rows=len(rows),
        page=page, page_length=length, filters=safe, search=term, sort=sort,
        direction=direction, scope=scope, counting="row",
        # 搜不动（没有可搜字段）⇒ 数量**未知**（null），不是 0。
        exact=not empty_search,
        details_complete=None if total is None else len(rows) == total,
        aggregate_complete=None,
        exceptions=([{"code":"no_searchable_fields",
                      "message":"这个对象没有可搜索的字段，按关键字查不出匹配数"}] if empty_search else []))
    # 结果集引用（PKG-018-T08）：这次的范围带一个**可引用的编号**（「继续统计刚才那批」）。
    # ⚠️ 存的是**范围定义**（不是结果快照）；用编号时会重新核数据/权限/定义有没有变。
    ref_block = result_sets.issue(
        object_id=object_id, revision=model.active_revision,
        criteria={"filters": {key: value for key, value in filters.items()
                               if key not in options and value not in (None, "")},
                  "search": term, "scope": scope},
        matched_total=(total if total is not None
                       else count_matching(object_id, filters, scope)),
        kind="query", based_on=base_ref)
    receipt["result_set"] = ref_block
    return {"object_id":object_id,"object":object_definition,"domain_id":model.application,"rows":rows,
            "total":(0 if total is None else total),"page":page,"page_length":length,"receipt":receipt,
            "result_set":ref_block}



# ---------- 受管记录的**程序筛选与统计**（PKG-018-T02） ----------
#
# 为什么是**公共**能力：人、Assistant、自动化都能用同一个口；**不是聊天专用后门**。
# 为什么和 query_records 放一个文件：统计与列表**必须同一授权、同一筛选、同一读取边界**
# —— 两处各写一套授权，迟早出现「统计算全量、列表给一页」的错位。
#
# 本期有限操作集（计划口径）：
# · 单个受管对象；最多 8 个 AND 条件；集合成员最多 50 个；**不接受任意 SQL/表达式片段**；
# · 指标最多 3 个：行数 / 某字段去重计数（默认不计 null）/ 数值字段求和；
# · 最多 1 个分组字段；分组显示最多 50 组（**全体指标在显示限额之前算**）。

AGGREGATE_OPS = analysis.AGGREGATE_OPS
MAX_AGGREGATE_FILTERS = analysis.MAX_AGGREGATE_FILTERS
MAX_AGGREGATE_METRICS = analysis.MAX_AGGREGATE_METRICS
MAX_AGGREGATE_GROUPS = analysis.MAX_AGGREGATE_GROUPS
MAX_SET_MEMBERS = analysis.MAX_SET_MEMBERS
# 一次统计允许读的行数上限（超出就明说，不硬算）。
MAX_AGGREGATE_ROWS = analysis.MAX_AGGREGATE_ROWS
NUMERIC_FIELD_TYPES = analysis.NUMERIC_FIELD_TYPES
DATE_FIELD_TYPES = analysis.DATE_FIELD_TYPES
DISTINCT_FIELD_TYPES = analysis.DISTINCT_FIELD_TYPES
GROUPABLE_FIELD_TYPES = analysis.GROUPABLE_FIELD_TYPES


def _aggregate_field_type(prepared, field_id):
    for field in prepared["compiled"]["fields"]:
        if field["id"] == field_id:
            return field.get("type")
    return None


def _check_filter_value(field_id, field_type, value):
    """筛选值与字段类型**不兼容就当场拒**（不猜、不静默吞）。

    ⚠️ 口径**只有一份**（`shangshu_core.analysis`）—— 受管记录与表格（XLSX／绑定表）
    共用同一套规则；这里只是把它翻成框架的校验错误。
    """
    try:
        analysis.check_filter_value(field_type, value, field_id)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)


def _aggregate_prepare(object_id, filters=None, scope=None):
    """与 query_records 同一套授权 ＋ 筛选准备（字段可见性、只看我自己的、回收站范围、关键字）。

    ⚠️ **两维分开**（PKG-117-T01）：
      · `visible` = **看得见**（`read` 维度）—— 投影出来的列；
      · `filterable` = **能拿它筛**（`filter` 维度）—— 筛选条件的闸。
    """
    model, compiled, roles = _load(object_id)
    filters = frappe.parse_json(filters) if isinstance(filters, str) else filters or {}
    columns = {f["id"]: c["fieldname"] for f, c in zip(compiled["fields"], compiled["doctype"]["fields"])}
    subject = _subject(compiled, roles)
    visible = {f["id"] for f in _fields_for_op(compiled, roles, "read", subject) if f["type"] != "detail"}
    filterable = {f["id"] for f in _fields_for_op(compiled, roles, "read", subject) if f["type"] != "detail"}
    options = {"$search", "$sort", "$direction", "$scope"}
    # ⚠️ 这里**不**因为字段不可见就报错：可见性由 `_aggregate_conditions` 判，
    #    并区分「没这个字段」(ValidationError) 与「有但没权限」(PermissionError)。
    if not isinstance(filters, dict) or set(filters) - options - set(columns):
        frappe.throw("筛选只能使用有权限字段的明确值", frappe.ValidationError)
    search = filters.get("$search", "")
    capabilities = _query_capabilities(compiled, roles)
    if not isinstance(search, str) or len(search) > capabilities["search_max_length"]:
        frappe.throw("搜索无效", frappe.ValidationError)
    scope = scope or filters.get("$scope", "active")
    if scope not in ("active", "trash"):
        frappe.throw("记录范围无效", frappe.ValidationError)
    from shangshu_core.record_lifecycle import available, require_access
    lifecycle = available(model.physical_doctype)
    if scope == "trash":
        require_access(model, compiled, roles, subject=_subject(compiled, roles))
    term = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    empty_search = bool(term and not capabilities["search_fields"])
    table = frappe.qb.DocType(model.physical_doctype)
    query = frappe.qb.from_(table)
    if lifecycle:
        query = query.where(Coalesce(table.ss_recycled, 0) == int(scope == "trash"))
    if term and not empty_search:
        query = query.where(Criterion.any([table[columns[field]].like("%" + term + "%")
                                          for field in capabilities["search_fields"]]))
    return {"model": model, "compiled": compiled, "roles": roles, "columns": columns,
            "visible": visible, "filterable": filterable, "capabilities": capabilities,
            "table": table, "query": query,
            "term": term, "empty_search": empty_search, "scope": scope,
            "own": _own(compiled, roles), "filters": filters, "search": search}


def _aggregate_conditions(prepared):
    """筛选条件 ⇒ Query Builder 条件（**只用有权限的字段**；类型不兼容当场拒）。

    ⚠️ **口径只有一份**（`shangshu_core.analysis`）：可用方式、类型兼容、集合上限
    都在那里定；这里只负责把「已定好的条件」翻成 SQL（表格那一侧在内存里判，
    规则同源 —— 见 analysis.matches）。
    """
    table, columns, visible = prepared["table"], prepared["columns"], prepared["visible"]
    # ⚠️ **筛选的闸按「筛」维度**（`filter`），不是「读」维度 ——
    # 「看得见」与「能拿它筛」是两件事（PKG-117-T01）。
    filterable = prepared.get("filterable", visible)
    options = {"$search", "$sort", "$direction", "$scope"}
    raw = {key: value for key, value in prepared["filters"].items() if key not in options}

    def _guard(field):
        # ⚠️ 这里**不**因为字段不可见就报错：可见性由本守卫判，
        #    并区分「没这个字段」(ValidationError) 与「有但没权限」(PermissionError)。
        if field not in filterable:
            known = {item["id"] for item in prepared["compiled"]["fields"]}
            if field in known:
                frappe.throw("没有该字段的筛选权限：%s" % field, frappe.PermissionError)
            frappe.throw("没有这个字段：%s" % field, frappe.ValidationError)

    field_types = {item["id"]: item.get("type") for item in prepared["compiled"]["fields"]}
    try:
        normalized = analysis.normalize_filters(raw, field_types, guard=_guard)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)
    conditions = []
    for field, op, value in normalized:
        column = columns[field]
        if op == "is_null":
            conditions.append(table[column].isnull())
            continue
        if op == "not_null":
            conditions.append(table[column].isnotnull())
            continue
        if op == "in":
            conditions.append(table[column].isin(value))
            continue
        if op in ("gt", "gte", "lt", "lte"):
            conditions.append({"gt": table[column] > value, "gte": table[column] >= value,
                               "lt": table[column] < value, "lte": table[column] <= value}[op])
            continue
        conditions.append(table[column] == value if op == "eq" else table[column] != value)
    if prepared["own"]:
        conditions.append(table.owner == frappe.session.user)
    return conditions


def _decimal_sum(values):
    """求和：**十进制**（不靠模型算，也不静默把文本当数值）。全空 ⇒ None（不是 0）。

    ⚠️ 口径只有一份（`shangshu_core.analysis.decimal_sum`）—— 受管记录与表格共用。
    """
    try:
        return analysis.decimal_sum(values)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)


def aggregate_records(object_id, filters=None, metrics=None, group_by=None, scope=None,
                       result_set=None, ref_extra=None):
    """受管记录的**程序统计**：行数 / 去重计数 / 求和，可选 1 个分组。

    ⚠️ 口径：
    · 数量来自**同一次授权、同一次筛选**的完整匹配范围（不是这一页）；
    · 算不出的数量写 null，**不推算成 0**；
    · 分组显示最多 50 组，超出时**明确**完整组数与未完整标记，**全体指标仍按全量算**；
    · 未授权字段不许用于筛选/分组/去重/求和（只隐藏输出列是不够的）。
    · `result_set`（PKG-018-T08）：给一个**结果集引用**（`rs_…`）⇒ 以它记下的范围
      为底继续统计（可再加条件、换分组）；引用**先核有效性**（数据变了/权限被撤/
      定义升版/过期 ⇒ 当场拒并要求重新查询）。
    """
    from decimal import Decimal
    from shangshu_core import result_sets
    base_ref = None
    if result_set is not None:
        # ⚠️ **先核有效性** —— 不许拿旧结果当新结果。
        entry = result_sets.resolve(result_set)
        base_ref = result_set
        base = entry.get("criteria") or {}
        base_object = entry.get("object_id")
        if object_id and object_id != base_object:
            frappe.throw("这个结果集引用指向的对象和本次请求的对象不是同一个；请重新查询",
                         frappe.ValidationError)
        object_id = base_object
        filters = _merge_filters(base.get("filters") or {}, _scope_filters(filters))
        if base.get("search") and not filters.get("$search"):
            filters["$search"] = base["search"]
        scope = scope or base.get("scope") or "active"
    if not object_id:
        frappe.throw("请给对象编号，或给一个结果集引用（rs_…）", frappe.ValidationError)
    prepared = _aggregate_prepare(object_id, filters, scope)
    table, columns, visible = prepared["table"], prepared["columns"], prepared["visible"]
    conditions = _aggregate_conditions(prepared)
    query = prepared["query"]
    if conditions:
        query = query.where(Criterion.all(conditions))
    # 指标口径先核（字段权限/类型/数量上限都在这里挡住）。
    # ⚠️ **口径只有一份**（`shangshu_core.analysis`）—— 受管记录与表格（XLSX／绑定表）
    # 共用同一套指标规则；这里只多判一件本侧的事：**这个字段当前身份能不能用**。
    def _metric_guard(field):
        if field not in visible:
            frappe.throw("没有该字段的读取权限：%s" % field, frappe.PermissionError)

    field_types = {item["id"]: item.get("type") for item in prepared["compiled"]["fields"]}
    try:
        plan = analysis.plan_metrics(metrics, field_types, guard=_metric_guard)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)
    if group_by:
        if group_by not in visible:
            frappe.throw("没有该字段的读取权限：%s" % group_by, frappe.PermissionError)
        try:
            analysis.check_groupable(group_by, _aggregate_field_type(prepared, group_by))
        except analysis.AnalysisError as error:
            frappe.throw(str(error), frappe.ValidationError)
    # 完整匹配行数（与明细同一 where ⇒ 同一读取边界）。
    matched = None if prepared["empty_search"] else query.select(Count("*")).run()[0][0]
    if matched is not None and matched > MAX_AGGREGATE_ROWS:
        frappe.throw("匹配 %d 行，超过一次统计 %d 行的上限；请缩小筛选范围" % (matched, MAX_AGGREGATE_ROWS),
                     frappe.ValidationError)
    # 需要逐列取值的指标（求和/去重/分组）：一次投影读回来，**服务器里算**。
    need_columns = []
    for item in plan:
        if item["field"] and item["field"] not in need_columns:
            need_columns.append(item["field"])
    if group_by and group_by not in need_columns:
        need_columns.append(group_by)
    projection = []
    if need_columns:
        columns_to_read = [table[columns[field]] for field in need_columns]
        projection = query.select(*columns_to_read).run()
    index = {field: position for position, field in enumerate(need_columns)}
    # **指标怎么算只有一份**（`analysis.compute`）—— 表格那一侧调的是同一个函数。
    try:
        computed = analysis.compute(projection, plan, group_by, index, row_count=matched)
    except analysis.AnalysisError as error:
        frappe.throw(str(error), frappe.ValidationError)
    values = computed["metrics"]
    result_groups = computed["groups"]
    exceptions = computed["exceptions"]
    criteria = {"filters": {key: value for key, value in prepared["filters"].items()
                            if key not in {"$search", "$sort", "$direction", "$scope"}},
                 "search": prepared["search"], "counting": "row",
                 "group_by": group_by or None,
                 "distinct_field": next((item["field"] for item in plan if item["op"] == "count_distinct"), None),
                 "sum_field": next((item["field"] for item in plan if item["op"] == "sum"), None),
                 "page": None, "page_length": None}
    receipt = query_receipt.build_receipt(
        object_id=object_id, object_name=(definition(object_id) or {}).get("name"),
        domain_id=prepared["model"].application, matched_total=matched,
        returned_rows=matched if matched is not None else 0, page=1, page_length=None,
        filters=criteria["filters"], search=prepared["search"], sort="", direction="",
        scope=prepared["scope"], counting="row", exact=matched is not None,
        details_complete=True, aggregate_complete=matched is not None,
        exceptions=exceptions)
    receipt["criteria"].update(criteria)
    # 结果集引用（PKG-018-T08）：这次的范围带一个**可引用的编号**（「继续统计刚才那 126 条」）。
    # ⚠️ 存的是**范围定义**（不是结果快照）；用编号时会重新核数据/权限/定义有没有变。
    ref_block = result_sets.issue(
        object_id=object_id, revision=prepared["model"].active_revision,
        criteria={"filters": criteria["filters"], "search": prepared["search"],
                  "scope": prepared["scope"]},
        matched_total=matched, kind="aggregate", based_on=base_ref, extra=ref_extra)
    receipt["result_set"] = ref_block
    return {"receipt": receipt, "metrics": values, "groups": result_groups,
            "group_truncation": computed["group_truncation"], "result_set": ref_block}

def guard_direct_write(doc, method=None):
    if doc.doctype.startswith("SSM ") and not getattr(frappe.flags,"shangshu_managed_write",False):
        frappe.throw("受管对象必须通过确认后的公共记录动作修改", frappe.PermissionError)


@contextmanager
def _writing():
    previous = getattr(frappe.flags,"shangshu_managed_write",False)
    frappe.flags.shangshu_managed_write = True
    try: yield
    finally: frappe.flags.shangshu_managed_write = previous


def _check_value_domain(field, value):
    """**值域清单**这一道闸（清单跟着定义进内核 ⇒ 所有写入口同一份口径）。

    · **这一列没声明清单** ⇒ 放行（没有值域规则）；
    · 声明了清单、`allow_custom` **不是** False ⇒ **放行**
      （清单只当提示：下拉提供其他，人工填写原文保存 —— 旧项目那条口径）；
    · 声明了清单、`allow_custom` **显式是** False ⇒ 值不在清单里**当场拒**（硬拦）。

    ⚠️ **逐字比对，不 trim** —— 「受理 」和「受理」是两种写法；
    trim 就等于偷偷把用户写的原文改成标准项（与「保留原文」相反）。
    """
    domain = field.get("value_domain") or {}
    options = domain.get("options")
    if not isinstance(options, list) or not options:
        return
    if domain.get("allow_custom", True):
        return
    if value is None:
        return
    text = value if isinstance(value, str) else str(value)
    if text not in [str(item) for item in options]:
        frappe.throw("字段「%s」只能填清单里的值" % field.get("label") or field.get("id"),
                     frappe.ValidationError)


def _apply(doc, compiled, roles, values):
    allowed = {f["id"]:f for f in _fields(compiled,roles,True)}
    if not isinstance(values,dict) or set(values)-set(allowed):
        frappe.throw("包含不可编辑字段", frappe.PermissionError)
    refs = _references(compiled)
    columns = {f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])}
    if doc.is_new():
        # 逻辑定义没有隐式 0/False 默认值。未填写数值必须进入必填/可空规则，
        # 不能让 Frappe new_doc 的默认 0 冒充用户已经填写。
        from shangshu_core.managed_nulls import NUMERIC_TYPES
        for field in compiled["fields"]:
            if field["type"] in NUMERIC_TYPES and field["id"] not in values:
                doc.set(columns[field["id"]], None)
    for key,value in values.items():
        field = allowed[key]
        # ⚠️ **值域清单这一道闸在写之前**（拒绝 ⇒ 一个字节都不改、也不出成功日志）
        _check_value_domain(field, value)
        if field["type"] == "reference" and value:
            target, target_schema, target_roles = _load(field["target"])
            _record(target,target_schema,target_roles,value,for_update=True)
        if field["type"] == "detail":
            if not isinstance(value,list) or len(value)>1000:
                frappe.throw("明细需为最多 1000 行的列表",frappe.ValidationError)
            child_schema = refs[field["target"]]
            existing = {row.name:row for row in doc.get(columns[key]) or []}
            used = set(); children = []
            for row in value:
                if not isinstance(row,dict):frappe.throw("明细行必须为字段对象",frappe.ValidationError)
                row_id=row.get("_row_id")
                if row_id and (row_id not in existing or row_id in used):
                    frappe.throw("明细行不属于当前记录或被重复引用",frappe.PermissionError)
                child=existing[row_id] if row_id else doc.append(columns[key],{})
                if row_id:used.add(row_id)
                _apply(child,child_schema,roles,{k:v for k,v in row.items() if k!="_row_id"})
                children.append(child)
            if set(existing)-used and len(_fields(child_schema,roles,True)) != len(child_schema["fields"]):
                frappe.throw("明细包含不可编辑字段，不能移除原有行",frappe.PermissionError)
            doc.set(columns[key],children)
        else:
            doc.set(columns[key],value)
    # 验证完整记录（包括未修改值）；只读字段不能通过部分更新绕过必填约束。
    all_roles = roles | {"System Manager"}
    merged = _values(doc,compiled,all_roles,row_ids=False)
    schema = record_schema(compiled,refs)
    _validate_schema(_without_optional_nulls(merged,schema),schema,compiled["title"])


def assert_unique(doc, compiled, columns):
    """已声明的业务唯一键：同值（含回收记录）占用时拒绝；任一字段为空视为不参与唯一。"""
    groups = compiled.get("unique_keys") or []
    for group in groups:
        values = {columns[key]: doc.get(columns[key]) for key in group}
        if any(value in (None, "") for value in values.values()):
            continue
        filters = dict(values)
        if doc.name:
            filters["name"] = ["!=", doc.name]
        if frappe.db.get_value(doc.doctype, filters, "name"):
            labels = "、".join(next((f["label"] for f in compiled["fields"] if f["id"] == key), key) for key in group)
            frappe.throw("已有记录占用该业务唯一键（" + labels + "），请核对后再保存", frappe.ValidationError)


def _write_one_record(model, compiled, roles, name, expected_modified, values):
    """写**一条**受管记录 —— 逐条的闸都在这里，**批量与单条共用这一份**。

    顺序固定：**版本闸 → 字段可写范围 → 值域 → 业务唯一键 → 落库**。
    ⚠️ **批量不合并这些判定**（契约：「快也不许绕闸」）——
    每一条记录都自己过一遍，任何一条不过就整包失败。

    返回 `(doc, changes)`：`changes` 是「哪个字段从什么变成什么」的明细（审计证据）。
    """
    doc = _record(model, compiled, roles, name, for_update=True)
    if str(doc.modified) != str(expected_modified or ""):
        frappe.throw("记录已被修改，请刷新后重试", frappe.TimestampMismatchError)
    from shangshu_core.managed_batch_storage import locked_before_doc
    with locked_before_doc(doc, compiled):
        before = _values(doc, compiled, roles | {"System Manager"})
        _apply(doc, compiled, roles, values)
        assert_unique(doc, compiled, {f["id"]: c["fieldname"] for f, c in zip(compiled["fields"], compiled["doctype"]["fields"])})
        from shangshu_core.managed_nulls import preserve_nulls
        with _writing(), preserve_nulls(doc, compiled):
            doc.save(ignore_permissions=True)
    after = _values(doc, compiled, roles | {"System Manager"})
    changes = [{"field": field["id"], "label": field["label"], "type": field["type"],
                "before": before.get(field["id"]), "after": after.get(field["id"])}
               for field in _fields(compiled, roles | {"System Manager"})
               if before.get(field["id"]) != after.get(field["id"])]
    return doc, changes


def _record_change_payload(model, compiled, doc, changes):
    """一条记录的审计载荷（**与单条写完全同形**）。"""
    return {"doctype": doc.doctype, "name": doc.name,
            "data": {"version": 1, "object_id": model.name, "object_title": compiled["title"],
                     "revision": model.active_revision, "changes": changes}}


def _notify_managed_change(model, doc, changes, context):
    """受管记录变了 ⇒ 通知「投影那边」（**批量时批末一次落盘**）。"""
    managed = {"handlers": 0, "results": []}
    if not changes:
        return managed
    changed = {}
    for change in changes:
        changed[str(change.get("field"))] = change.get("after")
    from shangshu_core import managed_changes
    if managed_changes.in_batch():
        managed_changes.defer_managed_change(object_id=model.name, record_name=doc.name,
                                             values=changed)
    else:
        managed = managed_changes.notify_managed_change(
            object_id=model.name, records={doc.name: changed},
            source=str(context.get("source") or "action"))
    return managed


#: 写受管记录撞了**并发**（乐观锁对不上）时，最多重读最新版本再写几次。
#: ⚠️ **不是无限重试**（2026-10-28）：撞的是**版本闸**，每一次重试都是
#: **重读那条记录的最新版本再写** ⇒ 对方那一趟写定之后就过去了。
#: ⇒ 3 次足够（站上实测：同一份通知书并发进来 2～3 趟）；再撞就照实报（那是真异常）。
WRITE_VERSION_RETRIES = 3


def _write_record_with_retry(model, compiled, roles, payload):
    """写一条受管记录 —— **撞了并发就重读最新版本再写**。

    ⚠️ **为什么要有**（2026-10-28 站上实测撞出来的）：
    同一份通知书**并发**进站（客户端并发 ＋ 域内回扫）⇒ 两边都改**同一条**待审记录
    ⇒ 内核的乐观锁（`expected_modified` 对不上）⇒ **后写的那趟被拒**
    （站上原话：「入站失败：记录已被修改，请刷新后重试」）
    ⇒ **那一趟白跑**（它做的事其实已经由另一趟做完了，结果并没有丢）。

    ⇒ **重试放在内核这一个入口** —— **域里不许各写一套**（契约：「域里不许自己写第二套记录引擎」）。
    ⇒ **只重试版本冲突**；别的失败（值域、权限、唯一键…）**照样当场报**
    （重试只会把真错误拖成慢失败，并且掩盖原因）。
    """
    last_error = None
    for attempt in range(WRITE_VERSION_RETRIES + 1):
        try:
            return _write_one_record(model, compiled, roles, payload["name"],
                                     payload["expected_modified"], payload["values"])
        except frappe.TimestampMismatchError as error:
            last_error = error
            if attempt >= WRITE_VERSION_RETRIES:
                raise
            # **等对方那一趟把版本写定**（极短退避）⇒ 再**重读**那条记录的最新版本。
            # ⚠️ **必须 reload**：同一事务里读到的还是**旧值**（读缓存）⇒ 不刷新就白重试。
            time.sleep(0.05 * (attempt + 1))
            fresh = _record(model, compiled, roles, payload["name"], for_update=True)
            try:
                fresh.reload()
            except Exception:
                pass
            payload = dict(payload)
            payload["expected_modified"] = str(fresh.modified)
    raise last_error


def write_record(action_id, payload, context):
    if not context.get("confirmed") or not getattr(frappe.flags,"shangshu_action_pin",None):
        frappe.throw("记录写入必须经过公共动作确认",frappe.PermissionError)
    if not is_managed(payload.get("object_id")):
        from shangshu_core import native_objects
        return native_objects.write_record(action_id, payload, context)
    model, compiled, roles = _load(payload["object_id"],write=True)
    if payload["expected_revision"] != model.active_revision:
        frappe.throw("字段定义已变化，请刷新表单",frappe.TimestampMismatchError)
    if action_id == "platform.object.create":
        doc = frappe.new_doc(model.physical_doctype)
        before = {}
        _apply(doc,compiled,roles,payload["values"])
        assert_unique(doc,compiled,{f["id"]:c["fieldname"] for f,c in zip(compiled["fields"],compiled["doctype"]["fields"])})
        from shangshu_core.managed_nulls import preserve_nulls
        with _writing(), preserve_nulls(doc, compiled):
            doc.save(ignore_permissions=True)
        after = _values(doc,compiled,roles | {"System Manager"})
        changes = [{"field":field["id"],"label":field["label"],"type":field["type"],
                    "before":before.get(field["id"]),"after":after.get(field["id"])}
                   for field in _fields(compiled,roles | {"System Manager"})
                   if before.get(field["id"]) != after.get(field["id"])]
    elif action_id == "platform.object.update":
        doc, changes = _write_record_with_retry(model, compiled, roles, payload)
    else:
        frappe.throw("记录动作未支持",frappe.ValidationError)
    # 内部执行上下文，不接受客户端传入；交给既有执行器，同事务追加唯一动作审计。
    # object_title/label/revision 都按“当时”存：表和字段以后改名改版，日志仍显示写入那刻的名字。
    context["record_change"] = _record_change_payload(model, compiled, doc, changes)
    imported = getattr(frappe.flags,'shangshu_record_import',None)
    if imported and imported.get('object_id') == model.name:
        # 仅内部导入执行器设置；HTTP source 或客户端 values 不能伪造来源。
        context['record_change']['data'].update(source='import',import_ref=imported)
    # ---------- 受管记录变了 ⇒ 通知「投影那边」（原收敛条目 05） ----------
    # ⚠️ **这里只有一个写入点** —— 谁写的值不重要（人／Assistant／自动化／example 都走这儿）
    # ⇒ **投影义务跟着那份投影走**，不再靠「每个调用者记得补写文件」。
    # ⚠️ **批量写时延迟到批末一次通知** ⇒ 处理器可以**一次落盘**（不许逐行落盘）。
    managed = _notify_managed_change(model, doc, changes, context)
    return {"object_id":model.name,"name":doc.name,"modified":str(doc.modified),
            "revision":model.active_revision,"managed_change":managed}


def write_records(action_id, payload, context):
    """**一次写多行**受管记录（2026-10-27 夜 · PKG-132 性能线）。

    **为什么要有它**：契约《处理契约与状态转换》§第 4 步③ 写死了 ——
    「要更快得**内核新增一条批量写能力**（照样过版本闸/字段权限/值域规则/唯一键/审计，
    **快也不许绕闸**），交内核同事拍；**域里不许自己写第二套记录引擎**」。

    实测（真大表 15,502 行 × 57 列）：逐行公共动作执行是**每行约 3.9ms 的固定开销**
    （域声明清单全扫、动作定义、幂等登记、动作回执各一次）⇒ 1,000 格要 6.4 秒。
    ⇒ 这条动作把「**一次动作执行**」变成「**一批记录**」：
    **动作框架只走一次**，而**每条记录的门一件都不少**。

    ⚠️ **不变量逐条保住**（与逐行写**同一份代码** `_write_one_record`）：
    ① 记录版本闸逐条比（不符 ⇒ 417）；② 字段可写范围逐条判；
    ③ 值域/业务校验逐条过；④ 事务：**整包全成或全败**（同事务，无中途提交）；
    ⑤ 幂等：**逐行键**（对象＋行＋值＋版本）原样保留；
    ⑥ 投影落盘/通知**批末一次**（已如此，别退回去）；
    ⑦ 每条记录的完整前后值均交给动作执行器；1.1 原子包只落一条统一日志。
    1.1 平坦原生文档复用刚锁定的本行前像，仍逐行 doc.save，不预载后续目标。

    返回 `{written, records, ...}`。
    """
    if not context.get("confirmed") or not getattr(frappe.flags,"shangshu_action_pin",None):
        frappe.throw("记录写入必须经过公共动作确认",frappe.PermissionError)
    if not is_managed(payload.get("object_id")):
        frappe.throw("批量写只支持受管对象", frappe.ValidationError)
    model, compiled, roles = _load(payload["object_id"],write=True)
    if payload["expected_revision"] != model.active_revision:
        frappe.throw("字段定义已变化，请刷新表单",frappe.TimestampMismatchError)
    items = payload.get("records") or []
    if not items:
        frappe.throw("批量写没有要写的记录", frappe.ValidationError)
    written = []
    record_changes = []
    written_versions = {}
    from shangshu_core import managed_changes, managed_batch_storage
    # 公共入口自己保证整批成功后才通知；晋升等已有外层批次继续拥有最终发送。
    with managed_changes.batch(source=str(context.get("source") or "action")) as batcher, \
            managed_batch_storage.save_scope(context.get('action_version')):
        for item in items:
            name = item.get("name")
            expected = item.get("expected_modified")
            if name in written_versions:
                # **同一个受管记录被多行映射** ⇒ 版本要跟刚写完的那一版
                # （与逐行写同口径：逐行写时这一格是**写完上一行之后现取**的版本）。
                expected = written_versions[name]
            doc, changes = _write_one_record(model, compiled, roles, name,
                                              expected, item.get("values") or {})
            written_versions[name] = str(doc.modified)
            change = _record_change_payload(model, compiled, doc, changes)
            # ⚠️ **逐条幂等键**：与今天逐行写**同一套键口径**（对象＋行＋值＋记录版本），
            #   重试命中同键、不会重复写值。
            if item.get("idempotency_key"):
                change["idempotency_key"] = str(item["idempotency_key"])
            if item.get("row_id"):
                change["row_id"] = str(item["row_id"])
            record_changes.append(change)
            written.append(doc.name)
            _notify_managed_change(model, doc, changes, context)
    # 每条真实前后值均保留；日志封装由执行器按锁定的动作版本决定。
    context["record_changes"] = record_changes
    return {"object_id":model.name,"revision":model.active_revision,"written":len(written),
            "records":written,
            "record_version_checked":True,
            "managed_change":batcher.result}
