"""受管模型计划与独立迁移命令；DDL 不进入普通 Action 事务。"""
import json

import frappe

from shangshu_core.design_support import (
    require_designer as _designer, require_application as _definition,
    content_hash as _hash, canonical_json as _json, lock_lifecycle as _lifecycle_lock,
)
from shangshu_core.model_schema import compile_object, plan_object_change, ModelError
from shangshu_core.model_lifecycle import object_life
from shangshu_core import subject_access, write_zone_schema

MODEL="Shangshu Object Model"
CHANGE="Shangshu Schema Change"


def _public(change):
    from shangshu_core.model_schema import record_schema
    from shangshu_core.model_records import _references
    compiled = json.loads(change.compiled_json)
    return {"id":change.name,"object_id":change.object_model,"status":change.status,
            "base_revision":change.base_revision,"target_revision":change.target_revision,
            "plan":json.loads(change.plan_json),"definition":json.loads(change.compiled_json),
            "error":change.error_message or "", "input_schema":record_schema(compiled,_references(compiled))}


def get_object_change(change_id):
    identity=_designer()
    change=frappe.get_doc(CHANGE,change_id)
    model=frappe.get_doc(MODEL,change.object_model)
    _definition(model.application,identity)
    if model.enterprise_id!=identity.enterprise_id:
        frappe.throw("无权访问该对象变更",frappe.PermissionError)
    return _public(change)


