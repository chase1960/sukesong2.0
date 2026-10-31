import json

import frappe
from frappe import _
from frappe.model.workflow import apply_workflow, get_transitions
from frappe.utils import now_datetime, nowdate

FINAL_STATES = ("Approved", "Rejected")
WORKFLOW_NAME = "费用报销审批"
ACTION_LABELS = {
    "Submit": "提交审批",
    "Manager Approve": "经理通过",
    "Finance Approve": "财务通过",
    "Reject": "退回",
}

JOURNEY = [
    {"state": "Draft", "label": "填写并提交", "owner": "发起人"},
    {"state": "Pending Manager Approval", "label": "经理审批", "owner": "费用审批人"},
    {"state": "Pending Finance Review", "label": "财务复核", "owner": "财务审批人"},
    {"state": "Approved", "label": "流程完成", "owner": "系统"},
]


def _expense_row(doc):
    return {
        "name": doc.name,
        "subject": doc.subject,
        "amount": doc.amount,
        "expense_date": doc.expense_date,
        "applicant": doc.applicant,
        "applicant_name": frappe.utils.get_fullname(doc.applicant),
        "department": doc.department,
        "workflow_state": doc.workflow_state,
        "owner": doc.owner,
        "modified": doc.modified,
    }


def user_participated_in(doc, user):
    """发起人、申请人、被抄送人或曾办理过该单的用户视为参与过。"""
    if user in (doc.owner, doc.applicant):
        return True
    copied = frappe.get_all(
        "Process Copy",
        filters={"reference_doctype": doc.doctype, "reference_name": doc.name, "user": user},
        limit=1,
    )
    if copied:
        return True
    acted = frappe.get_all(
        "Workflow Action",
        filters={
            "reference_doctype": doc.doctype,
            "reference_name": doc.name,
            "completed_by": user,
            "status": "Completed",
        },
        limit=1,
    )
    return bool(acted)


def _list_expenses(filters=None, limit=50):
    rows = frappe.get_all(
        "Expense Request",
        filters=filters or {},
        fields=["name"],
        order_by="modified desc",
        limit_page_length=limit,
    )
    result = []
    for row in rows:
        # 记录级权限：逐条校验，避免列表接口泄露他人单据。
        if not frappe.has_permission("Expense Request", "read", doc=row.name):
            continue
        result.append(_expense_row(frappe.get_doc("Expense Request", row.name)))
    return result


def _active_workflow():
    name = frappe.db.get_value(
        "Workflow", {"name": WORKFLOW_NAME, "document_type": "Expense Request", "is_active": 1}, "name"
    )
    return frappe.get_doc("Workflow", name) if name else None


@frappe.whitelist()
def get_center():
    user = frappe.session.user
    workflow = _active_workflow()
    open_actions = frappe.get_all(
        "Workflow Action",
        filters={"status": "Open", "reference_doctype": "Expense Request"},
        fields=["reference_name"],
        order_by="modified desc",
        limit_page_length=100,
    )
    names = list(dict.fromkeys(row.reference_name for row in open_actions))
    pending = []
    if workflow:
        for name in names:
            if frappe.has_permission("Expense Request", "read", doc=name):
                doc = frappe.get_doc("Expense Request", name)
                if get_transitions(doc, workflow):
                    pending.append(_expense_row(doc))

    copies = frappe.get_all(
        "Process Copy",
        filters={"user": user},
        fields=["reference_name"],
        order_by="creation desc",
        limit_page_length=50,
    )
    copied = []
    for copy in copies:
        if frappe.db.exists("Expense Request", copy.reference_name) and frappe.has_permission(
            "Expense Request", "read", doc=copy.reference_name
        ):
            copied.append(_expense_row(frappe.get_doc("Expense Request", copy.reference_name)))

    completed = []
    for row in _list_expenses({"workflow_state": ["in", list(FINAL_STATES)]}):
        doc = frappe.get_doc("Expense Request", row["name"])
        if user_participated_in(doc, user):
            completed.append(row)

    launch = []
    if workflow and frappe.has_permission("Expense Request", "create"):
        launch.append(
            {
                "doctype": "Expense Request",
                "title": "费用报销",
                "description": "提交费用与票据，自动经过经理和财务审核。",
                "icon": "expenses",
                "journey": "填写报销单 → 经理审批 → 财务复核 → 完成",
                "materials": ["报销事项与用途", "金额与费用日期", "票据或附件（可后补）"],
                "estimated_time": "约 2 分钟填写",
            }
        )

    return {
        "counts": {
            "launch": len(launch),
            "pending": len(pending),
            "started": frappe.db.count("Expense Request", {"owner": user}),
            "completed": len(completed),
            "copied": len(copied),
        },
        "launch": launch,
        "pending": pending,
        "started": _list_expenses({"owner": user}),
        "completed": completed,
        "copied": copied,
    }


