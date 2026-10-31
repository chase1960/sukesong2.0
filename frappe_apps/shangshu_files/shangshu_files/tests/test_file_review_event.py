"""文件域：**公共文件审核完成后要发出通知**（第二步的接缝）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_files.tests.test_file_review_event --skip-test-records

**为什么有这条**：以前**公共审核入口是哑的** —— 员工用公共审核能力完成，
系统里没有任何「本次审核已完成」的通报，自动化接不上（只有 example 自己的官文审核动作在发通知）。

**测试通过 = 什么成立**（一句话）：
「公共文件审核保存成功 ⇒ **发出**了 `files.review.completed` 事件（载荷里说得清哪份文件、
采用了哪些记录）⇒ **同一份文件的同一版本重复保存只发一次**（重试不会重复通报）⇒
**事件发不出去时，审核结论照样落库、而且回执里说得出没发出去**（不拦审核，也不装作没事）。」
"""
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

EVENT_ID = "files.review.completed"


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.tests.test_file_review_event")
class TestFileReviewEvent(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.token = uuid.uuid4().hex[:8]
        self.seq = 0

    def tearDown(self):
        frappe.set_user("Administrator")
        super().tearDown()

    def _act(self, name, payload, key=None):
        from shangshu_core.public_api import execute_registered_action

        self.seq += 1
        outcome = execute_registered_action(
            name, payload, confirmed=True,
            idempotency_key=key or "files-review-event-%s-%d" % (self.token, self.seq))
        return outcome.get("result") or {}

    def _create_file(self):
        return self._act("files.create", {
            "file_name": "审核事件-%s.txt" % self.token,
            "attribution": {"level": "personal"}})

    def _review(self, file_name, expected_version, expected_modified, key=None):
        return self._act("files.review", {
            "file": file_name, "expected_version": expected_version,
            "expected_modified": expected_modified, "relations": [], "note": "事件判据"},
            key=key)

    def _envelopes(self, event_id=EVENT_ID):
        return frappe.get_all("Shangshu Event Envelope",
                              filters={"event_id": event_id},
                              fields=["name", "payload_json", "idempotency_key"])

    def _version_of(self, file_name):
        from shangshu_files.working_file import content_revision

        doc = frappe.get_doc("Shangshu File Center File", file_name)
        return content_revision(doc), str(doc.modified)

    # ---------- 判据 ①：审核保存 ⇒ 发出事件 ----------
    def test_saving_a_review_publishes_the_review_completed_event(self):
        created = self._create_file()
        name = created.get("file")
        self.assertTrue(name, "建文件失败：%s" % created)
        version, modified = self._version_of(name)
        before = len(self._envelopes())
        result = self._review(name, version, modified)
        self.assertTrue((result.get("event") or {}).get("published"),
                         "审核保存后没有发出事件：%s" % result.get("event"))
        envelopes = self._envelopes()
        self.assertEqual(len(envelopes), before + 1, "事件信封没有多出一条")
        import json

        # 按**这份文件**找那条信封（不靠排序 —— 旧信封也在表里）。
        payloads = [json.loads(row.payload_json) for row in envelopes]
        mine = [item for item in payloads if item.get("file") == name]
        self.assertEqual(len(mine), 1, "事件载荷里没有说是哪份文件")
        payload = mine[0]
        self.assertIn("adopted", payload, "事件载荷里没说采用了哪些信息")
        self.assertEqual(str(payload.get("file_version")), str(version),
                         "事件载荷里的原件版本不对")

    # ---------- 判据 ②：同一版本重复保存 ⇒ 只发一次 ----------
    def test_a_retried_review_publishes_only_once(self):
        """**同一次审核重试**（同一个操作号）⇒ 只发一条事件。

        ⚠️ 「用旧版本号再存一次」**不是**这个场景：版本闸会当场拒
        （「文件或原件版本已变化」）—— 那是对的。真实的重试是**同一个操作号**重发
        （网络抖动、客户端重试）⇒ 动作层幂等 ⇒ 事件也**只发一次**，
        否则下游会把同一件审核处理两遍。
        """
        created = self._create_file()
        name = created.get("file")
        version, modified = self._version_of(name)
        key = "files-review-event-retry-%s" % self.token
        self._review(name, version, modified, key=key)
        count = len(self._envelopes())
        self._review(name, version, modified, key=key)
        self.assertEqual(len(self._envelopes()), count,
                         "同一次审核重试，又发了一条事件（下游会把同一件事处理两遍）")

    # ---------- 判据 ③：事件发不出去 ⇒ 审核结论仍落库 ＋ 回执说得出 ----------
    def test_a_failed_publish_does_not_undo_the_review_but_is_reported(self):
        import shangshu_files.review as review_module

        created = self._create_file()
        name = created.get("file")
        version, modified = self._version_of(name)
        original = review_module.publish_event if hasattr(review_module, "publish_event") else None
        # 让发布这一步抛错（模拟事件没发出去）。
        import shangshu_core.public_api as public_api

        def boom(*_args, **_kwargs):
            raise RuntimeError("模拟：事件通道没通")

        saved = public_api.publish_event
        public_api.publish_event = boom
        try:
            result = self._review(name, version, modified)
        finally:
            public_api.publish_event = saved
        event = result.get("event") or {}
        self.assertFalse(event.get("published"), "事件发不出去却报成发出去了")
        self.assertTrue(event.get("error"), "没发出去要说得清为什么")
        # 审核结论**照样落库**（不能因为通报失败把审核也丢了）。
        doc = frappe.get_doc("Shangshu File Center File", name)
        self.assertTrue(doc.get("reviewed_version"),
                        "事件没发出去把审核结论也丢了（不该发生）")
        del original


if __name__ == "__main__":
    unittest.main()
