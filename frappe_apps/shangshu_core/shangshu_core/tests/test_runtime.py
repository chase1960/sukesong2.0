import json
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core.runtime import (
    begin_node_execution,
    complete_node_execution,
    fail_node_execution,
    list_published_processes,
    publish_definition,
    register_action,
    register_domain_process_definition,
    save_process_draft,
    simulate_process,
    start_process,
    validate_process_definition,
)


def _definition(kind="fixed"):
    suffix = frappe.generate_hash(length=8).lower()
    definition_id = f"com.shangshu.test.{kind}.{suffix}"
    start = f"{definition_id}.start"
    if kind == "ai":
        nodes = [
            {"id": start, "type": "ai_select", "start": True, "terminal": True, "candidates": ["document.ocr_extract", "document.vision_extract"]}
        ]
    else:
        nodes = [
            {"id": start, "type": "action", "start": True, "terminal": True, "action_id": "document.pdf_text_extract"}
        ]
    doc = frappe.get_doc(
        {
            "doctype": "Shangshu Process Definition",
            "definition_id": definition_id,
            "title": "运行时自动化测试",
            "namespace": "com.shangshu.test",
            "business_object": "test.object",
            "enterprise_id": "default",
            "status": "Draft",
            "draft_revision": 1,
            "graph_json": json.dumps({"nodes": nodes, "edges": []}),
        }
    ).insert(ignore_permissions=True)
    return doc


def _simulation_definition():
    suffix = frappe.generate_hash(length=8).lower()
    definition_id = f"com.shangshu.test.simulation.{suffix}"
    n = definition_id + "."
    condition = {
        "kind": "clause",
        "source": {
            "scope": "business_object",
            "object_id": "expense_claim",
            "field_path": "amount",
            "field_label": "报销金额",
            "data_type": "number",
        },
        "operator": "gte",
        "value": 5000,
        "summary": "报销金额大于等于 5000",
    }
    graph = {
        "schema_version": 2,
        "nodes": [
            {"id": n + "start", "type": "human_task", "title": "提交", "start": True},
            {"id": n + "amount", "type": "condition", "title": "判断金额"},
            {"id": n + "manager", "type": "human_task", "title": "总经理复核"},
            {"id": n + "normal", "type": "human_task", "title": "普通路径"},
            {"id": n + "end", "type": "human_task", "title": "完成", "terminal": True},
        ],
        "edges": [
            {"id": "start-amount", "source": n + "start", "target": n + "amount"},
            {"id": "amount-manager", "source": n + "amount", "target": n + "manager", "label": "金额达到 5000", "condition": condition, "priority": 10},
            {"id": "amount-normal", "source": n + "amount", "target": n + "normal", "label": "其他情况", "is_default": True, "priority": 20},
            {"id": "manager-end", "source": n + "manager", "target": n + "end"},
            {"id": "normal-end", "source": n + "normal", "target": n + "end"},
        ],
    }
    return frappe.get_doc(
        {
            "doctype": "Shangshu Process Definition",
            "definition_id": definition_id,
            "title": "条件模拟测试",
            "namespace": "com.shangshu.test",
            "business_object": "test.object",
            "enterprise_id": "default",
            "status": "Draft",
            "draft_revision": 1,
            "graph_json": json.dumps(graph),
        }
    ).insert(ignore_permissions=True)