def prepare_object_change(application_id, definition, idempotency_key, object_id=None, expected_revision=0, change_key=None):
    """准备一次对象变更。

    ⚠️ **`change_key`（2026-10-30 · PKG-133 · W2）**：调用方**自己算好的变更键**。
    默认算法是 `hash([应用, 身份, 幂等键])` ⇒ **只看声明指纹**，看不见**编译器行为**
    ⇒ 内核改一行编译器行为（同一份声明编译出的模型变了）⇒ 键没变
    ⇒ 撞上一次那条变更 ⇒ 「幂等键已用于不同对象变更」⇒ **那张表再也晋升不上去**。
    ⇒ 调用方（晋升那条路）把**编译后模型的指纹**也算进键里
    （`promotion_records.change_key_for`）⇒ 模型规格变了就是**另一件事**⇒ 另一把键。
    """
    identity=_designer()
    _definition(application_id,identity)
    if not isinstance(idempotency_key,str) or not 1<=len(idempotency_key)<=200:
        frappe.throw("对象变更需要有效幂等键",frappe.ValidationError)
    if type(expected_revision) is not int or expected_revision<0:
        frappe.throw("对象修订号无效",frappe.ValidationError)
    definition=frappe.parse_json(definition) if isinstance(definition,str) else definition
    request_hash=_hash({"definition":definition,"object_id":object_id,"expected_revision":expected_revision})
    key=_hash([application_id,identity.identity_id,idempotency_key])
    _lifecycle_lock()
    _definition(application_id, identity, lock=True)
    # ⚠️ **对象 id 是从幂等键推导的**（没给 object_id 时）⇒ **同一张表永远是同一个 id**。
    #   而**退役故意保留模型行**（当退役记录用，审计要留）⇒ 同一张表退役后再晋升，
    #   撞的是**幂等键**（变更键唯一；行级键会重放上一世的旧结果）。
    # ⇒ **幂等键带「第几世」**：不同世互不撞，同一世内重试仍是同一把键（幂等成立）。
    target_object_id=str(object_id or (application_id+".object."+key[:32]))
    life=object_life(target_object_id)
    if change_key:
        # —— 调用方自己算好的键 ⇒ **它自己已经算过「第几世」** ⇒ 不再叠一层。
        pass
    else:
        change_key=key if life<=1 else _hash([key,"life",life])
    if frappe.db.get_value(CHANGE,change_key,"name",for_update=True):
        existing=frappe.get_doc(CHANGE,change_key,for_update=True)
        if existing.request_hash!=request_hash:
            frappe.throw("幂等键已用于不同对象变更",frappe.DuplicateEntryError)
        return get_object_change(change_key)
    original=None
    if object_id:
        model=frappe.get_doc(MODEL,object_id,for_update=True)
        if model.application!=application_id or model.enterprise_id!=identity.enterprise_id:
            frappe.throw("对象不属于当前应用",frappe.PermissionError)
        if model.revision!=expected_revision:
            frappe.throw("对象草稿已变化，请刷新后重试",frappe.TimestampMismatchError)
        if frappe.db.get_value(CHANGE,{"object_model":object_id,"status":["in",["Planned","Running","Failed"]]},"name",for_update=True):
            frappe.throw("对象已有待处理变更，请先完成或取消",frappe.ValidationError)
        original=json.loads(model.active_json) if model.active_revision else None
    else:
        if expected_revision:
            frappe.throw("新对象的基准修订必须为 0",frappe.ValidationError)
        object_id=target_object_id
        # ⚠️ **同 id 的模型行可能还在** —— **退役故意保留它**（当退役记录用，审计要留）
        #   ⇒ 同一张表「晋升过 → 退役 → 再晋升」时，**插一行新的必然撞主键**（DuplicateEntryError）
        #   ⇒ 那张表**再也升不上去**（真总表就卡在这儿）。
        # ⇒ **复活它**：把那一行重新变成可用（**不删模型行** ⇒ 对象 id 不变、审计痕迹留着）。
        #   修订号**不归零**（审计要留连续的痕迹）⇒ 复活后修订号接着往上走。
        existing=frappe.db.get_value(MODEL,object_id,"name",for_update=True)
        if existing:
            model=frappe.get_doc(MODEL,existing,for_update=True)
            if model.active_revision:
                frappe.throw("对象已存在且在线，请用后续晋升（加字段）而不是首次晋升",frappe.ValidationError)
        else:
            model=None
    references={}
    if model is not None:
        write_zone_schema.assert_model_writable(model)
    for row in frappe.get_all(MODEL,filters={"application":application_id,"active_revision":[">",0]},fields=["name","physical_doctype","active_json","active_revision"]):
        references[row.name]={"doctype":row.physical_doctype,"kind":json.loads(row.active_json)["kind"],"revision":row.active_revision}
    try:
        compiled=compile_object(application_id,object_id,definition,references)
        write_zone_schema.assert_reference_targets(compiled)
        # ⚠️ **声明角色存在性校验**（PKG-117-T01）：
        #   · **受管表链**（主体范围）⇒ **不查 Role 表** —— 主体**不是角色**
        #     （全局/部门/个人判的是人），拿「部门名」去 Role 表查必然查不到；
        #   · **建模对象链**（角色键）⇒ 照旧查（老口径不许放宽）。
        access=compiled.get("access") or {}
        if subject_access.is_subject_access(access):
            declared_roles=set()
        else:
            declared_roles=set(access["read_roles"]+access["write_roles"]+access.get('recycle_roles',[]))
        for field in compiled["fields"]:
            declared_roles.update(field.get("read_roles", [])); declared_roles.update(field.get("write_roles", [])); declared_roles.update(field.get("download_roles", []))
        if any(not frappe.db.exists("Role", {"name":role,"disabled":0}) for role in declared_roles):
            raise ModelError("对象权限引用了不存在或已停用角色")
        if original == compiled:
            raise ModelError("没有字段、权限或明细版本变化，无需生成变更计划")
        plan=plan_object_change(original,compiled)
    except ModelError as error:
        frappe.throw(str(error),frappe.ValidationError)
    point="model_prepare_"+frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        if model is None:
            model=frappe.get_doc({"doctype":MODEL,"object_id":object_id,"application":application_id,
                "enterprise_id":identity.enterprise_id,"owner_identity":identity.name,"revision":0,
                "active_revision":0,"active_json":"{}","physical_doctype":compiled["doctype"]["name"]}).insert(ignore_permissions=True)
        model.revision+=1;model.draft_json=_json(compiled);model.save(ignore_permissions=True)
        change=frappe.get_doc({"doctype":CHANGE,"change_key":change_key,"request_hash":request_hash,"object_model":object_id,
            "actor_identity":identity.name,"base_revision":expected_revision,"target_revision":model.revision,
            "compiled_json":_json(compiled),"plan_json":_json(plan),"status":"Planned"}).insert(ignore_permissions=True)
        return _public(change)
    except Exception:
        frappe.db.rollback(save_point=point)
        raise


