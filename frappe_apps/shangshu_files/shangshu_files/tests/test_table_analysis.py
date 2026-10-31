"""表格分析（普通 XLSX／数据库绑定表）：与受管记录**同一套**统计口径。

PKG-018-T06 第一阶段。**测试通过 = 什么成立**（一句话）：

「对一张表调 `files.table_aggregate`，能拿到**与受管记录同样形状**的统计
（行数／去重／求和／分组），**受管列的值取数据库正式值**（工作簿里的旧值不算数）、
**普通列取工作簿值**，回包**逐列标明来源**与**数据版本**；
**合计行默认剔除并报出**、**错误值当空值**、**没算出来的公式当空值**；
**表头不成立（标题行当表头／合并表头）当场拒绝**并说清怎么改；
**点名别的��作表也拒绝**；**无权的表读不到**；
**与 `platform.object.aggregate` 对同一批数据给出同一个数**（同一套语义，不是两套）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_files.tests.test_table_analysis --skip-test-records
"""
import base64
import os
import tempfile
import unittest
import uuid
from io import BytesIO

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook

from shangshu_core import model_records
from shangshu_files import promotion, service, sheet, table_analysis
from shangshu_files.tests import promotion_fixture as fixture

HEADERS = ["金额", "负责人", "日期"]
ROWS = [
    [10.5, "甲", "2026-10-01"],
    [20.25, "乙", "2026-10-02"],
    [0.25, "甲", "2026-10-03"],
    [5.0, "丙", "2026-10-04"],
]


def workbook_bytes(headers=None, rows=None, extra_sheets=(), total_row=None,
                    error_cell=False, formula_cell=False):
    """一张小表（**夹具**：不拿真实表当夹具）。"""
    book = Workbook()
    ws = book.active
    ws.title = "S-1"
    ws.append(list(headers or HEADERS))
    for row in (rows if rows is not None else ROWS):
        ws.append(list(row))
    if total_row is not None:
        ws.append(list(total_row))
    if error_cell:
        ws.cell(row=2, column=3).value = "#DIV/0!"
    if formula_cell:
        ws.cell(row=2, column=2).value = "=1+1"
    for title in extra_sheets:
        other = book.create_sheet(title)
        other.append(["别的表头"])
        other.append(["别的数据"])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def _upload(name, content):
    result = service.upload({"file_name": name, "content_base64": base64.b64encode(content).decode(),
                             "attribution": {"level": "personal"}})
    frappe.db.commit()
    return result["file"]


