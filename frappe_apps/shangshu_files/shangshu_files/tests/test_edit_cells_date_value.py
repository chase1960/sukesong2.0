"""`files.edit_cells` **能写日期格**（2026-10-28 · PKG-132 收尾实测撞出来的缺口）。

**测试通过 = 什么成立**（一句话）

「写一格**日期**时，载荷里的类型标记 `d` ⇒ 写进去的是**日期**（不是文本）；
  **动作的输入 schema 也放行这个类型标记** ⇒ 调用方按 schema 填**不会被当场拒**。」

⚠️ **缺口是怎么撞出来的**（站上实测）：
  要把客户总表里「混着好几种写法」的日期列清干净（文本日期／带说明的文本／Excel 序列号
  都要变成真日期），走的就是这个动作 ⇒ 而载荷的类型标记**只有 s／n／b**
  ⇒ **日期格写不进去**（写入口按列类型判：「定稿日期 须为日期」）⇒ 产品改不了日期列。

⚠️ **为什么不是「文本凑合」**：日期列的格子里必须**是日期**
  （晋升预检按列声明的类型判：文本日期只认 `YYYY-MM-DD`，Excel 日期认日期值）。
"""
import unittest

from shangshu_files import cells


class EditCellsDateValueTest(unittest.TestCase):
    """**日期格能写**。"""

    def test_the_date_marker_becomes_a_date_value(self):
        """`{'t':'d','v':'2020-12-31'}` ⇒ **日期**类型。"""
        self.assertEqual(cells._typed({'t': 'd', 'v': '2020-12-31'}),
                         {'type': 'date', 'value': '2020-12-31'})

    def test_the_other_markers_still_work(self):
        """**别把原来那三档改坏**（文本／数字／布尔）。"""
        self.assertEqual(cells._typed({'t': 's', 'v': 'x'}), {'type': 'text', 'value': 'x'})
        self.assertEqual(cells._typed({'t': 'n', 'v': 3}), {'type': 'number', 'value': 3})
        self.assertEqual(cells._typed({'t': 'b', 'v': True}), {'type': 'boolean', 'value': True})
        self.assertEqual(cells._typed(None), {'type': 'empty', 'value': None})

    def test_an_unknown_marker_is_refused(self):
        """**认不出的类型标记当场拒**（不猜）。"""
        with self.assertRaises(ValueError):
            cells._typed({'t': 'x', 'v': '2020-12-31'})

    def test_the_row_bound_covers_a_real_table(self):
        """**行号上限够一张真表**（客户总表 15,503 行 ⇒ 1000 的上限等于只能改前一千行）。"""
        from shangshu_files.tests import offline_env

        with offline_env.OfflineEnv() as env:
            domain = env.import_domain('domain')['domain']
            entry = next(item for item in domain.ACTIONS if item[0] == 'files.edit_cells')
            row_schema = entry[3]['properties']['changes']['items']['properties']['row']
            self.assertGreaterEqual(int(row_schema.get('maximum') or 0), 20000,
                                    "行号上限太小（真表 15,503 行 ⇒ 改不到后面的行）：%r" % (row_schema,))

    def test_the_action_schema_allows_the_date_marker(self):
        """**动作的输入 schema 放行 `d`**（不然调用方按 schema 填就被拒）。"""
        from shangshu_files.tests import offline_env

        with offline_env.OfflineEnv() as env:
            domain = env.import_domain('domain')['domain']
            entry = next(item for item in domain.ACTIONS if item[0] == 'files.edit_cells')
            schema = entry[3]
            value_schema = schema['properties']['changes']['items']['properties']['value']
            marker = value_schema['properties']['t']
            self.assertIn('d', marker.get('enum') or [],
                          "动作的输入 schema 没放行日期的类型标记 `d`：%r" % (marker,))
            self.assertIn('v', value_schema['properties'],
                          "值的载荷形状变了（老调用方会挂）")


if __name__ == '__main__':
    unittest.main()
