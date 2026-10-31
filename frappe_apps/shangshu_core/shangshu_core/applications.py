"""受管应用草稿；不要求用户先安装代码域，不产生业务事实副本。"""
import json
import uuid

import frappe

from shangshu_core.domains import list_domains, _resource_id
from shangshu_core.identity import get_identity
from shangshu_core.design_support import (
    canonical_json as _json, content_hash as _hash, require_designer as _designer,
    require_application as _definition, lock_lifecycle as _lifecycle_lock,
)

DEFINITION = "Shangshu Application Definition"
REVISION = "Shangshu Application Revision"
RELEASE = "Shangshu Application Release"
KINDS = {"objects", "datasets", "processes", "actions", "tools", "services", "events", "pages"}


def _managed_resource(binding, application_id):
    """本应用自建对象的绑定适配；不把应用伪装成已安装代码域。"""
    from shangshu_core.model_changes import MODEL
    model = frappe.get_doc(MODEL,binding["resource_id"])
    if model.application != application_id or binding["owner_domain"] != application_id or binding["kind"] not in {"objects","datasets"}:
        frappe.throw("只能引用本应用自建对象",frappe.PermissionError)
    if not model.active_revision or binding["version"] != str(model.active_revision):
        frappe.throw("对象版本已变化，请重新选择",frappe.ValidationError)
    if frappe.db.exists("Shangshu Schema Change",{"object_model":model.name,"status":["in",["Running","Failed"]]}):
        frappe.throw("对象迁移未完成",frappe.ValidationError)
    compiled = json.loads(model.active_json)
    from shangshu_core.model_records import check_references
    check_references(compiled)
    if compiled["kind"] != "record":
        frappe.throw("明细通过主表使用，不单独发布",frappe.ValidationError)
    return {"id":model.name,"object_id":model.name,"name":compiled["title"],"title":compiled["title"],
            "source":"managed","roles":compiled.get("access",{}).get("read_roles",["Desk User"]),
            "definition_hash":_hash(compiled)}


def _validate(spec, lock=False, application_id=None, model_lookup=None):
    if not isinstance(spec, dict) or set(spec) - {"schema_version", "title", "description", "bindings", "allowed_roles", "pages", "workflows", "overview"}:
        frappe.throw("应用定义包含不支持的字段", frappe.ValidationError)
    title = spec.get("title")
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 100:
        frappe.throw("应用名称需为 1–100 个字符", frappe.ValidationError)
    if spec.get("schema_version") != 1 or isinstance(spec.get("schema_version"), bool):
        frappe.throw("应用定义版本不支持", frappe.ValidationError)
    description = spec.get("description", "")
    if not isinstance(description, str) or len(description) > 1000:
        frappe.throw("应用描述不能超过 1000 个字符", frappe.ValidationError)
    roles = spec.get("allowed_roles", [])
    if not isinstance(roles, list) or not roles or any(not isinstance(role, str) or role in {"Guest", "All"} or not frappe.db.exists("Role", {"name": role, "disabled": 0}) for role in roles):
        frappe.throw("请选择有效的应用使用角色", frappe.ValidationError)
    bindings = spec.get("bindings", [])
    if not isinstance(bindings, list) or len(bindings) > 200:
        frappe.throw("资源引用必须是列表，最多 200 项", frappe.ValidationError)
    domains = list_domains(include_disabled=True, for_update=lock)
    snapshots, seen = [], set()
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {"kind", "resource_id", "owner_domain", "version"}:
            frappe.throw("资源引用必须声明类型、ID、所有者和版本", frappe.ValidationError)
        if any(not isinstance(value, str) or not value for value in binding.values()):
            frappe.throw("资源引用字段必须为非空文本", frappe.ValidationError)
        kind, resource_id = binding["kind"], binding["resource_id"]
        if kind not in KINDS or (kind, resource_id) in seen:
            frappe.throw("资源类型不支持或引用重复", frappe.ValidationError)
        seen.add((kind, resource_id))
        if binding["owner_domain"] == application_id:
            if model_lookup:
                public, compiled = model_lookup(resource_id)
                if kind not in {'datasets','objects'} or compiled['kind'] != 'record' or binding['version'] != str(public['revision']):
                    frappe.throw('导入对象引用无效', frappe.ValidationError)
                resource = {'id':resource_id,'definition_hash':_hash(compiled)}
            else:
                resource = _managed_resource(binding,application_id)
            snapshots.append({**binding,"declaration_hash":_hash(resource)})
            continue
        matches = [(domain, item) for domain in domains
                   for item in domain["contribution"].get(kind, []) if _resource_id(kind, item) == resource_id]
        if len(matches) != 1:
            frappe.throw("引用资源不存在或所有权冲突", frappe.ValidationError)
        domain, resource = matches[0]
        if not domain["enabled"] or domain["id"] != binding["owner_domain"] or domain["version"] != binding["version"]:
            frappe.throw("引用资源已停用、所有者或版本不匹配", frappe.ValidationError)
        snapshots.append({**binding, "declaration_hash": _hash(resource)})
    result={"schema_version": 1, "title": title.strip(), "description": description,
            "allowed_roles": sorted(set(roles)), "bindings": bindings}
    if any(key in spec for key in ("pages","workflows","overview")):
        from shangshu_core.application_pages import compile_pages
        result.update(compile_pages(spec,application_id,model_lookup=model_lookup))
    return result, snapshots


