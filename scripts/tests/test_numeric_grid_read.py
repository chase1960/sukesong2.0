#!/usr/bin/env python3
"""Read raw numeric values without date guesses; no private workbook or Frappe required."""
import datetime
import io
import sys
import unittest
import warnings
import zipfile
from pathlib import Path

from openpyxl import Workbook, load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions  # noqa: E402 —— 路径要先装好

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/sheet.py'

install_real_environment()

# 真模块装载：顶层 import 按真包解析（`shangshu_files.zipedit` / `openpyxl` 都是真的），
# 用到的**同文件兄弟函数自动跟着进来**（`_assert_table_headers` 等）——不再手抄上下文。
env = load_module_functions(SOURCE, [
    '_entry_streaming_openpyxl', '_entry_fast', '_raw_numeric_read_values', '_entry_streaming',
    '_entry_from_wb', '_dominant_type', 'value_typed', '_headers_of', '_iter_real_cells',
    '_data_extent', '_widths_of', '_literal_text', '_style_read_cache', '_style_index',
    '_style_blocks', '_style_font_view', '_style_views_from_wb', '_style_element',
    '_style_border_view',
])


def fixture():
    workbook = Workbook()
    sheet = workbook.active
    for column in range(1, 5):
        sheet.cell(1, column, 'field' + str(column))
    sheet['A2'] = 15058300000
    sheet['A2'].number_format = 'm/d/yy'
    sheet['B2'] = '#VALUE!'
    sheet['C2'] = 45000
    sheet['C2'].number_format = 'm/d/yy'
    sheet['D2'] = '=1+1'
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


class NumericGridRead(unittest.TestCase):
    def test_stream_reads_raw_numeric_and_preserves_real_error_date_formula(self):
        source = fixture()
        raw = zipfile.ZipFile(io.BytesIO(source)).read('xl/worksheets/sheet1.xml')
        self.assertIn(b'<v>15058300000</v>', raw)
        values = env['_entry_streaming'](source, None)['rows_raw'][0]
        self.assertEqual(values[:2], (15058300000, '#VALUE!'))
        self.assertIsInstance(values[2], datetime.datetime)
        self.assertEqual(values[3], '=1+1')

    def test_full_read_uses_same_recovery_without_changing_workbook_object(self):
        source = fixture()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            workbook = load_workbook(io.BytesIO(source), data_only=False)
        values = env['_entry_from_wb'](workbook, None, source)['rows_raw'][0]
        self.assertEqual(values[:2], (15058300000, '#VALUE!'))
        self.assertEqual(workbook.active['A2'].value, '#VALUE!')

    def test_raw_recovery_excludes_original_error_and_formula(self):
        source = fixture()
        recovered = env['_raw_numeric_read_values'](source, 'Sheet', {'A2', 'B2', 'D2'})
        self.assertEqual(recovered, {'A2': 15058300000})
        self.assertEqual(env['_raw_numeric_read_values'](source, 'Sheet', set()), {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
