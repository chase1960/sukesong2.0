"""内核：**退役受管对象 / 应用**（2026-10-22 收进内核的公共口）。

**为什么要有这个口**（用户 2026-10-22 原话）：
「**没有『退役受管对象/应用』的口 ⇒ 昨晚清 91 个残留只能直接删内核表——今晚最脏的一处。**」

也就是说：清理残留这件事**只能靠脚本直接改内核表**（`DELETE FROM tabShangshu Object Model`、
`DROP TABLE`）——**绕过内核的一切规矩**（引用检查、权限、应用绑定、审计）。
这个口把这些规矩**收进内核**：谁来退役、为什么退役、被谁引用着、退役后还剩什么，
**由内核判定并留下记录**，而不是脚本自己决定删哪张表。

**测试通过 = 什么成立**（一句话）：
「① 受管对象能**退役**（退役后它不再可用、物理表被清掉、绑定被解），
 ② **被别人引用着**的对象**退役不了**（当场说清被谁引用，不硬删），
 ③ 应用能**退役**（退役后它不再出现在可用清单里，绑定的资源一起下线），
 ④ 每一次退役都**留下记录**（谁、何时、为什么），
 ⑤ **整域退役**那道「排空后的维护窗口」前置条件，由判据**自己声明**
   （**不改那道闸**，闸自己另有尺子守着）。」

⚠️ **为什么 ③ 要自己声明窗口**（2026-10-30）：
   「整域退役」会**逐对象 DROP 物理表**（DDL 会隐式提交）⇒ 内核要求
   **在排空后的维护窗口执行**（`write_zone_schema.require_maintenance_window`）。
   那道闸是 **2026-10-30** 才加的，**比这条判据（2026-10-22）晚 8 天**
   ⇒ 判据**没跟上** ⇒ 现在直接调就撞闸 ⇒ 红。
   ⇒ 这里**判据自己把窗口条件满足掉**（进程内、开完还原）
   ⇒ **被验的退役语义一个字没变**
   （应用名下那个对象**仍然会出现在 `retired_objects` 里**、应用**仍然从可用清单里消失**）。
   ⚠️ **那道闸一个字没动** —— 没有窗口时它照旧拒（由
   `scripts/tests/test_write_zone_entrypoints.py` 的 `RetirementFenceTests` 守着）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_retire_objects --skip-test-records
"""
import uuid
from contextlib import contextmanager

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records

COLUMNS = [
    {"header": "业务编号", "promoted": True, "field": "code", "type": "text", "rules": {}},
]


@contextmanager
def _maintenance_window():
    """**声明「我现在处于排空后的维护窗口」**（2026-10-30）。

    ⚠️ **只对「整域退役」那一步**：那一轮会逐对象 DROP 物理表（DDL 隐式提交）
    ⇒ 内核要求在维护窗口执行（`write_zone_schema.require_maintenance_window`）。
    ⚠️ **进程内**改 `frappe.conf.maintenance_mode`（**不写回 `site_config.json`**），
    且**必须 `try/finally` 还原**（否则这个进程后续用例都带着维护模式跑）。
    ⚠️ **不用 `frappe.flags.in_migrate`**：那会改 Frappe 的文档创建/删除语义
    （`in_migrate` 会跳过一些校验与清理）⇒ 判据不该开那个。
    """
    previous = frappe.conf.maintenance_mode
    frappe.conf.maintenance_mode = True
    try:
        yield
    finally:
        frappe.conf.maintenance_mode = previous


