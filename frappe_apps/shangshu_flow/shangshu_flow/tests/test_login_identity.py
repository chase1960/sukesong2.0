"""统一登录第一阶段测试：品牌登录页、注册关闭、身份接口、生产预检、登录落地、2FA 兼容。

HTTP 行为（重定向、开放重定向）已在浏览器与 curl 验收中覆盖，
这里覆盖可静态保证的部分：路由规则、context、模板文案、接口权限、
落地改写、升级站点/空站登录配置补齐、2FA 分支兼容。
"""

import json

import frappe
from frappe.tests.utils import FrappeTestCase

STAFF = "staff1@shangshu.local"
WORKFLOW_NAME = "费用报销审批"


def _fake_login_context():
    """模拟游客请求 /login?redirect-to=... 的最小 request 上下文。"""
    frappe.local.request = frappe._dict(
        args=frappe._dict({"redirect-to": "/app/shangshu-process-center"}),
        url="http://127.0.0.1:8000/login",
    )
    frappe.local.form_dict = frappe._dict()
    frappe.set_user("Guest")


class TestLoginRouteRule(FrappeTestCase):
    def test_login_route_rule_registered(self):
        rules = frappe.get_hooks("website_route_rules")
        login_rules = [
            r for r in rules if r.get("from_route") == "/login" and r.get("to_route") == "shangshu-login"
        ]
        self.assertTrue(login_rules, "/login 必须映射到 shangshu-login 页面")

    def test_after_request_hook_registered(self):
        hooks = frappe.get_hooks("after_request")
        self.assertIn("shangshu_flow.auth.on_login_after_request", hooks)


class TestLoginLanding(FrappeTestCase):
    def tearDown(self):
        frappe.set_user("Administrator")

    def _make_response(self, message="Logged In", home_page="/app"):
        data = json.dumps({"message": message, "home_page": home_page})
        resp = type("R", (), {"mimetype": "application/json", "data": data.encode()})
        return resp

    def test_landing_without_redirect_rewrites_home_page(self):
        from shangshu_flow.auth import on_login_after_request, DEFAULT_LANDING_PAGE

        frappe.local.form_dict = frappe._dict({"cmd": "login"})
        frappe.local.request = frappe._dict(args=frappe._dict({}))
        resp = self._make_response()
        request = type("Req", (), {"method": "POST"})
        on_login_after_request(resp, request)
        data = json.loads(resp.data)
        self.assertEqual(data["home_page"], DEFAULT_LANDING_PAGE)

    def test_landing_no_app_message_preserved(self):
        # Website User（无 Desk App）登录返回 message=No App，不得改写。
        from shangshu_flow.auth import on_login_after_request

        frappe.local.form_dict = frappe._dict({"cmd": "login"})
        frappe.local.request = frappe._dict(args=frappe._dict({}))
        resp = self._make_response(message="No App", home_page="/app")
        request = type("Req", (), {"method": "POST"})
        on_login_after_request(resp, request)
        # 保留原生 home_page 与 message
        self.assertEqual(json.loads(resp.data)["message"], "No App")
        self.assertEqual(json.loads(resp.data)["home_page"], "/app")

    def test_landing_website_user_not_rewritten(self):
        from unittest.mock import patch

        from shangshu_flow.auth import on_login_after_request

        # 用 mock 让 frappe.db.get_value 对 user_type 返回 Website User，
        # 从而不改动 Administrator 真实记录（测试失败也不污染管理员）。
        frappe.local.form_dict = frappe._dict({"cmd": "login"})
        frappe.local.request = frappe._dict(args=frappe._dict({}))
        frappe.set_user("Administrator")
        resp = self._make_response(message="Logged In", home_page="/app")
        request = type("Req", (), {"method": "POST"})

        def fake_get_value(doctype, name, fieldname):
            if fieldname == "user_type":
                return "Website User"
            return frappe.db.get_value(doctype, name, fieldname)

        with patch.object(frappe.db, "get_value", side_effect=fake_get_value):
            on_login_after_request(resp, request)
        self.assertEqual(json.loads(resp.data)["home_page"], "/app")
        # 确认 Administrator 真实 user_type 未被改动
        self.assertEqual(frappe.db.get_value("User", "Administrator", "user_type"), "System User")

    def test_landing_with_redirect_preserved(self):
        from shangshu_flow.auth import on_login_after_request

        frappe.local.form_dict = frappe._dict({"cmd": "login"})
        frappe.local.request = frappe._dict(args=frappe._dict({"redirect-to": "/app/shangshu-workflow-studio"}))
        resp = self._make_response(home_page="/app")
        request = type("Req", (), {"method": "POST"})
        on_login_after_request(resp, request)
        # 保留原生 home_page，不改写
        self.assertEqual(json.loads(resp.data)["home_page"], "/app")

    def test_non_login_request_not_touched(self):
        from shangshu_flow.auth import on_login_after_request

        frappe.local.form_dict = frappe._dict({"cmd": "other"})
        frappe.local.request = frappe._dict(args=frappe._dict({}))
        resp = self._make_response(home_page="/app")
        request = type("Req", (), {"method": "POST"})
        on_login_after_request(resp, request)
        self.assertEqual(json.loads(resp.data)["home_page"], "/app")


