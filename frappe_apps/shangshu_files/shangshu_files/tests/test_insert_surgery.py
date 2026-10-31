"""Insert through the public action: ZIP-only, stable identity and one/ten-row movement.
Formula-bearing workbooks require explicit migration; original bytes remain intact.
Merges below the insertion move as a whole. No force-slow comparison survives.
"""
import base64
import io
import unittest
import uuid
from unittest import mock

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

#: 数据行数（千行级：老路要整本往返，手术路只挪坐标 —— 差就在这里显出来）。
ROWS = 1000
#: 列数。
COLS = 6
#: 插在第几行之前（0 基数据行号）：**插在中间**，不是末尾。
INSERT_AT = 500


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestInsertSurgery(FrappeTestCase):
    """RI-01～RI-05：唯一增量路径、稳定身份和明确拒绝。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.tables = []

    def tearDown(self):
        frappe.set_user("Administrator")
        for name in self.tables:
            try:
                frappe.delete_doc("Shangshu File Center File", name, force=True,
                                  ignore_permissions=True)
            except Exception:
                pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 准备 ----------

    def _upload(self, with_formula=False, with_merge=False):
        """造一张千行表（ROWS 行 × COLS 列），可选带公式/合并单元格。"""
        from openpyxl import Workbook
        from shangshu_files import service
        book = Workbook()
        # Each isolated fixture owns its physical attachment. Identical bytes
        # otherwise share Frappe's hash-deduplicated file across test teardown.
        book.properties.identifier = uuid.uuid4().hex
        sheet = book.active
        sheet.title = "S-1"
        sheet.append(["列%d" % index for index in range(COLS)])
        for row in range(1, ROWS + 1):
            sheet.append(["值%d-%d" % (row, col) for col in range(COLS)])
        if with_formula:
            # 原件含公式时明确要求迁移；日常插行不能退回另一套保存实现。
            sheet["B2"] = "=A2"
        if with_merge:
            # **合并区在插入点之下**（数据行 700 ＝ 物理第 702 行）⇒ 插完它必须跟着挪。
            sheet.merge_cells(start_row=702, start_column=1, end_row=702, end_column=2)
        out = io.BytesIO()
        book.save(out)
        result = service.upload({"file_name": "RI-插行-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(out.getvalue()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.tables.append(result["file"])
        return result["file"]

    def _row_ids(self, table):
        """这张表的固定行身份（按位置）。"""
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", table)
        return list(sheet._load_meta(doc).get("rows") or [])

    def _insert(self, table, before_row_id, count=1):
        """Run the actual registered action; trap the retired full-workbook opener."""
        from shangshu_core.public_api import execute_registered_action
        from shangshu_core.public_api import domain_execution
        from shangshu_files import sheet as S, zipedit
        probe = S.read_payload("files.sheet_read", {"table": table}, None)
        payload = {"table": table, "op_id": "ri-insert-%s" % uuid.uuid4().hex[:8], "count": count,
                   "before_row_id": before_row_id,
                   "expected_content_version": int(probe.get("content_version") or 0),
                   "expected_structure_version": int(probe.get("structure_version") or 1)}
        with mock.patch.object(S, "safe_open", side_effect=AssertionError("daily insert opened whole workbook")):
            with domain_execution("com.shangshu.files"):
                result = execute_registered_action("files.sheet_row_insert", payload, confirmed=True,
                                                   idempotency_key=payload["op_id"], source="user")
        frappe.db.commit()
        return result

    def _file_rows(self, table, count):
        """**文件字节**里前 `count` 个数据行的值（第 1 行是表头，从第 2 行起）。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", table)
        book = load_workbook(io.BytesIO(sheet._content(doc)))
        ws = book[book.sheetnames[0]]
        return [tuple(ws.cell(row=2 + index, column=1 + col).value for col in range(COLS))
                for index in range(count)]

    def _merged_ranges(self, table):
        """**文件字节**里的合并区（文字坐标，如 'A703:B703'）。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", table)
        book = load_workbook(io.BytesIO(sheet._content(doc)))
        ws = book[book.sheetnames[0]]
        return sorted(str(item) for item in ws.merged_cells.ranges)

    def _body(self, result):
        """动作回执里的**业务结果**（公共入口外面还套了一层：action_id/audit/…）。"""
        body = (result or {}).get("result")
        return body if isinstance(body, dict) else (result or {})

    def _path(self, result):
        """回执确认实际执行的增量路径。"""
        return str(((self._body(result).get("timing") or {}).get("fast_path") or ""))

    # ---------- RI-01 ----------

    def test_大表插行走手术快路(self):
        """千行大表插行 ⇒ **走手术**（回执里 fast_path ＝ surgery），不是老路。"""
        table = self._upload()
        result = self._insert(table, self._row_ids(table)[INSERT_AT])
        self.assertEqual(self._path(result), "surgery",
                         "大表插行**没走手术快路**（落回老路 ⇒ 大表又要十几秒）")

    # ---------- RI-02 ----------

    def test_插完之后行没串位(self):
        """插入点**之前**的内容不变；插入点是**新空行**；**之后**的行整体下移一位、内容不变。"""
        table = self._upload()
        before = self._file_rows(table, ROWS)
        self._insert(table, self._row_ids(table)[INSERT_AT])
        after = self._file_rows(table, ROWS + 1)
        self.assertEqual(len(after), ROWS + 1, "插完行数没多一个")
        for index in range(INSERT_AT):
            self.assertEqual(after[index], before[index],
                             "插入点**之前**的第 %d 行内容被改动了" % (index + 1))
        self.assertEqual(after[INSERT_AT][0], " ",
                         "新行不是空行（没钉住）")
        self.assertTrue(all(value is None for value in after[INSERT_AT][1:]),
                        "新行不空（除了第一格还有别的内容）")
        for index in range(INSERT_AT, ROWS):
            self.assertEqual(after[index + 1], before[index],
                             "插入点**之后**的第 %d 行内容变了（串位）" % (index + 1))

    # ---------- RI-03 ----------

    def test_一次插十行仍保留旧行身份和值(self):
        table = self._upload()
        ids = self._row_ids(table)
        before = self._file_rows(table, ROWS)
        result = self._insert(table, ids[INSERT_AT], count=10)
        new_ids = self._body(result)["row_ids"]
        self.assertEqual(len(new_ids), 10)
        self.assertEqual(self._row_ids(table), ids[:INSERT_AT] + new_ids + ids[INSERT_AT:])
        after = self._file_rows(table, ROWS + 10)
        self.assertEqual(after[:INSERT_AT], before[:INSERT_AT])
        self.assertEqual(after[INSERT_AT + 10:], before[INSERT_AT:])

    # ---------- RI-04 ----------

    def test_公式原件零写并提示显式迁移(self):
        from shangshu_files import sheet
        table = self._upload(with_formula=True)
        doc = frappe.get_doc("Shangshu File Center File", table)
        original = sheet._content(doc)
        ids = self._row_ids(table)
        with self.assertRaisesRegex(Exception, "显式迁移"):
            self._insert(table, ids[INSERT_AT])
        frappe.db.rollback()
        self.assertEqual(sheet._content(frappe.get_doc("Shangshu File Center File", table)), original)
        self.assertEqual(self._row_ids(table), ids)

    # ---------- RI-05 ----------

    def test_整块合并区跟随插行(self):
        """An intact merge below insertion follows its original content."""
        table = self._upload(with_merge=True)
        result = self._insert(table, self._row_ids(table)[INSERT_AT])
        self.assertEqual(self._path(result), "surgery")
        self.assertEqual(self._merged_ranges(table), ["A703:B703"],
                         "合并区没跟着行一起挪（插行后合并区指错了行）")


if __name__ == "__main__":
    unittest.main()
