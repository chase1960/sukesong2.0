"""三条读路径的回包必须同键；样式只走索引形式，不许再复制一份逐格展开的。

测试通过 = 同**一份 xlsx** 走三条读路径（整簿 `_entry_from_wb`／openpyxl 流式
`_entry_streaming_openpyxl`／快路径 `_entry_fast`）⇒
① 三者回包的**键集合完全一致**（不多一个、不少一个）；
② 回包里**没有 `cell_styles`** 这个「逐格展开的样式」键 ——
   样式只以 `style_ids`＋`font_styles`（＋行/列继承）这套**索引形式**给，
   消费方按需自拼，不让读路径替每格复制一份；
③ 样式信息**没丢**：按 `style_ids`＋`font_styles` 能还原每格的显示格式
   （数字格式／加粗／边框），删掉那个键不是把样式扔了。

背景（PKG-079-T01）：三条读路径给 `cell_styles` 三种形状（整簿＝逐格解析的显示格式／
openpyxl 流式＝共享样式视图／**快路径压根没这个键**），而**全仓没有一处读它**；
真表（9.7MB／15516 数据行）上实测：**763,491 个格每一个都带样式** ⇒ 任何「逐格展开」
的键都是 76 万条 ⇒ 放在生产默认那条快路径上就是每次冷读多占一份大字典。
"""
import ast
import datetime
import io
from pathlib import Path
import sys
import threading
import types
import unittest
from collections import OrderedDict

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import (  # noqa: E402 —— 路径要先装好
    install_real_environment,
    install_stub_package,
    load_module_functions,
)

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/sheet.py'

install_real_environment()
install_stub_package('frappe', ValidationError=ValueError)

_ALL_NAMES = [node.name for node in ast.parse(SOURCE.read_text()).body
              if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
env = load_module_functions(SOURCE, _ALL_NAMES, overrides={'content_revision': lambda doc: 1})
env.update({'content_revision': lambda doc: 1,
            '_PARSE_CACHE': OrderedDict(), '_PARSE_STATS': {}, '_PARSE_CACHE_MAX': 2,
            '_PARSE_LOCK': threading.RLock(), 'MAX_FILE_BYTES': 20 * 1024 * 1024,
            'MAX_ZIP_UNCOMPRESSED': 200 * 1024 * 1024, 'META_FIELD': 'sheet_meta_json',
            'WRITE_DENY_PARTS': ()})


def workbook_bytes():
    book = Workbook()
    ws = book.active
    ws.title = '样例'
    ws.append(['编号', '费用', '日期', '备注'])
    ws.append(['00123', 800, datetime.date(2026, 10, 15), '=SUM(B2)'])
    ws['A2'].font = Font(bold=True, color='112233')
    ws['B2'].number_format = '0.00'
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


class ReadEntryShapeTests(unittest.TestCase):
    def setUp(self):
        self.content = workbook_bytes()
        self.entries = {
            'full': env['_entry_from_wb'](load_workbook(io.BytesIO(self.content)), None, self.content),
            'openpyxl_stream': env['_entry_streaming_openpyxl'](self.content, None),
            'fast': env['_entry_fast'](self.content, None),
        }

    def test_three_read_paths_return_the_same_key_set(self):
        names = sorted(self.entries)
        baseline = set(self.entries['fast'])
        for name in names:
            self.assertEqual(set(self.entries[name]), baseline,
                             '读路径 %s 的回包键集合与快路径不一致' % name)

    def test_no_per_cell_style_key_in_any_read_path(self):
        for name, entry in self.entries.items():
            self.assertNotIn('cell_styles', entry,
                             '读路径 %s 仍在回包里逐格展开样式（那个键全仓没人读）' % name)

    def test_style_information_is_still_available_in_indexed_form(self):
        for name, entry in self.entries.items():
            style_ids = entry.get('style_ids') or {}
            views = entry.get('font_styles') or []
            self.assertTrue(style_ids, '读路径 %s 没有按格记样式号' % name)
            self.assertTrue(views, '读路径 %s 没有共享样式视图' % name)
            # 按格能还原出显示格式：样式号 → 视图里有数字格式／加粗／边框
            coord = sorted(style_ids)[0]
            sid = style_ids[coord]
            self.assertLess(sid, len(views))
            view = views[sid]
            for field in ('number_format', 'bold', 'border'):
                self.assertIn(field, view, '读路径 %s 的样式视图少了 %s' % (name, field))
            self.assertIn('row_style_ids', entry, '读路径 %s 少了行样式继承' % name)
            self.assertIn('column_style_ids', entry, '读路径 %s 少了列样式继承' % name)

    def test_core_read_keys_are_present_in_every_path(self):
        for name, entry in self.entries.items():
            for field in ('sheet_title', 'sheet_titles', 'headers', 'rows_raw',
                          'widths', 'column_types', 'readonly'):
                self.assertIn(field, entry, '读路径 %s 少了 %s' % (name, field))
            self.assertEqual(entry['headers'], ['编号', '费用', '日期', '备注'], name)
            self.assertEqual(entry['rows_raw'][0][0], '00123', name)


if __name__ == '__main__':
    unittest.main()