@frappe.whitelist()
def get_workbench():
    """面向办事人的工作台摘要；所有计数均复用流程中心的记录级权限结果。"""
    center = get_center()
    return {
        "enterprise": {"name": "尚书演示企业", "mode": "single_tenant_poc"},
        "counts": center["counts"],
        "recent": (center["pending"] + center["started"] + center["completed"])[:6],
        "installed_apps": ["费用报销", "业务数据"],
        "extension_slots": ["财会系统", "文件管理", "客户管理"],
    }


@frappe.whitelist()
def get_data_center(status=None, search=None, limit=100):
    """业务数据页的最小查询接口。

    当前只注册真实可用的 Expense Request 数据集；先完成统一目录、字段元数据和
    记录级权限边界，后续插件通过数据集注册协议扩充，不在页面硬编码跨插件表。
    """
    limit = min(max(int(limit or 100), 1), 200)
    allowed_states = ["Draft", "Pending Manager Approval", "Pending Finance Review", "Approved", "Rejected"]
    status = (status or "").strip()
    if status and status not in set(allowed_states):
        frappe.throw(_("不支持的数据状态"), frappe.ValidationError)
    rows = _list_expenses({"workflow_state": status} if status else {}, limit=limit)
    query = (search or "").strip().lower()
    if query:
        rows = [
            row for row in rows
            if query in " ".join(
                str(row.get(key) or "").lower()
                for key in ("name", "subject", "applicant", "applicant_name", "department")
            )
        ]
    counts = {state: 0 for state in allowed_states}
    # 计数同样只使用 has_permission 过滤后的记录，避免暴露其他用户数据量。
    for row in _list_expenses(limit=200):
        if row["workflow_state"] in counts:
            counts[row["workflow_state"]] += 1
    meta = frappe.get_meta("Expense Request")
    fields = [
        {
            "fieldname": df.fieldname,
            "label": df.label,
            "fieldtype": df.fieldtype,
            "required": bool(df.reqd),
        }
        for df in meta.fields
        if df.fieldname in {"subject", "amount", "expense_date", "applicant", "department", "cost_center", "purpose", "workflow_state"}
    ]
    return {
        "dataset": {"id": "shangshu_flow.expense_request", "title": "费用报销单", "source": "尚书流程"},
        "rows": rows,
        "total": sum(counts.values()),
        "counts": counts,
        "fields": fields,
    }


@frappe.whitelist(methods=["POST"])
def create_expense_request(subject, amount, expense_date=None, department=None, cost_center=None, purpose=None):
    if not _active_workflow():
        frappe.throw(_("费用报销流程当前未发布，暂时不能发起"), frappe.ValidationError)
    doc = frappe.get_doc(
        {
            "doctype": "Expense Request",
            "subject": subject,
            "amount": amount,
            "expense_date": expense_date or nowdate(),
            "department": department,
            "cost_center": cost_center,
            "applicant": frappe.session.user,
            "purpose": purpose,
        }
    ).insert()
    return get_instance(doc.name)


