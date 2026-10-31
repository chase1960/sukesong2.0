"""TX-01～TX-04：**人／Assistant／自动化三条路各改各的权威源、给一致结果**（原收敛条目 04）。

**口径**：受管表（Excel 晋升上来的表）里，**普通列与受管列的权威源不同** ——
普通列的权威是**文件里那一格**；受管列的权威是**受管记录**（文件里那一格是投影）。
⇒ **谁写哪一列，就只改那一份**；**改完两处要一致**。

**测试通过 = 下面每一条都成立**：
- **TX-01** 人改**普通列** ⇒ **只改文件**；**受管记录一个字没变**；
- **TX-02** 人改**受管列** ⇒ **受管记录变** ＋ **文件那一格跟着变**（两处一致）；
- **TX-03** Assistant／自动化改**受管列**（走核心公共动作）⇒ **受管记录变** ＋
  **文件那一格跟着变**；**普通列一个字没变**；
- **TX-04** 三条路**改同一格** ⇒ 读回来的值**一致**（谁写都对）。

⚠️ **判据要读两处**：受管记录（`query_records`）**与**文件字节（不是回包 ——
回包会把正式值盖上去，看不出投影有没有跟上）。
"""
import base64
import io
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

COL_AMOUNT = 1          # 受管列「金额」
COL_NAME = 3            # 普通列「名称」
FIRST_DATA_ROW = 2


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestWritePathsConsistency(FrappeTestCase):
    """TX-01～TX-04：三条路各改各的权威源、结果一致。"""

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
        from shangshu_files import promotion, service
        result = service.upload({"file_name": "TX-写入路径-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        promotion.define({"table": self.table,
                          "definition": fixture.definition(fixture.PROMOTED + fixture.ORDINARY)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table)) or {}
        self.object_id = binding.get("object_id")
        self.binding = binding
        self.created.append((self.object_id, binding.get("application_id")))
        self.row_id = sorted(binding["records"])[0]
        return binding

    def _file_cell(self, row, column):
        """**文件字节**里那一格的值（不是回包）。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        book = load_workbook(io.BytesIO(sheet._content(doc)))
        return book["S-1"].cell(row=row, column=column).value

    def _managed_value(self, field="amount"):
        """受管记录里那个字段的值（**权威**）。"""
        from shangshu_core import model_records
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=30)
        by_name = {row["name"]: row for row in rows["rows"]}
        return by_name.get(self.binding["records"][self.row_id], {}).get(field)

    def _human_write(self, header, column, value):
        """**人**走 Excel 那一路（整包写：一次落盘）。"""
        from shangshu_files import sheet
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        sheet.write_cells({"table": self.table,
                           "op_id": "tx-human-%s" % uuid.uuid4().hex[:8],
                           "cells": [{"row_id": self.row_id, "header": header, "value": value}],
                           "expected_content_version": int(probe.get("content_version") or 0),
                           "expected_structure_version": int(probe.get("structure_version") or 1)})
        frappe.db.commit()

    def _machine_write(self, field, value):
        """**Assistant／自动化**走核心公共动作（受管记录那一侧）。"""
        from shangshu_core.public_api import execute_registered_action
        from shangshu_core.public_api import domain_execution
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        record = self.binding["records"][self.row_id]
        with domain_execution("com.shangshu.core"):
            execute_registered_action(
                "platform.object.update",
                {"object_id": self.object_id, "name": record,
                 "expected_revision": model.active_revision,
                 "expected_modified": str(frappe.db.get_value(model.physical_doctype, record, "modified") or ""),
                 "values": {field: value}},
                confirmed=True, idempotency_key="tx-machine-%s" % uuid.uuid4().hex[:8],
                source="user")
        frappe.db.commit()

    # ---------- TX-01 ----------

    def test_人改普通列只改文件不动受管记录(self):
        """人改**普通列** ⇒ **只改文件**；**受管记录一个字没变**。"""
        self._prepare()
        before_managed = self._managed_value()
        before_file = self._file_cell(FIRST_DATA_ROW, COL_NAME)
        self._human_write("名称", COL_NAME, {"type": "text", "value": "人改的名字"})
        self.assertEqual(self._file_cell(FIRST_DATA_ROW, COL_NAME), "人改的名字",
                         "普通列没改到文件里")
        self.assertEqual(self._managed_value(), before_managed,
                         "改普通列**动了受管记录**（普通列的权威是文件，不是数据库）")

    # ---------- TX-02 ----------

    def test_人改受管列两处一致(self):
        """人改**受管列** ⇒ **受管记录变** ＋ **文件那一格跟着变**（两处一致）。"""
        self._prepare()
        self._human_write("金额", COL_AMOUNT, {"type": "number", "value": 606.5})
        self.assertEqual(self._managed_value(), 606.5, "受管记录没变（它是受管列的权威）")
        self.assertEqual(self._file_cell(FIRST_DATA_ROW, COL_AMOUNT), 606.5,
                         "文件那一格没跟着变（投影与权威分叉了）")

    # ---------- TX-03 ----------

    def test_助手改受管列两处一致且普通列不动(self):
        """Assistant／自动化改**受管列** ⇒ 受管记录变 ＋ 文件跟着变；**普通列一个字没变**。"""
        self._prepare()
        before_name = self._file_cell(FIRST_DATA_ROW, COL_NAME)
        self._machine_write("amount", 707.5)
        self.assertEqual(self._managed_value(), 707.5, "受管记录没变")
        self.assertEqual(self._file_cell(FIRST_DATA_ROW, COL_AMOUNT), 707.5,
                         "文件那一格没跟着变（投影与权威分叉了）")
        self.assertEqual(self._file_cell(FIRST_DATA_ROW, COL_NAME), before_name,
                         "改受管列**顺手改了普通列**")

    # ---------- TX-04 ----------

    def test_三条路改同一格结果一致(self):
        """人／Assistant／自动化**改同一格** ⇒ 读回来的值**一致**（谁写都对）。"""
        self._prepare()
        self._human_write("金额", COL_AMOUNT, {"type": "number", "value": 111.5})
        human_managed = self._managed_value()
        human_file = self._file_cell(FIRST_DATA_ROW, COL_AMOUNT)
        self.assertEqual(human_managed, 111.5, "人改完受管记录不对")
        self.assertEqual(human_file, human_managed, "人改完两处不一致")

        self._machine_write("amount", 222.5)
        machine_managed = self._managed_value()
        machine_file = self._file_cell(FIRST_DATA_ROW, COL_AMOUNT)
        self.assertEqual(machine_managed, 222.5, "助手改完受管记录不对")
        self.assertEqual(machine_file, machine_managed, "助手改完两处不一致")


if __name__ == "__main__":
    unittest.main()
