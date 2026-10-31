"""Release-gate probes for fresh-install, upgrade and restore verification.

These functions are intentionally CLI-only (no whitelist) and do not mutate
business facts. They give the repository-level K3 gate a stable way to verify
an isolated Frappe site without depending on a product page or private domain
implementation.
"""

import frappe

from shangshu_core.contracts import get_contract_snapshot
from shangshu_core.domains import ensure_registered_domains, list_domains, platform_contributions
from shangshu_core.runtime import list_published_processes


APP_DOMAINS = {
    "shangshu_core": "com.shangshu.core",
    "shangshu_finance": "com.shangshu.finance",
    "shangshu_ip": "com.shangshu.ip",
}

APP_PROCESSES = {
    "shangshu_finance": "com.shangshu.finance.expense_approval",
    "shangshu_ip": "com.shangshu.ip.trademark_application",
}


def verify_kernel_baseline(expected_apps=None):
    """Fail closed unless the isolated site matches the requested combination."""
    expected = frappe.parse_json(expected_apps or "[]")
    if not isinstance(expected, list) or "shangshu_core" not in expected:
        frappe.throw("内核基线检查必须声明包含 shangshu_core", frappe.ValidationError)

    installed = set(frappe.get_installed_apps())
    missing_apps = sorted(set(expected) - installed)
    unexpected_business_apps = sorted((installed & set(APP_DOMAINS)) - set(expected))
    if missing_apps or unexpected_business_apps:
        frappe.throw(
            f"站点 App 组合不匹配：缺少 {missing_apps or '-'}；多出 {unexpected_business_apps or '-'}",
            frappe.ValidationError,
        )

    ensure_registered_domains()
    domain_rows = {row["id"]: row for row in list_domains(include_disabled=True)}
    expected_domains = {APP_DOMAINS[app] for app in expected}
    missing_domains = sorted(expected_domains - set(domain_rows))
    disabled_domains = sorted(domain_id for domain_id in expected_domains if not domain_rows[domain_id]["enabled"])
    if missing_domains or disabled_domains:
        frappe.throw(
            f"领域注册不完整：缺少 {missing_domains or '-'}；停用 {disabled_domains or '-'}",
            frappe.ValidationError,
        )

    contract = get_contract_snapshot()
    if contract["api_version"].split(".")[0] != "1":
        frappe.throw("当前站点不是 platform_api 1.x", frappe.ValidationError)

    published = {row["definition_id"] for row in list_published_processes()}
    missing_processes = sorted(
        process_id for app, process_id in APP_PROCESSES.items() if app in expected and process_id not in published
    )
    if missing_processes:
        frappe.throw(f"已安装领域缺少已发布流程：{missing_processes}", frappe.ValidationError)

    contributions = platform_contributions()
    visible_domains = {row["id"] for row in contributions["domains"]}
    if not expected_domains.issubset(visible_domains):
        frappe.throw("启用领域未完整投影到平台贡献", frappe.ValidationError)

    return {
        "ok": True,
        "platform_api": contract["api_version"],
        "apps": sorted(set(expected)),
        "domains": sorted(expected_domains),
        "resource_counts": {
            section: len(contributions[section])
            for section in ("objects", "datasets", "processes", "actions", "tools", "services", "applications")
        },
    }
