"""公开读口 `files.sheet_read` 的逐行 `styles` 只带「和默认不一样」的格；默认样式整表只发一次。

**测试通过 = 什么成立**：
  ① 一份**没改过任何样式**的表 ⇒ 逐行 `styles` 里**没有**那些未改格（且顶层 `default_style` 在）；
  ② **改过样式的格** ⇒ 它的样式**值完整保留**（字号/颜色/加粗/边框/换行一个不少）；
  ③ **行级/列级继承**来的样式**仍然生效**（继承来的若≠默认就在回包里；＝默认就不在）；
  ④ 三条读路径（`_entry_fast` / `_entry_streaming_openpyxl` / `_entry_from_wb`）**键集合一致**；
  ⑤ `default_style` ＝ `font_styles[0]`（**同一份**，不是那份硬编码兜底）；
  ⑥ **任何一格**「缺项时的回落」＝ 它真实的样式（回落不缺一个值）—— 消费方按缺项回落到
     表级默认时，拿到的就是这一格本来的样子；
  ⑦ 体积：没改过样式的表 ⇒ 逐行 styles 的体积**不足旧写法（逐格一份默认）的 1%**。

⚠️ **离线跑**（不需要站上服务）：用域里那一份离线脚手架 `offline_env.OfflineEnv`
   （框架替身 ＋ 假公共口）＋ 真的 openpyxl 造的 xlsx 字节 ⇒ 跑的是**真的解析与投影**。
"""
import json
import unittest
from io import BytesIO

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from shangshu_files.tests import offline_env


