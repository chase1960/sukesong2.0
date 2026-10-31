"""WB-02／WB-03：**回填只改值** ＋ **回填失败可沿原路径恢复**（原收敛条目 05 的判据半）。

⚠️ 这两条**把现有能力坐实**（代码早就在这么做，但**没有任何判据**断言它）——
本文件**不改产品代码**，只证明：
- **WB-02** 回填**只改值**：目标格的数字格式／底色**一个字都不变**；
- **WB-03** 回填失败 ⇒ 如实说「**已入库、回填待恢复**」＋ **导出被闸住**
  ⇒ **去掉断点后重写同一格 ⇒ 待恢复清空、导出恢复**（恢复路径坐实）。

**尚未覆盖、下一笔要做**：核心公共动作（`platform.object.update`）写受管记录
**也要回填**（现在不���）—— 见执行计划 `#convergence-task-05-writeback-queue-20261027`。
"""
import base64
import json
import os
import tempfile
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

from shangshu_files.tests import promotion_fixture as fixture


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestWritebackOnlyValueAndRecovery(FrappeTestCase):
    """WB-02／WB-03：回填只改值 ＋ 失败可沿原路径恢复。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.table = None
        self.created = []

    def tearDown(self):
        frappe.set_user("Administrator")
        from shangshu_core import model_records
        for object_id, application_id in self.created:
            try:
                model = frappe.get_doc(model_records.MODEL, object_id)
                frappe.db.commit()
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
            except Exception:
                pass
            try:
                frappe.delete_doc("Shangshu Application Definition", application_id, force=True,
                                  ignore_permissions=True)
            except Exception:
                pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 准备 ----------

    def _upload(self):
        from shangshu_files import service
        result = service.upload({"file_name": "WB-回填-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        return self.table

    def _promote(self):
        from shangshu_files import promotion
        promotion.define({"table": self.table,
                          "definition": fixture.definition(fixture.PROMOTED + fixture.ORDINARY)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table)) or {}
        if binding.get("object_id"):
            self.created.append((binding.get("object_id"), binding.get("application_id")))
        return binding

    def _with_fault(self, point):
        """装一个断点（写进 `SS_FAULT_FILE`），返回可关闭的句柄。"""
        handle, path = tempfile.mkstemp(prefix="wb-fault-")
        os.close(handle)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(point)
        previous = os.environ.get("SS_FAULT_FILE")
        os.environ["SS_FAULT_FILE"] = path

        def restore():
            if previous is None:
                os.environ.pop("SS_FAULT_FILE", None)
            else:
                os.environ["SS_FAULT_FILE"] = previous
            os.unlink(path)
        return restore

    def _cell_format(self, row, column):
        """读那一格现在的**数字格式**（夹具给 A2 设了 `#,##0.00`、C2 设了底色）。"""
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        # ⚠️ **只读取内容**（`for_write=False`）—— 取写锁会跟后面那次写入自锁
        #   （同一行 for_update 等自己 ⇒ Lock wait timeout）。
        content = sheet._content(doc)
        from shangshu_files import workbook as _wb
        draft = _wb.decode(content)
        for sheet_row in draft.get("sheets") or []:
            if sheet_row.get("title") != "S-1":
                continue
            values = (sheet_row.get("cells") or [])
            if len(values) < row:
                return None
            return values[row - 1][column - 1]
        return None

    def _cell_fill(self, row, column):
        """读那一格的底色（openpyxl 层面）。"""
        from shangshu_files import sheet, workbook as _wb
        from openpyxl import load_workbook
        from io import BytesIO
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        content = sheet._content(doc)
        book = load_workbook(BytesIO(content))
        ws = book["S-1"]
        cell = ws.cell(row=row, column=column)
        return {"number_format": cell.number_format,
                "fill": (cell.fill.fgColor.rgb if cell.fill and cell.fill.fgColor else None)}

    # ---------- WB-02 ----------

    def test_回填只改值不动格式(self):
        """**回填只改值**：正式值写进受管记录后回填那一格 ⇒
        **那一格的值变了**，**数字格式与底色一个字都不变**。

        ⚠️ 夹具给 A2（金额列第一行）设了数字格式 `#,##0.00`、C2（名称列第一行）设了底色
        ⇒ 正好用来证明「回填不许碰格式」。
        """
        from shangshu_files import promotion
        self._upload()
        binding = self._promote()
        row_id = sorted(binding["records"])[0]
        before = self._cell_fill(2, 1)
        self.assertEqual(before.get("number_format"), "#,##0.00",
                         "夹具没给那一格设数字格式（这条判据的前提没了）")
        promotion.cell_write({"table": self.table, "row_id": row_id, "header": "金额",
                              "value": {"type": "number", "value": 4242.5}})
        frappe.db.commit()
        after = self._cell_fill(2, 1)
        self.assertEqual(after.get("number_format"), before.get("number_format"),
                         "回填把那一格的数字格式改了（只许改值）")
        self.assertEqual(after.get("fill"), before.get("fill"),
                         "回填把那一格的底色改了（只许改值）")
        # 值**确实**变了（否则上面两条就是假通过）。
        rows = __import__("shangshu_core.model_records", fromlist=["x"]).query_records(
            binding["object_id"], filters={}, page=1, page_length=30)
        by_name = {row["name"]: row for row in rows["rows"]}
        self.assertEqual(by_name[binding["records"][row_id]]["amount"], 4242.5,
                         "正式值没写进受管记录（回填判据的前提没了）")

    # ---------- WB-03 ----------

    def test_回填失败可沿原路径恢复(self):
        """回填失败 ⇒ 如实说「已入库、回填待恢复」＋ **导出被闸住**
        ⇒ **去掉断点后重写同一格 ⇒ 待恢复清空、导出恢复**。

        ⚠️ 恢复路**只有一条**：重跑同一个写路径（用户「重试保存」）。
        ⇒ 本条把它**坐实**（原来只断言「标了 pending」，没断言「能恢复」）。
        """
        from shangshu_files import promotion
        self._upload()
        binding = self._promote()
        row_id = sorted(binding["records"])[0]
        # ① 注入回填失败（写文件那步）。
        restore = self._with_fault("file-write")
        try:
            result = promotion.cell_write({"table": self.table, "row_id": row_id, "header": "金额",
                                           "value": {"type": "number", "value": 606.5}})
        finally:
            restore()
        frappe.db.commit()
        self.assertTrue(result["formal_written"], "值没入库")
        self.assertFalse(result["sheet_written"], "回填失败却说有回填（不老实）")
        self.assertTrue(result["pending"], "没标待恢复")
        self.assertIn("待恢复", result.get("message") or "", "回执没说「待恢复」（用户看不懂）")
        # ② 导出被闸住（不许拿旧文件冒充最新）。
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.require_no_pending_writeback(
                frappe.get_doc(promotion.FILE, self.table))
        self.assertIn("待恢复", str(caught.exception), "导出闸没说要「待恢复」")
        # ③ **去掉断点后重写同一格** ⇒ 待恢复清空、导出恢复。
        again = promotion.cell_write({"table": self.table, "row_id": row_id, "header": "金额",
                                       "value": {"type": "number", "value": 606.5}})
        frappe.db.commit()
        self.assertTrue(again["sheet_written"], "重试保存后回填仍没成功")
        self.assertFalse(again["pending"], "重试保存后「待恢复」没清掉")
        promotion.require_no_pending_writeback(
            frappe.get_doc(promotion.FILE, self.table))  # 不抛 ⇒ 导出恢复


if __name__ == "__main__":
    unittest.main()
