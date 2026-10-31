"""列头筛选（FIX-49）：新的 `in` 匹配方式 ＋ 整列值清单（只读）。

测试通过 = 什么成立：
- `in`（值在这几个里）**真的生效**：只留下勾中的那几个值的行；空值那一档是空字符串；
- **护栏**：老四个 operator（包含/等于/为空/不为空）**语义一个字没变**；
- **存量 view**（value 是字符串的老条件）**仍然校验通过**（向后兼容，不许把老视图判死）；
- `in` 的值**有上限**（条数 / 单条长度 / 总长），超了直接拒，不静默截断；
- 值清单是**整列去重**、排序稳定、空值归为「(空白)」；
- **不可读的列拿不到值清单**；看不见的行，它的值也不给。
"""
import types
import unittest
from unittest.mock import patch

import frappe

from shangshu_files import object_projection
from shangshu_files import sheet_view as view


def _ensure_site():
    """frappe 的上下文（frappe.throw 要有 local）。容器里已经连上就别重连。"""
    try:
        if frappe.local.site:
            return
    except Exception:
        pass
    frappe.init(site='shangshu.localhost')
    frappe.connect()


_ensure_site()


def _column_values(entry, meta, column='名称', allowed=None, hidden=()):
    """调值清单服务（只读、不写库）：把取数那几个口子都替掉，只验纯规则。"""
    doc = types.SimpleNamespace(name='T')
    rows = list(meta.get('rows') or [])
    with patch.object(view, '_source', return_value=(doc, entry, meta)), \
         patch.object(view.promotion, 'unreadable_headers', return_value=set(hidden)), \
         patch.object(object_projection, 'read_access',
                      return_value={'allowed_record_ids': allowed if allowed is not None else rows}):
        return view.column_values('files.sheet_column_values', {'table': 'T', 'column': column})


class InOperatorTests(unittest.TestCase):
    """`in` 这一条新的匹配方式。"""

    def _rows(self, filters, rows_raw, headers=('名称',)):
        entry = {'headers': list(headers), 'rows_raw': rows_raw}
        ids = ['r%d' % (index + 1) for index in range(len(rows_raw))]
        return [row['row_id'] for row in view.project_rows(entry, ids, {'filters': filters})]

    def test_in_keeps_only_the_selected_values(self):
        kept = self._rows([{'column': '名称', 'operator': 'in', 'value': ['A', 'C']}],
                           [['A'], ['B'], ['C']])
        self.assertEqual(kept, ['r1', 'r3'])

    def test_in_is_exact_match(self):
        # 勾了 'A'，'AB' **不该**命中（是精确匹配，不是「包含」）。
        kept = self._rows([{'column': '名称', 'operator': 'in', 'value': ['A']}], [['A'], ['AB']])
        self.assertEqual(kept, ['r1'])

    def test_in_matches_the_blank_cell(self):
        # 空值那一档在清单里是空字符串 ⇒ 空白的行要命中。
        kept = self._rows([{'column': '名称', 'operator': 'in', 'value': ['']}], [['A'], [''], [None]])
        self.assertEqual(kept, ['r2', 'r3'])

    def test_in_and_the_other_columns_are_anded(self):
        # 列与列之间是 AND（与 Excel 一致）。
        kept = self._rows([{'column': '名称', 'operator': 'in', 'value': ['A']},
                           {'column': '备注', 'operator': 'equals', 'value': 'x'}],
                          [['A', 'x'], ['A', 'y']], headers=('名称', '备注'))
        self.assertEqual(kept, ['r1'])


class OldOperatorTests(unittest.TestCase):
    """护栏：老四个 operator 的语义一个字不许变。"""

    def _kept(self, operator, value, rows_raw):
        entry = {'headers': ['名称'], 'rows_raw': rows_raw}
        ids = ['r%d' % (index + 1) for index in range(len(rows_raw))]
        return [row['row_id'] for row in
                view.project_rows(entry, ids, {'filters': [{'column': '名称', 'operator': operator, 'value': value}]})]

    def test_contains_is_case_insensitive_substring(self):
        self.assertEqual(self._kept('contains', 'a', [['Abc'], ['xyz']]), ['r1'])

    def test_equals_is_exact(self):
        self.assertEqual(self._kept('equals', 'a', [['a'], ['A'], ['ab']]), ['r1'])

    def test_empty_and_not_empty(self):
        self.assertEqual(self._kept('empty', '', [['a'], [''], [None], [0]]), ['r2', 'r3'])
        self.assertEqual(self._kept('not_empty', '', [['a'], [''], [None], [0]]), ['r1', 'r4'])


