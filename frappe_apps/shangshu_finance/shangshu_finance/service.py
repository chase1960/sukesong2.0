import base64
import hashlib
import json
import os
import time
from decimal import Decimal, ROUND_HALF_UP

import frappe
from frappe.model.workflow import apply_workflow
from frappe.utils import now_datetime, nowdate

from shangshu_core.public_api import (
    list_registered_actions, start_process, begin_node_execution, complete_node_execution,
    get_instance_replay, get_action_receipt, record_action_receipt, list_reference_audits,
    execute_registered_action, invoke_domain_service,
)

from shangshu_finance.install import DEFINITION_ID


MONEY = Decimal("0.01")
ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
# 本域在文件中心的那块路径（用户 2026-10-22 15:52：「每一个新业务域的注册都要注册一个新的路径」）。
# ⚠️ **域自己声明**（manifest 的 `file_paths` ＋ 域贡献里的同一份）⇒ 文件中心照办（幂等建目录）。
FINANCE_FILE_PATH = "/com.shangshu.finance/发票原件"
MAX_FILE_BYTES = 20 * 1024 * 1024
STATE_NODE = {
    "SS Draft": "com.shangshu.finance.node.submit",
    "SS Pending Manager Approval": "com.shangshu.finance.node.manager",
    "SS Needs Supplement": "com.shangshu.finance.node.supplement",
    "SS Pending Finance Review": "com.shangshu.finance.node.finance",
    "SS Pending Posting": "com.shangshu.finance.node.post",
    "SS Pending Payment": "com.shangshu.finance.node.pay",
    "SS Completed": "com.shangshu.finance.node.pay",
}


def _money(value):
    try:
        return Decimal(str(value)).quantize(MONEY, rounding=ROUND_HALF_UP)
    except Exception:
        frappe.throw("金额格式不正确", frappe.ValidationError)


def _json(value, default=None):
    if value in (None, ""):
        return default if default is not None else {}
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        frappe.throw("JSON 格式不正确", frappe.ValidationError)


def _dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _require_roles(*allowed):
    roles = set(frappe.get_roles())
    if not roles.intersection(allowed):
        frappe.throw("当前用户没有执行该动作的业务角色", frappe.PermissionError)


def _require_confirmation(confirmed):
    if str(confirmed).lower() not in ("1", "true", "yes"):
        frappe.throw("该写操作必须经过确认卡确认", frappe.ValidationError)


def _audit(action_id, reference_doctype, reference_name, input_summary, result_summary, idempotency_key, confirmation_text=""):
    return record_action_receipt(action_id, reference_doctype, reference_name, input_summary,
                                 result_summary, idempotency_key, confirmation_text)


def _audit_result(idempotency_key):
    receipt = get_action_receipt(idempotency_key)
    return _json(receipt.result_summary_json, {}) if receipt else None