class TestLoginPageBranding(FrappeTestCase):
    def tearDown(self):
        frappe.set_user("Administrator")

    def test_login_context_is_branded_chinese(self):
        from shangshu_flow.www import shangshu_login

        _fake_login_context()
        context = shangshu_login.get_context(frappe._dict())
        self.assertEqual(context["title"], "登录 · 尚书")
        self.assertEqual(context["login_name_label"], "邮箱或用户名")
        self.assertEqual(frappe.local.lang, "zh")
        self.assertIn("/app/shangshu-process-center", context["ss_redirect_to"])

    def test_login_template_renders_chinese_without_frappe_brand(self):
        from shangshu_flow.www import shangshu_login

        _fake_login_context()
        context = shangshu_login.get_context(frappe._dict())
        context.update(
            {
                "name": "shangshu-login",
                "route": "shangshu-login",
                "pathname": "/login",
                "path": "shangshu-login",
                "base_template_path": "templates/base.html",
                "boot": {},
                "show_sidebar": 0,
                "full_width": 1,
            }
        )
        html = frappe.render_template("www/shangshu-login.html", context)
        self.assertIn("尚书工作台", html)
        self.assertIn("登录 · 尚书", html)
        self.assertIn("邮箱或用户名", html)
        self.assertIn("忘记密码", html)
        self.assertNotIn("Login to Frappe", html)
        self.assertNotIn("Forgot Password?", html)
        self.assertNotIn("Sign up", html)
        self.assertIn("login.call", html)
        self.assertIn('args.cmd = "login"', html)


class TestSignupDisabled(FrappeTestCase):
    def test_signup_flag_is_set(self):
        self.assertTrue(frappe.get_website_settings("disable_signup"), "站点必须关闭自助注册")

    def test_guest_sign_up_is_rejected(self):
        from frappe.core.doctype.user.user import sign_up

        frappe.set_user("Guest")
        with self.assertRaises(frappe.ValidationError):
            sign_up(email="someone@example.com", full_name="测试", redirect_to="/app")


class TestSessionContext(FrappeTestCase):
    def test_guest_is_rejected(self):
        from shangshu_flow.auth import get_session_context

        frappe.set_user("Guest")
        with self.assertRaises(frappe.PermissionError):
            get_session_context()

    def test_logged_in_identity_payload_uses_user_name(self):
        from shangshu_flow.auth import get_session_context

        frappe.set_user(STAFF)
        data = get_session_context()
        # 字段名必须是 user_name（可被 rename，不是永久 ID），并保留 email。
        self.assertIn("user_name", data)
        self.assertNotIn("user_id", data)
        self.assertEqual(data["user_name"], STAFF)
        self.assertEqual(data["email"], STAFF)
        self.assertIn("Desk User", data["roles"])
        self.assertFalse(data["is_system_manager"])

    def test_administrator_is_system_manager(self):
        from shangshu_flow.auth import get_session_context

        frappe.set_user("Administrator")
        data = get_session_context()
        self.assertEqual(data["user_name"], "Administrator")
        self.assertTrue(data["is_system_manager"])

    def test_payload_has_no_secrets(self):
        from shangshu_flow.auth import get_session_context

        frappe.set_user("Administrator")
        data = get_session_context()
        forbidden = {"pwd", "password", "sid", "api_secret", "csrf_token", "csrf_secret"}
        leaked = forbidden.intersection({key.lower() for key in data})
        self.assertEqual(leaked, set())


