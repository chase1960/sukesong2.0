"""伴随投影写日期：那一格必须**带日期格式**，否则存盘重载后变成光秃秃的序号数。

测试通过 = 什么成立（空白伴随工作簿，表头「金额／日期」）：
- 投影把**日期值**写进去后，那一格带的是**日期格式**（yyyy-mm-dd）；
- 存盘再打开，那一格**还是日期**（不是 46298 这种序号数）；
- 旁边的数值格**不动格式**（照旧「常规」）。

为什么要有这条（2026-10-28 隔离站实测撞出来的真缺陷）：
改之前投影**照抄原格格式**（空白伴随表里原格是「常规」）⇒ 日期被存成序号数
⇒ ① 人看到的不是日期；② 保存校验闸当场判「未改内容被改动（…!B2），本次未生效」
⇒ **整次绑定作废** ⇒ 凡是带日期列的伴随表，**第一次接入必然失败**（不是偶发）。
口径与普通单格写一致（`shangshu_files.sheet._apply_value` 的 date 档）。
"""
import datetime
import unittest
from io import BytesIO

from openpyxl import Workbook, load_workbook

from shangshu_files.object_projection import apply_snapshot


class CompanionProjectionDateFormatTests(unittest.TestCase):
    def _project(self, value):
        wb = Workbook()
        ws = wb.active
        ws.title = 'S-1'
        ws.cell(1, 1).value = '金额'
        ws.cell(1, 2).value = '日期'
        meta = {'rows': []}
        binding = {
            'object_id': 'object-a',
            'field_columns': [
                {'field_id': 'amount', 'header': '金额', 'type': 'number'},
                {'field_id': 'day', 'header': '日期', 'type': 'date'},
            ],
            'definition_revision': 1,
        }
        records = [{'name': 'r-000001', 'values': {'amount': 22.5, 'day': value}}]
        changed = apply_snapshot(ws, meta, binding, records, initial=True)
        return wb, ws, changed

    def test_date_cell_carries_a_date_format(self):
        wb, ws, changed = self._project(datetime.date(2026, 10, 3))
        self.assertEqual(ws.cell(2, 2).number_format, 'yyyy-mm-dd',
            '日期格没有带日期格式 ⇒ 存盘后它会变成序号数（46298），人也看不到日期')
        self.assertEqual(len(changed), 2, '两列都该记成变化（金额与日期）')

    def test_date_stays_a_date_after_save_and_reload(self):
        wb, ws, _ = self._project(datetime.date(2026, 10, 3))
        out = BytesIO()
        wb.save(out)
        again = load_workbook(BytesIO(out.getvalue()))
        cell = again['S-1'].cell(2, 2)
        self.assertIsInstance(cell.value, (datetime.datetime, datetime.date),
            '存盘重载后日期格变成了 ' + repr(cell.value) + ' ⇒ 人看到的是序号数不是日期')
        got = cell.value.date() if isinstance(cell.value, datetime.datetime) else cell.value
        self.assertEqual(got, datetime.date(2026, 10, 3), '存盘重载后日期不是原来那天')

    def test_number_cell_keeps_its_own_format(self):
        wb, ws, _ = self._project(datetime.date(2026, 10, 3))
        self.assertEqual(ws.cell(2, 1).number_format, 'General',
            '数值格的格式被日期那一格带偏了 ⇒ 只该改日期格')

    def test_the_products_own_save_gate_accepts_the_written_file(self):
        """走**产品自己的存盘闸**（`sheet._save_with_gates` 里那道 `_verify_saved`）。

        ⚠️ 前一条只验了 openpyxl 往返；**这一条验的是产品真会走的那道闸**：
        存盘前的内存簿 与 存盘后重开的簿 要**逐格同型**。
        改之前日期格落盘变序号数 ⇒ 这道闸当场判「未改内容被改动」⇒ **整次绑定作废**。
        """
        from shangshu_files import sheet
        wb, ws, _ = self._project(datetime.date(2026, 10, 3))
        before = sheet._snapshot(wb)          # 存盘前：产品就是这么取的
        out = BytesIO()
        wb.save(out)
        saved = out.getvalue()
        # 产品那道闸：重开存盘簿，逐格比类型。日期没带格式 ⇒ 这里抛「未改内容被改动」。
        sheet._verify_saved(saved, 'S-1', None, before)
