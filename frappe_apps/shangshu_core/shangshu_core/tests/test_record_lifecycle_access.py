"""受管对象的**回收/恢复**权限：必须与其它入口**同一份有效定义**。

**背景**（原收敛条目 02 · 「撤掉什么」第 ① 项）：
`shangshu_core.record_lifecycle.allowed()` 只认**旧三键**
（`read_roles`／`write_roles`／`recycle_roles`）⇒ 而**受管表这条链**
（PKG-117-T01 之后）走的是**主体范围**新模型（`access` 是
「五操作 × 全局/部门/个人/无人」）⇒ 旧三键在这个形状里**根本不存在**
⇒ `access.get('read_roles', [])` 取到空列表 ⇒ 非管理员**一律被拒**
⇒ 部门成员即使**表级写档是「部门」**、本人就在那个部门，也**回收不了**。

**测试通过 = 下面每一条都成立**（编号 RL-xx）：

- **RL-01** 受管表（表级 `access` 是主体范围形状）＋ 本人**在该部门的写档内**
  ⇒ **允许**回收/恢复。
  （改之前：这里被旧三键判成「拒绝」⇒ 部门成员被误拒。）
- **RL-02** 同一条声明，但本人**不在**那个部门 ⇒ **拒绝**（不许放宽）。
- **RL-03** 表级写档是「无人（none）」⇒ **拒绝**（**管理员也不例外** ——
  这条链的 `none` 档**不含**管理员旁路，与 `subject_access` 的口径一致）。
- **RL-04** 管理员（`System Manager`）⇒ 放行（既有语义不变）。
- **RL-05** **建模对象链行为不变**：声明是**旧三键**形状 ⇒ 仍按旧三键判
  （`read_roles`/`write_roles`/`recycle_roles` 都要命中）⇒ 防把另一条链弄坏。
- **RL-06** 表级 `access` 声明**坏了/缺操作** ⇒ **拒绝**（fail-closed，不猜不放行）。
- **RL-07** 「回收/恢复」这个操作**落在写档上**（与其它入口同一份定义）：
  列级写档更严时，以列级为准（继承链 = 列 → 列的读 → 表 → 表的读）。
"""

import os
import sys
import unittest

_CORE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _CORE_ROOT not in sys.path:
    sys.path.insert(0, _CORE_ROOT)

try:  # 真实 frappe 在场 ⇒ 走真路径；不在 ⇒ 装桩（脱库跑）
    import frappe  # noqa: F401
    HAVE_FRAPPE = True
except ImportError:  # pragma: no cover - 取决于运行环境
    HAVE_FRAPPE = False

if not HAVE_FRAPPE:
    # 用**仓库里那一份**公共装载办法（计划 §十三「同一套装载办法只留这一份」）
    import importlib.util as _ilu

    _SEAM = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "scripts", "tests",
        "_f_module_seam.py"))
    _spec = _ilu.spec_from_file_location("_f_module_seam", _SEAM)
    _seam = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_seam)
    _seam.install_stub_package("frappe")
    _seam.install_stub_package("pypika")


