from decimal import Decimal

import frappe


DOMAIN_ID = "com.shangshu.finance"


OBJECTS = [
    {
        "id": "finance.invoice",
        "version": "1.0.0",
        "schema_version": 1,
        "name": "发票",
        "doctype": "Shangshu Finance Invoice",
        "record_actions": [{"action_id":"finance.expense.create_draft", "bindings":{"invoice":"name"}, "when":{"status":"Confirmed"}}],
        "operations": ["read"],
        "fields": [
            {"id": "name", "label": "记录编号", "type": "string"},
            {"id": "record_version", "label": "记录版本", "type": "integer"},
            {"id": "invoice_number", "label": "发票号码", "type": "string"},
            {"id": "invoice_date", "label": "开票日期", "type": "date"},
            {"id": "invoice_type", "label": "发票类型", "type": "string"},
            {"id": "direction", "label": "方向", "type": "enum"},
            {"id": "seller_name", "label": "开票方", "type": "string"},
            {"id": "seller_tax_id", "label": "开票方税号", "type": "string"},
            {"id": "buyer_name", "label": "购买方", "type": "string"},
            {"id": "total_amount", "label": "价税合计", "type": "money"},
            {"id": "tax_amount", "label": "税额", "type": "money"},
            {"id": "status", "label": "状态", "type": "enum"},
            {"id": "modified", "label": "更新时间", "type": "datetime"},
        ],
        "filter_fields": ["invoice_number", "direction", "status"],
    },
    {
        "id": "finance.expense_claim",
        "version": "1.0.0",
        "schema_version": 1,
        "name": "费用报销",
        "doctype": "Shangshu Expense Claim",
        "operations": ["read"],
        "fields": [
            {"id": "name", "label": "报销单号", "type": "string"},
            {"id": "subject", "label": "主题", "type": "string"},
            {"id": "applicant", "label": "申请人", "type": "identity"},
            {"id": "department", "label": "部门", "type": "string"},
            {"id": "amount", "label": "金额", "type": "money"},
            {"id": "workflow_state", "label": "当前状态", "type": "enum"},
            {"id": "modified", "label": "更新时间", "type": "datetime"},
        ],
        "filter_fields": ["subject", "workflow_state", "applicant"],
    },
    {
        "id": "finance.payable",
        "version": "1.0.0",
        "schema_version": 1,
        "name": "应付",
        "doctype": "Shangshu Payable",
        "record_actions": [{"action_id":"finance.payable.pay", "bindings":{"payable":"name", "expected_version":"record_version"}, "when":{"status":"Open"}}],
        "operations": ["read"],
        "fields": [
            {"id": "name", "label": "应付编号", "type": "string"},
            {"id": "recipient", "label": "收款人", "type": "identity"},
            {"id": "amount", "label": "应付金额", "type": "money"},
            {"id": "paid_amount", "label": "已付金额", "type": "money"},
            {"id": "balance_amount", "label": "待付余额", "type": "money"},
            {"id": "status", "label": "状态", "type": "enum"},
            {"id": "modified", "label": "更新时间", "type": "datetime"},
        ],
        "filter_fields": ["status", "recipient"],
    },
    {
        "id": "finance.ledger_entry",
        "version": "1.0.0",
        "schema_version": 1,
        "name": "会计分录",
        "doctype": "Shangshu Ledger Entry",
        "operations": ["read"],
        "fields": [
            {"id": "name", "label": "分录编号", "type": "string"},
            {"id": "business_date", "label": "业务日期", "type": "date"},
            {"id": "direction", "label": "借贷方向", "type": "enum"},
            {"id": "account", "label": "科目", "type": "string"},
            {"id": "amount", "label": "金额", "type": "money"},
            {"id": "memo", "label": "摘要", "type": "string"},
            {"id": "modified", "label": "更新时间", "type": "datetime"},
        ],
        "filter_fields": ["account", "business_date"],
    },
    {
        "id": "finance.cash_movement",
        "version": "1.0.0",
        "schema_version": 1,
        "name": "收付款流水",
        "doctype": "Shangshu Cash Movement",
        "operations": ["read"],
        "fields": [
            {"id": "name", "label": "流水编号", "type": "string"},
            {"id": "business_date", "label": "业务日期", "type": "date"},
            {"id": "movement_type", "label": "类型", "type": "enum"},
            {"id": "recipient", "label": "收款人", "type": "identity"},
            {"id": "amount_cents", "label": "金额（分）", "type": "integer"},
            {"id": "account", "label": "账户", "type": "string"},
            {"id": "memo", "label": "摘要", "type": "string"},
            {"id": "modified", "label": "更新时间", "type": "datetime"},
        ],
        "filter_fields": ["recipient", "business_date", "movement_type"],
    },
]