def create_document(file_name, content_base64, has_text_layer=False, file_sha256=None):
    safe_name = os.path.basename(str(file_name or "")).strip()
    ext = os.path.splitext(safe_name)[1].lower()
    if not safe_name or ext not in ALLOWED_EXTENSIONS:
        frappe.throw("仅支持 PDF、PNG、JPG 票据文件", frappe.ValidationError)
    try:
        content = base64.b64decode(content_base64, validate=True)
    except Exception:
        frappe.throw("文件内容不是有效 Base64", frappe.ValidationError)
    if not content or len(content) > MAX_FILE_BYTES:
        frappe.throw("文件为空或超过 20MB", frappe.ValidationError)
    digest = hashlib.sha256(content).hexdigest()
    if file_sha256 and not hashlib.sha256(content).hexdigest() == str(file_sha256):
        frappe.throw("文件摘要校验失败", frappe.ValidationError)

    # ⚠️ **2026-10-22（PKG-036-T02）：字节**由文件域放** —— 财务域不再自己存原件。
    # 这一笔收的是文件中心契约里那处**限期豁免**（`file-center-v1.json` 的 `exemptions`）：
    # 「发票文件直接 `save_file` 落一份原件」⇒ 绕过了「所有进尚书的文件都进文件中心」。
    # ⇒ 现在走文件域的公开动作 `files.upload`（受管入库 ＋ 归属 ＋ 审计 ＋ 幂等），
    #    财务域只拿**受管文件的引用**，不碰字节。
    receipt = execute_registered_action(
        "files.upload",
        {
            "file_name": safe_name,
            "content_base64": content_base64,
            "file_sha256": digest,
            "directory": FINANCE_FILE_PATH,
            "note": "发票原件（财务域）",
            # 归属＝上传人本人（发票是这个人交上来的）⇒ 文件域按它判授权。
            "attribution": {"level": "personal"},
        },
        confirmed=True,
        idempotency_key="finance:document:%s" % digest,
    )
    managed_file = str((receipt.get("result") or {}).get("file") or "")
    managed_version = str((receipt.get("result") or {}).get("version") or "")
    if not managed_file:
        frappe.throw("原件没能进文件中心，已中止（不入库）", frappe.ValidationError)
    # 受管原件的**固定版本**对应的 File 行（读字节那条路照旧用它，界面不��）。
    history = invoke_domain_service("files.versions", {"file": managed_file})
    frappe_file = str((history.get("current") or {}).get("frappe_file") or "")
    if not frappe_file:
        frappe.throw("读不到受管原件的固定版本，已中止（不入库）", frappe.ValidationError)

    candidates = ["document.pdf_text_extract"] if bool(int(has_text_layer or 0)) else ["document.ocr_extract", "document.vision_extract"]
    extraction = frappe.get_doc(
        {
            "doctype": "Shangshu Document Extraction",
            # 解析记录仍指向**受管文件的固定版本**（`file` 是那个 File 行；另记受管编号与版本）。
            "file": frappe_file,
            "managed_file": managed_file,
            "managed_version": managed_version,
            "file_sha256": digest,
            "has_text_layer": 1 if bool(int(has_text_layer or 0)) else 0,
            "status": "Pending",
            "candidate_tools_json": _dump(candidates),
        }
    ).insert()
    return {"extraction": extraction.name, "file": frappe_file,
            "managed_file": managed_file, "managed_version": managed_version,
            "sha256": digest, "candidate_tools": candidates}


def prepare_extraction(extraction_name, has_text_layer):
    extraction = frappe.get_doc("Shangshu Document Extraction", extraction_name)
    if extraction.owner != frappe.session.user and "System Manager" not in frappe.get_roles():
        frappe.throw("无权配置该提取任务", frappe.PermissionError)
    if extraction.status not in ("Pending", "Running"):
        frappe.throw("该提取任务已结束", frappe.ValidationError)
    fixed = bool(int(has_text_layer or 0))
    candidates = ["document.pdf_text_extract"] if fixed else ["document.ocr_extract", "document.vision_extract"]
    extraction.has_text_layer = 1 if fixed else 0
    extraction.candidate_tools_json = _dump(candidates)
    extraction.status = "Running"
    extraction.save(ignore_permissions=True)
    return {"extraction": extraction.name, "has_text_layer": fixed, "candidate_tools": candidates}


