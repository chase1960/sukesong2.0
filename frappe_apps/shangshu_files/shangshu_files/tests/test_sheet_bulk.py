"""成包编辑的纯规则：查找替换、填充序列、选择性粘贴。

测试通过 = 什么成立：
- 查找替换**只改命中的格**：子串/整格、区分/不区分大小写四种口径各对，
  没命中的格不进变更单，查找内容为空直接拒（不静默全表清空）；
- 填充序列按步长算出一串值：等差、日期（月/日）、列表循环、复制四种，
  给了终止值就到终止值为止；
- 选择性粘贴按模式只贴该贴的那部分：只贴值 / 只贴公式 / 只贴格式，
  「跳过空」时源格为空就不动目标格。
"""
import unittest

from shangshu_files.sheet_bulk import (compute_series, plan_find_replace, plan_paste_special,
                                       replace_in_text, translate_formula)

try:
    import openpyxl  # noqa: F401
    HAS_OPENPYXL = True
except ImportError:  # pragma: no cover - 环境没装就不跑这组
    HAS_OPENPYXL = False


class TestReplaceInText(unittest.TestCase):
    def test_substring_is_replaced(self):
        self.assertEqual(replace_in_text('甲一', '甲', '乙'), '乙一')

    def test_all_occurrences_are_replaced(self):
        self.assertEqual(replace_in_text('甲甲甲', '甲', '乙'), '乙乙乙')

    def test_case_insensitive_by_default(self):
        self.assertEqual(replace_in_text('Hello World', 'hello', '你好'), '你好 World')

    def test_case_sensitive_keeps_original_when_not_matching(self):
        self.assertIsNone(replace_in_text('Hello', 'hello', 'X', match_case=True))

    def test_case_sensitive_replaces_when_matching(self):
        self.assertEqual(replace_in_text('Hello', 'Hello', '你好', match_case=True), '你好')

    def test_whole_cell_only_replaces_the_entire_content(self):
        self.assertEqual(replace_in_text('甲一', '甲一', '乙', whole_cell=True), '乙')
        self.assertIsNone(replace_in_text('甲一', '甲', '乙', whole_cell=True))

    def test_whole_cell_ignores_case_by_default(self):
        self.assertEqual(replace_in_text('abc', 'ABC', 'x', whole_cell=True), 'x')

    def test_replacement_may_be_empty(self):
        self.assertEqual(replace_in_text('甲-乙', '-', ''), '甲乙')

    def test_no_match_returns_none(self):
        self.assertIsNone(replace_in_text('甲一', '乙', '丙'))

    def test_empty_find_is_rejected(self):
        with self.assertRaises(ValueError):
            replace_in_text('甲一', '', '乙')


class TestPlanFindReplace(unittest.TestCase):
    def _cells(self):
        return [
            {'row_id': 'r1', 'header': '姓名', 'text': '甲一', 'kind': 'text'},
            {'row_id': 'r2', 'header': '姓名', 'text': '乙一', 'kind': 'text'},
            {'row_id': 'r3', 'header': '姓名', 'text': '=A1&"甲"', 'kind': 'formula'},
        ]

    def test_only_matched_cells_are_planned(self):
        changes = plan_find_replace(self._cells(), '甲', '丙')
        self.assertEqual([c['row_id'] for c in changes], ['r1', 'r3'])

    def test_formula_cell_stays_a_formula(self):
        changes = plan_find_replace(self._cells(), '甲', '丙')
        formula = [c for c in changes if c['row_id'] == 'r3'][0]
        self.assertEqual(formula['kind'], 'formula')
        self.assertEqual(formula['formula'], '=A1&"丙"')

    def test_text_cell_carries_the_new_text(self):
        changes = plan_find_replace(self._cells(), '甲', '丙')
        text = [c for c in changes if c['row_id'] == 'r1'][0]
        self.assertEqual(text['kind'], 'text')
        self.assertEqual(text['text'], '丙一')

    def test_cells_without_match_are_not_touched(self):
        changes = plan_find_replace(self._cells(), '乙', '丙')
        self.assertEqual([c['row_id'] for c in changes], ['r2'])


