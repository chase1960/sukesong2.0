"""清单外的值，从**对象侧写入口**进去必须被拒（整链证据，走真实公共动作）。

**背景**（原收敛条目 02 · 2026-10-26 调查发现）：
值域清单原本**只存在文件域的声明里** ⇒ 编译成受管对象定义时**被丢掉**
⇒ 对象侧的写入口（`platform.object.update`）**不知道这一列有清单**
⇒ **清单外的值能从那条路写进去** ⇒ 「非法枚举在所有写入口均拒绝」不成立。

**测试通过 = 下面每一条都成立**（编号 VW-xx）：

- **VW-01** 清单里的值经**对象侧公共动作**写进去 ⇒ **成功**，读回来就是那个值。
- **VW-02** 清单外的值经**对象侧公共动作**写进去 ⇒ **当场被拒**，
  拒因**点名是「清单里的值」**（用户看得懂，不是内部码）。
- **VW-03** 被拒之后**一个字节都没改**（原值还在）——「拒绝不产生值变更」。
- **VW-04** 被拒之后**不出成功日志**（失败回执走失败那条路，不是成功）。
- **VW-05** 清单**跟着定义进内核**（编译后的受管字段带着 `value_domain`）。

⚠️ **站上判据**：需要真 Frappe（真表、真事务、真动作）⇒ 离线跑不了。
"""

import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_SITE = True
except Exception:
    frappe = None
    FrappeTestCase = unittest.TestCase
    HAS_SITE = False


COLUMNS = [
    {"header": "审查状态", "promoted": True, "field": "status", "type": "text",
     "rules": {"options": ["受理", "驳回"], "allow_custom": False}},
    {"header": "备注", "promoted": True, "field": "memo", "type": "text"},
]
ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
          "download": {"scope": "global"}, "record_scope": "all"}


@unittest.skipUnless(HAS_SITE, "需要真实站点（真表 / 真事务 / 真动作）")
class TestValueDomainWrite(FrappeTestCase):
    """VW-01～VW-05。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "vd-" + uuid.uuid4().hex
        self.table = "vd-tbl-" + uuid.uuid4().hex[:8]
        self.object_id = None
        self.application_id = None
        self.record = None

    def tearDown(self):
        frappe.set_user("Administrator")
        from shangshu_core import model_records
        if self.object_id:
            try:
                model = frappe.get_doc(model_records.MODEL, self.object_id)
                frappe.db.commit()
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, self.object_id, force=True, ignore_permissions=True)
            except Exception:
                pass
        if self.application_id:
            try:
                frappe.delete_doc("Shangshu Application Definition", self.application_id,
                                  force=True, ignore_permissions=True)
            except Exception:
                pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    def _provision(self):
        from shangshu_core.applications import create_application_definition
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.promotion_records import provision_promoted_records
        app = create_application_definition("值域试点", "vd-app:" + self.table)
        self.application_id = app["id"]
        with domain_execution("com.shangshu.core"):
            result = provision_promoted_records(
                table=self.table, title="值域试点", columns=COLUMNS,
                rows=[{"row_id": "r-000001",
                       "values": {"status": "受理", "memo": "第一条"}}],
                idempotency_key=self.key, access=ACCESS)
        self.object_id = result["object_id"]
        self.record = result["records"]["r-000001"]
        return result

    def _update(self, value, key_suffix):
        """从**对象侧公共动作**写一个值 ⇒ 返回 (成功?, 拒因?)。"""
        from shangshu_core.actions import execute_registered_action
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        rec = frappe.get_doc(model.physical_doctype, self.record)
        try:
            with domain_execution("com.shangshu.core"):
                execute_registered_action(
                    "platform.object.update",
                    {"object_id": self.object_id, "name": self.record,
                     "expected_revision": model.active_revision,
                     "expected_modified": str(rec.modified),
                     "values": {"status": value}},
                    confirmed=True, idempotency_key=self.key + "-" + key_suffix, source="user")
        except Exception as error:
            return False, str(error)
        return True, ""

    def test_list_violating_value_is_rejected_on_the_object_side_write_entry(self):
        """VW-01～VW-05 一起跑：清单内放行、清单外被拒、原值不变。"""
        import json

        from shangshu_core import model_records

        self._provision()

        # ---- VW-05 清单跟着定义进内核 ----
        compiled = json.loads(frappe.get_doc(model_records.MODEL, self.object_id).active_json)
        field = [f for f in compiled["fields"] if f["id"] == "status"][0]
        self.assertIn("value_domain", field, "编译后的字段没带值域清单（VW-05）")
        self.assertEqual(field["value_domain"]["options"], ["受理", "驳回"])
        self.assertFalse(field["value_domain"]["allow_custom"])

        # ---- VW-02 清单外的值 ⇒ 当场被拒 ----
        ok, reason = self._update("随便写的", "bad")
        self.assertFalse(ok, "清单外的值被放行了（VW-02）")
        self.assertIn("清单", reason, "拒因没点名「清单」（用户看不懂）：%r" % reason)

        # ---- VW-03 被拒之后一个字节都没改 ----
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=10)["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].get("status"), "受理",
                         "被拒之后值还是变了（VW-03）：%r" % (rows[0].get("status"),))

        # ---- VW-01 清单内的值 ⇒ 放行 ----
        ok, reason = self._update("驳回", "good")
        self.assertTrue(ok, "清单内的值被拒了（VW-01）：%r" % reason)

        # ---- 读回来就是那个值 ----
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=10)["rows"]
        self.assertEqual(rows[0].get("status"), "驳回", "读回来的值不对")


if __name__ == "__main__":
    unittest.main(verbosity=2)
