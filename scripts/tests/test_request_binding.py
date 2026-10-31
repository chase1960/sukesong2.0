"""S0 无站点回归：导入真实模块，Frappe I/O 全部替换，不读写业务库。"""

import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch
from _f_business_access_stub import make_business_access_stub


ROOT = Path(__file__).resolve().parents[2] / "frappe_apps/shangshu_core/shangshu_core"


class Denied(Exception):
    pass


class Conflict(Exception):
    pass


def fail(message, exception=ValueError):
    raise exception(message)


class FakeDocument(SimpleNamespace):
    def get(self,key,default=None):return getattr(self,key,default)


class RequestBindingTests(unittest.TestCase):
    def setUp(self):
        self.frappe = ModuleType("frappe")
        self.frappe.flags = SimpleNamespace()
        self.frappe.throw = fail
        self.frappe.PermissionError = Denied
        self.frappe.DuplicateEntryError = Conflict
        self.frappe.ValidationError = ValueError
        self.frappe.DoesNotExistError = LookupError
        self.frappe.session = SimpleNamespace(user="alice@example.invalid")
        self.frappe.get_roles = Mock(return_value=["Approver"])
        # action_requests.find_request 要问 `frappe.db.exists`（动作回执还在不在）
        self.frappe.db = SimpleNamespace(get_value=Mock(return_value="existing"),
                                       exists=Mock(return_value=False))
        self.frappe.get_doc = Mock()
        self.identity = SimpleNamespace(name="stable-alice", enterprise_id="enterprise-a")
        domains = ModuleType("shangshu_core.domains")
        domains.assert_domain_enabled = Mock()
        domains.platform_contributions = Mock(return_value={"tools": [{"id": "a.write"}]})
        self.domains = domains
        domains.list_domains = Mock()
        domains.raw_resource = Mock(return_value=({"id": "domain-a"}, {"handler": "trusted.handler"}))
        identity = ModuleType("shangshu_core.identity")
        identity.get_identity = Mock(return_value=self.identity)
        utils = ModuleType("frappe.utils")
        utils.now_datetime = Mock()
        utils.get_datetime = Mock(side_effect=lambda value: value)
        password = ModuleType("frappe.utils.password")
        password.encrypt = Mock(side_effect=lambda value: value)
        password.decrypt = Mock(side_effect=lambda value: value)
        package = ModuleType("shangshu_core")
        package.__path__ = [str(ROOT)]
        # actions.py 顶层 `from shangshu_core import unified_log, business_access`
        # 这份夹具测的是**动作角色闸 + 提案资格**的旧判定（角色不匹配要拒）
        # ⇒ 公共策略桩装成**关闭**态；试用开放口径另有一条测试单测。
        self.access_stub = make_business_access_stub(open_policy=False)
        package.business_access = self.access_stub
        # business_access.require_identity 用 `frappe.local` 放**请求级**身份缓存
        self.frappe.local = SimpleNamespace()
        execution = ModuleType('shangshu_core.domain_execution')
        execution.resource_execution = lambda *_args: lambda fn: fn
        execution.domain_execution = lambda *_args, **_kwargs: nullcontext()
        self.modules = patch.dict(sys.modules, {
            "frappe": self.frappe, "frappe.utils": utils, "frappe.utils.password": password, "shangshu_core": package,
            "shangshu_core.domains": domains, "shangshu_core.identity": identity,
            "shangshu_core.domain_execution": execution,
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.binding = self.load("request_binding")
        self.load("schema_validation")
        self.actions = self.load("actions")
        self.events = self.load("events")
        # actions.py 的角色闸现在按**动作号**问业务资格（business_access.resource_is_open）
        # ⇒ 动作夹具要带 action_id，否则闸自己都读不到动作。
        self.action = SimpleNamespace(action_id="a.write", action_version="1.0.0", input_schema_json="{}",
                                      allowed_roles_json='["Approver"]', effect="write",
                                      confirmation_policy="required")
        self.actions._definition = Mock(return_value=self.action)
        self.actions._proposal_public = Mock(return_value={"id": "proposal", "payload": {"amount": 10}})
        self.events._public = Mock(return_value={"id": "event"})
        self.doc = FakeDocument(
            name="existing", actor_identity="stable-alice", actor_user="alice@example.invalid",
            enterprise_id="enterprise-a", action_id="a.write", action_version="1.0.0",
            event_id="a.changed", event_version="1.0.0", payload_json='{"amount":10}',
            correlation_id="trace-a", status="Confirmed", reference_execution=None, idempotency_key="shared-key", created_via="ai",
        )
        self.frappe.get_doc.return_value = self.doc

    def load(self, name):
        spec = importlib.util.spec_from_file_location(f"shangshu_core.{name}", ROOT / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def propose(self, payload=None):
        return self.actions.propose_registered_action("a.write", payload or {"amount": 10}, "shared-key")

    def test_schema_constraints_cannot_be_bypassed(self):
        invalid = [(-1,{"type":"number","minimum":0}), (11,{"maximum":10}),
                   (0,{"exclusiveMinimum":0}), (10,{"exclusiveMaximum":10}),
                   ("",{"minLength":1}), ("abcd",{"maxLength":3}),
                   ("bad",{"pattern":"^[0-9]+$"}), ("2026-02-30",{"format":"date"}),
                   ([],{"minItems":1}), ([1,2],{"maxItems":1}), ([1,1],{"uniqueItems":True}),
                   (True,{"enum":[1]}), ([1,1.0],{"uniqueItems":True}), (float('nan'),{"type":"number"}),
                   ("a",{"oneOf":[{"type":"string"}]}), ("aaa",{"pattern":"(a+)+$"}),
                   ({"child":-1},{"additionalProperties":{"minimum":0}})]
        for value,schema in invalid:
            for validate in (self.actions._validate_schema, self.events._validate_schema):
                with self.subTest(schema=schema), self.assertRaises(ValueError):
                    validate(value,schema)
        for value,schema in [(0,{"minimum":0}), ("2026-09-10",{"format":"date"}),
                             ("123",{"pattern":"^[0-9]+$"}), (None,{"type":["string","null"]}),
                             ([True,1],{"uniqueItems":True}), (1.0,{"enum":[1]})]:
            self.actions._validate_schema(value,schema)
            self.events._validate_schema(value,schema)
        self.assertIs(self.actions._validate_schema, self.events._validate_schema)

    def event(self, **kwargs):
        return self.events.publish_event("a.changed", {"amount": 10}, "shared-key", **kwargs)

    def test_proposal_exact_retry_returns_existing(self):
        self.assertEqual(self.propose()["id"], "proposal")
        self.actions._proposal_public.assert_called_once_with(self.doc)

    def test_unpublished_action_cannot_enter_proposal_even_with_user_source(self):
        self.domains.platform_contributions.return_value = {"tools": []}
        for source in ("ai", "user"):
            with self.subTest(source=source), self.assertRaises(Denied):
                self.actions.propose_registered_action("a.write", {"password": "private"}, "key", source)
        self.frappe.get_doc.assert_not_called()

    def test_withdrawn_tool_cannot_execute_pending_proposal(self):
        self.domains.platform_contributions.return_value = {"tools": []}
        self.doc.status = "Proposed"
        self.actions.execute_registered_action = Mock()
        with self.assertRaises(Denied):
            self.actions.resolve_action_proposal("existing", "confirmed")
        self.actions.execute_registered_action.assert_not_called()

    def test_withdrawn_tool_proposal_can_still_be_rejected(self):
        self.domains.platform_contributions.return_value = {"tools": []}
        self.doc.status = "Proposed"
        self.doc.save = Mock()
        self.actions.resolve_action_proposal("existing", "rejected")
        self.assertEqual(self.doc.status, "Rejected")

    def test_proposal_rejects_mismatched_binding_before_returning_payload(self):
        for field, value in [("actor_identity", "someone-else"), ("enterprise_id", "elsewhere"),
                             ("action_id", "b.write"), ("action_version", "2.0.0"),
                             ("payload_json", '{"amount":11}')]:
            with self.subTest(field=field):
                previous = getattr(self.doc, field)
                setattr(self.doc, field, value)
                try:
                    with self.assertRaises(Conflict):
                        self.propose()
                    self.actions._proposal_public.assert_not_called()
                finally:
                    setattr(self.doc, field, previous)

    def test_event_exact_retry_returns_existing_without_delivery(self):
        self.events._deliver = Mock()
        self.assertTrue(self.event(correlation_id="trace-a")["idempotent"])
        self.events._deliver.assert_not_called()

    def test_event_rejects_mismatched_binding(self):
        for field, value in [("actor_identity", "someone-else"), ("enterprise_id", "elsewhere"),
                             ("event_id", "b.changed"), ("event_version", "2.0.0"),
                             ("payload_json", '{"amount":11}'), ("correlation_id", "trace-b")]:
            with self.subTest(field=field):
                previous = getattr(self.doc, field)
                setattr(self.doc, field, value)
                try:
                    with self.assertRaises(Conflict):
                        self.event(correlation_id="trace-a")
                    self.events._public.assert_not_called()
                finally:
                    setattr(self.doc, field, previous)

    def test_omitted_event_correlation_preserves_generated_value(self):
        self.assertTrue(self.event()["idempotent"])
        self.assertTrue(self.event(correlation_id="")["idempotent"])

    def test_renamed_user_can_retry_with_same_immutable_identity(self):
        self.frappe.session.user = "renamed@example.invalid"
        self.assertEqual(self.propose()["id"], "proposal")

    def test_payload_key_order_is_irrelevant(self):
        self.doc.payload_json = '{"amount":10,"nested":{"a":1,"b":2}}'
        self.assertEqual(self.propose({"nested": {"b": 2, "a": 1}, "amount": 10})["id"], "proposal")

    def test_bool_is_not_equal_to_number(self):
        self.doc.payload_json = '{"amount":1}'
        with self.assertRaises(Conflict):
            self.propose({"amount": True})

    def test_invalid_stored_payload_fails_closed(self):
        self.doc.payload_json = "not-json"
        with self.assertRaises(Conflict):
            self.propose()

    def test_ended_proposal_still_checks_action_permission(self):
        self.frappe.get_roles.return_value = ["Desk User"]
        for status in ["Proposed", "Confirmed", "Rejected", "Failed"]:
            with self.subTest(status=status):
                self.doc.status = status
                with self.assertRaises(Denied):
                    self.actions.resolve_action_proposal("existing", "confirmed")
                self.actions._proposal_public.assert_not_called()

    def test_ended_proposal_checks_enterprise_even_for_manager(self):
        self.frappe.get_roles.return_value = ["System Manager"]
        self.identity.enterprise_id = "enterprise-b"
        with self.assertRaises(Denied):
            self.actions.resolve_action_proposal("existing", "confirmed")
        self.actions._proposal_public.assert_not_called()

    def test_authorized_approver_can_read_ended_proposal(self):
        self.identity.name = "another-authorized-approver"
        with patch.object(self.actions.action_requests, "find_request", return_value=SimpleNamespace(status="Succeeded")), patch.object(self.actions, "execute_registered_action", return_value={"result": {"ok": True}}) as replay:
            self.assertTrue(self.actions.resolve_action_proposal("existing", "confirmed")["idempotent"])
            self.assertEqual(replay.call_args.kwargs["idempotency_key"], "shared-key")

    def test_descending_pages_skip_hidden_rows_without_duplicates_or_counts(self):
        docs = {f"p-{n:03}": FakeDocument(**{**vars(self.doc), "name": f"p-{n:03}"}) for n in range(125)}
        visible = {"p-003", "p-051", "p-124"}
        queries = []
        def query(doctype, filters, **kwargs):
            queries.append(filters)
            self.assertEqual(filters["enterprise_id"], self.identity.enterprise_id)
            names = sorted(docs, reverse=True)
            if "name" in filters:
                operator, after = filters["name"]
                self.assertEqual(operator, "<")
                names = [name for name in names if name < after]
            return [SimpleNamespace(name=name) for name in names[:kwargs["limit_page_length"]]]
        self.frappe.get_all = Mock(side_effect=query)
        self.frappe.get_doc = Mock(side_effect=lambda doctype,name: docs[name])
        with patch.object(self.actions, "_proposal_directory_item", side_effect=lambda doc,roles: {"id":doc.name} if doc.name in visible else None):
            first = self.actions.list_action_proposals(limit=2)
            self.assertEqual(first, {"items":[{"id":"p-124"},{"id":"p-051"}],"next_cursor":"p-051","has_more":True})
            second = self.actions.list_action_proposals(limit=2,after=first["next_cursor"])
            self.assertEqual(second, {"items":[{"id":"p-003"}],"next_cursor":None,"has_more":False})
            visible.clear()
            empty = self.actions.list_action_proposals(limit=2)
            self.assertEqual(empty, {"items":[],"next_cursor":None,"has_more":False})
        self.assertGreater(len(queries),3)

    def directory(self, failure=None, rejection_failure=None):
        self.frappe.get_all = Mock(return_value=[SimpleNamespace(name=self.doc.name)])
        self.frappe.get_doc = Mock(return_value=self.doc)
        self.actions._assert_proposal_target = Mock(side_effect=failure)
        review = SimpleNamespace(authorize_bound_review=Mock(),supports_review=Mock(return_value=True),
                                 _load=Mock(return_value=(self.doc,{},{}),side_effect=rejection_failure))
        with patch.dict(sys.modules,{'shangshu_core.proposal_review':review}):
            result=self.actions.list_action_proposals()
        # 产品已改为游标信封 {items,next_cursor,has_more}（actions.py:527）。
        # 权限/可见性断言针对的是条目本身，形状变化不改变判据 —— 只在这里解包。
        if isinstance(result, dict) and 'items' in result:
            result = result['items']
        return result,review

    def test_missing_target_directory_exposes_only_authorized_author_discard_entry(self):
        self.doc.status='Proposed'
        result,review=self.directory(LookupError('gone'))
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['review_access'],'reject_only')
        self.assertIn('不存在',result[0]['review_blocked_reason'])
        review._load.assert_called_once_with(self.doc.name,'resolve',decision='rejected')

    def test_missing_target_directory_does_not_expose_other_authors_or_ended_proposals(self):
        for actor,status in [('other@example.invalid','Proposed'),('alice@example.invalid','Confirmed')]:
            self.doc.actor_user=actor;self.doc.status=status
            result,review=self.directory(LookupError('gone'))
            self.assertEqual(result,[]);review._load.assert_not_called()

    def test_missing_target_directory_does_not_restore_revoked_discard_permission(self):
        self.doc.status='Proposed'
        result,review=self.directory(LookupError('gone'),Denied('revoked'))
        self.assertEqual(result,[]);review._load.assert_called_once()

    def test_directory_permission_and_validation_errors_do_not_become_discard_entries(self):
        self.doc.status='Proposed'
        for failure in (Denied('private'),ValueError('domain stopped or invalid')):
            result,review=self.directory(failure)
            self.assertEqual(result,[]);review._load.assert_not_called()

    def test_existing_normal_directory_entry_keeps_original_behavior(self):
        self.doc.status='Proposed'
        result,review=self.directory()
        self.assertEqual(result,[{'id':'proposal','payload':{'amount':10}}])
        review.authorize_bound_review.assert_called_once_with(self.doc,'read')
        review._load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
