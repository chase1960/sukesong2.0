import base64
import io
import json
from decimal import Decimal
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from pypdf import PdfWriter

from shangshu_finance.service import (
    apply_claim_action,
    complete_extraction,
    confirm_invoice,
    create_claim,
    create_document,
    finance_reconciliation,
    get_claim_instance,
    list_claims,
    pay_payable,
    post_expense,
)
from shangshu_core.public_api import (
    execute_registered_action,
    list_action_proposals,
    propose_registered_action,
    register_action,
    get_object_record,
    list_process_instances,
    is_domain_enabled,
    resolve_action_proposal,
    set_domain_enabled,
)
from shangshu_finance import api as finance_api


_RUN = frappe.generate_hash(length=8).lower()
STAFF = f"financetest-staff-{_RUN}@shangshu.local"
MANAGER = f"financetest-manager-{_RUN}@shangshu.local"
FINANCE = f"financetest-finance-{_RUN}@shangshu.local"
APPROVER = f"financetest-assign-{_RUN}@shangshu.local"


def _ensure_test_user(email, first_name, roles):
    if frappe.db.exists("User", email):
        return
    user = frappe.get_doc({
        "doctype": "User", "email": email, "first_name": first_name,
        "enabled": 1, "user_type": "System User", "send_welcome_email": 0,
    })
    for role in ["Desk User", *roles]:
        user.append("roles", {"role": role})
    user.insert(ignore_permissions=True)


def _key(prefix):
    return f"{prefix}-{frappe.generate_hash(length=12)}"


def _invoice_output(number):
    return {
        "fields": {
            "invoice_number": number,
            "invoice_date": frappe.utils.nowdate(),
            "seller_name": "南京办公用品有限公司",
            "seller_tax_id": "91320100TEST00001",
            "buyer_name": "尚书演示企业",
            "total_amount": "1130.00",
            "tax_amount": "130.00",
            "direction": "Input",
        },
        "raw_text": "增值税电子普通发票 办公用品 价税合计 1130.00",
    }


def _file_bytes(has_text_layer):
    if has_text_layer:
        stream = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        writer.write(stream)
        return stream.getvalue()
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )


def _create_confirmed_invoice(has_text_layer=True):
    frappe.set_user(STAFF)
    number = "TEST-" + frappe.generate_hash(length=10).upper()
    document = create_document(
        f"{number}.pdf" if has_text_layer else f"{number}.png",
        base64.b64encode(_file_bytes(has_text_layer)).decode(),
        1 if has_text_layer else 0,
    )
    selected = "document.pdf_text_extract" if has_text_layer else "document.ocr_extract"
    extracted = complete_extraction(
        document["extraction"],
        selected,
        _invoice_output(number),
        warnings={},
        reason="文字层固定路径" if has_text_layer else "扫描件优先选择 OCR",
        duration_ms=28,
        callback_id=_key("callback"),
    )
    invoice = frappe.get_doc("Shangshu Finance Invoice", extracted["invoice"])
    confirmed = confirm_invoice(invoice.name, invoice.record_version, {}, 1, _key("confirm-invoice"))
    return frappe.get_doc("Shangshu Finance Invoice", confirmed["invoice"])


def _create_claim(has_text_layer=True):
    invoice = _create_confirmed_invoice(has_text_layer)
    result = create_claim(
        invoice.name,
        "打印纸和办公耗材报销",
        "行政部",
        "行政管理",
        "员工垫付采购打印纸与办公耗材",
        1,
        _key("create-claim"),
    )
    return frappe.get_doc("Shangshu Expense Claim", result["claim"])


