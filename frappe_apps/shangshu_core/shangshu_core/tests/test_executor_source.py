"""动作审计区分人工与调度来源：后台写入不得与人工动作混同。"""
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (
    create_application_definition, execute_registered_action,
)


class TestExecutorSource(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def test_audit_records_executor_source(self):
        app = create_application_definition("来源归属回归", "src-" + frappe.generate_hash(length=20))
        payload = {"application_id": app["id"]}
        human = execute_registered_action("platform.application.inspect", payload)
        scheduled = execute_registered_action("platform.application.inspect", payload, source="scheduler")
        # **统一日志库**（PKG-020-T01）：动作审计只写统一表 ⇒ 来源看统一表的 `trigger_source`。
        self.assertEqual(
            frappe.db.get_value("Shangshu Unified Log", human["audit"], "trigger_source"), "user")
        self.assertEqual(
            frappe.db.get_value("Shangshu Unified Log", scheduled["audit"], "trigger_source"), "scheduled")
        # 旧形状快照里保留**原样标签**（旧读口的 `executor_source` 形状不变）。
        import json
        legacy = json.loads(frappe.db.get_value("Shangshu Unified Log", scheduled["audit"], "detail_json"))["legacy"]
        self.assertEqual(legacy["executor_source"], "scheduler")
