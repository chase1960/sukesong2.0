"""PKG-018-T09：**指标注册**（轻量）——「统计什么、按哪个日期、如何去重」由 FDE 登记，按名字跑。

**测试通过 = 什么成立**（一句话）：

「FDE 能登记一个指标（统计什么／按哪个日期／按哪个字段去重），登记后**按名字就能跑**，
跑出来的数与直接统计一致；**普通员工登记不了**（权限）；定义里写错字段**当场拒**；
**口径变了看得出来**（定义版本与内容哈希都变了，旧结果里带的是旧哈希）；
定义改版后**之前发的结果集引用作废**，明确要求重新查询。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_metric_registry --skip-test-records
"""
import uuid
from decimal import Decimal

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.actions import execute_registered_action
from shangshu_core.promotion_records import provision_promoted_records

COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
    {"header": "负责人", "promoted": True, "field": "owner_name", "type": "text"},
]

# 受管表链的**表级主体范围声明**（PKG-117-T01）：表级是**独立声明**的，
# 不再由各列并集推导 ⇒ 晋升入口**必填**。
TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}


def rows_for(count, days=None, amounts=None, owners=None):
    out = []
    for index in range(1, count + 1):
        values = {}
        if amounts is not None:
            values["amount"] = amounts[index - 1]
        if days is not None:
            values["day"] = days[index - 1]
        if owners is not None:
            values["owner_name"] = owners[index - 1]
        out.append({"row_id": "r-%06d" % index, "values": values})
    return out


