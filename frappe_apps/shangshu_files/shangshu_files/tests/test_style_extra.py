"""扩展单元格格式：填充色、斜体、下划线、对齐、清除格式。

测试通过 = 什么成立：
- 填充色写成实心 patternFill（fgColor = FF+RRGGBB），读回来还是同一个颜色；
- 斜体/下划线写进 <font>，取消时整个属性**去掉**（不是留一个 false）；
- 水平/垂直对齐写进 <alignment>，'none' 时属性**去掉**（回到默认）；
- 清除格式：整格回到默认（无填充、无边框、无对齐、非加粗）；
- 非法输入一律中文报错，不静默放过；
- 写后核验：读回来的与请求不一致就报错（整批不保存）。
"""
import unittest

from shangshu_files.style_extra import (
    HORIZONTAL_ALIGNS,
    VERTICAL_ALIGNS,
    alignment_view,
    build_fill_xml,
    fill_color_of,
    font_flags_of,
    normalize_align,
    normalize_extra_patch,
    normalize_fill_color,
    patch_font_flags,
    set_alignment,
    verify_cleared_after,
    verify_extra_after,
)


class TestFillColor(unittest.TestCase):
    def test_fill_color_is_written_as_a_solid_pattern_fill(self):
        xml = build_fill_xml(b'', '#FFEE00')
        self.assertIn(b'patternType="solid"', xml)
        self.assertIn(b'fgColor rgb="FFFFEE00"', xml)

    def test_fill_color_reads_back_the_same_color(self):
        xml = build_fill_xml(b'', '#FFEE00')
        self.assertEqual(fill_color_of(xml), '#FFEE00')

    def test_no_fill_reads_back_as_none(self):
        self.assertIsNone(fill_color_of(b'<fill><patternFill patternType="none"/></fill>'))
        self.assertIsNone(fill_color_of(b'<fill/>'))

    def test_fill_color_is_normalized_to_upper_case(self):
        self.assertEqual(normalize_fill_color('#ffee00'), '#FFEE00')

    def test_none_clears_the_fill(self):
        self.assertIsNone(normalize_fill_color('none'))
        self.assertIsNone(normalize_fill_color(None))

    def test_bad_fill_color_is_rejected_with_a_chinese_message(self):
        with self.assertRaises(ValueError) as caught:
            normalize_fill_color('red')
        self.assertIn('填充色', str(caught.exception))


class TestFontFlags(unittest.TestCase):
    def test_italic_and_underline_are_written_into_the_font(self):
        raw = patch_font_flags(b'<font><sz val="11"/></font>', italic=True, underline=True)
        self.assertIn(b'<i/>', raw)
        self.assertIn(b'<u ', raw)
        flags = font_flags_of(raw)
        self.assertTrue(flags['italic'])
        self.assertTrue(flags['underline'])

    def test_false_removes_the_property_entirely(self):
        raw = patch_font_flags(b'<font><i/><u val="single"/></font>', italic=False, underline=False)
        self.assertNotIn(b'<i', raw)
        self.assertNotIn(b'<u', raw)
        flags = font_flags_of(raw)
        self.assertFalse(flags['italic'])
        self.assertFalse(flags['underline'])

    def test_not_touched_keys_stay_untouched(self):
        raw = patch_font_flags(b'<font><sz val="11"/><name val="Calibri"/></font>', italic=True)
        self.assertIn(b'<sz val="11"/>', raw)
        self.assertIn(b'<name val="Calibri"/>', raw)

    def test_self_closing_font_is_expanded_before_patching(self):
        raw = patch_font_flags(b'<font/>', italic=True)
        self.assertIn(b'<i/>', raw)


