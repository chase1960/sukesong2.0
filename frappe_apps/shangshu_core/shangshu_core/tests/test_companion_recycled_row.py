"""**被回收的受管记录不该打断整页授权**（2026-10-27 夜 · PKG-132 · 审查报告 R04）。

**背景**：受管记录被回收后，内核对那条记录抛的是 **ValidationError**
（「记录已回收，请在回收站恢复后操作」）；而伴随表的授权只接住了
`PermissionError` / `DoesNotExistError` ⇒ **一行被回收，整页授权直接中断**。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **回收的行被逐条跳过** —— 那一行不在授权结果里，**其余行照常授权**，
   整页**不中断**（不抛错）。
2. **别的数据错误照旧抛出** —— 不是把所有 ValidationError 一股脑吞掉
   （笼统吞会把真错误说成「没权限」）。
3. **首次绑定不把已回收的行纳进来** —— 首次投影的取行条件**排除回收标记**。

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑，不需要连库）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. python3 -m unittest \
        shangshu_core.tests.test_companion_recycled_row
"""
import sys
import unittest
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    frappe = None


RECYCLED_MESSAGE = "记录已回收，请在回收站恢复后操作"


class _Flags(dict):
    """frappe.flags 的替身：**缺键给 None**（frappe 真的就是这样）。"""

    def __getattr__(self, item):
        return self.get(item)


class _Row(dict):
    """能当 `doc.xxx` 用的字典替身。"""

    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError as error:
            raise AttributeError(item) from error


