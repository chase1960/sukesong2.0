"""**一次写多行**（2026-10-27 夜 · PKG-132 性能线）。

**背景**：契约《处理契约与状态转换》第 4 步③ 写死了 ——
「要更快得**内核新增一条批量写能力**（照样过版本闸/字段权限/值域规则/唯一键/审计，
**快也不许绕闸**），交内核同事拍；**域里不许自己写第二套记录引擎**」。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **一次动作执行** —— 一批 N 条记录**只走一次动作框架**
   （`platform.object.update_many` 一次；**不是** N 次 `platform.object.update`）。
2. **每条记录的门一件不少** —— 逐条的写入函数被调用了 **N 次**
   （版本闸/字段权限/值域/唯一键都在**那一份**里，批量与单条共用）。
3. **审计逐条一行** —— N 条记录 ⇒ **N 条**审计载荷，
   每条带自己的记录名、自己的幂等键（粒度与逐行写一样，不合并成一行）。
4. **任一条不过 ⇒ 整包拒** —— 第 2 条记录版本对不上时**当场抛错**，
   后面的记录**不再写**（整包全成或全败）。

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑，不需要连库）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. python3 -m unittest \
        shangshu_core.tests.test_batch_record_write

**替的是什么**：替 **DB 层与受管记录本体**
（`frappe.get_doc` / `frappe.db.get_value` / 逐条写入函数）——
被断的**编排逻辑是真的**（`promotion_records.write_promoted_values`
与 `model_records.write_records` 原文）。
"""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover - 没有 frappe 就退化成替身
    HAS_FRAPPE = False
    frappe = None


class _Row(dict):
    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError as error:
            raise AttributeError(item) from error


