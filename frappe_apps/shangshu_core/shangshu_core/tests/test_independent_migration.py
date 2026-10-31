"""独立迁移口（内核）：**DDL 走它，域边界内一次 commit 都没有**。

**背景**：受管对象的物理表由 `model_changes.execute_object_change` 建立 ——
那是 DDL（**MariaDB 的 DDL 会隐式提交**）⇒ 必须独立事务；但**领域围栏里不许自行提交**
（`domain_execution` 的 `before_commit` 钩子：「领域执行器不得自行提交事务」）
⇒ 晋升这条链（域动作 → 内核 `promotion_records` → 独立迁移口）以前**必红**。
用户拍板的口径是**方案 A**：**内核提供一个「独立迁移」的公开口，DDL 走它，域边界内不碰 commit**。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. 在 `domain_execution(...)` 内调新口 ⇒ **DDL 跑完**、变更单 `Applied`、
   **物理表和列都在**。 【NEEDS_SITE：本轮未跑】
2. 在 `domain_execution(...)` 内直接 `frappe.db.commit()` ⇒ **仍然**抛
   「领域执行器不得自行提交事务」（**旧守卫没被削弱**）。 【离线可跑】
3. 新口运行**期间**深度标志被还原 ⇒ **出入口后域的 commit 立刻又被拦**
   （**屏障只在那扇窗里开**）。 【离线可跑】
4. **同一幂等键重试** ⇒ 不建第二个对象 / 第二张表 / 第二条记录。 【NEEDS_SITE】
5. **DDL 中途失败** ⇒ 变更单 `Failed`、**原生效版本保留**、
   **动作请求不卡在 `Running`**（失败路径的回滚有落点）、按同一计划可重试。
   【离线可跑一半（savepoint 重建 ＋ 失败收口）／NEEDS_SITE 一半（真 DDL 失败）】
6. `promotion_records.provision_promoted_records` 在 `domain_execution` 内
   **端到端跑通**（这就是本次回归本体）。 【NEEDS_SITE】

**离线那几条怎么跑**（本机没有站点 ⇒ 只跑得动离线那半）：

    python3 frappe_apps/shangshu_core/shangshu_core/tests/test_independent_migration.py

**离线那半替的是什么**：只替 **DB 层**（`frappe.db` / `frappe.flags`）——
围栏守卫、提交窗口、端口、savepoint 重建跑的都是**真代码**
（`domain_execution.py` / `independent_migration.py` 原文，按文件路径装起来）。
**真 DDL、真表、真事务**那几条**替不了** ⇒ 标 NEEDS_SITE、**本轮未跑**。

**拟真 `frappe.db` 照 MySQL 的脾气写**（不然这个离线判据就是自说自话）：
  · `commit()` 先跑 `before_commit` 回调，**回调调用前先出队**
    （frappe 的 CallbackManager 就是这么干的）；
  · `commit()` **销毁所有 savepoint**（MySQL：COMMIT 释放 savepoint）；
  · `rollback(save_point=名字)` 遇到**不存在**的 savepoint ⇒ 报错
    （MySQL 1305：SAVEPOINT does not exist）。
"""
import importlib.util
import sys
import types
import unittest
import uuid
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
CORE_DIR = TESTS_DIR.parent            # .../shangshu_core/shangshu_core
REPO_ROOT = TESTS_DIR.parents[3]       # 仓库根

try:                                    # 站上有真 frappe ⇒ 跑真站那几条
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_SITE = True
except Exception:                       # 离线上没有 frappe ⇒ 只跑离线那几条
    frappe = None
    FrappeTestCase = unittest.TestCase
    HAS_SITE = False


def _load_by_path(name, path):
    """按**文件路径**装一个模块（离线判据用它绕开真包与真 frappe 的依赖）。"""
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# ============================ 离线那半（不碰真站点） ============================