class _Hooks(list):
    """frappe.db.before_commit / after_commit 的替身（就是个集合）。"""

    def add(self, item):
        self.append(item)

    def discard(self, item):
        if item in self:
            self.remove(item)


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 才能断这些读口")
class TestCompanionRecycledRow(unittest.TestCase):
    """回收行逐条跳过；别的错误照旧抛。"""

    def setUp(self):
        from shangshu_core import object_companions, objects
        self.object_companions = object_companions
        self.objects = objects
        self._saved = (objects.get_object_record, objects.get_object_definition)
        # 模拟一次请求（`frappe.init()` 每次请求都重建 `frappe.local`）。
        self._local_saved = {}
        for name in ("cache", "session", "db", "flags"):
            try:
                self._local_saved[name] = getattr(frappe.local, name)
            except Exception:
                self._local_saved[name] = None
        frappe.local.cache = {}
        frappe.local.session = frappe._dict(user="someone@example.invalid")  # 要能属性访问
        frappe.local.db = _Flags()
        frappe.local.db.before_commit = _Hooks()
        frappe.local.db.after_commit = _Hooks()
        frappe.local.db.add_commit = _Hooks()
        frappe.local.flags = _Flags()
        frappe.flags.shangshu_call_domain = None
        # 批量取行口（授权现在走它）：**默认桩成「这批里有读不到的」** ——
        # 真实实现对「无权／已回收／不存在」都是当场抛 ⇒ 授权会**退回逐条判定**，
        # 而那正是本文件要断的那条路。⑤ 与 ⑥ 各自换成「成功批量」。
        from shangshu_core import model_records
        self._saved_get_records = model_records.get_records

        def refusing_get_records(object_id, names, *, fields=None):
            raise frappe.ValidationError("这一批里有读不到的")

        model_records.get_records = refusing_get_records

    def tearDown(self):
        from shangshu_core import model_records
        model_records.get_records = self._saved_get_records
        for name, value in self._local_saved.items():
            if value is None:
                try:
                    delattr(frappe.local, name)
                except Exception:
                    pass
            else:
                setattr(frappe.local, name, value)
        self.objects.get_object_record, self.objects.get_object_definition = self._saved

    def _stub(self, behaviour):
        def fake_get_record(object_id, name):
            outcome = behaviour(name)
            if isinstance(outcome, Exception):
                raise outcome
            return {"record": outcome}

        def fake_get_definition(object_id):
            return {"fields": [{"id": "review_status"}, {"id": "notice"}]}

        from shangshu_core import model_records
        def identities(object_id, names, *, fields):
            self.assertEqual(fields, [])
            if len(names) > 1:
                raise frappe.ValidationError('这一批里有读不到的')
            fake_get_record(object_id, names[0])  # Exercise the same denial/recycled/error case.
            return {names[0]: {'name': names[0]}}
        model_records.get_records = identities
        self.objects.get_object_record = fake_get_record
        self.objects.get_object_definition = fake_get_definition

    def _authorize(self, record_ids):
        """跑一次授权（把「找绑定」换成替身）。"""
        binding = _Row({
            "object_id": "OBJ-1", "file_id": "F-1", "enterprise_id": "default",
            "source_doctype": "SSM test", "definition_revision": 1,
            "enterprise_field": "enterprise_id",
            "fields": [{"id": "review_status", "header": "审查状态"}],
        })
        original_find = self.object_companions._find
        original_current = self.object_companions._current
        self.object_companions._find = lambda *args, **kwargs: binding
        self.object_companions._current = lambda *args, **kwargs: binding
        try:
            return self.object_companions.authorize_companion_cells(
                "F-1", record_ids, None, "read")
        finally:
            self.object_companions._find = original_find
            self.object_companions._current = original_current

    def test_a_recycled_row_is_skipped_not_fatal(self):
        """一行被回收 ⇒ **跳过它**，其余行照常，整页不中断。"""
        def behaviour(name):
            if name == "R-2":
                return frappe.ValidationError(RECYCLED_MESSAGE)
            return {"review_status": "受理"}

        self._stub(behaviour)
        result = self._authorize(["R-1", "R-2", "R-3"])
        self.assertIsNotNone(result, "整页授权被一行回收记录打断了")
        self.assertNotIn("R-2", result["allowed_record_ids"],
                         "被回收的行不该出现在授权结果里")
        self.assertIn("R-1", result["allowed_record_ids"])
        self.assertIn("R-3", result["allowed_record_ids"])

    def test_other_data_errors_are_not_swallowed(self):
        """**别的** ValidationError 照旧抛出（不笼统吞）。"""
        def behaviour(name):
            if name == "R-2":
                return frappe.ValidationError("字段值不合规则：这一格不能这么填")
            return {"review_status": "受理"}

        self._stub(behaviour)
        with self.assertRaises(frappe.ValidationError) as caught:
            self._authorize(["R-1", "R-2"])
        self.assertNotIn(RECYCLED_MESSAGE, str(caught.exception),
                         "别的数据错误被当成「回收」吞掉了")

    def test_the_first_binding_query_excludes_recycled_rows(self):
        """首次绑定的取行条件**排除回收标记**。"""
        source = Path(self.object_companions.__file__).read_text()
        self.assertIn("ss_recycled", source,
                      "首次绑定的取行没有排除已回收的行")

    # ---------- R24：一万行硬上限不该压在**日常授权**上 ----------
    def test_daily_authorization_is_not_rejected_by_the_ten_thousand_limit(self):
        """⑤ 日常授权**不再被「一万行」硬拒**（那是**首次迁移**的容量上限）。"""
        from shangshu_core import model_records
        big = ["R-%06d" % index for index in range(1, 12001)]
        self._stub(lambda name: {"review_status": "受理"})
        original = model_records.get_records
        seen = []

        def fake_get_records(object_id, names, *, fields=None):
            seen.extend(names)
            return {name: {"review_status": "受理"} for name in names}

        model_records.get_records = fake_get_records
        try:
            result = self._authorize(big)
        except frappe.ValidationError as caught:
            self.fail("一万行被拒了：%s" % caught.exception)
        finally:
            model_records.get_records = original
        self.assertEqual(len(result["allowed_record_ids"]), len(big),
                         "一万行应当照常授权（分批处理），不是被拒")
        self.assertEqual(len(seen), len(big), "批量取回的行数不对")

    # ---------- R09 内核侧：授权走**批量取行**，不逐行 get_object_record ----------
    def test_the_authorization_reads_the_rows_in_batches(self):
        """⑥ 授权**一次取一批**（不是逐行 `get_object_record`）。"""
        from shangshu_core import model_records
        self._stub(lambda name: {"review_status": "受理"})
        batch_calls = []
        original = model_records.get_records

        def fake_get_records(object_id, names, *, fields=None):
            batch_calls.append(list(names))
            return {name: {"review_status": "受理"} for name in names}

        model_records.get_records = fake_get_records
        try:
            result = self._authorize(["R-%06d" % index for index in range(1, 26)])
        finally:
            model_records.get_records = original
        self.assertTrue(batch_calls, "授权没有走批量取行 ⇒ 仍在逐行 get_object_record")
        self.assertEqual(sum(len(part) for part in batch_calls), 25,
                         "批量取回的行数不对")
        self.assertEqual(len(result["allowed_record_ids"]), 25)


if __name__ == "__main__":
    unittest.main()
