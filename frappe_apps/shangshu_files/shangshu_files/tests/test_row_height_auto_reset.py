"""**恢复自动行高**（2026-10-29 用户口径：「再点一次自动行高」的回头路）。

**测试通过 = 什么成立**（一句话）

「给 `files.sheet_row_heights_write` 传 **0**（＝**恢复自动**）⇒ 写后那一行在 xlsx 里
  **没有** `ht`／`customHeight` ⇒ **重开读回来也没有**这一行的行高（那一行回到自动行高）；
  而传正常的行高（pt）⇒ 照旧写进去、也读得回来（别把原来那条路改坏）。」

⚠️ **为什么用 0 表示「恢复自动」**：
  行高**存在 xlsx 文件里**（`sheet.py` 的 `_row_height_surgery` 改写 `<row ht=… customHeight="1">`）
  ⇒ 是**全表共享**的 ⇒「恢复自动」也得**写回文件**，
  否则刷新一下又变回手拖的高度（人看着像没生效）。
  值域是「行高（pt）」⇒ 正数是高度 ⇒ **0 拿来当「这一行没有固定高度」的记号**
  （xlsx 里就是「不写 ht／customHeight」⇒ 打开就是自动行高）。

⚠️ **为什么入参 schema 也得改**：平台的入参校验按 schema 走
  （`shangshu_core/schema_validation.py` 的 `additionalProperties.minimum`）
  ⇒ schema 还写着 `minimum: 1` 的话，**0 在进动作之前就被拒** ⇒ 这条路根本走不通。
"""
import re
import unittest
from io import BytesIO

from shangshu_files.tests import offline_env


def _workbook_bytes():
    """造一份最小的 xlsx：表头一行 ＋ 两行数据（Excel 行号 2、3）。"""
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = 'S-1'
    sheet.append(['名称', '备注'])
    sheet.append(['甲', '乙'])
    sheet.append(['丙', '丁'])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def _row_tag(content, part, number):
    """xlsx 里第 `number` 行的那段 `<row …>` 标签（字节）。"""
    from shangshu_files import zipedit
    xml = zipedit.read_sheet(content, part)
    match = re.search(rb'<row\b[^>]*\br="%d"[^>]*>' % number, xml)
    return match.group(0) if match else b''


class RowHeightAutoResetTest(unittest.TestCase):
    """**0 = 恢复自动行高**。"""

    def setUp(self):
        self.env = offline_env.OfflineEnv()
        self.env.__enter__()
        self.sheet = self.env.import_domain('sheet')['sheet']
        # 用**域自己那份** zipedit（`sheet` 绑的就是它）⇒ 同一套字节读写。
        self.zipedit = self.sheet.zipedit
        self.content = _workbook_bytes()
        self.part = self.zipedit.sheet_part_by_title(self.content, 'S-1')

    def tearDown(self):
        self.env.__exit__(None, None, None)

    # ---------- 写 0 = 恢复自动 ----------

    def test_写0之后那一行不再有固定高度(self):
        """写 0 ⇒ 那一行的 `<row>` 上**没有** `ht`／`customHeight`。"""
        saved = self.sheet._row_height_surgery(self.content, self.part, {'3': 0})
        tag = _row_tag(saved, self.part, 3)
        self.assertTrue(tag, "第 3 行不见了（写完行没了）：%r" % (tag,))
        self.assertNotIn(b'ht=', tag, "第 3 行还写着固定高度：%r" % (tag,))
        self.assertNotIn(b'customHeight=', tag, "第 3 行还标着自定义高度：%r" % (tag,))

    def test_写0之后读回来没有这一行的行高(self):
        """写 0 ⇒ **重开读回来**没有这一行的行高（那一行回到自动行高）。"""
        saved = self.sheet._row_height_surgery(self.content, self.part, {'3': 0})
        heights = self.sheet._row_heights_from_xml(saved, 'S-1')
        self.assertNotIn('3', heights,
                         "第 3 行的行高还读得回来（⇒ 还是被当成固定高度）：%r" % (heights,))

    def test_先写高度再恢复自动(self):
        """**先手拖高、再恢复自动** ⇒ 固定高度被撤掉、读回来也没有。"""
        dragged = self.sheet._row_height_surgery(self.content, self.part, {'3': 30})
        self.assertIn('3', self.sheet._row_heights_from_xml(dragged, 'S-1'),
                      "手拖的行高没写进去（后面那一步就没东西可撤了）")
        restored = self.sheet._row_height_surgery(dragged, self.part, {'3': 0})
        tag = _row_tag(restored, self.part, 3)
        self.assertNotIn(b'ht=', tag, "恢复自动后还留着固定高度：%r" % (tag,))
        self.assertNotIn('3', self.sheet._row_heights_from_xml(restored, 'S-1'))

    def test_别的行不受影响(self):
        """恢复第 3 行 ⇒ 第 2 行的固定高度**照旧留着**（别连坐）。"""
        dragged = self.sheet._row_height_surgery(self.content, self.part, {'2': 30, '3': 30})
        restored = self.sheet._row_height_surgery(dragged, self.part, {'3': 0})
        heights = self.sheet._row_heights_from_xml(restored, 'S-1')
        self.assertEqual(heights.get('2'), 30.0, "第 2 行的行高被连坐撤掉了：%r" % (heights,))
        self.assertNotIn('3', heights)

    # ---------- 正常的行高照旧 ----------

    def test_正常的行高照旧写得进去读得回来(self):
        """传 30（pt）⇒ `<row>` 上有 `ht`＋`customHeight`，读回来还是 30。"""
        saved = self.sheet._row_height_surgery(self.content, self.part, {'3': 30})
        tag = _row_tag(saved, self.part, 3)
        self.assertIn(b'ht="30"', tag, "行高没写进去：%r" % (tag,))
        self.assertIn(b'customHeight="1"', tag, "没标成自定义高度：%r" % (tag,))
        self.assertEqual(self.sheet._row_heights_from_xml(saved, 'S-1').get('3'), 30.0)

    def test_非法行高照旧被拒(self):
        """负数／超上限的值**照旧当场拒**（别因为放开 0 把闸也拆了）。"""
        for bad in (-1, 500):
            with self.assertRaises(ValueError):
                self.sheet._row_height_surgery(self.content, self.part, {'3': bad})

    # ---------- 动作的入参 schema ----------

    def test_动作的入参schema放行0(self):
        """**动作的输入 schema 放行 0**（不然调用方按 schema 填就被平台当场拒）。"""
        domain = self.env.import_domain('domain')['domain']
        entry = next(item for item in domain.ACTIONS if item[0] == 'files.sheet_row_heights_write')
        heights = entry[3]['properties']['row_heights']
        value = heights.get('additionalProperties') or {}
        self.assertEqual(value.get('minimum'), 0,
                         "行高下限还写着 1 ⇒ 传 0（恢复自动）在进动作前就被拒：%r" % (value,))
        self.assertEqual(value.get('maximum'), 409,
                         "行高上限被改了（原来 409）：%r" % (value,))


if __name__ == '__main__':
    unittest.main()
