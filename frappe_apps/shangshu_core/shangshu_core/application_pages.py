"""有限应用页面与审批组合；定义随 Application Revision 冻结，不另建发布权威。"""
import json
import math
import re

import frappe

from shangshu_core.design_support import content_hash, canonical_json, require_application
from shangshu_core.identity import get_identity


def compile_pages(spec, application_id, model_lookup=None):
    from shangshu_core.model_records import definition
    pages, workflows = spec.get("pages", []), spec.get("workflows", [])
    if not isinstance(pages, list) or len(pages) > 30 or not isinstance(workflows, list) or len(workflows) > 30:
        frappe.throw("页面和流程分别最多 30 项", frappe.ValidationError)
    datasets = {b["resource_id"] for b in spec.get("bindings", []) if b["kind"] == "datasets"}
    compiled, seen = [], set()
    for page in pages:
        if not isinstance(page, dict) or set(page) - {"id","title","object_id","fields","list_fields","columns","version","input_schema","field_policy","reference_fields","access"}:
            frappe.throw("页面配置不支持该字段", frappe.ValidationError)
        _identifier(page, seen)
        if page.get("object_id") not in datasets:
            frappe.throw("表单必须绑定本应用已引用的数据表", frappe.ValidationError)
        model = model_lookup(page['object_id'])[0] if model_lookup else definition(page["object_id"])
        if model.get("source") != "managed":
            frappe.throw("当前申请表配置仅支持受管数据表，代码域请使用已注册页面",frappe.ValidationError)
        fields = page.get("fields")
        properties = model["input_schema"]["properties"]
        if not isinstance(fields, list) or not fields or any(not isinstance(f,str) or f not in properties for f in fields) or len(set(fields)) != len(fields):
            frappe.throw("请选择有效且不重复的表单字段", frappe.ValidationError)
        if set(model["input_schema"].get("required",[])) - set(fields):
            frappe.throw("表单不能隐藏数据表的必填字段", frappe.ValidationError)
        columns = page.get("columns",1)
        if type(columns) is not int or columns not in (1,2):
            frappe.throw("表单只支持一列或两列布局", frappe.ValidationError)
        schema = {"type":"object","properties":{f:properties[f] for f in fields},
                  "required":[f for f in fields if f in model["input_schema"].get("required",[])],"additionalProperties":False}
        item = {"id":page["id"],"title":page["title"].strip(),"object_id":model["id"],"fields":fields,"columns":columns,
                "input_schema":schema,"reference_fields":{k:v for k,v in model.get("reference_fields",{}).items() if k.split('.')[0] in fields},
                "field_policy":[f for f in model["fields"] if f["id"] in fields]}
        list_fields=page.get("list_fields",[f["id"] for f in model["fields"] if f["type"]!="detail"])
        allowed_list={f["id"] for f in model["fields"] if f["type"]!="detail"}
        if not isinstance(list_fields,list) or not list_fields or any(not isinstance(f,str) or f not in allowed_list for f in list_fields) or len(set(list_fields))!=len(list_fields):
            frappe.throw("列表至少选择一个非明细字段，且不能重复",frappe.ValidationError)
        item["list_fields"]=list_fields
        from shangshu_core.model_records import _load
        active = model_lookup(model['id'])[1] if model_lookup else _load(model['id'])[1]
        item["access"]=active["access"]
        item["version"] = content_hash([model["revision"],item])
        compiled.append(item)
    forms = {p["id"]:p for p in compiled}
    flows, seen = [], set()
    for flow in workflows:
        if not isinstance(flow, dict) or set(flow) - {"id","title","form_id","approver_role","amount_field","threshold","escalation_role"}:
            frappe.throw("审批配置包含不支持的字段", frappe.ValidationError)
        _identifier(flow,seen)
        if flow.get("form_id") not in forms:
            frappe.throw("审批必须引用本应用的申请表", frappe.ValidationError)
        for key in ("approver_role", "escalation_role"):
            role=flow.get(key)
            if (key=="approver_role" or role) and (not isinstance(role,str) or role in {"Guest","All"} or not frappe.db.exists("Role",{"name":role,"disabled":0})):
                frappe.throw("请选择有效审批角色", frappe.ValidationError)
        item={k:flow[k] for k in ("id","title","form_id","approver_role")}
        if flow.get("amount_field"):
            prop=forms[flow["form_id"]]["input_schema"]["properties"].get(flow["amount_field"],{})
            threshold=flow.get("threshold")
            if prop.get("type") not in {"integer","number"} or type(threshold) not in (int,float) or not math.isfinite(threshold) or not flow.get("escalation_role"):
                frappe.throw("金额分支需数值字段、有效阈值与复核角色", frappe.ValidationError)
            item.update(amount_field=flow["amount_field"],threshold=threshold,escalation_role=flow["escalation_role"])
        elif flow.get("escalation_role") or flow.get("threshold") is not None:
            frappe.throw("请先选择金额判断字段", frappe.ValidationError)
        flows.append(item)
    overview=spec.get("overview",False)
    if type(overview) is not bool:
        frappe.throw("应用总览开关必须为布尔值", frappe.ValidationError)
    return {"pages":compiled,"workflows":flows,"overview":overview}


def _identifier(item, seen):
    if not isinstance(item.get("id"),str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}",item["id"]) or item["id"] in seen:
        frappe.throw("页面/流程标识需为唯一的小写英文标识", frappe.ValidationError)
    if not isinstance(item.get("title"),str) or not 1 <= len(item["title"].strip()) <= 100:
        frappe.throw("请填写名称（最多 100 字）", frappe.ValidationError)
    seen.add(item["id"])


def process_id(application_id, flow):
    return application_id + ".process." + flow["id"]


