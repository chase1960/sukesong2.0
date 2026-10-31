"""通用员工办理适配：沿冻结图与公共动作执行，不替代领域专用驱动。"""
import hashlib
from functools import wraps

import frappe
from shangshu_core.domain_execution import instance_execution

from shangshu_core.actions import _validate_schema, execute_registered_action
from shangshu_core.domains import assert_resource_enabled
from shangshu_core.identity import get_identity
from shangshu_core.runtime import (
    _json, _canonical, _latest_version, _node_for_instance, _action_for_instance,
    begin_node_execution, complete_node_execution, start_process, get_instance_replay,
)


def _atomic_portal(call):
    @wraps(call)
    def wrapped(*args,**kwargs):
        point="portal_"+frappe.generate_hash(length=12)
        frappe.db.savepoint(point)
        try:return call(*args,**kwargs)
        except Exception:
            frappe.db.rollback(save_point=point)
            raise
    return wrapped


def _can_handle(instance, node):
    if instance is not None and get_identity().enterprise_id != instance.enterprise_id:
        return False
    roles = set(frappe.get_roles())
    allowed = set(node.get("allowed_roles") or [])
    if "System Manager" in roles:
        return True
    if allowed:
        return bool(allowed.intersection(roles))
    return instance is not None and instance.initiator_user == frappe.session.user


def _schema(graph, node=None):
    form = graph.get("form") or {}
    schema=(node or {}).get("form_schema") or form.get("input_schema") or {"type":"object","properties":{},"additionalProperties":False}
    if not form.get("field_policy") or "System Manager" in frappe.get_roles():return schema
    from shangshu_core.model_records import _fields
    roles=set(frappe.get_roles())
    allowed={f["id"] for f in _fields({"fields":form["field_policy"]},roles,True)}
    access=form["access"]
    if schema.get("properties") and (not roles.intersection(access["write_roles"]) or not roles.intersection(access["read_roles"])):
        frappe.throw("当前角色无权填写此申请表",frappe.PermissionError)
    return _project_schema(schema,form["field_policy"],roles,write=True)


def _project_schema(schema, fields, roles, write=False):
    from shangshu_core.model_records import _fields
    allowed={field["id"]:field for field in _fields({"fields":fields},roles,write)}
    if write and set(schema.get("required",[]))-set(allowed):
        frappe.throw("当前角色缺少必填字段权限",frappe.PermissionError)
    properties={}
    for key,prop in schema.get("properties",{}).items():
        if key not in allowed:continue
        properties[key]=dict(prop)
        if allowed[key].get("children"):
            properties[key]["items"]=_project_schema(prop.get("items",{}),allowed[key]["children"],roles,write)
    return {**schema,"properties":properties,"required":[k for k in schema.get("required",[]) if k in properties]}


def _project_values(values,schema):
    result={}
    for key,prop in schema.get("properties",{}).items():
        if key not in values:continue
        value=values[key]
        if prop.get("type")=="array" and prop.get("items",{}).get("type")=="object" and isinstance(value,list):
            value=[_project_values(row,prop["items"]) for row in value if isinstance(row,dict)]
        result[key]=value
    return result


def _validate_form_references(graph,values):
    from shangshu_core.objects import get_object_record
    for path,target in (graph.get("form") or {}).get("reference_fields",{}).items():
        parts=path.split('.')
        candidates=[values.get(parts[0])] if len(parts)==1 else [row.get(parts[1]) for row in values.get(parts[0],[]) if isinstance(row,dict)]
        for value in candidates:
            if value not in (None,""):
                get_object_record(target,value)


def _support(graph):
    unsupported = [node.get("title") or node["id"] for node in graph["nodes"]
                   if node["type"] not in ("human_task", "condition", "action")]
    if unsupported:
        return "以下节点需要领域执行适配：" + "、".join(unsupported)
    if graph.get("mappings"):
        return "该流程的数据映射需要领域执行适配"
    def unsupported_source(rule):
        if not isinstance(rule, dict):
            return bool(rule)
        if "rules" in rule:
            return any(unsupported_source(child) for child in rule["rules"])
        return (rule.get("source") or {}).get("scope") != "process_input"
    if any(unsupported_source(edge.get("condition")) for edge in graph["edges"]
           if isinstance(edge.get("condition"), dict)):
        return "通用办理的条件暂只支持流程输入，业务对象/节点输出请使用领域适配"
    form = graph.get("form") or {}
    if form.get("sections") and not form.get("input_schema"):
        return "请配置通用发起表单 input_schema 或使用所属应用的办理入口"
    return None


