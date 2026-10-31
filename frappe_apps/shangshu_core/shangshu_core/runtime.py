import hashlib
import hmac
import json
import re
import secrets
from collections import defaultdict, deque

import frappe
from shangshu_core.domain_execution import resource_execution, instance_execution
from frappe.utils import add_to_date, now_datetime

from shangshu_core.domains import assert_resource_enabled, contribution_for_resource
from shangshu_core.identity import get_identity
from shangshu_core import unified_log


NODE_TYPES = {"human_task", "action", "ai_select", "condition", "wait_event", "subflow"}
SAFE_RETRY_EFFECTS = {"read", "external/read", "extract"}
FINAL_INSTANCE_STATES = {"Completed", "Cancelled"}
CONDITION_OPERATORS = {"eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_empty", "is_not_empty"}


def _json(value, default=None):
    if value in (None, ""):
        return default if default is not None else {}
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        frappe.throw("流程 JSON 格式不正确", frappe.ValidationError)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _require_system_manager():
    if "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)


def get_design_context(definition_id):
    _require_system_manager()
    name = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not name:
        frappe.throw("流程定义不存在", frappe.DoesNotExistError)
    definition = frappe.get_doc("Shangshu Process Definition", name)
    latest = frappe.get_doc("Shangshu Process Definition Version", definition.last_published_version).as_dict() if definition.last_published_version else None
    actions = frappe.get_all(
        "Shangshu Action Definition",
        filters={"enabled": 1},
        fields=[
            "registry_key", "action_id", "action_version", "title", "effect",
            "confirmation_policy", "allowed_roles_json", "input_schema_json", "output_schema_json",
            "timeout_seconds", "retry_policy",
        ],
        order_by="action_id asc, creation desc",
    )
    latest_actions = []
    seen_actions = set()
    for action in actions:
        if action.action_id in seen_actions:
            continue
        seen_actions.add(action.action_id)
        latest_actions.append(action)
    actions = latest_actions
    definition_domain = contribution_for_resource("processes", definition_id, include_disabled=True)
    actions = [
        action for action in actions
        if not contribution_for_resource("actions", action.action_id, include_disabled=True)
        or contribution_for_resource("actions", action.action_id)
        or (definition_domain and contribution_for_resource("actions", action.action_id, include_disabled=True)["id"] == definition_domain["id"])
    ]
    roles = frappe.get_all("Role", filters={"disabled": 0}, pluck="name", order_by="name asc")
    graph = _json(definition.graph_json)
    checks = []
    try:
        validate_graph(graph)
        checks.append({"status": "pass", "title": "流程结构", "detail": "起点、终态、路径和资源引用检查通过"})
    except Exception as error:
        checks.append({"status": "fail", "title": "流程结构", "detail": str(error)})
    checks.extend(
        [
            {"status": "pass" if definition.last_published_version else "warn", "title": "不可变发布版本", "detail": f"当前发布版本：{definition.last_published_version}" if definition.last_published_version else "尚未发布"},
            {"status": "pass", "title": "AI 写入边界", "detail": "AI 节点只能选择 read/extract 候选；写入由确认卡和领域动作执行"},
        ]
    )
    return {
        "definition": definition.as_dict() | {"graph": graph},
        "latest_version": latest,
        "actions": actions,
        "roles": roles,
        "data_sources": graph.get("data_sources") or [],
        "checks": checks,
        "node_types": sorted(NODE_TYPES),
    }


def list_process_definitions():
    """管理员设计目录：包括未发布草稿；停用领域的定义不进入日常设计入口。"""
    _require_system_manager()
    rows = frappe.get_all(
        "Shangshu Process Definition",
        fields=["definition_id", "title", "business_object", "status", "draft_revision", "last_published_version", "modified"],
        order_by="modified desc",
    )
    result = []
    for row in rows:
        domain = contribution_for_resource("processes", row.definition_id, include_disabled=True)
        if domain and not domain["enabled"]:
            continue
        row["domain_id"] = domain["id"] if domain else "com.shangshu.core"
        row["domain_name"] = domain["name"] if domain else "平台自建"
        result.append(row)
    return result


def create_process_definition(title, business_object=None):
    """创建最小可校验草稿；不自动发布、不播种业务数据。"""
    _require_system_manager()
    title = str(title or "").strip()
    if not title:
        frappe.throw("请填写流程名称", frappe.ValidationError)
    if len(title) > 80:
        frappe.throw("流程名称不能超过 80 个字符", frappe.ValidationError)
    suffix = frappe.generate_hash(length=12).lower()
    definition_id = f"com.shangshu.custom.{suffix}"
    start_id = f"{definition_id}.node.start"
    end_id = f"{definition_id}.node.complete"
    graph = {
        "schema_version": 2,
        "definition_id": definition_id,
        "business_object": str(business_object or "platform.business_record").strip(),
        "nodes": [
            {"id": start_id, "type": "human_task", "title": "提交事项", "start": True, "allowed_roles": ["Desk User"], "position": {"x": 280, "y": 120}},
            {"id": end_id, "type": "human_task", "title": "完成", "terminal": True, "allowed_roles": ["Desk User"], "position": {"x": 280, "y": 300}},
        ],
        "edges": [{"id": f"{definition_id}.edge.start-complete", "source": start_id, "target": end_id, "label": "提交"}],
        "form": {"sections": []},
        "mappings": [],
        "data_sources": [],
    }
    validate_graph(graph)
    definition = frappe.get_doc({
        "doctype": "Shangshu Process Definition",
        "definition_id": definition_id,
        "title": title,
        "namespace": "com.shangshu.custom",
        "business_object": graph["business_object"],
        "enterprise_id": "default",
        "status": "Draft",
        "draft_revision": 1,
        "graph_json": _canonical(graph),
    }).insert(ignore_permissions=True)
    return {"definition_id": definition.definition_id, "title": definition.title, "status": definition.status, "draft_revision": definition.draft_revision}


