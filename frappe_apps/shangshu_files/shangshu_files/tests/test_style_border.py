"""单元格边框预设：外框/内框/单边按选区算，写后核验不放过半成品。

测试通过 = 什么成立：
- 3×3 选区挑「外框」时，只有贴边的格画外侧线，正中间的格一条线都不画；
- 挑「内框」时，只画选区内部的横竖分隔线，外围不画；
- 挑「全部边框」时每格四边都有线；
- 单边预设只作用在选区的那一条边上；
- 线型与颜色真的写进了 xlsx 边框定义（rgb=FFRRGGBB）；
- 写后核验：读回来的边和请求不一致就报错，一致才放行；
- 非法预设、非法线型、非法颜色都被中文消息挡下。
"""
import unittest

from shangshu_files.style_border import (
    BORDER_PRESETS,
    DEFAULT_BORDER_COLOR,
    build_border_xml,
    edges_for_cell,
    normalize_border,
    verify_border_after,
)


def grid(preset, bounds=(1, 3, 1, 3)):
    """把一个预设摊成 {'col,row': {side: edge}}，没有线的格也保留（空字典）。"""
    min_col, max_col, min_row, max_row = bounds
    out = {}
    for row in range(min_row, max_row + 1):
        for col in range(min_col, max_col + 1):
            out['%d,%d' % (col, row)] = edges_for_cell(
                preset, 'thin', DEFAULT_BORDER_COLOR, col, row, bounds)
    return out


class TestBorderPresets(unittest.TestCase):
    def test_outer_border_only_touches_the_selection_boundary(self):
        cells = grid('outer')
        self.assertEqual(set(cells['1,1']), {'top', 'left'}, '左上角只有上边和左边')
        self.assertEqual(set(cells['3,3']), {'bottom', 'right'}, '右下角只有下边和右边')
        self.assertEqual(set(cells['2,2']), set(), '正中间的格不该有线')
        self.assertEqual(set(cells['1,3']), {'bottom', 'left'})
        self.assertEqual(set(cells['3,1']), {'top', 'right'})

    def test_inner_border_only_draws_inside_lines(self):
        cells = grid('inner')
        self.assertEqual(set(cells['1,1']), {'bottom', 'right'},
                         '外角格朝内的两条线属于内部框，外侧两条不画')
        self.assertEqual(set(cells['2,2']), {'top', 'bottom', 'left', 'right'})
        self.assertEqual(set(cells['3,3']), {'top', 'left'},
                         '右下角有两条朝内的线，但没有选区外框那两条')
        for cell, side in (('1,2', 'right'), ('2,1', 'bottom')):
            self.assertIn(side, cells[cell], '内部竖线/横线要画出来')

    def test_all_border_marks_every_cell_on_four_sides(self):
        cells = grid('all')
        self.assertEqual(len(cells), 9)
        for edges in cells.values():
            self.assertEqual(set(edges), {'top', 'bottom', 'left', 'right'})

    def test_single_side_preset_only_hits_its_own_edge_of_the_range(self):
        top = {key: edges for key, edges in grid('top').items() if edges}
        self.assertEqual(set(top), {'1,1', '2,1', '3,1'}, '上边框只落在选区第一行')
        for edges in top.values():
            self.assertEqual(set(edges), {'top'})
        left = {key: edges for key, edges in grid('left').items() if edges}
        self.assertEqual(set(left), {'1,1', '1,2', '1,3'}, '左边框只落在选区第一列')

    def test_none_preset_clears_every_side(self):
        self.assertEqual({key: edges for key, edges in grid('none').items() if edges}, {})

    def test_single_cell_selection_outer_border_is_a_full_box(self):
        cells = grid('outer', bounds=(2, 2, 2, 2))
        self.assertEqual(set(cells['2,2']), {'top', 'bottom', 'left', 'right'})

    def test_preset_set_is_exactly_what_the_ui_offers(self):
        self.assertEqual(BORDER_PRESETS,
                         ('none', 'all', 'outer', 'inner', 'top', 'bottom', 'left', 'right'))