def get_process_launch_context(definition_id):
    get_identity()
    assert_resource_enabled("processes", definition_id)
    version_name = _latest_version(definition_id)
    if not version_name:
        frappe.throw("流程尚未发布", frappe.ValidationError)
    version = frappe.get_doc("Shangshu Process Definition Version", version_name)
    graph = _json(version.graph_json)
    from shangshu_core.application_pages import assert_launch
    assert_launch(graph)
    start = next(node for node in graph["nodes"] if node.get("start"))
    if start.get("allowed_roles") and not _can_handle(None, start):
        frappe.throw("当前账号无权发起该流程", frappe.PermissionError)
    title = frappe.db.get_value("Shangshu Process Definition", version.definition, "title")
    return {"definition_id": definition_id, "version": version.name, "title": title,"columns":(graph.get("form") or {}).get("columns",1),
            "reference_fields":(graph.get("form") or {}).get("reference_fields",{}),
            "field_order":(graph.get("form") or {}).get("field_order",[]),
            "schema": _schema(graph, start), "supported": not _support(graph), "reason": _support(graph)}


def publish_portal_definition(definition_id, expected_revision=None):
    """员工入口发布必须有运行适配；底层发布仍供受管领域运行器使用。"""
    from shangshu_core.domains import raw_resource
    from shangshu_core.runtime import get_design_context, publish_definition
    context = get_design_context(definition_id)
    if context["definition"]["graph"].get("application_ref"):
        frappe.throw("请从所属应用发布此流程",frappe.ValidationError)
    _, resource = raw_resource("processes", definition_id)
    if not (resource and resource.get("launch_adapter")):
        reason = _support(context["definition"]["graph"])
        if reason:
            frappe.throw(reason, frappe.ValidationError)
    return publish_definition(definition_id, expected_revision)


@_atomic_portal
def launch_process(definition_id, values, idempotency_key, confirmed=False):
    from shangshu_core.design_support import lock_lifecycle
    lock_lifecycle()
    context = get_process_launch_context(definition_id)
    if not context["supported"]:
        frappe.throw(context["reason"], frappe.ValidationError)
    if confirmed is not True or not idempotency_key:
        frappe.throw("发起流程需要明确确认及幂等键", frappe.ValidationError)
    values = _json(values, {})
    _validate_schema(values, context["schema"])
    identity = get_identity()
    key = hashlib.sha256(f"{identity.identity_id}:{definition_id}:{idempotency_key}".encode()).hexdigest()
    previous = frappe.db.get_value("Shangshu Process Instance", {"start_key": key}, "name")
    if previous:
        instance = frappe.get_doc("Shangshu Process Instance", previous)
        if _json(instance.input_json, {}) != values:
            frappe.throw("幂等键对应的发起内容已变化", frappe.ValidationError)
        return {"name": previous, "idempotent": True}
    instance = start_process(definition_id, enterprise_id=identity.enterprise_id, input_data=values, start_key=key)
    graph,node=_node_for_instance(instance,instance.current_node)
    _validate_form_references(graph,values)
    if graph.get("application_ref") and node.get("submit_on_launch"):
        opened=begin_node_execution(instance.name,node["id"],values)
        complete_node_execution(opened["execution"],opened["token"],output_data=values,callback_id="launch:"+key)
    _drain_conditions(instance.name)
    return {"name": instance.name, "idempotent": False}


@instance_execution('name')
def get_process_task(name):
    replay = get_instance_replay(name)
    instance = frappe.get_doc("Shangshu Process Instance", name)
    graph, node = _node_for_instance(instance, instance.current_node)
    reason = _support(graph)
    can_handle = instance.status == "Running" and _can_handle(instance, node) and not reason
    schema = _schema(graph, node)
    if node["type"] == "action":
        schema = _json(_action_for_instance(instance, node["action_id"]).input_schema_json, {})
    branches = [edge for edge in graph["edges"] if edge["source"] == node["id"]]
    replay["task"] = {"node_id": node["id"], "type": node["type"], "can_handle": bool(can_handle),
                      "reason": reason, "schema": schema, "values": _json(instance.variables_json, {}),
                      "choices": [{"id": edge.get("id") or edge["target"], "title": edge.get("label") or "继续"}
                                  for edge in branches] if node["type"] != "condition" and len(branches) > 1 else []}
    if node["type"]=="action" and node.get("input_mapping"):
        from shangshu_core.process_mapping import input_values
        replay["task"]["values"]=input_values(node,_json(instance.variables_json,{}))
    form=graph.get("form") or {}
    replay["task"].update(reference_fields=form.get("reference_fields",{}),field_order=form.get("field_order",[]),columns=form.get("columns",1),display_schema=form.get("input_schema",schema))
    if form.get("field_policy") and "System Manager" not in frappe.get_roles():
        visible=_project_schema(form["input_schema"],form["field_policy"],set(frappe.get_roles()))
        replay["task"]["display_schema"]=visible
        replay["task"]["values"]=_project_values(replay["task"]["values"],visible)
        # 回放中的输入/输出也不绕过字段权限；业务值只从上面的受限投影提供。
        for execution in replay.get("executions",[]):
            for key in ("input_json","output_json","input","output"):execution.pop(key,None)
        for key in ("input_json","variables_json"):replay.get("instance",{}).pop(key,None)
    return replay


