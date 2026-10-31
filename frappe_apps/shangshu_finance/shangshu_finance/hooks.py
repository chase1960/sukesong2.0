app_name = "shangshu_finance"
app_title = "尚书财务"
app_publisher = "Shangshu"
app_description = "票据、报销、过账、应付与付款插件"
app_email = "dev@shangshu.local"
app_license = "MIT"
# 2026-10-22（PKG-036-T02）：发票原件**改由文件域放**（走 `files.upload`）⇒
# 财务域对文件域是**必装依赖** ⇒ App 级依赖也要写上
# （内核 `check_registered_manifests` 核「manifest 依赖与 App 依赖一致」，两边要对得上）。
required_apps = ["frappe", "shangshu_core", "shangshu_files"]

after_install = "shangshu_finance.install.after_install"
after_migrate = "shangshu_finance.install.after_migrate"
before_tests = "shangshu_finance.install.before_tests"

shangshu_domain_contributions = ["shangshu_finance.domain.get_contribution"]

permission_query_conditions = {
    "Shangshu Funding Request": "shangshu_finance.funding.permission_query",
    "Shangshu Funding Transfer": "shangshu_finance.funding.permission_query",
    "Shangshu Expense Claim": "shangshu_finance.permissions.expense_claim_query",
}
has_permission = {
    "Shangshu Funding Request": "shangshu_finance.funding.permission",
    "Shangshu Funding Transfer": "shangshu_finance.funding.permission",
    "Shangshu Expense Claim": "shangshu_finance.permissions.expense_claim_permission",
}
