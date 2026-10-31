from unittest.mock import patch
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import execute_registered_action, query_object_records


class TestStock(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.sku = "stock-test-" + frappe.generate_hash(length=12)

    def action(self, action, values, key=None):
        frappe.db.commit()  # Model independent HTTP action transactions.
        return execute_registered_action(action, values, confirmed=True,
                                         idempotency_key=key or frappe.generate_hash(length=24))["result"]

    def balance(self):
        return query_object_records("warehouse.stock", {"sku": self.sku})["rows"][0]["quantity"]

    def test_receive_issue_replay_and_reverse(self):
        received = self.action("warehouse.receive", {"sku": self.sku, "quantity": 10, "source": self.sku + "-in"})
        values = {"sku": self.sku, "quantity": 4, "source": self.sku + "-order"}
        issued = self.action("warehouse.issue", values)
        self.assertEqual(self.action("warehouse.issue", values), issued)
        self.assertEqual(self.balance(), 6)
        with self.assertRaises(frappe.DuplicateEntryError):
            self.action("warehouse.issue", {**values, "quantity": 5})
        with self.assertRaises(frappe.ValidationError):
            self.action("warehouse.issue", {**values, "source": self.sku + "-short", "quantity": 7})
        reversed_ = self.action("warehouse.reverse", {"movement": issued["movement"], "note": "取消调货"})
        self.assertEqual(self.balance(), 10)
        self.assertEqual(self.action("warehouse.reverse", {"movement": issued["movement"], "note": "取消调货"}), reversed_)
        with self.assertRaises(frappe.ValidationError):
            self.action("warehouse.reverse", {"movement": reversed_["movement"], "note": "不允许再次冲销"})
        self.assertEqual(frappe.db.count("Shangshu Stock Movement", {"sku": self.sku}), 3)
        self.assertTrue(frappe.db.exists("Shangshu Stock Movement", received["movement"]))

    def test_atomic_failure_and_immutable_history(self):
        from shangshu_warehouse.shangshu_warehouse.doctype.shangshu_stock_item.shangshu_stock_item import ShangshuStockItem
        self.action("warehouse.receive", {"sku": self.sku, "quantity": 10, "source": self.sku + "-in"})
        with patch.object(ShangshuStockItem, "save", side_effect=RuntimeError("余额写入故障")):
            with self.assertRaises(RuntimeError):
                self.action("warehouse.issue", {"sku": self.sku, "quantity": 3, "source": self.sku + "-failed"})
        self.assertEqual(self.balance(), 10)
        self.assertEqual(frappe.db.count("Shangshu Stock Movement", {"sku": self.sku}), 1)
        movement = frappe.get_doc("Shangshu Stock Movement", {"sku": self.sku})
        with self.assertRaises(frappe.PermissionError):
            movement.save(ignore_permissions=True)
        with self.assertRaises(frappe.PermissionError):
            frappe.delete_doc(movement.doctype, movement.name, ignore_permissions=True)

    def test_permission_confirmation_and_schema(self):
        values = {"sku": self.sku, "quantity": 1, "source": self.sku}
        with self.assertRaises(frappe.ValidationError):
            execute_registered_action("warehouse.receive", values, idempotency_key=self.sku)
        with self.assertRaises(frappe.ValidationError):
            self.action("warehouse.receive", {**values, "quantity": -1})
        user = "stock-staff-" + frappe.generate_hash(length=10) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": user, "first_name": "库存无权限测试", "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        frappe.set_user(user)
        with self.assertRaises(frappe.PermissionError):
            self.action("warehouse.receive", values)
        with self.assertRaises(frappe.PermissionError):
            query_object_records("warehouse.stock")

    def test_portal_launch_executes_registered_action_and_disable_blocks_new_write(self):
        from shangshu_core.public_api import launch_process, get_process_task, complete_process_task, set_domain_enabled
        values = {"sku": self.sku, "quantity": 2, "source": self.sku}
        launched = launch_process("com.shangshu.warehouse.receive", values, self.sku, True)
        task = get_process_task(launched["name"])["task"]
        done = complete_process_task(launched["name"], task["node_id"], values, self.sku + "-done", confirmed=True)
        self.assertEqual(done["instance"]["status"], "Completed")
        self.assertEqual(self.balance(), 2)
        from shangshu_core.public_api import list_application_definitions, set_application_enabled
        dependent = 'com.shangshu.orders'
        enabled = frappe.db.get_value('Shangshu Domain', dependent, 'enabled')
        orders_enabled = bool(enabled)
        applications = []
        try:
            # Other integrated-suite tests may have published composed workspaces.
            # Suspend them through the real lifecycle API, retaining their revision.
            for item in list_application_definitions():
                if item['status'] != 'Published':
                    continue
                revision = frappe.db.get_value('Shangshu Application Definition', item['id'], 'draft_revision')
                set_application_enabled(item['id'], False, '库存独立生命周期测试前置隔离', revision)
                applications.append((item['id'], revision))
            # 合并说明（来自 fast 那版）：六App组合里 **orders 强依赖 warehouse**
            # （orders 的 plugin.yml 声明了非可选依赖 com.shangshu.warehouse）——
            # orders 还开着时停用 warehouse 会被真实停用检查拦下。
            # 先断言这道拦，再用**真实口**把 orders 停掉（别在测试里放宽生产停用检查）。
            if orders_enabled:
                with self.assertRaises(frappe.ValidationError):
                    set_domain_enabled('com.shangshu.warehouse', False, '强依赖应阻断')
                set_domain_enabled(dependent, False, '隔离仓库消费者')
            elif enabled is not None:
                frappe.db.set_value('Shangshu Domain', dependent, 'enabled', 0)
            frappe.db.commit()  # Prior completed receipt and explicit fixture state survive rejection.
            set_domain_enabled("com.shangshu.warehouse", False, "隔离回归")
            with self.assertRaises(frappe.PermissionError):
                self.action("warehouse.issue", {**values, "source": self.sku + "-disabled"})
            set_domain_enabled("com.shangshu.warehouse", True, "恢复隔离回归")
            movement = frappe.db.get_value("Shangshu Stock Movement", {"sku": self.sku}, "name")
            frappe.db.savepoint("immutable_stock")
            with self.assertRaises(Exception):
                frappe.db.sql("update `tabShangshu Stock Movement` set quantity=999 where name=%s", movement)
            frappe.db.rollback(save_point="immutable_stock")
        finally:
            frappe.set_user('Administrator')
            set_domain_enabled('com.shangshu.warehouse', True, 'finally恢复库存测试前状态')
            if orders_enabled:
                # 复原 orders 前先确保它的前置依赖（finance）是开的，否则启用会被拦。
                if not frappe.db.get_value('Shangshu Domain', 'com.shangshu.finance', 'enabled'):
                    set_domain_enabled('com.shangshu.finance', True, 'finally恢复订单前置依赖')
                set_domain_enabled(dependent, True, 'finally恢复仓库消费者')
            elif enabled is not None:
                frappe.db.set_value('Shangshu Domain', dependent, 'enabled', enabled)
            for application, revision in applications:
                set_application_enabled(application, True, 'finally恢复原已发布应用', revision)
            frappe.db.commit()