class TestTableAnalysis(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.tables = []
        self.created = []

    def tearDown(self):
        frappe.set_user("Administrator")
        for table in self.tables:
            try:
                frappe.db.set_value("Shangshu File Center File", table, "status", "Active",
                                    update_modified=False)
                service.recycle({"file": table})
            except Exception:
                pass
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

    def _upload(self, **kwargs):
        name = "T06-分析表-%s.xlsx" % uuid.uuid4().hex[:6]
        table = _upload(name, workbook_bytes(**kwargs))
        self.tables.append(table)
        return table

    def _promote(self, table, columns):
        promotion.define({"table": table, "definition": fixture.definition(columns)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, table))
        if binding and binding.get("object_id") and not binding.get("__seen"):
            self.created.append((binding["object_id"], binding.get("application_id")))
            binding["__seen"] = True
        return binding

    # ---------- ① 普通 XLSX：与手算一致，且每列说清来源与版本 ----------
    def test_plain_xlsx_aggregate_matches_hand_calculation_and_tells_sources(self):
        table = self._upload()
        result = table_analysis.aggregate({
            "table": table,
            "metrics": [{"op": "count_rows"}, {"op": "sum", "field": "金额"},
                        {"op": "count_distinct", "field": "负责人"}],
            "group_by": "负责人",
        })
        self.assertEqual(result["metrics"]["count_rows"], 4, "行数按全部数据行算")
        self.assertEqual(str(result["metrics"]["sum_金额"]), "36.00",
                         "求和按十进制：10.5+20.25+0.25+5.0 = 36.00")
        self.assertEqual(result["metrics"]["count_distinct_负责人"], 3, "去重计数（甲/乙/丙）")
        groups = {item["group"]: item["metrics"]["count_rows"] for item in result["groups"]}
        self.assertEqual(groups, {"甲": 2, "乙": 1, "丙": 1}, "分组按负责人")
        # **每列说清来源**：普通表没有受管绑定 ⇒ 值来自工作簿，不是数据库正式值
        columns = {item["column"]: item for item in result["columns"]}
        self.assertEqual(columns["金额"]["origin"], "workbook", "普通列的值来自工作簿")
        self.assertFalse(columns["金额"]["authoritative"], "工作簿的值不是数据库正式值")
        self.assertEqual(columns["金额"]["kind"], "number")
        self.assertFalse(result["bound"], "这张表没有受管绑定")
        # **数据版本**：哪个文件、哪个版本、什么时候读的
        self.assertEqual(result["source"]["file"]["table"], table)
        self.assertGreaterEqual(int(result["source"]["file"]["content_revision"]), 1)
        self.assertTrue(result["source"]["file"]["read_at"], "要说清什么时候读的")
        self.assertIsNone(result["source"]["database"], "没绑定 ⇒ 没有数据库来源")
        # 回执与受管记录同一套结构
        self.assertEqual(result["receipt"]["counts"]["matched_total"], 4)
        self.assertEqual(result["receipt"]["criteria"]["group_by"], "负责人")

    # ---------- ② 合计行：默认剔除并报出；可显式保留 ----------
    def test_total_row_is_excluded_by_default_and_reported(self):
        table = self._upload(total_row=["合计", None, None])
        result = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertEqual(result["metrics"]["count_rows"], 4, "合计行不算数据行")
        self.assertEqual(len(result["rows"]["excluded_total_rows"]), 1, "报出剔了哪一行")
        codes = [item.get("code") for item in result["receipt"]["exceptions"]]
        self.assertIn("total_rows_excluded", codes, "回执要说清剔了合计行")
        kept = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}],
                                          "include_total_rows": True})
        self.assertEqual(kept["metrics"]["count_rows"], 5, "要保留时能保留")

    # ---------- ③ 错误值：当空值（不是 0），并上报 ----------
    def test_error_value_counts_as_empty_and_is_reported(self):
        table = self._upload(error_cell=True)
        result = table_analysis.aggregate({
            "table": table,
            "metrics": [{"op": "count_rows"}, {"op": "count_distinct", "field": "日期"}],
        })
        self.assertEqual(result["metrics"]["count_rows"], 4, "错误值所在的那一行**仍然是一行**")
        self.assertEqual(result["metrics"]["count_distinct_日期"], 3,
                         "#DIV/0! 当空值（不是那个错误文本、也不是 0）")
        codes = [item.get("code") for item in result["receipt"]["exceptions"]]
        self.assertIn("error_values", codes, "回执要说清有错误值")
        self.assertIs(result["receipt"]["completeness"]["aggregate_complete"], False,
                      "有算不出的值 ⇒ 聚合不完整（如实说）")

    # ---------- ④ 公式格：算出来的值可用；没算出来的当空值并上报 ----------
    def test_formula_cell_uses_computed_value_and_flags_pending(self):
        table = self._upload(formula_cell=True)
        result = table_analysis.aggregate({
            "table": table,
            "metrics": [{"op": "count_distinct", "field": "负责人"}],
        })
        columns = {item["column"]: item for item in result["columns"]}
        self.assertEqual(columns["负责人"]["kind"], "formula", "有公式格的列要标出来")
        self.assertEqual(columns["负责人"]["value_kind"], "computed", "值是算出来的，不是存下来的")
        # 公式由本域公式引擎在写回时算好；**没算出来的当空值**（这里表是原样上传的）
        codes = [item.get("code") for item in result["receipt"]["exceptions"]]
        self.assertIn("formula_values_pending", codes, "没算出来的公式格要上报")

    # ---------- ⑤ 表头不成立 ⇒ 拒绝并说清怎么改 ----------
    def test_title_row_as_header_is_rejected_with_advice(self):
        book = Workbook()
        ws = book.active
        ws.title = "S-1"
        ws.append(["某某统计表"])          # 第 1 行是标题
        ws.append(["金额", "负责人"])
        ws.append([1, "甲"])
        out = BytesIO()
        book.save(out)
        table = _upload("T06-标题行-%s.xlsx" % uuid.uuid4().hex[:6], out.getvalue())
        self.tables.append(table)
        with self.assertRaises(frappe.ValidationError) as caught:
            table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertIn("表头", str(caught.exception))
        self.assertIn("标题", str(caught.exception), "要说清常见原因（标题行当表头）")

    def test_merged_header_is_rejected(self):
        book = Workbook()
        ws = book.active
        ws.title = "S-1"
        ws.append(["金额", None])
        ws.append([1, 2])
        ws.merge_cells("A1:B1")
        out = BytesIO()
        book.save(out)
        table = _upload("T06-合并表头-%s.xlsx" % uuid.uuid4().hex[:6], out.getvalue())
        self.tables.append(table)
        with self.assertRaises(frappe.ValidationError) as caught:
            table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertIn("表头", str(caught.exception), "合并表头要当场拒并说清")

    # ---------- ⑥ 多工作表：只分析主工作表；点名别的表 ⇒ 拒 ----------
    def test_other_sheet_is_refused_with_the_primary_sheet_named(self):
        table = self._upload(extra_sheets=["S-2"])
        result = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertEqual(result["sheet"], "S-1", "默认分析主工作表")
        self.assertIn("S-2", result["sheets"], "回包把有哪些工作表说清楚")
        with self.assertRaises(frappe.ValidationError) as caught:
            table_analysis.aggregate({"table": table, "sheet": "S-2",
                                       "metrics": [{"op": "count_rows"}]})
        self.assertIn("S-1", str(caught.exception), "要说清只能分析哪一张")

    # ---------- ⑦ 受管列：值取数据库正式值（工作簿里的旧值不算数） ----------
    def test_managed_column_uses_database_value_not_the_stale_workbook_value(self):
        table = self._upload()
        # ⚠️ **PKG-117-T01**：受管列必须带**主体范围**（这里＝全局，与改造前效果一致）。
        columns = [
            {"header": "金额", "promoted": True, "field": "amount", "type": "number",
             "access": dict(fixture.GLOBAL_ACCESS)},
            {"header": "负责人", "promoted": True, "field": "owner_name", "type": "text",
             "access": dict(fixture.GLOBAL_ACCESS)},
            {"header": "日期", "promoted": True, "field": "day", "type": "date",
             "access": dict(fixture.GLOBAL_ACCESS)},
        ]
        binding = self._promote(table, columns)
        self.assertTrue(binding and binding.get("object_id"), "晋升成功并绑上受管对象")
        # 造一次**分岔**：数据库写成功、回填工作簿失败（真实里唯一会出现分岔的地方）
        handle, path = tempfile.mkstemp(prefix="t06-fault-")
        os.close(handle)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("file-write")
        previous = os.environ.get("SS_FAULT_FILE")
        os.environ["SS_FAULT_FILE"] = path
        try:
            row_id = sorted(binding["records"])[0]
            outcome = promotion.cell_write({"table": table, "row_id": row_id, "header": "金额",
                                            "value": {"type": "number", "value": 555.5}})
        finally:
            if previous is None:
                os.environ.pop("SS_FAULT_FILE", None)
            else:
                os.environ["SS_FAULT_FILE"] = previous
            os.unlink(path)
        self.assertTrue(outcome.get("formal_written"), "值已入库")
        self.assertFalse(outcome.get("sheet_written"), "回填没成功（工作簿里还是旧值）")
        frappe.db.commit()
        result = table_analysis.aggregate({
            "table": table,
            "metrics": [{"op": "count_rows"}, {"op": "sum", "field": "金额"}],
        })
        # 数据库里：555.5 + 20.25 + 0.25 + 5.0 = 581.00；工作簿里还是 10.5+20.25+0.25+5.0 = 36.00
        self.assertEqual(str(result["metrics"]["sum_金额"]), "581.00",
                         "受管列取数据库正式值（不是滞后的工作簿投影）")
        column = {item["column"]: item for item in result["columns"]}["金额"]
        self.assertEqual(column["origin"], "database", "受管列的值来源是数据库")
        self.assertTrue(column["authoritative"], "数据库里的值才是正式值")
        self.assertTrue(result["bound"], "回包说清这张表有受管绑定")
        self.assertIsNotNone(result["source"]["database"], "带数据库来源与版本")
        self.assertEqual(result["source"]["database"]["object_id"], binding["object_id"])

    # ---------- ⑧ 同一套语义：与受管记录的统计对同一批数据给同一个数 ----------
    def test_same_numbers_as_the_managed_record_aggregate(self):
        table = self._upload()
        # ⚠️ **PKG-117-T01**：受管列必须带**主体范围**（这里＝全局，与改造前效果一致）。
        columns = [
            {"header": "金额", "promoted": True, "field": "amount", "type": "number",
             "access": dict(fixture.GLOBAL_ACCESS)},
            {"header": "负责人", "promoted": True, "field": "owner_name", "type": "text",
             "access": dict(fixture.GLOBAL_ACCESS)},
            {"header": "日期", "promoted": True, "field": "day", "type": "date",
             "access": dict(fixture.GLOBAL_ACCESS)},
        ]
        binding = self._promote(table, columns)
        metrics = [{"op": "count_rows"}, {"op": "sum", "field": "amount"},
                   {"op": "count_distinct", "field": "owner_name"}]
        managed = model_records.aggregate_records(binding["object_id"], {}, metrics, "owner_name")
        table_result = table_analysis.aggregate({
            "table": table,
            "metrics": [{"op": "count_rows"}, {"op": "sum", "field": "金额"},
                        {"op": "count_distinct", "field": "负责人"}],
            "group_by": "负责人",
        })
        self.assertEqual(table_result["metrics"]["count_rows"], managed["metrics"]["count_rows"])
        self.assertEqual(str(table_result["metrics"]["sum_金额"]),
                         str(managed["metrics"]["sum_amount"]), "求和一样")
        self.assertEqual(table_result["metrics"]["count_distinct_负责人"],
                         managed["metrics"]["count_distinct_owner_name"], "去重一样")
        managed_groups = {item["group"]: item["metrics"]["count_rows"] for item in managed["groups"]}
        table_groups = {item["group"]: item["metrics"]["count_rows"] for item in table_result["groups"]}
        self.assertEqual(table_groups, managed_groups, "分组一样")

    # ---------- ⑨ 权限：无权的人读不到这张表 ----------
    def test_unauthorized_user_cannot_analyze_the_table(self):
        table = self._upload()
        email = "t06-staff-" + frappe.generate_hash(length=8) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "分析隔离员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        try:
            frappe.set_user(email)
            with self.assertRaises(frappe.PermissionError):
                table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        finally:
            frappe.set_user("Administrator")
            if frappe.db.exists("User", email):
                frappe.delete_doc("User", email, ignore_permissions=True, force=True)

    # ---------- ⑩ 公共动作通道能调（不是聊天专用后门） ----------
    def test_public_action_channel_can_aggregate(self):
        from shangshu_core.public_api import execute_registered_action
        table = self._upload()
        outcome = execute_registered_action("files.table_aggregate", {
            "table": table, "metrics": [{"op": "count_rows"}]}, confirmed=True,
            idempotency_key="t06-" + uuid.uuid4().hex[:8])
        payload = outcome.get("result") or {}
        self.assertEqual(payload["metrics"]["count_rows"], 4, "公共动作通道能统计一张表")

    # ---------- ⑪ 缓存：可丢弃的只读派生（带来源版本） ----------
    def test_derived_cache_is_versioned_and_reports_its_source(self):
        table = self._upload()
        first = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertFalse(first["cache"]["hit"], "第一次是现算")
        second = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertTrue(second["cache"]["hit"], "同一份来源版本 ⇒ 命中派生缓存")
        self.assertEqual(second["metrics"], first["metrics"], "命中缓存给的数一样")
        self.assertTrue(second["cache"]["key"].startswith(table_analysis.CACHE_PREFIX))
        # **可丢弃**：缓存不是事实，删掉不影响任何东西
        frappe.cache.delete_value(second["cache"]["key"])
        third = table_analysis.aggregate({"table": table, "metrics": [{"op": "count_rows"}]})
        self.assertFalse(third["cache"]["hit"], "缓存删掉后现算（它是可丢弃的派生）")
        self.assertEqual(third["metrics"], first["metrics"], "数还是一样")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
