"""PB-01～PB-05：**粘贴边界**（后端侧）——只复制值，不复制身份/权限/绑定/行 ID/格式。

**口径**（原收敛条目 04 的「粘贴边界」）：
- 粘贴**只复制值**：不复制字段身份、权限、绑定、源行 ID 或格式；
- 保留**前导零、长编号、空、false、0、中文及格内换行**；
- 多格**不变成逐格独立事务/落盘**（一次动作包、一次落盘）。

**为什么要有后端这几条**：这条边界**前端侧已有判据**
（`shangshu-server/tests/website/excel-grid-context-menu.test.ts` 等，含 3×4／200×20／
20,000 格样本与前导零/长编号/换行）⇒ 但**服务端**（`files.sheet_paste_apply`）
**没有对应断言** ⇒ 「后端也守住」这件事只能靠读代码自证。

**测试通过 = 下面每一条都成立**：
- **PB-01** 粘进去的**值逐字一致**（前导零/长编号/空/false/0/中文/格内换行都不变形）；
- **PB-02** **不复制字段身份／权限／绑定**：目标列的 access 声明、对象绑定、列→字段映射
  一个字没变；
- **PB-03** **不复制源行 ID**：目标行的固定行身份没变；
- **PB-04** **不复制格式**：目标格的数字格式／底色不变；
- **PB-05** 受管列的值进**受管记录**（权威）且文件与之一致；普通列的值**只在文件里**
  （不进受管记录）。
"""
import base64
import io
import json
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