def _attachments(name):
    return frappe.get_all(
        "File",
        filters={"attached_to_doctype": "Expense Request", "attached_to_name": name},
        fields=["name", "file_name", "file_url", "file_size", "is_private", "owner", "creation"],
        order_by="creation asc",
        limit_page_length=50,
    )


def _timeline(name, doc):
    comments = frappe.get_all(
        "Comment",
        filters={
            "reference_doctype": "Expense Request",
            "reference_name": name,
            "comment_type": ["in", ["Workflow", "Comment"]],
        },
        fields=["content", "comment_by", "creation", "comment_type"],
        order_by="creation asc",
        limit_page_length=200,
    )
    timeline = [{"type": "created", "label": "申请已创建", "by": doc.owner, "at": doc.creation}]
    for row in comments:
        timeline.append(
            {
                "type": "comment" if row.comment_type == "Comment" else "workflow",
                "label": row.content,
                "by": row.comment_by,
                "at": row.creation,
            }
        )
    return timeline


@frappe.whitelist()
def get_instance(name):
    doc = frappe.get_doc("Expense Request", name)
    doc.check_permission("read")
    transitions = get_transitions(doc)
    workflow = frappe.get_doc("Workflow", WORKFLOW_NAME)
    current = next((row for row in workflow.states if row.state == doc.workflow_state), None)
    journey = [dict(item) for item in JOURNEY]
    current_index = next((index for index, item in enumerate(journey) if item["state"] == doc.workflow_state), 0)
    if doc.workflow_state == "Rejected":
        journey.insert(1, {"state": "Rejected", "label": "补充后重提", "owner": "发起人"})
        current_index = 1
    for index, item in enumerate(journey):
        item["status"] = "done" if index < current_index else "current" if index == current_index else "next"
    next_hint = {
        "Draft": "检查必填信息后提交，单据将进入经理审批。",
        "Pending Manager Approval": "等待费用审批人通过或退回补充材料。",
        "Pending Finance Review": "经理已通过，等待财务核验金额与票据。",
        "Approved": "流程已结束，可在数据页查询和留档。",
        "Rejected": "根据退回意见补充材料，然后重新提交。",
    }.get(doc.workflow_state, "按当前节点要求继续办理。")
    return {
        "doc": _expense_row(doc)
        | {
            "purpose": doc.purpose,
            "cost_center": doc.cost_center,
            "ai_summary": doc.ai_summary,
        },
        "actions": [
            {"action": row.action, "label": ACTION_LABELS.get(row.action, row.action)}
            for row in transitions
        ],
        "current_node": {
            "state": doc.workflow_state,
            "role": current.allow_edit if current else None,
            "next_hint": next_hint,
        },
        "journey": journey,
        "attachments": _attachments(name),
        "timeline": _timeline(name, doc),
    }


@frappe.whitelist(methods=["POST"])
def apply_action(name, action, note=None):
    doc = frappe.get_doc("Expense Request", name)
    doc.check_permission("read")
    # 显式复核当前用户在此状态下可执行的转换，防止绕过流程状态。
    allowed = {row.action for row in get_transitions(doc)}
    if action not in allowed:
        frappe.throw(_("当前流程状态不允许执行该动作"), frappe.PermissionError)
    result = apply_workflow(doc, action)
    if note and note.strip():
        result.add_comment("Comment", text=note.strip())
    frappe.db.commit()
    return get_instance(result.name)


