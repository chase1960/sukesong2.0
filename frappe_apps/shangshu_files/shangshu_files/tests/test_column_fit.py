"""按内容自动算列宽。

测试通过 = 什么成立：
- 拉丁文按字符数算，中日韩字符**占两格**（一个汉字比一个字母宽）；
- 算出来的宽度留了 2 格余量（不然最后一个字贴边）；
- 空列给一个最小宽度（6 格），超长内容封顶 255 格（xlsx 上限）；
- 数字按它的字面长度算（1234.5 是 6 格，不按数值大小）。
"""
import unittest

from shangshu_files.column_fit import display_width, fit_width


class TestDisplayWidth(unittest.TestCase):
    def test_ascii_counts_one_per_char(self):
        self.assertEqual(display_width('abc'), 3)
        self.assertEqual(display_width(''), 0)
        self.assertEqual(display_width(None), 0)

    def test_chinese_counts_two_per_char(self):
        self.assertEqual(display_width('名称'), 4)
        self.assertEqual(display_width('A名'), 3)

    def test_mixed_text_sums_up(self):
        self.assertEqual(display_width('甲A乙'), 5)

    def test_numbers_use_their_text_length(self):
        self.assertEqual(display_width('1234.5'), 6)
        self.assertEqual(display_width(1234.5), 6)


class TestFitWidth(unittest.TestCase):
    def test_width_has_two_chars_of_padding(self):
        # 内容 3 格 + 余量 2 格 = 5，但窄列不低于 6 格（否则标题都放不下）
        self.assertEqual(fit_width(['abcdefgh']), 10)
        self.assertEqual(fit_width(['abc']), 6)

    def test_widest_cell_wins(self):
        self.assertEqual(fit_width(['a', 'abcdef', 'ab']), 8)

    def test_empty_column_gets_the_minimum_width(self):
        self.assertEqual(fit_width([]), 6)
        self.assertEqual(fit_width([None, '']), 6)

    def test_very_long_content_is_capped(self):
        self.assertEqual(fit_width(['x' * 500]), 255)

    def test_chinese_column_is_wider_than_the_same_length_ascii(self):
        self.assertGreater(fit_width(['名称列']), fit_width(['abcd']))