def _workbook_bytes():
    """一份带三种样式的 xlsx：

    · A 列 —— **列级**样式（整列 sz 15 斜体）
    · 第 3 行 —— **行级**样式（整行 sz 30）
    · B2 —— **格级**样式（sz 20 加粗红字 + 填充）
    · C3 —— **格级**样式（上边框细线 + 自动换行）
    · C2 —— 一个**什么都没改**的格（默认样式）
    """
    wb = Workbook()
    ws = wb.active
    ws.title = '报价'
    ws.append(['客户', '数量', '备注'])
    ws.append(['甲', 10, 'a'])
    ws.append(['乙', 20, 'b'])
    ws['B2'].font = Font(sz=20, bold=True, color='FF0000')
    ws['B2'].fill = PatternFill('solid', fgColor='FFFFC4')
    ws['C3'].border = Border(top=Side(style='thin'))
    ws['C3'].alignment = Alignment(wrap_text=True)
    ws.row_dimensions[3].font = Font(sz=30)
    ws.column_dimensions['A'].font = Font(sz=15, italic=True)
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def _plain_workbook_bytes(columns=20, rows=30):
    """一份**什么都没改过样式**的表（用来量体积）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = '报价'
    ws.append(['列%d' % i for i in range(1, columns + 1)])
    for r in range(rows):
        ws.append(['值%d-%d' % (r, c) for c in range(1, columns + 1)])
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


class SheetReadStylesPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = offline_env.OfflineEnv()
        cls.env.__enter__()
        cls.sheet = cls.env.import_domain('sheet')['sheet']

    @classmethod
    def tearDownClass(cls):
        cls.env.__exit__(None, None, None)

    # —— 小工具 ——
    def _entry(self, content):
        return self.sheet._entry_fast(content, False)

    def _row_styles(self, entry, pos, headers=None):
        headers = headers or entry['headers']
        return self.sheet._row_style_views(entry, pos, headers, set(headers))

    def _resolved(self, entry, pos, headers):
        """这一行**每一格**真实解析出来的样式（按回包的解析顺序，按格→行→列→0）。"""
        views = entry.get('font_styles') or []
        out = {}
        for i in range(1, len(headers) + 1):
            sid = (entry.get('style_ids') or {}).get((pos + 2, i),
                   (entry.get('row_style_ids') or {}).get(pos + 2,
                   (entry.get('column_style_ids') or {}).get(i, 0)))
            out[headers[i - 1] or ('列%d' % i)] = views[sid] if sid < len(views) else \
                {'font_size': None, 'font_color': None, 'bold': False}
        return out

    # —— ① 没改过样式的格不进回包；顶层 default_style 在 ——
    def test_unchanged_cell_is_absent_and_table_default_is_published(self):
        content = _workbook_bytes()
        entry = self._entry(content)
        headers = entry['headers']
        row2 = self._row_styles(entry, 0, headers)
        # C2 什么都没改 ⇒ 不带项
        self.assertNotIn('备注', row2, '没改过样式的格不该在逐行 styles 里')
        # 顶层表级默认在，且就是工作簿默认 xf 那份
        self.assertIn('default_style', entry, '读路径条目必须带表级默认样式')
        self.assertTrue(entry['default_style'])

    # —— ② 改过样式的格：值完整保留 ——
    def test_changed_cell_keeps_every_style_value(self):
        content = _workbook_bytes()
        entry = self._entry(content)
        headers = entry['headers']
        row2 = self._row_styles(entry, 0, headers)
        b2 = row2['数量']
        self.assertEqual(b2['font_size'], 20, '字号丢了')
        self.assertTrue(b2['bold'], '加粗丢了')
        self.assertEqual(b2['font_color'], '#FF0000', '字体颜色丢了')
        self.assertEqual(b2['fill_color'], '#FFFFC4', '填充色丢了')
        row3 = self._row_styles(entry, 1, headers)
        c3 = row3['备注']
        self.assertEqual(c3['border']['top']['style'], 'thin', '边框丢了')
        self.assertIsNone(c3['border']['left']['style'], '没设的边框那几边不该被编出来')
        self.assertTrue(c3['wrap_text'], '换行丢了')

    # —— ③ 行级/列级继承仍然生效 ——
    def test_row_and_column_inherited_styles_still_arrive(self):
        content = _workbook_bytes()
        entry = self._entry(content)
        headers = entry['headers']
        row2 = self._row_styles(entry, 0, headers)
        row3 = self._row_styles(entry, 1, headers)
        # 列级（A 列整列 sz 15 斜体）⇒ A2 带这一份
        self.assertIn('客户', row2, '列级样式没进回包')
        self.assertEqual(row2['客户']['font_size'], 15, '列级样式的字号不对')
        self.assertTrue(row2['客户']['italic'], '列级样式的斜体不对')
        # 行级（第 3 行整行 sz 30）⇒ A3/B3 带这一份
        self.assertEqual(row3['客户']['font_size'], 30, '行级样式没生效')
        self.assertEqual(row3['数量']['font_size'], 30, '行级样式没生效')

    # —— ④ 三条读路径键集合一致 ——
    def test_three_read_paths_expose_the_same_keys(self):
        content = _workbook_bytes()
        wb = load_workbook(BytesIO(content), data_only=False)
        entries = {
            'fast': self.sheet._entry_fast(content, False),
            'streaming_openpyxl': self.sheet._entry_streaming_openpyxl(content, False),
            'openpyxl': self.sheet._entry_from_wb(wb, False, content),
        }
        base = set(entries['fast'])
        for name, entry in entries.items():
            self.assertEqual(set(entry), base, '%s 这条读路径的键集合与快路径不一致' % name)
            for key in ('style_ids', 'font_styles', 'row_style_ids', 'column_style_ids', 'default_style'):
                self.assertIn(key, entry, '%s 这条读路径缺 %s' % (name, key))

    # —— ⑤ default_style ＝ font_styles[0] ——
    def test_default_style_is_the_first_shared_style_view(self):
        content = _workbook_bytes()
        for name, entry in (('fast', self._entry(content)),
                            ('streaming_openpyxl', self.sheet._entry_streaming_openpyxl(content, False))):
            views = entry.get('font_styles') or []
            self.assertTrue(views, '%s 这条读路径没有共享样式视图' % name)
            self.assertEqual(entry['default_style'], views[0],
                             '%s 的表级默认样式不是 font_styles[0]' % name)
            # **不是**那份硬编码兜底（真默认带字号 11 / 边框四边）
            self.assertIsNotNone(entry['default_style'].get('font_size'),
                                 '%s 的表级默认样式不该是那份硬编码兜底' % name)

    # —— ⑥ 缺项回落 ＝ 真实样式 ——
    def test_missing_entry_falls_back_to_the_cells_own_style(self):
        content = _workbook_bytes()
        entry = self._entry(content)
        headers = entry['headers']
        default = self.sheet._default_style_of(entry)
        for pos in range(2):
            published = self._row_styles(entry, pos, headers)
            for header, real in self._resolved(entry, pos, headers).items():
                fallback = published.get(header, default)
                self.assertEqual(fallback, real,
                                 '第 %d 行的「%s」缺项回落拿到的不是它本来的样式' % (pos + 2, header))

    # —— ⑦ 体积 ——
    def test_unchanged_table_payload_shrinks_below_one_percent(self):
        content = _plain_workbook_bytes()
        entry = self._entry(content)
        headers = entry['headers']
        old_size = new_size = 0
        for pos in range(30):
            old = self._resolved(entry, pos, headers)
            new = self._row_styles(entry, pos, headers)
            old_size += len(json.dumps(old, ensure_ascii=False).encode())
            new_size += len(json.dumps(new, ensure_ascii=False).encode())
            self.assertEqual(new, {}, '没改过样式的表不该有逐格样式')
        self.assertGreater(old_size, 0)
        self.assertLess(new_size, old_size * 0.01,
                         '逐行 styles 体积没降到旧写法的 1%% 以下（旧 %d 字节 → 新 %d 字节）'
                         % (old_size, new_size))


if __name__ == '__main__':
    unittest.main()