DATASETS = [
    {
        "id": "finance.invoice",
        "name": "发票",
        "description": "进项与出项票据的识别、核对和入库记录",
        "icon": "发",
        "query": "shangshu_finance.domain.query_dataset",
        "columns": [
            {"field": "invoice_number", "label": "发票号码"},
            {"field": "invoice_type", "label": "发票类型"},
            {"field": "direction", "label": "方向", "value_labels": {"Input": "进项", "Output": "出项"}},
            {"field": "seller_name", "label": "开票方"},
            {"field": "buyer_name", "label": "购买方"},
            {"field": "total_amount", "label": "价税合计", "format": "money"},
            {"field": "status", "label": "状态", "value_labels": {"Confirmed": "已核对", "Draft": "待核对"}},
        ],
        "filters": [
            {"field": "invoice_number", "label": "发票号码", "type": "text"},
            {"field": "direction", "label": "发票方向", "type": "select", "options": [{"value": "", "label": "全部"}, {"value": "Input", "label": "进项"}, {"value": "Output", "label": "出项"}]},
            {"field": "status", "label": "状态", "type": "select", "options": [{"value": "", "label": "全部"}, {"value": "Confirmed", "label": "已核对"}, {"value": "Draft", "label": "待核对"}]},
        ],
    },
    {
        "id": "finance.expense_claim",
        "name": "费用报销",
        "description": "员工费用申请、审批、过账和付款状态",
        "icon": "报",
        "query": "shangshu_finance.domain.query_dataset",
        "columns": [
            {"field": "subject", "label": "主题"},
            {"field": "applicant", "label": "申请人"},
            {"field": "department", "label": "部门"},
            {"field": "amount", "label": "金额", "format": "money"},
            {"field": "workflow_state", "label": "当前状态", "value_labels": {"SS Draft": "草稿", "SS Pending Manager Approval": "待经理审批", "SS Needs Supplement": "待补充材料", "SS Pending Finance Review": "待财务复核", "SS Pending Posting": "待过账", "SS Pending Payment": "待付款", "SS Completed": "已完成"}},
            {"field": "modified", "label": "更新时间", "format": "datetime"},
        ],
        "filters": [
            {"field": "subject", "label": "主题", "type": "text"},
            {"field": "workflow_state", "label": "状态", "type": "text"},
        ],
    },
    {
        "id": "finance.payable",
        "name": "应付",
        "description": "已过账报销形成的待付款与结清记录",
        "icon": "付",
        "query": "shangshu_finance.domain.query_dataset",
        "columns": [
            {"field": "recipient", "label": "收款人"},
            {"field": "amount", "label": "应付金额", "format": "money"},
            {"field": "paid_amount", "label": "已付金额", "format": "money"},
            {"field": "balance_amount", "label": "待付余额", "format": "money"},
            {"field": "status", "label": "状态", "value_labels": {"Open": "待付款", "Paid": "已结清"}},
        ],
        "filters": [{"field": "status", "label": "状态", "type": "select", "options": [{"value": "", "label": "全部"}, {"value": "Open", "label": "待付款"}, {"value": "Paid", "label": "已结清"}]}],
    },
    {
        "id": "finance.ledger_entry",
        "name": "会计分录",
        "description": "不可变的借贷分录记录",
        "icon": "账",
        "query": "shangshu_finance.domain.query_dataset",
        "columns": [
            {"field": "business_date", "label": "业务日期", "format": "date"},
            {"field": "direction", "label": "借贷方向", "value_labels": {"Debit": "借", "Credit": "贷"}},
            {"field": "account", "label": "科目"},
            {"field": "amount", "label": "金额", "format": "money"},
            {"field": "memo", "label": "摘要"},
        ],
        "filters": [{"field": "account", "label": "科目", "type": "text"}],
    },
    {
        "id": "finance.cash_movement",
        "name": "收付款流水",
        "description": "实际发生的收付款与银行账户流水",
        "icon": "收",
        "query": "shangshu_finance.domain.query_dataset",
        "columns": [
            {"field": "business_date", "label": "业务日期", "format": "date"},
            {"field": "movement_type", "label": "类型", "value_labels": {"Payment": "付款", "Receipt": "收款", "Reversal": "冲回"}},
            {"field": "recipient", "label": "收款人"},
            {"field": "amount", "label": "金额", "format": "money"},
            {"field": "account", "label": "账户"},
            {"field": "memo", "label": "摘要"},
        ],
        "filters": [{"field": "recipient", "label": "收款人", "type": "text"}],
    },
]