class _FakeDb:
    """拟真 `frappe.db`：**只实现这次要验的那几样**，且**照 MySQL 的脾气**写。

    ⚠️ 写错脾气 ⇒ 这个判据就是假绿 ⇒ 三条脾气逐条照 MySQL 写：
      ① `commit()` 先跑 `before_commit` 回调，**回调调用前先出队**；
      ② `commit()` **销毁所有 savepoint**（COMMIT 释放 savepoint）；
      ③ `rollback(save_point=…)` 遇到**不存在**的 savepoint ⇒ 报错（1305）。
    """

    def __init__(self):
        self.before_commit = set()
        self.transaction_writes = 0
        self.commits = 0
        self.savepoints = []          # 现存的 savepoint（按建立顺序）

    # —— 事务 ——
    def commit(self):
        # ⚠️ **计数在回调之后加** —— 照 Frappe 的真脾气：
        #    `before_commit` 的钩子是在**真正的 COMMIT 之前**跑的
        #    ⇒ 钩子抛错 ⇒ **事务根本没提交** ⇒ 提交计数**不许涨**
        #    （早先这里先加计数 ⇒ 被守卫拦下的那次提交也被算成「提交了」
        #      ⇒ 「围栏里一次提交都不该发生」这条判据自己就错了）。
        for callback in list(self.before_commit):
            self.before_commit.discard(callback)     # ① 调用前先出队
            callback()                               # 抛错 ⇒ 这里就停住，**没有 COMMIT**
        self.commits += 1
        self.transaction_writes = 0
        self.savepoints = []                          # ② COMMIT 释放 savepoint

    def rollback(self, save_point=None):
        if save_point is None:
            self.savepoints = []
            self.transaction_writes = 0
            return
        if save_point not in self.savepoints:
            raise RuntimeError("SAVEPOINT %s does not exist" % save_point)   # ③
        cut = self.savepoints.index(save_point)
        # ROLLBACK TO 会释放它之后建立的 savepoint
        self.savepoints = self.savepoints[:cut + 1]

    def savepoint(self, name):
        # MySQL：同名 savepoint 会被**替换**（旧的删掉、新的建在当前位置）
        self.savepoints = [item for item in self.savepoints if item != name]
        self.savepoints.append(name)

    # —— 围栏要读的那张表（`domain_execution` 的启停判定）——
    def sql(self, *args, **kwargs):
        return [{"enabled": 1, "execution_stopped": 0, "health_status": "healthy"}]