def register_domain_process_definition(definition_id, title, business_object, graph):
    """领域 App 首次安装时注册稳定命名空间流程；已存在定义永不覆盖。"""
    _require_system_manager()
    definition_id = str(definition_id or "").strip()
    owner = contribution_for_resource("processes", definition_id, include_disabled=True)
    if not owner:
        frappe.throw("流程必须先由已安装领域贡献声明", frappe.PermissionError)
    if not definition_id.startswith(owner["id"] + "."):
        frappe.throw("流程 ID 必须位于所属领域命名空间", frappe.ValidationError)
    existing = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if existing:
        doc = frappe.get_doc("Shangshu Process Definition", existing)
        return {"definition_id": doc.definition_id, "created": False, "draft_revision": doc.draft_revision, "status": doc.status}
    value = validate_graph(graph)
    if value.get("definition_id") != definition_id:
        frappe.throw("流程图 definition_id 与注册 ID 不一致", frappe.ValidationError)
    doc = frappe.get_doc({
        "doctype": "Shangshu Process Definition",
        "definition_id": definition_id,
        "title": str(title or "").strip(),
        "namespace": owner["id"],
        "business_object": str(business_object or "").strip(),
        "enterprise_id": "default",
        "status": "Draft",
        "draft_revision": 1,
        "graph_json": _canonical(value),
    }).insert(ignore_permissions=True)
    return {"definition_id": doc.definition_id, "created": True, "draft_revision": doc.draft_revision, "status": doc.status}


def save_process_draft(definition_id, graph, expected_revision):
    _require_system_manager()
    name = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not name:
        frappe.throw("流程定义不存在", frappe.DoesNotExistError)
    definition = frappe.get_doc("Shangshu Process Definition", name)
    if _json(definition.graph_json).get("application_ref"):
        frappe.throw("此流程由应用配置管理，请在所属应用保存并发布",frappe.ValidationError)
    if int(expected_revision) != int(definition.draft_revision or 0):
        frappe.throw("流程草稿已被其他人修改，请刷新后重试", frappe.TimestampMismatchError)
    value = _json(graph)
    if not isinstance(value.get("nodes"), list) or not isinstance(value.get("edges"), list):
        frappe.throw("流程草稿必须包含 nodes 与 edges", frappe.ValidationError)
    ids = [str(node.get("id") or "") for node in value["nodes"]]
    if any(not item or "." not in item for item in ids) or len(ids) != len(set(ids)):
        frappe.throw("节点必须使用带命名空间的唯一 ID", frappe.ValidationError)
    definition.graph_json = _canonical(value)
    definition.draft_revision = int(definition.draft_revision or 0) + 1
    definition.status = "Draft"
    definition.save(ignore_permissions=True)
    return {"definition_id": definition.definition_id, "draft_revision": definition.draft_revision, "status": definition.status, "modified": definition.modified}


def _action(action_id):
    name = frappe.db.get_value(
        "Shangshu Action Definition",
        {"action_id": action_id, "enabled": 1},
        "name",
        order_by="modified desc",
    )
    if not name:
        frappe.throw(f"动作未注册或已停用：{action_id}", frappe.ValidationError)
    return frappe.get_doc("Shangshu Action Definition", name)