def complete_extraction(extraction_name, selected_tool, output, warnings=None, raw_text=None, reason=None, duration_ms=0, callback_id=None):
    extraction = frappe.get_doc("Shangshu Document Extraction", extraction_name)
    if extraction.owner != frappe.session.user and "Finance Approver" not in frappe.get_roles() and "System Manager" not in frappe.get_roles():
        frappe.throw("无权写入该提取记录", frappe.PermissionError)
    existing_invoice = frappe.db.get_value("Shangshu Finance Invoice", {"extraction": extraction.name}, "name")
    if extraction.status == "Succeeded" and existing_invoice:
        return {"extraction": extraction.name, "invoice": existing_invoice, "invoice_data": frappe.get_doc("Shangshu Finance Invoice", existing_invoice).as_dict(), "status": "Succeeded", "idempotent": True}
    candidates = _json(extraction.candidate_tools_json, [])
    if selected_tool not in candidates:
        extraction.status = "Failed"
        extraction.error_code = "TOOL_NOT_ALLOWED"
        extraction.error_message = "模型或调用方选择了候选集合外工具"
        extraction.save(ignore_permissions=True)
        frappe.throw("提取工具不在当前节点候选集合中", frappe.PermissionError)
    data = _json(output, {})
    fields = data.get("fields") if isinstance(data.get("fields"), dict) else data
    required = ("invoice_number", "invoice_date", "seller_name", "total_amount")
    missing = [key for key in required if fields.get(key) in (None, "")]
    if missing:
        frappe.throw("提取结果缺少字段：" + "、".join(missing), frappe.ValidationError)
    amount = _money(fields["total_amount"])
    duplicate_key = hashlib.sha256(
        "|".join(
            [
                str(fields.get("invoice_number") or "").strip(),
                str(fields.get("seller_tax_id") or "").strip(),
                f"{amount:.2f}",
                str(fields.get("direction") or "Input"),
            ]
        ).encode("utf-8")
    ).hexdigest()
    duplicate = frappe.db.get_value("Shangshu Finance Invoice", {"duplicate_key": duplicate_key}, "name")
    if duplicate:
        frappe.throw(f"发现重复发票：{duplicate}", frappe.DuplicateEntryError)

    extraction.status = "Succeeded"
    extraction.selected_tool = selected_tool
    extraction.selection_reason = reason or ("检测到可靠文字层，使用固定解析工具" if extraction.has_text_layer else "在受控候选工具中选择")
    registered = next((row for row in list_registered_actions() if row["id"] == selected_tool), None)
    if not registered:
        frappe.throw("抽取工具未注册或无权使用", frappe.PermissionError)
    extraction.tool_version = registered["version"]
    extraction.output_json = _dump(data)
    extraction.warnings_json = _dump(_json(warnings, {}))
    extraction.raw_text = str(raw_text or data.get("raw_text") or "")[:20000]
    extraction.duration_ms = int(duration_ms or 0)
    extraction.error_code = None
    extraction.error_message = None
    extraction.save(ignore_permissions=True)

    invoice = frappe.get_doc(
        {
            "doctype": "Shangshu Finance Invoice",
            "status": "Draft",
            "invoice_number": str(fields["invoice_number"]),
            "invoice_type": str(fields.get("invoice_type") or "")[:140],
            "invoice_date": fields["invoice_date"],
            "seller_name": fields["seller_name"],
            "seller_tax_id": fields.get("seller_tax_id"),
            "buyer_name": fields.get("buyer_name"),
            "total_amount": amount,
            "tax_amount": _money(fields.get("tax_amount") or 0),
            "direction": fields.get("direction") or "Input",
            "duplicate_key": duplicate_key,
            "file": extraction.file,
            "extraction": extraction.name,
            "record_version": 1,
        }
    ).insert()
    _audit(
        "finance.invoice.create_draft",
        invoice.doctype,
        invoice.name,
        {"extraction": extraction.name, "selected_tool": selected_tool, "callback_id": callback_id},
        {"invoice": invoice.name, "status": invoice.status},
        f"extract:{callback_id or extraction.name}",
    )
    return {"extraction": extraction.name, "invoice": invoice.name, "invoice_data": invoice.as_dict(), "status": "Succeeded", "idempotent": False}


def fail_extraction(extraction_name, error_code, error_message):
    extraction = frappe.get_doc("Shangshu Document Extraction", extraction_name)
    extraction.status = "Failed"
    extraction.error_code = str(error_code)[:140]
    extraction.error_message = str(error_message)[:1000]
    extraction.save(ignore_permissions=True)
    return {"extraction": extraction.name, "status": extraction.status}