@unittest.skipIf(HAS_SITE, "离线那几条在没有站点的机器上跑（站上有真事务，跑它没意义）")
class TestIndependentMigrationOffline(unittest.TestCase):
    """离线可跑的那几条：屏障挂起/恢复、savepoint 重建、失败收口、幂等键推导。"""

    def setUp(self):
        self.previous = {key: sys.modules.get(key) for key in (
            "frappe", "shangshu_core", "shangshu_core.lifecycle", "shangshu_core.action_packages",
            "shangshu_core.subject_access", "shangshu_core.design_support",
            "shangshu_core.domain_execution", "shangshu_core.independent_migration",
            "shangshu_core.promotion_records")}

        fake = types.ModuleType("frappe")
        fake.flags = types.SimpleNamespace(shangshu_call_domain=None,
                                           shangshu_domain_execution_depth=None)
        fake.ValidationError = type("ValidationError", (Exception,), {})
        fake.PermissionError = type("PermissionError", (Exception,), {})
        fake.DoesNotExistError = type("DoesNotExistError", (Exception,), {})

        def _throw(message, exc=fake.ValidationError):
            raise exc(message)

        fake.throw = _throw
        fake.db = _FakeDb()
        sys.modules["frappe"] = fake
        self.frappe = fake

        package = types.ModuleType("shangshu_core")
        package.__path__ = []
        sys.modules["shangshu_core"] = package

        lifecycle = types.ModuleType("shangshu_core.lifecycle")
        lifecycle.assert_declared_call = lambda domain_id: None
        sys.modules["shangshu_core.lifecycle"] = lifecycle

        subject_access = types.ModuleType("shangshu_core.subject_access")
        subject_access.REQUIRED_OPS = ("read", "write", "download")
        subject_access.ROLE_KEYS = ("read_roles", "write_roles", "download_roles")
        subject_access.normalize_access = lambda access, where="", required=(), extra_keys=(): access
        subject_access.is_subject_access = lambda access: False
        sys.modules["shangshu_core.subject_access"] = subject_access
        package.subject_access = subject_access

        design_support = types.ModuleType("shangshu_core.design_support")
        design_support.require_designer = lambda: None
        sys.modules["shangshu_core.design_support"] = design_support

        # —— **真代码**（按文件路径装，绕开真包与真 frappe 的依赖）——
        _load_by_path("shangshu_core.action_packages", CORE_DIR / "action_packages.py")
        self.domain_execution = _load_by_path("shangshu_core.domain_execution",
                                               CORE_DIR / "domain_execution.py")
        self.port = _load_by_path("shangshu_core.independent_migration",
                                  CORE_DIR / "independent_migration.py")
        self.promotion_records = _load_by_path("shangshu_core.promotion_records",
                                               CORE_DIR / "promotion_records.py")

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    # ---------- ② 旧守卫没被削弱 ----------
    def test_domain_commit_is_still_blocked_inside_the_fence(self):
        """② 围栏里直接 `frappe.db.commit()` ⇒ **仍然**抛「领域执行器不得自行提交事务」。"""
        with self.domain_execution.domain_execution("domain.a"):
            for _ in range(2):
                with self.assertRaises(self.frappe.ValidationError) as caught:
                    self.frappe.db.commit()
                self.assertIn("领域执行器不得自行提交事务", str(caught.exception),
                              "守卫的拒因被改了")
        self.assertEqual(self.frappe.db.commits, 0, "围栏里一次提交都不该发生")

    # ---------- ③ 屏障只在那扇窗里开 ----------
    def test_migration_window_opens_and_restores_the_barrier(self):
        """③ 窗口开着 ⇒ 提交放行；**出窗后域的 commit 立刻又被拦**。"""
        with self.domain_execution.domain_execution("domain.a"):
            with self.domain_execution.independent_migration_window():
                self.frappe.db.commit()          # 窗内：放行
            with self.assertRaises(self.frappe.ValidationError):
                self.frappe.db.commit()          # 出窗：又被拦
            self.assertEqual(self.frappe.db.commits, 1, "窗内那次提交没放行")

    def test_barrier_is_back_after_the_port_has_run(self):
        """③ 新口跑完 ⇒ 屏障**立刻**恢复（域不能趁迁移口开着的时候提交）。

        ⚠️ **断言从 `commits == 1` 改成 `commits == 0`**（审查报告 R01 · PKG-128-T08 ·
        用户 2026-10-26 定「乙」）：改之前新口**直接提交调用方正在用的那条连接**
        （`frappe.db.commit()`）⇒ 域围栏里还没提交的那些写（比如文件侧刚存的 ACL）
        **被提前提交** ⇒ 后续 DDL 一失败就留下「**文件 ACL 已经提交、对象 ACL 还是旧版**」
        的半写。
        改之后：**迁移口自己不提交调用方那条连接** ⇒ 它的待写内容原样留着，
        由最外层请求边界提交或回滚。

        ⚠️ **诚实说明白**：DDL 跑在调用方那条连接上 ⇒ MariaDB 的**隐式提交**
        仍会在 DDL 那一刻提交那一刻的待写内容（这改不了）⇒
        「业务写不被提前提交」靠的是**业务写排在迁移之后**（文件域写声明在迁移之后），
        **不是**靠这条连接干净。
        """
        with self.domain_execution.domain_execution("domain.a"):
            self.port.run_independent_migration("change-1", confirmed=True,
                                                 executor=lambda change_id, confirmed=False: {"ok": True})
            with self.assertRaises(self.frappe.ValidationError):
                self.frappe.db.commit()
        self.assertEqual(self.frappe.db.commits, 0,
                         "新口一次都不许提交调用方那条连接（DDL 走独立连接）")

    # ---------- ⑤ savepoint 重建（动作不卡在 Running 的关键） ----------
    def test_port_rebuilds_the_action_savepoint_after_the_commit(self):
        """⑤ 提交与 DDL 销毁了 savepoint ⇒ 新口**按原名重建**它
        ⇒ 动作失败时的 `rollback(save_point=…)` 有落点（**动作不会卡在 Running**）。"""
        point = "action_execute_" + "a" * 12
        self.frappe.db.savepoint(point)
        self.frappe.flags.shangshu_action_savepoints = [point]
        with self.domain_execution.domain_execution("domain.a"):
            self.port.run_independent_migration("change-1", confirmed=True,
                                                 executor=lambda change_id, confirmed=False: {"ok": True})
            # 提交把 savepoint 销毁了 ⇒ 这里必须**不报错**（重建成功）
            self.frappe.db.rollback(save_point=point)

    def test_failed_migration_still_leaves_the_action_rollback_usable(self):
        """⑤ 迁移失败 ⇒ 变更收口、动作的回滚路径**仍然有落点**、屏障**恢复**。"""
        point = "action_execute_" + "a" * 12
        self.frappe.db.savepoint(point)
        self.frappe.flags.shangshu_action_savepoints = [point]

        def _boom(change_id, confirmed=False):
            raise RuntimeError("DDL 故意炸")

        with self.domain_execution.domain_execution("domain.a"):
            with self.assertRaises(RuntimeError):
                self.port.run_independent_migration("change-1", confirmed=True, executor=_boom)
            # 失败后 savepoint 仍在 ⇒ 失败记账能跑（动作不会卡在 Running）
            self.frappe.db.rollback(save_point=point)
            # 屏障恢复 ⇒ 域不能自己提交
            with self.assertRaises(self.frappe.ValidationError):
                self.frappe.db.commit()

    def test_port_refuses_without_confirmation(self):
        """新口不许闷头跑 DDL：没确认 ⇒ 当场拒。"""
        with self.assertRaises(self.frappe.ValidationError):
            self.port.run_independent_migration("change-1", confirmed=False,
                                                 executor=lambda change_id, confirmed=False: {"ok": True})
        self.assertEqual(self.frappe.db.commits, 0, "没确认就不该提交")

    # ---------- A 幂等键推导（纯逻辑） ----------
    def test_row_idempotency_key_is_stable_and_generation_aware(self):
        """A 行级幂等键：**同一世内重试是同一把键**（幂等成立）、
        **不同世用不同的键**（退役后再晋升不撞上一世的结果）。"""
        key = self.promotion_records._row_key
        self.assertEqual(key("promotion-row", "k1", "r-1", 1), key("promotion-row", "k1", "r-1", 1),
                         "同一世重试的键变了（幂等不成立）")
        self.assertNotEqual(key("promotion-row", "k1", "r-1", 1), key("promotion-row", "k1", "r-1", 2),
                            "不同世撞了同一把键（会重放上一世的旧结果）")
        self.assertNotEqual(key("promotion-row", "k1", "r-1", 1), key("promotion-row", "k2", "r-1", 1),
                            "不同幂等键撞了")

    # ---------- 域边界内不碰 commit（静态回归闸） ----------
    def test_promotion_records_has_no_commit_of_its_own(self):
        """**回归本体**：`promotion_records` 里**一次 commit 都不许有**
        （围栏的规矩：锁由外层请求/任务事务释放）。"""
        source = (CORE_DIR / "promotion_records.py").read_text(encoding="utf-8")
        self.assertNotIn("frappe.db.commit(", source,
                         "晋升链里又冒出 commit 了（域边界内不许自行提交）")