def validate_graph(graph):
    """发布前校验统一流程图；返回规范化后的图。"""
    graph = _json(graph)
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    if not nodes:
        frappe.throw("流程至少需要一个节点", frappe.ValidationError)

    node_by_id = {}
    for node in nodes:
        node_id = str(node.get("id") or "").strip()
        node_type = str(node.get("type") or "").strip()
        if not node_id or "." not in node_id:
            frappe.throw("每个节点必须使用带命名空间的唯一 ID", frappe.ValidationError)
        if node_id in node_by_id:
            frappe.throw(f"节点 ID 重复：{node_id}", frappe.ValidationError)
        if node_type not in NODE_TYPES:
            frappe.throw(f"不支持的节点类型：{node_type}", frappe.ValidationError)
        node_by_id[node_id] = node

        if node_type == "ai_select":
            candidates = node.get("candidates") or []
            if not candidates:
                frappe.throw(f"AI 选择节点没有候选工具：{node_id}", frappe.ValidationError)
            for action_id in candidates:
                action = _action(action_id)
                if action.effect not in SAFE_RETRY_EFFECTS:
                    frappe.throw(f"AI 选择节点只能使用只读/提取工具：{action_id}", frappe.ValidationError)
        if node_type == "action":
            action_id = node.get("action_id")
            if not action_id:
                frappe.throw(f"动作节点缺少 action_id：{node_id}", frappe.ValidationError)
            action = _action(action_id)
            from shangshu_core.process_mapping import validate_mapping
            validate_mapping(graph,node,action)
            if action.effect in ("write", "high-risk", "append-only") and action.confirmation_policy != "required":
                frappe.throw(f"写动作必须由系统强制确认：{action_id}", frappe.ValidationError)
        if node.get("auto_complete") and (node_type!="human_task" or not node.get("terminal") or node.get("form_schema",{}).get("properties")):
            frappe.throw("自动完成只用于无输入的终态，不得跳过业务动作",frappe.ValidationError)
        if node_type == "subflow" and not node.get("definition_version"):
            frappe.throw(f"子流程必须固定已发布版本：{node_id}", frappe.ValidationError)

    starts = [node["id"] for node in nodes if node.get("start")]
    if len(starts) != 1:
        frappe.throw("流程必须且只能有一个起点", frappe.ValidationError)
    terminals = {node["id"] for node in nodes if node.get("terminal")}
    if not terminals:
        frappe.throw("流程至少需要一个终态", frappe.ValidationError)

    outgoing = defaultdict(list)
    edge_ids = set()
    for edge in edges:
        edge_id = str(edge.get("id") or "").strip()
        if edge_id:
            if edge_id in edge_ids:
                frappe.throw(f"连线 ID 重复：{edge_id}", frappe.ValidationError)
            edge_ids.add(edge_id)
        source = edge.get("source")
        target = edge.get("target")
        if source not in node_by_id or target not in node_by_id:
            frappe.throw("流程连线引用了不存在的节点", frappe.ValidationError)
        condition = edge.get("condition")
        if isinstance(condition, dict):
            _validate_condition(condition, edge_id or f"{source} -> {target}")
        outgoing[source].append(edge)

    for node_id, node in node_by_id.items():
        if node.get("type") != "condition":
            continue
        branches = outgoing[node_id]
        if len(branches) < 2:
            frappe.throw(f"条件节点至少需要两个出口：{node_id}", frappe.ValidationError)
        defaults = [edge for edge in branches if edge.get("is_default")]
        if len(defaults) > 1:
            frappe.throw(f"条件节点只能有一个默认分支：{node_id}", frappe.ValidationError)
        for edge in branches:
            if not edge.get("is_default") and not edge.get("condition"):
                frappe.throw(f"条件分支缺少规则：{edge.get('id') or edge.get('target')}", frappe.ValidationError)

    for node_id in node_by_id:
        if node_id not in terminals and not outgoing[node_id]:
            frappe.throw(f"进行中节点没有出口：{node_id}", frappe.ValidationError)

    reachable = {starts[0]}
    queue = deque([starts[0]])
    while queue:
        current = queue.popleft()
        for edge in outgoing[current]:
            target = edge["target"]
            if target not in reachable:
                reachable.add(target)
                queue.append(target)
    missing = sorted(set(node_by_id) - reachable)
    if missing:
        frappe.throw("存在不可达节点：" + "、".join(missing), frappe.ValidationError)
    if not terminals.intersection(reachable):
        frappe.throw("起点无法到达终态", frappe.ValidationError)

    normalized = {"nodes": nodes, "edges": edges}
    for key in ("schema_version", "definition_id", "business_object", "form", "mappings", "data_sources", "permissions", "viewport", "application_ref"):
        if graph.get(key) is not None:
            normalized[key] = graph[key]
    return normalized


def _validate_condition(rule, location):
    kind = rule.get("kind") or ("group" if "rules" in rule else "clause")
    if kind == "group":
        if rule.get("combinator") not in ("and", "or"):
            frappe.throw(f"复合条件缺少 AND/OR：{location}", frappe.ValidationError)
        rules = rule.get("rules") or []
        if not rules:
            frappe.throw(f"复合条件不能为空：{location}", frappe.ValidationError)
        for child in rules:
            if not isinstance(child, dict):
                frappe.throw(f"条件格式不正确：{location}", frappe.ValidationError)
            _validate_condition(child, location)
        return
    if kind != "clause":
        frappe.throw(f"不支持的条件类型：{kind}", frappe.ValidationError)
    source = rule.get("source") or {}
    if source.get("scope") not in ("process_input", "business_object", "node_output", "context"):
        frappe.throw(f"条件数据来源不完整：{location}", frappe.ValidationError)
    if not str(source.get("field_path") or "").strip() or not str(source.get("field_label") or "").strip():
        frappe.throw(f"条件字段来源不完整：{location}", frappe.ValidationError)
    if rule.get("operator") not in CONDITION_OPERATORS:
        frappe.throw(f"不支持的条件运算符：{rule.get('operator')}", frappe.ValidationError)


def validate_process_definition(definition_id, graph=None):
    _require_system_manager()
    name = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not name:
        frappe.throw("流程定义不存在", frappe.DoesNotExistError)
    definition = frappe.get_doc("Shangshu Process Definition", name)
    graph = validate_graph(graph if graph is not None else definition.graph_json)
    return {
        "valid": True,
        "draft_revision": definition.draft_revision,
        "summary": f"校验通过：{len(graph['nodes'])} 个节点、{len(graph['edges'])} 条连线",
        "checks": [
            {"status": "pass", "title": "流程结构", "detail": "起点、终态、可达性与节点出口正确"},
            {"status": "pass", "title": "条件来源", "detail": "结构化条件的字段来源与运算符有效"},
            {"status": "pass", "title": "动作与 AI 工具", "detail": "引用来自注册表，写入动作保留确认闸门"},
        ],
    }


