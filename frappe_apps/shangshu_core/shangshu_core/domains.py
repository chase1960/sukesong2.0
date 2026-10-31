import copy
import importlib
import json
import re

import frappe
from frappe.utils import now_datetime
from shangshu_core.domain_execution import resource_execution
from shangshu_core import unified_log, request_cache


DOMAIN_DOCTYPE = "Shangshu Domain"
# 旧表（PKG-020-T01 之后**不再新增**：域变更审计只写统一日志表 `Shangshu Unified Log`；
# 这张表保留表结构与历史行，读口把它合并进来）。
AUDIT_DOCTYPE = "Shangshu Domain Change Audit"
CORE_DOMAIN_ID = "com.shangshu.core"
WORKBENCH_API_VERSION = "1.0.0"
WORKBENCH_KINDS = {"metric"}
RESOURCE_SECTIONS = (
    "applications", "navigation", "workbench", "objects", "datasets", "processes",
    "actions", "tools", "services", "events", "subscriptions", "roles", "pages",
)
PRIVATE_KEYS = {"query", "workbench_provider", "handler", "executor", "doctype", "execution_guard", "work_update_guard",
                # 逐项审核（G3）与重放守卫：实现路径只给内核调度器，不进公开贡献。
                # 基线内核已有前两个，重做内核时丢了；`replay_guard` 是我们新加的，一并收进来。
                # 合并说明：fast 那边的 PRIVATE_KEYS 是本集合的子集，**并集**取本集合（两边的私有键都留）。
                # `review_save_policy`（PKG-033-T01）：动作声明「这一组不许部分保存」——
                # 那是**内核与域之间**的约定，不进公开贡献（浏览器从域的审核声明那一侧知道口径）。
                "proposal_guard", "proposal_snapshot", "proposal_projection", "review_handler", "replay_guard",
                "review_save_policy", "transaction", "transaction_versions", "package_actions", "package_guard"}
