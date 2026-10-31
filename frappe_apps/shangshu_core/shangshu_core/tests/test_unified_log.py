"""PKG-020-T01：统一日志库 —— 四类痕迹合成一种行 ＋ 域专属字段按域分表且可解耦。

**测试通过 = 什么成立**（一句话）：

「**四类平台操作痕迹（动作执行审计／事件信封／AI 执行审计／域变更审计）各在统一日志表
里留下一行，九个通用字段齐全且形状对、日志编号唯一、日志写下就改不动；
按受管记录能取到这行日志；域专属字段按 log_no 接到主行上、换个域读不到别域的字段；
域被拔掉后它那张扩展表连同字段一起消失，而主日志表与别域的行不受影响；
既有的查询口（query_action_audits 等）读出来的形状没变。**」

为什么要有这张表（用户 2026-10-22 12:18/13:44 原话）：
- 「**统回一个数据库去记录**……后续要在数据库里加字段啥的，**也在这里加**」
  ⇒ 四张各说各话的日志表合成一张主表（九个通用字段）。
- 「**假设 host 被拔掉了，这个字段也随之拔掉**」
  ⇒ 域专属字段按域分表存（每行带主表的 log_no），域没了那张表就没了。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_unified_log --skip-test-records
"""
import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import unified_log
from shangshu_core.unified_log import LOG_DOCTYPE

#: 九个通用字段（契约 `common_fields.required`）。
COMMON_FIELDS = ("log_no", "occurred_at", "actor_user", "trigger_source", "domain_id",
                 "what_kind", "what_id", "result", "business_object_id", "business_name",
                 "detail_json")
#: 每一行都得有值的那些（业务对象两列在「这次操作没碰受管记录」时留空 —— 不硬凑）。
ALWAYS_FILLED = ("log_no", "occurred_at", "actor_user", "trigger_source", "domain_id",
                 "what_kind", "what_id", "result", "detail_json")
#: 四张旧表（保留结构与历史行；不再新增）。
OLD_TABLES = ("Shangshu Action Execution Audit", "Shangshu AI Execution Audit",
              "Shangshu Domain Change Audit")

ACTION_DOMAINS = ("com.shangshu.core", "com.shangshu.test.log")