def cancel_object_change(change_id):
    identity = _designer()
    _lifecycle_lock()
    hint = frappe.get_doc(CHANGE, change_id)
    model = write_zone_schema.lock_model(hint.object_model)
    write_zone_schema.assert_model_writable(model)
    change = frappe.get_doc(CHANGE, change_id, for_update=True)
    _definition(model.application, identity)
    if model.enterprise_id != identity.enterprise_id:
        frappe.throw("无权访问该变更", frappe.PermissionError)
    if change.status == "Cancelled":
        return _public(change)
    if change.status != "Planned":
        frappe.throw("只能取消尚未执行的计划；已开始的迁移必须先恢复", frappe.ValidationError)
    change.status = "Cancelled"
    change.last_actor_identity = identity.name
    change.save(ignore_permissions=True)
    return _public(change)


def _check_existing_values(model, compiled, plan):
    """只读扫描，不自动补值、删字段或修改旧记录。"""
    if not model.active_revision or not plan["needs_data_check"]:
        return
    from shangshu_core.model_schema import field_schema
    from shangshu_core.schema_validation import _validate_schema
    columns = {field["id"]: column["fieldname"] for field, column in
               zip(compiled["fields"], compiled["doctype"]["fields"])}
    fields = {field["id"]: field for field in compiled["fields"]}
    existing_columns = set(frappe.db.get_table_columns(model.physical_doctype))
    names = sorted({columns[check["field"]] for check in plan["needs_data_check"]} & existing_columns)
    offset = 0
    while True:
        rows = frappe.get_all(model.physical_doctype, fields=["name", *names],
                              order_by="name asc", limit_start=offset, limit_page_length=200)
        if not rows:
            return
        for row in rows:
            for check in plan["needs_data_check"]:
                field = fields[check["field"]]
                if field["type"] == "detail":
                    # 明细约束需统计子行，不能读取不存在的 Table 列。
                    column = next(c for c in compiled["doctype"]["fields"] if c["fieldname"] == columns[field["id"]])
                    count = frappe.db.count(column["options"], {"parent":row.name,
                        "parenttype":model.physical_doctype, "parentfield":column["fieldname"]})
                    rules = field.get("constraints", {})
                    if count < rules.get("minItems", 1 if field["required"] else 0) or count > rules.get("maxItems", 1000):
                        frappe.throw("现有明细不满足新行数约束", frappe.ValidationError)
                    continue
                value = row.get(columns[field["id"]])
                if value in (None, ""):
                    if field["required"]:
                        frappe.throw("现有记录缺少必填值，请先补齐后重试", frappe.ValidationError)
                    continue
                if field["type"] == "boolean": value = bool(value)
                if field["type"] == "date": value = str(value)
                _validate_schema(value, field_schema(field), field["label"])
        offset += len(rows)


def _prepare_object_change(change_id, identity):
    """① **准备阶段**（**调用方那条连接**）：读计划 + 校验；**一个字都不写**。

    **为什么计划只能在调用方那条连接上读**：域围栏里，变更单/对象行**刚写、还没提交**
    ⇒ 另一条连接（另一个快照）**看不见** ⇒ 计划数据只能**内存传参**给 ② 那段
    （这就是「独立连接」这条路必须拆成三段的原因）。
    """
    change = frappe.get_doc(CHANGE, change_id)
    model = frappe.get_doc(MODEL, change.object_model)
    _definition(model.application, identity)
    if model.enterprise_id != identity.enterprise_id:
        frappe.throw("无权访问该变更", frappe.PermissionError)
    compiled = json.loads(change.compiled_json)
    plan = json.loads(change.plan_json)
    if plan["blocked"]:
        frappe.throw("包含危险结构变更，不能执行；请取消后调整", frappe.ValidationError)
    from shangshu_core.model_records import check_references
    check_references(compiled)
    return {"change": change, "model": model, "compiled": compiled, "plan": plan,
            "done": change.status == "Applied" and not model.get('scope_fence'), "started": False}