def _publish_checks(workflow):
    meta = frappe.get_meta(workflow.document_type)
    doc_roles = {row.role for row in meta.permissions or []}
    all_roles = set(frappe.get_all("Role", pluck="name"))
    state_names = [row.state for row in workflow.states]
    outgoing = {row.state for row in workflow.transitions}

    checks = []
    checks.append(
        {
            "title": "流程已激活",
            "status": "pass" if workflow.is_active else "fail",
            "detail": "流程当前对业务端可用" if workflow.is_active else "流程未激活，业务端不可发起",
        }
    )
    missing_role = sorted(
        {row.allowed for row in workflow.transitions if row.allowed not in all_roles}
        | {row.allow_edit for row in workflow.states if row.allow_edit not in all_roles}
    )
    checks.append(
        {
            "title": "角色配置完整",
            "status": "fail" if missing_role else "pass",
            "detail": "缺失角色：" + "、".join(missing_role) if missing_role else "转换与节点引用的角色均存在",
        }
    )
    missing_perm = sorted(
        {row.allowed for row in workflow.transitions if row.allowed not in doc_roles}
    )
    checks.append(
        {
            "title": "对象权限覆盖转换角色",
            "status": "fail" if missing_perm else "pass",
            "detail": "未获得对象权限的角色：" + "、".join(missing_perm)
            if missing_perm
            else "所有转换角色在「报销申请」对象上具备读写权限",
        }
    )
    no_exit = [state for state in state_names if state not in FINAL_STATES and state not in outgoing]
    checks.append(
        {
            "title": "路径覆盖（无死路状态）",
            "status": "fail" if no_exit else "pass",
            "detail": "以下状态没有可用出路：" + "、".join(no_exit)
            if no_exit
            else "每个进行中状态都存在后续转换",
        }
    )
    # 从 Draft 出发的可达性检查
    edges = {}
    for row in workflow.transitions:
        edges.setdefault(row.state, set()).add(row.next_state)
    seen, stack = set(), ["Draft"]
    while stack:
        node = stack.pop()
        for nxt in edges.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    unreachable = [state for state in state_names if state != "Draft" and state not in seen]
    checks.append(
        {
            "title": "终态可达",
            "status": "fail" if unreachable else "pass",
            "detail": "从草稿无法到达：" + "、".join(unreachable)
            if unreachable
            else "从「草稿」出发可到达全部状态（含两个终态）",
        }
    )
    self_ok = [row.action for row in workflow.transitions if row.allow_self_approval]
    checks.append(
        {
            "title": "自我审批策略",
            "status": "warn",
            "detail": f"{len(self_ok)} 条转换允许发起人自我审批（PoC 演示配置；上线前建议关闭）",
        }
    )
    has_layout = bool(workflow.workflow_data)
    checks.append(
        {
            "title": "画布布局已保存",
            "status": "pass" if has_layout else "warn",
            "detail": "workflow_data 已存在，Builder 可恢复节点位置"
            if has_layout
            else "尚未保存画布位置，首次保存后恢复",
        }
    )
    return checks


@frappe.whitelist()
def get_studio_context(workflow_name=WORKFLOW_NAME):
    frappe.only_for(("System Manager",))
    workflow = frappe.get_doc("Workflow", workflow_name)
    workflow.check_permission("read")
    meta = frappe.get_meta(workflow.document_type)
    state_names = [row.state for row in workflow.states]
    return {
        "workflow": {
            "name": workflow.name,
            "document_type": workflow.document_type,
            "is_active": workflow.is_active,
            "state_count": len(workflow.states),
            "transition_count": len(workflow.transitions),
            "modified": workflow.modified,
            "modified_by": workflow.modified_by,
            "scenario": "员工提交费用报销，经理审批后由财务复核；退回时发起人补充材料并重提。",
            "journey": "填写报销单 → 经理审批 → 财务复核 → 完成",
        },
        "form_fields": [
            {
                "fieldname": df.fieldname,
                "label": df.label,
                "fieldtype": df.fieldtype,
                "required": bool(df.reqd),
                "read_only": bool(df.read_only),
                "in_list_view": bool(df.in_list_view),
            }
            for df in meta.fields
            if df.fieldtype not in ("Section Break", "Column Break") and not df.hidden
        ],
        "mapping": [
            {
                "source": f"发起表单.{df.label}",
                "target": f"{workflow.document_type}.{df.fieldname}",
                "direction": "write",
            }
            for df in meta.fields
            if df.fieldtype not in ("Section Break", "Column Break", "Button", "Heading")
            and not df.hidden
            and not df.read_only
            and df.fieldname != "workflow_state"
        ]
        + [
            {"source": "流程引擎", "target": f"{workflow.document_type}.workflow_state", "direction": "write"},
            {"source": f"{workflow.document_type}.applicant", "target": "流程记录.发起人", "direction": "read"},
            {"source": "AI 抽取（提案样例）", "target": f"{workflow.document_type}.ai_summary", "direction": "write_after_confirm"},
        ],
        "participants": [
            {
                "stage": row.state,
                "role": row.allow_edit,
                "doc_status": row.doc_status,
                "actions": [
                    {
                        "action": t.action,
                        "label": ACTION_LABELS.get(t.action, t.action),
                        "role": t.allowed,
                        "to": t.next_state,
                        "self_approval": bool(t.allow_self_approval),
                    }
                    for t in workflow.transitions
                    if t.state == row.state
                ],
            }
            for row in workflow.states
        ],
        "checks": _publish_checks(workflow),
        "instances_by_state": {
            state: frappe.db.count("Expense Request", {"workflow_state": state})
            for state in state_names
        },
    }