def get_contribution():
    actions = [
        "document.pdf_text_extract", "document.ocr_extract", "document.vision_extract",
        "finance.invoice.create_draft", "finance.invoice.confirm_fields", "finance.expense.create_draft",
        "finance.expense.submit", "finance.expense.manager_decide", "finance.expense.finance_review",
        "finance.posting.post_expense", "finance.payable.pay", "finance.posting.reverse", "finance.cash.reverse",
    ]
    value = {
        "id": DOMAIN_ID,
        "name": "财务",
        "owner_app": "shangshu_finance",
        # 2026-10-22（PKG-036-T02）：域版本 0.3.1 → **0.3.2** ——
        # 收掉文件中心契约那处限期豁免：发票原件不再自己 `save_file`，
        # 改走文件域的公开动作 `files.upload`（字节由文件域放）⇒
        # **跨域调用 ⇒ 必须声明对文件域的依赖**（内核 `assert_declared_call` 会拒没声明的调用）。
        "version": "0.3.2",
        "platform_api": ">=1.0 <2.0",
        "workbench_api": "1.0.0",
        "default_enabled": True,
        "health": {"status": "healthy", "message": "票据、报销、过账和付款服务已注册"},
        "applications": [
            {
                "id": "com.shangshu.finance.expense_management",
                "title": "费用管理",
                "description": "从票据识别、费用报销到过账付款，在一个应用内完成。",
                "icon": "费",
                "roles": ["Desk User"],
                "home": "generated.overview",
                "primary_action": {
                    "type": "process",
                    "label": "申请报销",
                    "target": "com.shangshu.finance.expense_approval",
                },
                "journey": "上传并核对票据 → 填写报销 → 经理审批 → 财务复核 → 过账付款",
                "help": "员工从“申请报销”开始；审批人从待办进入。票据上传只是报销表单的一部分。",
            }
        ],
        "navigation": [
            {"id": "finance", "label": "财务", "route": "objects", "roles": ["Desk User"]},
        ],
        # **本域在文件中心的那块路径**（用户 2026-10-22 15:52 的口径）：
        # 各域**自己声明**；文件中心**照办**（幂等建目录），文件中心不许硬编码任何域 id。
        "file_paths": [{"path": "/com.shangshu.finance/发票原件", "note": "财务域上传的发票原件。"}],
        "workbench": [
            {"id": "finance.pending_claims", "title": "待处理报销", "route": "flowdesign", "kind": "metric"},
            {"id": "finance.open_payables", "title": "待付款", "route": "objects", "dataset": "finance.payable", "kind": "metric"},
            {"id": "finance.invoices", "title": "已入库发票", "route": "objects", "dataset": "finance.invoice", "kind": "metric"},
        ],
        "workbench_provider": "shangshu_finance.domain.workbench_cards",
        "objects": OBJECTS,
        "datasets": [{**item, "object_id": item["id"]} for item in DATASETS],
        "processes": [
            {"id": "com.shangshu.finance.expense_approval", "title": "费用报销与付款", "allow_disabled_continuation": True, "launch_adapter": "finance.expense", "instance_adapter": "finance.expense", "journey": "上传票据 → 核对 → 经理审批 → 财务复核 → 过账 → 付款"},
        ],
        "actions": [
            {
                "id": action_id,
                **(
                    {"handler": "shangshu_finance.public_handlers.execute_action"}
                    if action_id in {
                        "finance.invoice.confirm_fields", "finance.expense.create_draft",
                        "finance.expense.submit", "finance.expense.manager_decide",
                        "finance.expense.finance_review", "finance.posting.post_expense",
                        "finance.payable.pay",
                    }
                    else {}
                ),
            }
            for action_id in actions
        ],
        "tools": [
            {"id": item}
            for item in (
                "document.pdf_text_extract", "document.ocr_extract", "document.vision_extract",
                "finance.invoice.confirm_fields", "finance.expense.create_draft", "finance.expense.submit",
                "finance.expense.manager_decide", "finance.expense.finance_review",
                "finance.posting.post_expense", "finance.payable.pay",
            )
        ],
        "services": [
            {"id": "finance.claim.list", "handler": "shangshu_finance.public_handlers.invoke_service", "roles": ["Desk User"],
             "effect":"read", "purpose":"directory", "input_schema":{"type":"object","properties":{
                 "view":{"type":"string","enum":["started","pending","completed","launch","copied"]}},"additionalProperties":False}},
            {"id": "finance.claim.get", "handler": "shangshu_finance.public_handlers.invoke_service", "roles": ["Desk User"],
             "effect":"read", "purpose":"detail", "input_schema":{"type":"object","properties":{
                 "claim":{"type":"string","minLength":1,"maxLength":140}},"required":["claim"],"additionalProperties":False}},
            {"id": "finance.claim.reconcile", "handler": "shangshu_finance.public_handlers.invoke_service", "roles": ["Finance Approver"],
             "effect":"read", "purpose":"detail", "input_schema":{"type":"object","properties":{
                 "claim":{"type":"string","minLength":1,"maxLength":140}},"required":["claim"],"additionalProperties":False}},
        ],
        "roles": [
            {"role": "Expense Approver", "label": "费用审批人", "capabilities": ["expense_approve"], "assignable": True},
            {"role": "Finance Approver", "label": "财务复核人", "capabilities": ["finance_review"]},
            {"role": "Cashier", "label": "出纳", "capabilities": ["finance_payment"]},
        ],
        "pages": [{"id": "finance.settings", "label": "财务设置", "roles": ["System Manager"]}],
    }
    # 原费用应用保持显式旧范围，外采拨款不混入报销页面。
    value["applications"][0].update(**{section + "_ids": [row["id"] for row in value[section]]
                                      for section in ("objects", "datasets", "actions", "tools", "processes")})
    from shangshu_finance.funding import contributions
    value['lifecycle_service'] = 'finance.funding.lifecycle'
    for section, entries in contributions().items():
        value[section] = [*value[section], *entries]
    return value