@_atomic_portal
@instance_execution('name')
def complete_process_task(name, node_id, values, idempotency_key, decision=None, confirmed=False):
    if confirmed is not True or not idempotency_key:
        frappe.throw("办理需要明确确认及幂等键", frappe.ValidationError)
    get_identity()
    # 同一实例的并发办理串行化；事务由 Frappe 请求层提交/回滚。
    frappe.db.get_value("Shangshu Process Instance", name, "name", for_update=True)
    instance = frappe.get_doc("Shangshu Process Instance", name)
    graph, node = _node_for_instance(instance, node_id)
    if not _can_handle(instance, node):
        frappe.throw("当前账号无权办理该节点", frappe.PermissionError)
    callback = hashlib.sha256(f"portal:{name}:{frappe.session.user}:{idempotency_key}".encode()).hexdigest()
    request_hash = hashlib.sha256(_canonical({"node":node_id,"values":_json(values,{}),"decision":decision}).encode()).hexdigest()
    previous = frappe.db.get_value("Shangshu Node Execution", {"callback_id": callback}, "name")
    if previous:
        execution = frappe.get_doc("Shangshu Node Execution", previous)
        if execution.request_hash != request_hash:
            frappe.throw("幂等键对应的办理内容已变化", frappe.ValidationError)
        return get_process_task(name)
    if instance.status != "Running" or instance.current_node != node_id:
        frappe.throw("当前节点已变化，请刷新", frappe.ValidationError)
    if _support(graph):
        frappe.throw(_support(graph), frappe.ValidationError)
    values = _json(values, {})
    data = _json(instance.variables_json, {})
    schema = _schema(graph, node)
    action = _action_for_instance(instance, node["action_id"]) if node["type"] == "action" else None
    if action:
        schema = _json(action.input_schema_json, {})
    _validate_schema(values, schema)
    if not action:
        _validate_form_references(graph,values)
    if not action or not (node.get("input_mapping") or node.get("output_mapping")):
        data.update(values)  # 未配置映射的历史人工动作保留原变量语义。
    opened = begin_node_execution(name, node_id, data)
    frappe.db.set_value("Shangshu Node Execution", opened["execution"], "request_hash", request_hash)
    output = values
    if action:
        from shangshu_core.action_provenance import process_node_provenance
        with process_node_provenance(opened['execution'],opened['token']):
            result = execute_registered_action(action.action_id, values, confirmed=True,
                idempotency_key=callback, action_version=action.action_version)
        output = result["result"]
        from shangshu_core.process_mapping import output_values
        data.update(output_values(node,output))
    complete_node_execution(opened["execution"], opened["token"], output_data=output,
                            callback_id=callback, decision=decision, reason=decision)
    frappe.db.set_value("Shangshu Process Instance", name, "variables_json", _canonical(data))
    _drain_conditions(name)
    return get_process_task(name)


def _drain_conditions(name):
    for _ in range(100):
        instance = frappe.get_doc("Shangshu Process Instance", name)
        if instance.status != "Running":
            return
        graph, node = _node_for_instance(instance, instance.current_node)
        if node["type"]=="action" and node.get("automatic"):
            from shangshu_core.process_mapping import validate_mapping,input_values,output_values
            action=_action_for_instance(instance,node["action_id"])
            validate_mapping(graph,node,action)
            data=_json(instance.variables_json,{})
            payload=input_values(node,data)
            opened=begin_node_execution(name,node["id"],payload)
            from shangshu_core.action_provenance import process_node_provenance
            with process_node_provenance(opened['execution'],opened['token']):
                result=execute_registered_action(action.action_id,payload,confirmed=False,
                    idempotency_key="process-auto:"+opened["execution"],action_version=action.action_version,source='automation')
            output=result["result"]
            data.update(output_values(node,output))
            complete_node_execution(opened["execution"],opened["token"],output_data=output)
            frappe.db.set_value("Shangshu Process Instance",name,"variables_json",_canonical(data))
            continue
        if node["type"] != "condition" and not (node.get("terminal") and node.get("auto_complete")):
            return
        opened = begin_node_execution(name, node["id"], _json(instance.variables_json, {}))
        complete_node_execution(opened["execution"], opened["token"], output_data={})
    frappe.throw("条件判断超过 100 步，请检查循环出口", frappe.ValidationError)