class TestRecordLifecycleAccess(unittest.TestCase):
    """RL-01～RL-07。"""

    def _allowed(self, compiled, roles, subject=None):
        from shangshu_core import record_lifecycle
        return record_lifecycle.allowed(compiled, roles, subject=subject)

    # **主体上下文**（`org_admin.subject_context` 的形状）：
    # 「现在这个人」是谁、他属哪些部门、他管哪些部门、他是不是管理员。
    # ⚠️ **离线判据自己给**（不查库）—— 线上由内核现取（不缓存）。
    DEPT_MEMBER = {"user": "zhang@x.com", "member_of": ["财务"],
                   "head_departments": [], "is_admin": False}
    OUTSIDER = {"user": "li@x.com", "member_of": ["法务"],
                "head_departments": [], "is_admin": False}

    # ---------- 受管表链（主体范围） ----------

    def test_RL01_department_member_may_recycle_within_own_department(self):
        """RL-01 部门成员在**自己部门的写档**内 ⇒ 允许回收。

        改之前：`allowed()` 取 `access.get('read_roles', [])` ⇒ 空 ⇒ 一律拒。
        """
        compiled = {
            "access": {
                "read": {"scope": "department", "departments": ["财务"]},
                "write": {"scope": "department", "departments": ["财务"]},
                "download": {"scope": "department", "departments": ["财务"]},
                "record_scope": "own",
            }
        }
        from shangshu_core import subject_access
        subject = {"user": "zhang@x.com", "member_of": ["财务"],
                   "head_departments": [], "is_admin": False}
        # 先确认主体判定本身是放行的（避免把主体判定的错算到本函数头上）
        scope = subject_access.resolve_op_scope({}, compiled["access"], "write")
        self.assertTrue(subject_access.subject_allows(scope, subject),
                        "主体判定本身不该拒（这条判据的前提）")
        self.assertTrue(self._allowed(compiled, {"Desk User"}, subject=self.DEPT_MEMBER),
                        "本部门成员被旧三键误拒了（RL-01）")

    def test_RL02_outsider_may_not_recycle(self):
        """RL-02 不在该部门 ⇒ 拒绝（不许放宽）。"""
        compiled = {
            "access": {
                "read": {"scope": "department", "departments": ["财务"]},
                "write": {"scope": "department", "departments": ["财务"]},
                "download": {"scope": "department", "departments": ["财务"]},
                "record_scope": "own",
            }
        }
        from shangshu_core import subject_access
        subject = {"user": "li@x.com", "member_of": ["法务"],
                   "head_departments": [], "is_admin": False}
        scope = subject_access.resolve_op_scope({}, compiled["access"], "write")
        self.assertFalse(subject_access.subject_allows(scope, subject),
                         "主体判定本身就该拒（这条判据的前提）")
        self.assertFalse(self._allowed(compiled, {"Desk User"}, subject=self.OUTSIDER),
                         "非本部门的人被放行了（RL-02）")

    def test_RL03_none_scope_is_denied(self):
        """RL-03 表级写档是「无人」⇒ 拒绝。"""
        compiled = {
            "access": {
                "read": {"scope": "none"},
                "write": {"scope": "none"},
                "download": {"scope": "none"},
                "record_scope": "own",
            }
        }
        self.assertFalse(self._allowed(compiled, {"Desk User"}, subject=self.DEPT_MEMBER),
                         "「无人」档被放行了（RL-03）")

    def test_RL04_admin_is_allowed(self):
        """RL-04 管理员放行（既有语义不变）。"""
        compiled = {
            "access": {
                "read": {"scope": "none"},
                "write": {"scope": "none"},
                "download": {"scope": "none"},
                "record_scope": "own",
            }
        }
        self.assertTrue(self._allowed(compiled, {"System Manager"}),
                        "管理员被拒了（RL-04）")

    # ---------- 建模对象链（旧三键）行为不变 ----------

    def test_RL05_legacy_role_keys_still_decide(self):
        """RL-05 旧三键形状 ⇒ 仍按旧三键判（**建模对象链行为不变**）。

        旧口径 = `read_roles`／`write_roles`／`recycle_roles` **三者都要命中**。
        """
        legacy = {
            "access": {
                "read_roles": {"Desk User"},
                "write_roles": {"Desk User"},
                "recycle_roles": {"Desk User"},
            }
        }
        self.assertTrue(self._allowed(legacy, {"Desk User"}), "旧口径被改坏了（RL-05）")
        # 少一个角色键（recycle_roles）⇒ 旧口径就是拒
        missing = {
            "access": {
                "read_roles": {"Desk User"},
                "write_roles": {"Desk User"},
            }
        }
        self.assertFalse(self._allowed(missing, {"Desk User"}),
                         "旧口径的『三键都要命中』被改坏了（RL-05）")
        # 角色不匹配 ⇒ 拒
        self.assertFalse(self._allowed(legacy, {"Auditor"}), "旧口径的角色匹配被改坏了（RL-05）")

    # ---------- 声明坏了 ⇒ fail-closed ----------

    def test_RL06_broken_declaration_is_denied(self):
        """RL-06 表级 `access` 缺操作/形状坏 ⇒ **拒绝**（不猜、不放行）。"""
        broken = {
            "access": {
                "read": {"scope": "global"},
                # 缺 write / download
            }
        }
        self.assertFalse(self._allowed(broken, {"Desk User"}, subject=self.DEPT_MEMBER),
                         "声明坏了却被放行（RL-06）")

    def test_RL07_column_write_scope_wins_over_table(self):
        """RL-07 继承链 = 列 → 列的读 → 表 → 表的读（**与其它入口同一份定义**）。

        列级写档比表级更严 ⇒ 以列级为准。
        """
        compiled = {
            "access": {
                "read": {"scope": "global"},
                "write": {"scope": "global"},
                "download": {"scope": "global"},
                "record_scope": "own",
            },
            "fields": [
                {"id": "amount", "type": "number",
                 "access": {"write": {"scope": "personal", "users": ["zhang@x.com"]}}},
            ],
        }
        from shangshu_core import subject_access
        subject = {"user": "li@x.com", "member_of": [], "head_departments": [],
                   "is_admin": False}
        field_access = compiled["fields"][0]["access"]
        scope = subject_access.resolve_op_scope(field_access, compiled["access"], "write")
        self.assertFalse(subject_access.subject_allows(scope, subject),
                         "列级写档（个人）没生效（这条判据的前提）")
        self.assertFalse(self._allowed(compiled, {"Desk User"}, subject=self.OUTSIDER),
                         "列级更严的写档被忽略了（RL-07）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
