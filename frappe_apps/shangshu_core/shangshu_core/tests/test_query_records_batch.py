"""**分页读一页 N 行，取行不许 N 次查**（2026-10-28 · PKG-132 · 审查报告 R14）。

**背景**：受管记录的**列表读**（`query_records`）以前是
「SQL 限出当前页的行名 ⇒ **逐行 `frappe.get_doc`** ⇒ 逐行装配字段值」。
⇒ 一页 30 行 = **30 次逐行取文档 ＋ 30 次字段装配**，行数一多就线性变慢
（站上实测：目标行读回 600 行 = 600 次逐行装配 ⇒ 3.1 秒）。
⇒ 而内核**已经有**批量取行口 `model_records.get_records`（一次 `name IN (...)`），
只是**分页路没接上去**。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **读一页 N 行，取行的 SQL 条数**（随行数增长的部分）**不是 N** ——
   页从 10 行加到 50 行，SQL 条数**只多几条**（不是多 40 条）。
2. **口径一字不变** —— 读回的每一行仍带着该读到的字段值、`name`、`modified`、`creation`；
   值的类型归一（日期仍是 `YYYY-MM-DD` 文本、布尔仍是 bool）没变。
3. **收尾不重复装配** —— 一次查询里**只装配一次定义**（不是页头、回执、返回各装配一遍）。

**怎么跑**（装了这个 App 的站点上）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. ../../env/bin/python -m unittest \
        shangshu_core.tests.test_query_records_batch
"""
import sys
import unittest
import uuid
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover - 没有 frappe 就退化成替身
    HAS_FRAPPE = False
    frappe = None
    FrappeTestCase = unittest.TestCase

from shangshu_core import model_records  # noqa: E402  （放在 frappe 判定之后）

COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
    {"header": "开关", "promoted": True, "field": "flag", "type": "boolean"},
    {"header": "负责人", "promoted": True, "field": "owner_name", "type": "text"},
]
TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}


def rows_for(count):
    out = []
    for index in range(1, count + 1):
        out.append({"row_id": "r-%06d" % index,
                    "values": {"amount": index, "day": "2026-01-%02d" % (index % 28 + 1),
                               "flag": index % 2 == 0, "owner_name": "人%d" % index}})
    return out


def _site_ready():
    """**连上站点了吗** —— 没有站点就跳过（别在离线环境里报错）。"""
    try:
        # `frappe.local.site` 只有 `frappe.init(site=…)` 之后才有值 ⇒
        # 没连站点就是 False ⇒ 这条判据**跳过**（而不是在离线环境里报错）。
        return bool(getattr(frappe.local, "site", None))
    except Exception:
        return False


@unittest.skipUnless(HAS_FRAPPE and _site_ready(), "需要站点：这条判据只在装了站点的环境里跑")
class TestQueryRecordsBatch(FrappeTestCase):
    """分页读的取行成本**不随行数线性增长**；口径不变。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "r14-" + uuid.uuid4().hex
        self.table = "r14-table-" + uuid.uuid4().hex[:8]
        self.created = []

    def tearDown(self):
        frappe.set_user("Administrator")
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

    def _provision(self, count):
        from shangshu_core.promotion_records import provision_promoted_records
        result = provision_promoted_records(table=self.table, title="分页批读试点",
                                            columns=COLUMNS, rows=rows_for(count),
                                            access=TABLE_ACCESS,
                                            idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    def _sql_count(self, object_id, page_length):
        """数一次分页读发了多少条 SQL。"""
        counted = []
        original = frappe.db.sql

        def counting(query, *args, **kwargs):
            counted.append(" ".join(str(query or "").split())[:160])
            return original(query, *args, **kwargs)

        frappe.db.sql = counting
        try:
            out = model_records.query_records(object_id, page=1, page_length=page_length)
        finally:
            frappe.db.sql = original
        return len(counted), out

    def test_a_page_costs_one_bulk_read_not_one_query_per_row(self):
        """① 页从 10 行加到 50 行，SQL 条数**只多几条**（不是多 40 条）。"""
        result = self._provision(60)
        object_id = result["object_id"]
        small, out_small = self._sql_count(object_id, 10)
        big, out_big = self._sql_count(object_id, 50)
        self.assertEqual(len(out_small["rows"]), 10, "小页没读够")
        self.assertEqual(len(out_big["rows"]), 50, "大页没读够")
        growth = big - small
        self.assertLessEqual(
            growth, 6,
            "读的行数从 10 加到 50，SQL 多了 %d 条（应当基本不随行数增长 ⇒ 仍在逐行取文档）" % growth)

    def test_the_rows_still_carry_the_same_values(self):
        """② 口径不变：字段值、name／modified／creation、类型归一都在。"""
        result = self._provision(6)
        out = model_records.query_records(result["object_id"], page=1, page_length=6)
        self.assertEqual(len(out["rows"]), 6)
        for row in out["rows"]:
            self.assertTrue(row.get("name"), "每行都要带 name")
            self.assertTrue(row.get("modified"), "每行都要带 modified（记录版本）")
            self.assertTrue(row.get("creation"), "每行都要带 creation")
            self.assertIn("amount", row, "字段值没读回来")
            self.assertIsInstance(row.get("flag"), bool, "布尔字段没归一成 bool")
            self.assertRegex(str(row.get("day")), r"^\d{4}-\d{2}-\d{2}$", "日期没归一成 YYYY-MM-DD")
        amounts = sorted(int(row["amount"]) for row in out["rows"])
        self.assertEqual(amounts, [1, 2, 3, 4, 5, 6], "读回的值不对")

    def test_the_definition_is_assembled_once(self):
        """③ 一次查询里**只装配一次定义**（不是页头、回执、返回各装配一遍）。"""
        result = self._provision(5)
        counted = []
        original = model_records.definition

        def counting(object_id):
            counted.append(object_id)
            return original(object_id)

        model_records.definition = counting
        try:
            model_records.query_records(result["object_id"], page=1, page_length=5)
        finally:
            model_records.definition = original
        self.assertLessEqual(
            len(counted), 1,
            "一次查询里装配了 %d 次定义（应当 1 次）" % len(counted))


if __name__ == "__main__":
    unittest.main()
