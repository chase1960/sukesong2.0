app_name = "shangshu_warehouse"
app_title = "尚书仓库"
app_publisher = "Shangshu"
app_description = "单仓库存与出入库流水"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe", "shangshu_core"]
shangshu_domain_contributions = ["shangshu_warehouse.domain.get_contribution"]
after_install = "shangshu_warehouse.install.after_install"
after_migrate = "shangshu_warehouse.install.after_migrate"
permission_query_conditions = {
    "Shangshu Stock Item": "shangshu_warehouse.permissions.query",
    "Shangshu Stock Movement": "shangshu_warehouse.permissions.query",
}
has_permission = {
    "Shangshu Stock Item": "shangshu_warehouse.permissions.check",
    "Shangshu Stock Movement": "shangshu_warehouse.permissions.check",
}

