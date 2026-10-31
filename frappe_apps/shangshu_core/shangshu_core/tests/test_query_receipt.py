"""PKG-018-T01：查询回执 —— 让工具结果说清「这次查到了什么」。

**测试通过 = 什么成立**（一句话）：

「**126 条匹配只返回 5 条明细时，回执里明确写着：匹配总数 126、这次实际返回 5 条、
计数是精确的、**明细没有完整返回**、实际用的条件与计数口径、当前授权范围与查询时间**；
**查询失败不是 0 条**。」

为什么要有回执（PKG-018-T01）：查询结果里只有 `rows/total` 时，模型收到的是 5 行 JSON ——
它会把 5 行当成全部，或自己逐行心算。回执把「总量／返回量／完整性／口径／范围／时间／异常」
这些事实**随结果一起**送到模型实际收到的工具消息里（不加一次 LLM 摘要）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_query_receipt --skip-test-records
"""
import unittest
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core.runtime import register_action

OBJECT_ID = "test.receipt.todo"
CREATE_ACTION = "test.receipt.todo.create"
CORE_DOMAIN = {"id": "com.shangshu.core", "name": "尚书平台核心", "enabled": True, "contribution": {}}
OBJECT = {
    "id": OBJECT_ID, "name": "回执测试待办", "doctype": "ToDo", "version": "1.0.0", "schema_version": 1,
    "operations": ["read"],
    "fields": [{"id": "description", "label": "描述", "type": "text"},
               {"id": "status", "label": "状态", "type": "choice"},
               {"id": "modified", "label": "更新时间", "type": "text"}],
    "native_table": {"doctype": "ToDo", "title": "回执测试待办", "version_field": "modified",
                     "fields": [{"id": "description", "label": "描述", "type": "text", "required": True},
                                 {"id": "status", "label": "状态", "type": "choice",
                                  "options": ["Open", "Closed", "Cancelled"]}],
                     "read_roles": ["Desk User"], "write_roles": ["Desk User"],
                     "search_fields": ["description"],
                     "write": {"update_action": "test.receipt.todo.update",
                               "create_action": CREATE_ACTION,
                               "name_param": "name", "version_param": "expected_version"}},
}
ACTIONS = {
    "test.receipt.todo.update": {"id": "test.receipt.todo.update",
                                 "handler": "shangshu_core.tests.test_query_receipt._write_todo"},
    CREATE_ACTION: {"id": CREATE_ACTION,
                    "handler": "shangshu_core.tests.test_query_receipt._create_todo"},
}
MATCHED = 126
RETURNED = 5


def _write_todo(action_id, payload, context):
    if not context.get("confirmed"):
        frappe.throw("测试动作需要确认", frappe.ValidationError)
    doc = frappe.get_doc("ToDo", payload["name"], for_update=True)
    if str(doc.modified) != str(payload["expected_version"]):
        frappe.throw("待办已被修改", frappe.TimestampMismatchError)
    doc.description = payload.get("description", doc.description)
    doc.save()
    return {"name": doc.name, "modified": str(doc.modified)}


def _create_todo(action_id, payload, context):
    if not context.get("confirmed"):
        frappe.throw("测试动作需要确认", frappe.ValidationError)
    doc = frappe.get_doc({"doctype": "ToDo", "description": payload["description"],
                          "status": payload.get("status") or "Open"})
    doc.insert(ignore_permissions=True)
    return {"name": doc.name, "modified": str(doc.modified)}