def confirm_invoice(invoice_name, expected_version, fields, confirmed, idempotency_key):
    _require_confirmation(confirmed)
    prior = _audit_result(idempotency_key)
    if prior:
        return prior | {"idempotent": True}
    invoice = frappe.get_doc("Shangshu Finance Invoice", invoice_name)
    if invoice.owner != frappe.session.user and "Finance Approver" not in frappe.get_roles() and "System Manager" not in frappe.get_roles():
        frappe.throw("无权确认该发票", frappe.PermissionError)
    if int(expected_version) != int(invoice.record_version):
        frappe.throw("发票记录已变化，请重新核对", frappe.TimestampMismatchError)
    if invoice.status != "Draft":
        frappe.throw("仅待核对草稿可确认", frappe.ValidationError)
    allowed = {"invoice_number", "invoice_date", "seller_name", "seller_tax_id", "buyer_name", "total_amount", "tax_amount", "direction"}
    requested = _json(fields, {})
    if set(requested) - allowed:
        frappe.throw("包含不允许确认的字段", frappe.ValidationError)
    diff = {}
    for key, value in requested.items():
        normalized = _money(value) if key in ("total_amount", "tax_amount") else value
        old = invoice.get(key)
        if str(old or "") != str(normalized or ""):
            diff[key] = {"from": old, "to": normalized}
            invoice.set(key, normalized)
    invoice.status = "Confirmed"
    invoice.record_version = int(invoice.record_version) + 1
    invoice.confirmed_by = frappe.session.user
    invoice.confirmed_at = now_datetime()
    invoice.confirmation_diff_json = _dump(diff)
    invoice.save()
    result = {"invoice": invoice.name, "status": invoice.status, "record_version": invoice.record_version}
    _audit("finance.invoice.confirm_fields", invoice.doctype, invoice.name, {"expected_version": expected_version, "diff": diff}, result, idempotency_key, "已核对发票字段并确认")
    return result | {"idempotent": False}


def create_claim(invoice_name, subject, department, cost_center, purpose, confirmed, idempotency_key):
    _require_confirmation(confirmed)
    prior = _audit_result(idempotency_key)
    if prior:
        return prior | {"idempotent": True}
    invoice = frappe.get_doc("Shangshu Finance Invoice", invoice_name)
    if invoice.status != "Confirmed":
        frappe.throw("发票必须先完成人工核对", frappe.ValidationError)
    if frappe.db.exists("Shangshu Expense Claim", {"invoice": invoice.name}):
        frappe.throw("该发票已经绑定报销单", frappe.DuplicateEntryError)
    claim = frappe.get_doc(
        {
            "doctype": "Shangshu Expense Claim",
            "subject": subject,
            "applicant": frappe.session.user,
            "invoice": invoice.name,
            "amount": invoice.total_amount,
            "expense_date": invoice.invoice_date,
            "department": department,
            "cost_center": cost_center,
            "purpose": purpose,
            "payment_recipient": frappe.session.user,
            "record_version": 1,
        }
    ).insert()
    instance = start_process(DEFINITION_ID, claim.doctype, claim.name)
    claim.process_instance = instance.name
    claim.save(ignore_permissions=True)
    _seed_intake_executions(claim, invoice)
    result = {"claim": claim.name, "process_instance": instance.name, "state": claim.workflow_state}
    _audit("finance.expense.create_draft", claim.doctype, claim.name, {"invoice": invoice.name}, result, idempotency_key, "已确认创建报销草稿")
    return result | {"idempotent": False}


def _seed_intake_executions(claim, invoice):
    extraction = frappe.get_doc("Shangshu Document Extraction", invoice.extraction)
    inputs = {"document_extraction": {"has_text_layer": bool(extraction.has_text_layer)}}
    # 历史事实通过真实运行接口重放到提交节点，不由领域伪造核心执行记录。
    for _ in range(20):
        current = get_instance_replay(claim.process_instance)["instance"]["current_node"]
        if current == "com.shangshu.finance.node.submit":
            return
        opened = begin_node_execution(claim.process_instance, current, inputs)
        node = opened["node"]
        if current.endswith(".upload"):
            output = {"file": extraction.file}
        elif current.endswith((".pdf_extract", ".scan_extract")):
            output = _json(extraction.output_json, {})
        else:
            output = {"invoice": invoice.name, "claim": claim.name}
        complete_node_execution(opened["execution"], opened["token"],
                                selected_tool=extraction.selected_tool if current.endswith((".pdf_extract", ".scan_extract")) else None,
                                output_data=output, reason=extraction.selection_reason,
                                callback_id=f"{claim.name}:intake:{current}")
    frappe.throw("收票流程未到达提交节点，请检查已发布流程", frappe.ValidationError)


