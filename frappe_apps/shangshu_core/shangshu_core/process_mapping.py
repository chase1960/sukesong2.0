"""通用动作的有界类型映射；不执行代码、不直接写对象、不扩权。"""
import frappe
from shangshu_core.schema_validation import _validate_schema


def validate_mapping(graph,node,action):
    import json
    if not node.get("automatic") and not node.get("input_mapping") and not node.get("output_mapping"):return
    if node["type"]!="action":frappe.throw("只有动作节点支持数据映射",frappe.ValidationError)
    if node.get("automatic") and (action.effect not in {"read","external/read","extract"} or action.confirmation_policy=="required"):
        frappe.throw("需确认或有写副作用的动作不能自动执行",frappe.ValidationError)
    schema=json.loads(action.input_schema_json or '{}')
    inputs=node.get("input_mapping",{})
    outputs=node.get("output_mapping",{})
    if not isinstance(inputs,dict) or not isinstance(outputs,dict):frappe.throw("映射必须是字段字典",frappe.ValidationError)
    if set(schema.get("required",[]))-set(inputs):frappe.throw("动作必填输入缺少映射",frappe.ValidationError)
    properties=(graph.get("form") or {}).get("input_schema",{}).get("properties",{})
    for target,binding in inputs.items():
        prop=schema.get("properties",{}).get(target)
        if not prop or not isinstance(binding,dict):frappe.throw("映射目标不是动作输入字段",frappe.ValidationError)
        if set(binding)=={"value"}:_validate_schema(binding["value"],prop)
        elif set(binding)=={"field"}:
            source=properties.get(binding["field"])
            if not source or source.get("type")!=prop.get("type") and not (source.get("type")=="integer" and prop.get("type")=="number"):
                frappe.throw("映射来源不存在或类型不兼容",frappe.ValidationError)
        else:frappe.throw("输入映射仅支持流程字段或固定值",frappe.ValidationError)
    for target,binding in outputs.items():
        if not isinstance(target,str) or not target.isidentifier() or target.startswith('_') or target in properties:
            frappe.throw("输出变量不能覆盖申请字段或保留字段",frappe.ValidationError)
        if not isinstance(binding,dict) or set(binding)!={"field","type"} or not isinstance(binding["field"],str) or binding["type"] not in {"string","number","integer","boolean","object","array"}:
            frappe.throw("输出映射需声明字段和类型",frappe.ValidationError)


def input_values(node,values):
    return {name:binding.get("value") if "value" in binding else values.get(binding["field"])
            for name,binding in node.get("input_mapping",{}).items()}


def output_values(node,result):
    values={}
    for name,binding in node.get("output_mapping",{}).items():
        if not isinstance(result,dict) or binding["field"] not in result:
            frappe.throw("动作输出缺少映射字段",frappe.ValidationError)
        value=result[binding["field"]]
        _validate_schema(value,{"type":binding["type"]})
        values[name]=value
    return values