def _visible(doctype, fields, filters=None, limit_start=0, limit_page_length=30):
    return frappe.get_list(
        doctype,
        fields=fields,
        filters=filters or {},
        order_by="modified desc",
        limit_start=limit_start,
        limit_page_length=limit_page_length,
    )


def workbench_cards():
    # 无权读取的指标不查询、不返回假零；有权查询的故障继续由统一 API 报错。
    readable = {
        card: frappe.has_permission(doctype, ptype="read")
        for card, doctype in (
            ("finance.pending_claims", "Shangshu Expense Claim"),
            ("finance.open_payables", "Shangshu Payable"),
            ("finance.invoices", "Shangshu Finance Invoice"),
        )
    }
    claims = _visible("Shangshu Expense Claim", ["name", "workflow_state"], limit_page_length=500) if readable["finance.pending_claims"] else []
    pending_states = {"SS Pending Manager Approval", "SS Pending Finance Review", "SS Pending Posting", "SS Pending Payment"}
    payables = _visible("Shangshu Payable", ["name", "status", "balance_amount"], limit_page_length=500) if readable["finance.open_payables"] else []
    invoices = _visible("Shangshu Finance Invoice", ["name", "status", "total_amount"], limit_page_length=500) if readable["finance.invoices"] else []
    cards = [
        {"id": "finance.pending_claims", "title": "待处理报销", "value": len([row for row in claims if row.workflow_state in pending_states]), "unit": "笔", "description": "需要当前角色审批、过账或付款", "route": "flowdesign", "domain_id": DOMAIN_ID},
        {"id": "finance.open_payables", "title": "待付款", "value": str(sum((Decimal(str(row.balance_amount or 0)) for row in payables if row.status == "Open"), Decimal("0"))), "unit": "元", "description": "已过账但尚未结清", "route": "objects", "dataset": "finance.payable", "domain_id": DOMAIN_ID},
        {"id": "finance.invoices", "title": "已入库发票", "value": len([row for row in invoices if row.status == "Confirmed"]), "unit": "张", "description": "已核对并确认字段", "route": "objects", "dataset": "finance.invoice", "domain_id": DOMAIN_ID},
    ]
    return [card for card in cards if readable[card["id"]]]