def _public(doc):
    return {"id": doc.name, "source": "managed", "namespace": doc.namespace,
            "status": doc.status, "draft_revision": doc.draft_revision,
            "draft": json.loads(doc.draft_json), "owner_identity": doc.owner_identity,
            "published_revision": doc.published_revision}


def publish_application_definition(application_id, expected_revision):
    """发布只移动到已冻结的修订；草稿修改不改变此指针。"""
    identity = _designer()
    _lifecycle_lock()
    doc = _definition(application_id, identity, lock=True)
    if isinstance(expected_revision, bool) or str(expected_revision) != str(doc.draft_revision):
        frappe.throw("应用草稿已变化，请重新检查后发布", frappe.TimestampMismatchError)
    history = frappe.get_doc(REVISION, f"{doc.name}:{doc.draft_revision}")
    spec, dependencies = _validate(json.loads(history.definition_json), lock=True, application_id=application_id)
    if _json(dependencies) != _json(json.loads(history.dependencies_json)):
        frappe.throw("资源声明已变化，请重新保存草稿并检查影响", frappe.ValidationError)
    if _json(spec) != _json(json.loads(history.definition_json)):
        frappe.throw("表单依赖已变化，请重新保存草稿并检查影响", frappe.ValidationError)
    if not spec["bindings"]:
        frappe.throw("请先为应用配置资源，空应用不能发布", frappe.ValidationError)
    if doc.published_revision == history.name and doc.status == "Published":
        return _public(doc)
    point = "app_publish_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        from shangshu_core.application_pages import publish_workflows
        publish_workflows(doc,spec)
        frappe.get_doc({"doctype": RELEASE, "application": doc.name, "revision": history.name,
                        "previous_revision": doc.published_revision, "actor_identity": identity.name}).insert(ignore_permissions=True)
        doc.published_revision = history.name
        doc.status = "Published"
        doc.save(ignore_permissions=True)
    except Exception:
        frappe.db.rollback(save_point=point)
        raise
    return _public(doc)


def _resolve_dependencies(history, domains):
    resources = {kind: [] for kind in KINDS}
    issues = []
    for binding in json.loads(history.dependencies_json):
        if binding["owner_domain"] == history.application:
            try:
                resource = _managed_resource(binding,history.application)
                if _hash(resource) != binding["declaration_hash"]:
                    raise frappe.ValidationError("对象声明已变化")
                resources[binding["kind"]].append(resource)
            except (frappe.DoesNotExistError,frappe.ValidationError,frappe.PermissionError):
                issues.append({"code":"version_changed","kind":binding["kind"],"resource_id":binding["resource_id"]})
            continue
        domain = domains.get(binding["owner_domain"])
        candidates = [] if not domain else [item for item in domain["contribution"].get(binding["kind"], [])
            if _resource_id(binding["kind"], item) == binding["resource_id"]]
        code = ("domain_missing" if not domain else "domain_disabled" if not domain["enabled"] else
                "version_changed" if domain["version"] != binding["version"] else
                "resource_missing_or_ambiguous" if len(candidates) != 1 else
                "declaration_changed" if _hash(candidates[0]) != binding["declaration_hash"] else None)
        if code:
            issues.append({"code": code, "kind": binding["kind"], "resource_id": binding["resource_id"],
                           "owner_domain": binding["owner_domain"], "expected_version": binding["version"],
                           "actual_version": domain["version"] if domain else None})
        else:
            resources[binding["kind"]].append(candidates[0])
    return resources, issues


def _dependency_domains(history):
    """只读取此发布修订明确依赖的代码域；自建对象走原模型校验。"""
    owners = sorted({binding["owner_domain"] for binding in json.loads(history.dependencies_json)
                     if binding["owner_domain"] != history.application})
    return {row["id"]: row for row in list_domains(include_disabled=True, domain_ids=owners)}


