"""PKG-018-T08：结果集引用（会话内的「继续统计刚才那 126 条」）。

**测试通过 = 什么成立**（一句话）：

「一次统计/查询的结果**带一个可引用的编号**；拿这个编号能**继续查**（加条件、换分组、再统计）；
**数据变了／权限被撤／受管对象升版／过期／编号被改过／别人的编号** —— 这六种情况
一律**明确要求重新查询**，**不许拿旧结果当新结果**。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_result_set --skip-test-records
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records, extend_promoted_records

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


class TestResultSet(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "t08-" + uuid.uuid4().hex
        self.table = "t08-table-" + uuid.uuid4().hex[:8]
        self.created = []
        self.staff = None

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
        if self.staff and frappe.db.exists("User", self.staff):
            frappe.delete_doc("User", self.staff, ignore_permissions=True, force=True)
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 辅助 ----------

    def _provision(self, rows, columns=None, table=None):
        result = provision_promoted_records(table=table or self.table, title="引用试点",
                                            columns=columns or COLUMNS, rows=rows,
                                            access=TABLE_ACCESS,
                                            idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    def _aggregate(self, object_id=None, **payload):
        return model_records.aggregate_records(object_id, **payload)

    def _staff_user(self):
        """建一个普通员工（Desk User），并让它与对象同一个企业。"""
        email = "rs-staff-" + frappe.generate_hash(length=8) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "引用员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        self.staff = email
        return email

    # ① 结果带可引用编号；拿编号能继续查（加条件／换分组）；新结果也带新编号
    def test_aggregate_returns_reference_and_reference_can_be_continued(self):
        result = self._provision(rows_for(126, owners=["甲" if index % 2 == 0 else "乙" for index in range(126)],
                                          amounts=[1] * 126))
        first = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        self.assertEqual(first["metrics"]["count_rows"], 126, "行数按全部匹配记录算")
        ref = (first.get("result_set") or {}).get("ref")
        self.assertTrue(ref and ref.startswith("rs_"), "统计结果要带一个可引用的编号")
        # 回执里也要有（口径自证：模型只看回执就知道这个范围怎么来的）
        self.assertEqual((first["receipt"].get("result_set") or {}).get("ref"), ref,
                         "回执里要带同一个引用编号")

        # 「继续统计刚才那 126 条」—— 拿编号加条件再统计
        second = self._aggregate(None, result_set=ref, filters={"owner_name": "甲"},
                                 metrics=[{"op": "count_rows"}])
        self.assertEqual(second["metrics"]["count_rows"], 63, "用引用继续统计：甲 63 条")
        self.assertEqual(second["receipt"]["criteria"]["filters"], {"owner_name": "甲"},
                         "回执要回显实际用的条件")
        self.assertNotEqual((second.get("result_set") or {}).get("ref"), ref,
                            "继续统计要发一个新的引用编号")
        self.assertEqual((second.get("result_set") or {}).get("based_on"), ref,
                         "新引用要说明它接在哪一个引用上")

        # 拿编号换分组再统计
        grouped = self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}],
                                  group_by="owner_name")
        self.assertEqual(len(grouped["groups"]), 2, "用引用换分组也能查")

    # ② 乱编的编号 ⇒ 明确要求重新查询（不能只发一个编号就用）
    def test_made_up_reference_is_rejected_and_asks_to_requery(self):
        result = self._provision(rows_for(3, amounts=[1, 2, 3]))
        for fake in ("rs_totally-made-up.000000000000",
                     "rs_%s.%s" % ("a" * 22, "0" * 12),
                     "not-a-reference",
                     ""):
            with self.assertRaises(frappe.ValidationError) as caught:
                self._aggregate(None, result_set=fake, metrics=[{"op": "count_rows"}])
            self.assertIn("重新查询", str(caught.exception),
                          "编造的编号要明确告诉调用方「请重新查询」")

    # ③ 别人的编号不能用（撤权前先说归属）
    def test_reference_of_another_identity_cannot_be_used(self):
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4]))
        email = self._staff_user()
        enterprise = frappe.get_value(model_records.MODEL, result["object_id"], "enterprise_id")
        identity = frappe.get_doc("Shangshu Identity", frappe.db.get_value(
            "Shangshu Identity", {"user": email}, "name"))
        if identity.enterprise_id != enterprise:
            frappe.db.set_value("Shangshu Identity", identity.name, "enterprise_id", enterprise)
        frappe.set_user(email)
        owned = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        ref = owned["result_set"]["ref"]
        frappe.set_user("Administrator")
        with self.assertRaises(frappe.PermissionError):
            self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}])

    # ④ 数据变了 ⇒ 引用作废，明确要求重新查询（不许拿旧数当新数）
    def test_data_change_invalidates_reference(self):
        result = self._provision(rows_for(3, amounts=[1, 2, 3]))
        first = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        ref = first["result_set"]["ref"]
        self.assertEqual(first["metrics"]["count_rows"], 3)
        # 新增一条匹配记录 ⇒ 范围变了
        from shangshu_core.actions import execute_registered_action
        execute_registered_action("platform.object.create",
                                  {"object_id": result["object_id"],
                                   "expected_revision": result["revision"],
                                   "values": {"amount": 4}},
                                  confirmed=True, idempotency_key=self.key + "-add", source="user")
        with self.assertRaises(frappe.ValidationError) as caught:
            self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}])
        message = str(caught.exception)
        self.assertIn("重新查询", message, "数据变了要明确要求重新查询")
        self.assertIn("3", message, "要说清原来是几条、现在是几条")
        self.assertIn("4", message, "要说清原来是几条、现在是几条")

    # ⑤ 受管对象定义升版 ⇒ 引用作废
    def test_object_revision_change_invalidates_reference(self):
        result = self._provision(rows_for(3, amounts=[1, 2, 3]))
        first = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])
        ref = first["result_set"]["ref"]
        columns = list(COLUMNS) + [{"header": "备注", "promoted": True, "field": "note", "type": "text"}]
        extend_promoted_records(object_id=result["object_id"], application_id=result["application_id"],
                                title="引用试点", columns=columns, rows=[], records={},
                                access=TABLE_ACCESS,
                                idempotency_key=self.key + "-extend")
        with self.assertRaises(frappe.ValidationError) as caught:
            self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}])
        self.assertIn("重新查询", str(caught.exception), "定义升版要明确要求重新查询")

    # ⑥ 权限被撤 ⇒ 引用作废（权限错误，不给旧结果）
    def test_permission_revocation_invalidates_reference(self):
        from shangshu_core.business_access import OPEN_BUSINESS_ACCESS
        result = self._provision(rows_for(4, amounts=[1, 2, 3, 4]))
        email = self._staff_user()
        enterprise = frappe.get_value(model_records.MODEL, result["object_id"], "enterprise_id")
        identity = frappe.get_doc("Shangshu Identity", frappe.db.get_value(
            "Shangshu Identity", {"user": email}, "name"))
        if identity.enterprise_id != enterprise:
            frappe.db.set_value("Shangshu Identity", identity.name, "enterprise_id", enterprise)
        frappe.set_user(email)
        ref = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])["result_set"]["ref"]
        if OPEN_BUSINESS_ACCESS:
            # ⚠️ **试用期业务资格全开**（2026-10-27 用户口径 · 业务权限全部开放）：
            #   **摘掉角色不再撤业务权** ⇒ 撤权要走**仍然保留**的那道闸 ——
            #   **身份停用**（登录／平台身份／企业边界这三条不变）。
            frappe.db.set_value("Shangshu Identity", identity.name, "status", "Disabled",
                                update_modified=False)
            frappe.db.commit()
            frappe.set_user(email)
        else:
            # 开关关闭 ⇒ 回到**声明权限**：把员工的角色摘掉（他再也读不到这个对象）
            user = frappe.get_doc("User", email)
            user.roles = []
            user.save(ignore_permissions=True)
            frappe.db.commit()
            frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError) as caught:
            self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}])
        message = str(caught.exception)
        if OPEN_BUSINESS_ACCESS:
            # 开放口径下撤权先撞**身份停用**那道闸（身份/企业边界是仍保留的闸）⇒
            # 明确说清是哪道闸，**不给旧结果**。
            self.assertIn("身份已停用", message, "撤权后要明确说清是哪道闸")
        else:
            self.assertIn("重新查询", message, "撤权后要明确要求重新查询")

    # ⑦ 编号被改过 ⇒ 拒（内容对不上）
    def test_tampered_reference_is_rejected(self):
        result = self._provision(rows_for(2, amounts=[1, 2]))
        ref = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])["result_set"]["ref"]
        body, fingerprint = ref.split(".", 1)
        tampered = body + "." + ("0" * len(fingerprint))
        with self.assertRaises(frappe.ValidationError) as caught:
            self._aggregate(None, result_set=tampered, metrics=[{"op": "count_rows"}])
        self.assertIn("重新查询", str(caught.exception), "被改过的编号要明确要求重新查询")

    # ⑧ 过期 ⇒ 拒（引用是会话内的短命句柄）
    def test_expired_reference_is_rejected(self):
        from shangshu_core import result_sets
        result = self._provision(rows_for(2, amounts=[1, 2]))
        ref = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])["result_set"]["ref"]
        ref_id = ref[3:].split(".", 1)[0]
        entry = frappe.cache.get_value(result_sets.CACHE_PREFIX + ref_id)
        self.assertTrue(entry, "引用要存在服务端（编号本身不是凭据）")
        entry["created_at"] = entry["created_at"] - (result_sets.REF_TTL_SECONDS + 60)
        frappe.cache.set_value(result_sets.CACHE_PREFIX + ref_id, entry,
                               expires_in_sec=result_sets.REF_TTL_SECONDS)
        with self.assertRaises(frappe.ValidationError) as caught:
            self._aggregate(None, result_set=ref, metrics=[{"op": "count_rows"}])
        self.assertIn("重新查询", str(caught.exception), "过期引用要明确要求重新查询")

    # ⑨ 引用检查口：能单独问「这个编号还准不准」
    def test_reference_status_can_be_checked_on_its_own(self):
        from shangshu_core import result_sets
        result = self._provision(rows_for(2, amounts=[1, 2]))
        ref = self._aggregate(result["object_id"], metrics=[{"op": "count_rows"}])["result_set"]["ref"]
        status = result_sets.describe(ref)
        self.assertTrue(status["valid"], "刚做的统计，引用应当有效")
        self.assertEqual(status["object_id"], result["object_id"])
        self.assertEqual(status["matched_total"], 2)
        broken = result_sets.describe("rs_broken.000000000000")
        self.assertFalse(broken["valid"], "编造的编号要报「无效」")
        self.assertIn("重新查询", broken["reason"])


if __name__ == "__main__":  # pragma: no cover
    pass
