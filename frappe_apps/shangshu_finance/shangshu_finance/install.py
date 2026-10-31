import json

import frappe

from shangshu_core.public_api import (
    register_domain_process_definition,
    get_design_context,
    save_process_draft,
    ensure_immutable_triggers,
    ensure_registered_domains,
    publish_definition,
    register_action,
)


WORKFLOW_NAME = "尚书费用报销财务闭环"
DEFINITION_ID = "com.shangshu.finance.expense_approval"


def _data_sources():
    return [
        {
            "id": "document_extraction",
            "title": "票据抽取记录",
            "scope": "business_object",
            "fields": [
                {"path": "has_text_layer", "label": "是否包含可靠文字层", "data_type": "boolean"},
                {"path": "status", "label": "识别状态", "data_type": "enum"},
                {"path": "selected_tool", "label": "已选择工具", "data_type": "string"},
            ],
        },
        {
            "id": "expense_claim",
            "title": "费用报销单",
            "scope": "business_object",
            "fields": [
                {"path": "amount", "label": "报销金额", "data_type": "number"},
                {"path": "department", "label": "所属部门", "data_type": "string"},
                {"path": "cost_center", "label": "成本中心", "data_type": "string"},
                {"path": "workflow_state", "label": "审批状态", "data_type": "enum"},
            ],
        },
    ]


def _clause(object_id, field_path, field_label, data_type, operator, value, summary):
    return {
        "kind": "clause",
        "source": {
            "scope": "business_object",
            "object_id": object_id,
            "field_path": field_path,
            "field_label": field_label,
            "data_type": data_type,
        },
        "operator": operator,
        "value": value,
        "summary": summary,
    }


def after_install():
    # App 首次安装仍在 Frappe 事务中；DDL trigger 留给紧随其后的 migrate。
    ensure_foundation(install_triggers=False)


def after_migrate():
    ensure_foundation()


def before_tests():
    ensure_foundation()


def ensure_foundation(install_triggers=True):
    ensure_registered_domains()
    ensure_roles()
    ensure_actions()
    from shangshu_finance.funding import install as install_funding
    install_funding(install_triggers)
    ensure_process_definition()
    ensure_workflow()
    if install_triggers:
        ensure_immutable_triggers("Shangshu Ledger Entry", "shangshu_ledger_entry")
        ensure_immutable_triggers("Shangshu Cash Movement", "shangshu_cash_movement")


def ensure_roles():
    for role in ("Expense Approver", "Finance Approver", "Cashier"):
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)


def ensure_actions():
    object_schema = lambda required, properties: {
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": properties,
    }
    schemas = {
        "finance.invoice.confirm_fields": object_schema(
            ["invoice", "expected_version", "fields"],
            {"invoice": {"type": "string"}, "expected_version": {"type": "integer"}, "fields": {"type": "object"}},
        ),
        "finance.expense.create_draft": object_schema(
            ["invoice", "subject"],
            {
                "invoice": {"type": "string"}, "subject": {"type": "string"},
                "department": {"type": "string"}, "cost_center": {"type": "string"},
                "purpose": {"type": "string"},
            },
        ),
        "finance.expense.submit": object_schema(
            ["claim", "action"],
            {"claim": {"type": "string"}, "action": {"type": "string", "enum": ["submit", "resubmit"]}, "note": {"type": "string"}},
        ),
        "finance.expense.manager_decide": object_schema(
            ["claim", "action"],
            {"claim": {"type": "string"}, "action": {"type": "string", "enum": ["manager_approve", "return"]}, "note": {"type": "string"}},
        ),
        "finance.expense.finance_review": object_schema(
            ["claim", "action"],
            {"claim": {"type": "string"}, "action": {"type": "string", "enum": ["finance_approve", "return"]}, "note": {"type": "string"}},
        ),
        "finance.posting.post_expense": object_schema(["claim"], {"claim": {"type": "string"}}),
        "finance.payable.pay": object_schema(
            ["payable", "account", "expected_version"],
            {"payable": {"type": "string"}, "account": {"type": "string"}, "expected_version": {"type": "integer"}},
        ),
    }
    specs = (
        ("document.pdf_text_extract", "1.0.0", "PDF 文字层解析", "extract", "none", ["Desk User"], 60, "safe_read"),
        ("document.ocr_extract", "1.0.0", "OCR 票据识别", "extract", "none", ["Desk User"], 120, "safe_read"),
        ("document.vision_extract", "1.0.0", "多模态票据识别", "extract", "none", ["Desk User"], 180, "safe_read"),
        ("finance.invoice.create_draft", "1.0.0", "生成发票草稿", "propose", "none", ["Desk User"], 30, "none"),
        ("finance.invoice.confirm_fields", "1.0.0", "确认发票字段", "write", "required", ["Desk User", "Finance Approver"], 30, "none"),
        ("finance.expense.create_draft", "1.0.0", "创建报销草稿", "propose", "required", ["Desk User"], 30, "none"),
        ("finance.expense.submit", "1.0.0", "提交报销", "write", "required", ["Desk User"], 30, "none"),
        ("finance.expense.manager_decide", "1.0.0", "经理审批", "high-risk", "required", ["Expense Approver"], 30, "none"),
        ("finance.expense.finance_review", "1.0.0", "财务复核", "high-risk", "required", ["Finance Approver"], 30, "none"),
        ("finance.posting.post_expense", "1.0.0", "费用过账", "append-only", "required", ["Finance Approver"], 30, "none"),
        ("finance.payable.pay", "1.0.0", "登记付款", "append-only", "required", ["Finance Approver", "Cashier"], 30, "none"),
        ("finance.posting.reverse", "1.0.0", "红冲分录", "append-only", "required", ["Finance Approver"], 30, "none"),
        ("finance.cash.reverse", "1.0.0", "冲回现金流水", "append-only", "required", ["Finance Approver", "Cashier"], 30, "none"),
    )
    for action_id, version, title, effect, confirmation, roles, timeout, retry in specs:
        register_action(action_id, version, title, effect, confirmation, roles, schemas.get(action_id, {}), {}, timeout, retry)