@frappe.whitelist(methods=["POST"])
def set_workflow_active(workflow_name=WORKFLOW_NAME, active=1):
    """发布 / 停用流程。仅 System Manager；Workflow 自带变更轨迹留痕。"""
    frappe.only_for("System Manager")
    workflow = frappe.get_doc("Workflow", workflow_name)
    if int(active):
        failed = [
            check
            for check in _publish_checks(workflow)
            if check["status"] == "fail" and check["title"] != "流程已激活"
        ]
        if failed:
            detail = "；".join(f'{check["title"]}：{check["detail"]}' for check in failed)
            frappe.throw(_("发布检查未通过：{0}").format(detail), frappe.ValidationError)
    workflow.is_active = 1 if int(active) else 0
    workflow.save(ignore_permissions=True)
    frappe.db.commit()
    return {
        "is_active": workflow.is_active,
        "message": "流程已发布" if workflow.is_active else "流程已停用",
    }


@frappe.whitelist(methods=["POST"])
def propose_workflow_change(workflow_name=WORKFLOW_NAME, instruction=None):
    frappe.only_for("System Manager")
    instruction = (instruction or "").strip()
    if not instruction:
        frappe.throw(_("请输入希望 AI 修改的内容"))
    proposal = {
        "proposal_id": frappe.generate_hash(length=12),
        "workflow_name": workflow_name,
        "instruction": instruction,
        "summary": "建议为大额费用增加总经理复核，并保留退回补充材料路径。",
        "changes": [
            {"operation": "add_state", "state": "Pending Executive Review", "role": "System Manager"},
            {
                "operation": "add_transition",
                "from": "Pending Manager Approval",
                "to": "Pending Executive Review",
                "action": "Escalate",
                "condition": "doc.amount >= 10000",
            },
        ],
        "risk": "中等：将改变金额达到 10,000 元的审批路径。",
        "requires_confirmation": True,
        "disclaimer": "当前提案为受控接口样例，由确定性规则生成，未接入真实模型。",
        "generated_at": str(now_datetime()),
    }
    frappe.cache.set_value(f"shangshu_flow:proposal:{proposal['proposal_id']}", json.dumps(proposal), expires_in_sec=900)
    return proposal


@frappe.whitelist(methods=["POST"])
def apply_workflow_proposal(proposal_id, confirmed=0):
    frappe.only_for("System Manager")
    if not int(confirmed):
        frappe.throw(_("应用 AI 提案前必须明确确认"))
    raw = frappe.cache.get_value(f"shangshu_flow:proposal:{proposal_id}")
    if not raw:
        frappe.throw(_("提案不存在或已过期，请重新生成"))
    proposal = json.loads(raw)
    # 最小验证只证明“提案—确认—受控写入”接口；避免未经完整发布测试直接改变生产流程。
    return {
        "status": "validated",
        "message": "已通过确认接口；最小验证环境不自动发布，需在发布与测试视图完成回归后生效。",
        "proposal": proposal,
    }
