"""PKG-018-T10：**跨表 JOIN** —— 只支持**已明确声明的关联**。

**测试通过 = 什么成立**（一句话）：

「按**声明过的引用关联**能跨受管对象统计；**一对多不会默默给出一个被放大的数**
（左端每个行只算一次、右端按展开算，两边都写明口径）；**关联声明得对**才跑
（不是引用字段、方向对不上、基数声明与实际不符 ⇒ 当场拒）；**关联的两侧都要查权限**
（读不到那一侧就整条拒掉，看不到的那侧记录数要**报出来**，不静默丢）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_join_aggregate --skip-test-records
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.actions import execute_registered_action
from shangshu_core.applications import (create_application_definition, get_application_definition,
                                        publish_application_definition, save_application_draft)
from shangshu_core.model_changes import execute_object_change, prepare_object_change


class TestJoinAggregate(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "t10-" + uuid.uuid4().hex
        self.objects = []
        self.bindings = []
        self.counter = 0
        self.application = None
        self.staff = None

    def tearDown(self):
        frappe.set_user("Administrator")
        for object_id in self.objects:
            try:
                model = frappe.get_doc(model_records.MODEL, object_id)
                frappe.db.commit()
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
            except Exception:
                pass
        if self.application:
            try:
                frappe.delete_doc("Shangshu Application Definition", self.application, force=True,
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

    # ---------- 辅助：造三个受管对象（客户／订单／费用） ----------

    def _application(self):
        if self.application is None:
            app = create_application_definition("关联试点", "t10-app:" + self.key)
            self.application = app["id"]
        return self.application

    def _object(self, title, fields, access=None):
        application = self._application()
        definition = {"schema_version": 1, "title": title, "kind": "record", "fields": fields,
                      "access": access or {"read_roles": ["Desk User", "System Manager"],
                                           "write_roles": ["System Manager"], "record_scope": "all"}}
        change = prepare_object_change(application, definition, "t10-object:" + uuid.uuid4().hex)
        frappe.db.commit()
        applied = execute_object_change(change["id"], confirmed=True)
        self.objects.append(change["object_id"])
        return change["object_id"], applied["target_revision"]

    def _publish(self, bindings):
        # 同一对象的绑定**按最新修订**替换（绑定版本必须对得上对象的当前生效版本）
        known = {object_id for object_id, _revision in self.bindings}
        for object_id, revision in bindings:
            self.bindings = [item for item in self.bindings if item[0] != object_id]
            self.bindings.append((object_id, revision))
        current = get_application_definition(self.application)
        spec = {"schema_version": 1, "title": "关联试点", "description": "跨表关联判据用",
                "allowed_roles": ["Desk User"],
                "bindings": [{"kind": "datasets", "resource_id": object_id,
                              "owner_domain": self.application, "version": str(revision)}
                             for object_id, revision in self.bindings]}
        saved = save_application_draft(self.application, spec, current["draft_revision"])
        publish_application_definition(self.application, saved["draft_revision"])

    def _record(self, object_id, revision, values, tag):
        outcome = execute_registered_action(
            "platform.object.create",
            {"object_id": object_id, "expected_revision": revision, "values": values},
            confirmed=True, idempotency_key="t10-row:" + self.key + ":" + tag, source="user")
        return outcome["result"]["name"]

    def _tag(self, name):
        self.counter += 1
        return "%s-%d" % (name, self.counter)

    def _fixture(self, expense_count=2, customer_access=None, order_access=None):
        """客户 2 条；订单 3 条（两单同属一个客户）；费用挂在订单上。"""
        customer_id, customer_rev = self._object("客户", [
            {"id": "customer_name", "label": "客户名", "type": "text"}], access=customer_access)
        order_id, order_rev = self._object("订单", [
            {"id": "amount", "label": "金额", "type": "decimal"},
            {"id": "customer", "label": "客户", "type": "reference", "target": customer_id}],
            access=order_access)
        expense_id, expense_rev = self._object("费用", [
            {"id": "cost", "label": "费用", "type": "decimal"},
            {"id": "order", "label": "订单", "type": "reference", "target": order_id}])
        c1 = self._record(customer_id, customer_rev, {"customer_name": "甲公司"}, self._tag("c1"))
        c2 = self._record(customer_id, customer_rev, {"customer_name": "乙公司"}, self._tag("c2"))
        orders = []
        for index, customer in enumerate((c1, c2, c1)):
            orders.append(self._record(order_id, order_rev,
                                       {"amount": 10 * (index + 1), "customer": customer},
                                       self._tag("o%d" % index)))
        for index, order in enumerate(orders):
            for number in range(expense_count):
                self._record(expense_id, expense_rev,
                             {"cost": index + number / 10, "order": order},
                             self._tag("e%d-%d" % (index, number)))
        self._publish([(customer_id, customer_rev), (order_id, order_rev), (expense_id, expense_rev)])
        return {"customer": customer_id, "customer_rev": customer_rev, "order": order_id,
                "order_rev": order_rev, "expense": expense_id, "expense_rev": expense_rev,
                "customers": (c1, c2), "orders": orders}

    def _join(self, payload):
        outcome = execute_registered_action("platform.object.join_aggregate", payload,
                                            confirmed=True,
                                            idempotency_key="t10-join:" + self.key + ":" + uuid.uuid4().hex[:8],
                                            source="user")
        return outcome.get("result") or {}

    def _staff_user(self, object_id=None):
        email = "join-staff-" + frappe.generate_hash(length=8) + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "关联员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        self.staff = email
        if object_id:
            # 新建员工默认落在别的企业 ⇒ 归到与对象同一个企业，才能单独验「字段/记录隔离」
            enterprise = frappe.get_value(model_records.MODEL, object_id, "enterprise_id")
            identity = frappe.get_doc("Shangshu Identity", frappe.db.get_value(
                "Shangshu Identity", {"user": email}, "name"))
            if identity.enterprise_id != enterprise:
                frappe.db.set_value("Shangshu Identity", identity.name, "enterprise_id", enterprise)
        return email

    # ① 外键方向（右端至多一行）：两边口径都写明；右端要看去重
    def test_declared_reference_join_states_both_sides_counting(self):
        data = self._fixture()
        result = self._join({
            "object_id": data["order"],
            "join": {"target_object_id": data["customer"], "field": "customer",
                     "declared_on": "self"},
            "cardinality": "one_to_one",
            "metrics": [{"op": "count_rows", "side": "left"},
                        {"op": "count_rows", "side": "right"},
                        {"op": "count_distinct", "field": "customer_name", "side": "right"}],
        })
        self.assertEqual(result["metrics"]["left_count_rows"], 3, "左端行数＝参与的左端行")
        self.assertEqual(result["metrics"]["right_count_rows"], 3, "右端按配对算（3 个订单各有 1 个客户）")
        self.assertEqual(result["metrics"]["right_count_distinct_customer_name"], 2,
                         "右端一共 2 个客户 ⇒ 要看去重计数")
        join_block = result["receipt"]["join"]
        self.assertEqual(join_block["cardinality"], "one_to_one")
        self.assertEqual(join_block["counting"]["left"], "distinct_left_rows")
        self.assertEqual(join_block["counting"]["right"], "joined_rows")
        self.assertEqual(join_block["base_rows"], 3, "左端匹配行数要说清")
        self.assertEqual(join_block["joined_rows"], 3, "配对行数要说清")
        self.assertIn("去重", join_block["notes"], "右端行数与右端记录数不是一个数，要说清")

    # ② 一对多：左端**不膨胀**（2 行左端不是 4），右端按展开算；膨胀倍数要说出来
    def test_one_to_many_does_not_inflate_the_left_side_and_says_so(self):
        data = self._fixture(expense_count=2)
        result = self._join({
            "object_id": data["order"],
            "join": {"target_object_id": data["expense"], "field": "order",
                     "declared_on": "target"},
            "cardinality": "one_to_many",
            "metrics": [{"op": "count_rows", "side": "left"},
                        {"op": "count_rows", "side": "right"},
                        {"op": "sum", "field": "cost", "side": "right"}],
        })
        self.assertEqual(result["metrics"]["left_count_rows"], 3,
                         "左端每个订单只算一次（3 个订单，不是 6）—— 不膨胀")
        self.assertEqual(result["metrics"]["right_count_rows"], 6, "右端按展开算（3 单 × 每单 2 条费用）")
        join_block = result["receipt"]["join"]
        self.assertEqual(join_block["base_rows"], 3, "左端匹配行数")
        self.assertEqual(join_block["joined_rows"], 6, "展开后的配对行数")
        self.assertEqual(join_block["expansion_ratio"], "6/3", "膨胀倍数要写出来")
        self.assertEqual(join_block["counting"]["left"], "distinct_left_rows")
        self.assertEqual(join_block["counting"]["right"], "joined_rows")
        self.assertTrue(any(item.get("code") == "one_to_many_expanded"
                            for item in result["receipt"]["exceptions"]),
                        "回执里要有「一对多已展开」的异常说明")

    # ③ 基数声明与实际不符 ⇒ 当场拒（不许默默给出一个被放大的数）
    def test_cardinality_must_match_the_declared_relation(self):
        data = self._fixture()
        with self.assertRaises(frappe.ValidationError):
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["expense"], "field": "order",
                                 "declared_on": "target"},
                        "cardinality": "one_to_one",
                        "metrics": [{"op": "count_rows", "side": "left"}]})
        with self.assertRaises(frappe.ValidationError):
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["customer"], "field": "customer",
                                 "declared_on": "self"},
                        "cardinality": "one_to_many",
                        "metrics": [{"op": "count_rows", "side": "left"}]})

    # ④ 不是声明过的关联 ⇒ 拒（不许模型自由猜关联、任意拼表）
    def test_undeclared_relation_is_rejected(self):
        data = self._fixture()
        with self.assertRaises(frappe.ValidationError):
            # 金额不是引用字段
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["customer"], "field": "amount",
                                 "declared_on": "self"},
                        "cardinality": "one_to_one",
                        "metrics": [{"op": "count_rows", "side": "left"}]})
        with self.assertRaises(frappe.ValidationError):
            # 目标对象对不上（这个引用指向的是客户，不是费用）
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["expense"], "field": "customer",
                                 "declared_on": "self"},
                        "cardinality": "one_to_one",
                        "metrics": [{"op": "count_rows", "side": "left"}]})

    # ⑤ 两边权限都要查：读不到关联对象 ⇒ 整条拒
    def test_both_sides_permissions_are_checked(self):
        data = self._fixture(customer_access={"read_roles": ["System Manager"],
                                              "write_roles": ["System Manager"],
                                              "record_scope": "all"})
        # 左端能读、右端能读时，普通员工能跑（结果按他的权限算）
        ok = self._fixture(order_access={"read_roles": ["Desk User", "System Manager"],
                                         "write_roles": ["System Manager"], "record_scope": "all"})
        email = self._staff_user(data["order"])
        frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError):
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["customer"], "field": "customer",
                                 "declared_on": "self"},
                        "cardinality": "one_to_one",
                        "metrics": [{"op": "count_rows", "side": "left"}]})
        result = self._join({"object_id": ok["order"],
                             "join": {"target_object_id": ok["customer"], "field": "customer",
                                      "declared_on": "self"},
                             "cardinality": "one_to_one",
                             "metrics": [{"op": "count_rows", "side": "left"}]})
        self.assertEqual(result["metrics"]["left_count_rows"], 3)

    # ⑥ 右端记录级范围（只看本人）⇒ 看���到的那几条**要报出来**，不静默丢
    def test_right_side_record_scope_exclusions_are_reported(self):
        data = self._fixture(customer_access={"read_roles": ["Desk User", "System Manager"],
                                              "write_roles": ["System Manager"],
                                              "record_scope": "own"})
        email = self._staff_user(data["order"])
        frappe.set_user(email)
        result = self._join({"object_id": data["order"],
                             "join": {"target_object_id": data["customer"], "field": "customer",
                                      "declared_on": "self"},
                             "cardinality": "one_to_one",
                             "metrics": [{"op": "count_rows", "side": "left"},
                                         {"op": "count_rows", "side": "right"}]})
        join_block = result["receipt"]["join"]
        self.assertEqual(join_block["excluded_by_permission"], 3,
                         "客户是别人建的 ⇒ 3 条配对被排除，要报出来")
        self.assertEqual(result["metrics"]["left_count_rows"], 0, "没读到关联记录就没有配对")

    # ⑦ 右端字段无权 ⇒ 拒（不因为「对象能读」就放过字段）
    def test_right_side_field_permission_is_checked(self):
        data = self._fixture()
        # 客户加一个只有管理员能看的字段
        from shangshu_core.model_changes import prepare_object_change as _prepare
        model = frappe.get_doc(model_records.MODEL, data["customer"])
        definition = {"schema_version": 1, "title": "客户", "kind": "record",
                      "fields": [{"id": "customer_name", "label": "客户名", "type": "text"},
                                 {"id": "secret", "label": "密级", "type": "text",
                                  "read_roles": ["System Manager"], "write_roles": ["System Manager"]}],
                      "access": {"read_roles": ["Desk User", "System Manager"],
                                 "write_roles": ["System Manager"], "record_scope": "all"}}
        change = _prepare(self.application, definition, "t10-secret:" + uuid.uuid4().hex,
                          object_id=data["customer"], expected_revision=model.revision)
        frappe.db.commit()
        applied = execute_object_change(change["id"], confirmed=True)
        self._publish([(data["customer"], applied["target_revision"]),
                       (data["order"], data["order_rev"]), (data["expense"], data["expense_rev"])])
        email = self._staff_user(data["order"])
        frappe.set_user(email)
        with self.assertRaises(frappe.PermissionError):
            self._join({"object_id": data["order"],
                        "join": {"target_object_id": data["customer"], "field": "customer",
                                 "declared_on": "self"},
                        "cardinality": "one_to_one",
                        "metrics": [{"op": "count_distinct", "field": "secret", "side": "right"}]})


if __name__ == "__main__":  # pragma: no cover
    pass