def _path_value(root, path):
    value = root
    for part in str(path or "").split("."):
        if not part:
            continue
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _condition_value(rule, sample):
    kind = rule.get("kind") or ("group" if "rules" in rule else "clause")
    if kind == "group":
        values = [_condition_value(child, sample) for child in rule.get("rules") or []]
        return all(values) if rule.get("combinator") == "and" else any(values)
    source = rule.get("source") or {}
    root = sample
    object_id = source.get("object_id")
    if object_id and isinstance(sample.get(object_id), dict):
        root = sample[object_id]
    actual = _path_value(root, source.get("field_path"))
    expected = rule.get("value")
    operator = rule.get("operator")
    try:
        if operator == "eq":
            return actual == expected
        if operator == "neq":
            return actual != expected
        if operator == "gt":
            return actual is not None and actual > expected
        if operator == "gte":
            return actual is not None and actual >= expected
        if operator == "lt":
            return actual is not None and actual < expected
        if operator == "lte":
            return actual is not None and actual <= expected
        if operator == "contains":
            return actual is not None and expected in actual
        if operator == "in":
            return actual in (expected or [])
        if operator == "is_empty":
            return actual in (None, "", [], {})
        if operator == "is_not_empty":
            return actual not in (None, "", [], {})
    except TypeError:
        label = source.get("field_label") or source.get("field_path") or "条件字段"
        frappe.throw(f"模拟数据类型与“{label}”条件不匹配", frappe.ValidationError)
    return False


def _legacy_condition_value(expression, sample, decision=None):
    value = str(expression or "").strip()
    if value == "file.has_text_layer == true":
        return bool(_path_value(sample, "document_extraction.has_text_layer"))
    if value == "file.has_text_layer == false":
        return not bool(_path_value(sample, "document_extraction.has_text_layer"))
    return value == str(decision or "")


def simulate_process(definition_id, sample=None, graph=None):
    """无写入路径模拟；只读草稿图，不调用动作、AI 或财务账本。"""
    _require_system_manager()
    name = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not name:
        frappe.throw("流程定义不存在", frappe.DoesNotExistError)
    definition = frappe.get_doc("Shangshu Process Definition", name)
    graph = validate_graph(graph if graph is not None else definition.graph_json)
    sample = _json(sample, {})
    decisions = sample.get("decisions") or {}
    node_by_id = {node["id"]: node for node in graph["nodes"]}
    outgoing = defaultdict(list)
    for edge in graph["edges"]:
        outgoing[edge["source"]].append(edge)
    current = next(node["id"] for node in graph["nodes"] if node.get("start"))
    trace = []
    visited = defaultdict(int)
    for _index in range(100):
        node = node_by_id[current]
        visited[current] += 1
        if visited[current] > 8:
            frappe.throw(f"模拟检测到可能死循环：{node.get('title') or current}", frappe.ValidationError)
        step = {"node_id": current, "title": node.get("title") or current, "type": node.get("type")}
        trace.append(step)
        if node.get("terminal"):
            return {"status": "completed", "draft_revision": definition.draft_revision, "trace": trace}
        branches = outgoing[current]
        chosen = None
        if len(branches) == 1:
            chosen = branches[0]
        elif node.get("type") == "condition":
            for edge in sorted(branches, key=lambda item: int(item.get("priority") or 0)):
                condition = edge.get("condition")
                if isinstance(condition, dict) and _condition_value(condition, sample):
                    chosen = edge
                    break
                if isinstance(condition, str) and _legacy_condition_value(condition, sample):
                    chosen = edge
                    break
            if not chosen:
                chosen = next((edge for edge in branches if edge.get("is_default")), None)
        else:
            decision = decisions.get(current)
            chosen = next(
                (
                    edge for edge in branches
                    if decision in (edge.get("id"), edge.get("target"), edge.get("label"), edge.get("condition"))
                ),
                None,
            )
        if not chosen:
            return {
                "status": "waiting_input",
                "draft_revision": definition.draft_revision,
                "trace": trace,
                "node_id": current,
                "choices": [
                    {"edge_id": edge.get("id"), "label": edge.get("label") or str(edge.get("condition") or "默认"), "target": edge.get("target")}
                    for edge in branches
                ],
            }
        step["edge_id"] = chosen.get("id")
        step["edge_label"] = chosen.get("label") or str(chosen.get("condition") or "")
        current = chosen["target"]
    frappe.throw("模拟超过 100 步，请检查循环出口", frappe.ValidationError)


def register_action(action_id, version, title, effect, confirmation_policy, roles=None, input_schema=None, output_schema=None, timeout_seconds=30, retry_policy="none"):
    """资源所有权明确的动作注册；同一 registry_key 定义不一致时拒绝覆盖。"""
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", str(version or "")):
        frappe.throw(f"动作版本必须使用 SemVer：{action_id}@{version}", frappe.ValidationError)
    from shangshu_core import request_cache
    # 动作定义要变了 ⇒ 本次请求里**别再拿旧定义**（2026-10-27 夜 · PKG-132 性能线）。
    request_cache.clear("action_def")
    registry_key = f"{action_id}@{version}"
    payload = {
        "doctype": "Shangshu Action Definition",
        "registry_key": registry_key,
        "action_id": action_id,
        "action_version": version,
        "title": title,
        "effect": effect,
        "confirmation_policy": confirmation_policy,
        "allowed_roles_json": _canonical(roles or []),
        "input_schema_json": _canonical(input_schema or {}),
        "output_schema_json": _canonical(output_schema or {}),
        "timeout_seconds": timeout_seconds,
        "retry_policy": retry_policy,
        "enabled": 1,
    }
    if frappe.db.exists("Shangshu Action Definition", registry_key):
        existing = frappe.get_doc("Shangshu Action Definition", registry_key)
        comparable = {key: existing.get(key) for key in payload if key != "doctype"}
        expected = {key: value for key, value in payload.items() if key != "doctype"}
        if comparable != expected:
            # 混版报错要点名哪一侧旧（PKG-013-T05）：同版本号判不出谁旧，但
            # 「改了定义却没升版本号」是确定的 —— 报因要说清，别只留一句「禁止隐式覆盖」。
            from shangshu_core.field_access import version_conflict_note
            frappe.throw(version_conflict_note(action_id, version, version), frappe.DuplicateEntryError)
        return existing
    return frappe.get_doc(payload).insert(ignore_permissions=True)


