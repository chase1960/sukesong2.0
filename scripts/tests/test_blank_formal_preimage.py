"""空行占位沿既有单元格空值口径核对，非空文本/日期冲突仍拒绝。"""
import unittest
from pathlib import Path
from _f_module_seam import install_real_environment, load_module_functions
install_real_environment()

PATH = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/promotion.py'
ns = load_module_functions(PATH, {'same_formal_value'})
same = ns['same_formal_value']


class BlankFormalPreimage(unittest.TestCase):
    def test_row_placeholder_and_empty_projection_are_the_same_blank(self):
        for blank in (None, '', ' ', '\t\n'):
            with self.subTest(blank=blank):
                self.assertTrue(same(blank, {'type': 'empty', 'value': None}))
                self.assertTrue(same(None, {'type': 'text', 'value': blank}))

    def test_nonempty_text_does_not_trim_or_gain_empty_equivalence(self):
        self.assertFalse(same(' 00123 ', {'type': 'text', 'value': '00123'}))
        self.assertFalse(same('x', {'type': 'empty', 'value': None}))
        self.assertFalse(same(False, {'type': 'empty', 'value': None}))
        self.assertFalse(same(0, {'type': 'empty', 'value': None}))
        self.assertTrue(same('00123', {'type': 'text', 'value': '00123'}))

    def test_date_sync_semantics_remain_strict(self):
        self.assertTrue(same('2026-10-29', {'type': 'date', 'value': '2026-10-29T00:00:00'}))
        self.assertFalse(same('2026-10-29', {'type': 'date', 'value': '2026-10-30T00:00:00'}))


if __name__ == '__main__':
    unittest.main()
