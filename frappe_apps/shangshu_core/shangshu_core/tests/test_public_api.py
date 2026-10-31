from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (
    API_VERSION,
    get_contract_snapshot,
    list_registered_actions,
    list_registered_events,
    publish_event,
    retry_event_delivery,
)


def _failing_subscription(_payload, _context):
    raise RuntimeError("temporary consumer failure")


def _successful_subscription(_payload, _context):
    return {"accepted": True}


def _partial_write_subscription(payload, _context):
    frappe.get_doc({"doctype": "Role", "role_name": payload["source"]}).insert(ignore_permissions=True)
    raise RuntimeError("consumer failed after writing")


def _successful_write_subscription(payload, _context):
    frappe.get_doc({"doctype": "Role", "role_name": payload["source"] + "-ok"}).insert(ignore_permissions=True)
    return {"accepted": True}


class TestPublicApiV1(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def test_no_subscribers_stays_complete_and_external_retry_reuses_key(self):
        from shangshu_core.events import raw_resource
        domain, event = raw_resource("events", "platform.contract.checked")
        key = "external-retry-" + frappe.generate_hash(length=12)
        with patch("shangshu_core.events.raw_resource", return_value=(domain, {**event, "delivery": "after_commit"})), patch("shangshu_core.events._subscriptions", return_value=[]):
            empty = publish_event(event['id'], {'source': key}, key)
        self.assertEqual(empty['status'], 'Delivered')
        self.assertFalse(retry_event_delivery(empty['id'])['retried'])
        # 外部替身记忆不随数据库回滚；第一次目标已成功但响应丢失。
        effects, calls = set(), []
        def target(_payload, context):
            calls.append(context['delivery_key'])
            effects.add(context['delivery_key'])
            if len(calls) == 1:
                raise RuntimeError('目标成功但响应丢失，使用同一目标幂等键重试')
            return {'accepted': True}
        get_attr = frappe.get_attr
        with patch('shangshu_core.events._subscriptions', return_value=[(domain, {'id':'target', 'handler':'test.target'})]), patch('shangshu_core.events.frappe.get_attr', side_effect=lambda path: target if path == 'test.target' else get_attr(path)):
            published = publish_event(event['id'], {'source': key}, key + '-target')
            self.assertEqual(published['status'], 'Failed')
            retried = retry_event_delivery(published['id'])
        self.assertEqual(retried['status'], 'Delivered')
        self.assertEqual(len(effects), 1)
        self.assertEqual(calls[0], calls[1])

    def test_deferred_event_keeps_pending_snapshot_and_retries_once(self):
        from shangshu_core.events import raw_resource
        domain, event = raw_resource("events", "platform.contract.checked")
        event = {**event, "delivery": "after_commit"}
        key = "event-deferred-" + frappe.generate_hash(length=12)
        with patch("shangshu_core.events.raw_resource", return_value=(domain, event)), \
                patch("shangshu_core.events._subscriptions", return_value=[(domain, {"id": "deferred", "handler": "shangshu_core.tests.test_public_api._successful_subscription"})]):
            published = publish_event(event["id"], {"source": key}, key)
        self.assertEqual(published["status"], "Published")
        self.assertEqual(published["deliveries"][0]["attempts"], 0)
        subscriptions = [(domain, {"id": name, "handler": "shangshu_core.tests.test_public_api._successful_subscription"}) for name in ("deferred", "added-later")]
        with patch("shangshu_core.events._subscriptions", return_value=subscriptions):
            retried = retry_event_delivery(published["id"])
            again = retry_event_delivery(published["id"])
        self.assertEqual(retried["status"], "Delivered")
        self.assertEqual([item["subscription_id"] for item in retried["deliveries"]], ["deferred"])
        self.assertFalse(again["retried"])
        self.assertEqual(again["deliveries"][0]["attempts"], 1)

    def test_service_validates_input_output_and_rolls_back_failed_result(self):
        from shangshu_core.public_api import invoke_domain_service
        marker = "service-schema-" + frappe.generate_hash(length=12)
        service = {"id": "platform.test.service", "handler": "test.handler",
                   "input_schema": {"type": "object", "required": ["source"],
                                    "properties": {"source": {"type": "string", "minLength": 1}},
                                    "additionalProperties": False},
                   "output_schema": {"type": "object", "required": ["accepted"],
                                     "properties": {"accepted": {"type": "boolean"}}}}
        def invalid_result(_id, payload, _context):
            frappe.get_doc({"doctype": "Role", "role_name": payload["source"]}).insert(ignore_permissions=True)
            return {"accepted": "yes"}
        get_attr = frappe.get_attr
        frappe.get_doc({"doctype": "Role", "role_name": marker + "-before"}).insert(ignore_permissions=True)
        with patch("shangshu_core.domains.raw_resource", return_value=({"id": "com.shangshu.core"}, service)), \
                patch("shangshu_core.domains.frappe.get_attr", side_effect=lambda path: invalid_result if path == "test.handler" else get_attr(path)) as handler:
            with self.assertRaises(frappe.ValidationError):
                invoke_domain_service(service["id"], {"source": ""})
            handler.assert_not_called()
            with self.assertRaises(frappe.ValidationError):
                invoke_domain_service(service["id"], {"source": marker})
            self.assertFalse(frappe.db.exists("Role", marker))
            self.assertTrue(frappe.db.exists("Role", marker + "-before"), "不得回滚调用方之前的有效写入")
        with patch("shangshu_core.domains.raw_resource", return_value=({"id": "com.shangshu.core"}, service)), \
                patch("shangshu_core.domains.frappe.get_attr", return_value=lambda *_: {"accepted": True}):
            self.assertEqual(invoke_domain_service(service["id"], {"source": marker}), {"accepted": True})

    def test_legacy_service_without_schema_keeps_its_result(self):
        from shangshu_core.public_api import invoke_domain_service
        service = {"id": "platform.test.legacy", "handler": "test.handler"}
        with patch("shangshu_core.domains.raw_resource", return_value=({"id": "com.shangshu.core"}, service)), \
                patch("shangshu_core.domains.frappe.get_attr", return_value=lambda _id, payload, _ctx: payload):
            self.assertEqual(invoke_domain_service(service["id"], {"legacy": True}), {"legacy": True})

    def test_failed_consumer_rolls_back_only_its_own_writes(self):
        marker = "event-rollback-" + frappe.generate_hash(length=12)
        subscriptions = [
            ({"id": "com.shangshu.core"}, {"id": "test.success", "handler": "shangshu_core.tests.test_public_api._successful_write_subscription"}),
            ({"id": "com.shangshu.core"}, {"id": "test.partial", "handler": "shangshu_core.tests.test_public_api._partial_write_subscription"}),
        ]
        with patch("shangshu_core.events._subscriptions", return_value=subscriptions):
            result = publish_event("platform.contract.checked", {"source": marker}, marker)
        self.assertEqual(result["status"], "Partial")
        self.assertFalse(frappe.db.exists("Role", marker), "失败消费者不能留下局部业务写入")
        self.assertTrue(frappe.db.exists("Role", marker + "-ok"), "其他成功消费者的写入不得回滚")
        self.assertTrue(frappe.db.exists("Shangshu Event Envelope", result["id"]), "失败证据必须保留")
        with patch("shangshu_core.events._subscriptions", return_value=subscriptions):
            retry = retry_event_delivery(result["id"])
        self.assertEqual(retry["deliveries"][0]["attempts"], 1, "成功消费者不得重复调用")
        self.assertEqual(retry["deliveries"][1]["attempts"], 2)
        self.assertFalse(frappe.db.exists("Role", marker))
        self.assertTrue(frappe.db.exists("Role", marker + "-ok"))

    def test_machine_contract_and_runtime_catalog_share_v1_resources(self):
        contract = get_contract_snapshot()
        self.assertEqual(contract["api_version"], API_VERSION)
        self.assertEqual(contract["entrypoint"], "shangshu_core.public_api")
        self.assertIn("publish_event", contract["resources"]["event"])
        self.assertIn("platform.contract.checked", {row["id"] for row in list_registered_events()})
        tools = {row["id"]: row for row in list_registered_actions(tools_only=True)}
        self.assertTrue(tools["platform.object.query"]["executable"])
        self.assertEqual(tools["platform.object.query"]["effect"], "read")

    def test_event_publish_is_idempotent_audited_and_delivered(self):
        key = "event-" + frappe.generate_hash(length=16)
        before = frappe.db.count("Shangshu Event Envelope", {"idempotency_key": key})
        first = publish_event("platform.contract.checked", {"source": "public-api-test"}, key, "contract-test")
        second = publish_event("platform.contract.checked", {"source": "public-api-test"}, key, "contract-test")
        with self.assertRaises(frappe.DuplicateEntryError):
            publish_event("platform.contract.checked", {"source": "different-request"}, key, "contract-test")
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["status"], "Delivered")
        self.assertEqual(first["deliveries"][0]["subscription_id"], "platform.contract.checked.audit")
        self.assertEqual(frappe.db.count("Shangshu Event Envelope", {"idempotency_key": key}), before + 1)

    def test_event_schema_and_sensitive_payload_are_server_side_gates(self):
        with self.assertRaises(frappe.ValidationError):
            publish_event("platform.contract.checked", {}, "event-" + frappe.generate_hash(length=12))
        with self.assertRaises(frappe.ValidationError):
            publish_event(
                "platform.contract.checked",
                {"source": "test", "token": "must-not-enter-event"},
                "event-" + frappe.generate_hash(length=12),
            )

    def test_failed_event_delivery_is_audited_and_admin_can_retry(self):
        key = "event-retry-" + frappe.generate_hash(length=12)
        # 重试测试使用真实注册所有者；未注册消费者现在必须被执行边界拒绝。
        domain = {"id": "com.shangshu.core"}
        failed_subscription = {
            "id": "platform.contract.checked.retry-test",
            "handler": "shangshu_core.tests.test_public_api._failing_subscription",
        }
        successful_subscription = {
            **failed_subscription,
            "handler": "shangshu_core.tests.test_public_api._successful_subscription",
        }
        with patch("shangshu_core.events._subscriptions", return_value=[(domain, failed_subscription)]):
            failed = publish_event("platform.contract.checked", {"source": "retry-test"}, key)
        self.assertEqual(failed["status"], "Failed")
        self.assertEqual(failed["deliveries"][0]["attempts"], 1)
        with patch("shangshu_core.events._subscriptions", return_value=[(domain, successful_subscription)]):
            retried = retry_event_delivery(failed["id"])
        self.assertTrue(retried["retried"])
        self.assertEqual(retried["status"], "Delivered")
        self.assertEqual(retried["deliveries"][0]["attempts"], 2)