def publish_definition(definition_id, expected_revision=None):
    _require_system_manager()
    name = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not name:
        frappe.throw("流程定义不存在", frappe.DoesNotExistError)
    definition = frappe.get_doc("Shangshu Process Definition", name)
    if expected_revision is not None and int(expected_revision) != int(definition.draft_revision or 0):
        frappe.throw("流程草稿已变化，请刷新后重新发布", frappe.TimestampMismatchError)
    graph = validate_graph(definition.graph_json)
    latest = frappe.db.get_value(
        "Shangshu Process Definition Version",
        {"definition": definition.name},
        "version_number",
        order_by="version_number desc",
    ) or 0
    number = int(latest) + 1
    version_id = f"{definition.definition_id}@{number}"
    dependencies = _dependency_snapshot(graph)
    version = frappe.get_doc(
        {
            "doctype": "Shangshu Process Definition Version",
            "version_id": version_id,
            "definition": definition.name,
            "version_number": number,
            "graph_json": _canonical(graph),
            "graph_hash": _hash(graph),
            "dependency_snapshot_json": _canonical(dependencies),
            "published_by": frappe.session.user,
            "published_at": now_datetime(),
        }
    ).insert(ignore_permissions=True)
    definition.status = "Published"
    definition.last_published_version = version.name
    definition.save(ignore_permissions=True)
    return version.as_dict()


def _dependency_snapshot(graph):
    actions = {}
    for node in graph["nodes"]:
        action_ids = []
        if node.get("action_id"):
            action_ids.append(node["action_id"])
        action_ids.extend(node.get("candidates") or [])
        for action_id in action_ids:
            action = _action(action_id)
            actions[action_id] = {
                "registry_key": action.registry_key,
                "version": action.action_version,
                "effect": action.effect,
                "confirmation_policy": action.confirmation_policy,
            }
    return {"actions": actions}


def _latest_version(definition_id):
    definition = frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "name")
    if not definition:
        return None
    return frappe.db.get_value(
        "Shangshu Process Definition Version",
        {"definition": definition},
        "name",
        order_by="version_number desc",
    )


@resource_execution('processes', 'definition_id')
def start_process(definition_id, business_doctype=None, business_name=None, enterprise_id="default", input_data=None, start_key=None, business_object_id=None):
    # 业务链接两种给法（二选一，别同时给）：
    # · 传统：business_doctype（物理表类型）＋ business_name；
    # · **受管记录**：business_object_id（受管对象 id）＋ business_name（记录名）——
    #   **物理表类型由内核代为解析**（业务域拿不到它，也不该知道它）。
    #   这条是给「晋升＝受管对象」后的业务域用的：它们只要说「这是哪条受管记录」。
    assert_resource_enabled("processes", definition_id)
    if business_object_id and not business_doctype:
        from shangshu_core.model_records import physical_doctype_for

        business_doctype = physical_doctype_for(business_object_id)
    identity = get_identity()
    from shangshu_core.action_provenance import current_action_origin
    version_name = _latest_version(definition_id)
    if not version_name:
        frappe.throw("流程尚未发布", frappe.ValidationError)
    version = frappe.get_doc("Shangshu Process Definition Version", version_name)
    graph = _json(version.graph_json)
    from shangshu_core.application_pages import assert_launch
    assert_launch(graph)
    start = next(node for node in graph["nodes"] if node.get("start"))
    instance = frappe.get_doc(
        {
            "doctype": "Shangshu Process Instance",
            "definition_version": version.name,
            "definition_id": definition_id,
            "graph_hash": version.graph_hash,
            "input_json": _canonical(_json(input_data, {})),
            "variables_json": _canonical(_json(input_data, {})),
            "start_key": start_key,
            "business_doctype": business_doctype,
            "business_name": business_name,
            "initiator_identity": identity.name,
            "initiator_user": frappe.session.user,
            "origin_snapshot_json": _canonical(current_action_origin()),
            "enterprise_id": enterprise_id,
            "status": "Running",
            "current_node": start["id"],
            "started_at": now_datetime(),
        }
    ).insert(ignore_permissions=True)
    return instance


def _node_for_instance(instance, node_id):
    version = frappe.get_doc("Shangshu Process Definition Version", instance.definition_version)
    if version.graph_hash != instance.graph_hash:
        frappe.throw("流程实例版本校验失败", frappe.ValidationError)
    graph = _json(version.graph_json)
    node = next((item for item in graph["nodes"] if item.get("id") == node_id), None)
    if not node:
        frappe.throw("节点不属于该流程版本", frappe.ValidationError)
    return graph, node


