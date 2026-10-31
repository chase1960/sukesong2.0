"""受管记录侧（**真跑库**那部分）的「主体范围」判据（PKG-117-T01 内核半）。

⚠️ **这份判据需要真实 bench**（要 User / 会话 / 组织事实）⇒ **本机跑不了**，
由有 bench 的环境执行。**纯规则**那部分（形状、继承链、编译期校验、物理权限落法、
晋升定义拼装）在 `test_subject_access.py`（**可脱 frappe 跑**）。

**测试通过 =** 下面每一条都成立：

- **MA-01** 新形状列按**列的主体范围**判 ⇒ 部门外的人**看不见**那一列
  （`_fields` 的读投影）。
- **MA-02** 旧形状列（角色键）**照旧判** —— 建模对象链**行为不变**。
- **MA-03** **同一份字段列表里两种形状共存**，各走各的（不互相兜底）。
- **MA-04** **「筛」并进了「读」**（2026-10-27 降维）⇒ 能读就能筛；
  看得见 ≠ 能拿它筛**不再能表达**
  （`filterable_fields` 与 `search_fields` 分开）。
- **MA-05** 部门级表 ⇒ 表外的人**整张表都读不到**（列没声明 ⇒ 继承表级）。
- **MA-06** 主体判定**走 org_admin 的判定口**（`subject_allows` /
  `field_subject_allows`）：任职部门 / 管辖范围命中才算数。
- **MA-07** **管理员旁路**：`subject_context` 给的 `is_admin`（Frappe 角色
  `System Manager`）为真 ⇒ **四档全部放行**（含 `none`）；普通员工的
  `is_admin` 为假 ⇒ 在 `none` 档**仍被拒**。
- **MA-08** `subject_context` 的键集 = `user` / `member_of` /
  `head_departments` / `is_admin`（**部门装的是 key**，不是标题）。
"""

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records, org_admin
from shangshu_core import subject_access


GLOBAL = {"scope": "global"}
FINANCE = {"scope": "department", "departments": ["财务"]}
NONE = {"scope": "none"}