DOMAIN_ID_RE = re.compile(r"^com\.shangshu\.[a-z0-9][a-z0-9._-]*$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
PLATFORM_V1_RANGE_RE = re.compile(r"^(?:\^1(?:\.\d+){0,2}|>=1(?:\.\d+){0,2}\s+<2(?:\.0){0,2})$")
RESOURCE_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")
ROUTE_ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")
WORKBENCH_DEFINITION_KEYS = {"id", "title", "kind", "route", "dataset", "roles"}
WORKBENCH_RESULT_KEYS = {
    "id", "title", "kind", "route", "dataset", "roles", "value", "unit",
    "description", "domain_id", "domain_name",
}


def _resource_id(section, raw):
    if not isinstance(raw, dict):
        return str(raw or "").strip()
    if section == "roles":
        return str(raw.get("role") or raw.get("id") or "").strip()
    return str(raw.get("id") or "").strip()


def _require_manager():
    if "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)


def _providers():
    result = []
    for path in frappe.get_hooks("shangshu_domain_contributions") or []:
        provider = frappe.get_attr(path)
        contribution = provider()
        if isinstance(contribution, dict):
            result.append(contribution)
    return result


def _validate_workbench_declarations(domain_id, contribution):
    definitions = contribution.get("workbench") or []
    provider = str(contribution.get("workbench_provider") or "").strip()
    if not definitions and not provider:
        return
    if str(contribution.get("workbench_api") or "") != WORKBENCH_API_VERSION:
        frappe.throw(
            f"工作台贡献必须声明 workbench_api {WORKBENCH_API_VERSION}：{domain_id}",
            frappe.ValidationError,
        )
    if not definitions or not provider:
        frappe.throw(f"工作台声明与 workbench_provider 必须同时存在：{domain_id}", frappe.ValidationError)
    owner_app = str(contribution.get("owner_app") or "").strip()
    if not owner_app or not provider.startswith(f"{owner_app}."):
        frappe.throw(f"工作台提供器必须位于所属 App：{domain_id}/{provider or 'missing'}", frappe.PermissionError)
    dataset_ids = {_resource_id("datasets", item) for item in contribution.get("datasets") or []}
    for item in definitions:
        if not isinstance(item, dict):
            frappe.throw(f"工作台组件必须是对象：{domain_id}", frappe.ValidationError)
        unknown = sorted(set(item) - WORKBENCH_DEFINITION_KEYS)
        if unknown:
            frappe.throw(f"工作台组件包含未支持字段：{domain_id}/{item.get('id')} {unknown}", frappe.ValidationError)
        card_id = _resource_id("workbench", item)
        if not RESOURCE_ID_RE.fullmatch(card_id):
            frappe.throw(f"工作台组件必须使用命名空间 ID：{domain_id}/{card_id or 'missing'}", frappe.ValidationError)
        title = str(item.get("title") or "").strip()
        if not title or len(title) > 80:
            frappe.throw(f"工作台组件标题缺失或过长：{domain_id}/{card_id}", frappe.ValidationError)
        if item.get("kind") not in WORKBENCH_KINDS:
            frappe.throw(f"工作台组件类型不受 v1 支持：{domain_id}/{card_id}", frappe.ValidationError)
        if not ROUTE_ID_RE.fullmatch(str(item.get("route") or "")):
            frappe.throw(f"工作台组件路由不合法：{domain_id}/{card_id}", frappe.ValidationError)
        dataset_id = str(item.get("dataset") or "").strip()
        if dataset_id and dataset_id not in dataset_ids:
            frappe.throw(f"工作台组件引用了本领域未声明的数据集：{domain_id}/{card_id}/{dataset_id}", frappe.ValidationError)
        roles = item.get("roles") or []
        if not isinstance(roles, list) or any(not isinstance(role, str) or not role.strip() for role in roles):
            frappe.throw(f"工作台组件 roles 必须是非空字符串数组：{domain_id}/{card_id}", frappe.ValidationError)


def _normalize_workbench_cards(contribution, raw_cards):
    domain_id = contribution["id"]
    definitions = {_resource_id("workbench", item): item for item in contribution.get("workbench") or []}
    if not isinstance(raw_cards, (list, tuple)):
        frappe.throw(f"工作台提供器必须返回数组：{domain_id}", frappe.ValidationError)
    result = []
    seen = set()
    for raw in raw_cards:
        if not isinstance(raw, dict):
            frappe.throw(f"工作台提供器返回项必须是对象：{domain_id}", frappe.ValidationError)
        unknown = sorted(set(raw) - WORKBENCH_RESULT_KEYS)
        card_id = _resource_id("workbench", raw)
        if unknown:
            frappe.throw(f"工作台提供器返回未支持字段：{domain_id}/{card_id or 'missing'} {unknown}", frappe.ValidationError)
        if card_id not in definitions:
            frappe.throw(f"工作台提供器返回了未声明组件：{domain_id}/{card_id or 'missing'}", frappe.PermissionError)
        if card_id in seen:
            frappe.throw(f"工作台提供器返回重复组件：{domain_id}/{card_id}", frappe.DuplicateEntryError)
        seen.add(card_id)
        definition = definitions[card_id]
        for field in ("title", "kind", "route", "dataset"):
            if field in raw and (raw.get(field) or "") != (definition.get(field) or ""):
                frappe.throw(f"工作台提供器不能改写声明字段：{domain_id}/{card_id}/{field}", frappe.PermissionError)
        if raw.get("domain_id") not in (None, "", domain_id):
            frappe.throw(f"工作台提供器不能伪装其他领域：{domain_id}/{card_id}", frappe.PermissionError)
        value = raw.get("value")
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            frappe.throw(f"工作台 metric 必须返回字符串或数字 value：{domain_id}/{card_id}", frappe.ValidationError)
        card = copy.deepcopy(definition)
        for field in ("value", "unit", "description"):
            if field in raw:
                card[field] = raw[field]
        if any(len(str(card.get(field) or "")) > limit for field, limit in (("unit", 16), ("description", 200))):
            frappe.throw(f"工作台组件文本超过协议限制：{domain_id}/{card_id}", frappe.ValidationError)
        card["domain_id"] = domain_id
        card["domain_name"] = contribution.get("name") or "业务应用"
        result.append(card)
    return result


def _validate_contributions(contributions):
    # **动作声明的保存方式（`review_save_policy`）注册期就认** ——
    # 值不合法 ⇒ 当场拒并点名（是哪个动作／写的什么值／合法值是哪两个）。
    # 运行时那道闸是 fail-closed（写错 ⇒ 按最严那档），但**静默**降级没人看得见
    # ⇒ 注册期这道不许省（域当场改对，别等运行时才发现）。
    # ⚠️ 这个键是**内核与域之间**的私有约定（PRIVATE_KEYS 里的一个）⇒ **不进公开贡献**。
    from shangshu_core.proposal_review import validate_review_save_policy_declarations
    owners = {}
    by_domain = {}
    for contribution in contributions:
        domain_id = str(contribution.get("id") or "").strip()
        if not DOMAIN_ID_RE.fullmatch(domain_id):
            frappe.throw(f"领域贡献 ID 不合法：{domain_id}", frappe.ValidationError)
        version = str(contribution.get("version") or "")
        if not VERSION_RE.fullmatch(version):
            frappe.throw(f"领域版本必须使用 SemVer：{domain_id}@{version or 'missing'}", frappe.ValidationError)
        platform_api = str(contribution.get("platform_api") or "")
        if not PLATFORM_V1_RANGE_RE.fullmatch(platform_api):
            frappe.throw(f"领域未声明兼容的 platform_api 1.x：{domain_id}", frappe.ValidationError)
        refresh = str(contribution.get("refresh") or "").strip()
        if refresh and not re.fullmatch(r"[A-Za-z_][\w.]*\.[A-Za-z_]\w*", refresh):
            frappe.throw(f"领域的 refresh 入口必须是「模块路径.函数名」：{domain_id}/{refresh}", frappe.ValidationError)
        if domain_id in by_domain:
            frappe.throw(f"领域 ID 被多个贡献重复声明：{domain_id}", frappe.DuplicateEntryError)
        by_domain[domain_id] = contribution
        _validate_workbench_declarations(domain_id, contribution)
        for section in RESOURCE_SECTIONS:
            local = set()
            for raw in contribution.get(section) or []:
                resource_id = _resource_id(section, raw)
                if not resource_id:
                    frappe.throw(f"领域资源缺少 ID：{domain_id}/{section}", frappe.ValidationError)
                if resource_id in local:
                    frappe.throw(f"领域内资源重复：{domain_id}/{section}/{resource_id}", frappe.DuplicateEntryError)
                local.add(resource_id)
                key = (section, resource_id)
                if key in owners and owners[key] != domain_id:
                    frappe.throw(
                        f"资源已由其他领域拥有，禁止覆盖：{section}/{resource_id}（{owners[key]} 与 {domain_id}）",
                        frappe.DuplicateEntryError,
                    )
                owners[key] = domain_id
    declared_actions = {resource_id: owner for (section, resource_id), owner in owners.items() if section == "actions"}
    declared_events = {resource_id: owner for (section, resource_id), owner in owners.items() if section == "events"}
    for domain_id, contribution in by_domain.items():
        # 动作声明的保存方式：注册期就认（不认 ⇒ 当场拒并点名）。
        validate_review_save_policy_declarations(domain_id, contribution.get("actions") or [])
        from shangshu_core.action_packages import validate_declaration
        for action in contribution.get("actions") or []:
            validate_declaration(action)
            for child in action.get("package_actions") or []:
                if child not in declared_actions:
                    frappe.throw("原子包子动作未注册：" + child, frappe.ValidationError)
        for item in contribution.get("objects") or []:
            object_id = _resource_id("objects", item)
            if "." not in object_id:
                frappe.throw(f"对象必须使用命名空间 ID：{domain_id}/{object_id}", frappe.ValidationError)
            if not VERSION_RE.fullmatch(str(item.get("version") or "")):
                frappe.throw(f"对象版本必须使用 SemVer：{domain_id}/{object_id}", frappe.ValidationError)
            if not isinstance(item.get("schema_version"), int) or item["schema_version"] < 1:
                frappe.throw(f"对象必须声明正整数 schema_version：{domain_id}/{object_id}", frappe.ValidationError)
            field_ids = [str(field.get("id") or "") for field in item.get("fields") or []]
            if any(not field_id for field_id in field_ids) or len(field_ids) != len(set(field_ids)):
                frappe.throw(f"对象字段 ID 缺失或重复：{domain_id}/{object_id}", frappe.ValidationError)
        for item in contribution.get("tools") or []:
            action_id = _resource_id("tools", item)
            if action_id not in declared_actions:
                frappe.throw(f"AI Tool 必须投影已注册 Action：{domain_id}/{action_id}", frappe.ValidationError)
            if declared_actions[action_id] != domain_id:
                frappe.throw(f"领域不能把其他领域 Action 重新暴露为 Tool：{domain_id}/{action_id}", frappe.PermissionError)
        for event in contribution.get("events") or []:
            version = str(event.get("version") or "")
            if not VERSION_RE.fullmatch(version):
                frappe.throw(f"事件版本必须使用 SemVer：{domain_id}/{event.get('id')}@{version or 'missing'}", frappe.ValidationError)
            if not isinstance(event.get("payload_schema"), dict):
                frappe.throw(f"事件必须声明 payload_schema：{domain_id}/{event.get('id')}", frappe.ValidationError)
            if event.get('delivery') not in (None, 'at_least_once', 'after_commit'):
                frappe.throw('事件投递模式不受支持', frappe.ValidationError)
        for subscription in contribution.get("subscriptions") or []:
            event_id = str(subscription.get("event_id") or "")
            if event_id not in declared_events:
                frappe.throw(f"订阅引用了未注册事件：{domain_id}/{event_id}", frappe.ValidationError)
            if not subscription.get("handler"):
                frappe.throw(f"订阅缺少公共 handler：{domain_id}/{subscription.get('id')}", frappe.ValidationError)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def refresh_domain_contributions():
    """migrate 时**代各域刷新**（域的动作登记／域贡献／域对象）。

    为什么要有这个口（2026-10-22 两次实踩）：域的 `setup()` 以前只在**装域**时跑
    ⇒ 改了域的动作或工具清单后，`bench migrate` **不会**刷新 ⇒ 现场出现
    「动作未注册或已停用」「域的工具清单没更新」⇒ 逼着人手工去跑
    `ensure_foundation` / `install.setup`（**规矩不该靠人记得**）。

    ⇒ 规矩收进内核：域在贡献里声明 `refresh`（自己的刷新入口，如
      `"refresh": "example_extension.install.refresh"`），**migrate 时内核逐个调用**。
    ⇒ 域不必自己记得；内核也不必知道域的实现细节（只认那个入口）。
    """
    # 域贡献要变了 ⇒ 本次请求里**别再拿旧域声明**。
    request_cache.clear("domains")
    refreshed = []
    for contribution in _providers():
        domain_id = str(contribution.get("id") or "").strip()
        path = str(contribution.get("refresh") or "").strip()
        if not path:
            continue
        module_name, _, attribute = path.rpartition(".")
        try:
            module = importlib.import_module(module_name)
            entry = getattr(module, attribute, None)
        except Exception as error:  # noqa: BLE001 —— 刷新失败要看得见，不能静默
            frappe.throw(f"领域 {domain_id} 的刷新入口加载失败：{path}（{error}）", frappe.ValidationError)
        if not callable(entry):
            frappe.throw(f"领域 {domain_id} 的刷新入口不可调用：{path}", frappe.ValidationError)
        entry()
        refreshed.append(domain_id)
    return refreshed


def ensure_registered_domains():
    # 注册表要变了 ⇒ 本次请求里**别再拿旧域声明**（2026-10-27 夜 · PKG-132 性能线）。
    request_cache.clear("domains")
    if not frappe.db.exists("DocType", DOMAIN_DOCTYPE):
        return []
    contributions = _providers()
    _validate_contributions(contributions)
    rows = []
    for contribution in contributions:
        domain_id = str(contribution.get("id") or "").strip()
        payload = _canonical(contribution)
        if frappe.db.exists(DOMAIN_DOCTYPE, domain_id):
            doc = frappe.get_doc(DOMAIN_DOCTYPE, domain_id)
            # 2026-10-25（用户拍板）：**新建业务表走「晋升」那条路**，不建自己的 DocType。
            # ⇒ 域的声明里**新出现**一个带 `doctype` 的对象 ⇒ 当场点名拒。
            # **存量不拦**（逐域重走晋升期间不许挡住迁移）；**首次登记不拦**（那不是新增）。
            from shangshu_core.data_ownership import (native_table_violation_note,
                                                       new_native_table_violations)
            violations = new_native_table_violations(
                json.loads(doc.get("contribution_json") or "{}"), contribution)
            if violations:
                frappe.throw(native_table_violation_note(
                    contribution.get("name") or domain_id, violations), frappe.ValidationError)
            # 迁移只刷新声明与健康，不覆盖管理员启停状态。
            declared = {
                "display_name": contribution.get("name") or domain_id,
                "owner_app": contribution.get("owner_app") or "unknown",
                "domain_version": contribution.get("version") or "0",
                "health_status": contribution.get("health", {}).get("status") or "healthy",
                "health_message": contribution.get("health", {}).get("message") or "",
                "contribution_json": payload,
            }
            changed = False
            if domain_id == CORE_DOMAIN_ID and (not doc.enabled or doc.execution_stopped):
                doc.enabled = 1
                doc.execution_stopped = 0
                doc.disabled_at = None
                doc.disabled_by = None
                doc.disabled_reason = None
                changed = True
            for field, value in declared.items():
                if (doc.get(field) or "") != (value or ""):
                    doc.set(field, value)
                    changed = True
            # GET/list 路径允许补注册，但不得每次读取都制造 modified 写入。
            if changed:
                doc.save(ignore_permissions=True)
        else:
            doc = frappe.get_doc({
                "doctype": DOMAIN_DOCTYPE,
                "domain_id": domain_id,
                "display_name": contribution.get("name") or domain_id,
                "owner_app": contribution.get("owner_app") or "unknown",
                "domain_version": contribution.get("version") or "0",
                "enabled": 1 if contribution.get("default_enabled", True) else 0,
                "health_status": contribution.get("health", {}).get("status") or "healthy",
                "health_message": contribution.get("health", {}).get("message") or "",
                "contribution_json": payload,
            }).insert(ignore_permissions=True)
        rows.append(doc)
    return rows


def _doc(domain_id):
    """域文档 —— **同一请求内复用**（2026-10-27 夜 · PKG-132 性能线）。

    以前这里是「先 exists 再 get_doc」两条查询，**每个动作都要走一遍**；
    批量写 500 行 ⇒ 1000 条查询只为读同一份「这个域停了没有」。
    ⇒ 改成**同一请求内读一次**（`request_cache`）。

    ⚠️ **注册表被改过以后必须清缓存**：`ensure_registered_domains` /
    `refresh_domain_contributions` 都会 `request_cache.clear("domains")`。
    """
    def _load():
        if not frappe.db.exists(DOMAIN_DOCTYPE, domain_id):
            frappe.throw("领域未注册", frappe.DoesNotExistError)
        return frappe.get_doc(DOMAIN_DOCTYPE, domain_id)

    return request_cache.get(("domains:doc", domain_id), _load)


def is_domain_enabled(domain_id):
    return bool(_doc(domain_id).enabled)


def assert_domain_enabled(domain_id, for_update=False):
    doc = frappe.get_doc(DOMAIN_DOCTYPE, domain_id, for_update=True) if for_update else _doc(domain_id)
    if not doc.enabled:
        frappe.throw(f"{doc.display_name}已停用，当前不能新建或发起业务", frappe.PermissionError)
    if doc.health_status == "unavailable":
        frappe.throw(f"{doc.display_name}当前不可用", frappe.ValidationError)
    return doc


def _public(contribution):
    value = copy.deepcopy(contribution)
    value.pop("default_enabled", None)
    for section in RESOURCE_SECTIONS:
        for item in value.get(section) or []:
            if not isinstance(item, dict):
                continue
            for key in PRIVATE_KEYS:
                item.pop(key, None)
    value.pop("workbench_provider", None)
    return value


def _domain_snapshot(row):
    return {
        "id": row.domain_id,
        "name": row.display_name,
        "owner_app": row.owner_app,
        "version": row.domain_version,
        "enabled": bool(row.enabled),
        "execution_stopped": bool(row.execution_stopped),
        "health": {"status": row.health_status, "message": row.health_message or ""},
        "disabled_at": row.disabled_at,
        "disabled_by": row.disabled_by,
        "disabled_reason": row.disabled_reason or "",
        "contribution": _public(json.loads(row.contribution_json or "{}")),
    }


def list_domains(include_disabled=False, for_update=False, *, domain_ids=None):
    if domain_ids is not None:
        domain_ids = sorted(set(domain_ids))
        if not domain_ids:
            return []
    filters = {"domain_id": ["in", domain_ids]} if domain_ids is not None else {}
    rows = frappe.get_all(
        DOMAIN_DOCTYPE,
        filters=filters,
        fields=["domain_id", "display_name", "owner_app", "domain_version", "enabled", "execution_stopped", "health_status", "health_message", "disabled_at", "disabled_by", "disabled_reason", "contribution_json"],
        order_by="display_name asc",
    )
    if for_update:
        table = frappe.qb.DocType(DOMAIN_DOCTYPE)
        query = frappe.qb.from_(table).select(table.star).orderby(table.display_name)
        if domain_ids is not None:
            query = query.where(table.domain_id.isin(domain_ids))
        rows = query.for_update().run(as_dict=True)
    result = []
    for row in rows:
        if not include_disabled and not row.enabled:
            continue
        result.append(_domain_snapshot(row))
    return result


def set_domain_enabled(domain_id, enabled, reason, stop_mode='drain'):
    _require_manager()
    if stop_mode not in ('drain', 'complete'):
        frappe.throw('未知停用方式', frappe.ValidationError)
    from shangshu_core.design_support import lock_lifecycle
    lock_lifecycle()
    reason = str(reason or "").strip()
    if not reason:
        frappe.throw("请填写启停原因", frappe.ValidationError)
    doc = frappe.get_doc(DOMAIN_DOCTYPE, _doc(domain_id).name, for_update=True)
    target = bool(int(enabled)) if isinstance(enabled, str) else bool(enabled)
    if doc.domain_id == CORE_DOMAIN_ID and not target:
        frappe.throw("平台核心是系统必需组件，禁止停用", frappe.PermissionError)
    previous = bool(doc.enabled)
    stopped = not target and (stop_mode == 'complete' or bool(doc.execution_stopped))
    if previous == target and bool(doc.execution_stopped) == stopped:
        return {"domain_id": doc.domain_id, "enabled": previous, "execution_stopped": stopped, "changed": False}
    if not target:
        from shangshu_core.lifecycle import domain_lifecycle
        blockers = domain_lifecycle(doc.domain_id)['stop_blockers' if stopped else 'disable_blockers']
        if blockers:
            frappe.throw("请先处理停用阻断：" + "、".join(blockers), frappe.ValidationError)
    else:
        from shangshu_core.manifest import check_registered_manifests
        from shangshu_core.lifecycle import domain_lifecycle
        check_registered_manifests()
        missing = [item['id'] for item in domain_lifecycle(doc.domain_id)['requirements'] if not item.get('optional') and not item['enabled']]
        if missing:
            frappe.throw('请先启用依赖领域：' + '、'.join(missing), frappe.ValidationError)
    doc.enabled = 1 if target else 0
    doc.execution_stopped = int(stopped)
    if target:
        doc.disabled_at = None
        doc.disabled_by = None
        doc.disabled_reason = None
    else:
        doc.disabled_at = now_datetime()
        doc.disabled_by = frappe.session.user
        doc.disabled_reason = reason
    doc.save(ignore_permissions=True)
    # **统一日志库**（PKG-020-T01）：域变更审计只写统一表这一处；
    # 旧表 `Shangshu Domain Change Audit` 保留表结构与历史行，不再新增。
    _snapshot = {**json.loads(doc.contribution_json or '{}'), 'execution_stopped': stopped}
    _legacy_row = {
        "domain_id": doc.domain_id,
        "action": "Enable" if target else "Disable",
        "previous_enabled": 1 if previous else 0,
        "new_enabled": 1 if target else 0,
        "actor_user": frappe.session.user,
        "reason": reason,
        "snapshot_json": _canonical(_snapshot),
    }
    unified_log.write_log(
        kind="domain_change", what_id=_legacy_row["action"], domain_id=doc.domain_id,
        actor_user=frappe.session.user, actor_identity=unified_log.current_actor_identity(),
        trigger_source="user", result="Succeeded",
        detail={
            "action": _legacy_row["action"],
            "previous_enabled": _legacy_row["previous_enabled"],
            "new_enabled": _legacy_row["new_enabled"],
            "reason": reason,
            "execution_stopped": stopped,
            "snapshot": _snapshot,
            # 旧形状快照：旧读口按它投影回去 ⇒ 既有返回形状不变。
            "legacy": _legacy_row,
        })
    return {"domain_id": doc.domain_id, "enabled": target, "execution_stopped": stopped, "changed": True}


def contribution_for_resource(section, resource_id, include_disabled=False):
    for row in list_domains(include_disabled=True):
        items = row["contribution"].get(section) or []
        if any(_resource_id(section, item) == resource_id for item in items):
            if not row["enabled"] and not include_disabled:
                return None
            return row
    return None


def raw_resource(section, resource_id):
    """解析领域私有资源实现，仅供 core 调度器使用，不对浏览器公开实现路径。

    ⚠️ **域声明清单一次请求只全扫一遍**（2026-10-27 夜 · PKG-132 性能线）：
    这里的清单是**整张域表连 `contribution_json` 一起读**，而它**每个动作都要用一次**
    ⇒ 批量写 500 行就是 500 次全扫（实测每行 2 次、共占掉约 6% 的写路径时间，
    在动作数多的链路上更明显）。
    ⇒ 改成**同一请求内复用**（`request_cache`），**不缓存任何业务数据**。
    """
    for row in _domain_rows():
        contribution = json.loads(row.contribution_json or "{}")
        for raw in contribution.get(section) or []:
            item = raw if isinstance(raw, dict) else {"id": raw}
            if _resource_id(section, item) != str(resource_id):
                continue
            return (
                {
                    "id": row.domain_id,
                    "name": row.display_name,
                    "enabled": bool(row.enabled),
                    "contribution": _public(contribution),
                },
                copy.deepcopy(item),
            )
    return None, None


def _domain_rows():
    """域声明清单（连 contribution_json）—— **一次请求只全扫一遍**。"""
    return request_cache.get(
        "domains:rows",
        lambda: frappe.get_all(
            DOMAIN_DOCTYPE,
            fields=["domain_id", "display_name", "enabled", "contribution_json"],
        ),
    )


def assert_resource_enabled(section, resource_id):
    row = contribution_for_resource(section, resource_id, include_disabled=True)
    if row and not row["enabled"]:
        assert_domain_enabled(row["id"])
    return row


def platform_contributions(include_work=False):
    domains = list_domains(include_disabled=False)
    result = {"domains": []} | {section: [] for section in RESOURCE_SECTIONS}
    for row in domains:
        contribution = row["contribution"]
        doctypes = _dataset_doctypes(row["id"])
        result["domains"].append({key: row[key] for key in ("id", "name", "version", "enabled", "health")})
        for section in RESOURCE_SECTIONS:
            for item in contribution.get(section) or []:
                value = copy.deepcopy(item) if isinstance(item, dict) else {"id": item}
                if section == "datasets" and not _readable_dataset(value, doctypes):
                    continue
                value.setdefault("domain_id", row["id"])
                result[section].append(value)
    if include_work:
        apps = application_catalog(include_resources=False)
        roles = frappe.get_roles()
        result['work_items'], result['work_errors'] = [], []
        for service in result['services']:
            if service.get('purpose') != 'work_items' or service.get('effect') != 'read' or not _visible_to_roles(service, roles):
                continue
            try:
                items = invoke_domain_service(service['id'], {})['items']
                from shangshu_core.schema_validation import _validate_schema
                _validate_schema(items, {'type':'array','maxItems':100,'items':{'type':'object','required':['dataset','name','title','step'],
                    'properties':{key:{'type':'string','maxLength':500} for key in ('dataset','name','title','step')},'additionalProperties':False}}, 'work_items')
                owned = {item['id'] for item in result['datasets'] if item['domain_id'] == service['domain_id']}
                for item in items:
                    if item.get('dataset') not in owned:
                        frappe.throw('待办数据集归属不匹配', frappe.ValidationError)
                    app = next((app for app in apps if any(data['id'] == item['dataset'] for data in app.get('datasets', []))), None)
                    if app:
                        result['work_items'].append({key: item[key] for key in ('dataset','name','title','step')} | {'application':app['id'],'domain_id':service['domain_id']})
            except Exception as error:
                result['work_errors'].append({'domain_id':service['domain_id'],'message':str(error)})
    return result


def _visible_to_roles(item, roles):
    from shangshu_core import business_access
    business_access.require_identity()
    if business_access.resource_is_open(item.get("id")):
        return True
    required = set(item.get("roles") or [])
    return not required or "System Manager" in roles or bool(required & set(roles))


def _dataset_doctypes(domain_id):
    # list_domains() intentionally redacts private DocType names; use the server-side
    # registered contribution, not a second role policy in the public manifest.
    raw = json.loads(_doc(domain_id).contribution_json or "{}")
    return {obj["id"]: obj["doctype"] for obj in raw.get("objects") or []
            if isinstance(obj, dict) and obj.get("id") and obj.get("doctype")}


def _readable_dataset(item, doctypes):
    """A published data entrance cannot grant read access to its underlying DocType."""
    if not _visible_to_roles(item, frappe.get_roles()):
        return False
    doctype = doctypes.get(item.get("object_id") or item.get("id"))
    from shangshu_core import business_access
    if business_access.resource_is_open(item.get("id")):
        return True  # 仅开放声明入口；实际记录、企业范围仍由目标读口判定。
    return not doctype or frappe.has_permission(doctype, ptype="read")


def _application_resources(contribution, application):
    resources = {}
    for section in ("objects", "datasets", "processes", "actions", "tools", "services", "events", "subscriptions", "roles", "pages"):
        declared = contribution.get(section) or []
        selected_ids = application.get(f"{section}_ids")
        if selected_ids is None:
            selected = declared
        else:
            wanted = set(selected_ids)
            selected = [item for item in declared if _resource_id(section, item) in wanted]
        resources[section] = copy.deepcopy(selected)
    return resources



def _application_summary(application):
    """导航只需入口元数据；字段、流程和资源计数留给精确详情读取。"""
    keys = ("id", "title", "description", "icon", "home", "source", "enabled",
            "domain_id", "domain_name", "domain_version", "health", "published_revision")
    return {key: copy.deepcopy(application[key]) for key in keys if key in application}


def _build_domain_application(row, application, roles, include_resources, doctypes, summary=False):
    """装配**一个**域贡献的应用（目录与「按 ID 取」**共用这一份**，不两写）。"""
    if summary:
        compact = _application_summary(dict(application, domain_id=row["id"],
            domain_name=row["name"], domain_version=row["version"],
            enabled=row["enabled"], health=row["health"]))
        # 卡片原来以获权数据表名称补空说明；只保留这些名称，不展开字段/流程。
        if not str(compact.get("description") or "").strip():
            selected = application.get("datasets_ids")
            datasets = [item for item in row["contribution"].get("datasets", [])
                        if selected is None or item.get("id") in selected]
            if datasets:
                types = _dataset_doctypes(row["id"])
                compact["description"] = "、".join(str(item.get("name") or "").strip()
                    for item in datasets if str(item.get("name") or "").strip()
                    and _readable_dataset(item, types))
        return compact
    contribution = row["contribution"]
    resources = _application_resources(contribution, application)
    if not include_resources:
        resources["datasets"] = [item for item in resources["datasets"]
                                 if _readable_dataset(item, doctypes)]
    app = copy.deepcopy(application)
    app.update({
        "domain_id": row["id"],
        "domain_name": row["name"],
        "domain_version": row["version"],
        "enabled": row["enabled"],
        "health": row["health"],
        "datasets": resources["datasets"],
        "processes": resources["processes"],
        "resource_counts": {key: len(value) for key, value in resources.items()},
    })
    app["setup_steps"] = [
        {"id": "data", "label": "数据", "complete": bool(resources["datasets"])},
        {"id": "page", "label": "页面", "complete": bool(app.get("home"))},
        {"id": "process", "label": "流程", "complete": bool(resources["processes"])},
        {"id": "permission", "label": "权限", "complete": bool(resources["roles"])},
        {"id": "publish", "label": "发布", "complete": bool(row["enabled"])},
    ]
    if include_resources:
        app["resources"] = resources
    return app


def _domain_application_by_id(application_id, include_disabled=False, include_resources=False):
    """按已注册应用 ID 精确取贡献，不解析其他域、不猜 ID 的命名空间。"""
    raw_rows = frappe.db.sql("""
        SELECT domain_id, display_name, owner_app, domain_version, enabled,
               execution_stopped, health_status, health_message,
               disabled_at, disabled_by, disabled_reason, contribution_json
          FROM `tabShangshu Domain`
         WHERE JSON_CONTAINS(JSON_EXTRACT(
                   IF(JSON_VALID(contribution_json), contribution_json, '{}'),
                   '$.applications[*].id'), %(application_id_json)s)
            OR (CONCAT(domain_id, '.default') = %(application_id)s AND
                COALESCE(JSON_TYPE(JSON_EXTRACT(
                   IF(JSON_VALID(contribution_json), contribution_json, '{}'),
                   '$.applications')), 'NULL') = 'NULL')
         LIMIT 2
    """, {"application_id": application_id,
           "application_id_json": json.dumps(application_id)}, as_dict=True)
    if len(raw_rows) > 1:
        frappe.throw("应用 ID 被多个领域重复声明", frappe.DuplicateEntryError)
    roles = set(frappe.get_roles())
    for raw_row in raw_rows:
        if not include_disabled and not raw_row.enabled:
            return None
        row = _domain_snapshot(raw_row)
        contribution = row["contribution"]
        applications = contribution.get("applications") if contribution.get("applications") is not None else [{
            "id": f'{row["id"]}.default',
            "title": row["name"],
            "description": contribution.get("health", {}).get("message") or "已安装业务应用",
            "icon": row["name"][:1],
        }]
        for application in applications:
            if application.get("id") != application_id:
                continue
            if not include_disabled and not _visible_to_roles(application, roles):
                continue
            doctypes = _dataset_doctypes(row["id"]) if not include_resources else {}
            return _build_domain_application(row, application, roles, include_resources, doctypes)
    return None


def application_catalog(include_disabled=False, include_resources=False, design=False, summary=False):
    """把已安装领域投影成用户能理解的应用目录。

    保留领域贡献应用，并聚合已发布的受管应用；草稿不进入员工目录。
    """
    if design:
        _require_manager()
        include_disabled = include_resources = True
    summary = bool(summary and not include_resources and not design)
    roles = set(frappe.get_roles())
    result = []
    for row in list_domains(include_disabled=include_disabled):
        contribution = row["contribution"]
        doctypes = _dataset_doctypes(row["id"]) if not include_resources and not summary else {}
        applications = contribution.get("applications") if contribution.get("applications") is not None else [{
            "id": f'{row["id"]}.default',
            "title": row["name"],
            "description": contribution.get("health", {}).get("message") or "已安装业务应用",
            "icon": row["name"][:1],
        }]
        for application in applications:
            if not include_disabled and not _visible_to_roles(application, roles):
                continue
            result.append(_build_domain_application(row, application, roles,
                                                   include_resources, doctypes, summary=summary))
    if design:
        from shangshu_core.applications import design_application_catalog
        return design_application_catalog(result)
    from shangshu_core.applications import published_application_catalog
    result.extend(published_application_catalog(include_resources=include_resources, summary=summary))
    return result


def get_application(application_id, include_disabled=False, include_resources=False):
    """按 ID 取**一个**应用 —— **不重建整份目录**（2026-10-28 · PKG-132 · R13）。

    两条来源各自**按 ID 定位**：
    · 域贡献的应用 ⇒ 注册声明按 ID 精确匹配，**只装配那一个**；
    · 已发布的受管应用 ⇒ 已发布目录**按 ID 过滤**（不再装配全部再挑一个）。
    取不到就明确拒（不给空壳）。
    """
    if not isinstance(application_id, str) or not application_id.strip():
        frappe.throw("应用 ID 不能为空", frappe.ValidationError)
    application = _domain_application_by_id(application_id, include_disabled, include_resources)
    if application is None:
        from shangshu_core.applications import published_application_catalog
        for candidate in published_application_catalog(include_resources=include_resources,
                                                      application_id=application_id):
            if candidate.get("id") == application_id:
                application = candidate
                break
    if application is None:
        frappe.throw("应用不存在或当前用户无权访问", frappe.DoesNotExistError)
    if application.get("overview_enabled"):
        from shangshu_core.application_pages import overview_data
        application["overview"] = overview_data(application)
    return application


def role_capabilities(roles):
    capabilities = {}
    role_set = set(roles or [])
    for row in list_domains(include_disabled=False):
        for item in row["contribution"].get("roles") or []:
            if item.get("role") in role_set:
                for capability in item.get("capabilities") or []:
                    capabilities[capability] = True
    return capabilities


def workbench_data():
    cards = []
    from shangshu_core.domain_execution import domain_execution
    contributions = [json.loads(row.contribution_json or '{}') for row in frappe.get_all(
        DOMAIN_DOCTYPE, filters={'enabled': 1}, fields=['contribution_json'])]
    roles = frappe.get_roles()
    for contribution in contributions:
        if not is_domain_enabled(contribution["id"]):
            continue
        provider = contribution.get("workbench_provider")
        if provider:
            declared = {
                _resource_id("workbench", item): item
                for item in contribution.get("workbench") or []
                if _visible_to_roles(item, roles)
            }
            with domain_execution(contribution['id']):
                provided = frappe.get_attr(provider)() or []
            for card in _normalize_workbench_cards(contribution, provided):
                if card["id"] in declared:
                    cards.append(card)
    return cards


@resource_execution('datasets', 'dataset_id')
def query_dataset(dataset_id, filters=None, page=1, page_length=30):
    from shangshu_core import model_records
    if model_records.is_managed(dataset_id):
        return model_records.query_records(dataset_id,filters,page,page_length)
    row = contribution_for_resource("datasets", dataset_id, include_disabled=True)
    if not row:
        frappe.throw("数据集不存在", frappe.DoesNotExistError)
    assert_domain_enabled(row["id"])
    raw = json.loads(_doc(row["id"]).contribution_json or "{}")
    dataset = next((item for item in raw.get("datasets") or [] if item.get("id") == dataset_id), None)
    if not dataset or not dataset.get("query"):
        frappe.throw("数据集没有查询实现", frappe.ValidationError)
    result = frappe.get_attr(dataset["query"])(dataset_id, filters or {}, int(page), min(int(page_length), 100))
    # 集合入口复用同一 Action 权限/表单，不为新建业务绕行空流程或增加 API。
    from shangshu_core.actions import list_registered_actions
    declared = set(dataset.get("collection_actions") or [])
    actions = [action for action in list_registered_actions() if action["id"] in declared
               and action["domain_id"] == row["id"] and action["executable"]] if declared else []
    result = {**result, "actions": actions}
    # 已声明原生表格的数据集沿用同一集合入口，把对象能力投影给公共表格工作面。
    object_id = dataset.get("object_id")
    if object_id:
        from shangshu_core import native_objects
        try:
            if native_objects.declared(object_id):
                result["object"] = native_objects.definition(object_id)
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            pass
    return result


@resource_execution('services', 'service_id')
def invoke_domain_service(service_id, payload=None):
    domain, service = raw_resource("services", service_id)
    if not domain or not service:
        frappe.throw("领域服务不存在", frappe.DoesNotExistError)
    from shangshu_core.lifecycle import assert_declared_call
    assert_declared_call(domain['id'])
    assert_domain_enabled(domain["id"])
    from shangshu_core import business_access
    business_access.require_identity()
    roles = set(frappe.get_roles())
    required_roles = set(service.get("roles") or [])
    if not business_access.resource_is_open(service_id) and required_roles and "System Manager" not in roles and not required_roles.intersection(roles):
        frappe.throw("当前用户无权调用该领域服务", frappe.PermissionError)
    required_capability = service.get("capability")
    if not business_access.resource_is_open(service_id) and required_capability and "System Manager" not in roles and not role_capabilities(roles).get(required_capability):
        frappe.throw("当前用户缺少领域服务所需能力", frappe.PermissionError)
    handler = service.get("handler")
    if not handler:
        frappe.throw("领域服务没有执行实现", frappe.ValidationError)
    from shangshu_core.identity import get_identity

    identity = get_identity()
    context = {
        "identity_id": identity.identity_id,
        "enterprise_id": identity.enterprise_id,
        "user_name": frappe.session.user,
        "roles": list(roles),
        "domain_id": domain["id"],
    }
    from shangshu_core.schema_validation import _validate_schema

    values = {} if payload is None else payload
    # 旧服务未声明 schema 时保持兼容；声明后与 Action/表单共用校验。
    _validate_schema(values, service.get("input_schema"), "service.input")
    point = "service_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    previous_domain = getattr(frappe.flags, 'shangshu_call_domain', None)
    try:
        frappe.flags.shangshu_call_domain = domain['id']
        result = frappe.get_attr(handler)(service_id, values, context)
        _validate_schema(result, service.get("output_schema"), "service.output")
        return result
    except Exception:
        frappe.db.rollback(save_point=point)
        raise
    finally:
        frappe.flags.shangshu_call_domain = previous_domain