DATASET_SPECS = {
    "finance.invoice": ("Shangshu Finance Invoice", ["name", "invoice_number", "invoice_type", "direction", "seller_name", "buyer_name", "total_amount", "status", "modified"]),
    "finance.expense_claim": ("Shangshu Expense Claim", ["name", "subject", "applicant", "department", "amount", "workflow_state", "modified"]),
    "finance.payable": ("Shangshu Payable", ["name", "recipient", "amount", "paid_amount", "balance_amount", "status", "modified"]),
    "finance.ledger_entry": ("Shangshu Ledger Entry", ["name", "business_date", "direction", "account", "amount", "memo", "modified"]),
    "finance.cash_movement": ("Shangshu Cash Movement", ["name", "business_date", "movement_type", "recipient", "amount_cents", "account", "memo", "modified"]),
}


def query_dataset(dataset_id, filters=None, page=1, page_length=30):
    if dataset_id not in DATASET_SPECS:
        frappe.throw("财务数据集不存在", frappe.DoesNotExistError)
    doctype, fields = DATASET_SPECS[dataset_id]
    raw_filters = filters if isinstance(filters, dict) else frappe.parse_json(filters or "{}")
    allowed = {item["field"] for item in next(row for row in DATASETS if row["id"] == dataset_id).get("filters") or []}
    query_filters = {}
    for key, value in (raw_filters or {}).items():
        if key not in allowed or value in (None, ""):
            continue
        query_filters[key] = ["like", f"%{value}%"] if isinstance(value, str) and key not in {"direction", "status"} else value
    start = max(int(page) - 1, 0) * int(page_length)
    rows = _visible(doctype, fields, query_filters, start, page_length)
    if dataset_id == "finance.cash_movement":
        for row in rows:
            row["amount"] = float(Decimal(str(row.pop("amount_cents", 0))) / Decimal("100"))
    total = frappe.get_list(doctype, filters=query_filters, fields=["count(name) as count"])[0].count
    return {"dataset_id": dataset_id, "rows": rows, "total": total, "page": int(page), "page_length": int(page_length)}