def _record_claim_node(claim, node_id, action_id, input_summary, result, idempotency_key):
    # 财务 Decimal 以精确十进制字符串进入 JSON 公共契约，不能退化成浮点金额。
    input_summary = json.loads(json.dumps(input_summary, default=str))
    result = json.loads(json.dumps(result, default=str))
    current = get_instance_replay(claim.process_instance)["instance"]["current_node"]
    decision = {"manager_approve": "approved", "finance_approve": "approved",
                "manager_return": "returned", "finance_return": "returned",
                "resubmit": "resubmitted"}.get(input_summary.get("action"))
    if input_summary.get("action") == "resubmit" and current.endswith(".supplement"):
        opened = begin_node_execution(claim.process_instance, current, input_summary)
        complete_node_execution(opened["execution"], opened["token"], output_data=result,
                                decision="resubmitted", callback_id=f"node:{idempotency_key}:supplement")
        current = get_instance_replay(claim.process_instance)["instance"]["current_node"]
    if current != node_id:
        frappe.throw("报销流程当前节点与操作不一致，请刷新或联系管理员", frappe.ValidationError)
    opened = begin_node_execution(claim.process_instance, current, input_summary)
    complete_node_execution(opened["execution"], opened["token"], output_data=result,
                            decision=decision, callback_id=f"node:{idempotency_key}")


def _sync_instance(claim):
    if not claim.process_instance:
        return
    # 只验证业务状态投影，不再从 Workflow 反向改写 core 当前节点。
    instance = get_instance_replay(claim.process_instance)["instance"]
    if instance["current_node"] != STATE_NODE.get(claim.workflow_state):
        frappe.throw("业务状态与冻结流程不一致，本次操作已阻止", frappe.ValidationError)
    if claim.workflow_state == "SS Completed" and instance["status"] != "Completed":
        frappe.throw("流程尚未完成，不能标记业务完成", frappe.ValidationError)


def apply_claim_action(claim_name, action, note, confirmed, idempotency_key):
    _require_confirmation(confirmed)
    prior = _audit_result(idempotency_key)
    if prior:
        return prior | {"idempotent": True}
    claim = frappe.get_doc("Shangshu Expense Claim", claim_name)
    action_map = {
        "submit": ("Submit Claim", "finance.expense.submit", "com.shangshu.finance.node.submit", ("Desk User",)),
        "manager_approve": ("Manager Approve", "finance.expense.manager_decide", "com.shangshu.finance.node.manager", ("Expense Approver",)),
        "manager_return": ("Return for Supplement", "finance.expense.manager_decide", "com.shangshu.finance.node.manager", ("Expense Approver",)),
        "resubmit": ("Resubmit", "finance.expense.submit", "com.shangshu.finance.node.submit", ("Desk User",)),
        "finance_approve": ("Finance Approve", "finance.expense.finance_review", "com.shangshu.finance.node.finance", ("Finance Approver",)),
        "finance_return": ("Finance Return", "finance.expense.finance_review", "com.shangshu.finance.node.finance", ("Finance Approver",)),
    }
    if action not in action_map:
        frappe.throw("不支持的报销动作", frappe.ValidationError)
    workflow_action, action_id, node_id, roles = action_map[action]
    _require_roles(*roles)
    if action in ("manager_return", "finance_return") and not str(note or "").strip():
        frappe.throw("退回必须填写原因", frappe.ValidationError)
    if action in ("submit", "resubmit") and claim.applicant != frappe.session.user:
        frappe.throw("只有发起人可以提交或重提", frappe.PermissionError)
    if action.startswith(("manager_", "finance_")) and claim.applicant == frappe.session.user:
        frappe.throw("不能审批或退回自己的报销单", frappe.PermissionError)
    savepoint = "claim_action_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(savepoint)
    try:
        if action.startswith("manager_"):
            claim.manager_note = str(note or "").strip()
        elif action.startswith("finance_"):
            claim.finance_note = str(note or "").strip()
        elif action == "resubmit":
            claim.supplement_note = str(note or "").strip()
        claim.save(ignore_permissions=True)
        result_doc = apply_workflow(claim, workflow_action)
        result = {"claim": result_doc.name, "state": result_doc.workflow_state, "action": action}
        _record_claim_node(result_doc, node_id, action_id, {"action": action, "note": note}, result, idempotency_key)
        _audit(action_id, result_doc.doctype, result_doc.name, {"action": action, "note": note}, result, idempotency_key, f"已确认{workflow_action}")
        _sync_instance(result_doc)
        return result | {"idempotent": False}
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        raise