def _lock_object_change(context, identity):
    """① **准备阶段（续）**：**取行锁** ＋ 复核版本（DDL 之前）。

    ⚠️ **「迁移中」这个状态只写在调用方那条连接上、而且不提交** ——
       提交它就等于「提前提交调用方的连接」（审查报告 R01 点名的那个毛病）；
       跨连接的并发由**连接级命名锁** ＋ ③ 的**版本复核**兜住。
    """
    _lifecycle_lock()
    model = write_zone_schema.lock_model(context["model"].name)
    change = frappe.get_doc(CHANGE, context["change"].name, for_update=True)
    context["change"] = change
    context["model"] = model
    if change.status == "Applied" and not model.get('scope_fence'):
        context["done"] = True
        return
    if change.status not in {"Planned", "Running", "Failed", "Applied"} or model.revision != change.target_revision:
        frappe.throw("计划已取消或对象修订已变化", frappe.ValidationError)
    context['model'] = write_zone_schema.begin_schema_change(model, context['fence_token'])
    change.status = "Running"; change.error_message = ""
    change.last_actor_identity = identity.name
    change.save(ignore_permissions=True)
    context["started"] = True


def _write_physical_schema(name, physical, context=None):
    """物理 DocType 的 **schema**（**不含权限**）—— 权限等 DDL 成功后再落。

    ⚠️ **权限为什么不先落**：`frappe.db.updatedb` 要求 `tabDocType` 那一行**已经在库里**
    （查不到就抛「Wrong doctype」）⇒ schema 必须先落；而 Frappe 的 `updatedb()` 内部
    **自己就 `self.commit()`** ⇒ 那一刻起 schema 行就回不去了 ⇒ 权限若也先落，
    **DDL 失败时对象的 ACL 已经改掉** ⇒ 权限留到 DDL 成功之后写
    （见 `_write_object_permissions`）。

    ⚠️ **这里正是「迁移中」这个状态变耐久的那一刻**：物理 DocType 的落库/保存
    **内部就会提交**（`on_update → frappe.db.updatedb → self.commit()`）
    ⇒ 「迁移中」随之落库 ⇒ 失败收口必须能改它（`_mark_object_change_failed`）
    ⇒ 那个标志（`context["durable"]`）**就在这里**置位 ——
    置早一步会让失败收口去改一条**还没落库**的行（另一条连接看不见它）；
    置晚一步会让「已经落库的迁移中」**停在迁移中** ⇒ 同键重试被挡。
    """
    if frappe.db.exists("DocType", name):
        doc = frappe.get_doc("DocType", name)
        allowed = {c["fieldname"] for c in physical["fields"]}
        if not doc.custom or doc.module != "Shangshu Core" or any(f.fieldname not in allowed for f in doc.fields):
            frappe.throw("物理对象与受管定义冲突，停止自动恢复", frappe.ValidationError)
        if context is not None:
            from shangshu_core.managed_nulls import add_nullable_columns
            add_nullable_columns(context["compiled"], context)
        doc.set("fields", physical["fields"])
        # ⚠️ 权限**这里一个字都不动**（保留原样）⇒ DDL 失败时对象的 ACL 一点没变
        doc.save(ignore_permissions=True)
        if context is not None:
            context["durable"] = True      # ← 提交就在这次 save 内部发生
        return doc
    doc = frappe.get_doc({"doctype":"DocType", "module":"Shangshu Core", **physical,
                          "autoname":"hash",
                          # ⚠️ 权限**先空着**：等 DDL 成功之后再写（理由见上面）
                          "permissions": []})
    doc.insert(ignore_permissions=True)
    if context is not None:
        context["durable"] = True          # ← 提交就在这次 insert 内部发生
    return doc