class TestBorderNormalization(unittest.TestCase):
    def test_legacy_string_border_still_normalizes(self):
        self.assertEqual(normalize_border('all'),
                         {'preset': 'all', 'style': 'thin', 'color': DEFAULT_BORDER_COLOR})
        self.assertEqual(normalize_border('none')['preset'], 'none')

    def test_object_border_keeps_style_and_color(self):
        got = normalize_border({'preset': 'outer', 'style': 'double', 'color': '#ff0000'})
        self.assertEqual(got, {'preset': 'outer', 'style': 'double', 'color': '#FF0000'})

    def test_unknown_preset_is_rejected_with_chinese_message(self):
        with self.assertRaises(ValueError) as caught:
            normalize_border({'preset': 'rainbow'})
        self.assertIn('边框预设', str(caught.exception))

    def test_unknown_line_style_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            normalize_border({'preset': 'all', 'style': 'squiggly'})
        self.assertIn('线型', str(caught.exception))

    def test_bad_color_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            normalize_border({'preset': 'all', 'color': 'red'})
        self.assertIn('颜色', str(caught.exception))


class TestBorderXml(unittest.TestCase):
    def test_xml_contains_requested_style_and_argb_color(self):
        edges = edges_for_cell('outer', 'dashed', '#D1D5DB', 1, 1, (1, 3, 1, 3))
        xml = build_border_xml(b'', edges)
        self.assertIn(b'<left style="dashed"><color rgb="FFD1D5DB"/></left>', xml)
        self.assertIn(b'<right/>', xml, '没画的边必须是空标签')
        self.assertIn(b'<diagonal/>', xml)
        self.assertLess(xml.index(b'<left'), xml.index(b'<right'), '边序要符合 OOXML')
        self.assertLess(xml.index(b'<right'), xml.index(b'<top'))

    def test_namespace_prefix_is_kept(self):
        xml = build_border_xml(b'x:', edges_for_cell('all', 'thin', '#000000', 1, 1, (1, 1, 1, 1)))
        self.assertIn(b'<x:border>', xml)
        self.assertIn(b'<x:left style="thin">', xml)


class TestBorderWriteVerification(unittest.TestCase):
    def test_matching_readback_passes(self):
        expected = edges_for_cell('all', 'thin', '#D1D5DB', 1, 1, (1, 2, 1, 2))
        actual = {side: {'style': 'thin', 'color': '#D1D5DB'} for side in expected}
        actual.update({side: {'style': None, 'color': None}
                       for side in ('top', 'bottom', 'left', 'right') if side not in expected})
        verify_border_after(actual, expected)

    def test_readback_with_wrong_style_fails(self):
        expected = edges_for_cell('all', 'thin', '#D1D5DB', 1, 1, (1, 1, 1, 1))
        actual = {'top': {'style': 'thick', 'color': '#D1D5DB'},
                  'bottom': {'style': 'thin', 'color': '#D1D5DB'},
                  'left': {'style': 'thin', 'color': '#D1D5DB'},
                  'right': {'style': 'thin', 'color': '#D1D5DB'}}
        with self.assertRaises(ValueError) as caught:
            verify_border_after(actual, expected)
        self.assertIn('核验失败', str(caught.exception))

    def test_readback_with_wrong_color_fails(self):
        expected = edges_for_cell('all', 'thin', '#D1D5DB', 1, 1, (1, 1, 1, 1))
        actual = {'top': {'style': 'thin', 'color': '#000000'},
                  'bottom': {'style': 'thin', 'color': '#D1D5DB'},
                  'left': {'style': 'thin', 'color': '#D1D5DB'},
                  'right': {'style': 'thin', 'color': '#D1D5DB'}}
        with self.assertRaises(ValueError):
            verify_border_after(actual, expected)

    def test_missing_side_is_detected(self):
        expected = edges_for_cell('all', 'thin', '#D1D5DB', 1, 1, (1, 1, 1, 1))
        actual = {'top': {'style': 'thin', 'color': '#D1D5DB'}}
        with self.assertRaises(ValueError):
            verify_border_after(actual, expected)


if __name__ == '__main__':
    unittest.main()