def post_expense(claim_name, confirmed, idempotency_key):
    _require_confirmation(confirmed)
    _require_roles("Finance Approver")
    prior = _audit_result(idempotency_key)
    if prior:
        return prior | {"idempotent": True}
    claim = frappe.get_doc("Shangshu Expense Claim", claim_name)
    if claim.workflow_state != "SS Pending Posting":
        frappe.throw("当前报销单不在待过账状态", frappe.ValidationError)
    if claim.applicant == frappe.session.user:
        frappe.throw("不能过账自己的报销单", frappe.PermissionError)
    amount = _money(claim.amount)
    savepoint = "post_expense"
    frappe.db.savepoint(savepoint)
    try:
        batch = frappe.get_doc(
            {
                "doctype": "Shangshu Posting Batch",
                "batch_type": "Expense",
                "expense_claim": claim.name,
                "total_amount": amount,
                "idempotency_key": idempotency_key,
                "status": "Posted",
                "confirmed_by": frappe.session.user,
                "confirmed_at": now_datetime(),
                "reason": "员工垫付办公费用确认",
            }
        ).insert(ignore_permissions=True)
        _insert_entry(batch.name, "Debit", "管理费用—办公费", amount, claim, "确认办公费用")
        _insert_entry(batch.name, "Credit", "其他应付款—员工", amount, claim, "确认员工垫付款")
        payable = frappe.get_doc(
            {
                "doctype": "Shangshu Payable",
                "expense_claim": claim.name,
                "recipient": claim.payment_recipient,
                "amount": amount,
                "paid_amount": Decimal("0.00"),
                "balance_amount": amount,
                "status": "Open",
                "record_version": 1,
                "expense_posting_batch": batch.name,
            }
        ).insert(ignore_permissions=True)
        result_doc = apply_workflow(claim, "Post Expense")
        result = {"claim": claim.name, "state": result_doc.workflow_state, "posting_batch": batch.name, "payable": payable.name}
        _record_claim_node(result_doc, "com.shangshu.finance.node.post", "finance.posting.post_expense", {"amount": amount}, result, idempotency_key)
        _audit("finance.posting.post_expense", claim.doctype, claim.name, {"amount": amount, "debit": "管理费用—办公费", "credit": "其他应付款—员工"}, result, idempotency_key, "已确认借贷影响并执行不可变过账")
        _sync_instance(result_doc)
        return result | {"idempotent": False}
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        raise


def _insert_entry(batch, direction, account, amount, source, memo):
    return frappe.get_doc(
        {
            "doctype": "Shangshu Ledger Entry",
            "posting_batch": batch,
            "direction": direction,
            "account": account,
            "amount": amount,
            "business_date": nowdate(),
            "source_doctype": source.doctype,
            "source_name": source.name,
            "memo": memo,
        }
    ).insert(ignore_permissions=True)