def approval_graph(application_id, revision, spec, flow):
    page=next(p for p in spec["pages"] if p["id"]==flow["form_id"])
    prefix=process_id(application_id,flow)
    schema={**page["input_schema"],"required":list(page["input_schema"].get("required",[]))}
    # 条件必需的输入不能留空；类型仍来自同一个对象字段。
    if flow.get("amount_field") and flow["amount_field"] not in schema["required"]:
        schema["required"].append(flow["amount_field"])
    empty={"type":"object","properties":{},"additionalProperties":False}
    nodes=[{"id":prefix+".submit","type":"human_task","title":page["title"],"start":True,"submit_on_launch":True,"form_schema":schema},
           {"id":prefix+".review","type":"human_task","title":"审批","allowed_roles":[flow["approver_role"]],"form_schema":empty},
           {"id":prefix+".revise","type":"human_task","title":"修改并重新提交","form_schema":schema},
           {"id":prefix+".done","type":"human_task","title":"已通过","terminal":True,"auto_complete":True,"form_schema":empty}]
    edges=[]
    def edge(source,target,label):
        edges.append({"id":prefix+".edge."+source+"_"+target,"source":prefix+"."+source,"target":prefix+"."+target,"label":label})
    edge("submit","review","提交");edge("revise","review","重新提交");edge("review","revise","退回修改")
    if flow.get("amount_field"):
        nodes.extend([{"id":prefix+".amount","type":"condition","title":"金额判断"},
                      {"id":prefix+".extra","type":"human_task","title":"金额复核","allowed_roles":[flow["escalation_role"]],"form_schema":empty}])
        edge("review","amount","通过")
        edge("amount","extra","达到复核金额")
        edges[-1]["condition"]={"source":{"scope":"process_input","field_path":flow["amount_field"],"field_label":schema["properties"][flow["amount_field"]].get("title",flow["amount_field"]),"data_type":"number"},"operator":"gte","value":flow["threshold"]}
        edge("amount","done","无需额外复核");edges[-1]["is_default"]=True
        edge("extra","done","通过");edge("extra","revise","退回修改")
    else:edge("review","done","通过")
    return {"schema_version":2,"definition_id":prefix,"business_object":page["object_id"],"nodes":nodes,"edges":edges,
            "form":{"id":page["id"],"version":page["version"],"columns":page["columns"],"input_schema":schema,
                    "field_order":page["fields"],"field_policy":page["field_policy"],"access":page["access"],"reference_fields":page["reference_fields"]},
            "application_ref":{"id":application_id,"revision":revision,"allowed_roles":spec["allowed_roles"]}}


def publish_workflows(doc, spec):
    """应用发布事务内生成已有 Process Version；失败回滚整个发布。"""
    from shangshu_core.runtime import publish_definition
    for flow in spec.get("workflows",[]):
        graph=approval_graph(doc.name,doc.draft_revision,spec,flow)
        name=frappe.db.get_value("Shangshu Process Definition",{"definition_id":graph["definition_id"]},"name")
        record=frappe.get_doc("Shangshu Process Definition",name) if name else frappe.get_doc({"doctype":"Shangshu Process Definition",
            "definition_id":graph["definition_id"],"namespace":doc.name,"enterprise_id":doc.enterprise_id,"draft_revision":0})
        record.title=flow["title"];record.business_object=graph["business_object"]
        record.graph_json=canonical_json(graph);record.draft_revision+=1;record.status="Draft"
        record.save(ignore_permissions=True)
        publish_definition(record.definition_id,record.draft_revision)


def assert_launch(graph):
    ref=graph.get("application_ref")
    if not ref:return
    app=require_application(ref["id"],get_identity())
    if app.status!="Published" or not app.published_revision:
        frappe.throw("所属应用尚未发布或已停用",frappe.PermissionError)
    history=frappe.get_doc("Shangshu Application Revision",app.published_revision)
    spec=json.loads(history.definition_json)
    if history.revision_number!=ref["revision"] or not any(process_id(app.name,f)==graph["definition_id"] for f in spec.get("workflows",[])):
        frappe.throw("此流程不属于当前应用发布版本",frappe.PermissionError)
    # 试用开放口径（PKG-132）：应用**角色档位**不再阻断已发布应用的启动。
    # ⚠️ 上面三条业务状态判据（未发布／已停用／不属于本发布版本）**照旧执行** ——
    # 那是应用本身的业务状态，不是「谁可以用」。
    from shangshu_core import business_access
    business_access.require_identity()
    if (not business_access.is_open() and "System Manager" not in frappe.get_roles()
            and not set(frappe.get_roles()).intersection(spec["allowed_roles"])):
        frappe.throw("当前账号无权使用此应用",frappe.PermissionError)
    from shangshu_core.applications import _resolve_dependencies, _dependency_domains
    _,issues=_resolve_dependencies(history,_dependency_domains(history))
    if issues:frappe.throw("应用依赖已变化，请管理员重新检查发布",frappe.ValidationError)


def overview_data(application):
    """仅应用详情聚合现有权限查询；目录不查业务库，不另存统计。"""
    from shangshu_core.objects import query_object_records
    from shangshu_core.runtime import list_process_instances
    tables=[]
    for dataset in application.get("datasets",[]):
        try:
            result=query_object_records(dataset["id"],page_length=1)
            tables.append({"id":dataset["id"],"title":dataset.get("name") or dataset["id"],"total":result["total"]})
        except frappe.PermissionError:
            continue
    ids=[flow["id"] for flow in application.get("processes",[])]
    return {"tables":tables,"recent_pending":list_process_instances("pending",definition_ids=ids)[:10] if ids else []}