def expense_graph():
    n = "com.shangshu.finance.node."
    return {
        "schema_version": 2,
        "definition_id": DEFINITION_ID,
        "business_object": {"id": "finance.expense_claim", "title": "费用报销单"},
        "data_sources": _data_sources(),
        "nodes": [
            {"id": n + "upload", "type": "human_task", "title": "上传票据", "start": True, "allowed_roles": ["Desk User"]},
            {"id": n + "detect", "type": "condition", "title": "判断文字层"},
            {"id": n + "pdf_extract", "type": "action", "title": "PDF 文字解析", "action_id": "document.pdf_text_extract"},
            {"id": n + "scan_extract", "type": "ai_select", "title": "扫描票据识别", "candidates": ["document.ocr_extract", "document.vision_extract"]},
            {"id": n + "confirm_fields", "type": "human_task", "title": "核对发票字段", "allowed_roles": ["Desk User", "Finance Approver"]},
            {"id": n + "claim", "type": "action", "title": "创建报销草稿", "action_id": "finance.expense.create_draft"},
            {"id": n + "submit", "type": "action", "title": "提交报销", "action_id": "finance.expense.submit"},
            {"id": n + "manager", "type": "human_task", "title": "经理审批", "allowed_roles": ["Expense Approver"]},
            {"id": n + "supplement", "type": "human_task", "title": "补充材料", "allowed_roles": ["Desk User"]},
            {"id": n + "finance", "type": "human_task", "title": "财务复核", "allowed_roles": ["Finance Approver"]},
            {"id": n + "post", "type": "action", "title": "确认过账", "action_id": "finance.posting.post_expense"},
            {"id": n + "pay", "type": "action", "title": "登记付款", "action_id": "finance.payable.pay", "terminal": True},
        ],
        "edges": [
            {"id": "edge-upload-detect", "source": n + "upload", "target": n + "detect"},
            {
                "id": "edge-detect-pdf", "source": n + "detect", "target": n + "pdf_extract", "label": "有文字层", "priority": 10,
                "condition": _clause("document_extraction", "has_text_layer", "是否包含可靠文字层", "boolean", "eq", True, "包含可靠文字层"),
            },
            {"id": "edge-detect-scan", "source": n + "detect", "target": n + "scan_extract", "label": "扫描件", "priority": 20, "is_default": True},
            {"id": "edge-pdf-confirm", "source": n + "pdf_extract", "target": n + "confirm_fields"},
            {"id": "edge-scan-confirm", "source": n + "scan_extract", "target": n + "confirm_fields"},
            {"id": "edge-confirm-claim", "source": n + "confirm_fields", "target": n + "claim"},
            {"id": "edge-claim-submit", "source": n + "claim", "target": n + "submit"},
            {"id": "edge-submit-manager", "source": n + "submit", "target": n + "manager"},
            {"id": "edge-manager-finance", "source": n + "manager", "target": n + "finance", "condition": "approved", "label": "通过"},
            {"id": "edge-manager-supplement", "source": n + "manager", "target": n + "supplement", "condition": "returned", "label": "退回"},
            {"id": "edge-supplement-submit", "source": n + "supplement", "target": n + "submit", "condition": "resubmitted", "label": "重提"},
            {"id": "edge-finance-post", "source": n + "finance", "target": n + "post", "condition": "approved", "label": "通过"},
            {"id": "edge-finance-supplement", "source": n + "finance", "target": n + "supplement", "condition": "returned", "label": "退回"},
            {"id": "edge-post-pay", "source": n + "post", "target": n + "pay"},
        ],
        "form": {
            "object": "finance.expense_claim",
            "sections": [
                {"title": "报销信息", "fields": ["subject", "department", "cost_center", "purpose"]},
                {"title": "发票信息", "fields": ["invoice_number", "invoice_date", "seller_name", "total_amount"]},
            ],
        },
        "mappings": [
            {"source": "票据识别.output.fields", "target": "发票草稿.*", "mode": "待人工核对"},
            {"source": "发票.total_amount", "target": "报销单.amount", "mode": "确认后写入"},
            {"source": "报销单.amount", "target": "过账批次.total_amount", "mode": "财务确认"},
            {"source": "应付.balance_amount", "target": "付款流水.amount", "mode": "付款确认"},
        ],
    }


