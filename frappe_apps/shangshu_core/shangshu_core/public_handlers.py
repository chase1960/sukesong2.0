import frappe

from shangshu_core.objects import query_object_records


def execute_action(action_id, payload, _context):
    if action_id == "platform.object.aggregate":
        from shangshu_core import model_records
        return model_records.aggregate_records(
            payload.get("object_id"),
            payload.get("filters") or {},
            payload.get("metrics") or None,
            payload.get("group_by") or None,
            payload.get("scope") or None,
            payload.get("result_set"),
        )
    if action_id == "platform.object.query":
        return query_object_records(
            payload.get("object_id"),
            payload.get("filters") or {},
            payload.get("page") or 1,
            payload.get("page_length") or 30,
            payload.get("result_set"),
            fields=payload.get("fields"),
            read_scope=payload.get("read_scope"),
            include_definition=payload.get("include_definition", True),
        )
    if action_id == "platform.object.result_set":
        # **结果集引用的有效性检查口**（PKG-018-T08）：只报「还准不准」，不返数据。
        from shangshu_core import result_sets
        return result_sets.describe(payload.get("ref"))
    if action_id == "platform.metric.define":
        # **指标登记**（PKG-018-T09）：FDE 登记「统计什么／按哪个日期／如何去重」。
        from shangshu_core import metric_registry
        return metric_registry.define(payload)
    if action_id == "platform.metric.run":
        # 按名字跑一个登记好的指标（走**同一套**统计口径）。
        from shangshu_core import metric_registry
        return metric_registry.run(payload)
    if action_id == "platform.metric.list":
        from shangshu_core import metric_registry
        return {"items": metric_registry.list_definitions()}
    if action_id == "platform.object.join_aggregate":
        # **跨表 JOIN**（PKG-018-T10）：只支持**声明过的引用关联**；
        # 基数必须显式声明；两端权限都查。
        from shangshu_core import join_aggregate
        return join_aggregate.join_aggregate(payload)
    if action_id == "platform.object.audit_log":
        # **按受管记录取日志**（2026-10-22 第四段）：动作审计 ＋ 事件信封，
        # **每条带来源编号**（可点回原始记录）；授权与全局流水**同一套**。
        from shangshu_core import receipts
        return receipts.query_business_audits(
            payload.get("object_id"),
            business_name=payload.get("business_name") or None,
            page=payload.get("page") or 1,
            page_length=payload.get("page_length") or 50,
        )
    frappe.throw("平台动作不存在", frappe.DoesNotExistError)


def record_process_log(service_id, values, _context):
    """**平台服务 `platform.log.record`**：写一条过程记录（助手与别的域走这个口）。

    与 `public_api.write_process_record` **同一条路**（都汇到 `unified_log.write_log`）——
    域用公开口，助手/别的域用这个服务；**域与域之间不直接依赖**。

    写进去的是**过程痕迹**，不是正式值（正式值住在受管记录里）——
    日志只记「做了什么、跟哪条业务记录有关、结果如何」，**不抄业务值**。
    """
    from shangshu_core import process_log
    row = process_log.write_process_record(
        values.get("what_id") or "",
        domain_id=values.get("domain_id") or "com.shangshu.core",
        business_object_id=values.get("business_object_id") or "",
        business_name=values.get("business_name") or "",
        result=values.get("result") or "Succeeded",
        trigger_source=values.get("trigger_source") or "unknown",
        detail=values.get("detail") or {},
    )
    return {"log_no": row.log_no, "domain_id": row.domain_id, "what_kind": row.what_kind,
            "what_id": row.what_id, "result": row.result,
            "business_object_id": row.business_object_id}


def handle_contract_checked(payload, context):
    """最小内建订阅，用于证明版本化事件投递面可独立工作。"""
    return {"accepted": True, "source": payload.get("source"), "delivery_key": context.get("delivery_key")}
