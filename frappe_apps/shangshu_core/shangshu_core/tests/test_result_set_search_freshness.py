"""结果集引用的**有效性校验要带上搜索词**（2026-10-27 夜 · PKG-132 · 审查报告 R22）。

**背景**：签发引用时把搜索词**单独**存进 `criteria["search"]`，而核有效性时
只按 `criteria["filters"]` 计数 ⇒ **带搜索词的引用**拿去续查，拿「这个范围的总数」
去比「刚才那 10 条」⇒ **误判成「数据已变化」**（或反过来，把变了的数据说成没变）。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **带搜索词的引用，续查时按同一个搜索词计数** ——
   计数用的条件里**含那个 `$search`**（不是把搜索词丢掉再数）。
2. **没有搜索词的引用，计数条件里就不该多出 `$search`**（不凭空加条件）。
3. **引用里的筛选条件原样带进计数**（口径不漂）。

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑，不需要连库）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. python3 -m unittest \
        shangshu_core.tests.test_result_set_search_freshness
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


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 才能断这些读口")
class TestResultSetSearchFreshness(unittest.TestCase):
    """核「这个范围还在不在」时，**口径要和签发时一模一样**。"""

    def setUp(self):
        from shangshu_core import model_records, result_sets
        self.model_records = model_records
        self.result_sets = result_sets
        self.captured = {}
        self._saved = (model_records.object_state, model_records.count_matching)

        def fake_state(object_id):
            return {"revision": 3}

        def fake_count(object_id, filters=None, scope=None):
            self.captured["filters"] = dict(filters or {})
            self.captured["scope"] = scope
            return 10

        model_records.object_state = fake_state
        model_records.count_matching = fake_count

    def tearDown(self):
        self.model_records.object_state, self.model_records.count_matching = self._saved

    def _entry(self, criteria):
        return {"object_id": "OBJ-1", "revision": 3, "criteria": criteria,
                "matched_total": 10, "kind": "query"}

    def test_the_search_term_is_part_of_the_freshness_count(self):
        """带搜索词的引用 ⇒ 计数时**带上同一个 `$search`**。"""
        self.result_sets.assert_fresh(self._entry({"filters": {"review_status": "受理"},
                                                   "search": "3IN24", "scope": "active"}))
        self.assertEqual(self.captured["filters"].get("$search"), "3IN24",
                         "核有效性时把搜索词丢了 ⇒ 拿全量跟那 10 条比")
        self.assertEqual(self.captured["filters"].get("review_status"), "受理")

    def test_no_search_term_means_no_search_filter(self):
        """没有搜索词 ⇒ 计数条件里**不凭空多出** `$search`。"""
        self.result_sets.assert_fresh(self._entry({"filters": {"review_status": "受理"},
                                                   "scope": "active"}))
        self.assertNotIn("$search", self.captured["filters"])

    def test_the_scope_is_carried_over(self):
        """范围口径（scope）原样带进计数。"""
        self.result_sets.assert_fresh(self._entry({"filters": {}, "search": "x", "scope": "trash"}))
        self.assertEqual(self.captured["scope"], "trash")


if __name__ == "__main__":
    unittest.main()