# ============================ 真站那几条（NEEDS_SITE） ============================

COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
]

TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}


@unittest.skipUnless(HAS_SITE, "需要真实站点（真 DDL / 真表 / 真事务）")
class TestIndependentMigrationOnSite(FrappeTestCase):
    """① ④ ⑤ ⑥：真 DDL、真表、真事务那几条。**本轮未跑（本机没有站点）**。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "im-" + uuid.uuid4().hex
        self.table = "im-table-" + uuid.uuid4().hex[:8]
        self.application = None
        self.objects = []
        self.applications = []

    def tearDown(self):
        frappe.set_user("Administrator")
        from shangshu_core import model_records
        for object_id in self.objects:
            try:
                model = frappe.get_doc(model_records.MODEL, object_id)
                frappe.db.commit()
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
            except Exception:
                pass
        for application_id in self.applications:
            try:
                frappe.delete_doc("Shangshu Application Definition", application_id, force=True,
                                  ignore_permissions=True)
            except Exception:
                pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    def _application(self):
        from shangshu_core.applications import create_application_definition
        if self.application is None:
            app = create_application_definition("独立迁移试点", "im-app:" + self.key)
            self.application = app["id"]
            self.applications.append(self.application)
        return self.application

    def _plan(self, columns=None):
        from shangshu_core.model_changes import prepare_object_change
        from shangshu_core.promotion_records import build_definition
        definition = build_definition("独立迁移试点", columns or COLUMNS, access=TABLE_ACCESS)
        change = prepare_object_change(self._application(), definition, "im-object:" + self.key)
        self.objects.append(change["object_id"])
        return change

    # ---------- ① ----------
    def test_port_runs_the_ddl_inside_the_domain_fence(self):
        """① 围栏内调新口 ⇒ DDL 跑完、变更单 `Applied`、物理表和列都在。

        ⚠️ **物理列名不是业务字段名**：内核 `model_schema` 给受管字段的物理列起名是
        `f_<sha256(对象id:字段id)[:20]>`（`amount`／`day` 只是**字段id**，
        用来写值的，不是列名）⇒ 判据**不许写死**业务名去找列，要按内核自己那份
        编译映射找列（否则这条判据在真站点上永远是错的）。
        """
        import json

        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.independent_migration import run_independent_migration
        change = self._plan()
        with domain_execution("com.shangshu.core"):
            applied = run_independent_migration(change["id"], confirmed=True)
        self.assertEqual(applied["status"], "Applied", "变更单没有生效")
        model = frappe.get_doc(model_records.MODEL, change["object_id"])
        columns = set(frappe.db.get_table_columns(model.physical_doctype))
        compiled = json.loads(model.active_json)
        physical = [column["fieldname"] for column in compiled["doctype"]["fields"]]
        self.assertTrue(physical, "编译出来的受管字段列名一个都没有")
        for fieldname in physical:
            self.assertRegex(fieldname, r"^f_[0-9a-f]{20}$",
                             "受管字段的物理列名不是内核那套哈希列名：%s" % fieldname)
            self.assertIn(fieldname, columns,
                          "物理表里少了受管字段那一列：%s" % fieldname)
        self.assertEqual(len(physical), len(COLUMNS), "受管字段的列数与声明的不一致")

    def test_barrier_is_restored_right_after_the_port(self):
        """③ 围栏内跑完新口 ⇒ 域的 commit **立刻又被拦**（屏障只在那扇窗里开过）。"""
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.independent_migration import run_independent_migration
        change = self._plan()
        with domain_execution("com.shangshu.core"):
            run_independent_migration(change["id"], confirmed=True)
            with self.assertRaises(frappe.ValidationError) as caught:
                frappe.db.commit()
            self.assertIn("领域执行器不得自行提交事务", str(caught.exception))

    # ---------- ④ ----------
    def test_same_idempotency_key_does_not_build_a_second_object_or_table(self):
        """④ 同一幂等键重试 ⇒ 不建第二个对象 / 第二张表。"""
        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.independent_migration import run_independent_migration
        change = self._plan()
        with domain_execution("com.shangshu.core"):
            first = run_independent_migration(change["id"], confirmed=True)
            second = run_independent_migration(change["id"], confirmed=True)
        self.assertEqual(second["status"], "Applied")
        self.assertEqual(second["target_revision"], first["target_revision"], "重试推进了修订号")
        models = frappe.get_all(model_records.MODEL, filters={"application": self.application},
                                pluck="name")
        self.assertEqual(models, [change["object_id"]], "重试建出了第二个对象")
        model = frappe.get_doc(model_records.MODEL, change["object_id"])
        # ⚠️ **从另一条连接数**（不靠调用方那条连接的读视图）：
        #    物理表的 DocType 行是**DDL 那次隐式提交**带上去的 ⇒ 调用方那条连接
        #    的读视图固定在事务开始 ⇒ **看不见**那行 ⇒ 在它自己这儿数出来永远是 0
        #    ⇒ 判据会「假红」。
        watcher = frappe.database.get_db(socket=frappe.conf.db_socket, host=frappe.conf.db_host,
                                         port=frappe.conf.db_port, user=frappe.conf.db_name,
                                         password=frappe.conf.db_password,
                                         cur_db_name=frappe.conf.db_name)
        watcher.connect()
        try:
            count = watcher.sql("SELECT COUNT(*) FROM tabDocType WHERE name=%s",
                                (model.physical_doctype,))[0][0]
        finally:
            watcher.close()
        self.assertEqual(count, 1, "重试建出了第二张物理表")

    # ---------- ⑤ ----------
    def test_failed_ddl_leaves_the_object_side_untouched_and_the_plan_retryable(self):
        """⑤ DDL 中途失败 ⇒ **对象侧一点没生效**（没有物理 DocType、没有权限）、
        **变更单不会停在「迁移中」**（那会挡住同键重试）、**原生效版本保留**、
        **动作请求不卡在 `Running`**（回滚有落点）、按同一计划可重试。

        **改之前**（`execute_object_change` 旧序）：先把物理 DocType **连同权限**提交、
        再跑 DDL ⇒ DDL 一失败，**物理表没建起来、权限却已经落了**（半写）；
        而且「迁移中」这个状态也被提交了 ⇒ 库里那条变更单停在「迁移中」
        ⇒ **同键重试被挡住**（人卡住）。

        **改之后**：**权限（DocPerm）在 DDL 成功之后才写** ⇒ DDL 失败 ⇒
        对象的 ACL 一个字没动；失败收口**换一条连接**把状态改成「失败」
        ⇒ 同键可以重来。

        ⚠️ **先把计划提交掉**：模拟「计划早已落库」那条路（设计器在界面上点了执行）。
        计划还没落库时（同一次请求里准备并迁移），失败后那两行会随事务一起没掉 ——
        那样更好：库里**连僵尸记录都没有**，重试按同一幂等键重新准备即可。
        """
        import json
        from unittest.mock import patch
        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.independent_migration import run_independent_migration
        from shangshu_core.model_changes import CHANGE
        change = self._plan()
        frappe.db.commit()                      # 计划与模型行先落库
        point = "action_execute_" + frappe.generate_hash(length=12)
        frappe.db.savepoint(point)
        previous = getattr(frappe.flags, "shangshu_action_savepoints", None)
        frappe.flags.shangshu_action_savepoints = [*(previous or []), point]
        try:
            with domain_execution("com.shangshu.core"):
                # ⚠️ **第一次放行、第二次炸** ——
                #    Frappe 落自定义 DocType 时**内部就会跑一次 `updatedb`**（表就在那时建起来）；
                #    迁移命令**显式**跑的那次是第二次。
                #    ⇒ 让第一次过、第二次炸 ⇒ 才造得出「**表已经建好、命令却失败**」的局面
                #    ⇒ 正是旧实现留下「**权限已经落库、对象还没成**」那半写的场面。
                #    （如果第一次就炸 ⇒ 什么都没落 ⇒ 这条判据分不出新旧实现。）
                real_updatedb = type(frappe.local.db).updatedb
                calls = {"n": 0}

                def _updatedb(inner, doctype, meta=None):
                    calls["n"] += 1
                    if calls["n"] == 1:
                        return real_updatedb(inner, doctype, meta)
                    raise frappe.ValidationError("DDL 故意炸")

                with patch.object(type(frappe.local.db), "updatedb", _updatedb):
                    with self.assertRaises(frappe.ValidationError) as caught:
                        run_independent_migration(change["id"], confirmed=True)
                    # ⚠️ **失败必须来自 DDL**：别的环节先炸了 ⇒ 下面那些
                    #    「对象侧一点没生效」的断言就没有意义（假绿）。
                    self.assertIn("DDL 故意炸", str(caught.exception),
                                  "失败不是来自 DDL（这条判据没打到点上）")
                # ⚠️ **状态要从「另一条连接」读**（不靠调用方那条连接的读视图）：
                #    失败收口是**另一条连接**写的（`model_changes._mark_object_change_failed`
                #    ⇒ 它那一次提交**改不掉调用方那条连接已经固定的读视图**
                #    —— 调用方是 `REPEATABLE-READ`，读视图在事务开始那一刻就定了
                #    ⇒ 它读到的还是 DDL 提交之前那个「迁移中」）。
                #    ⇒ **库里真实的状态**要看另一条连接（这与下面数 DocPerm／DocType
                #    用的是同一个道理）。
                watcher = frappe.database.get_db(socket=frappe.conf.db_socket, host=frappe.conf.db_host,
                                                 port=frappe.conf.db_port, user=frappe.conf.db_name,
                                                 password=frappe.conf.db_password,
                                                 cur_db_name=frappe.conf.db_name)
                watcher.connect()
                try:
                    status = watcher.sql("SELECT status FROM `tabShangshu Schema Change` WHERE name=%s",
                                         (change["id"],))[0][0]
                finally:
                    watcher.close()
                self.assertEqual(status, "Failed",
                                 "变更单停在「%s」⇒ 同键重试会被挡住" % status)
                model = frappe.get_doc(model_records.MODEL, change["object_id"])
                self.assertEqual(model.active_revision, 0, "生效版本被挪走了（应保留原值）")
                # ⚠️ **物理表名要从编译结果里取**，不能用 `model.physical_doctype` ——
                #    那个字段是**激活阶段**才写的 ⇒ DDL 失败时它还是空的
                #    ⇒ 拿空名字去查 DocType ⇒ 恒为 0 ⇒ 判据「假绿」（先红时就栽在这）。
                from shangshu_core.record_lifecycle import physical_definition
                compiled = json.loads(frappe.get_doc(CHANGE, change["id"]).compiled_json)
                physical_name = physical_definition(compiled)["name"]
                self.assertTrue(physical_name, "编译结果里没有物理表名")
                # 对象侧**权限一点没动**（从另一条连接数 DocPerm）：
                # 旧实现把权限跟物理 DocType 一起落库 ⇒ 权限先落 ⇒ 对象还没成 ⇒ 半写
                watcher = frappe.database.get_db(socket=frappe.conf.db_socket, host=frappe.conf.db_host,
                                                 port=frappe.conf.db_port, user=frappe.conf.db_name,
                                                 password=frappe.conf.db_password,
                                                 cur_db_name=frappe.conf.db_name)
                watcher.connect()
                try:
                    perms = watcher.sql("SELECT COUNT(*) FROM tabDocPerm WHERE parent=%s",
                                        (physical_name,))[0][0]
                finally:
                    watcher.close()
                self.assertEqual(perms, 0,
                                 "DDL 失败后对象的权限已经落了（半写：ACL 先落、对象没成）")
                # 动作的 savepoint 仍在 ⇒ 失败路径回滚有落点 ⇒ 动作**不会卡在 Running**
                frappe.db.rollback(save_point=point)
                # 按同一计划可重试
                applied = run_independent_migration(change["id"], confirmed=True)
                self.assertEqual(applied["status"], "Applied", "按同一计划重试没成")
        finally:
            frappe.flags.shangshu_action_savepoints = previous

    # ---------- ⑦ ----------
    def test_activation_failure_leaves_no_committed_acl_and_no_pointer(self):
        """⑦ **DDL 成功、但激活（移动生效指针）失败** ⇒ 对象的 ACL **不许落库**。

        **改之前**（`model_changes` 旧序）：物理 DocType 建好后**立刻写权限**
        （`doc.set("permissions", …)` ＋ `doc.save()`）⇒ 那次 save 触发 Frappe 的
        `on_update → frappe.db.updatedb` ⇒ **Frappe 自己在那里 `self.commit()`**
        （`database/mariadb/database.py` 的 `updatedb()` 末尾就是 `self.commit()`）
        ⇒ **DocPerm 行当场落库**；而生效指针（`active_revision`）是**之后**才移动的
        ⇒ 激活一失败 ⇒ **「ACL 已经生效、生效指针没动」** —— 这正是审查报告 R01
        点名的那个半写。

        **改之后**：**生效指针先移、权限后写**，而「写权限」那一次 save 的提交
        **把两者一起带上** ⇒ 要么一起生效、要么一起没生效 ⇒ 没有半写。

        **怎么测**：让激活阶段失败（对象修订号对不上 ⇒ 激活拒绝移动指针），
        再从**另一条连接**看：DocPerm 行数必须是 0、`active_revision` 必须是 0。
        （必须从另一条连接看：调用方那条连接的读视图固定在事务开始，
        看不见别的连接提交的东西。）
        """
        from unittest.mock import patch

        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.independent_migration import run_independent_migration
        from shangshu_core.model_changes import CHANGE
        from shangshu_core.record_lifecycle import physical_definition
        import json

        change = self._plan()
        frappe.db.commit()
        # 让激活阶段失败：把对象的修订号改掉 ⇒ 激活不许移动生效指针
        model = frappe.get_doc(model_records.MODEL, change["object_id"])
        model.revision = model.revision + 99
        model.save(ignore_permissions=True)
        frappe.db.commit()
        compiled = json.loads(frappe.get_doc(CHANGE, change["id"]).compiled_json)
        physical_name = physical_definition(compiled)["name"]
        self.assertTrue(physical_name, "编译结果里没有物理表名")

        with domain_execution("com.shangshu.core"):
            with self.assertRaises(frappe.ValidationError):
                run_independent_migration(change["id"], confirmed=True)

        watcher = frappe.database.get_db(socket=frappe.conf.db_socket, host=frappe.conf.db_host,
                                         port=frappe.conf.db_port, user=frappe.conf.db_name,
                                         password=frappe.conf.db_password,
                                         cur_db_name=frappe.conf.db_name)
        watcher.connect()
        try:
            perms = watcher.sql("SELECT COUNT(*) FROM tabDocPerm WHERE parent=%s",
                                 (physical_name,))[0][0]
            active = watcher.sql(
                "SELECT active_revision FROM `tabShangshu Object Model` WHERE name=%s",
                (change["object_id"],))[0][0]
        finally:
            watcher.close()
        self.assertEqual(active, 0, "生效指针被挪走了（激活明明失败了）")
        self.assertEqual(perms, 0,
                         "对象的 ACL 已经落库（半写：权限先生效、生效指针没动）")

    # ---------- ⑥ ----------
    def test_provision_promoted_records_runs_end_to_end_inside_the_fence(self):
        """⑥ **回归本体**：晋升整条链在围栏内跑通（DDL 走新口、域边界内零 commit）。"""
        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.promotion_records import provision_promoted_records
        rows = [{"row_id": "r-000001", "values": {"amount": 10.5, "day": "2026-10-01"}},
                {"row_id": "r-000002", "values": {"amount": 21.0, "day": "2026-10-02"}}]
        with domain_execution("com.shangshu.core"):
            result = provision_promoted_records(table=self.table, title="晋升试点",
                                                columns=COLUMNS, rows=rows,
                                                idempotency_key=self.key, access=TABLE_ACCESS)
        self.objects.append(result["object_id"])
        self.applications.append(result["application_id"])
        found = model_records.query_records(result["object_id"], filters={}, page=1, page_length=30)
        self.assertEqual(found["total"], 2, "两行工作簿没有接出两条受管记录")
        self.assertEqual(sorted(result["records"]), ["r-000001", "r-000002"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