def get_application_release_status(application_id):
    doc = _definition(application_id, _designer())
    return _release_status(doc, list_domains(include_disabled=True))


def _release_status(doc, domains):
    issues = []
    if doc.published_revision:
        history = frappe.get_doc(REVISION, doc.published_revision)
        if history.application != doc.name:
            frappe.throw("应用发布修订归属异常", frappe.ValidationError)
        _, issues = _resolve_dependencies(history, {row["id"]: row for row in domains})
    return {"application_id": doc.name, "status": doc.status, "published_revision": doc.published_revision,
            "available": doc.status == "Published" and bool(doc.published_revision) and not issues,
            "issues": issues, "releases": frappe.get_all(RELEASE, filters={"application": doc.name},
                fields=["name", "revision", "previous_revision", "actor_identity", "creation", "action", "reason"], order_by="creation desc", limit_page_length=100)}


def set_application_enabled(application_id, enabled, reason, expected_revision):
    identity = _designer()
    _lifecycle_lock()
    doc = _definition(application_id, identity, lock=True)
    if isinstance(expected_revision, bool) or str(expected_revision) != str(doc.draft_revision):
        frappe.throw("应用已变化，请刷新后重试", frappe.TimestampMismatchError)
    if enabled not in (True, False, 0, 1, "0", "1"):
        frappe.throw("启停状态无效", frappe.ValidationError)
    target = enabled in (True, 1, "1")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
        frappe.throw("请填写 1–1000 字启停原因", frappe.ValidationError)
    if not doc.published_revision:
        frappe.throw("应用尚未发布，请先配置并发布", frappe.ValidationError)
    if target:
        history = frappe.get_doc(REVISION, doc.published_revision)
        _, issues = _resolve_dependencies(history, {row["id"]: row for row in list_domains(include_disabled=True, for_update=True)})
        if issues:
            frappe.throw("应用依赖不可用，请先处理发布检查中的问题", frappe.ValidationError)
    status = "Published" if target else "Disabled"
    if doc.status == status:
        return _public(doc)
    point = "app_status_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        frappe.get_doc({"doctype": RELEASE, "application": doc.name, "revision": doc.published_revision,
                        "previous_revision": doc.published_revision, "actor_identity": identity.name,
                        "action": "Enable" if target else "Disable", "reason": reason.strip()}).insert(ignore_permissions=True)
        doc.status = status
        doc.save(ignore_permissions=True)
    except Exception:
        frappe.db.rollback(save_point=point)
        raise
    return _public(doc)


def domain_application_dependents(domain_id):
    """站点级域启停门禁；只返回管理操作所需的应用 ID/名称。"""
    result = []
    table = frappe.qb.DocType(DEFINITION)
    rows = frappe.qb.from_(table).select(table.name, table.published_revision).where(table.status == "Published").for_update().run(as_dict=True)
    for row in rows:
        if not row.published_revision:
            continue
        history = frappe.get_doc(REVISION, row.published_revision)
        if any(item["owner_domain"] == domain_id for item in json.loads(history.dependencies_json)):
            result.append({"id": row.name, "title": json.loads(history.definition_json)["title"]})
    return result