def _action_for_instance(instance, action_id):
    """按实例绑定的发布版本解析动作，禁止运行中漂移到最新注册版本。"""
    version = frappe.get_doc("Shangshu Process Definition Version", instance.definition_version)
    dependencies = _json(version.dependency_snapshot_json, {})
    pinned = (dependencies.get("actions") or {}).get(action_id) or {}
    registry_key = pinned.get("registry_key")
    if not registry_key or not frappe.db.exists("Shangshu Action Definition", registry_key):
        frappe.throw(f"流程版本引用的动作不可用：{action_id}", frappe.ValidationError)
    action = frappe.get_doc("Shangshu Action Definition", registry_key)
    if action.action_id != action_id:
        frappe.throw(f"流程动作版本校验失败：{action_id}", frappe.ValidationError)
    return action


@instance_execution('instance_name')
def begin_node_execution(instance_name, node_id, input_data=None):
    instance = frappe.get_doc("Shangshu Process Instance", instance_name)
    if instance.status in FINAL_INSTANCE_STATES:
        frappe.throw("流程实例已经结束", frappe.ValidationError)
    if instance.current_node != node_id:
        frappe.throw("该节点不是当前可执行节点", frappe.ValidationError)
    graph, node = _node_for_instance(instance, node_id)
    attempt = frappe.db.count("Shangshu Node Execution", {"process_instance": instance.name, "node_id": node_id}) + 1
    token = secrets.token_urlsafe(32)
    action_id = node.get("action_id")
    candidates = node.get("candidates") or []
    action = _action_for_instance(instance, action_id) if action_id else None
    execution = frappe.get_doc(
        {
            "doctype": "Shangshu Node Execution",
            "process_instance": instance.name,
            "node_id": node_id,
            "node_type": node["type"],
            "attempt": attempt,
            "status": "Running" if node["type"] != "human_task" else "Waiting Human",
            "idempotency_key": secrets.token_hex(24),
            "input_json": _canonical(_json(input_data, {})),
            "action_id": action_id,
            "action_version": action.action_version if action else None,
            "candidate_tools_json": _canonical(candidates),
            "execution_token_hash": hashlib.sha256(token.encode()).hexdigest(),
            "token_expires_at": add_to_date(now_datetime(), minutes=15),
            "safe_retry": 1 if (action and action.effect in SAFE_RETRY_EFFECTS) or node["type"] == "ai_select" else 0,
            "started_at": now_datetime(),
        }
    ).insert(ignore_permissions=True)
    return {"execution": execution.name, "token": token, "node": node, "graph_hash": instance.graph_hash}


@instance_execution('execution_name', execution=True)
def complete_node_execution(execution_name, token, selected_tool=None, output_data=None, reason=None, callback_id=None, decision=None):
    instance_name = frappe.db.get_value("Shangshu Node Execution", execution_name, "process_instance")
    if instance_name:
        frappe.db.get_value("Shangshu Process Instance", instance_name, "name", for_update=True)
    frappe.db.get_value("Shangshu Node Execution", execution_name, "name", for_update=True)
    execution = frappe.get_doc("Shangshu Node Execution", execution_name)
    if not token or not hmac.compare_digest(
        execution.execution_token_hash or "",
        hashlib.sha256(str(token).encode()).hexdigest(),
    ):
        frappe.throw("执行令牌无效", frappe.PermissionError)
    if execution.status == "Completed":
        return {"execution": execution.name, "status": execution.status, "output": _json(execution.output_json, {})}
    if execution.status not in ("Running", "Waiting Human"):
        frappe.throw("当前执行记录不可完成", frappe.ValidationError)
    if execution.token_expires_at and execution.token_expires_at < now_datetime():
        frappe.throw("执行令牌已过期", frappe.PermissionError)
    if callback_id:
        duplicate = frappe.db.get_value("Shangshu Node Execution", {"callback_id": callback_id}, "name")
        if duplicate and duplicate != execution.name:
            frappe.throw("回调幂等键已被其他执行使用", frappe.DuplicateEntryError)

    instance = frappe.get_doc("Shangshu Process Instance", execution.process_instance)
    if instance.status in FINAL_INSTANCE_STATES or instance.current_node != execution.node_id:
        frappe.throw("节点已变化，请刷新后重新办理", frappe.ValidationError)
    graph, node = _node_for_instance(instance, execution.node_id)
    # 先算下一步，不能在分支失败后留下“节点已完成、实例没推进”的半状态。
    next_node = None if node.get("terminal") else _select_next_node(
        graph, node, _json(execution.input_json, {}), decision
    )
    candidates = _json(execution.candidate_tools_json, [])
    if node["type"] == "ai_select":
        if selected_tool not in candidates:
            execution.status = "Failed"
            execution.checkpoint = "tool_rejected"
            execution.ended_at = now_datetime()
            execution.save(ignore_permissions=True)
            exception = _record_exception(execution, "TOOL_NOT_ALLOWED", "模型返回了候选集合外工具", False)
            return {
                "execution": execution.name,
                "status": "Failed",
                "error": {"code": "TOOL_NOT_ALLOWED", "message": "AI 选择超出节点允许的候选工具"},
                "exception": exception.name,
            }
        selected_action = _action_for_instance(instance, selected_tool)
        # **统一日志库**（PKG-020-T01）：AI 执行审计只写统一表这一处；
        # 旧表 `Shangshu AI Execution Audit` 保留表结构与历史行，不再新增。
        _legacy_ai_row = {
            "node_execution": execution.name,
            "candidate_tools_json": _canonical(candidates),
            "selected_tool": selected_tool,
            "selection_reason": reason or "",
            "model_version": "bff-declared",
            "tool_version": selected_action.action_version,
            "prompt_summary": "仅包含当前节点允许的候选工具与已脱敏业务上下文",
            "created_by_identity": get_identity().name,
        }
        unified_log.write_log(
            kind="tool", what_id=selected_tool,
            domain_id=frappe.db.get_value("Shangshu Process Definition", instance.definition_id, "namespace")
            or "com.shangshu.core",
            actor_user=frappe.session.user, actor_identity=get_identity().name,
            trigger_source="agent",
            result="Succeeded",
            reference_doctype="Shangshu Node Execution", reference_name=execution.name,
            detail={
                "node_execution": execution.name,
                "node_id": execution.node_id,
                "process_instance": instance.name,
                "candidate_tools": candidates,
                "selected_tool": selected_tool,
                "selection_reason": reason or "",
                "model_version": "bff-declared",
                "tool_version": selected_action.action_version,
                "prompt_summary": "仅包含当前节点允许的候选工具与已脱敏业务上下文",
                # 旧形状快照：旧读口按它投影回去 ⇒ 既有返回形状不变。
                "legacy": _legacy_ai_row,
            })

    execution.status = "Completed"
    execution.selected_tool = selected_tool
    execution.selection_reason = reason
    execution.output_json = _canonical(_json(output_data, {}))
    execution.callback_id = callback_id
    execution.checkpoint = "result_committed"
    execution.ended_at = now_datetime()
    execution.save(ignore_permissions=True)
    if not frappe.db.exists("Shangshu Process Subscription", {"process_instance": instance.name, "user": frappe.session.user}):
        frappe.get_doc({"doctype":"Shangshu Process Subscription", "process_instance":instance.name,
                        "user":frappe.session.user, "reason":f"办理参与：{execution.node_id}"}).insert(ignore_permissions=True)
    _advance(instance, graph, node, next_node=next_node)
    return {"execution": execution.name, "status": execution.status, "output": _json(execution.output_json, {})}