class TestUnifiedLog(FrappeTestCase):
    domain = "com.shangshu.test.log"
    other_domain = "com.shangshu.test.log.other"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        frappe.set_user("Administrator")
        # 域变更审计要一个**真域**（域未注册 ⇒ 停用不了）⇒ 这里登记两个判据专用域。
        for domain in (cls.domain, cls.other_domain):
            if not frappe.db.exists("Shangshu Domain", domain):
                frappe.get_doc({
                    "doctype": "Shangshu Domain", "domain_id": domain,
                    "display_name": "统一日志判据域", "owner_app": "shangshu_core",
                    "domain_version": "1.0.0", "enabled": 1, "execution_stopped": 0,
                    "contribution_json": "{}"}).insert(ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        # **判据自己造的东西要收干净**（不然会给同站点的别的判据留残留）：
        # 扩展表、判据专用域、判据建的流程。
        for domain in (cls.domain, cls.other_domain):
            try:
                unified_log.remove_domain_extension(domain)
            except Exception:
                pass
            try:
                if frappe.db.exists("Shangshu Domain", domain):
                    frappe.db.delete("Shangshu Domain", {"domain_id": domain})
            except Exception:
                pass
        # 不可变记录的删除要走「受控维护」开关（内核既有机制：database.py）。
        frappe.db.sql("SET @shangshu_immutable_maintenance = 1")
        for definition in frappe.get_all("Shangshu Process Definition",
                                        filters={"definition_id": ["like", "com.shangshu.test.unifiedlog%"]},
                                        pluck="name"):
            for instance in frappe.get_all("Shangshu Process Instance",
                                           filters={"definition_id": definition}, pluck="name"):
                frappe.db.delete("Shangshu Process Subscription", {"process_instance": instance})
                frappe.db.delete("Shangshu Node Execution", {"process_instance": instance})
                frappe.db.delete("Shangshu Process Instance", {"name": instance})
            frappe.db.delete("Shangshu Process Definition Version", {"definition": definition})
            frappe.db.delete("Shangshu Process Definition", {"name": definition})
        frappe.db.commit()
        frappe.db.sql("SET @shangshu_immutable_maintenance = 0")
        frappe.set_user("Administrator")
        super().tearDownClass()

    def setUp(self):
        frappe.set_user("Administrator")
        from shangshu_core.identity import ensure_identity_for_user

        self.identity = ensure_identity_for_user("Administrator")  # 身份名（字符串）

    def tearDown(self):
        frappe.set_user("Administrator")
        super().tearDown()

    # ---------- ① 四类痕迹各写一行 ----------

    def _action_row(self):
        """走公共动作执行入口（动作执行审计那一路）。"""
        from shangshu_core.public_api import create_application_definition, execute_registered_action

        app = create_application_definition("统一日志判据", "log-" + frappe.generate_hash(length=20))
        result = execute_registered_action("platform.application.inspect", {"application_id": app["id"]})
        return result["audit"]

    def _event_row(self):
        """走事件发布（事件信封那一路）。"""
        from shangshu_core.events import publish_event

        key = "unified-log-event-" + uuid.uuid4().hex
        publish_event("platform.contract.checked", {"source": "unified-log-test"}, key)
        rows = frappe.get_all(LOG_DOCTYPE, filters={"what_kind": "event", "idempotency_key": key},
                              fields=["name"], limit=1)
        self.assertTrue(rows, "事件发布没有在统一日志表留下行")
        return rows[0]["name"]

    def _tool_row(self):
        """走 AI 工具选择（AI 执行审计那一路）。"""
        from shangshu_core.runtime import (begin_node_execution, complete_node_execution,
                                          publish_definition, start_process)

        suffix = frappe.generate_hash(length=8).lower()
        definition_id = f"com.shangshu.test.unifiedlog.{suffix}"
        node = f"{definition_id}.start"
        graph = {"nodes": [{"id": node, "type": "ai_select", "start": True, "terminal": True,
                            "candidates": ["document.ocr_extract", "document.vision_extract"]}],
                 "edges": []}
        doc = frappe.get_doc({
            "doctype": "Shangshu Process Definition", "definition_id": definition_id,
            "title": "统一日志判据流程", "namespace": "com.shangshu.test",
            "business_object": "test.object", "enterprise_id": "default", "status": "Draft",
            "draft_revision": 1, "graph_json": json.dumps(graph)}).insert(ignore_permissions=True)
        publish_definition(definition_id)
        instance = start_process(definition_id)
        opened = begin_node_execution(instance.name, node)
        complete_node_execution(opened["execution"], opened["token"],
                                selected_tool="document.ocr_extract",
                                output_data={"ok": True}, reason="统一日志判据")
        rows = frappe.get_all(LOG_DOCTYPE, filters={"what_kind": "tool"},
                              fields=["name"], order_by="creation desc", limit=1)
        self.assertTrue(rows, "AI 工具选择没有在统一日志表留下行")
        return rows[0]["name"]

    def _domain_row(self):
        """走域启停（域变更审计那一路）。"""
        from shangshu_core.domains import set_domain_enabled

        set_domain_enabled(self.domain, 0, "统一日志判据：停用")
        try:
            rows = frappe.get_all(LOG_DOCTYPE,
                                  filters={"what_kind": "domain_change", "domain_id": self.domain},
                                  fields=["name"], order_by="creation desc", limit=1)
            self.assertTrue(rows, "域启停没有在统一日志表留下行")
            return rows[0]["name"]
        finally:
            set_domain_enabled(self.domain, 1, "统一日志判据：恢复")

    def test_four_kinds_of_traces_each_write_one_unified_row(self):
        """① 四类平台操作痕迹各写一行，且通用字段形状对。"""
        rows = {
            "action": self._action_row(),
            "event": self._event_row(),
            "tool": self._tool_row(),
            "domain_change": self._domain_row(),
        }
        for kind, name in rows.items():
            row = frappe.get_doc(LOG_DOCTYPE, name)
            for field in ALWAYS_FILLED:
                self.assertTrue(row.get(field) not in (None, ""), f"{kind} 那一行缺通用字段 {field}")
            for field in ("business_object_id", "business_name"):
                self.assertIsNotNone(row.get(field), f"{kind} 那一行缺通用字段 {field}")
            self.assertEqual(row.what_kind, kind)
            self.assertIn(row.result, ("Succeeded", "Failed", "Delivering", "Rejected", "Unknown"))
            self.assertIn(row.trigger_source, ("user", "agent", "scheduled", "system", "unknown"))
            self.assertTrue(str(row.occurred_at), "发生时间没落")
            self.assertTrue(json.loads(row.detail_json or "{}") is not None)

    # ---------- ② 九个通用字段齐全 ＋ ③ 编号唯一 ----------

    def test_log_no_is_unique_and_common_fields_have_the_contract_shape(self):
        """②③ 通用字段形状对、日志编号唯一。"""
        first = unified_log.write_log(kind="action", what_id="log.test.first", result="Succeeded",
                                      domain_id=self.domain, actor_user="Administrator",
                                      actor_identity=self.identity, detail={"n": 1})
        second = unified_log.write_log(kind="action", what_id="log.test.second", result="Failed",
                                       domain_id=self.domain, actor_user="Administrator",
                                       actor_identity=self.identity, detail={"n": 2})
        self.assertNotEqual(first.log_no, second.log_no, "日志编号必须唯一")
        self.assertTrue(first.log_no.startswith("LOG-"), f"日志编号形状不对：{first.log_no}")
        row = frappe.get_doc(LOG_DOCTYPE, first.name)
        self.assertEqual(row.what_id, "log.test.first")
        self.assertEqual(row.result, "Succeeded")
        self.assertEqual(row.domain_id, self.domain)
        self.assertEqual(json.loads(row.detail_json)["n"], 1)

    # ---------- ④ 写下就锁住 ----------

    def test_a_written_log_cannot_be_modified(self):
        """④ 日志写下就改不动。"""
        row = unified_log.write_log(kind="action", what_id="log.test.locked", result="Succeeded",
                                    domain_id=self.domain, actor_user="Administrator",
                                    actor_identity=self.identity, detail={"v": 1})
        doc = frappe.get_doc(LOG_DOCTYPE, row.name)
        doc.detail_json = json.dumps({"v": 2})
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    # ---------- ⑤ 不复制受管记录的正式值，但前后值要留 ----------

    def test_log_keeps_before_and_after_but_not_the_records_current_values(self):
        """⑤ 受管记录的当前值不进日志；改了哪些字段的前后值要留。"""
        from shangshu_core.promotion_records import provision_promoted_records

        columns = [{"header": "客户名", "promoted": True, "field": "customer", "type": "text", "rules": {}},
                    {"header": "备注", "promoted": True, "field": "note", "type": "text", "rules": {}}]
        table = "unified-log-" + uuid.uuid4().hex[:8]
        result = provision_promoted_records(table=table, title="统一日志判据",
                                            columns=columns,
                                            rows=[{"row_id": "r-001",
                                                   "values": {"customer": "甲公司", "note": "不该进日志的当前值"}}],
                                            access={"read": {"scope": "global"},
                                                    "write": {"scope": "global"},
                                                    "download": {"scope": "global"},
                                                    "record_scope": "all"},
                                            idempotency_key="unified-log-" + uuid.uuid4().hex)
        self.addCleanup(self._drop_promoted, result)

        from shangshu_core.public_api import execute_registered_action

        physical = frappe.db.get_value("Shangshu Object Model", result["object_id"], "physical_doctype")
        before = str(frappe.db.get_value(physical, result["records"]["r-001"], "modified"))
        execute_registered_action("platform.object.update", {
            "object_id": result["object_id"], "name": result["records"]["r-001"],
            "expected_modified": before,
            "expected_revision": frappe.db.get_value("Shangshu Object Model", result["object_id"], "active_revision"),
            "values": {"customer": "乙公司"}}, confirmed=True, idempotency_key="unified-log-upd-" + uuid.uuid4().hex)

        rows = frappe.get_all(LOG_DOCTYPE, filters={"what_kind": "action", "what_id": "platform.object.update"},
                              fields=["name", "detail_json", "business_object_id", "business_name"],
                              order_by="creation desc", limit=1)
        self.assertTrue(rows, "受管记录变更没有在统一日志表留下行")
        detail = json.loads(rows[0]["detail_json"])
        changes = detail["record_changes"]["changes"]
        changed = {c["field"]: c for c in changes}
        self.assertIn("customer", changed, "改了哪个字段必须留下")
        self.assertEqual(changed["customer"]["before"], "甲公司")
        self.assertEqual(changed["customer"]["after"], "乙公司")
        self.assertNotIn("不该进日志的当前值", rows[0]["detail_json"],
                         "日志不得复制受管记录的当前值（未改字段的原值）")
        self.assertEqual(rows[0]["business_name"], result["records"]["r-001"])

    def _drop_promoted(self, result):
        try:
            frappe.db.sql("DROP TABLE IF EXISTS `%s`" % frappe.db.get_value(
                "Shangshu Object Model", result["object_id"], "physical_doctype"))
        except Exception:
            pass

    # ---------- ⑦ 域专属字段按 log_no 关联，换域不串味 ----------

    def test_domain_extension_fields_attach_by_log_no_and_do_not_leak_across_domains(self):
        """⑦ 域专属字段按 log_no 接到主行上；别域的行读不到别域的字段。"""
        unified_log.declare_extension_fields(self.domain, [
            {"name": "job", "label": "同步作业", "type": "Data"},
            {"name": "outcome", "label": "作业结果", "type": "Data"}])
        unified_log.declare_extension_fields(self.other_domain, [
            {"name": "batch", "label": "导入批次", "type": "Data"}])

        own = unified_log.write_log(kind="process", what_id="host.sync.job", result="Succeeded",
                                    domain_id=self.domain, actor_user="Administrator",
                                    actor_identity=self.identity, detail={"job": "job-1"},
                                    extension_values={"job": "job-1", "outcome": "已送达"})
        other = unified_log.write_log(kind="process", what_id="example.review", result="Succeeded",
                                      domain_id=self.other_domain, actor_user="Administrator",
                                      actor_identity=self.identity, detail={"batch": "B-9"},
                                      extension_values={"batch": "B-9"})

        own_read = unified_log.read_log(own.name)
        self.assertEqual(own_read["extension"].get("job"), "job-1")
        self.assertEqual(own_read["extension"].get("outcome"), "已送达")
        self.assertNotIn("batch", own_read["extension"], "别域的专属字段不得串到本域的行上")

        other_read = unified_log.read_log(other.name)
        self.assertEqual(other_read["extension"].get("batch"), "B-9")
        self.assertNotIn("job", other_read["extension"], "本域的专属字段不得串到别域的行上")

    # ---------- ⑧ 域被拔掉 ⇒ 扩展表与字段一起消失，别域与主表不受影响 ----------

    def test_removing_a_domain_drops_its_extension_table_only(self):
        """⑧ 域被拔掉 ⇒ 它的扩展字段随之消失（表也没了）；主表与别域不受影响。"""
        unified_log.declare_extension_fields(self.domain, [
            {"name": "job", "label": "同步作业", "type": "Data"}])
        unified_log.declare_extension_fields(self.other_domain, [
            {"name": "batch", "label": "导入批次", "type": "Data"}])
        own = unified_log.write_log(kind="process", what_id="host.sync.job", result="Succeeded",
                                    domain_id=self.domain, actor_user="Administrator",
                                    actor_identity=self.identity, detail={},
                                    extension_values={"job": "job-2"})
        other = unified_log.write_log(kind="process", what_id="example.review", result="Succeeded",
                                      domain_id=self.other_domain, actor_user="Administrator",
                                      actor_identity=self.identity, detail={},
                                      extension_values={"batch": "B-10"})
        self.assertTrue(unified_log.extension_table_exists(self.domain))

        unified_log.remove_domain_extension(self.domain)

        self.assertFalse(unified_log.extension_table_exists(self.domain),
                         "域被拔掉后它那张扩展表必须消失")
        self.assertIsNone(unified_log.read_extension(own.name),
                          "域被拔掉后该域的专属字段必须读不到")
        # 主日志行还在，九个通用字段照旧。
        row = frappe.get_doc(LOG_DOCTYPE, own.name)
        for field in ALWAYS_FILLED:
            self.assertTrue(row.get(field) not in (None, ""), f"主日志行不该受域拔掉影响：{field}")
        # 别域不受影响。
        self.assertTrue(unified_log.extension_table_exists(self.other_domain))
        self.assertEqual(unified_log.read_extension(other.name).get("batch"), "B-10")

    # ---------- ⑥ 既有查询口形状没变 ----------

    def test_existing_query_ports_still_return_the_same_shape(self):
        """⑥ 既有的动作审计查询口读出来还是老形状（新行从统一表来）。"""
        from shangshu_core import receipts

        audit = self._action_row()
        result = receipts.query_action_audits(page_length=50)
        self.assertIn("items", result)
        self.assertIn("total", result)
        item = next((row for row in result["items"] if row.get("audit") == audit), None)
        self.assertIsNotNone(item, "统一表里的新审计行必须能从既有查询口读到")
        for key in ("audit", "action_id", "actor", "source", "time", "status", "record_changes"):
            self.assertIn(key, item, f"既有查询口的返回形状变了：少了 {key}")
        self.assertEqual(item["action_id"], "platform.application.inspect")
        self.assertEqual(item["status"], "Succeeded")
        self.assertTrue(item["actor"]["user"])


    # ---------- ⑨ 旧表不再新增；旧表的历史行仍查得到 ----------

    def test_old_log_tables_stop_receiving_new_rows(self):
        """⑨ 旧表保留表结构与历史行，但**不再新增**（统一日志是唯一的新写入处）。"""
        before = {table: frappe.db.count(table) for table in OLD_TABLES}
        self._action_row()
        self._tool_row()
        self._domain_row()
        after = {table: frappe.db.count(table) for table in OLD_TABLES}
        for table in OLD_TABLES:
            self.assertEqual(after[table], before[table], f"{table} 不该再新增行")

    def test_old_table_history_is_still_readable_through_the_same_port(self):
        """⑨ 旧表的历史行由读口合并进来（仍查得到，形状不变）。"""
        from shangshu_core import receipts

        key = "unified-log-legacy-" + uuid.uuid4().hex
        frappe.get_doc({
            "doctype": "Shangshu Action Execution Audit", "action_id": "legacy.action.demo",
            "action_version": "1.0.0", "actor_identity": self.identity,
            "actor_user": "Administrator", "executor_source": "user",
            "reference_doctype": "", "reference_name": "",
            "input_summary_json": "{}", "result_summary_json": "{}", "confirmed": 0,
            "confirmation_text": "", "idempotency_key": key, "status": "Succeeded",
            "duration_ms": 1}).insert(ignore_permissions=True)
        result = receipts.query_action_audits(filters={"idempotency_key": key})
        self.assertTrue(result["items"], "旧表的历史行必须仍能从既有查询口查到")
        item = result["items"][0]
        self.assertEqual(item["action_id"], "legacy.action.demo")
        self.assertEqual(item["status"], "Succeeded")
