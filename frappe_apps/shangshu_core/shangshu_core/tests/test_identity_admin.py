"""账号生命周期护栏：权限、保底管理员、分组与角色映射、凭据不回传。

这些断言全部在真实 Frappe 上执行；本地兼容模式不涉及本模块。
"""

import frappe
from frappe.tests.utils import FrappeTestCase
from unittest.mock import patch

from shangshu_core.public_api import execute_registered_action, list_identities, list_collaboration_people


class TestIdentityAdmin(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def _create(self, email, role="staff", group=""):
        return execute_registered_action(
            "platform.identity.create",
            {"email": email, "display_name": email.split("@")[0], "role": role,
             "initial_password": "pilot-strong-pw-1", "collaboration_group": group},
            True,
            frappe.generate_hash(length=24),
        )

    def test_create_maps_platform_role_and_group_and_never_returns_password(self):
        email = "idt-" + frappe.generate_hash(length=10) + "@example.invalid"
        result = self._create(email, "manager", "开发")
        self.assertEqual(result["result"]["role"], "manager")
        self.assertEqual(result["result"]["collaboration_group"], "开发")
        self.assertNotIn("password", str(result).lower(), "结果不得包含任何口令字段")
        roles = set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))
        self.assertIn("Desk User", roles)
        self.assertIn("Collaboration Manager", roles)
        self.assertNotIn("Expense Approver", roles, "协作管理不得再借用财务能力")
        self.assertEqual(
            frappe.db.get_value("Shangshu Identity", {"user": email}, "collaboration_group"), "开发"
        )
        person=next(row for row in list_collaboration_people() if row['display_name']==email.split('@')[0])
        self.assertEqual(person['user_name'],email)
        self.assertNotEqual(person['username'],email, '旧协作键不能当成Frappe用户名')
        self.assertEqual(person['identity_id'],frappe.db.get_value('Shangshu Identity',{'user':email},'identity_id'))

    def test_business_approver_role_is_explicit_assignable_and_revocable(self):
        """协作经理不自动获得业务审批权；管理员可以单独指定/更换审批人。"""
        role = "Pilot Expense Approver"
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)
        email = "idt-approver-" + frappe.generate_hash(length=10) + "@example.invalid"
        self._create(email, "manager")
        options = {"roles": [{"role": role, "label": "试用费用审批人", "assignable": True}]}
        with patch("shangshu_core.identity_admin.platform_contributions", return_value=options):
            def set_roles(business_roles):
                return execute_registered_action(
                    "platform.identity.role",
                    {"email": email, "roles": ["manager", "finance"], "business_roles": business_roles},
                    True, frappe.generate_hash(length=24),
                )
            set_roles([role])
            self.assertIn(role, frappe.get_roles(email))
            self.assertIn("Finance Approver", frappe.get_roles(email))
            set_roles([])
            self.assertNotIn(role, frappe.get_roles(email))
            self.assertIn("Finance Approver", frappe.get_roles(email))
            frappe.db.commit()  # Retain role/user fixtures across a rejected request.
            with self.assertRaises(frappe.ValidationError):
                set_roles(["System Manager"])
            staff = "idt-approver-staff-" + frappe.generate_hash(length=10) + "@example.invalid"
            self._create(staff, "staff")
            execute_registered_action("platform.identity.role",
                                      {"email": staff, "roles": ["staff"], "business_roles": [role]},
                                      True, frappe.generate_hash(length=24))
            projected = next(row for row in list_identities() if row["email"] == staff)
            self.assertEqual(projected["platform_roles"], ["staff"])

    def test_confirmation_is_required_and_duplicate_email_is_rejected(self):
        email = "idt-dup-" + frappe.generate_hash(length=10) + "@example.invalid"
        with self.assertRaisesRegex(frappe.ValidationError, "必须经过确认"):
            execute_registered_action(
                "platform.identity.create",
                {"email": email, "display_name": "未确认", "role": "staff", "initial_password": "pilot-pw-12345"},
                False,
                frappe.generate_hash(length=24),
            )
        self.assertFalse(frappe.db.exists("User", email), "未确认不得建号")
        self._create(email)
        with self.assertRaisesRegex(frappe.ValidationError, "已存在"):
            self._create(email)

    def test_invalid_group_and_short_password_are_rejected(self):
        email = "idt-bad-" + frappe.generate_hash(length=10) + "@example.invalid"
        with self.assertRaisesRegex(frappe.ValidationError, "collaboration_group|协作分组"):
            self._create(email, "staff", "人事")
        with self.assertRaisesRegex(frappe.ValidationError, "minLength=8|至少 8 位"):
            execute_registered_action(
                "platform.identity.create",
                {"email": email, "display_name": "短口令", "role": "staff", "initial_password": "short"},
                True,
                frappe.generate_hash(length=24),
            )

    def test_status_and_role_guard_keep_one_enabled_administrator(self):
        email = "idt-adm-" + frappe.generate_hash(length=10) + "@example.invalid"
        self._create(email, "admin")
        frappe.db.commit()  # A preceding successful create is a separate request.
        # 不能停用自己
        with self.assertRaisesRegex(frappe.ValidationError, "不能停用"):
            execute_registered_action("platform.identity.status", {"email": "Administrator", "enabled": False},
                                      True, frappe.generate_hash(length=24))
        # 停用后身份状态同步关闭，且不再出现在启用管理员集合里
        execute_registered_action("platform.identity.status", {"email": email, "enabled": False},
                                  True, frappe.generate_hash(length=24))
        self.assertFalse(frappe.db.get_value("User", email, "enabled"))
        self.assertEqual(frappe.db.get_value("Shangshu Identity", {"user": email}, "status"), "Disabled")
        # 重新启用后可以改角色；自己不能改自己
        execute_registered_action("platform.identity.status", {"email": email, "enabled": True},
                                  True, frappe.generate_hash(length=24))
        frappe.db.commit()
        with self.assertRaisesRegex(frappe.ValidationError, "不能修改"):
            execute_registered_action("platform.identity.role", {"email": "Administrator", "role": "staff"},
                                      True, frappe.generate_hash(length=24))
        execute_registered_action("platform.identity.role", {"email": email, "role": "staff"},
                                  True, frappe.generate_hash(length=24))
        roles = set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))
        self.assertNotIn("System Manager", roles)

    def test_list_identities_requires_system_manager_and_hides_credentials(self):
        self.assertTrue(list_identities(), "管理员可读账号清单")
        sample = list_identities()[0]
        for leaked in ("password", "api_key", "session"):
            self.assertNotIn(leaked, str(sample).lower(), f"清单不得包含 {leaked}")
        user = "idt-view-" + frappe.generate_hash(length=10) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": user, "first_name": "只读", "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        self.addCleanup(frappe.set_user, "Administrator")
        frappe.set_user(user)
        with self.assertRaises(frappe.PermissionError):
            list_identities()