class TestProductionPreflight(FrappeTestCase):
    def test_preflight_flags_local_test_accounts(self):
        from shangshu_flow.auth import production_preflight

        report = production_preflight()
        self.assertFalse(report["ok"])
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("test_account_present", codes)

    def test_preflight_never_leaks_passwords(self):
        from shangshu_flow.auth import production_preflight

        report = production_preflight()
        self.assertNotIn("shangshu123", str(report))
        self.assertNotIn("admin\"", str(report).replace("Administrator", ""))

    def test_preflight_flags_enabled_test_account_with_known_password(self):
        from shangshu_flow.auth import production_preflight
        from unittest.mock import patch

        def only_staff_uses_default(user, _password):
            if user == "staff1@shangshu.local":
                return user
            raise frappe.AuthenticationError()

        with patch("frappe.utils.password.check_password", side_effect=only_staff_uses_default):
            report = production_preflight()
        self.assertTrue(any(
            issue["code"] == "test_account_default_password"
            and issue["user"] == "staff1@shangshu.local"
            for issue in report["issues"]
        ))

    def test_preflight_does_not_flag_disabled_test_account(self):
        from shangshu_flow.auth import production_preflight

        email = "staff1@shangshu.local"
        original = frappe.db.get_value("User", email, "enabled")
        try:
            frappe.db.set_value("User", email, "enabled", 0)
            report = production_preflight()
            self.assertFalse(any(issue["user"] == email for issue in report["issues"]))
        finally:
            frappe.db.set_value("User", email, "enabled", original)

    def test_assert_production_ready_raises_on_blocking(self):
        from shangshu_flow.auth import assert_production_ready

        # 本地站点存在测试账号，应触发阻断。
        with self.assertRaises(frappe.ValidationError):
            assert_production_ready()


class TestLoginFoundationMigration(FrappeTestCase):
    """升级站点与空站都能补齐/整理登录配置，且绝不触碰 Workflow。

    注意：ensure_login_foundation 是非破坏性幂等函数，不删除 Workspace、
    不改动用户数据。一次性用户一律用 try/finally + frappe.delete_doc 清理，
    禁止直接 SQL 删除 User；不依赖类级 setUp/tearDown 模糊清理。
    """

    def tearDown(self):
        frappe.set_user("Administrator")

    def _snapshot_workflow(self):
        wf = frappe.get_doc("Workflow", WORKFLOW_NAME)
        return {
            "states": len(wf.states),
            "transitions": len(wf.transitions),
            "workflow_data": wf.workflow_data,
        }

    @staticmethod
    def _delete_test_user(email):
        """用 frappe.delete_doc 清理一次性用户，确保 User/__Auth/Has Role 关联一起删。"""
        if frappe.db.exists("User", email):
            frappe.delete_doc("User", email, ignore_permissions=True, force=True)
            frappe.db.commit()

    def _cleanup_orphans(self):
        """清理孤儿密码/角色记录（仅 onetime% 前缀，用 Frappe 提供的 API）。"""
        from frappe.utils.password import delete_all_passwords_for

        for name in frappe.get_all("User", filters={"name": ("like", "onetime%")}, pluck="name"):
            self._delete_test_user(name)
        # 无 User 主记录的孤儿 __Auth
        orphan_auth = frappe.db.sql(
            "select name from `__Auth` where doctype='User' and name like 'onetime%'"
        )
        for row in orphan_auth:
            delete_all_passwords_for("User", row[0])
        # 孤儿 Has Role
        frappe.db.sql("delete from `tabHas Role` where parent like 'onetime%'")
        frappe.db.commit()

    def test_upgrade_site_completes_login_foundation_without_touching_workflow(self):
        from shangshu_flow.install import ensure_login_foundation

        before = self._snapshot_workflow()
        ensure_login_foundation()
        after = self._snapshot_workflow()
        self.assertEqual(before["states"], after["states"], "不得改动 Workflow states")
        self.assertEqual(before["transitions"], after["transitions"], "不得改动 transitions")
        self.assertEqual(before["workflow_data"], after["workflow_data"], "不得改动 workflow_data")

    def test_ensure_login_foundation_is_idempotent_and_does_not_delete_data(self):
        from shangshu_flow.install import ensure_login_foundation

        # 非破坏性：重复调用不报错，且绝不删除任何 Workspace。
        ws_before = {w["name"] for w in frappe.get_all("Workspace", fields=["name"])}
        ensure_login_foundation()
        ensure_login_foundation()
        ws_after = {w["name"] for w in frappe.get_all("Workspace", fields=["name"])}
        self.assertEqual(ws_before, ws_after, "ensure_login_foundation 不得删除任何 Workspace")

    def test_create_user_covers_absent_to_created(self):
        from shangshu_flow.install import _create_test_user

        # 一次性唯一邮箱，确保“用户不存在 → 创建成功”被真实覆盖，用随机密码。
        email = f"onetime-{frappe.generate_hash(length=8)}@shangshu.local"
        password = frappe.generate_hash(length=16)
        self.assertFalse(frappe.db.exists("User", email))
        try:
            user = _create_test_user(email, "一次性用户", password, roles=("Desk User",))
            self.assertEqual(user.email, email)
            self.assertTrue(frappe.db.exists("User", email))
            self.assertIn("Desk User", frappe.get_roles(email))
        finally:
            self._delete_test_user(email)

    def test_create_user_is_idempotent(self):
        from shangshu_flow.install import _create_test_user

        email = f"onetime2-{frappe.generate_hash(length=8)}@shangshu.local"
        password = frappe.generate_hash(length=16)
        try:
            _create_test_user(email, "一次性用户", password)
            # 同一邮箱再次调用不重复创建，不报错。
            _create_test_user(email, "一次性用户二", password)
            count = frappe.db.count("User", {"email": email})
            self.assertEqual(count, 1)
        finally:
            self._delete_test_user(email)

    def test_one_time_user_cascade_and_cleanup(self):
        from shangshu_flow.install import _create_test_user

        email = f"onetime-cascade-{frappe.generate_hash(length=6)}@shangshu.local"
        password = frappe.generate_hash(length=16)
        try:
            _create_test_user(email, "级联清理", password, roles=("Desk User",))
            # 创建后：User / __Auth / Has Role 三处均存在。
            self.assertTrue(frappe.db.exists("User", email))
            self.assertTrue(
                frappe.db.sql(
                    "select 1 from `__Auth` where doctype='User' and name=%s", email
                ),
                "密码记录应存在",
            )
            self.assertTrue(
                frappe.db.sql(
                    "select 1 from `tabHas Role` where parent=%s and role='Desk User'", email
                ),
                "角色记录应存在",
            )
        finally:
            self._delete_test_user(email)
        # delete_doc 后三处均不存在。
        self.assertFalse(frappe.db.exists("User", email))
        self.assertFalse(
            frappe.db.sql("select 1 from `__Auth` where doctype='User' and name=%s", email),
            "密码记录应被清除",
        )
        self.assertFalse(
            frappe.db.sql("select 1 from `tabHas Role` where parent=%s", email),
            "角色记录应被清除",
        )

    def test_orphan_cleanup_zeroes_all_tables(self):
        # 清理可能来自前一次运行的孤儿数据，断言三表清零。
        self._cleanup_orphans()
        user = frappe.db.count("User", {"name": ("like", "onetime%")})
        auth = frappe.db.sql(
            "select count(*) from `__Auth` where doctype='User' and name like 'onetime%'"
        )[0][0]
        role = frappe.db.sql("select count(*) from `tabHas Role` where parent like 'onetime%'")[0][0]
        self.assertEqual(user, 0)
        self.assertEqual(auth, 0)
        self.assertEqual(role, 0)


