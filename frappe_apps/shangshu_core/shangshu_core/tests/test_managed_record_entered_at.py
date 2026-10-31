"""PKG-068-T01：**受管记录自带「进入这个受管对象的时间」**（内核那一列，一劳永逸）。

**为什么要有这一列**（用户 2026-10-23 22:1x 拍板）：
「给审核中心配一个进入的时间 —— 这一个字段，**以后所有的业务域只要往审核中心塞东西都记录**，
这样一劳永逸。」

⇒ **进入时间不是某个域的事** ⇒ 落在**内核的受管记录**上 ⇒ **所有域**的受管记录都自带
（域**不用自己加一列**、**不用升受管对象版本**、**不用 migrate**）。

⚠️ **为什么不能拿 `modified` 顶替**：`modified` 是**最后写入**的时间（审一次就变一次）
⇒ 拿它当「进入审核中心的时间」是**错的**（用户 2026-10-23 21:0x 已明确否掉这条路）。

**测试通过 = 什么成立**（一句话）：
「受管记录的行（**数据集**与**详情**两处）都带着 **`creation`** —— 那是这条记录
**进到这个受管对象**的时间（文本、有值、**不晚于**更新时间）；
而域**不许**拿 `creation` 当自己的受管字段名（否则域给的那一列会被内核这一行**悄悄盖掉**）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_managed_record_entered_at --skip-test-records
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records

COLUMNS = [
    {"header": "业务编号", "promoted": True, "field": "code", "type": "text", "rules": {}},
]


class TestManagedRecordEnteredAt(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "entered-" + uuid.uuid4().hex
        self.table = "entered-table-" + uuid.uuid4().hex[:8]
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

    def _provision(self, codes):
        rows = [{"row_id": "r-%03d" % index, "values": {"code": code}}
                for index, code in enumerate(codes, start=1)]
        result = provision_promoted_records(table=self.table, title="进入时间试点", columns=COLUMNS,
                                           rows=rows,
                                           access={"read": {"scope": "global"},
                                                   "write": {"scope": "global"},
                                                   "download": {"scope": "global"},
                                                   "record_scope": "all"},
                                           idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    # ① 数据集行：带着进入时间
    def test_the_dataset_row_carries_the_time_the_record_entered_the_object(self):
        result = self._provision(["CASE-001", "CASE-002"])
        payload = model_records.query_records(result["object_id"], page_length=10)
        rows = payload.get("rows") or []
        self.assertEqual(len(rows), 2, "受管记录读不出来：%s" % payload)
        for row in rows:
            entered = row.get("creation")
            self.assertTrue(entered, "行上没有「进入这个受管对象的时间」：%s" % row)
            self.assertIsInstance(entered, str, "进入时间必须是文本：%r" % (entered,))
            self.assertTrue(row.get("modified"), "行上没有更新时间（固定尾注缺了）：%s" % row)
            self.assertLessEqual(str(entered)[:19], str(row.get("modified"))[:19],
                                 "进入时间比更新时间还晚（那是写坏了，不是进入时间）")

    # ② 详情口：同一形状
    def test_the_single_record_carries_the_same_time(self):
        result = self._provision(["CASE-003"])
        name = result["records"]["r-001"]
        payload = model_records.get_record(result["object_id"], name)
        record = payload.get("record") or {}
        self.assertTrue(record.get("creation"),
                        "详情口没有「进入这个受管对象的时间」（两处形状必须一致）：%s" % payload)
        self.assertIsInstance(record.get("creation"), str, "进入时间必须是文本：%r" % (record.get("creation"),))

    # ③ 域不许拿 `creation` 当自己的受管字段名
    def test_a_domain_may_not_declare_creation_as_its_own_managed_field(self):
        """域要是能声明 `creation`，它给的那一列会被内核这一行**悄悄盖掉**
        （内核的固定尾注写在域的字段之后）⇒ 人看到的值就是错的 ⇒ 当场拒。"""
        from shangshu_core import model_schema

        owner = "com.shangshu.app." + "a" * 32
        object_id = owner + ".object." + "b" * 32
        definition = {"schema_version": 1, "title": "抢 creation 的域", "kind": "record",
                      "fields": [{"id": "creation", "label": "进入时间", "type": "text"}],
                      "access": {"read_roles": ["Desk User"], "write_roles": ["Desk User"],
                                 "record_scope": "all"}}
        with self.assertRaises(model_schema.ModelError):
            model_schema.compile_object(owner, object_id, definition)


if __name__ == "__main__":  # pragma: no cover
    import unittest

    unittest.main()
