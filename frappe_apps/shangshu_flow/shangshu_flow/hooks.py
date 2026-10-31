app_name = "shangshu_flow"
app_title = "尚书流程"
app_publisher = "Shangshu"
app_description = "尚书流程设计器与流程中心"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe"]

after_install = "shangshu_flow.install.after_install"
after_migrate = "shangshu_flow.install.after_migrate"
before_tests = "shangshu_flow.install.before_tests"

app_include_css = "/assets/shangshu_flow/css/shangshu_flow.css?v=20260831-5"
app_include_js = "/assets/shangshu_flow/js/platform_shell.js?v=20260831-5"

# 尚书统一登录入口（第一阶段）：把 /login 交给本 App 的 www/shangshu-login 渲染。
# 认证、会话、限流、2FA 与 redirect 处理仍全部走 Frappe 原生：
# context 复用 frappe.www.login.get_context，模板复用原生 login.js。
website_route_rules = [
    {"from_route": "/login", "to_route": "shangshu-login"},
]

# 默认登录落地：无 redirect-to 的登录成功落到尚书工作台 Page。
# LoginManager.set_user_info 在 on_session_creation 之后才写 home_page，
# 因此用 after_request 在响应构建后改写。带 redirect-to 的请求由原生
# sanitize_redirect 处理，不被覆盖。
after_request = ["shangshu_flow.auth.on_login_after_request"]

permission_query_conditions = {
    "Process Copy": "shangshu_flow.permissions.process_copy_query",
    "Expense Request": "shangshu_flow.permissions.expense_request_query",
}
has_permission = {
    "Process Copy": "shangshu_flow.permissions.process_copy_permission",
    "Expense Request": "shangshu_flow.permissions.expense_request_permission",
}
