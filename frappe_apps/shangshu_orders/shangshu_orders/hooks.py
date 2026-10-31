app_name = "shangshu_orders"
app_title = "尚书订单"
app_publisher = "Shangshu"
app_description = "库存出库与外采拨款"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe", "shangshu_core", "shangshu_warehouse", "shangshu_finance"]
shangshu_domain_contributions = ["shangshu_orders.domain.get_contribution"]
after_install = "shangshu_orders.install.setup"
after_migrate = "shangshu_orders.install.setup"
permission_query_conditions = {"Shangshu Order": "shangshu_orders.service.permission_query"}
has_permission = {"Shangshu Order": "shangshu_orders.service.permission"}