def _apply_object_change_ddl(context):
    """② **DDL 阶段**（**调用方那条连接**）：物理 schema → 真 DDL。

    **为什么 DDL 仍留在调用方那条连接上**（2026-10-26 站上实测，3850）：
    DDL 换一条**独立连接** ⇒ 调用方那条连接（`REPEATABLE-READ`，读视图固定在
    事务开始那一刻）**看不见**独立连接提交的那行 `DocType`，也**读不了**那张新表
    （InnoDB 1412 Table definition has changed）⇒ **晋升整条链**
    （建表 → 接出受管记录 → 读回）会断在半路。
    ⇒ DDL 留在调用方那条连接上。

    ⚠️ **这一段会提交**（2026-10-26 站上实测，Frappe v15 源码
    `frappe/database/mariadb/database.py` 的 `updatedb()` 末尾就是 `self.commit()`，
    `sql_ddl()` 在跑 DDL 之前也 `self.commit()`）⇒ **此刻连接上还没提交的写会被一起带走**。
    ⇒ 保护调用方的业务写**只能靠次序**：**域侧的业务写必须排在迁移之后**
    （文件域 `promotion.define` / `rewrite` 都已改成先跑迁移、后写声明）。
    ⇒ 本阶段**不写权限** —— 权限跟**生效指针**一起走（`_write_object_permissions`）
    ⇒ 不会出现「ACL 已经生效、生效指针没动」那个半写（审查报告 R01）。
    """
    from shangshu_core.record_lifecycle import physical_definition
    compiled = context["compiled"]
    plan = context["plan"]
    write_zone_schema.assert_reference_targets(compiled, source=context['model'].name,
                                               token=context['fence_token'])
    _check_existing_values(context["model"], compiled, plan)
    physical = physical_definition(compiled)
    name = physical["name"]
    # 上一个进程可能在 DDL 后退出；不能以本进程旧表缓存判断是否需要建表。
    frappe.db.get_tables(cached=False)
    frappe.clear_cache(doctype=name)
    doc = _write_physical_schema(name, physical, context)
    context["physical_doc"] = doc
    context["physical"] = physical
    # 元数据已存在但 DDL 中断时，updatedb 再次执行会补齐缺列。
    frappe.db.updatedb(name)
    # Frappe 数值默认 NOT NULL；逻辑可空字段在既有 DDL 阶段补足物理语义。
    from shangshu_core.managed_nulls import apply_schema
    apply_schema(compiled)
    frappe.cache.hdel("table_columns", "tab"+name)
    actual = set(frappe.db.get_table_columns(name))
    expected = {c["fieldname"] for c in physical["fields"] if c["fieldtype"] != "Table"}
    if not expected <= actual:
        frappe.throw("物理字段尚未补齐", frappe.ValidationError)


def _write_object_permissions(context):
    """④ **权限（DocPerm）写在生效指针之后** —— 两者**同一次提交**。

    ⚠️ **为什么排在生效指针之后**（审查报告 R01 · 2026-10-26 站上实测）：
      写物理 DocType 的权限 ⇒ `doc.save()` ⇒ Frappe 的 `on_update` ⇒
      `frappe.db.updatedb()` ⇒ **Frappe 自己在那里 `self.commit()`**
      ⇒ **那一次提交把此刻连接上还没提交的写一起带走**。
      ⇒ 权限若先写、指针后移 ⇒ **权限先落库**；指针那一步随后失败 ⇒
      **「ACL 已经生效、生效指针没动」的半写**（实测就是这个形状）。
      ⇒ 改成**指针先移、权限后写** ⇒ 权限那一次提交**把两者一起带走**
      ⇒ **要么一起生效、要么一起没生效**。

    ⚠️ **权限也要跟着 access 落**（对象声明「谁能读/写这张表」）
      ⇒ 物理表原来一条 DocPerm 都没有 ⇒ **除了管理员谁都读不到行**
      ⇒ 域里「按值认行」撞 PermissionError ⇒ 入档/认行做不了。
    """
    doc = context["physical_doc"]
    physical = context["physical"]
    doc.set("permissions", physical.get("permissions") or [])
    doc.save(ignore_permissions=True)
    # ⚠️ **这里发生一次提交**（`doc.save()` → `on_update` → `updatedb()` → `self.commit()`）
    #   ⇒ **生效指针（③）与权限（④）这一次一起落库** ⇒ 不会半写。
    # ⚠️ **迁移本体到这里才算完成** ⇒ 往后（回包整形等）出错不许再改状态成「失败」。
    context["completed"] = True


