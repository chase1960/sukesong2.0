"""读路径合并：晋升列以数据库正式值为准，普通列以表里的值为准。

测试通过 = 什么成立：
- 同一格里，表里的旧值（88.88）和数据库正式值（10.5）不一样时，
  **合并读给的是 10.5**（正式值），来源标 `database`；
- 普通列没被数据库动过，值**照旧是表里的**（不被正式值顶掉）；
- 正式值里**没有**这一行时，**不凭空造值** —— 整行原样保留；
- 字段 ACL 挡住（无权查看）的列：值一个字节不给，键留着标 `hidden`，
  **正式值也顶不开它**（不许借合并读绕过列权限）；
- 批量合并逐行独立：一行有正式值不影响另一行。
"""
import unittest

from shangshu_files.read_merge import (
    merge_row_values,
    merge_rows,
    promoted_by_header,
)


COLUMNS = [
    {'header': '名称', 'promoted': False},
    {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'decimal'},
    {'header': '日期', 'promoted': True, 'field': 'day', 'type': 'date'},
]


def sheet_row():
    """表里读出来的一行（初始 xlsx 的原值）。"""
    return {
        '名称': {'type': 'text', 'value': '乙二'},
        '金额': {'type': 'decimal', 'value': 88.88},
        '日期': {'type': 'date', 'value': '2026-10-19'},
    }


class TestPromotedByHeader(unittest.TestCase):
    def test_only_promoted_columns_with_a_field_are_collected(self):
        promoted = promoted_by_header(COLUMNS)
        self.assertEqual(sorted(promoted), ['日期', '金额'])
        self.assertEqual(promoted['金额']['field'], 'amount')

    def test_header_is_matched_after_trimming(self):
        promoted = promoted_by_header([{'header': ' 金额 ', 'promoted': True, 'field': 'amount'}])
        self.assertIn('金额', promoted)


class TestMergeRowValues(unittest.TestCase):
    def test_promoted_column_takes_the_database_formal_value(self):
        merged, source = merge_row_values(
            sheet_row(), {'amount': 10.5}, promoted_by_header(COLUMNS))
        self.assertEqual(merged['金额']['value'], 10.5, '同一格以数据库正式值为准')
        self.assertEqual(merged['金额']['type'], 'decimal')
        self.assertEqual(source['金额'], 'database')

    def test_ordinary_column_keeps_the_sheet_value(self):
        merged, source = merge_row_values(
            sheet_row(), {'amount': 10.5}, promoted_by_header(COLUMNS))
        self.assertEqual(merged['名称']['value'], '乙二', '普通列照旧是表里的值')
        self.assertEqual(source['名称'], 'sheet')

    def test_column_without_a_formal_row_keeps_the_sheet_value(self):
        merged, source = merge_row_values(
            sheet_row(), {}, promoted_by_header(COLUMNS))
        self.assertEqual(merged['金额']['value'], 88.88, '没有正式值就不造值')
        self.assertEqual(source['金额'], 'sheet')

    def test_denied_column_keeps_the_key_but_gives_no_value(self):
        values = sheet_row()
        values['金额'] = {'type': 'hidden', 'hidden': True, 'value': None}
        merged, source = merge_row_values(
            values, {'amount': 10.5}, promoted_by_header(COLUMNS), denied={'金额'})
        self.assertIn('金额', merged, '键要留着，界面才能说「无权查看」')
        self.assertIsNone(merged['金额']['value'], '无权查看的值一个字节不给')
        self.assertTrue(merged['金额'].get('hidden'))
        self.assertEqual(source['金额'], 'denied')

    def test_missing_value_becomes_an_explicit_empty_cell(self):
        merged, source = merge_row_values(
            {'金额': None}, {}, promoted_by_header(COLUMNS))
        self.assertEqual(merged['金额'], {'type': 'empty', 'value': None})
        self.assertEqual(source['金额'], 'sheet')


class TestMergeRows(unittest.TestCase):
    def test_rows_are_merged_independently(self):
        rows = [
            {'row_id': 'r1', 'values': sheet_row()},
            {'row_id': 'r2', 'values': sheet_row()},
        ]
        merged, sources = merge_rows(rows, {'r1': {'amount': 10.5}}, promoted_by_header(COLUMNS))
        self.assertEqual(merged[0]['values']['金额']['value'], 10.5)
        self.assertEqual(merged[1]['values']['金额']['value'], 88.88, '没有正式值的那行不动')
        self.assertEqual(sources['r1']['金额'], 'database')
        # 现行契约（read_merge.merge_rows 的口径）：**每一行都带 source**，
        # 没有正式值的那行来源标 'sheet'（值照旧是表里的，不凭空造值）。
        # 早前这里写的是 assertNotIn('r2', sources)，
        # 与同文件 test_a_row_without_formal_values_keeps_the_sheet_values
        # 断言的 sources['r1']['金额'] == 'sheet' 自相矛盾 —— 改成按现行契约断言。
        self.assertEqual(sources['r2']['金额'], 'sheet')

    def test_a_row_without_formal_values_keeps_the_sheet_values(self):
        rows = [{'row_id': 'r1', 'values': sheet_row()}]
        merged, sources = merge_rows(rows, {}, promoted_by_header(COLUMNS))
        self.assertEqual(merged[0]['values']['金额']['value'], 88.88, '没有正式值就不造值')
        self.assertEqual(sources['r1']['金额'], 'sheet')
        self.assertEqual(merged[0]['row_id'], 'r1')

    def test_merged_row_keeps_the_other_fields_of_the_row(self):
        rows = [{'row_id': 'r1', 'row_index': 2, 'values': sheet_row()}]
        merged, _ = merge_rows(rows, {'r1': {'amount': 10.5}}, promoted_by_header(COLUMNS))
        self.assertEqual(merged[0]['row_id'], 'r1')
        self.assertEqual(merged[0]['row_index'], 2, '行号等其它字段不能被合并读弄丢')


if __name__ == '__main__':
    unittest.main()