def published_application_catalog(include_resources=False, application_id=None, summary=False):
    """员工读取冻结定义；领域资源仍按原接口鉴权，应用不能授予数据权限。

    ⚠️ `application_id`：**按 ID 取一个**时用（2026-10-28 · PKG-132 · R13）——
    不给就把**全部**已发布应用装配一遍再挑一个（读一个＝装配全部）。
    """
    identity = get_identity()
    roles = set(frappe.get_roles())
    from shangshu_core import business_access
    result = []
    filters = {"enterprise_id": identity.enterprise_id, "status": "Published"}
    if application_id:
        filters["name"] = application_id
    for row in frappe.get_all(DEFINITION, filters=filters,
                              fields=["name", "published_revision"], order_by="creation asc"):
        if not row.published_revision:
            continue
        history = frappe.get_doc(REVISION, row.published_revision)
        if history.application != row.name:
            frappe.throw("应用发布修订归属异常", frappe.ValidationError)
        spec = json.loads(history.definition_json)
        if (not business_access.resource_is_open(row.name)
                and "System Manager" not in roles and not roles.intersection(spec["allowed_roles"])):
            continue
        resources, issues = _resolve_dependencies(history, _dependency_domains(history))
        if issues:
            continue
        if summary and not include_resources:
            # 已核验身份、发布版本与依赖；导航不读每张表的字段/筛选器。
            result.append({"id": row.name, "source": "managed", "title": spec["title"],
                "description": spec["description"], "enabled": True,
                "published_revision": history.revision_number})
            continue
        from shangshu_core.domains import _visible_to_roles
        for kind, items in resources.items():
            resources[kind] = [item for item in items if not isinstance(item, dict)
                               or _visible_to_roles(item, roles)]
        from shangshu_core import model_records
        from shangshu_core.domains import _dataset_doctypes, _readable_dataset
        visible_datasets=[]
        doctypes_by_domain={}
        for item in resources["datasets"]:
            try:
                if item.get("source")=="managed":
                    visible_datasets.append(model_records.dataset(item["id"]))
                else:
                    owner = next((binding["owner_domain"] for binding in spec["bindings"]
                                  if binding["kind"]=="datasets" and binding["resource_id"]==item["id"]), None)
                    if owner:
                        if owner not in doctypes_by_domain:
                            doctypes_by_domain[owner] = _dataset_doctypes(owner)
                        if _readable_dataset(item, doctypes_by_domain[owner]):
                            visible_datasets.append(item)
            except frappe.PermissionError:continue
        resources["datasets"]=visible_datasets
        for dataset in resources["datasets"]:
            page=next((p for p in spec.get("pages",[]) if p["object_id"]==dataset["id"]),None)
            if page and page.get("list_fields"):
                dataset["columns"]=[c for c in dataset.get("columns",[]) if c["field"] in page["list_fields"]]
                dataset["filters"]=[c for c in dataset.get("filters",[]) if c["field"] in page["list_fields"]]
        app = {"id": row.name, "source": "managed", "title": spec["title"], "description": spec["description"],
               "enabled": True, "published_revision": history.revision_number,
               "datasets": resources["datasets"], "processes": resources["processes"],
               "resource_counts": {key: len(value) for key, value in resources.items()}}
        from shangshu_core.application_pages import process_id
        app["processes"].extend({"id":process_id(row.name,flow),"title":flow["title"],"name":flow["title"],"source":"managed"} for flow in spec.get("workflows",[]))
        app["resource_counts"]["processes"]=len(app["processes"])
        app["overview_enabled"]=spec.get("overview",False)
        if include_resources:
            app["resources"] = resources
        result.append(app)
    return result


def _record_revision(doc, identity, dependencies):
    frappe.get_doc({"doctype": REVISION, "revision_key": f"{doc.name}:{doc.draft_revision}",
                    "application": doc.name, "revision_number": doc.draft_revision,
                    "actor_identity": identity.name, "definition_json": doc.draft_json,
                    "dependencies_json": _json(dependencies)}).insert(ignore_permissions=True)


def create_application_definition(title, idempotency_key):
    identity = _designer()
    if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 200:
        frappe.throw("新建应用需要有效幂等键", frappe.ValidationError)
    spec, dependencies = _validate({"schema_version": 1, "title": title, "description": "",
                                    "bindings": [], "allowed_roles": ["Desk User"]})
    key = _hash([identity.identity_id, identity.enterprise_id, idempotency_key])
    existing = frappe.db.get_value(DEFINITION, {"creation_key": key}, "name")
    if existing:
        doc = _definition(existing, identity)
        if doc.creation_hash != _hash(spec):
            frappe.throw("幂等键已用于不同的新建请求", frappe.DuplicateEntryError)
        return _public(doc) | {"idempotent": True}
    app_id = "com.shangshu.app." + uuid.uuid4().hex
    point = "app_create_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        doc = frappe.get_doc({"doctype": DEFINITION, "application_id": app_id, "namespace": app_id,
                              "enterprise_id": identity.enterprise_id, "owner_identity": identity.name,
                              "creation_key": key, "creation_hash": _hash(spec), "draft_revision": 1,
                              "status": "Draft", "title": spec["title"], "draft_json": _json(spec)}).insert(ignore_permissions=True)
        _record_revision(doc, identity, dependencies)
        return _public(doc) | {"idempotent": False}
    except frappe.DuplicateEntryError:
        frappe.db.rollback(save_point=point)
        existing = frappe.db.get_value(DEFINITION, {"creation_key": key}, "name", for_update=True)
        if not existing:
            raise
        doc = _definition(existing, identity, lock=True)
        if doc.creation_hash != _hash(spec):
            frappe.throw("幂等键已用于不同的新建请求", frappe.DuplicateEntryError)
        return _public(doc) | {"idempotent": True}
    except Exception:
        frappe.db.rollback(save_point=point)
        raise