class LegacyViewTests(unittest.TestCase):
    """存量 view（value 是字符串的老条件）必须还能校验通过。"""

    def test_legacy_filters_still_validate(self):
        result = view.validate_view(
            {'filters': [{'column': '名称', 'operator': 'contains', 'value': '甲'}],
             'freeze': {'rows': 1, 'columns': 0}}, ['名称'], set())
        self.assertEqual(result['filters'], [{'column': '名称', 'operator': 'contains', 'value': '甲'}])
        self.assertEqual(result['freeze'], {'rows': 1, 'columns': 0})

    def test_legacy_empty_value_still_validates(self):
        # 老视图里 value 可能是空字符串（甚至没给 value）—— 照旧放行。
        result = view.validate_view(
            {'filters': [{'column': '名称', 'operator': 'empty'}],
             'freeze': {'rows': 0, 'columns': 0}}, ['名称'], set())
        self.assertEqual(result['filters'], [{'column': '名称', 'operator': 'empty', 'value': ''}])

    def test_legacy_too_long_value_still_rejected(self):
        with self.assertRaises(ValueError):
            view.validate_view(
                {'filters': [{'column': '名称', 'operator': 'contains', 'value': 'x' * 1001}],
                 'freeze': {'rows': 0, 'columns': 0}}, ['名称'], set())


class InLimitTests(unittest.TestCase):
    """`in` 的值有上限：条数 / 单条长度 / 总长。"""

    def _view(self, values):
        return {'filters': [{'column': '名称', 'operator': 'in', 'value': values}],
                'freeze': {'rows': 0, 'columns': 0}}

    def test_too_many_values_rejected(self):
        with self.assertRaises(ValueError):
            view.validate_view(self._view(['v'] * (view.MAX_IN_VALUES + 1)), ['名称'], set())

    def test_value_too_long_rejected(self):
        with self.assertRaises(ValueError):
            view.validate_view(self._view(['x' * (view.MAX_IN_VALUE_LENGTH + 1)]), ['名称'], set())

    def test_total_length_too_long_rejected(self):
        many = ['x' * view.MAX_IN_VALUE_LENGTH] * 10
        with self.assertRaises(ValueError):
            view.validate_view(self._view(many), ['名称'], set())

    def test_empty_value_list_rejected(self):
        with self.assertRaises(ValueError):
            view.validate_view(self._view([]), ['名称'], set())

    def test_non_string_value_rejected(self):
        with self.assertRaises(ValueError):
            view.validate_view(self._view([1, 2]), ['名称'], set())

    def test_limits_are_the_documented_ones(self):
        self.assertEqual(view.MAX_IN_VALUES, 500)
        self.assertEqual(view.MAX_IN_VALUE_LENGTH, 32767)
        self.assertEqual(view.MAX_IN_TOTAL_LENGTH, 100000)


class ColumnValuesTests(unittest.TestCase):
    """值清单（只读）：整列去重、排序稳定、空值归一、权限闸。"""

    ENTRY = {'headers': ['名称', '备注'], 'rows_raw': [['B', 'x'], ['A', 'y'], ['B', 'z'], ['', 'w']]}
    META = {'rows': ['r1', 'r2', 'r3', 'r4'], 'deleted_rows': []}

    def test_whole_column_distinct_values(self):
        result = _column_values(self.ENTRY, self.META)
        self.assertEqual(result['values'], ['A', 'B', ''])
        self.assertTrue(result['has_blank'])
        self.assertEqual(result['total'], 2)
        self.assertFalse(result['truncated'])

    def test_order_is_stable(self):
        first = _column_values(self.ENTRY, self.META)['values']
        second = _column_values(self.ENTRY, self.META)['values']
        self.assertEqual(first, second)

    def test_invisible_rows_do_not_leak_values(self):
        # 行级 ACL 挡住的行，它的值**不给**（值清单也不能成为泄露口）。
        result = _column_values(self.ENTRY, self.META, allowed=['r1', 'r2'])
        self.assertEqual(result['values'], ['A', 'B'])

    def test_deleted_rows_do_not_contribute(self):
        meta = {'rows': ['r1', 'r2', 'r3', 'r4'], 'deleted_rows': ['r3']}
        result = _column_values(self.ENTRY, meta)
        self.assertEqual(result['values'], ['A', 'B', ''])

    def test_unreadable_column_has_no_values(self):
        with self.assertRaises(frappe.PermissionError):
            _column_values(self.ENTRY, self.META, hidden=('名称',))

    def test_unknown_column_rejected(self):
        with self.assertRaises(ValueError):
            _column_values(self.ENTRY, self.META, column='没有这一列')


if __name__ == '__main__':
    unittest.main()