def staff_user():
    """造一个**没有任何组织任职**的普通员工（⇒ 部门档一律不命中）。"""
    email = "subject-staff-" + uuid.uuid4().hex[:8] + "@example.invalid"
    frappe.get_doc({"doctype": "User", "email": email, "first_name": "主体员工",
                    "enabled": 1, "send_welcome_email": 0,
                    "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
    return email


def admin_user():
    """造一个**管理员**（Frappe 角色 `System Manager`）⇒ 主体判定对他旁路。"""
    email = "subject-admin-" + uuid.uuid4().hex[:8] + "@example.invalid"
    frappe.get_doc({"doctype": "User", "email": email, "first_name": "主体管理员",
                    "enabled": 1, "send_welcome_email": 0,
                    "roles": [{"role": "System Manager"}]}).insert(ignore_permissions=True)
    return email


class TestSubjectAccessOnRecords(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.email = staff_user()
        self.addCleanup(self._drop_user)

    def _drop_user(self):
        self._drop_email(self.email)

    def _drop_email(self, email):
        frappe.set_user("Administrator")
        if frappe.db.exists("User", email):
            frappe.delete_doc("User", email, ignore_permissions=True, force=True)
            frappe.db.commit()

    def _as_staff(self):
        frappe.set_user(self.email)

    # ---------- MA-01 新形状列按列的主体范围判 ----------
    def test_部门外的人看不见部门列(self):
        """列声明「部门：财务」⇒ 表外员工**读不到这一列**。"""
        compiled = {"fields": [
            {"id": "amount", "label": "金额", "type": "decimal", "deprecated": False,
             "access": {"read": FINANCE, "write": GLOBAL, "download": GLOBAL}},
            {"id": "day", "label": "日期", "type": "date", "deprecated": False,
             "access": {"read": GLOBAL, "write": GLOBAL, "download": GLOBAL}},
        ]}
        self._as_staff()
        visible = [field["id"] for field in model_records._fields(compiled, {"Desk User"})]
        self.assertIn("day", visible, "全局列应当看得见")
        self.assertNotIn("amount", visible, "部门外的人**看得见**了部门列 —— 判定没生效")

    # ---------- MA-02 旧形状列照旧判 ----------
    def test_旧形状列照旧判(self):
        """建模对象链（角色键）：未声明 read ⇒ **不限制**（行为不变）。"""
        compiled = {"fields": [
            {"id": "plain", "label": "普通列", "type": "text", "deprecated": False},
            {"id": "limited", "label": "受限列", "type": "text", "deprecated": False,
             "read_roles": ["System Manager"]},
        ]}
        self._as_staff()
        visible = [field["id"] for field in model_records._fields(compiled, {"Desk User"})]
        self.assertIn("plain", visible, "旧链未声明 read = 不限制，行为不能变")
        self.assertNotIn("limited", visible, "声明了别的角色 ⇒ 读不到")

    # ---------- MA-03 两种形状共存 ----------
    def test_同一份列表两种形状共存(self):
        """一份列表里，带 `access` 的走新模型，带 `read_roles` 的走旧模型，各走各的。"""
        compiled = {"fields": [
            {"id": "new_shape", "label": "新形状列", "type": "text", "deprecated": False,
             "access": {"read": GLOBAL, "write": GLOBAL, "download": GLOBAL}},
            {"id": "old_shape", "label": "旧形状列", "type": "text", "deprecated": False,
             "read_roles": ["Desk User"]},
        ]}
        self._as_staff()
        visible = [field["id"] for field in model_records._fields(compiled, {"Desk User"})]
        self.assertEqual(sorted(visible), ["new_shape", "old_shape"])

    # ---------- MA-04 「筛」并进了「读」（2026-10-27 降维） ----------
    def test_看得见就能拿它筛(self):
        """**降维**（用户 2026-10-27 06:2x 口径）：「筛」并进「读」⇒
        **能读就能筛**；「看得见但不许筛」**不再能表达**。

        这一列的声明里**还留着旧的 `filter` 键**（读＝全局、筛＝个人）
        ⇒ 按「视同未声明」处理 ⇒ 筛跟着读走 ⇒ **能筛**。
        """
        compiled = {"fields": [
            {"id": "amount", "label": "金额", "type": "text", "deprecated": False,
             "access": {"read": GLOBAL,
                        "filter": {"scope": "personal", "users": ["someone-else@example.invalid"]},
                        "write": GLOBAL, "download": GLOBAL}},
        ]}
        self._as_staff()
        capabilities = model_records._query_capabilities(compiled, {"Desk User"})
        self.assertIn("amount", capabilities["search_fields"], "读得到就该能被搜到")
        self.assertIn("amount", capabilities["filterable_fields"],
                      "「筛」已并进「读」⇒ 读得到就该能筛（旧的那个 filter 键视同未声明）")
        # **能筛的字段集合＝能搜的字段集合**（同一份判定）。
        self.assertEqual(sorted(capabilities["filterable_fields"]),
                         sorted(capabilities["search_fields"]),
                         "筛与搜用了两份判定")

    # ---------- MA-05 部门级表：表外的人整张表都读不到 ----------
    def test_部门级表的列继承表级(self):
        """列**没声明** ⇒ 继承表级 ⇒ 部门外的人连这一列都读不到。"""
        compiled = {"fields": [
            {"id": "amount", "label": "金额", "type": "decimal", "deprecated": False},
        ], "access": {"read": FINANCE, "write": FINANCE, "download": FINANCE,
                     "record_scope": "all"}}
        self._as_staff()
        visible = [field["id"] for field in model_records._fields(compiled, {"Desk User"})]
        self.assertEqual(visible, [], "部门级表的列对表外员工**可见**了 —— 继承表级没生效")

    # ---------- MA-06 主体判定走 org_admin 的判定口 ----------
    def test_org_admin_subject_entry_points(self):
        """`org_admin.subject_allows` / `field_subject_allows` 按任职/管辖判。"""
        ctx = {"user": self.email, "member_of": ["财务"], "head_departments": []}
        self.assertTrue(org_admin.subject_allows(self.email, FINANCE, ctx=ctx),
                        "任职部门命中 ⇒ 该部门的主体范围应当放行")
        self.assertFalse(org_admin.subject_allows(self.email, FINANCE,
                                                   ctx={"user": self.email, "member_of": ["销售"],
                                                        "head_departments": []}),
                         "不在那个部门 ⇒ 不该放行")
        # 管辖范围也算命中（部门负责人看得见所辖部门）
        self.assertTrue(org_admin.subject_allows(
            self.email, FINANCE,
            ctx={"user": self.email, "member_of": [], "head_departments": ["财务"]}),
            "管辖范围命中 ⇒ 应当放行")
        # 单列单操作（组合口）
        field = {"id": "amount", "access": {"read": FINANCE, "write": FINANCE,
                                            "download": FINANCE}}
        self.assertTrue(org_admin.field_subject_allows(self.email, field, "read", ctx=ctx))
        self.assertFalse(org_admin.field_subject_allows(
            self.email, field, "read",
            ctx={"user": self.email, "member_of": ["销售"], "head_departments": []}))

    def test_subject_context_shape(self):
        """`subject_context` 给的是「主体」那份字典（不是角色）。"""
        ctx = org_admin.subject_context(self.email)
        self.assertEqual(sorted(ctx), ["head_departments", "is_admin", "member_of", "user"])
        self.assertEqual(ctx["user"], self.email.lower())
        self.assertIsInstance(ctx["member_of"], list)
        self.assertIsInstance(ctx["head_departments"], list)
        self.assertIsInstance(ctx["is_admin"], bool)

    # ---------- MA-07 管理员旁路 ----------
    def test_管理员对四档全部放行(self):
        """测试通过 = 管理员（`System Manager`）对 global/department/personal/none
        **都放行**；普通员工在 `none` 档**仍被拒**。"""
        admin = admin_user()
        self.addCleanup(self._drop_email, admin)
        admin_ctx = org_admin.subject_context(admin)
        self.assertTrue(admin_ctx["is_admin"], "管理员的主体上下文里 is_admin 应当为真")
        for scope in (GLOBAL, FINANCE,
                      {"scope": "personal", "users": ["nobody@example.invalid"]}, NONE):
            self.assertTrue(org_admin.subject_allows(admin, scope, ctx=admin_ctx),
                            "管理员应当对「%s」这一档放行" % scope["scope"])
        staff_ctx = org_admin.subject_context(self.email)
        self.assertFalse(staff_ctx["is_admin"], "普通员工不是管理员")
        self.assertFalse(org_admin.subject_allows(self.email, NONE, ctx=staff_ctx),
                         "普通员工在「无人」这一档应当被拒")

    def test_主体判定不查库(self):
        """`subject_access.subject_allows` 只认给它的 subject（**不查库**）。"""
        self.assertTrue(subject_access.subject_allows(GLOBAL, {"user": "a@b.com"}))
        self.assertFalse(subject_access.subject_allows(GLOBAL, {"user": ""}),
                         "没有登录用户 ⇒ 不该放行")