def ensure_process_definition():
    registered = register_domain_process_definition(DEFINITION_ID, "费用报销与付款", "finance.expense_claim", expense_graph())
    if registered["created"]:
        publish_definition(DEFINITION_ID, registered["draft_revision"])
        return
    definition = get_design_context(DEFINITION_ID)["definition"]
    old_graph = definition["graph"]
    old_ids = {node.get("id") for node in old_graph.get("nodes", [])}
    seed_v1 = "com.shangshu.finance.node.claim" not in old_ids and int(definition.get("draft_revision") or 0) == 1
    migrated = expense_graph() if seed_v1 else _migrate_graph_v2(old_graph)
    if migrated != old_graph:
        saved = save_process_draft(DEFINITION_ID, migrated, definition["draft_revision"])
        if seed_v1:
            publish_definition(DEFINITION_ID, saved["draft_revision"])


def _migrate_graph_v2(graph):
    """只补齐可编辑协议和已知裸条件；不重建节点、不覆盖用户已修改配置。"""
    value = json.loads(json.dumps(graph or {}))
    value.setdefault("schema_version", 2)
    value.setdefault("definition_id", DEFINITION_ID)
    value.setdefault("business_object", {"id": "finance.expense_claim", "title": "费用报销单"})
    value.setdefault("data_sources", _data_sources())
    seen = set()
    for index, edge in enumerate(value.get("edges") or []):
        base = edge.get("id") or f"edge-{str(edge.get('source') or '').split('.')[-1]}-{str(edge.get('target') or '').split('.')[-1]}"
        edge_id = base
        suffix = 2
        while edge_id in seen:
            edge_id = f"{base}-{suffix}"
            suffix += 1
        edge["id"] = edge_id
        seen.add(edge_id)
        if edge.get("condition") == "file.has_text_layer == true":
            edge["condition"] = _clause("document_extraction", "has_text_layer", "是否包含可靠文字层", "boolean", "eq", True, "包含可靠文字层")
            edge.setdefault("label", "有文字层")
            edge.setdefault("priority", 10)
        elif edge.get("condition") == "file.has_text_layer == false":
            edge.pop("condition", None)
            edge.setdefault("label", "扫描件")
            edge["is_default"] = True
            edge.setdefault("priority", 20)
    return value


def ensure_workflow():
    states = (
        ("SS Draft", "0", "Desk User"),
        ("SS Pending Manager Approval", "0", "Expense Approver"),
        ("SS Needs Supplement", "0", "Desk User"),
        ("SS Pending Finance Review", "0", "Finance Approver"),
        ("SS Pending Posting", "0", "Finance Approver"),
        ("SS Pending Payment", "0", "Finance Approver"),
        ("SS Completed", "1", "System Manager"),
    )
    transitions = (
        ("SS Draft", "Submit Claim", "SS Pending Manager Approval", "Desk User", 1),
        ("SS Pending Manager Approval", "Manager Approve", "SS Pending Finance Review", "Expense Approver", 0),
        ("SS Pending Manager Approval", "Return for Supplement", "SS Needs Supplement", "Expense Approver", 0),
        ("SS Needs Supplement", "Resubmit", "SS Pending Manager Approval", "Desk User", 1),
        ("SS Pending Finance Review", "Finance Approve", "SS Pending Posting", "Finance Approver", 0),
        ("SS Pending Finance Review", "Finance Return", "SS Needs Supplement", "Finance Approver", 0),
        ("SS Pending Posting", "Post Expense", "SS Pending Payment", "Finance Approver", 0),
        ("SS Pending Payment", "Record Payment", "SS Completed", "Finance Approver", 0),
    )
    for state, _doc_status, _role in states:
        if not frappe.db.exists("Workflow State", state):
            frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": state, "style": "Primary"}).insert(ignore_permissions=True)
    for _state, action, _next_state, _role, _self in transitions:
        if not frappe.db.exists("Workflow Action Master", action):
            frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": action}).insert(ignore_permissions=True)
    if frappe.db.exists("Workflow", WORKFLOW_NAME):
        return
    workflow = frappe.get_doc(
        {
            "doctype": "Workflow",
            "workflow_name": WORKFLOW_NAME,
            "document_type": "Shangshu Expense Claim",
            "is_active": 1,
            "send_email_alert": 0,
            "workflow_state_field": "workflow_state",
        }
    )
    for state, doc_status, allow_edit in states:
        workflow.append("states", {"state": state, "doc_status": doc_status, "allow_edit": allow_edit})
    for state, action, next_state, allowed, allow_self in transitions:
        workflow.append("transitions", {"state": state, "action": action, "next_state": next_state, "allowed": allowed, "allow_self_approval": allow_self})
    workflow.insert(ignore_permissions=True)