class TestRetireObjects(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        from shangshu_core.identity import ensure_identity_for_user

        self.identity = ensure_identity_for_user("Administrator")
        self.key = "retire-" + uuid.uuid4().hex
        self.table = "retire-table-" + uuid.uuid4().hex[:8]
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

    def _provision(self):
        result = provision_promoted_records(
            table=self.table, title="退役试点", columns=COLUMNS,
            rows=[{"row_id": "r-001", "values": {"code": "RET-001"}}],
            access={"read": {"scope": "global"}, "write": {"scope": "global"},
                    "download": {"scope": "global"}, "record_scope": "all"},
            idempotency_key=self.key + "-" + uuid.uuid4().hex[:8])
        self.created.append((result["object_id"], result["application_id"]))
        return result

    # ① 受管对象能退役
    def test_retire_a_managed_object_takes_it_offline(self):
        from shangshu_core.model_lifecycle import retire_managed_object

        result = self._provision()
        object_id = result["object_id"]
        model = frappe.get_doc(model_records.MODEL, object_id)
        physical = "tab" + model.physical_doctype   # Frappe 物理表名＝tab ＋ DocType 名
        self.assertTrue(frappe.db.sql("SHOW TABLES LIKE %s", (physical,)), "物理表没建起来")

        receipt = retire_managed_object(object_id, reason="清理试点残留", actor_identity=self.identity)

        self.assertEqual(receipt.get("retired"), True)
        # 退役后不再可用：清单里没有它。
        listing = model_records.list_definitions()
        self.assertNotIn(object_id, [row.get("id") for row in listing],
                         "退役后它还在可用清单里")
        # 物理表清掉了。
        self.assertFalse(frappe.db.sql("SHOW TABLES LIKE %s", (physical,)),
                         "退役后物理表还在")
        # 留下记录：谁、何时、为什么。
        self.assertEqual(receipt.get("reason"), "清理试点残留")
        self.assertEqual(receipt.get("actor_identity"), self.identity)
        self.assertTrue(receipt.get("retired_at"))

    # ② 被引用的对象退役不了
    def test_an_object_that_is_still_referenced_cannot_be_retired(self):
        """被**在用的对象**引用着 ⇒ 退役不了，当场说清被谁引用（不硬删）。"""
        from shangshu_core.model_lifecycle import retire_managed_object

        result = self._provision()
        object_id = result["object_id"]

        # 造一个**在用的**对象，它的明细字段指向被测对象。
        child_id = object_id + ".child"
        frappe.get_doc({
            "doctype": model_records.MODEL,
            "object_id": child_id,
            "application": result["application_id"],
            "enterprise_id": "default",
            "owner_identity": self.identity,
            "revision": 1,
            "active_revision": 1,
            "active_json": frappe.as_json({
                "kind": "record", "owner": result["application_id"], "title": "子表",
                "fields": [{"id": "link", "label": "指向", "type": "detail",
                            "target": object_id, "required": False}],
                "access": {"read_roles": ["System Manager"], "write_roles": ["System Manager"]},
                "doctype": {"name": "SSM retireprobechild", "fields": []},
            }),
            "physical_doctype": "SSM retireprobechild",
        }).insert(ignore_permissions=True)
        self.created.append((child_id, result["application_id"]))
        frappe.db.commit()

        with self.assertRaises(Exception) as caught:
            retire_managed_object(object_id, reason="硬删试试", actor_identity=self.identity)
        self.assertIn("引用", str(caught.exception))
        # 拒绝之后它**还在线**（没被硬删）。
        self.assertTrue(frappe.db.get_value(model_records.MODEL, object_id, "active_revision"),
                        "被引用着却还是被退役了 —— 表会变成死链")

    # ③ 应用能退役
    def test_retire_an_application_takes_its_objects_offline_too(self):
        from shangshu_core.model_lifecycle import retire_application

        result = self._provision()
        application_id = result["application_id"]
        # —— **整域退役要维护窗口**（内核 2026-10-30 加的那道闸）⇒ 判据自己声明 ——
        with _maintenance_window():
            receipt = retire_application(application_id, reason="试点应用下线",
                                        actor_identity=self.identity)
        self.assertEqual(receipt.get("retired"), True)
        self.assertIn(result["object_id"], receipt.get("retired_objects") or [])
        # 退役后应用不再出现在可用清单里。
        from shangshu_core import applications

        catalog = applications.published_application_catalog()
        self.assertNotIn(application_id, [row.get("id") for row in catalog],
                         "退役后应用还在可用清单里")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