class TestAlignment(unittest.TestCase):
    def test_horizontal_and_vertical_alignment_are_written(self):
        xf = set_alignment(b'<xf numFmtId="0"/>', horizontal='center', vertical='top')
        view = alignment_view(xf)
        self.assertEqual(view['horizontal_align'], 'center')
        self.assertEqual(view['vertical_align'], 'top')

    def test_none_removes_the_alignment_attribute(self):
        xf = set_alignment(b'<xf numFmtId="0"><alignment horizontal="center"/></xf>', horizontal=None)
        view = alignment_view(xf)
        self.assertIsNone(view['horizontal_align'])

    def test_alignment_never_touches_the_other_axis(self):
        xf = set_alignment(b'<xf numFmtId="0"><alignment vertical="top"/></xf>', horizontal='right')
        view = alignment_view(xf)
        self.assertEqual(view['horizontal_align'], 'right')
        self.assertEqual(view['vertical_align'], 'top')

    def test_wrap_text_still_works(self):
        xf = set_alignment(b'<xf numFmtId="0"/>', wrap=True)
        self.assertIn(b'wrapText="1"', xf)

    def test_align_values_are_validated(self):
        self.assertEqual(normalize_align('horizontal_align', 'center'), 'center')
        self.assertEqual(normalize_align('vertical_align', 'top'), 'top')
        with self.assertRaises(ValueError) as caught:
            normalize_align('horizontal_align', 'middle')
        self.assertIn('对齐方式', str(caught.exception))
        with self.assertRaises(ValueError):
            normalize_align('vertical_align', 'left')


class TestNormalizePatch(unittest.TestCase):
    def test_valid_patch_is_accepted(self):
        patch = normalize_extra_patch({'fill_color': '#ffee00', 'italic': True,
                                       'underline': False, 'horizontal_align': 'center',
                                       'vertical_align': 'none'})
        self.assertEqual(patch['fill_color'], '#FFEE00')
        self.assertTrue(patch['italic'])
        self.assertFalse(patch['underline'])
        self.assertEqual(patch['horizontal_align'], 'center')
        self.assertIsNone(patch['vertical_align'])

    def test_clear_format_cannot_be_combined_with_other_settings(self):
        with self.assertRaises(ValueError) as caught:
            normalize_extra_patch({'clear_format': True, 'italic': True})
        self.assertIn('清除格式', str(caught.exception))

    def test_clear_format_must_be_true(self):
        with self.assertRaises(ValueError):
            normalize_extra_patch({'clear_format': False})

    def test_non_boolean_flags_are_rejected(self):
        with self.assertRaises(ValueError):
            normalize_extra_patch({'italic': 'yes'})


class TestVerifyAfter(unittest.TestCase):
    def test_matching_after_passes(self):
        after = {'italic': True, 'underline': False, 'fill_color': '#FFEE00',
                 'horizontal_align': 'center', 'vertical_align': None}
        self.assertTrue(verify_extra_after(after, {'italic': True, 'fill_color': '#FFEE00',
                                                   'horizontal_align': 'center'}))

    def test_mismatched_after_is_rejected(self):
        after = {'italic': False, 'fill_color': None}
        with self.assertRaises(ValueError) as caught:
            verify_extra_after(after, {'italic': True})
        self.assertIn('核验失败', str(caught.exception))

    def test_cleared_cell_must_look_like_the_default(self):
        default = {'font_size': 11}
        cleared = {'font_size': 11, 'bold': False, 'italic': False, 'underline': False,
                   'fill_color': None, 'horizontal_align': None, 'vertical_align': None,
                   'number_format': 'General',
                   'border': {'top': {'style': None}, 'bottom': {'style': None},
                              'left': {'style': None}, 'right': {'style': None}}}
        self.assertTrue(verify_cleared_after(cleared, default))

    def test_cleared_cell_with_a_remaining_fill_is_rejected(self):
        default = {'font_size': 11}
        dirty = {'font_size': 11, 'bold': False, 'italic': False, 'underline': False,
                 'fill_color': '#FFEE00', 'horizontal_align': None, 'vertical_align': None,
                 'number_format': 'General', 'border': {}}
        with self.assertRaises(ValueError) as caught:
            verify_cleared_after(dirty, default)
        self.assertIn('填充色', str(caught.exception))


class TestAlignLists(unittest.TestCase):
    def test_allowed_values_are_the_product_ones(self):
        self.assertEqual(HORIZONTAL_ALIGNS, ('left', 'center', 'right'))
        self.assertEqual(VERTICAL_ALIGNS, ('top', 'center', 'bottom'))
