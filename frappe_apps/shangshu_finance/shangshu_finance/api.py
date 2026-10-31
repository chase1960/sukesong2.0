import frappe

from shangshu_core.public_api import assert_domain_enabled, is_domain_enabled, domain_execution
from shangshu_finance.domain import DOMAIN_ID
from shangshu_finance.service import (
    apply_claim_action,
    complete_extraction,
    confirm_invoice,
    create_claim,
    create_document,
    fail_extraction,
    finance_reconciliation,
    get_claim_instance,
    list_claims,
    pay_payable,
    post_expense,
    prepare_extraction,
)


def _new_business_allowed():
    assert_domain_enabled(DOMAIN_ID)


def _existing_claim_allowed(claim):
    if is_domain_enabled(DOMAIN_ID):
        return
    if not claim or not frappe.db.exists("Shangshu Expense Claim", claim):
        assert_domain_enabled(DOMAIN_ID)
    process = frappe.db.get_value("Shangshu Expense Claim", claim, "process_instance")
    if not process:
        assert_domain_enabled(DOMAIN_ID)


def _existing_payable_allowed(payable):
    if is_domain_enabled(DOMAIN_ID):
        return
    claim = frappe.db.get_value("Shangshu Payable", payable, "expense_claim")
    _existing_claim_allowed(claim)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def upload_document(file_name, content_base64, has_text_layer=0, file_sha256=None):
    _new_business_allowed()
    return create_document(file_name, content_base64, has_text_layer, file_sha256)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def extraction_prepare(extraction, has_text_layer=0):
    _new_business_allowed()
    return prepare_extraction(extraction, has_text_layer)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def extraction_succeeded(extraction, selected_tool, output, warnings=None, raw_text=None, reason=None, duration_ms=0, callback_id=None):
    _new_business_allowed()
    return complete_extraction(extraction, selected_tool, output, warnings, raw_text, reason, duration_ms, callback_id)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def extraction_failed(extraction, error_code, error_message):
    _new_business_allowed()
    return fail_extraction(extraction, error_code, error_message)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def invoice_confirm(invoice, expected_version, fields, confirmed=0, idempotency_key=None):
    _new_business_allowed()
    return confirm_invoice(invoice, expected_version, fields, confirmed, idempotency_key)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID)
def claim_create(invoice, subject, department, cost_center, purpose, confirmed=0, idempotency_key=None):
    _new_business_allowed()
    return create_claim(invoice, subject, department, cost_center, purpose, confirmed, idempotency_key)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID, allow_disabled=True)
def claim_action(claim, action, note=None, confirmed=0, idempotency_key=None):
    _existing_claim_allowed(claim)
    return apply_claim_action(claim, action, note, confirmed, idempotency_key)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID, allow_disabled=True)
def posting_confirm(claim, confirmed=0, idempotency_key=None):
    _existing_claim_allowed(claim)
    return post_expense(claim, confirmed, idempotency_key)


@frappe.whitelist(methods=["POST"])
@domain_execution(DOMAIN_ID, allow_disabled=True)
def payable_pay(payable, account, expected_version, confirmed=0, idempotency_key=None):
    _existing_payable_allowed(payable)
    return pay_payable(payable, account, confirmed, expected_version, idempotency_key)


@frappe.whitelist()
@domain_execution(DOMAIN_ID, allow_disabled=True)
def process_center(view="started"):
    if view == "launch" and not is_domain_enabled(DOMAIN_ID):
        return []
    return list_claims(view)


@frappe.whitelist()
@domain_execution(DOMAIN_ID, allow_disabled=True)
def claim_instance(claim):
    return get_claim_instance(claim)


@frappe.whitelist()
@domain_execution(DOMAIN_ID, allow_disabled=True)
def reconciliation(claim):
    return finance_reconciliation(claim)