def _select_next_node(graph, node, sample=None, decision=None):
    branches = [edge for edge in graph["edges"] if edge.get("source") == node["id"]]
    if len(branches) == 1:
        return branches[0]["target"]
    chosen = None
    if node.get("type") == "condition":
        for edge in sorted(branches, key=lambda item: int(item.get("priority") or 0)):
            if edge.get("is_default"):
                continue
            rule = edge.get("condition")
            if ((isinstance(rule, dict) and _condition_value(rule, sample or {}))
                    or (isinstance(rule, str) and _legacy_condition_value(rule, sample or {}))):
                chosen = edge
                break
        if chosen is None:
            chosen = next((edge for edge in branches if edge.get("is_default")), None)
    elif decision is not None:
        matches = [edge for edge in branches if decision in
                   (edge.get("id"), edge.get("target"), edge.get("label"), edge.get("condition"))]
        if len(matches) == 1:
            chosen = matches[0]
    if chosen is None:
        frappe.throw("没有匹配的流程出口，请检查条件输入或选择办理动作", frappe.ValidationError)
    return chosen["target"]


def _advance(instance, graph, node, next_node=None):
    if node.get("terminal"):
        instance.status = "Completed"
        instance.completed_at = now_datetime()
        instance.current_node = node["id"]
    else:
        instance.current_node = next_node or _select_next_node(graph, node)
    instance.save(ignore_permissions=True)


@instance_execution('execution_name', execution=True)
def fail_node_execution(execution_name, code, message, retryable=False):
    execution = frappe.get_doc("Shangshu Node Execution", execution_name)
    if execution.status == "Completed":
        frappe.throw("已完成执行不能标记失败", frappe.ValidationError)
    execution.status = "Failed"
    execution.checkpoint = "external_failed"
    execution.ended_at = now_datetime()
    execution.save(ignore_permissions=True)
    return _record_exception(execution, code, message, bool(retryable and execution.safe_retry))


def _record_exception(execution, code, message, retryable):
    return frappe.get_doc(
        {
            "doctype": "Shangshu Process Exception",
            "process_instance": execution.process_instance,
            "node_execution": execution.name,
            "error_code": code,
            "error_message": str(message)[:1000],
            "retryable": 1 if retryable else 0,
            "status": "Open",
            "created_at": now_datetime(),
        }
    ).insert(ignore_permissions=True)


def list_published_processes():
    rows = frappe.get_all(
        "Shangshu Process Definition",
        # A definition may have a newer draft while its last immutable version
        # remains usable.  The process center must not hide that published
        # version merely because somebody is editing the next revision.
        filters={"last_published_version": ["is", "set"]},
        fields=["definition_id", "title", "business_object", "last_published_version", "modified"],
        order_by="title asc",
    )
    result = []
    for row in rows:
        domain = contribution_for_resource("processes", row.definition_id, include_disabled=True)
        if domain and not domain["enabled"]:
            continue
        row["domain_id"] = domain["id"] if domain else "com.shangshu.core"
        row["domain_name"] = domain["name"] if domain else "平台"
        from shangshu_core.domains import raw_resource
        from shangshu_core.process_portal import get_process_launch_context
        _, resource = raw_resource("processes", row.definition_id)
        if resource and resource.get("launch_adapter"):
            row["can_launch"] = True
        else:
            try:
                context = get_process_launch_context(row.definition_id)
                row["can_launch"] = context["supported"]
                row["launch_reason"] = context["reason"]
            except frappe.PermissionError:
                continue
            except frappe.ValidationError:
                row["can_launch"] = False
                row["launch_reason"] = "流程或所属应用依赖需管理员检查"
        result.append(row)
    return result


