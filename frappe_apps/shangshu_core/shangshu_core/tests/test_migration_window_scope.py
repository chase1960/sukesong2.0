"""独立迁移的**提交放行范围**必须是**当前这一段**，不能是**整个进程**
（PKG-128-T03 · 2026-10-26 · 审查报告 R02）。

**背景**：内核给独立迁移开了一个「受控提交窗口」
（`domain_execution.independent_migration_window`）——
窗内放行那一次提交，出窗立刻把屏障挂回去。
这个窗口的深度以前记在**模块全局变量** `_MIGRATION_WINDOW_DEPTH` 里
⇒ **另一个请求**只要撞上这个窗口，它的提交守卫也会看到「窗口开着」
⇒ **放行了本来禁止的提交**（领域围栏里的自行提交）。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **请求 A 开着窗口时，同一时刻的请求 B 仍然被拦**（B 在领域围栏里自行提交 ⇒ 照旧抛
   「领域执行器不得自行提交事务」）—— **放行范围只限当前这一段**。 【离线可跑】
2. 请求 A 的窗口**关掉之后**，A 自己又照旧被拦（屏障恢复没坏）。 【离线可跑】
3. 两个请求**各开各的窗口**，互不影响（A 开着窗时 B 照样被拦；
   B 自己开窗时 B 能提交一次）。 【离线可跑】
4. **同一个窗口内嵌套进入**，退出后仍回到「被拦」的状态（不许多开一次就多放行一次）。 【离线可跑】

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑）：

    python3 frappe_apps/shangshu_core/shangshu_core/tests/test_migration_window_scope.py

**替的是什么**：替 **DB 层**（`frappe.db` / `frappe.flags`）——
围栏守卫、提交窗口跑的都是**真代码**
（`domain_execution.py` 原文，按文件路径装起来）。
**真站点那半不在本文件范围**（本条只断「放行范围」，不涉及 DDL 与真表）。

⚠️ **为什么用两个线程而不是直接改全局变量**：
   缺陷的本质是「**别的请求**被连带放行」⇒ 只看单个调用栈看不出来
   ⇒ 必须真的让两个执行流**同时**存在。
   本判据用 `threading` 让两个线程各走各的围栏与窗口。
"""
import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
CORE_DIR = TESTS_DIR.parent            # .../shangshu_core/shangshu_core


def _load_by_path(name, path):
    """按**文件路径**装一个模块（离线判据用它绕开真包与真 frappe 的依赖）。"""
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _FakeDb:
    """拟真 `frappe.db`：**只实现这次要验的那几样**，且**照 MySQL 的脾气**写。

    ⚠️ `commit()` 先跑 `before_commit` 回调，**回调调用前先出队**
      （frappe 的 CallbackManager 就是这么干的）
      ⇒ 守卫抛错时**事务根本没提交**（提交计数不涨）。
    """

    def __init__(self):
        self.before_commit = set()
        self.transaction_writes = 0
        self.commits = 0
        self.savepoints = []

    def commit(self):
        for callback in list(self.before_commit):
            self.before_commit.discard(callback)
            callback()
        self.commits += 1
        self.transaction_writes = 0
        self.savepoints = []

    def rollback(self, save_point=None):
        if save_point is None:
            self.savepoints = []
            self.transaction_writes = 0
            return
        if save_point not in self.savepoints:
            raise RuntimeError("SAVEPOINT %s does not exist" % save_point)
        cut = self.savepoints.index(save_point)
        self.savepoints = self.savepoints[:cut + 1]

    def savepoint(self, name):
        self.savepoints = [item for item in self.savepoints if item != name]
        self.savepoints.append(name)

    def sql(self, *args, **kwargs):
        return [{"enabled": 1, "execution_stopped": 0, "health_status": "healthy"}]


