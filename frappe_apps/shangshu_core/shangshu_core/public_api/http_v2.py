"""HTTP v2 发起边界；可信 Python 集成继续使用 public_api v1。"""
import frappe

from shangshu_core.public_api import launch_process


@frappe.whitelist(methods=["POST"])
def process_start(definition_id, values, idempotency_key, confirmed=False):
    confirmed = confirmed is True or confirmed in ("true", "1")
    return launch_process(definition_id, values, idempotency_key, confirmed)