class TestMetricRegistry(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "t09-" + uuid.uuid4().hex
        self.table = "t09-table-" + uuid.uuid4().hex[:8]
        self.created = []
        self.staff = None
        self.metric_names = []

    def tearDown(self):
        frappe.set_user("Administrator")
        for name in self.metric_names:
            try:
                frappe.delete_doc("Shangshu Metric Definition", name, force=True, ignore_permissions=True)
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
        if self.staff and frappe.db.exists("User", self.staff):
            frappe.delete_doc("User", self.staff, ignore_permissions=True, force=True)
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 辅助 ----------

    def _provision(self, rows, columns=None, table=None):
        result = provision_promoted_records(table=table or self.table, title="指标试点",
                                            columns=columns or COLUMNS, rows=rows,
                                            access=TABLE_ACCESS,
                                            idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    def _define(self, payload, confirmed=True):
        name = str(payload.get("metric_name"))
        if name not in self.metric_names:
            self.metric_names.append(name)
        outcome = execute_registered_action("platform.metric.define", payload, confirmed=confirmed,
                                            idempotency_key=self.key + "-define-" + uuid.uuid4().hex[:8],
                                            source="user")
        return outcome.get("result") or {}

    def _run(self, metric_name, payload=None, confirmed=True):
        outcome = execute_registered_action("platform.metric.run",
                                            {"metric_name": metric_name, **(payload or {})},
                                            confirmed=confirmed,
                                            idempotency_key=self.key + "-run-" + uuid.uuid4().hex[:8],
                                            source="user")
        return outcome.get("result") or {}

    def _staff_user(self):
        email = "metric-staff-" + frappe.generate_hash(length=8) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "指标员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        self.staff = email
        return email

    # ① 登记 → 按名字跑；数值与直接统计一致；去重字段自动成为一条去重指标
    def test_registered_metric_can_be_run_by_name(self):
        result = self._provision(rows_for(6, amounts=[1, 2, 3, 4, 5, 6],
                                          owners=["甲", "甲", "乙", "乙", "丙", "丙"],
                                          days=["2026-10-0%d" % (index % 3 + 1) for index in range(6)]))
        defined = self._define({
            "metric_name": "amount_total", "title": "金额合计",
            "object_id": result["object_id"],
            "metrics": [{"op": "sum", "field": "amount"}],
            "date_field": "day", "distinct_field": "owner_name",
        })
        self.assertEqual(defined["metric_name"], "amount_total")
        self.assertEqual(defined["definition_version"], 1, "首次登记是第 1 版")
        self.assertTrue(defined["definition_hash"], "要给出定义的内容指纹")

        run = self._run("amount_total")
        self.assertEqual(Decimal(str(run["metrics"]["sum_amount"])), Decimal("21"), "按名字跑出来的数要对")
        self.assertEqual(run["metrics"]["count_distinct_owner_name"], 3,
                         "「按哪个字段去重」要成为一条去重指标")
        # 回执要带**口径自证**：这是哪个指标、第几版、内容指纹是多少
        metric_block = run["receipt"]["metric"]
        self.assertEqual(metric_block["metric_name"], "amount_total")
        self.assertEqual(metric_block["definition_version"], 1)
        self.assertEqual(metric_block["date_field"], "day")
        self.assertEqual(metric_block["distinct_field"], "owner_name")
        self.assertTrue(metric_block["definition_hash"])

        # 与直接统计同口径
        direct = model_records.aggregate_records(result["object_id"], {},
                                                  [{"op": "sum", "field": "amount"}])
        self.assertEqual(Decimal(str(direct["metrics"]["sum_amount"])),
                         Decimal(str(run["metrics"]["sum_amount"])))

    # ② 口径变了看得出来：版本升、指纹变；旧结果里带的是旧指纹
    def test_changing_definition_is_visible_in_version_and_hash(self):
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4],
                                          owners=["甲", "甲", "乙", "乙"]))
        first = self._define({"metric_name": "amount_total", "object_id": result["object_id"],
                              "metrics": [{"op": "sum", "field": "amount"}],
                              "distinct_field": "owner_name"})
        before = self._run("amount_total")
        changed = self._define({"metric_name": "amount_total", "object_id": result["object_id"],
                                "metrics": [{"op": "count_rows"}], "distinct_field": "owner_name"})
        self.assertEqual(changed["definition_version"], 2, "改一次定义要升一版")
        self.assertNotEqual(changed["definition_hash"], first["definition_hash"],
                            "口径变了内容指纹必须变")
        after = self._run("amount_total")
        self.assertNotEqual(after["receipt"]["metric"]["definition_hash"],
                            before["receipt"]["metric"]["definition_hash"],
                            "旧结果里的指纹与新结果不同 ⇒ 看得出口径变了")
        self.assertEqual(after["receipt"]["metric"]["definition_version"], 2)

    # ③ 权限：普通员工登记不了
    def test_only_system_manager_can_register_metric(self):
        result = self._provision(rows_for(2, amounts=[1, 2]))
        email = self._staff_user()
        frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError):
            self._define({"metric_name": "staff_metric", "object_id": result["object_id"],
                          "metrics": [{"op": "count_rows"}]})

    # ④ 定义写错当场拒（不存在的字段／不是日期的日期字段／不存在的对象）
    def test_invalid_definition_is_rejected_at_registration(self):
        result = self._provision(rows_for(2, amounts=[1, 2]))
        with self.assertRaises(frappe.ValidationError):
            self._define({"metric_name": "bad_field", "object_id": result["object_id"],
                          "metrics": [{"op": "sum", "field": "不存在的字段"}]})
        with self.assertRaises(frappe.ValidationError):
            self._define({"metric_name": "bad_date", "object_id": result["object_id"],
                          "metrics": [{"op": "count_rows"}], "date_field": "amount"})
        with self.assertRaises(frappe.ValidationError):
            self._define({"metric_name": "bad_object", "object_id": "com.shangshu.app.x.object.y",
                          "metrics": [{"op": "count_rows"}]})

    # ⑤ 跑不存在的指标 ⇒ 明确报错
    def test_running_unknown_metric_is_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            self._run("根本没登记过的指标")

    # ⑥ 按日期跑：定义里说了按哪个日期，就按那个日期筛
    def test_date_range_uses_the_declared_date_field(self):
        result = self._provision(rows_for(6, amounts=[1] * 6,
                                          days=["2026-10-01", "2026-10-02", "2026-10-03",
                                                "2026-10-01", "2026-10-02", "2026-10-03"]))
        self._define({"metric_name": "daily_amount", "object_id": result["object_id"],
                      "metrics": [{"op": "count_rows"}], "date_field": "day"})
        run = self._run("daily_amount", {"date_from": "2026-10-02", "date_to": "2026-10-03"})
        self.assertEqual(run["metrics"]["count_rows"], 4, "按定义里声明的日期字段筛")
        self.assertEqual(run["receipt"]["metric"]["date_field"], "day")
        # 没声明日期字段的指标，不许按日期筛
        self._define({"metric_name": "no_date", "object_id": result["object_id"],
                      "metrics": [{"op": "count_rows"}]})
        with self.assertRaises(frappe.ValidationError):
            self._run("no_date", {"date_from": "2026-10-02"})

    # ⑦ 定义改版 ⇒ 之前发的结果集引用作废（明确要求重新查询）
    def test_reference_from_metric_run_is_invalidated_by_definition_change(self):
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4]))
        self._define({"metric_name": "amount_total", "object_id": result["object_id"],
                      "metrics": [{"op": "sum", "field": "amount"}]})
        run = self._run("amount_total")
        ref = run["result_set"]["ref"]
        self.assertTrue(ref, "按指标跑出来的结果也要带可引用编号")
        self._define({"metric_name": "amount_total", "object_id": result["object_id"],
                      "metrics": [{"op": "count_rows"}]})
        with self.assertRaises(frappe.ValidationError) as caught:
            model_records.aggregate_records(None, result_set=ref, metrics=[{"op": "count_rows"}])
        self.assertIn("重新查询", str(caught.exception), "定义改版后旧引用要作废并要求重新查询")

    # ⑧ 指标里的固定条件与本次条件冲突 ⇒ 明确拒（不静默取其一）
    def test_conflicting_filters_are_rejected(self):
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4],
                                          owners=["甲", "乙", "甲", "乙"]))
        self._define({"metric_name": "amount_total", "object_id": result["object_id"],
                      "metrics": [{"op": "count_rows"}], "filters": {"owner_name": "甲"}})
        with self.assertRaises(frappe.ValidationError):
            self._run("amount_total", {"filters": {"owner_name": "乙"}})


if __name__ == "__main__":  # pragma: no cover
    pass