def get_application_definition(application_id):
    doc = _definition(application_id, _designer())
    result = _public(doc)
    domains = list_domains(include_disabled=True)
    result["design_context"] = {"domains": domains, "resource_options": _resource_options(domains),
                                "release": _release_status(doc, domains), "delivery_format":"shangshu.application/1"}
    from shangshu_core.actions import list_registered_actions
    result["design_context"]["configuration_actions"] = [action for action in list_registered_actions(tools_only=True)
                                                         if action['id']=='platform.application.configure']
    from shangshu_core.model_changes import MODEL, CHANGE
    models = frappe.get_all(MODEL,filters={"application":doc.name},fields=["name","revision","active_revision","draft_json","active_json"])
    result["design_context"]["models"] = []
    for model in models:
        compiled = json.loads(model.draft_json)
        pending = frappe.db.get_value(CHANGE,{"object_model":model.name,"status":["in",["Planned","Running","Failed"]]},"name")
        from shangshu_core.model_schema import record_schema
        from shangshu_core.model_records import _references, design_capabilities
        result["design_context"]["models"].append({"id":model.name,"revision":model.revision,"active_revision":model.active_revision,
            "input_schema":record_schema(compiled,_references(compiled)),
            "definition":{k:compiled[k] for k in ("title","schema_version","kind","fields","access") if k in compiled},"change_id":pending,
            "capabilities":design_capabilities(model)})
        if model.active_revision and json.loads(model.active_json)["kind"]=="record":
            result["design_context"]["resource_options"].append({"kind":"datasets","resource_id":model.name,"owner_domain":doc.name,
                "version":str(model.active_revision),"domain":"本应用","enabled":True,"label":json.loads(model.active_json)["title"]})
    labels = {"Desk User": "普通员工", "System Manager": "系统管理员"}
    result["role_options"] = [{"id": row.name, "label": labels.get(row.name) or frappe._(row.name, lang="zh")}
                              for row in frappe.get_all("Role", filters={"disabled": 0}, fields=["name"], order_by="name asc")
                              if row.name not in {"Guest", "All"}]
    return result


def _resource_options(domains):
    return [{"kind": kind, "resource_id": _resource_id(kind, item), "owner_domain": domain["id"],
             "version": domain["version"], "domain": domain["name"], "enabled": domain["enabled"],
             "label": (item.get("name") or item.get("title") or item.get("label") or item.get("id"))
                       if isinstance(item, dict) else str(item)}
            for domain in domains for kind in sorted(KINDS)
            for item in domain["contribution"].get(kind, [])]


def design_application_catalog(code_apps):
    """既有管理员设计目录的统一投影；不替换员工目录。"""
    identity = _designer()
    result = [dict(app, source="code", editable=False) for app in code_apps]
    for row in frappe.get_all(DEFINITION, filters={"enterprise_id": identity.enterprise_id},
                              fields=["name", "title", "status", "draft_json", "draft_revision"],
                              order_by="modified desc", limit_page_length=200):
        spec = json.loads(row.draft_json)
        counts = {kind: sum(item["kind"] == kind for item in spec["bindings"]) for kind in KINDS}
        counts["processes"]+=len(spec.get("workflows",[]))
        counts["pages"]+=len(spec.get("pages",[]))
        result.append({"id": row.name, "title": row.title, "description": spec.get("description", ""),
                       "source": "managed", "editable": True, "status": row.status,
                       "enabled": row.status == "Published", "draft_revision": row.draft_revision,
                       "resource_counts": counts})
    return result


def list_application_definitions():
    identity = _designer()
    rows = frappe.get_all(DEFINITION, filters={"enterprise_id": identity.enterprise_id},
                          fields=["name"], order_by="modified desc", limit_page_length=200)
    return [_public(_definition(row.name, identity)) for row in rows]


def save_application_draft(application_id, definition, expected_revision):
    identity = _designer()
    doc = _definition(application_id, identity, lock=True)
    if isinstance(expected_revision, bool) or str(expected_revision) != str(doc.draft_revision):
        frappe.throw("应用已被其他修改更新，请重新读取后合并", frappe.TimestampMismatchError)
    spec, dependencies = _validate(frappe.parse_json(definition) if isinstance(definition, str) else definition, application_id=application_id)
    history = frappe.get_doc(REVISION, f"{doc.name}:{doc.draft_revision}")
    if _json(spec) == _json(json.loads(doc.draft_json)) and _json(dependencies) == _json(json.loads(history.dependencies_json)):
        return _public(doc)
    point = "app_save_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        doc.title, doc.draft_json = spec["title"], _json(spec)
        doc.draft_revision += 1
        doc.save(ignore_permissions=True)
        _record_revision(doc, identity, dependencies)
        return _public(doc)
    except Exception:
        frappe.db.rollback(save_point=point)
        raise
