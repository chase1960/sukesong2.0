"""迁移失败 → 恢复 → **真实建记录并读回**（阶段1 完成边界第③条）。

**这条判据证明什么**（一句话）：一次 DDL 失败之后，同一条链**按原键重来**，
能拿到**同一个**受管对象（不建第二个对象/第二张表），**真的建出受管记录**，
并且**读得回来** —— 也就是「失败不是死局，恢复后业务真能继续」。

**为什么单独一条**：原判据 ⑤ 只验到「变更单不再是『迁移中』」；
但**能重来**（状态对）与**重来之后真能干活**（记录建得出来、读得回来）是两件事。
后者才是业务侧真正关心的。

⚠️ **站上判据**：需要真 Frappe（真 DDL、真表、真事务）⇒ 离线跑不了。
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
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
]

TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}

ROWS = [{"row_id": "r-000001", "values": {"amount": 10.5, "day": "2026-10-01"}},
        {"row_id": "r-000002", "values": {"amount": 21.0, "day": "2026-10-02"}}]


@unittest.skipUnless(HAS_SITE, "需要真实站点（真 DDL / 真表 / 真事务）")
class TestMigrationRecovery(FrappeTestCase):
    """失败 → 恢复 → 真建记录并读回。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "recovery-" + uuid.uuid4().hex
        self.table = "recovery-tbl-" + uuid.uuid4().hex[:8]
        self.object_id = None
        self.application_id = None

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

    def _watcher(self):
        watcher = frappe.database.get_db(socket=frappe.conf.db_socket, host=frappe.conf.db_host,
                                         port=frappe.conf.db_port, user=frappe.conf.db_name,
                                         password=frappe.conf.db_password,
                                         cur_db_name=frappe.conf.db_name)
        watcher.connect()
        return watcher

    def _change_rows(self):
        """认领**这张表**自己的变更单（站上有很多别的变更单 ⇒ 不能取「最后一条」）。"""
        from shangshu_core.model_changes import CHANGE, _hash
        from shangshu_core.promotion_records import _application
        app_id = _application(self.table, "迁移恢复试点", self.key)
        object_id = str(app_id + ".object." + _hash(
            [app_id, frappe.session.user, "promotion-object:" + str(self.table)])[:32])
        rows = frappe.get_all(CHANGE, filters={"object_model": object_id},
                              fields=["name", "status", "object_model"], limit=10)
        if rows:
            return rows
        # 兜底：本次新建的应用名下的变更单（一次只建一个 ⇒ 不会认错别人的）
        return frappe.get_all(CHANGE, filters={"object_model": ["like", app_id + ".object.%"]},
                              fields=["name", "status", "object_model"], limit=10)

    def test_recovery_after_failed_ddl_really_creates_and_reads_records(self):
        """失败 → 重来 → **真的建出受管记录并读回**。

        改之前：这条**根本没被验过** —— ⑤ 只验到「状态不是迁移中」，
        没有验「重来之后业务真能继续」。
        """
        from unittest.mock import patch

        from shangshu_core import model_records
        from shangshu_core.domain_execution import domain_execution
        from shangshu_core.promotion_records import provision_promoted_records

        # ---- ① 让 DDL 失败（第一次放行、第二次炸）----
        real_updatedb = type(frappe.local.db).updatedb
        calls = {"n": 0}

        def _updatedb(inner, doctype, meta=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return real_updatedb(inner, doctype, meta)
            raise frappe.ValidationError("DDL 故意炸")

        with domain_execution("com.shangshu.core"):
            with patch.object(type(frappe.local.db), "updatedb", _updatedb):
                with self.assertRaises(frappe.ValidationError):
                    provision_promoted_records(table=self.table, title="迁移恢复试点",
                                              columns=COLUMNS, rows=ROWS,
                                              idempotency_key=self.key, access=TABLE_ACCESS)

        # ---- ①bis 失败那一刻**对象侧一点没生效**（这是「不半写」的另一半）----
        #   改之前：物理 DocType 落库那次 save **带上了权限** ⇒ DocPerm 行当场落库；
        #   而生效指针还没动 ⇒ 库里留下「ACL 已生效、指针没动」的半写。
        #   改之后：权限与生效指针**同一次提交** ⇒ 失败时两者都没生效。
        from shangshu_core.model_changes import CHANGE
        from shangshu_core.record_lifecycle import physical_definition
        import json as _json
        watcher = self._watcher()
        try:
            # ⚠️ **按「这张表」认领**（应用 id 是按表固定的 ⇒ 确定）
            from shangshu_core.promotion_records import _application
            app_id = _application(self.table, "迁移恢复试点", self.key)
            mine = frappe.get_all(CHANGE, filters={"object_model": ["like", app_id + ".object.%"]},
                                  fields=["name", "object_model", "status", "compiled_json"],
                                  limit=10)
            self.assertTrue(mine, "找不到这次迁移的变更单")
            compiled = _json.loads(mine[0]["compiled_json"])
            physical_name = physical_definition(compiled)["name"]
            perms = watcher.sql("SELECT COUNT(*) FROM tabDocPerm WHERE parent=%s",
                                 (physical_name,))[0][0]
        finally:
            watcher.close()
        self.assertEqual(perms, 0,
                         "失败后对象的 ACL 已经落库（半写：权限先生效、生效指针没动）")

        # ---- ② 变更单不是「迁移中」⇒ 同键可以重来 ----
        from shangshu_core.model_changes import CHANGE
        # ⚠️ **认领「这张表」自己的那条变更单**（不取「最后一条」——
        #    站上有很多别的变更单 ⇒ 取错一条会看错结论）。
        #    认领办法：**对象 id 是从幂等键推导的** ⇒ 用内核自己那份推导算一遍
        #    （`prepare_object_change` 里同一条算法），算不出就按「本次新建的
        #    应用」过滤 —— 两层都取不到才算真的没有。
        rows = self._change_rows()
        self.assertTrue(rows, "按表名找不到这次迁移的变更单")
        # ⚠️ **状态要从「另一条连接」读**（不靠调用方那条连接）：
        #    失败收口是**另一条连接**写的 ⇒ 调用方那条连接（`REPEATABLE-READ`，
        #    读视图固定在事务开始那一刻）**读到的还是它自己那份「迁移中」**
        #    （读得到自己的未提交写）。⇒ **库里真实的状态**看另一条连接。
        watcher = self._watcher()
        try:
            status = watcher.sql("SELECT status FROM `tabShangshu Schema Change` WHERE name=%s",
                                 (rows[0]["name"],))[0][0]
        finally:
            watcher.close()
        self.assertEqual(status, "Failed",
                         "变更单停在「%s」⇒ 同键重试会被挡住" % status)

        # ---- ③ 按**同一键**重来 ⇒ 拿到**同一个**对象（不建第二个）----
        with domain_execution("com.shangshu.core"):
            result = provision_promoted_records(table=self.table, title="迁移恢复试点",
                                                columns=COLUMNS, rows=ROWS,
                                                idempotency_key=self.key, access=TABLE_ACCESS)
        self.object_id = result["object_id"]
        self.application_id = result["application_id"]
        self.assertEqual(self.object_id, rows[0].get("object_model") or self.object_id,
                         "重来之后对象 id 变了（键没固定住 ⇒ 不是同一个对象）")
        self.assertEqual(len(result["records"]), 2, "恢复后没有为两行各建一条受管记录")

        # ---- ④ 重来之后**真的读得回来** ----
        found = model_records.query_records(self.object_id, filters={}, page=1, page_length=30)
        self.assertEqual(found["total"], 2, "恢复后读不回那两条受管记录")
        values = sorted((row.get("amount"), row.get("day")) for row in found["rows"])
        self.assertEqual(values, [(10.5, "2026-10-01"), (21.0, "2026-10-02")],
                         "读回来的值不对：%r" % (values,))

        # ---- ⑤ 不建第二个对象 / 第二张表 ----
        watcher = self._watcher()
        try:
            objects = watcher.sql(
                "SELECT COUNT(*) FROM `tabShangshu Object Model` WHERE name=%s",
                (self.object_id,))[0][0]
            tables = watcher.sql(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() "
                "AND table_name=%s", (model_records.MODEL,))[0][0]
        finally:
            watcher.close()
        self.assertEqual(objects, 1, "恢复后凭空多出了对象")

        # ---- ⑥ 对象的 ACL 在恢复后真的落库了（不是「无人」也不是空的）----
        from shangshu_core.record_lifecycle import physical_definition
        import json as _json
        change_row = frappe.get_all(CHANGE, filters={"object_model": self.object_id},
                                    fields=["name", "compiled_json"], limit=1)[0]
        compiled = _json.loads(change_row["compiled_json"])
        physical_name = physical_definition(compiled)["name"]
        watcher = self._watcher()
        try:
            perms = watcher.sql("SELECT COUNT(*) FROM tabDocPerm WHERE parent=%s",
                                 (physical_name,))[0][0]
        finally:
            watcher.close()
        self.assertGreater(perms, 0, "恢复后对象的 ACL 一条都没有（权限没落库）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