class TestQueryReceipt(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = frappe.generate_hash(length=10)
        from shangshu_core import domains
        real = domains.raw_resource

        def resolver(section, resource_id):
            if section == "objects" and resource_id == OBJECT_ID:
                return CORE_DOMAIN, OBJECT
            if section == "actions" and resource_id in ACTIONS:
                return CORE_DOMAIN, ACTIONS[resource_id]
            return real(section, resource_id)

        for target in ("shangshu_core.native_objects.raw_resource", "shangshu_core.actions.raw_resource"):
            patcher = patch(target, side_effect=resolver)
            patcher.start()
            self.addCleanup(patcher.stop)
        register_action("test.receipt.todo.update", "1.0.0", "测试回执待办修改", "write", "required",
                        ["Desk User"], {"type": "object"}, {}, 30, "none")
        register_action(CREATE_ACTION, "1.0.0", "测试回执待办新建", "write", "required", ["Desk User"],
                        {"type": "object"}, {}, 30, "none")
        self._seed(MATCHED)

    def _seed(self, count):
        """批量造 count 条待办（用 bulk_insert，避免一条条 insert 拖慢判据）。"""
        now = frappe.utils.now()
        rows = []
        for index in range(count):
            rows.append(("RECEIPT-%s-%03d" % (self.key, index),
                         "回执样本-%s-%03d" % (self.key, index),
                         "Open", "Administrator", now, now))
        frappe.db.bulk_insert("ToDo",
                              ["name", "description", "status", "owner", "creation", "modified"],
                              rows)
        frappe.db.commit()

    def _query(self, filters=None, page=1, page_length=30):
        from shangshu_core.native_objects import query_records
        return query_records(OBJECT_ID, filters or {}, page, page_length)

    # ① 总量／返回量／完整性：三件事分开说
    def test_receipt_states_total_returned_and_incomplete(self):
        # 用本次的 key 隔离（表里还有别的记录）⇒ 匹配 126 条、只回 5 条。
        result = self._query({"$search": "回执样本-" + self.key}, page_length=RETURNED)
        receipt = result["receipt"]
        counts = receipt["counts"]
        self.assertEqual(counts["matched_total"], MATCHED, "回执必须说清完整匹配行数")
        self.assertEqual(counts["returned_rows"], RETURNED, "回执必须说清这次实际返回几行")
        self.assertIs(counts["exact"], True, "计数与明细同一次读取 ⇒ 精确")
        completeness = receipt["completeness"]
        self.assertIs(completeness["details_complete"], False, "只回 5/126 ⇒ 明细没完整返回")
        self.assertEqual(completeness["detail_rows"], RETURNED)
        self.assertEqual(completeness["matched_rows"], MATCHED)
        # 旧消费者继续可用（向后兼容）
        self.assertEqual(result["total"], MATCHED)
        self.assertEqual(len(result["rows"]), RETURNED)
        self.assertEqual(result["page"], 1)

    # ② 口径／范围／时间：回执行了什么，不是空话
    def test_receipt_states_criteria_scope_and_time(self):
        result = self._query({"status": "Open", "$search": "回执样本-" + self.key,
                              "$sort": "description", "$direction": "asc"}, page_length=RETURNED)
        receipt = result["receipt"]
        criteria = receipt["criteria"]
        self.assertEqual(criteria["filters"], {"status": "Open"}, "回执要回显实际用的筛选条件")
        self.assertEqual(criteria["search"], "回执样本-" + self.key)
        self.assertEqual(criteria["sort"], "description")
        self.assertEqual(criteria["direction"], "asc")
        self.assertEqual(criteria["counting"], "row", "计数口径要说清是行计数")
        self.assertEqual(criteria["page"], 1)
        self.assertEqual(criteria["page_length"], RETURNED)
        self.assertTrue(receipt["time"]["queried_at"], "要有查询时间")
        self.assertIn("scope", receipt)
        self.assertEqual(receipt["exceptions"], [], "没有异常就明说没有")

    # ④ 查询编号每次唯一、只用于追溯（不宣称固定结果集）
    def test_query_id_is_unique_per_call_and_only_traces(self):
        import json as _json
        first = self._query({"$search": "回执样本-" + self.key}, page_length=RETURNED)
        second = self._query({"$search": "回执样本-" + self.key}, page_length=RETURNED)
        self.assertNotEqual(first["receipt"]["query_id"], second["receipt"]["query_id"],
                            "同条件两次查询的编号不能撞（追问要分得清是哪一次算的）")
        receipt_text = _json.dumps(first["receipt"], ensure_ascii=False)
        self.assertNotIn("snapshot", receipt_text.lower(), "编号只用于追溯，不宣称是固定结果集快照")
        self.assertNotIn("固定结果集", receipt_text)

    # ③ 查询失败不是 0 条
    def test_query_failure_is_not_reported_as_zero_rows(self):
        with self.assertRaises(frappe.ValidationError):
            self._query({"status": "Open", "$sort": "不存在的字段"})
        # 未声明的字段 ⇒ 当场拒（不是「查不到 ⇒ 0 条」）
        with self.assertRaises(frappe.ValidationError):
            self._query({"owner": "越权筛选"})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