class TestFinanceChain(FrappeTestCase):
    def setUp(self):
        self.addCleanup(frappe.db.rollback)
        frappe.set_user("Administrator")
        _ensure_test_user(STAFF, "Finance Test Staff", [])
        _ensure_test_user(MANAGER, "Finance Test Manager", ["Expense Approver"])
        _ensure_test_user(FINANCE, "Finance Test Approver", ["Finance Approver", "Cashier"])

    def tearDown(self):
        frappe.set_user("Administrator")
        for email in (STAFF, MANAGER, FINANCE, APPROVER):
            if frappe.db.exists("User", email):
                frappe.delete_doc("User", email, ignore_permissions=True, force=True)

    def test_approver_is_assignable_and_revocable_through_platform_action(self):
        _ensure_test_user(APPROVER, "Finance Assignable Approver", [])
        def assign(roles):
            execute_registered_action("platform.identity.role",
                                      {"email": APPROVER, "roles": ["staff"], "business_roles": roles},
                                      True, _key("assign-approver"))
        assign(["Expense Approver"])
        self.assertIn("Expense Approver", frappe.get_roles(APPROVER))
        assign([])
        self.assertNotIn("Expense Approver", frappe.get_roles(APPROVER))

    def test_multi_role_applicant_cannot_approve_own_claim(self):
        """管理兼财务人员可有审批资格，但不得批准本人报销。"""
        claim = _create_claim()
        frappe.set_user("Administrator")
        user = frappe.get_doc("User", STAFF)
        for role in ("Expense Approver", "Finance Approver", "Cashier"):
            user.append("roles", {"role": role})
        user.save(ignore_permissions=True)
        frappe.set_user(STAFF)
        apply_claim_action(claim.name, "submit", "本人提交", 1, _key("self-submit"))
        self.assertIn("Expense Approver", frappe.get_roles())
        self.assertNotIn(claim.name, {row["name"] for row in list_claims("pending")})
        self.assertNotIn("manager_approve", get_claim_instance(claim.name)["actions"])
        before_note = frappe.db.get_value("Shangshu Expense Claim", claim.name, "manager_note")
        with self.assertRaises(frappe.PermissionError):
            apply_claim_action(claim.name, "manager_approve", "本人审批", 1, _key("self-approve"))
        self.assertEqual(frappe.db.get_value("Shangshu Expense Claim", claim.name, "workflow_state"),
                         "SS Pending Manager Approval")
        self.assertEqual(frappe.db.get_value("Shangshu Expense Claim", claim.name, "manager_note"), before_note)

    def test_administrator_cannot_approve_own_claim(self):
        claim = _create_claim()
        frappe.set_user("Administrator")
        frappe.db.set_value("Shangshu Expense Claim", claim.name, "applicant", "Administrator")
        apply_claim_action(claim.name, "submit", "管理员提交", 1, _key("admin-submit"))
        self.assertNotIn("manager_approve", get_claim_instance(claim.name)["actions"])
        with self.assertRaises(frappe.PermissionError):
            apply_claim_action(claim.name, "manager_approve", "本人审批", 1, _key("admin-self-approve"))
        self.assertEqual(frappe.db.get_value("Shangshu Expense Claim", claim.name, "workflow_state"),
                         "SS Pending Manager Approval")

    def test_invalid_claim_transition_rolls_back_review_note(self):
        claim = _create_claim()
        frappe.set_user(MANAGER)
        before_note = frappe.db.get_value("Shangshu Expense Claim", claim.name, "manager_note")
        with self.assertRaises(frappe.ValidationError):
            apply_claim_action(claim.name, "manager_approve", "不得半写入", 1, _key("invalid-transition"))
        self.assertEqual(frappe.db.get_value("Shangshu Expense Claim", claim.name, "workflow_state"), "SS Draft")
        self.assertEqual(frappe.db.get_value("Shangshu Expense Claim", claim.name, "manager_note"), before_note)

    def test_public_ai_action_proposal_does_not_write_until_human_confirmation(self):
        invoice = _create_confirmed_invoice()
        before = frappe.db.count("Shangshu Expense Claim")
        proposal = propose_registered_action(
            "finance.expense.create_draft",
            {
                "invoice": invoice.name,
                "subject": "AI 辅助生成的办公耗材报销",
                "department": "行政部",
                "cost_center": "行政管理",
                "purpose": "验证公共 AI 提案确认边界",
            },
            _key("ai-proposal"),
            "ai-chat",
        )
        self.assertEqual(proposal["status"], "proposed")
        self.assertEqual(frappe.db.count("Shangshu Expense Claim"), before)
        self.assertIn(proposal["id"], {row["id"] for row in list_action_proposals()["items"]})

        # 提案等待人工确认期间，即使同 ID 发布了新 Action 版本，也必须按提案锁定的 v1 schema 执行。
        newer_registry_key = "finance.expense.create_draft@1.1.0"
        register_action(
            "finance.expense.create_draft", "1.1.0", "创建报销草稿（不兼容探针）", "propose", "required",
            ["Desk User"],
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["incompatible_marker"],
                "properties": {"incompatible_marker": {"type": "string"}},
            },
            {}, 30, "none",
        )
        try:
            resolved = resolve_action_proposal(proposal["id"], "confirmed")
        finally:
            if frappe.db.exists("Shangshu Action Definition", newer_registry_key):
                frappe.delete_doc("Shangshu Action Definition", newer_registry_key, ignore_permissions=True, force=True)
        self.assertEqual(resolved["status"], "confirmed")
        self.assertTrue(resolved["execution_audit"])
        # **统一日志库**（PKG-020-T01）：动作审计只写统一表 ⇒ 回执编号是统一日志的编号。
        self.assertEqual(frappe.db.get_value("Shangshu Unified Log", resolved["execution_audit"], "what_id"), "finance.expense.create_draft")
        self.assertEqual(json.loads(frappe.db.get_value("Shangshu Unified Log", resolved["execution_audit"], "detail_json"))["legacy"]["action_version"], "1.0.0")
        self.assertEqual(frappe.db.count("Shangshu Expense Claim"), before + 1)
        duplicate = resolve_action_proposal(proposal["id"], "confirmed")
        self.assertTrue(duplicate["idempotent"])
        self.assertEqual(frappe.db.count("Shangshu Expense Claim"), before + 1)

    def test_complete_stop_blocks_new_and_existing_business_until_reenabled(self):
        claim = _create_claim()
        frappe.set_user("Administrator")
        orders_enabled = is_domain_enabled("com.shangshu.orders")
        if orders_enabled:
            with self.assertRaises(frappe.ValidationError):
                set_domain_enabled("com.shangshu.finance", 0, "已启用依赖不能被停用", stop_mode="complete")
            set_domain_enabled("com.shangshu.orders", 0, "测试准备：先停依赖方", stop_mode="complete")
        try:
            with self.assertRaises(frappe.ValidationError):
                set_domain_enabled("com.shangshu.finance", 0, "在途流程必须先处理", stop_mode="complete")
            frappe.set_user(STAFF)
            result = finance_api.claim_action(claim.name, "submit", "停用前完成流程", 1, _key("stop-submit"))
            self.assertEqual(result["state"], "SS Pending Manager Approval")
            frappe.set_user(MANAGER)
            finance_api.claim_action(claim.name, "manager_approve", "同意", 1, _key("stop-manager"))
            frappe.set_user(FINANCE)
            finance_api.claim_action(claim.name, "finance_approve", "通过", 1, _key("stop-finance"))
            posted = finance_api.posting_confirm(claim.name, 1, _key("stop-post"))
            payable = frappe.get_doc("Shangshu Payable", posted["payable"])
            finance_api.payable_pay(payable.name, "基本户", payable.record_version, 1, _key("stop-pay"))
            frappe.set_user("Administrator")
            stopped = set_domain_enabled("com.shangshu.finance", 0, "验证完整停止执行", stop_mode="complete")
            self.assertTrue(stopped["execution_stopped"])
            frappe.set_user(STAFF)
            for operation in (
                lambda: finance_api.upload_document("blocked.pdf", "ZmlsZQ=="),
                lambda: finance_api.claim_instance(claim.name),
                lambda: finance_api.claim_action(claim.name, "submit", "拒绝存量续办", 1, _key("stopped-submit")),
                lambda: get_object_record("finance.expense_claim", claim.name),
            ):
                with self.assertRaises(frappe.PermissionError):
                    operation()
        finally:
            frappe.set_user("Administrator")
            set_domain_enabled("com.shangshu.finance", 1, "测试清理：恢复财务")
            if orders_enabled:
                set_domain_enabled("com.shangshu.orders", 1, "测试清理：恢复订单")
        frappe.set_user(FINANCE)
        completed = finance_api.claim_instance(claim.name)
        self.assertEqual(completed["claim"]["workflow_state"], "SS Completed")
        self.assertEqual(completed["process"]["status"], "Completed")
        self.assertEqual(finance_api.reconciliation(claim.name)["payable"]["status"], "Paid")

    def test_first_install_defers_trigger_ddl_until_migrate(self):
        from shangshu_finance import install

        with patch.object(install, "ensure_immutable_triggers") as ensure_triggers:
            install.after_install()
            ensure_triggers.assert_not_called()

    def test_legacy_graph_condition_migrates_without_rebuilding_nodes(self):
        from shangshu_finance.install import _migrate_graph_v2

        legacy = {
            "nodes": [{"id": "com.shangshu.finance.node.detect", "type": "condition", "title": "用户改过的标题", "start": True, "terminal": True}],
            "edges": [
                {"source": "com.shangshu.finance.node.detect", "target": "com.shangshu.finance.node.detect", "condition": "file.has_text_layer == true"},
                {"source": "com.shangshu.finance.node.detect", "target": "com.shangshu.finance.node.detect", "condition": "file.has_text_layer == false"},
            ],
            "custom": {"preserved": True},
        }
        migrated = _migrate_graph_v2(legacy)
        self.assertEqual(migrated["schema_version"], 2)
        self.assertEqual(migrated["nodes"][0]["title"], "用户改过的标题")
        self.assertEqual(migrated["custom"], {"preserved": True})
        self.assertEqual(migrated["edges"][0]["condition"]["source"]["object_id"], "document_extraction")
        self.assertTrue(migrated["edges"][1]["is_default"])
        self.assertNotIn("condition", migrated["edges"][1])
        self.assertEqual(len({edge["id"] for edge in migrated["edges"]}), 2)
        self.assertNotIn("file.has_text_layer", json.dumps(migrated))

    def test_1130_full_chain_with_return_resubmit_post_and_payment(self):
        claim = _create_claim(has_text_layer=False)
        self.assertEqual(Decimal(str(claim.amount)), Decimal("1130.0"))
        self.assertTrue(claim.process_instance)

        frappe.set_user(STAFF)
        apply_claim_action(claim.name, "submit", "材料已核对", 1, _key("submit"))
        frappe.set_user(MANAGER)
        returned = apply_claim_action(claim.name, "manager_return", "请补充办公用品用途", 1, _key("manager-return"))
        self.assertEqual(returned["state"], "SS Needs Supplement")

        frappe.set_user(STAFF)
        resubmitted = apply_claim_action(claim.name, "resubmit", "已补充：行政部日常打印使用", 1, _key("resubmit"))
        self.assertEqual(resubmitted["state"], "SS Pending Manager Approval")
        frappe.set_user(MANAGER)
        self.assertIn(claim.process_instance, {row['name'] for row in list_process_instances('pending')})
        apply_claim_action(claim.name, "manager_approve", "用途合理，同意报销", 1, _key("manager-approve"))
        frappe.set_user(FINANCE)
        reviewed = apply_claim_action(claim.name, "finance_approve", "金额、票据与科目核验通过", 1, _key("finance-approve"))
        self.assertEqual(reviewed["state"], "SS Pending Posting")

        post_key = _key("post")
        posted = post_expense(claim.name, 1, post_key)
        duplicate_post = post_expense(claim.name, 1, post_key)
        self.assertEqual(posted["posting_batch"], duplicate_post["posting_batch"])
        payable = frappe.get_doc("Shangshu Payable", posted["payable"])
        self.assertEqual(Decimal(str(payable.balance_amount)), Decimal("1130.0"))
        detail = get_object_record("finance.payable", payable.name)
        self.assertEqual([item["id"] for item in detail["actions"]], ["finance.payable.pay"])
        self.assertEqual(detail["actions"][0]["values"]["payable"], payable.name)
        self.assertNotIn("doctype", detail["object"])

        pay_key = _key("pay")
        paid = pay_payable(payable.name, "基本户", 1, payable.record_version, pay_key)
        duplicate_pay = pay_payable(payable.name, "基本户", 1, payable.record_version, pay_key)
        self.assertEqual(paid["cash_movement"], duplicate_pay["cash_movement"])
        self.assertEqual(get_object_record("finance.payable", payable.name)["actions"], [])
        detail = get_object_record("finance.expense_claim", claim.name)
        self.assertEqual(detail["processes"][0]["name"], claim.process_instance)

        report = finance_reconciliation(claim.name)
        self.assertEqual(report["claim"]["workflow_state"], "SS Completed")
        self.assertEqual(len(report["batches"]), 2)
        self.assertEqual(len(report["entries"]), 4)
        self.assertTrue(all(item["balanced"] for item in report["balance"].values()))
        self.assertEqual(Decimal(str(report["payable"]["paid_amount"])), Decimal("1130.0"))
        self.assertEqual(Decimal(str(report["payable"]["balance_amount"])), Decimal("0.0"))
        self.assertEqual(report["cash_movements"][0]["amount_cents"], 113000)
        self.assertEqual(
            frappe.db.count("Shangshu Posting Batch", {"expense_claim": claim.name}),
            2,
        )
        executions = frappe.get_all("Shangshu Node Execution", filters={"process_instance": claim.process_instance},
                                    fields=["node_id", "status"], order_by="creation asc")
        self.assertEqual([row.node_id.rsplit('.', 1)[-1] for row in executions], [
            "upload", "detect", "scan_extract", "confirm_fields", "claim", "submit",
            "manager", "supplement", "submit", "manager", "finance", "post", "pay",
        ])
        self.assertTrue(all(row.status == "Completed" for row in executions))
        process = frappe.get_doc("Shangshu Process Instance", claim.process_instance)
        self.assertEqual(process.status, "Completed")

    def test_text_pdf_uses_fixed_tool_without_ai_audit(self):
        claim = _create_claim(has_text_layer=True)
        extraction = frappe.get_doc("Shangshu Document Extraction", frappe.db.get_value("Shangshu Finance Invoice", claim.invoice, "extraction"))
        self.assertEqual(extraction.selected_tool, "document.pdf_text_extract")
        execution = frappe.db.get_value(
            "Shangshu Node Execution",
            {"process_instance": claim.process_instance, "selected_tool": "document.pdf_text_extract"},
            "name",
        )
        self.assertTrue(execution)
        # **统一日志库**（PKG-020-T01）：AI 执行审计只写统一表这一处。
        self.assertFalse(frappe.db.exists("Shangshu Unified Log", {"what_kind": "tool", "reference_name": execution}))

    def test_scan_uses_whitelist_and_records_ai_reason(self):
        claim = _create_claim(has_text_layer=False)
        # **统一日志库**（PKG-020-T01）：AI 执行审计只写统一表这一处（旧表不再新增）。
        audit = frappe.get_all(
            "Shangshu Unified Log",
            filters={"what_kind": "tool", "reference_name": ["in", frappe.get_all("Shangshu Node Execution", filters={"process_instance": claim.process_instance}, pluck="name")]},
            fields=["detail_json"],
            order_by="creation desc",
            limit=1,
        )[0]
        detail = json.loads(audit.detail_json)
        self.assertIn("document.ocr_extract", detail["candidate_tools"])
        self.assertEqual(detail["selected_tool"], "document.ocr_extract")
        self.assertIn("OCR", detail["selection_reason"])

    def test_unconfirmed_and_cross_role_actions_are_rejected(self):
        claim = _create_claim()
        frappe.set_user(STAFF)
        with self.assertRaises(frappe.ValidationError):
            apply_claim_action(claim.name, "submit", None, 0, _key("unconfirmed"))
        apply_claim_action(claim.name, "submit", "提交", 1, _key("submit"))
        with self.assertRaises(frappe.PermissionError):
            apply_claim_action(claim.name, "manager_approve", "越权", 1, _key("cross-role"))

    def test_candidate_outside_extraction_whitelist_does_not_create_invoice(self):
        frappe.set_user(STAFF)
        document = create_document(
            "outside-tool.png",
            base64.b64encode(_file_bytes(False)).decode(),
            0,
        )
        with self.assertRaises(frappe.PermissionError):
            complete_extraction(
                document["extraction"],
                "finance.payable.pay",
                _invoice_output("OUTSIDE-" + frappe.generate_hash(length=6)),
            )
        self.assertFalse(frappe.db.exists("Shangshu Finance Invoice", {"extraction": document["extraction"]}))

    def test_database_triggers_reject_ledger_update_and_cash_delete(self):
        claim = _create_claim()
        frappe.set_user(STAFF)
        apply_claim_action(claim.name, "submit", "提交", 1, _key("submit"))
        frappe.set_user(MANAGER)
        apply_claim_action(claim.name, "manager_approve", "同意", 1, _key("manager"))
        frappe.set_user(FINANCE)
        apply_claim_action(claim.name, "finance_approve", "核验通过", 1, _key("finance"))
        posted = post_expense(claim.name, 1, _key("post"))
        payable = frappe.get_doc("Shangshu Payable", posted["payable"])
        paid = pay_payable(payable.name, "基本户", 1, payable.record_version, _key("pay"))
        entry = frappe.db.get_value("Shangshu Ledger Entry", {"posting_batch": posted["posting_batch"]}, "name")

        frappe.db.savepoint("immutable_finance_triggers")
        with self.assertRaises(Exception):
            frappe.db.sql("update `tabShangshu Ledger Entry` set amount=1 where name=%s", entry)
        frappe.db.rollback(save_point="immutable_finance_triggers")

        frappe.db.savepoint("immutable_cash_trigger")
        with self.assertRaises(Exception):
            frappe.db.sql("delete from `tabShangshu Cash Movement` where name=%s", paid["cash_movement"])
        frappe.db.rollback(save_point="immutable_cash_trigger")
        self.assertEqual(frappe.db.get_value("Shangshu Ledger Entry", entry, "amount"), Decimal("1130.0"))
        self.assertTrue(frappe.db.exists("Shangshu Cash Movement", paid["cash_movement"]))