class TestProcessRuntime(FrappeTestCase):
    def test_domain_process_registration_uses_declared_namespace_and_never_overwrites(self):
        definition_id = f"com.shangshu.ip.test.{frappe.generate_hash(length=8).lower()}"
        graph = {
            "schema_version": 2,
            "definition_id": definition_id,
            "business_object": "ip.matter",
            "nodes": [{"id": definition_id + ".start", "type": "human_task", "title": "提交", "start": True, "terminal": True}],
            "edges": [],
        }
        owner = {"id": "com.shangshu.ip", "name": "知识产权", "enabled": True}
        with patch("shangshu_core.runtime.contribution_for_resource", return_value=owner):
            first = register_domain_process_definition(definition_id, "商标申请", "ip.matter", graph)
            second = register_domain_process_definition(definition_id, "不应覆盖", "ip.matter", {**graph, "nodes": []})
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(frappe.db.get_value("Shangshu Process Definition", {"definition_id": definition_id}, "title"), "商标申请")

    def test_first_install_defers_trigger_ddl_until_migrate(self):
        from shangshu_core import install

        with patch.object(install, "ensure_immutable_triggers") as ensure_triggers:
            install.after_install()
            ensure_triggers.assert_not_called()

    def setUp(self):
        frappe.set_user("Administrator")

    def test_version_is_frozen_and_old_instance_does_not_drift(self):
        definition = _definition()
        v1 = publish_definition(definition.definition_id, 1)
        instance = start_process(definition.definition_id)

        definition = frappe.get_doc("Shangshu Process Definition", definition.name)
        graph = json.loads(definition.graph_json)
        graph["nodes"][0]["title"] = "第二版标题"
        definition.graph_json = json.dumps(graph)
        definition.draft_revision = 2
        definition.save(ignore_permissions=True)
        v2 = publish_definition(definition.definition_id, 2)

        self.assertNotEqual(v1["name"], v2["name"])
        self.assertEqual(frappe.db.get_value("Shangshu Process Instance", instance.name, "definition_version"), v1["name"])
        frozen = frappe.get_doc("Shangshu Process Definition Version", v1["name"])
        frozen.graph_json = "{}"
        with self.assertRaises(frappe.ValidationError):
            frozen.save(ignore_permissions=True)
        frappe.db.savepoint("immutable_version_trigger")
        with self.assertRaises(Exception):
            frappe.db.sql(
                "update `tabShangshu Process Definition Version` set graph_json='{}' where name=%s",
                frozen.name,
            )
        frappe.db.rollback(save_point="immutable_version_trigger")

    def test_instance_uses_action_version_pinned_at_publish_time(self):
        suffix = frappe.generate_hash(length=8).lower()
        action_id = f"test.pinned.{suffix}"
        register_action(action_id, "1.0.0", "固定动作一版", "read", "none")
        definition = _definition()
        graph = json.loads(definition.graph_json)
        graph["nodes"][0]["action_id"] = action_id
        definition.graph_json = json.dumps(graph)
        definition.save(ignore_permissions=True)
        published = publish_definition(definition.definition_id, 1)
        register_action(action_id, "2.0.0", "固定动作二版", "read", "none")

        instance = start_process(definition.definition_id)
        opened = begin_node_execution(instance.name, graph["nodes"][0]["id"])
        execution = frappe.get_doc("Shangshu Node Execution", opened["execution"])
        snapshot = frappe.parse_json(published["dependency_snapshot_json"])
        self.assertEqual(snapshot["actions"][action_id]["version"], "1.0.0")
        self.assertEqual(execution.action_version, "1.0.0")

    def test_published_version_stays_visible_while_next_draft_is_edited(self):
        definition = _definition()
        publish_definition(definition.definition_id, 1)
        graph = json.loads(definition.graph_json)
        graph["nodes"][0]["title"] = "下一版草稿"
        saved = save_process_draft(definition.definition_id, graph, 1)

        self.assertEqual(saved["status"], "Draft")
        visible = {row["definition_id"] for row in list_published_processes()}
        self.assertIn(definition.definition_id, visible)

    def test_fixed_tool_callback_is_idempotent(self):
        definition = _definition()
        publish_definition(definition.definition_id, 1)
        instance = start_process(definition.definition_id)
        node_id = json.loads(frappe.db.get_value("Shangshu Process Definition", definition.name, "graph_json"))["nodes"][0]["id"]
        opened = begin_node_execution(instance.name, node_id, {"file": "sample.pdf"})
        first = complete_node_execution(opened["execution"], opened["token"], output_data={"invoice_number": "001"}, callback_id="cb-" + frappe.generate_hash(length=8))
        second = complete_node_execution(opened["execution"], opened["token"], output_data={"invoice_number": "changed"})
        self.assertEqual(first["status"], "Completed")
        self.assertEqual(second["output"]["invoice_number"], "001")
        self.assertEqual(frappe.db.count("Shangshu Node Execution", {"process_instance": instance.name}), 1)

    def test_ai_tool_outside_candidates_is_rejected_and_audited(self):
        definition = _definition("ai")
        publish_definition(definition.definition_id, 1)
        instance = start_process(definition.definition_id)
        node_id = json.loads(definition.graph_json)["nodes"][0]["id"]
        opened = begin_node_execution(instance.name, node_id, {"kind": "scan"})
        result = complete_node_execution(opened["execution"], opened["token"], selected_tool="finance.payable.pay", output_data={})
        self.assertEqual(result["status"], "Failed")
        self.assertEqual(result["error"]["code"], "TOOL_NOT_ALLOWED")
        self.assertTrue(frappe.db.exists("Shangshu Process Exception", result["exception"]))
        # **统一日志库**（PKG-020-T01）：AI 执行审计只写统一表这一处。
        self.assertFalse(frappe.db.exists("Shangshu Unified Log", {"what_kind": "tool", "reference_name": opened["execution"]}),
                         "被拒的工具选择不得留下 AI 执行审计")

    def test_timeout_failure_is_retryable_only_for_extract(self):
        definition = _definition()
        publish_definition(definition.definition_id, 1)
        instance = start_process(definition.definition_id)
        node_id = json.loads(definition.graph_json)["nodes"][0]["id"]
        opened = begin_node_execution(instance.name, node_id, {"file": "timeout.pdf"})
        exception = fail_node_execution(opened["execution"], "EXTRACTION_TIMEOUT", "提取超时", retryable=True)
        self.assertEqual(exception.error_code, "EXTRACTION_TIMEOUT")
        self.assertEqual(exception.retryable, 1)

    def test_structured_condition_validation_and_no_write_simulation(self):
        definition = _simulation_definition()
        validated = validate_process_definition(definition.definition_id)
        self.assertTrue(validated["valid"])
        high = simulate_process(definition.definition_id, {"expense_claim": {"amount": 5000}})
        low = simulate_process(definition.definition_id, {"expense_claim": {"amount": 4999.99}})
        self.assertEqual(high["status"], "completed")
        self.assertEqual(low["status"], "completed")
        self.assertIn("总经理复核", [step["title"] for step in high["trace"]])
        self.assertNotIn("总经理复核", [step["title"] for step in low["trace"]])

    def test_condition_without_source_is_rejected(self):
        definition = _simulation_definition()
        graph = json.loads(definition.graph_json)
        graph["edges"][1]["condition"]["source"].pop("field_label")
        with self.assertRaises(frappe.ValidationError):
            validate_process_definition(definition.definition_id, graph)

    def test_simulation_reports_condition_type_mismatch(self):
        definition = _simulation_definition()
        with self.assertRaises(frappe.ValidationError):
            simulate_process(definition.definition_id, {"expense_claim": {"amount": "不是金额"}})