class _Flags(dict):
    """frappe.flags 的替身：**缺键给 None**（frappe 真的就是这样，不是抛错）。"""

    def __getattr__(self, item):
        return self.get(item)


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 才能断这些编排")
class TestBatchWriteShape(unittest.TestCase):
    """批量写的**编排形状**：一次动作执行、逐条过门、逐条审计、整包失败。"""

    def setUp(self):
        from shangshu_core import model_records, promotion_records
        self.model_records = model_records
        self.promotion_records = promotion_records
        self._saved = {
            "get_doc": frappe.get_doc,
            "cache": getattr(frappe.local, "cache", None),
            "session": getattr(frappe.local, "session", None),
            "db": getattr(frappe.local, "db", None),
            "flags": getattr(frappe.local, "flags", None),
        }
        # 模拟一次请求：`frappe.local` 是这一次的（`frappe.init()` 每次请求都重建它）。
        frappe.local.cache = {}
        frappe.local.session = _Row(user="someone@example.invalid")
        frappe.local.db = _Row()
        frappe.local.db.get_value = lambda *args, **kwargs: "v1"
        frappe.local.flags = _Flags()
        frappe.flags.shangshu_action_pin = {"action_id": "platform.object.update_many",
                                            "action_version": "1.0.0"}
        self.calls = []

    def tearDown(self):
        if hasattr(self, "_saved_current_versions"):
            self.promotion_records._current_versions = self._saved_current_versions
        frappe.get_doc = self._saved["get_doc"]
        for name in ("cache", "session", "db", "flags"):
            value = self._saved.get(name)
            if value is None:
                try:
                    delattr(frappe.local, name)
                except Exception:
                    pass
            else:
                setattr(frappe.local, name, value)

    def _stub_managed_object(self, names):
        """把「受管对象」换成替身：三条记录、版本已知。"""
        def fake_get_doc(*args, **kwargs):
            if args and args[0] == self.model_records.MODEL:
                return _Row({"name": "OBJ-1", "active_revision": 7,
                             "physical_doctype": "SSM test"})
            return _Row({"name": args[1] if len(args) > 1 else "?", "modified": "2026-01-01 00:00:00"})

        frappe.get_doc = fake_get_doc
        # 逐条当前版本：批量取回那一段（真实现也在核心里，这里换成替身）
        self._saved_current_versions = self.promotion_records._current_versions
        self.promotion_records._current_versions = lambda model, wanted: {name: "v1" for name in wanted}

    def test_one_action_execution_for_the_whole_package(self):
        """一批 N 条 ⇒ **一次**动作执行（不是 N 次）。"""
        from shangshu_core import actions
        self._stub_managed_object(["R1", "R2", "R3"])
        recorded = []
        original = actions.execute_registered_action

        def recorder(action_id, payload=None, **kwargs):
            recorded.append((action_id, payload, kwargs))
            return {"ok": True}

        actions.execute_registered_action = recorder
        self.promotion_records.execute_registered_action = recorder
        try:
            with self.model_records.batch_state():
                result = self.promotion_records.write_promoted_values(
                    object_id="OBJ-1",
                    records={"r1": "R1", "r2": "R2", "r3": "R3"},
                    values_by_row={"r1": {"c0": 1}, "r2": {"c0": 2}, "r3": {"c0": 3}},
                    idempotency_key="pkg")
        finally:
            actions.execute_registered_action = original
        self.assertEqual(len(recorded), 1, "动作执行了 %d 次（应当 1 次）" % len(recorded))
        action_id, payload, _kwargs = recorded[0]
        self.assertEqual(action_id, "platform.object.update_many")
        self.assertEqual(len(payload["records"]), 3, "包里记录条数不对")
        self.assertEqual(payload["expected_revision"], 7)
        self.assertEqual(result["written"], 3)

    def test_every_record_keeps_its_own_idempotency_key(self):
        """逐条幂等键保留（对象＋行＋值＋版本）—— 重试不重复写值。"""
        from shangshu_core import actions
        self._stub_managed_object(["R1", "R2"])
        recorded = []
        original = actions.execute_registered_action

        def recorder(action_id, payload=None, **kwargs):
            recorded.append((action_id, payload, kwargs))
            return {"ok": True}

        actions.execute_registered_action = recorder
        self.promotion_records.execute_registered_action = recorder
        try:
            with self.model_records.batch_state():
                self.promotion_records.write_promoted_values(
                    object_id="OBJ-1",
                    records={"r1": "R1", "r2": "R2"},
                    values_by_row={"r1": {"c0": 1}, "r2": {"c0": 2}},
                    idempotency_key="pkg")
        finally:
            actions.execute_registered_action = original
        _action_id, payload, _kwargs = recorded[0]
        keys = [item.get("idempotency_key") for item in payload["records"]]
        self.assertEqual(len(set(keys)), 2, "两条记录的幂等键相同 ⇒ 重试会互相顶掉")
        for key in keys:
            self.assertIn("promotion-write:", key)

    def _stub_record_plumbing(self):
        """把「这是不是受管对象」「模型/定义/角色装配」「投影通知」换成替身。"""
        self._saved_is_managed = self.model_records.is_managed
        self._saved_load = self.model_records._load
        self._saved_notify = self.model_records._notify_managed_change
        self.model_records.is_managed = lambda object_id: True
        self.model_records._load = lambda object_id, write=False: (
            _Row({"name": "OBJ-1", "active_revision": 1, "physical_doctype": "SSM test"}),
            {"title": "表", "fields": [], "doctype": {"fields": []}},
            {"Desk User"})
        self.model_records._notify_managed_change = lambda *args, **kwargs: {"handlers": 0, "results": []}

    def _restore_record_plumbing(self):
        self.model_records.is_managed = self._saved_is_managed
        self.model_records._load = self._saved_load
        self.model_records._notify_managed_change = self._saved_notify

    def test_each_record_still_goes_through_the_record_writer(self):
        """逐条的写入函数被调用 N 次 —— 门没有因为批量被合并。"""
        calls = []
        original = self.model_records._write_one_record

        def fake_write(model, compiled, roles, name, expected_modified, values):
            calls.append((name, expected_modified, values))
            doc = _Row({"name": name, "modified": "2026-01-02 00:00:00", "doctype": "SSM test"})
            return doc, [{"field": "c0", "label": "列", "type": "text",
                          "before": None, "after": values.get("c0")}]

        self._stub_record_plumbing()
        self.model_records._write_one_record = fake_write
        try:
            context = {"confirmed": True, "source": "user"}
            result = self.model_records.write_records(
                "platform.object.update_many",
                {"object_id": "OBJ-1", "expected_revision": 1,
                 "records": [{"name": "R1", "expected_modified": "v1", "values": {"c0": 1},
                              "row_id": "r1", "idempotency_key": "k1"},
                             {"name": "R2", "expected_modified": "v1", "values": {"c0": 2},
                              "row_id": "r2", "idempotency_key": "k2"}]},
                context)
        finally:
            self.model_records._write_one_record = original
            self._restore_record_plumbing()
        self.assertEqual(len(calls), 2, "逐条写入只调了 %d 次（应当 2 次）" % len(calls))
        self.assertEqual(result["written"], 2)
        changes = context.get("record_changes") or []
        self.assertEqual(len(changes), 2, "审计载荷不是逐条一行（应当 2 条）")
        self.assertEqual([c["name"] for c in changes], ["R1", "R2"])
        self.assertEqual([c["idempotency_key"] for c in changes], ["k1", "k2"])

    def test_one_bad_record_stops_the_whole_package(self):
        """第 2 条版本对不上 ⇒ **当场抛错**，第 3 条不再写。"""
        calls = []
        original = self.model_records._write_one_record

        def fake_write(model, compiled, roles, name, expected_modified, values):
            calls.append(name)
            if name == "R2":
                raise frappe.TimestampMismatchError("记录已被修改，请刷新后重试")
            doc = _Row({"name": name, "modified": "2026-01-02 00:00:00", "doctype": "SSM test"})
            return doc, []

        self._stub_record_plumbing()
        self.model_records._write_one_record = fake_write
        try:
            with self.assertRaises(frappe.TimestampMismatchError):
                self.model_records.write_records(
                    "platform.object.update_many",
                    {"object_id": "OBJ-1", "expected_revision": 1,
                     "records": [{"name": "R1", "expected_modified": "v1", "values": {}},
                                 {"name": "R2", "expected_modified": "v0", "values": {}},
                                 {"name": "R3", "expected_modified": "v1", "values": {}}]},
                    {"confirmed": True, "source": "user"})
        finally:
            self.model_records._write_one_record = original
            self._restore_record_plumbing()
        self.assertEqual(calls, ["R1", "R2"], "第 3 条不该再写（应当只写 R1、R2）")


if __name__ == "__main__":
    unittest.main()
