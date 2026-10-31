"""文件域：**「本次审核已完成」这条通知的载荷**（纯函数层 ⇒ 没有站点也能跑）。

跑法（仓库根）：

    python3 -m unittest discover -s frappe_apps/shangshu_files -p "test_*.py" -t frappe_apps/shangshu_files

**测试通过 = 什么成立**（一句话）：
「公共文件审核保存成功 ⇒ **发出**一条 `files.review.completed` 通知，
载荷里**只有事实**（哪份文件、什么版本、采用了哪些记录的哪些字段、谁做的、什么时候、哪一次操作），
**没有**「要发邮件／该结案／要通知客户」这类结论；
同一份文件的同一版本 ⇒ 同一把幂等键（重试只发一次），
同一批结论 ⇒ 同一个内容指纹（下游据此去重）。」
"""
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_files
if str(APP_ROOT) not in __import__('sys').path:
    __import__('sys').path.insert(0, str(APP_ROOT))

from shangshu_files import events  # noqa: E402


class TestReviewEventPayload(unittest.TestCase):
    """载荷形状 ＋ 「不许写结论」这条纪律。"""

    def _payload(self):
        return events.build_review_completed_payload(
            "FILE-001", "v3",
            [{"object_id": "com.shangshu.x", "name": "r-1",
              "values": {"decision": "通过", "case_table": "总表"}}],
            operator="trial-jia", occurred_at="2026-10-21 20:05:03",
            trace_id="op-abc-123")

    # ---------- 判据 ①：载荷里**只有事实** ----------
    def test_the_payload_carries_only_facts(self):
        payload = self._payload()
        self.assertEqual(payload["file"], "FILE-001")
        self.assertEqual(payload["file_version"], "v3")
        self.assertEqual(payload["operator"], "trial-jia")
        self.assertEqual(payload["occurred_at"], "2026-10-21 20:05:03")
        self.assertEqual(payload["trace_id"], "op-abc-123")
        adopted = payload["adopted"]
        self.assertEqual(len(adopted), 1)
        self.assertEqual(adopted[0]["object_id"], "com.shangshu.x")
        self.assertEqual(adopted[0]["name"], "r-1")
        self.assertEqual(adopted[0]["fields"], ["case_table", "decision"])

    def test_the_payload_never_says_what_should_happen_next(self):
        """「审核完了」**不等于**「要发邮件」—— 公共模块不许下这个结论。"""
        body = repr(self._payload())
        for word in events.FORBIDDEN_CONCLUSIONS:
            self.assertNotIn(word, body,
                             "载荷里出现了业务结论「%s」（公共模块只说明事实）" % word)

    def test_a_relation_without_adopted_values_is_not_reported_as_adopted(self):
        payload = events.build_review_completed_payload(
            "FILE-002", "v1",
            [{"object_id": "com.shangshu.x", "name": "r-2", "values": {}}])
        self.assertEqual(payload["adopted"], [],
                         "没采用任何字段的关联不算「采用」")

    # ---------- 判据 ②：幂等键与内容指纹 ----------
    def test_the_same_file_and_version_share_one_idempotency_key(self):
        first = events.review_completed_idempotency_key("FILE-001", "v3")
        second = events.review_completed_idempotency_key("FILE-001", "v3")
        self.assertEqual(first, second, "同一份文件的同一版本必须同一把键（重试只发一次）")
        self.assertNotEqual(first, events.review_completed_idempotency_key("FILE-001", "v4"))

    def test_the_same_conclusions_share_one_fingerprint(self):
        first = events.content_fingerprint(self._payload())
        second = events.content_fingerprint(self._payload())
        self.assertEqual(first, second, "同一批结论必须同一个指纹（下游据此去重）")
        other = events.build_review_completed_payload(
            "FILE-001", "v3",
            [{"object_id": "com.shangshu.x", "name": "r-1",
              "values": {"decision": "驳回"}}])
        self.assertNotEqual(first, events.content_fingerprint(other),
                            "结论变了指纹必须变（那是另一件事）")


if __name__ == "__main__":
    unittest.main()
