"""财务领域对尚书 public_api v1 暴露的统一执行器。"""

import frappe

from shangshu_finance.service import (
    apply_claim_action,
    confirm_invoice,
    create_claim,
    finance_reconciliation,
    get_claim_instance,
    list_claims,
    pay_payable,
    post_expense,
)


def execute_action(action_id, payload, context):
    confirmed = 1 if context.get("confirmed") else 0
    key = context.get("idempotency_key")
    if action_id == "finance.invoice.confirm_fields":
        return confirm_invoice(payload.get("invoice"), payload.get("expected_version"), payload.get("fields") or {}, confirmed, key)
    if action_id == "finance.expense.create_draft":
        return create_claim(
            payload.get("invoice"), payload.get("subject"), payload.get("department"),
            payload.get("cost_center"), payload.get("purpose"), confirmed, key,
        )
    if action_id in ("finance.expense.submit", "finance.expense.manager_decide", "finance.expense.finance_review"):
        operation=payload.get("action")
        if operation=="return":
            operation={"finance.expense.manager_decide":"manager_return",
                       "finance.expense.finance_review":"finance_return"}.get(action_id,operation)
        return apply_claim_action(payload.get("claim"), operation, payload.get("note"), confirmed, key)
    if action_id == "finance.posting.post_expense":
        return post_expense(payload.get("claim"), confirmed, key)
    if action_id == "finance.payable.pay":
        return pay_payable(
            payload.get("payable"), payload.get("account"), confirmed,
            payload.get("expected_version"), key,
        )
    frappe.throw("该财务动作尚未开放公共执行器", frappe.ValidationError)


def invoke_service(service_id, payload, _context):
    if service_id == "finance.claim.list":
        return {"list": list_claims(payload.get("view") or "started")}
    if service_id == "finance.claim.get":
        return get_claim_instance(payload.get("claim"))
    if service_id == "finance.claim.reconcile":
        return finance_reconciliation(payload.get("claim"))
    frappe.throw("财务领域服务不存在", frappe.DoesNotExistError)
