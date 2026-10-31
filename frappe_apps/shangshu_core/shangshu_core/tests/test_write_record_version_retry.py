"""**写受管记录撞了并发**（乐观锁对不上）⇒ 内核**重读最新版本再写**。

**测试通过 = 什么成立**（一句话）：
「两个动作**同时**改同一条受管记录 ⇒ 后写的那一个撞上乐观锁
（「记录已被修改，请刷新后重试」）⇒ 内核**自己重读那条记录的最新版本再写一次**就过去了
⇒ **人看到的是「都写进去了」，不是「有一趟失败了」**；
而**真失败**（不是版本冲突）**照样当场报**（不许被重试吞掉）。」

**为什么有这一条**（2026-10-28 站上实测撞出来的）：
同一份通知书**并发**进站（客户端并发 ＋ 域内回扫）⇒ 两边都改**同一条**待审记录
⇒ 内核的乐观锁（`expected_modified` 对不上）⇒ **后写的那趟被拒**
（站上原话：「入站失败：记录已被修改，请刷新后重试」）
⇒ **那一趟白跑**（它做的事其实已经由另一趟做完了）。

⇒ **重试放在内核这一个入口**（`model_records.write_record`）——
**域里不许各写一套**（契约：「域里不许自己写第二套记录引擎」）。
"""
import unittest
from unittest import mock

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_core.tests.test_write_record_version_retry")
class TestWriteRecordVersionRetry(FrappeTestCase):
    """受管记录写的版本冲突重试。"""

    def setUp(self):
        # 公共动作确认标记（`write_record` 头一道闸：没这个标记不许写）。
        frappe.flags.shangshu_action_pin = {"action_id": "platform.object.update"}

    def tearDown(self):
        frappe.flags.shangshu_action_pin = None
        super().tearDown()

    def _doc(self, modified):
        doc = mock.MagicMock()
        doc.name = "REC-1"
        doc.modified = modified
        return doc

    def test_a_version_conflict_is_retried_with_the_fresh_version(self):
        """撞版本冲突 ⇒ **重读最新版本再写**（一次就过去）。"""
        from shangshu_core import model_records

        seen = []

        def fake_write_one(model, compiled, roles, name, expected_modified, values):
            seen.append(expected_modified)
            if len(seen) == 1:
                raise frappe.TimestampMismatchError("记录已被修改，请刷新后重试")
            return self._doc("v2"), []

        def fake_record(model, compiled, roles, name, include_recycled=False, for_update=False):
            # 第一次是「旧版本」（写的时候撞了）；重试时读到的是**对方刚写定的新版本**。
            return self._doc("v1") if not seen else self._doc("v2")

        with mock.patch.object(model_records, "is_managed", return_value=True):
          with mock.patch.object(model_records, "_load", return_value=(mock.MagicMock(active_revision=1), mock.MagicMock(), set())):
            with mock.patch.object(model_records, "_record", side_effect=fake_record):
                with mock.patch.object(model_records, "_write_one_record", side_effect=fake_write_one):
                    with mock.patch.object(model_records, "_notify_managed_change", return_value={}):
                        with mock.patch.object(model_records, "_record_change_payload", return_value={"data": {}}):
                            model_records.write_record(
                                "platform.object.update",
                                {"object_id": "obj-1", "expected_revision": 1,
                                 "name": "REC-1", "expected_modified": "v0", "values": {}},
                                {"confirmed": True})
        self.assertEqual(len(seen), 2, "撞了版本冲突没有重试（写了 %d 次）" % len(seen))
        self.assertEqual(seen[0], "v0", "第一次写用的不是调用方给的版本")
        self.assertEqual(seen[1], "v2", "重试时没有用重读到的最新版本")

    def test_a_real_failure_is_not_retried(self):
        """**真失败**（不是版本冲突）**照样当场报**（不许被重试吞掉）。"""
        from shangshu_core import model_records

        calls = []

        def fake_write_one(model, compiled, roles, name, expected_modified, values):
            calls.append(expected_modified)
            raise frappe.ValidationError("这个是真的坏了")

        with mock.patch.object(model_records, "is_managed", return_value=True):
          with mock.patch.object(model_records, "_load", return_value=(mock.MagicMock(active_revision=1), mock.MagicMock(), set())):
            with mock.patch.object(model_records, "_record", side_effect=[self._doc("v1")]):
                with mock.patch.object(model_records, "_write_one_record", side_effect=fake_write_one):
                    with self.assertRaises(frappe.ValidationError):
                        model_records.write_record(
                            "platform.object.update",
                            {"object_id": "obj-1", "expected_revision": 1,
                             "name": "REC-1", "expected_modified": "v0", "values": {}},
                            {"confirmed": True})
        self.assertEqual(len(calls), 1, "真失败被重试了 ⇒ 原因会被拖慢、也会被吞掉")

    def test_repeated_conflicts_are_reported_after_several_tries(self):
        """**一直撞** ⇒ 当场报（不许无限重试）。"""
        from shangshu_core import model_records

        calls = []

        def fake_write_one(model, compiled, roles, name, expected_modified, values):
            calls.append(expected_modified)
            raise frappe.TimestampMismatchError("记录已被修改，请刷新后重试")

        with mock.patch.object(model_records, "is_managed", return_value=True):
          with mock.patch.object(model_records, "_load", return_value=(mock.MagicMock(active_revision=1), mock.MagicMock(), set())):
            with mock.patch.object(model_records, "_record", side_effect=[self._doc("v1")] * 8):
                with mock.patch.object(model_records, "_write_one_record", side_effect=fake_write_one):
                    with self.assertRaises(frappe.TimestampMismatchError):
                        model_records.write_record(
                            "platform.object.update",
                            {"object_id": "obj-1", "expected_revision": 1,
                             "name": "REC-1", "expected_modified": "v0", "values": {}},
                            {"confirmed": True})
        self.assertGreater(len(calls), 1, "一次都没重试")
        self.assertLessEqual(len(calls), 6, "重试次数没上限 ⇒ 会一直打")