class TestComputeSeries(unittest.TestCase):
    def test_linear_series_uses_the_step(self):
        self.assertEqual([v['value'] for v in compute_series({'type': 'linear', 'start': 1, 'step': 2}, 3)],
                         [1, 3, 5])

    def test_linear_series_step_may_be_fraction(self):
        self.assertEqual([v['value'] for v in compute_series({'type': 'linear', 'start': 1, 'step': 0.5}, 3)],
                         [1, 1.5, 2.0])

    def test_linear_series_stops_at_the_stop_value(self):
        values = compute_series({'type': 'linear', 'start': 1, 'step': 2, 'stop': 5}, 10)
        self.assertEqual([v['value'] for v in values], [1, 3, 5])

    def test_date_series_by_month(self):
        values = compute_series({'type': 'date', 'start': '2026-01-01', 'step': 1, 'unit': 'month'}, 3)
        self.assertEqual([v['value'] for v in values],
                         ['2026-01-01', '2026-02-01', '2026-03-01'])

    def test_date_series_by_day(self):
        values = compute_series({'type': 'date', 'start': '2026-01-01', 'step': 2, 'unit': 'day'}, 2)
        self.assertEqual([v['value'] for v in values], ['2026-01-01', '2026-01-03'])

    def test_date_series_crosses_the_year(self):
        values = compute_series({'type': 'date', 'start': '2026-11-15', 'step': 1, 'unit': 'month'}, 3)
        self.assertEqual([v['value'] for v in values],
                         ['2026-11-15', '2026-12-15', '2027-01-15'])

    def test_list_series_cycles(self):
        values = compute_series({'type': 'list', 'values': ['甲', '乙']}, 3)
        self.assertEqual([v['value'] for v in values], ['甲', '乙', '甲'])

    def test_copy_series_repeats_the_start(self):
        values = compute_series({'type': 'copy', 'start': '甲'}, 3)
        self.assertEqual([v['value'] for v in values], ['甲', '甲', '甲'])

    def test_zero_count_gives_nothing(self):
        self.assertEqual(compute_series({'type': 'linear', 'start': 1, 'step': 1}, 0), [])

    def test_unknown_type_is_rejected(self):
        with self.assertRaises(ValueError):
            compute_series({'type': 'magic', 'start': 1}, 3)

    def test_linear_without_a_number_start_is_rejected(self):
        with self.assertRaises(ValueError):
            compute_series({'type': 'linear', 'start': '甲', 'step': 1}, 3)

    def test_date_with_a_bad_start_is_rejected(self):
        with self.assertRaises(ValueError):
            compute_series({'type': 'date', 'start': '2026-13-01', 'step': 1, 'unit': 'day'}, 2)


class TestPlanPasteSpecial(unittest.TestCase):
    def _source(self):
        return [
            {'kind': 'text', 'value': '甲', 'display': '甲', 'style_id': 3},
            {'kind': 'formula', 'value': None, 'formula': '=A1+1', 'display': '2', 'style_id': 3},
            {'kind': 'number', 'value': 5, 'display': '5', 'style_id': 4},
            {'kind': 'empty', 'value': None, 'display': '', 'style_id': 0},
        ]

    def test_values_mode_writes_values_not_formulas(self):
        plan = plan_paste_special(self._source(), 'values', skip_empty=False)
        values = [item for item in plan if item['kind'] == 'value']
        self.assertEqual(len(values), 4)
        self.assertEqual(values[1]['value'], {'type': 'text', 'value': '2'})

    def test_formulas_mode_keeps_the_formula(self):
        plan = plan_paste_special(self._source(), 'formulas', skip_empty=False)
        values = [item for item in plan if item['kind'] == 'value']
        self.assertEqual(values[1]['value'], {'type': 'formula', 'formula': '=A1+1'})

    def test_formats_mode_only_plans_styles(self):
        plan = plan_paste_special(self._source(), 'formats', skip_empty=False)
        self.assertTrue(plan)
        self.assertTrue(all(item['kind'] == 'style' for item in plan))
        self.assertEqual([item['style_id'] for item in plan], [3, 3, 4, 0])

    def test_skip_empty_leaves_the_target_alone(self):
        plan = plan_paste_special(self._source(), 'values', skip_empty=True)
        indexes = [item['index'] for item in plan if item['kind'] == 'value']
        self.assertNotIn(3, indexes)

    def test_without_skip_empty_the_empty_source_is_written(self):
        plan = plan_paste_special(self._source(), 'values', skip_empty=False)
        indexes = [item['index'] for item in plan if item['kind'] == 'value']
        self.assertIn(3, indexes)

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            plan_paste_special(self._source(), 'magic', skip_empty=False)


@unittest.skipUnless(HAS_OPENPYXL, '公式平移需要 openpyxl')
class TestTranslateFormula(unittest.TestCase):
    def test_relative_reference_moves_with_the_cell(self):
        # 源格 D2 的公式 =B1*2 贴到 D4：相对引用跟着挪成 =B3*2
        self.assertEqual(translate_formula('=B1*2', 'D2', 'D4'), '=B3*2')

    def test_absolute_reference_stays(self):
        self.assertEqual(translate_formula('=$B$1*2', 'D2', 'D4'), '=$B$1*2')

    def test_same_cell_keeps_the_formula(self):
        self.assertEqual(translate_formula('=B1*2', 'D2', 'D2'), '=B1*2')

    def test_broken_formula_is_returned_as_is(self):
        self.assertEqual(translate_formula('=SUM(', 'D2', 'D4'), '=SUM(')

    def test_non_formula_text_is_returned_as_is(self):
        self.assertEqual(translate_formula('甲一', 'D2', 'D4'), '甲一')
