"""公共「分析语义」（PKG-018-T06 第一阶段）：受管记录与表格**同一套**口径。

**测试通过 = 什么成立**（一句话）：

「这套统计口径只有一份：行数按全部匹配行算、去重计数**不计 null**、求和用**十进制**
且全空是 **null（不是 0）**、列里有不是数值的值当场拒；一次最多 3 个指标／8 个条件／
50 个集合成员；分组最多 50 组且超出时**说清完整组数**，**全体指标仍按全量算**；
筛选方式与类型兼容规则只有一份（数值列不许拿文字筛、日期列必须 YYYY-MM-DD）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_analysis --skip-test-records
"""
import unittest
from decimal import Decimal

from shangshu_core import analysis


class TestAnalysisSemantics(unittest.TestCase):
    """**纯口径**（不碰 frappe、不碰数据库）—— 口径与运行形态无关。"""

    # ---------- 指标集与上限 ----------
    def test_metric_set_and_limits(self):
        plan = analysis.plan_metrics([{"op": "count_rows"}], {})
        self.assertEqual(plan, [{"op": "count_rows", "name": "count_rows", "field": None}])
        with self.assertRaises(analysis.AnalysisError):
            analysis.plan_metrics([{"op": "count_rows"}] * 4, {})
        with self.assertRaises(analysis.AnalysisError):
            analysis.plan_metrics([{"op": "avg"}], {})
        with self.assertRaises(analysis.AnalysisError):
            analysis.plan_metrics([{"op": "sum"}], {})

    def test_sum_rejects_non_numeric_field_and_distinct_rejects_undistinctable(self):
        types = {"owner": "text", "amount": "number", "children": "detail"}
        with self.assertRaises(analysis.AnalysisError):
            analysis.plan_metrics([{"op": "sum", "field": "owner"}], types)
        with self.assertRaises(analysis.AnalysisError):
            analysis.plan_metrics([{"op": "count_distinct", "field": "children"}], types)
        # 数值列做去重是允许的（与受管记录那一侧同一份 DISTINCT 名单）
        plan = analysis.plan_metrics([{"op": "count_distinct", "field": "amount"}], types)
        self.assertEqual(plan[0]["name"], "count_distinct_amount")

    # ---------- 筛选口径（只有一份） ----------
    def test_filter_ops_types_and_limits(self):
        types = {"day": "date", "amount": "number", "owner": "text"}
        normalized = analysis.normalize_filters(
            {"day": {"op": "gte", "value": "2026-10-03"},
             "owner": "甲",
             "amount": {"op": "in", "value": [1, 2]}},
            types)
        self.assertEqual(normalized, [("day", "gte", "2026-10-03"), ("owner", "eq", "甲"),
                                      ("amount", "in", [1, 2])])
        # 类型不兼容 ⇒ 当场拒（不猜、不静默吞）
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"amount": "十块"}, types)
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"day": {"op": "gte", "value": 20261003}}, types)
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"owner": {"op": "gt", "value": "甲"}}, types)
        # 条件数与集合成员上限
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"f%d" % index: "x" for index in range(9)}, types)
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"owner": {"op": "in", "value": ["x"] * 51}}, types)
        # 不认识的字段 / 不支持的筛选方式
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"没有这个字段": "x"}, types)
        with self.assertRaises(analysis.AnalysisError):
            analysis.normalize_filters({"owner": {"op": "like", "value": "甲"}}, types)

    def test_guard_blocks_unauthorized_field_before_use(self):
        types = {"secret": "text"}
        seen = []

        def guard(field):
            seen.append(field)
            raise analysis.AnalysisError("没有该字段的读取权限：%s" % field, code="field_denied")

        with self.assertRaises(analysis.AnalysisError) as caught:
            analysis.plan_metrics([{"op": "count_distinct", "field": "secret"}], types, guard=guard)
        self.assertEqual(caught.exception.code, "field_denied")
        self.assertEqual(seen, ["secret"], "守卫先跑，字段没被用上")

    # ---------- 算出来是什么（十进制／null／分组截断） ----------
    def test_sum_is_decimal_null_when_all_empty_and_rejects_text(self):
        self.assertEqual(analysis.decimal_sum([None, None]), (None, False),
                         "全空求和是 null（不是 0）")
        self.assertEqual(analysis.decimal_sum([None, 1.5, None]), (Decimal("1.5"), True))
        self.assertEqual(analysis.decimal_sum([0.1, 0.2]), (Decimal("0.3"), True),
                         "十进制：0.1+0.2 = 0.3（不是浮点的 0.30000000000000004）")
        with self.assertRaises(analysis.AnalysisError):
            analysis.decimal_sum([1, "十块"])

    def test_compute_counts_distinct_without_null_and_groups_with_truncation(self):
        rows = [("甲", 1), ("甲", 2), ("乙", 3), (None, 4), ("丙", 5)]
        index = {"owner": 0, "amount": 1}
        plan = analysis.plan_metrics([{"op": "count_rows"}, {"op": "count_distinct", "field": "owner"},
                                      {"op": "sum", "field": "amount"}], {"owner": "text", "amount": "number"})
        result = analysis.compute(rows, plan, None, index)
        self.assertEqual(result["metrics"]["count_rows"], 5, "行数按全部匹配行算")
        self.assertEqual(result["metrics"]["count_distinct_owner"], 3, "null 不计入去重")
        self.assertEqual(result["metrics"]["sum_amount"], "15", "求和按十进制")
        # 分组：最多 50 组；超出时**说清完整组数**，但**全体指标仍按全量算**
        many = [("组%d" % index, 1) for index in range(120)]
        plan2 = analysis.plan_metrics([{"op": "count_rows"}], {"g": "text"})
        result2 = analysis.compute(many, plan2, "g", {"g": 0})
        self.assertEqual(len(result2["groups"]), 50, "分组显示最多 50 组")
        self.assertEqual(result2["group_truncation"]["total_groups"], 120, "要说明完整分组数")
        self.assertIs(result2["group_truncation"]["complete"], False, "要标出没完整返回")
        self.assertEqual(result2["metrics"]["count_rows"], 120,
                         "全体指标按全量算，不把显示的 50 组当全部")
        self.assertTrue(any(item.get("code") == "group_truncated"
                            for item in result2["exceptions"]))

    def test_unknown_count_is_null_not_zero(self):
        """**数量未知**写 null，**不推算成 0**（与受管记录那一侧同一份）。"""
        plan = analysis.plan_metrics([{"op": "count_rows"}], {})
        result = analysis.compute([], plan, None, {}, row_count=None)
        self.assertIsNone(result["metrics"]["count_rows"], "未知就是 null（不是 0）")

    # ---------- 内存判条件（表格侧用；规则与受管记录同源） ----------
    def test_matches_matches_sql_semantics(self):
        self.assertTrue(analysis.matches(3, "eq", 3))
        self.assertTrue(analysis.matches(3, "eq", 3.0))
        self.assertTrue(analysis.matches("2026-10-03", "gte", "2026-10-01"))
        self.assertTrue(analysis.matches("2026-10-03", "in", ["2026-10-01", "2026-10-03"]))
        self.assertFalse(analysis.matches(None, "eq", 0))
        self.assertTrue(analysis.matches(None, "is_null", None))
        self.assertTrue(analysis.matches("", "is_null", None))
        self.assertFalse(analysis.matches(None, "not_null", None))
        self.assertFalse(analysis.matches(None, "gt", 1), "空值不参与大小比较")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