def _instance_access(instance, require_pending=False):
    if get_identity().enterprise_id != instance.enterprise_id:
        return False
    user = frappe.session.user
    roles = set(frappe.get_roles())
    if "System Manager" in roles or (instance.initiator_user == user and not require_pending):
        return True
    if not require_pending and frappe.db.exists("Shangshu Process Subscription", {"process_instance": instance.name, "user": user}):
        return True
    try:
        graph, node = _node_for_instance(instance, instance.current_node)
    except Exception:
        return False
    allowed = set(node.get("allowed_roles") or [])
    return bool(allowed.intersection(roles)) if allowed else instance.initiator_user == user


def list_process_instances(view="started", definition_ids=None):
    user = frappe.session.user
    filters = {"enterprise_id": get_identity().enterprise_id}
    if definition_ids is not None:
        filters["definition_id"] = ["in", definition_ids or [""]]
    if view == "started":
        filters["initiator_user"] = user
    elif view == "completed":
        filters["status"] = "Completed"
    elif view == "pending":
        filters["status"] = "Running"
    elif view == "copied":
        subscriptions = frappe.get_all("Shangshu Process Subscription", filters={"user": user}, fields=["process_instance", "reason"])
        names = [row.process_instance for row in subscriptions if not str(row.reason or "").startswith("办理参与：")]
        filters["name"] = ["in", names or [""]]
    else:
        frappe.throw("不支持的流程视图", frappe.ValidationError)
    rows = frappe.get_all(
        "Shangshu Process Instance",
        filters=filters,
        fields=["name", "definition_id", "business_doctype", "business_name", "status", "current_node", "initiator_user", "modified"],
        order_by="modified desc",
        limit_page_length=100,
    )
    result = []
    title_cache = {}
    for row in rows:
        instance = frappe.get_doc("Shangshu Process Instance", row.name)
        if view == "pending" and not _instance_access(instance, require_pending=True):
            continue
        if view == "completed" and not _instance_access(instance):
            continue
        if view not in ("started", "completed", "copied", "pending") and not _instance_access(instance):
            continue
        domain = contribution_for_resource("processes", row.definition_id, include_disabled=True)
        definition = frappe.db.get_value("Shangshu Process Definition", {"definition_id": row.definition_id}, ["title", "last_published_version"], as_dict=True) or {}
        title_key = (row.name, row.current_node)
        if title_key not in title_cache:
            try:
                _, node = _node_for_instance(instance, instance.current_node)
                title_cache[title_key] = node.get("title") or "处理中"
            except Exception:
                title_cache[title_key] = "处理中"
        row["definition_title"] = definition.get("title") or "业务流程"
        row["current_node_title"] = title_cache[title_key]
        row["domain_id"] = domain["id"] if domain else "com.shangshu.core"
        row["domain_name"] = domain["name"] if domain else "平台"
        row["domain_enabled"] = domain["enabled"] if domain else True
        result.append(row)
    return result


@instance_execution('name')
def get_instance_replay(name):
    instance = frappe.get_doc("Shangshu Process Instance", name)
    if not _instance_access(instance):
        frappe.throw("无权查看该流程实例", frappe.PermissionError)
    executions = frappe.get_all(
        "Shangshu Node Execution",
        filters={"process_instance": name},
        fields=["name", "node_id", "node_type", "attempt", "status", "action_id", "action_version", "candidate_tools_json", "selected_tool", "selection_reason", "checkpoint", "started_at", "ended_at", "output_json"],
        order_by="creation asc",
    )
    exceptions = frappe.get_all(
        "Shangshu Process Exception",
        filters={"process_instance": name},
        fields=["name", "node_execution", "error_code", "error_message", "retryable", "status", "recovery_action", "resolved_at"],
        order_by="creation asc",
    )
    domain = contribution_for_resource("processes", instance.definition_id, include_disabled=True)
    definition_title = frappe.db.get_value(
        "Shangshu Process Definition", {"definition_id": instance.definition_id}, "title"
    ) or "业务流程"
    try:
        graph, current_node = _node_for_instance(instance, instance.current_node)
        current_node_title = current_node.get("title") or "处理中"
        titles = {node["id"]:node.get("title") or node["id"] for node in graph["nodes"]}
        for execution in executions:
            execution["node_title"] = titles.get(execution.node_id, execution.node_id)
    except Exception:
        current_node_title = "处理中"
    public_instance = instance.as_dict()
    # 回放不能绕过申请字段权限；受限业务材料由办理接口投影。
    frozen, _ = _node_for_instance(instance, instance.current_node)
    if (frozen.get("form") or {}).get("field_policy") and "System Manager" not in frappe.get_roles():
        for key in ("input_json", "variables_json"):
            public_instance.pop(key, None)
        for execution in executions:
            execution.pop("output_json", None)
    return {
        "instance": public_instance,
        "definition_title": definition_title,
        "current_node_title": current_node_title,
        "domain": {"id": domain["id"], "name": domain["name"], "enabled": domain["enabled"]} if domain else {"id": "com.shangshu.core", "name": "平台", "enabled": True},
        "executions": executions,
        "exceptions": exceptions,
    }
