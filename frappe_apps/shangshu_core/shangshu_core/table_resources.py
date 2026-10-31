"""按完整资源 ID 定位表格，不列举目录，也不在授权失败后改猜存储。"""
import frappe

HOOK = "shangshu_table_resource_resolvers"


def resolve_table_resource(resource_id):
    from shangshu_core import business_access, model_records, objects
    from shangshu_core.domains import raw_resource

    business_access.require_identity()
    if not isinstance(resource_id, str) or not resource_id or resource_id != resource_id.strip():
        frappe.throw("请提供完整的表格资源 ID", frappe.ValidationError)
    candidates = []
    managed = model_records.is_managed(resource_id)
    domain, item = (None, None) if managed else raw_resource("objects", resource_id)
    if managed or (domain and item):
        # 准入错误原样返回；不能把‘有对象但无权/停用’当作‘没有这个对象’。
        objects.get_object_definition(resource_id)
        candidates.append({"table": resource_id, "source": "db"})
    providers = frappe.get_hooks(HOOK) or []
    if not isinstance(providers, (list, tuple)):
        frappe.throw("表格资源解析器配置无效", frappe.ValidationError)
    for path in providers:
        if not isinstance(path, str) or not path:
            frappe.throw("表格资源解析器必须是已安装应用的可信入口", frappe.ValidationError)
        provider = frappe.get_attr(path)
        if not callable(provider):
            frappe.throw("表格资源解析器不可调用", frappe.ValidationError)
        candidate = provider(resource_id)
        if candidate is None:
            continue
        if (not isinstance(candidate, dict) or candidate.get("table") != resource_id or
                candidate.get("source") != "xlsx"):
            frappe.throw("表格资源解析器返回了错误的身份或类型", frappe.ValidationError)
        candidates.append({"table": resource_id, "source": "xlsx"})
    if not candidates:
        frappe.throw("表格资源不存在", frappe.DoesNotExistError)
    if len(candidates) != 1:
        frappe.throw("同一 ID 对应多种表格资源，存在歧义，请使用明确来源的链接", frappe.ValidationError)
    return candidates[0]