class TestTwoFactorBranches(FrappeTestCase):
    """2FA 响应分支兼容测试：验证 2FA 开启时登录进入 verification 分支、落地不改写。

    临时开启 System Settings 2FA，断言 2FA 开启生效、on_login_after_request 面对
    verification 响应不改写 home_page（不破坏 OTP）。tearDown 恢复配置。
    注意：此为响应分支兼容验证，非端到端 OTP 实测，也未使用真实的临时 2FA 配置用户。
    """

    def setUp(self):
        self._ss = frappe.get_doc("System Settings")
        self._prev_enabled = self._ss.enable_two_factor_auth

    def tearDown(self):
        frappe.db.set_value("System Settings", "System Settings", "enable_two_factor_auth", self._prev_enabled)
        frappe.db.commit()
        frappe.set_user("Administrator")

    def _verification_response(self):
        data = json.dumps(
            {
                "message": "Logged In",
                "home_page": "/app",
                "verification": {"method": "OTP App", "setup": True},
                "tmp_id": "abc123",
            }
        )
        return type("R", (), {"mimetype": "application/json", "data": data.encode()})

    def test_enabling_2fa_changes_system_setting(self):
        frappe.set_user("Administrator")
        frappe.db.set_value("System Settings", "System Settings", "enable_two_factor_auth", 1)
        frappe.db.commit()
        self.assertTrue(frappe.get_doc("System Settings").enable_two_factor_auth)

    def test_landing_hook_preserves_2fa_verification_response(self):
        from shangshu_flow.auth import on_login_after_request

        frappe.set_user("Administrator")
        frappe.local.form_dict = frappe._dict({"cmd": "login"})
        frappe.local.request = frappe._dict(args=frappe._dict({}))
        request = type("Req", (), {"method": "POST"})
        resp = self._verification_response()
        on_login_after_request(resp, request)
        data = json.loads(resp.data)
        # verification/tmp_id 分支必须保留（2FA 未完成，不得改写 home_page 破坏 OTP）。
        self.assertIn("verification", data)
        self.assertEqual(data["tmp_id"], "abc123")
        self.assertEqual(data["home_page"], "/app")
