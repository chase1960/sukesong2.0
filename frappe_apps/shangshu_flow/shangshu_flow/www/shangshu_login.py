# 尚书统一登录入口（第一阶段）。
#
# 只做品牌与文案层：认证、会话、限流、2FA、忘记密码与 redirect 处理
# 全部保持 Frappe 原生——context 完全复用 frappe.www.login.get_context，
# 模板原样复用原生 login.js（含 2FA 与 redirect 分支）。
#
# 已登录用户访问本页时的跳转行为由原生 get_context 的 frappe.Redirect 决定。

import frappe
from frappe.www.login import get_context as frappe_login_get_context
from frappe.www.login import sanitize_redirect

no_cache = True

LOGIN_NAME_LABEL = "邮箱或用户名"


def get_context(context):
    # 游客页面语言协商：cookie/Accept-Language 可能解析为英文。
    # 本页是纯中文产品入口，渲染期把会话语言钉扎为 zh，
    # 使 login.js 内嵌的服务端翻译串与错误提示均为中文。
    frappe.local.lang = "zh"

    context = frappe_login_get_context(context)

    context["title"] = "登录 · 尚书"
    context["login_name_label"] = LOGIN_NAME_LABEL
    # 渲染期兜底：注册入口由 Website Settings.disable_signup 关闭，
    # 这里保证模板分支与原生一致。
    context["ss_signup_disabled"] = bool(context.get("disable_signup"))

    # 与原生 login.js 的跳转目标保持一致：只允许同域路径，
    # sanitize_redirect 是 Frappe 原生实现。
    context["ss_redirect_to"] = sanitize_redirect(
        frappe.local.request.args.get("redirect-to")
    ) or ""

    return context