class TestMigrationWindowScope(unittest.TestCase):
    """提交放行窗口的范围：只限当前这一段，不许波及别的请求。"""

    def setUp(self):
        self.previous = {key: sys.modules.get(key) for key in (
            "frappe", "shangshu_core", "shangshu_core.lifecycle", "shangshu_core.action_packages",
            "shangshu_core.domain_execution")}

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

        # —— **真代码**（按文件路径装，绕开真包与真 frappe 的依赖）——
        _load_by_path("shangshu_core.action_packages", CORE_DIR / "action_packages.py")
        self.domain_execution = _load_by_path("shangshu_core.domain_execution",
                                               CORE_DIR / "domain_execution.py")

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    # ---------- ① 别的请求不许被连带放行 ----------
    def test_other_request_is_not_released_while_my_window_is_open(self):
        """① 请求 A 开着窗口时，请求 B 在围栏里自行提交 ⇒ **照旧被拦**。

        **为什么要有这条**：放行标志以前记在**模块全局变量**里
        ⇒ A 一开窗，**B 的守卫也看到「窗口开着」** ⇒ B 在领域围栏里的自行提交
        被放行 ⇒ 领域边界形同虚设。
        """
        window_open = threading.Event()
        b_may_commit = threading.Event()
        b_blocked = []
        b_commits_before = []

        def request_a():
            """请求 A：开着独立迁移窗口，等 B 试完。"""
            with self.domain_execution.domain_execution("domain.a"):
                with self.domain_execution.independent_migration_window():
                    window_open.set()
                    b_may_commit.wait(timeout=5)
            # 出窗后 A 自己又该被拦
            b_commits_before.append(self.frappe.db.commits)

        def request_b():
            """请求 B：与 A 同时存在，在自己的围栏里试着自行提交。"""
            window_open.wait(timeout=5)
            try:
                with self.domain_execution.domain_execution("domain.b"):
                    self.frappe.db.commit()
                b_blocked.append(False)      # 没被拦 ⇒ 缺陷还在
            except self.frappe.ValidationError:
                b_blocked.append(True)
            finally:
                b_may_commit.set()

        thread_a = threading.Thread(target=request_a)
        thread_b = threading.Thread(target=request_b)
        thread_a.start()
        thread_b.start()
        thread_a.join(timeout=10)
        thread_b.join(timeout=10)

        self.assertTrue(b_blocked, "请求 B 没有跑完 —— 判据的前置不成立")
        self.assertTrue(b_blocked[0],
                        "请求 A 开着迁移窗口时，请求 B 在领域围栏里的自行提交**被放行了** "
                        "⇒ 放行范围是整个进程，不只是当前这一段 ⇒ 领域边界形同虚设。")

    # ---------- ② 出窗后屏障恢复 ----------
    def test_barrier_is_back_after_my_own_window_closes(self):
        """② 自己的窗口关掉 ⇒ 自己又照旧被拦（放行范围没有漏出去）。"""
        with self.domain_execution.domain_execution("domain.a"):
            with self.domain_execution.independent_migration_window():
                self.frappe.db.commit()              # 窗内：放行
            with self.assertRaises(self.frappe.ValidationError):
                self.frappe.db.commit()              # 出窗：又被拦
            self.assertEqual(self.frappe.db.commits, 1, "窗内那次提交没放行")

    # ---------- ③ 两个窗口互不影响 ----------
    def test_two_windows_do_not_share_the_release(self):
        """③ 两个请求各开各的窗口：A 开着时 B 照样被拦；B 自己开窗时 B 能提交一次。"""
        a_window_open = threading.Event()
        b_may_open = threading.Event()
        results = {}

        def request_a():
            with self.domain_execution.domain_execution("domain.a"):
                with self.domain_execution.independent_migration_window():
                    a_window_open.set()
                    b_may_open.wait(timeout=5)

        def request_b():
            a_window_open.wait(timeout=5)
            # B 在 A 的窗开着的时候：先试一次（该被拦）
            try:
                with self.domain_execution.domain_execution("domain.b"):
                    self.frappe.db.commit()
                results["blocked_while_a_open"] = False
            except self.frappe.ValidationError:
                results["blocked_while_a_open"] = True
            # B 自己开窗：这一次该放行
            try:
                with self.domain_execution.domain_execution("domain.b"):
                    with self.domain_execution.independent_migration_window():
                        self.frappe.db.commit()
                results["own_window"] = True
            except self.frappe.ValidationError:
                results["own_window"] = False
            finally:
                b_may_open.set()

        thread_a = threading.Thread(target=request_a)
        thread_b = threading.Thread(target=request_b)
        thread_a.start()
        thread_b.start()
        thread_a.join(timeout=10)
        thread_b.join(timeout=10)

        self.assertTrue(results.get("blocked_while_a_open"),
                        "A 的窗开着时 B 的提交被放行了 ⇒ 窗口范围没锁住。")
        self.assertTrue(results.get("own_window"),
                        "B 自己开窗时自己的提交**没**被放行 ⇒ 放行范围收得太紧，正常迁移跑不通。")

    # ---------- ④ 嵌套不许多放行 ----------
    def test_nested_window_does_not_leave_the_fence_open(self):
        """④ 窗口里再进一次窗口 ⇒ **退到最外层之后**仍然被拦
        （不许多开一次就多放行一次；内层退出时外层还开着 ⇒ 仍放行，那是对的）。

        **口径说明**：内层窗口退出时**外层窗口还开着** ⇒ 这一刻提交**仍该放行**
        （外层那段还没走完）⇒ 判据断的是「**最外层退出之后**」那个状态。
        """
        with self.domain_execution.domain_execution("domain.a"):
            with self.domain_execution.independent_migration_window():
                with self.domain_execution.independent_migration_window():
                    self.frappe.db.commit()          # 内层窗内：放行
                # 内层已退、外层还开着 ⇒ 仍放行（这一段还没走完）
                self.frappe.db.commit()
            # ⚠️ **退到最外层之外** ⇒ 必须又被拦（多开一次不许多放行一次）
            with self.assertRaises(self.frappe.ValidationError):
                self.frappe.db.commit()
            self.assertEqual(self.frappe.db.commits, 2, "只该放行两段窗内的提交")


if __name__ == '__main__':
    unittest.main()
