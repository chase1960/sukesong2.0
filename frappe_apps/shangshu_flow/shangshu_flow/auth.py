"""统一身份第一阶段：只读身份接口与生产预检。

- get_session_context：下一阶段 Node OAuth/BFF 将调用此接口获取当前身份，
  本轮不实现任何 OAuth 流程。
- production_preflight：检查测试账号与开发默认密码是否泄漏到目标环境，
  只报告结果，不读取、不输出任何密码。无 whitelist，HTTP 一律 403。
- assert_production_ready：存在 block/high 问题时抛出异常并返回非零退出状态，
  供 CI/部署执行 `bench execute shangshu_flow.auth.assert_production_ready`。
"""

import json

import frappe
from frappe import _

TEST_ACCOUNT_EMAILS = (
    "staff1@shangshu.local",
    "manager1@shangshu.local",
    "finance1@shangshu.local",
)

# 默认登录落地页（无 redirect-to 时）。
DEFAULT_LANDING_PAGE = "/app/shangshu-workbench"

# 预检认为不可部署的问题等级。
BLOCKING_LEVELS = ("block", "high")


def on_login_after_request(response, request):
    """登录成功的默认落地决策（after_request，晚于 set_user_info）。

    LoginManager.set_user_info 在 on_session_creation 之后才写 home_page，
    因此必须在响应构建后的 after_request 里改，才会真正生效。

    仅改写**真正成功登录的 System User**（Frappe User.user_type == System User）
    且未携带显式 redirect-to 的响应，把 home_page 改为尚书工作台 Page。
    - message == "No App"：这是 Website User（无 Desk App）登录，保留 Frappe
      原生 home_page 行为，不改写。
    - Website User / 非 System User：保留原生 home_page，不改写。
    - 带 URL redirect-to：保留原生（login.js 优先用 URL redirect-to 跳转）。
    - 2FA verification 分支：尚未真正登录，不改写。
    """
    if request.method != "POST":
        return
    if frappe.local.form_dict.get("cmd") != "login":
        return
    # login.js 实际读取页面 URL 的 redirect-to（get_url_arg），而非 POST body。
    if frappe.local.request.args.get("redirect-to"):
        return
    if getattr(response, "mimetype", "") != "application/json" or not response.data:
        return
    try:
        data = json.loads(response.data)
    except Exception:
        return
    # 2FA 流程：message=Logged In 但带 verification/tmp_id，未真正登录，不改写。
    if data.get("verification") is not None or data.get("tmp_id"):
        return
    # 只处理真正的 System User 桌面登录成功。
    if data.get("message") != "Logged In":
        return
    user = frappe.session.user
    if user in ("Guest", None):
        return
    user_type = frappe.db.get_value("User", user, "user_type")
    if user_type != "System User":
        return
    data["home_page"] = DEFAULT_LANDING_PAGE
    response.data = json.dumps(data, separators=(",", ":")).encode()


@frappe.whitelist()
def get_session_context():
    """当前登录身份的最小只读快照。必须登录后调用。

    注意：`user_name` 是 Frappe User.name（本例即 email），**可被 rename**，
    不是永久身份标识。下一阶段必须建立不可变 Shangshu Identity ID 后，
    才能作为 OAuth subject；Node 侧不得把 email / user_name 当永久外键。
    """
    if frappe.session.user in ("Guest", None):
        frappe.throw(_("需要登录后才能获取身份信息"), frappe.PermissionError)

    roles = list(frappe.get_roles())
    return {
        "user_name": frappe.session.user,
        "display_name": frappe.utils.get_fullname(frappe.session.user),
        "email": frappe.db.get_value("User", frappe.session.user, "email"),
        "roles": roles,
        "language": frappe.local.lang,
        "is_system_manager": "System Manager" in roles,
    }


def production_preflight():
    """生产预检：发现启用的测试账号或开发默认密码时给出阻断/高危结论。

    无 whitelist：HTTP 调用（含已登录用户）一律 403，仅供部署/CI 通过
    bench execute 或测试直调。通过 frappe.utils.password.check_password 比对
    已知开发密码，只产生“是否命中”的结论，不读取、不返回、不记录任何密码。
    """
    from frappe.utils.password import check_password
    from shangshu_flow.install import TEST_USER_PASSWORD

    issues = []

    for email in TEST_ACCOUNT_EMAILS:
        if not frappe.db.get_value("User", email, "enabled"):
            continue
        issues.append(
            {
                "level": "block",
                "code": "test_account_present",
                "user": email,
                "detail": "验收测试账号仍处于启用状态，正式部署前必须禁用。",
            }
        )
        try:
            check_password(email, TEST_USER_PASSWORD)
        except frappe.AuthenticationError:
            pass
        except Exception:
            issues.append(
                {
                    "level": "high",
                    "code": "test_account_password_check_failed",
                    "user": email,
                    "detail": "测试账号初始口令检查未完成，请人工复核。",
                }
            )
        else:
            issues.append(
                {
                    "level": "high",
                    "code": "test_account_default_password",
                    "user": email,
                    "detail": "测试账号仍在使用公开的开发初始口令，内部试用录入真实数据前须处理。",
                }
            )

    try:
        check_password("Administrator", "admin")
        issues.append(
            {
                "level": "high",
                "code": "admin_default_password",
                "user": "Administrator",
                "detail": "Administrator 仍在使用已知开发密码，生产部署前必须修改。",
            }
        )
    except frappe.AuthenticationError:
        pass
    except Exception:
        # 密码校验的基础设施异常不应让预检崩溃，仅标记为需人工复核。
        issues.append(
            {
                "level": "high",
                "code": "admin_password_check_failed",
                "user": "Administrator",
                "detail": "Administrator 默认密码检查未完成，请人工复核。",
            }
        )

    return {"ok": not issues, "issues": issues}


def assert_production_ready():
    """生产可部署断言：存在 block/high 问题时抛异常并返回非零退出状态。

    供 CI/部署执行 `bench --site <site> execute shangshu_flow.auth.assert_production_ready`。
    `frappe.throw(..., title=...)` 抛 ValidationError，bench execute 捕获后返回非零。
    """
    report = production_preflight()
    blocking = [issue for issue in report["issues"] if issue["level"] in BLOCKING_LEVELS]
    if blocking:
        detail = "；".join(f"{issue['code']} ({issue['user']}): {issue['detail']}" for issue in blocking)
        frappe.throw(_("生产预检未通过：{0}").format(detail), title=_("部署阻断"))
    frappe.response["message"] = "生产预检通过"
    return 0
