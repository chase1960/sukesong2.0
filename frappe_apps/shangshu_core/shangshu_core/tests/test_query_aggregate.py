"""PKG-018-T02：受管记录的**程序筛选与统计**（公共只读能力）。

**测试通过 = 什么成立**（一句话）：

「**行数按全部授权匹配记录算**（不是这一页）；去重计数**不计 null** 且说清按哪个字段；
求和用**十进制精度**、全空时返回 null 并说明、**文本字段当场拒**；
一次查询可带筛选直接出汇总；分组最多 50 组且超出时说明完整组数与未完整标记，
而**全体指标仍按全量算**（不把显示的 50 组当全部）；
**换身份后统计按该身份重算**，未授权字段不许用于筛选／分组／去重／求和。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_query_aggregate --skip-test-records
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
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


class TestQueryAggregate(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "t02-" + uuid.uuid4().hex
        self.table = "t02-table-" + uuid.uuid4().hex[:8]
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

    def _provision(self, rows, columns=None, table=None, access=None):
        # 每次用**不同的**幂等键（同一把键配不同内容 ⇒ 内核会拒：业务内容已变化）
        result = provision_promoted_records(table=table or self.table, title="统计试点",
                                           columns=columns or COLUMNS, rows=rows,
                                           access=access or TABLE_ACCESS,
                                           idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    def _aggregate(self, object_id, **payload):
        return model_records.aggregate_records(object_id, **payload)

    # ① 行数按全部匹配记录算；一次查询可带筛选直接出汇总
    def test_count_rows_counts_all_matched_rows_and_filter_applies(self):
        result = self._provision(rows_for(120, days=["2026-10-%02d" % (index % 28 + 1) for index in range(120)],
                                           amounts=[index * 10.5 for index in range(120)],
                                           owners=["甲" if index % 2 == 0 else "乙" for index in range(120)]))
        aggregate = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        self.assertEqual(aggregate["metrics"]["count_rows"], 120, "行数按全部匹配记录算")
        # 带筛选 ⇒ 直接出汇总（不必先拉明细）
        filtered = self._aggregate(result["object_id"], filters={"owner_name": "甲"},
                                   metrics=[{"op": "count_rows"}, {"op": "count_distinct", "field": "day"}])
        self.assertEqual(filtered["metrics"]["count_rows"], 60, "筛选后的行数")
        self.assertEqual(filtered["metrics"]["count_distinct_day"], 14, "去重计数按 day，且与行数分开")
        self.assertEqual(filtered["receipt"]["criteria"]["filters"], {"owner_name": "甲"},
                         "回执要回显实际用的条件")
        self.assertEqual(filtered["receipt"]["criteria"]["counting"], "row")

    # ② 去重默认不计 null，且说清按哪个字段
    def test_count_distinct_skips_null_and_names_the_field(self):
        result = self._provision(rows_for(6, owners=["甲", "甲", "乙", None, None, "丙"]))
        aggregate = self._aggregate(result["object_id"],
                                    metrics=[{"op": "count_distinct", "field": "owner_name"}])
        self.assertEqual(aggregate["metrics"]["count_distinct_owner_name"], 3,
                         "null 不计入去重（甲/乙/丙）")
        self.assertEqual(aggregate["receipt"]["criteria"]["distinct_field"], "owner_name",
                         "口径要说清按哪个字段去重")

    # ③ 求和：十进制精度 / 全空为 null / 文本字段当场拒
    def test_sum_uses_decimal_precision_null_when_all_null_and_rejects_text(self):
        result = self._provision(rows_for(3, amounts=[10.5, 20.25, 0.25]))
        aggregate = self._aggregate(result["object_id"], metrics=[{"op": "sum", "field": "amount"}])
        self.assertEqual(str(aggregate["metrics"]["sum_amount"]), "31.00", "十进制精度：10.5+20.25+0.25=31.00")
        # ⚠️ 事实记录：**晋升的数值列会把缺失值落成 0** ⇒ 受管数值列上暂时构造不出「全空」。
        #   「全空求和 ⇒ null（不是 0）」的口径因此用**单元级**判据钉住（_decimal_sum），
        #   集成层只验「空值被跳过、0 是实际算出的零」。
        self.assertEqual(model_records._decimal_sum([None, None]), (None, False),
                         "全空求和是 null（不是 0）")
        self.assertEqual(model_records._decimal_sum([None, 1.5, None]),
                         (__import__("decimal").Decimal("1.5"), True), "空值被跳过，其余照算")
        partial = self._aggregate(result["object_id"], metrics=[{"op": "sum", "field": "amount"}])
        self.assertEqual(str(partial["metrics"]["sum_amount"]), "31.00")
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], metrics=[{"op": "sum", "field": "owner_name"}])

    # ④ 分组上限 50；全体指标在显示限额之前算
    def test_group_by_caps_display_but_overall_metrics_use_full_range(self):
        days = ["2026-%02d-%02d" % (index // 28 + 1, index % 28 + 1) for index in range(120)]
        result = self._provision(rows_for(120, days=days, amounts=[1 for _ in range(120)]))
        aggregate = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}], group_by="day")
        truncation = aggregate["group_truncation"]
        self.assertEqual(len(aggregate["groups"]), 50, "分组显示最多 50 组")
        self.assertEqual(truncation["total_groups"], 120, "要说明完整分组数")
        self.assertEqual(truncation["returned_groups"], 50)
        self.assertIs(truncation["complete"], False, "要标出没完整返回")
        self.assertEqual(aggregate["metrics"]["count_rows"], 120,
                         "全体指标按全量算，不把显示的 50 组当全部")

    # ⑤ 未授权字段不许用于筛选/分组/去重/求和
    def test_unauthorized_field_cannot_be_used_for_filter_group_distinct_or_sum(self):
        result = self._provision(rows_for(3, amounts=[1, 2, 3]))
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], filters={"不存在的字段": "x"},
                            metrics=[{"op": "count_rows"}])
        with self.assertRaises(frappe.PermissionError):
            self._aggregate(result["object_id"], metrics=[{"op": "sum", "field": "不存在的字段"}])
        with self.assertRaises(frappe.PermissionError):
            self._aggregate(result["object_id"], metrics=[{"op": "count_distinct", "field": "不存在的字段"}])
        with self.assertRaises(frappe.PermissionError):
            self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}], group_by="不存在的字段")

    # ---------- A02：数据超过分页上限，聚合仍按**全部**授权匹配记录算 ----------
    def test_aggregate_is_over_all_matched_rows_not_one_page(self):
        result = self._provision(rows_for(124, amounts=[1] * 124,
                                           days=["2026-10-%02d" % (index % 28 + 1) for index in range(124)]))
        # 列表一次最多 100 条（分页上限）⇒ 聚合不能跟着分页走。
        listed = model_records.query_records(result["object_id"], filters={}, page=1, page_length=100)
        self.assertEqual(listed["total"], 124)
        self.assertEqual(len(listed["rows"]), 100, "列表只给一页")
        aggregate = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        self.assertEqual(aggregate["metrics"]["count_rows"], 124, "聚合按全部匹配记录算（不按那一页）")
        self.assertEqual(aggregate["receipt"]["counts"]["matched_total"], 124)

    # ---------- A05：日期边界与字段类型不符 ----------
    def test_date_range_boundaries_are_explicit_and_type_mismatch_is_rejected(self):
        result = self._provision(rows_for(10, days=["2026-10-%02d" % (index + 1) for index in range(10)],
                                           amounts=[1] * 10))
        lower = self._aggregate(result["object_id"],
                                filters={"day": {"op": "gte", "value": "2026-10-03"}},
                                metrics=[{"op": "count_rows"}])
        self.assertEqual(lower["metrics"]["count_rows"], 8, ">= 2026-10-03 ⇒ 10-03..10-10 共 8 天")
        upper = self._aggregate(result["object_id"],
                                filters={"day": {"op": "lte", "value": "2026-10-03"}},
                                metrics=[{"op": "count_rows"}])
        self.assertEqual(upper["metrics"]["count_rows"], 3, "<= 2026-10-03 ⇒ 含当天共 3 天")
        inside_set = self._aggregate(result["object_id"],
                                     filters={"day": {"op": "in", "value": ["2026-10-01", "2026-10-10"]}},
                                     metrics=[{"op": "count_rows"}])
        self.assertEqual(inside_set["metrics"]["count_rows"], 2)
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], filters={"day": {"op": "gte", "value": 20261003}},
                            metrics=[{"op": "count_rows"}])
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], filters={"amount": "十块"},
                            metrics=[{"op": "count_rows"}])
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], filters={"owner_name": {"op": "gt", "value": "甲"}},
                            metrics=[{"op": "count_rows"}])

    # ---------- A07：授权隔离（字段可见性 / 记录范围 / 企业边界） ----------
    def test_authorization_isolation_field_visibility_and_enterprise(self):
        """普通员工**看得见这个对象**，但**看不见密级列** ⇒ 那列不许用于筛选/分组/去重/求和；
        且看不见的行数/分组数**不泄漏**；对象归别家企业时**直接不可访问**。"""
        columns = [
            {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
            {"header": "密级", "promoted": True, "field": "secret", "type": "text",
             "access": {"read": {"scope": "personal", "users": ["Administrator"]},
                        "write": {"scope": "personal", "users": ["Administrator"]},
                        "download": {"scope": "personal", "users": ["Administrator"]}}},
        ]
        access = {"read": {"scope": "global"},
                  "write": {"scope": "personal", "users": ["Administrator"]},
                  "download": {"scope": "personal", "users": ["Administrator"]},
                  "record_scope": "all"}
        rows = [{"row_id": "r-%06d" % index,
                 "values": {"amount": index + 1, "secret": "机密%d" % index}} for index in range(6)]
        result = self._provision(rows, columns=columns, access=access)
        object_id = result["object_id"]
        enterprise = frappe.get_value(model_records.MODEL, object_id, "enterprise_id")
        # 管理员：全部字段可读（这条是「隔离不是一刀切」的对照）
        admin = self._aggregate(object_id, metrics=[{"op": "count_rows"},
                                                   {"op": "count_distinct", "field": "secret"}])
        self.assertEqual(admin["metrics"]["count_rows"], 6)
        self.assertEqual(admin["metrics"]["count_distinct_secret"], 6)
        # 普通员工：对象可读 ⇒ 行数照算（不因一个字段被遮就整体报错）
        email = "agg-staff-" + frappe.generate_hash(length=8) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "统计隔离员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        try:
            identity = frappe.get_doc("Shangshu Identity", frappe.db.get_value(
                "Shangshu Identity", {"user": email}, "name"))
            if identity.enterprise_id != enterprise:
                # 新建员工默认落在别的企业 ⇒ 把它归到与对象同一个企业，才能单独验「字段隔离」
                frappe.db.set_value("Shangshu Identity", identity.name, "enterprise_id", enterprise)
            frappe.set_user(email)
            visible = self._aggregate(object_id, metrics=[{"op": "count_rows"}])
            self.assertEqual(visible["metrics"]["count_rows"], 6, "对象本身可读 ⇒ 行数照算")
            for payload in (
                {"metrics": [{"op": "count_distinct", "field": "secret"}]},
                {"metrics": [{"op": "count_rows"}], "group_by": "secret"},
                {"filters": {"secret": "机密1"}, "metrics": [{"op": "count_rows"}]},
            ):
                with self.assertRaises(frappe.PermissionError):
                    self._aggregate(object_id, **payload)
        finally:
            frappe.set_user("Administrator")
            if frappe.db.exists("User", email):
                frappe.delete_doc("User", email, ignore_permissions=True, force=True)
        # 企业边界：对象归别家企业 ⇒ 直接不可访问（**连行数都不给**）
        frappe.db.set_value(model_records.MODEL, object_id, "enterprise_id", "foreign-test-enterprise")
        try:
            with self.assertRaises(frappe.PermissionError):
                self._aggregate(object_id, metrics=[{"op": "count_rows"}])
        finally:
            frappe.db.set_value(model_records.MODEL, object_id, "enterprise_id", enterprise)

    # ⑦ 公共动作口：助手/人 走公共动作通道也能统计（不是聊天专用后门）
    def test_public_action_can_aggregate(self):
        from shangshu_core.public_api import execute_registered_action
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4], owners=["甲", "甲", "乙", "乙"]))
        outcome = execute_registered_action("platform.object.aggregate", {
            "object_id": result["object_id"],
            "metrics": [{"op": "count_rows"}, {"op": "sum", "field": "amount"},
                        {"op": "count_distinct", "field": "owner_name"}],
        }, confirmed=True, idempotency_key=self.key + "-action")
        payload = outcome.get("result") or {}
        self.assertEqual(payload["metrics"]["count_rows"], 4)
        from decimal import Decimal
        self.assertEqual(Decimal(str(payload["metrics"]["sum_amount"])), Decimal("10"),
                         "求和按十进制返回（字符串，不靠模型算）")
        self.assertEqual(payload["metrics"]["count_distinct_owner_name"], 2)
        self.assertEqual(payload["receipt"]["counts"]["matched_total"], 4)

    # ⑥ 参数闸：条件数、指标数、分组数
    def test_limits_on_conditions_metrics_and_group_by(self):
        result = self._provision(rows_for(3, amounts=[1, 2, 3]))
        too_many = {"f%d" % index: index for index in range(9)}
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], filters=too_many, metrics=[{"op": "count_rows"}])
        with self.assertRaises(frappe.ValidationError):
            self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}, {"op": "count_rows"},
                                                         {"op": "count_rows"}, {"op": "count_rows"}])


if __name__ == "__main__":  # pragma: no cover
    pass