def _activate_object_change(context, identity):
    """③ **激活阶段**（**调用方那条连接**）：**重新取锁、读版本、核验**，再移动生效指针。

    **为什么必须重新取锁、重新读版本**：② 的 DDL 可能花时间
    ⇒ 这期间别人可能改了对象（改了草稿、改了修订号）⇒ 移动生效指针之前
    **必须重新拿一次行锁、重读一次版本** ⇒ 版本对不上就**不许移动**
    （宁可不做，也不要拿旧计划盖掉别人的新版本）。

    ⚠️ **这里的写不提交** ⇒ 生效指针跟**权限**（`_write_object_permissions`）
       在**同一次提交**里落库 ⇒ **要么一起生效、要么一起没生效**（不半写）。
    """
    model = write_zone_schema.recover_schema_change(context['model'], context['fence_token'])
    write_zone_schema.assert_reference_targets(context['compiled'], source=model.name,
                                               token=context['fence_token'])
    change = frappe.get_doc(CHANGE, context["change"].name, for_update=True)
    if change.status == "Applied":
        context["done"] = True
        context["change"] = change
        return
    if model.revision != change.target_revision:
        frappe.throw("对象修订已变化，生效指针没有移动；请重新发起变更", frappe.TimestampMismatchError)
    model.active_json = change.compiled_json
    model.active_revision = change.target_revision
    model.save(ignore_permissions=True)
    change.status = "Applied"; change.error_message = ""
    change.last_actor_identity = identity.name
    change.save(ignore_permissions=True)
    context["change"] = change
    # ⚠️ **到这里迁移本体还没完成** —— 权限（④）还没写
    # ⇒ 失败收口**仍然要**把这条变更单改成「失败」（否则同键重试被挡）。
    #   「迁移本体完成」的判定点在 `_write_object_permissions` 之后。


def _verify_object_change(context, model):
    """门闸最后核验：定义、回执、物理列与权限均完整，之后不再执行 DDL。"""
    change = frappe.get_doc(CHANGE, context['change'].name, for_update=True)
    if (change.status != 'Applied' or model.active_revision != change.target_revision
            or json.loads(model.active_json) != json.loads(change.compiled_json)):
        return False
    physical = context['physical']
    doc = frappe.get_doc('DocType', physical['name'])
    expected = {column['fieldname'] for column in physical['fields'] if column['fieldtype'] != 'Table'}
    if not expected <= set(frappe.db.get_table_columns(physical['name'])):
        return False
    if len(doc.permissions) != len(physical.get('permissions') or []):
        return False
    for permission in physical.get('permissions') or []:
        if not any(all((row.get(key) or 0) == (value or 0) for key, value in permission.items())
                   for row in doc.permissions):
            return False
    from shangshu_core.managed_nulls import _ddl, _schema
    return not _ddl(context['compiled'], _schema(physical['name']))


def _mark_object_change_failed(context):
    """失败收口：变更单从「迁移中」改成「失败」（**在另一条连接上落库**）。

    **为什么必须在另一条连接上**：DDL 跑在调用方那条连接上，而 Frappe v15 的
    `updatedb()` **自己就 `self.commit()`**（`frappe/database/mariadb/database.py`
    末尾）⇒ 「**迁移中**」这个状态**已经被提交了** ⇒ 外层回滚之后，库里那条变更单
    会停在「迁移中」⇒ **同键重试会被挡住**（「该对象已有未完成变更」）⇒ 人就卡住了。

    ⚠️ **为什么这里不回滚调用方那条连接**（2026-10-26 核 Frappe v15 源码）：
      · `frappe.db.rollback()`（不带 save_point）**回滚整条事务** ⇒ 会把
        **动作请求行**（域围栏之前就写下的）一起丢掉 ⇒ 失败回执写不上
        （`action_requests.fail` 更新 0 行）⇒ **失败原因丢失**；
      · 它还会 `before_commit.reset()` ⇒ **把域围栏的提交屏障抹掉**。
      ⇒ 失败路径只做**一件事**：把变更单从「迁移中」改成「失败」，
        其余（域的待写内容、行锁）交给最外层请求边界处置。

    ⚠️ **只有「迁移中」已经耐久时才需要改**：DDL 那次提交之前就失败
      ⇒ 「迁移中」还没落库 ⇒ 外层回滚会把它带走 ⇒ 库里没有僵尸行，不用改。
    """
    if not context.get("started") or context.get("completed"):
        return
    if not context.get("durable"):
        # 「迁移中」还没落库（DDL 那次提交之前就失败）⇒ 外层回滚会带走它
        return
    change = context["change"]
    message = "迁移未完成，原生效版本保留；请用本计划重试恢复。"
    try:
        from shangshu_core.independent_migration import independent_connection
        with independent_connection() as db:
            db.sql("UPDATE `tabShangshu Schema Change` SET status=%s, error_message=%s,"
                   " modified=NOW() WHERE name=%s AND status=%s",
                   ("Failed", message, change.name, "Running"))
            db.commit()
    except Exception as error:
        # 收口本身失败不许盖掉真正的错因（让原异常继续往上抛）。
        # 后果：库里那条变更单停在「迁移中」⇒ 同键重试会被挡（要人工看一眼）。
        print("DEBUG 迁移失败收口没落库:", repr(error))
        try:
            frappe.log_error(title="迁移失败收口没落库", message=str(error))
        except Exception:
            pass