#: 目标表的 8 个列（1 个受管列 ＋ 7 个普通列）。
HEADERS = ["金额", "编号", "长编号", "空列", "确认", "数量", "备注", "中文"]
#: 粘进去的那一行：把「值形状」的每一种都放进去。
VALUES = [606.5, "00123", "1234567890123456789", "", False, 0, "第一行\n第二行", "中文值"]
TYPES = ["number", "text", "text", "empty", "boolean", "number", "text", "text"]
#: 金额那一格（第 1 列）是被晋升的受管列；其余都是普通列。
PROMOTED_FIELD = "amount"
PROMOTED_HEADER = "金额"


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestPasteBoundary(FrappeTestCase):
    """PB-01～PB-05：粘贴只复制值。"""

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

    def _prepare(self):
        """造一张 8 列、2 行的表（金额是受管列），给「数量」那格设一个特殊格式。"""
        from openpyxl import Workbook
        from shangshu_files import promotion, service
        book = Workbook()
        sheet = book.active
        sheet.title = "P-1"
        sheet.append(HEADERS)
        sheet.append([10.5, "原编号", "123", "", True, 7, "原备注", "原中文"])
        sheet.append([20.5, "原编号2", "456", "", False, 8, "原备注2", "原中文2"])
        sheet["F2"].number_format = "#,##0.00"
        out = io.BytesIO()
        book.save(out)
        result = service.upload({"file_name": "PB-粘贴边界-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(out.getvalue()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        access = {"read": {"scope": "global"}, "write": {"scope": "global"},
                  "download": {"scope": "global"}}
        definition = {"access": dict(access, record_scope="all"),
                      "columns": [{"header": PROMOTED_HEADER, "promoted": True,
                                   "field": PROMOTED_FIELD, "type": "number",
                                   "access": dict(access)}]}
        promotion.define({"table": self.table, "definition": definition})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table)) or {}
        self.object_id = binding.get("object_id")
        self.binding = binding
        self.created.append((self.object_id, binding.get("application_id")))
        return binding

    def _paste(self):
        """服务端粘贴那一行（走已登记的公共动作）。"""
        from shangshu_core.public_api import execute_registered_action
        from shangshu_core.public_api import domain_execution
        from shangshu_files import sheet
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        payload = {"table": self.table, "op_id": "pb-paste-%s" % uuid.uuid4().hex[:8],
                   "start_row": 0, "start_col": 0,
                   "matrix": [list(VALUES)], "matrix_types": [list(TYPES)],
                   "expected_content_version": int(probe.get("content_version") or 0),
                   "expected_structure_version": int(probe.get("structure_version") or 1)}
        with domain_execution("com.shangshu.files"):
            execute_registered_action("files.sheet_paste_apply", payload, confirmed=True,
                                      idempotency_key=payload["op_id"], source="user")
        frappe.db.commit()

    def _file_values(self, row=0):
        """**文件字节**里那一行的值（逐字）。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        book = load_workbook(io.BytesIO(sheet._content(doc)))
        ws = book["P-1"]
        return [ws.cell(row=row + 2, column=index + 1).value for index in range(len(HEADERS))]

    def _file_format(self, row=0, column=6):
        """目标那一格现在的数字格式。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        book = load_workbook(io.BytesIO(sheet._content(doc)))
        return book["P-1"].cell(row=row + 2, column=column).number_format

    def _managed_value(self):
        from shangshu_core import model_records
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=30)
        by_name = {row["name"]: row for row in rows["rows"]}
        first = sorted(self.binding["records"])[0]
        return by_name.get(self.binding["records"][first], {}).get(PROMOTED_FIELD)

    # ---------- PB-01 ----------

    def test_粘贴的值逐字不变(self):
        """前导零、长编号、空、false、0、中文、格内换行**都不变形**。"""
        self._prepare()
        self._paste()
        values = self._file_values()
        self.assertEqual(values[0], 606.5, "金额那一格的值不对")
        self.assertEqual(values[1], "00123", "**前导零丢了**（看着像数字被改了类型）")
        self.assertEqual(values[2], "1234567890123456789", "长编号变了")
        self.assertIsNone(values[3], "空值没保持空")
        self.assertIs(values[4], False, "false 变成了别的")
        self.assertEqual(values[5], 0, "0 变成了别的")
        self.assertEqual(values[6], "第一行\n第二行", "格内换行丢了")
        self.assertEqual(values[7], "中文值", "中文值不对")

    # ---------- PB-02 ----------

    def test_粘贴不复制字段身份权限与绑定(self):
        """列的 access 声明、对象绑定、列→字段映射**一个字没变**。"""
        from shangshu_files import promotion
        self._prepare()
        before_definition = promotion.load_definition(self._doc())
        before_binding = dict(self.binding)
        self._paste()
        after_definition = promotion.load_definition(self._doc())
        after_binding = promotion._managed_binding(self._doc()) or {}
        self.assertEqual(after_definition.get("access"), before_definition.get("access"),
                         "粘贴把表级的权限声明改了")
        self.assertEqual([c.get("access") for c in after_definition.get("columns") or []],
                         [c.get("access") for c in before_definition.get("columns") or []],
                         "粘贴把列的权限声明改了")
        self.assertEqual(after_binding.get("object_id"), before_binding.get("object_id"),
                         "粘贴把受管对象绑定改了")
        self.assertEqual(after_binding.get("records"), before_binding.get("records"),
                         "粘贴把行→记录的映射改了")

    # ---------- PB-03 ----------

    def test_粘贴不复制源行身份(self):
        """目标行的固定行身份没变（粘贴不带行 ID）。"""
        from shangshu_files import promotion
        self._prepare()
        before_rows = list(promotion._load_meta(self._doc()).get("rows") or [])
        self._paste()
        after_rows = list(promotion._load_meta(self._doc()).get("rows") or [])
        self.assertEqual(after_rows, before_rows, "粘贴把固定行身份改了")

    # ---------- PB-04 ----------

    def test_粘贴不复制格式(self):
        """目标格的数字格式**不变**（粘贴只带值）。"""
        self._prepare()
        before = self._file_format(row=0, column=6)
        self.assertEqual(before, "#,##0.00", "夹具没给那一格设格式（判据前提没了）")
        self._paste()
        self.assertEqual(self._file_format(row=0, column=6), before,
                         "粘贴把目标格的数字格式改了（只许改值）")

    # ---------- PB-05 ----------

    def test_受管列进受管记录普通列只进文件(self):
        """受管列的值进**受管记录**（权威）且与文件一致；普通列**不进受管记录**。"""
        from shangshu_core import model_records
        self._prepare()
        self._paste()
        self.assertEqual(self._managed_value(), 606.5, "受管列的值没进受管记录")
        self.assertEqual(self._file_values()[0], 606.5, "受管列的文件投影与权威不一致")
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=30)
        first = sorted(self.binding["records"])[0]
        record = {row["name"]: row for row in rows["rows"]}.get(self.binding["records"][first], {})
        self.assertNotIn("编号", record, "普通列的值混进了受管记录")
        self.assertEqual(record.get("amount"), 606.5, "受管记录里的值不对")

    def _doc(self):
        from shangshu_files import promotion
        return frappe.get_doc(promotion.FILE, self.table)


if __name__ == "__main__":
    unittest.main()