def pay_payable(payable_name, account, confirmed, expected_version, idempotency_key):
    _require_confirmation(confirmed)
    _require_roles("Finance Approver", "Cashier")
    prior = _audit_result(idempotency_key)
    if prior:
        return prior | {"idempotent": True}
    payable = frappe.get_doc("Shangshu Payable", payable_name)
    if int(expected_version) != int(payable.record_version):
        frappe.throw("应付记录已变化，请重新确认", frappe.TimestampMismatchError)
    if payable.status != "Open" or _money(payable.balance_amount) <= 0:
        frappe.throw("该应付已结清或不可付款", frappe.ValidationError)
    claim = frappe.get_doc("Shangshu Expense Claim", payable.expense_claim)
    if claim.workflow_state != "SS Pending Payment":
        frappe.throw("报销单不在待付款状态", frappe.ValidationError)
    if claim.applicant == frappe.session.user:
        frappe.throw("不能登记自己报销单的付款", frappe.PermissionError)
    amount = _money(payable.balance_amount)
    savepoint = "pay_payable"
    frappe.db.savepoint(savepoint)
    try:
        batch = frappe.get_doc(
            {
                "doctype": "Shangshu Posting Batch",
                "batch_type": "Payment",
                "expense_claim": claim.name,
                "payable": payable.name,
                "total_amount": amount,
                "idempotency_key": idempotency_key,
                "status": "Posted",
                "confirmed_by": frappe.session.user,
                "confirmed_at": now_datetime(),
                "reason": "报销款实际支付",
            }
        ).insert(ignore_permissions=True)
        _insert_entry(batch.name, "Debit", "其他应付款—员工", amount, claim, "结清员工应付款")
        _insert_entry(batch.name, "Credit", "银行存款", amount, claim, "银行账户实际付款")
        movement = frappe.get_doc(
            {
                "doctype": "Shangshu Cash Movement",
                "movement_type": "Payment",
                "amount_cents": int((amount * 100).to_integral_exact()),
                "account": str(account or "").strip() or "基本户",
                "business_date": nowdate(),
                "payable": payable.name,
                "posting_batch": batch.name,
                "recipient": payable.recipient,
                "memo": "员工报销款付款",
            }
        ).insert(ignore_permissions=True)
        payable.paid_amount = amount
        payable.balance_amount = Decimal("0.00")
        payable.status = "Paid"
        payable.record_version = int(payable.record_version) + 1
        payable.payment_posting_batch = batch.name
        payable.save(ignore_permissions=True)
        # 首阶段付款由 Finance Approver 完成；Cashier 角色将在委托/独立付款节点阶段接入。
        if "Finance Approver" not in frappe.get_roles():
            frappe.throw("当前流程版本的付款节点仅允许财务复核角色", frappe.PermissionError)
        result_doc = apply_workflow(claim, "Record Payment")
        result = {"claim": claim.name, "state": result_doc.workflow_state, "posting_batch": batch.name, "payable": payable.name, "cash_movement": movement.name}
        _record_claim_node(result_doc, "com.shangshu.finance.node.pay", "finance.payable.pay", {"amount": amount, "account": account}, result, idempotency_key)
        _audit("finance.payable.pay", payable.doctype, payable.name, {"amount": amount, "account": account, "expected_version": expected_version}, result, idempotency_key, "已确认付款对象、金额和银行账户")
        _sync_instance(result_doc)
        return result | {"idempotent": False}
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        raise


def finance_reconciliation(claim_name):
    claim = frappe.get_doc("Shangshu Expense Claim", claim_name)
    claim.check_permission("read")
    batches = frappe.get_all("Shangshu Posting Batch", filters={"expense_claim": claim.name}, fields=["name", "batch_type", "total_amount", "status", "confirmed_by", "confirmed_at"], order_by="creation asc")
    batch_names = [row.name for row in batches]
    entries = frappe.get_all("Shangshu Ledger Entry", filters={"posting_batch": ["in", batch_names or [""]]}, fields=["name", "posting_batch", "direction", "account", "amount", "business_date"], order_by="creation asc")
    payable_name = frappe.db.get_value("Shangshu Payable", {"expense_claim": claim.name}, "name")
    payable = frappe.get_doc("Shangshu Payable", payable_name).as_dict() if payable_name else None
    cash = frappe.get_all("Shangshu Cash Movement", filters={"payable": payable_name} if payable_name else {"name": ""}, fields=["name", "movement_type", "amount_cents", "account", "business_date"])
    balance = {}
    for batch in batch_names:
        debit = sum((_money(row.amount) for row in entries if row.posting_batch == batch and row.direction == "Debit"), Decimal("0.00"))
        credit = sum((_money(row.amount) for row in entries if row.posting_batch == batch and row.direction == "Credit"), Decimal("0.00"))
        balance[batch] = {"debit": str(debit), "credit": str(credit), "balanced": debit == credit}
    return {"claim": claim.as_dict(), "batches": batches, "entries": entries, "payable": payable, "cash_movements": cash, "balance": balance}