def execute_object_change(change_id, confirmed=False):
    """独立命令：**准备 → DDL → 激活**，核对后才移动生效指针。

    **三段**（审查报告 R01 · PKG-128-T08 · 2026-10-26 用户定「乙」）：
      ① **准备**（调用方那条连接）：读计划、校验、**取行锁**；只写「迁移中」这个状态；
      ② **DDL**（调用方那条连接）：物理 schema → 真 DDL → **成功后才写权限**；
      ③ **激活**（调用方那条连接）：**重新取锁、读版本、核验**，再移动生效指针。

    **为什么 DDL 不换独立连接**（站上实测，3850）：换独立连接 ⇒ 调用方那条连接
    （`REPEATABLE-READ`）看不见独立连接提交的元数据、也**读不了**那张新表
    （InnoDB 1412）⇒ **晋升整条链**会断在半路。

    **「不提前提交外层事务」靠三件事保证**（不是靠换连接）：
      · **权限在 DDL 成功之后才写** ⇒ DDL 失败 ⇒ 对象的 ACL 一点没动；
      · **文件侧的晋升声明写在迁移之后** ⇒ DDL 的隐式提交带不跑业务写；
      · **本命令自己不提交**（除 DDL 那次隐式提交）⇒ 域的待写内容由外层边界处置。

    ⚠️ **不再要求「调用方那条连接是干净的」**：以前那个 `transaction_writes` 的
    前置条件是靠「先提交清零」伪造出来的（提交 ⇒ 域的待写内容被提前落库）。

    **「不提前提交外层事务」靠的是次序，不是连接干净**（2026-10-26 站上实测）：
      Frappe v15 的 `updatedb()` **自己就 `self.commit()`**（`sql_ddl()` 跑 DDL 前
      也提交）⇒ **DDL 那一刻连接上还没提交的写，会被一起带走**（实测：哨兵行
      在迁移后被另一条连接看见了）⇒ **域侧的业务写必须排在迁移之后**
      （文件域 `promotion.define`／`rewrite` 已改成先跑迁移、后写声明）。

    **「失败不激活半套定义或权限」靠的是③④同一次提交**：生效指针与 DocPerm
      在同一次提交里落库 ⇒ 要么一起生效、要么一起没生效。
    """
    write_zone_schema.assert_engineering_entry()
    identity = _designer()
    if confirmed is not True:
        frappe.throw("请明确确认对象变更", frappe.ValidationError)
    # ① 准备阶段（调用方那条连接）：读计划 + 校验
    context = _prepare_object_change(change_id, identity)
    if context["done"]:
        return _public(context["change"])
    context['fence_token'] = 'schema-change:' + context['change'].name
    with write_zone_schema.schema_lock(context['model'].name), write_zone_schema.schema_operation(
            context['model'].name, context['fence_token']):
        try:
            _lock_object_change(context, identity)
            if context["done"]:
                return _public(context["change"])
            # 首次既有 DDL commit 同时使 fence 耐久；不额外提交调用方业务。
            _apply_object_change_ddl(context)
            _activate_object_change(context, identity)
            _write_object_permissions(context)
            write_zone_schema.finish_schema_change(context['model'], context['fence_token'],
                lambda model: _verify_object_change(context, model))
            return _public(context["change"])
        except Exception:
            # 已耐久 fence 留给同计划恢复；正常 rollback 不会误清它。
            _mark_object_change_failed(context)
            raise