def get_claim_instance(claim_name):
    claim = frappe.get_doc("Shangshu Expense Claim", claim_name)
    claim.check_permission("read")
    invoice = frappe.get_doc("Shangshu Finance Invoice", claim.invoice)
    extraction = frappe.get_doc("Shangshu Document Extraction", invoice.extraction)
    replay = get_instance_replay(claim.process_instance)
    executions = replay["executions"]
    payable_name = frappe.db.get_value("Shangshu Payable", {"expense_claim": claim.name}, "name")
    audit_refs = [(claim.doctype, claim.name), (invoice.doctype, invoice.name)] + ([("Shangshu Payable", payable_name)] if payable_name else [])
    audits = list_reference_audits(audit_refs)
    actions = _available_actions(claim)
    return {
        "claim": claim.as_dict(),
        "invoice": invoice.as_dict(),
        "extraction": {"name": extraction.name, "status": extraction.status, "candidate_tools": _json(extraction.candidate_tools_json, []), "selected_tool": extraction.selected_tool, "selection_reason": extraction.selection_reason, "warnings": _json(extraction.warnings_json, {}), "file": extraction.file},
        "process": replay["instance"],
        "actions": actions,
        "executions": executions,
        "audits": audits,
        "finance": finance_reconciliation(claim.name) if claim.workflow_state in ("SS Pending Payment", "SS Completed") else None,
    }


def _available_actions(claim):
    roles = set(frappe.get_roles())
    result = []
    if claim.applicant == frappe.session.user and claim.workflow_state == "SS Draft":
        result.append("submit")
    if claim.applicant == frappe.session.user and claim.workflow_state == "SS Needs Supplement":
        result.append("resubmit")
    if claim.applicant == frappe.session.user:
        return result
    if "Expense Approver" in roles and claim.workflow_state == "SS Pending Manager Approval":
        result.extend(["manager_approve", "manager_return"])
    if "Finance Approver" in roles and claim.workflow_state == "SS Pending Finance Review":
        result.extend(["finance_approve", "finance_return"])
    if "Finance Approver" in roles and claim.workflow_state == "SS Pending Posting":
        result.append("post")
    if "Finance Approver" in roles and claim.workflow_state == "SS Pending Payment":
        result.append("pay")
    return result


def list_claims(view="started"):
    filters = {}
    user = frappe.session.user
    if view == "started":
        filters["applicant"] = user
    elif view == "pending":
        roles = set(frappe.get_roles())
        states = []
        if "Expense Approver" in roles:
            states.append("SS Pending Manager Approval")
        if "Finance Approver" in roles:
            states.extend(["SS Pending Finance Review", "SS Pending Posting", "SS Pending Payment"])
        if not states:
            return []
        filters["workflow_state"] = ["in", states]
        filters["applicant"] = ["!=", user]
    elif view == "completed":
        # “已完成”既包含本人发起，也包含本人实际办理过的事项；管理员可查看全部。
        filters["workflow_state"] = "SS Completed"
    elif view == "launch":
        return [{"definition_id": DEFINITION_ID, "title": "费用报销与付款", "journey": "上传票据 → 核对 → 经理审批 → 财务复核 → 过账 → 付款", "materials": ["发票 PDF 或图片", "部门与成本归属", "用途说明"]}]
    elif view == "copied":
        return []
    else:
        frappe.throw("不支持的流程中心视图", frappe.ValidationError)
    names = frappe.get_all("Shangshu Expense Claim", filters=filters, pluck="name", order_by="modified desc", limit_page_length=100)
    rows = []
    is_admin = user == "Administrator" or "System Manager" in frappe.get_roles()
    for name in names:
        if frappe.has_permission("Shangshu Expense Claim", "read", doc=name):
            doc = frappe.get_doc("Shangshu Expense Claim", name)
            if view == "completed" and not is_admin and doc.applicant != user:
                participated = any(row.actor_user == user for row in list_reference_audits([(doc.doctype, doc.name)]))
                if not participated:
                    continue
            rows.append({"name": doc.name, "subject": doc.subject, "amount": doc.amount, "applicant": doc.applicant, "state": doc.workflow_state, "current_node": STATE_NODE.get(doc.workflow_state), "modified": doc.modified})
    return rows
