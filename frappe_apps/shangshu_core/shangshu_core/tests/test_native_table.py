"""原生对象表格适配回归：领域显式声明、读/写/导出/导入共用同一入口。

用 ToDo 作真实 DocType、用本模块的写处理器作真实动作，避免为测试复制受管对象或镜像表。
"""
import base64
from io import BytesIO
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook
from shangshu_core.public_api import execute_registered_action, invoke_domain_service
from shangshu_core.runtime import register_action

OBJECT_ID = "test.native.todo"
UPDATE_ACTION = "test.native.todo.update"
CREATE_ACTION = "test.native.todo.create"
CORE_DOMAIN = {"id": "com.shangshu.core", "name": "尚书平台核心", "enabled": True, "contribution": {}}
OBJECT = {
    "id": OBJECT_ID, "name": "测试待办", "doctype": "ToDo", "version": "1.0.0", "schema_version": 1,
    "operations": ["read"],
    "fields": [{"id": "description", "label": "描述", "type": "text"},
               {"id": "status", "label": "状态", "type": "choice"},
               {"id": "date", "label": "日期", "type": "date"},
               {"id": "modified", "label": "更新时间", "type": "text"}],
    "native_table": {"doctype": "ToDo", "title": "测试待办", "version_field": "modified",
                     "fields": [{"id": "description", "label": "描述", "type": "text", "required": True},
                                {"id": "status", "label": "状态", "type": "choice", "options": ["Open", "Closed", "Cancelled"]},
                                {"id": "date", "label": "日期", "type": "date"}],
                     "read_roles": ["Desk User"], "write_roles": ["Desk User"], "search_fields": ["description"],
                     "write": {"update_action": UPDATE_ACTION, "create_action": CREATE_ACTION,
                               "name_param": "name", "version_param": "expected_version"}},
}
ACTIONS = {
    UPDATE_ACTION: {"id": UPDATE_ACTION, "handler": "shangshu_core.tests.test_native_table._write_todo"},
    CREATE_ACTION: {"id": CREATE_ACTION, "handler": "shangshu_core.tests.test_native_table._create_todo"},
}


def _write_todo(action_id, payload, context):
    if not context.get("confirmed"):
        frappe.throw("测试动作需要确认", frappe.ValidationError)
    doc = frappe.get_doc("ToDo", payload["name"], for_update=True)
    if str(doc.modified) != str(payload["expected_version"]):
        frappe.throw("待办已被修改", frappe.TimestampMismatchError)
    for key in ("description", "status", "date"):
        if key in payload:
            doc.set(key, payload[key])
    doc.save(ignore_permissions=True)
    context["record_change"] = {"doctype": "ToDo", "name": doc.name, "data": {"operation": "test-update"}}
    return {"name": doc.name, "modified": str(doc.modified)}


def _create_todo(action_id, payload, context):
    if not context.get("confirmed"):
        frappe.throw("测试动作需要确认", frappe.ValidationError)
    doc = frappe.get_doc({"doctype": "ToDo", "description": payload["description"]})
    if payload.get("status"):
        doc.status = payload["status"]
    doc.insert(ignore_permissions=True)
    context["record_change"] = {"doctype": "ToDo", "name": doc.name, "data": {"operation": "test-create"}}
    return {"name": doc.name, "modified": str(doc.modified)}


class TestNativeObjectTable(FrappeTestCase):
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
        register_action(UPDATE_ACTION, "1.0.0", "测试原生待办修改", "write", "required", ["Desk User"],
                        {"type": "object", "additionalProperties": False, "required": ["name", "expected_version"],
                         "properties": {"name": {"type": "string"}, "expected_version": {"type": "string"},
                                        "description": {"type": "string"}, "status": {"type": "string"},
                                        "date": {"type": "string"}}}, {}, 30, "none")
        register_action(CREATE_ACTION, "1.0.0", "测试原生待办新建", "write", "required", ["Desk User"],
                        {"type": "object", "additionalProperties": False, "required": ["description"],
                         "properties": {"description": {"type": "string"}, "status": {"type": "string"}}}, {}, 30, "none")
        self.todo = frappe.get_doc({"doctype": "ToDo", "description": "原始描述-" + self.key}).insert(ignore_permissions=True)

    def _query(self, filters=None):
        from shangshu_core.native_objects import query_records
        return query_records(OBJECT_ID, filters or {}, 1, 30)

    def _update(self, values, expected_modified=None, expected_revision=None, name=None):
        from shangshu_core.native_objects import revision
        payload = {"object_id": OBJECT_ID, "expected_revision": expected_revision or revision(OBJECT_ID),
                   "name": name or self.todo.name, "expected_modified": expected_modified or str(self.todo.modified),
                   "values": values}
        return execute_registered_action("platform.object.update", payload, True, frappe.generate_hash(length=24))["result"]

    def test_unbounded_doctype_cannot_be_declared(self):
        from shangshu_core import native_objects
        self.assertIsNone(native_objects.declared("ToDo"))
        self.assertIsNone(native_objects.declared("erpnext.Sales Order"))
        with self.assertRaises(frappe.ValidationError):
            native_objects.definition("ToDo")

    def test_definition_exposes_table_capabilities(self):
        from shangshu_core.native_objects import definition, revision
        value = definition(OBJECT_ID)
        self.assertEqual(value["source"], "native")
        self.assertIsInstance(value["revision"], int)
        self.assertGreaterEqual(value["revision"], 1)
        self.assertIn("update", value["operations"])
        self.assertIn("create", value["operations"])
        self.assertEqual(value["export"]["service"], "platform.object.export")
        self.assertTrue(value["export"]["available"])
        self.assertEqual([field["id"] for field in value["fields"]], ["description", "status", "date"])
        self.assertEqual(next(field for field in value["fields"] if field["id"] == "status")["options"],
                         ["Open", "Closed", "Cancelled"])
        self.assertEqual(value["revision"], revision(OBJECT_ID))

    def test_query_returns_declared_rows_only(self):
        result = self._query({"$search": "原始描述-" + self.key})
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["rows"][0]["name"], self.todo.name)
        self.assertEqual(set(result["rows"][0]) - {"name", "modified"},
                         {"description", "status", "date"})
        with self.assertRaises(frappe.ValidationError):
            self._query({"unlisted": "x"})

    def test_selected_fields_are_bounded_and_do_not_build_definition(self):
        from shangshu_core import native_objects
        with patch.object(native_objects, 'definition', side_effect=AssertionError('schema not requested')):
            result = native_objects.query_records(OBJECT_ID, {'name': self.todo.name},
                fields=['status'], include_definition=False)
        self.assertEqual(set(result['rows'][0]), {'name', 'modified', 'status'})
        self.assertNotIn('object', result)
        self.assertEqual(result['rows'][0]['status'], 'Open')

    def test_identity_projection_still_searches_declared_description(self):
        from shangshu_core import native_objects
        result = native_objects.query_records(OBJECT_ID, {'$search': '原始描述-' + self.key},
            fields=[], include_definition=False)
        self.assertEqual([row['name'] for row in result['rows']], [self.todo.name])
        self.assertEqual(set(result['rows'][0]), {'name', 'modified'})

    def test_declared_read_filters_do_not_expand_native_write_or_projection(self):
        from shangshu_core import native_objects
        domain, item, block, write, catalog = native_objects.declared(OBJECT_ID)
        # Status is deliberately outside this table surface, but remains an object read filter.
        item = {**item, "filter_fields": ["name", "status"]}
        block = {**block, "fields": [field for field in block["fields"] if field["id"] != "status"]}
        with patch.object(native_objects, "_require", return_value=(domain, item, block, write, catalog)):
            result = self._query({"name": self.todo.name, "status": "Open"})
            self.assertEqual([row["name"] for row in result["rows"]], [self.todo.name])
            self.assertEqual(result["total"], 1)
            self.assertNotIn("status", result["rows"][0])
            self.assertNotIn("status", [field["id"] for field in result["object"]["fields"]])
            self.assertEqual(self._query({"name": self.todo.name, "status": "Closed"})["total"], 0)
            from shangshu_core import objects
            with patch.object(objects, "_native", return_value=True):
                complete = objects.query_object_records(OBJECT_ID, {"name": self.todo.name})
            self.assertEqual(complete["rows"][0]["status"], "Open")
            self.assertNotIn("status", complete["object"]["input_schema"]["properties"])
            readable = native_objects._readable_fields("ToDo") - {"status"}
            with patch("frappe.model.get_permitted_fields", return_value=list(readable)):
                hidden = native_objects.query_records(OBJECT_ID, {"name": self.todo.name}, object_projection=True)
                self.assertNotIn("status", hidden["rows"][0])
                with patch.object(frappe, "get_list") as denied_query:
                    with self.assertRaises(frappe.PermissionError):
                        self._query({"status": "Open"})
                    denied_query.assert_not_called()
            with patch.object(frappe, "get_list") as query:
                with self.assertRaises(frappe.ValidationError):
                    self._query({"allocated_to": "Administrator"})
                query.assert_not_called()
                with patch.object(native_objects, "_roles", return_value=set()):
                    with self.assertRaises(frappe.PermissionError):
                        self._query({"name": self.todo.name})
                query.assert_not_called()
        invalid = {**item, "filter_fields": ["allocated_to"]}
        with patch.object(native_objects, "_require", return_value=(domain, invalid, block, write, catalog)), \
                patch.object(frappe, "get_list") as query:
            with self.assertRaises(frappe.ValidationError):
                self._query({"allocated_to": "Administrator"})
            query.assert_not_called()

    def test_cell_update_routes_through_declared_action(self):
        from shangshu_core.native_objects import revision
        result = self._update({"description": "改后-" + self.key})
        self.assertEqual(result["object_id"], OBJECT_ID)
        self.assertEqual(result["revision"], revision(OBJECT_ID))
        self.assertEqual(frappe.db.get_value("ToDo", self.todo.name, "description"), "改后-" + self.key)

    def test_stale_row_and_revision_are_rejected(self):
        frappe.db.commit()  # The stale request must not roll back the prior fixture creation.
        with self.assertRaises(frappe.TimestampMismatchError):
            self._update({"description": "x"}, expected_modified="2000-01-01 00:00:00.000000")
        with self.assertRaises(frappe.TimestampMismatchError):
            self._update({"description": "x"}, expected_revision=999999)
        self.assertEqual(frappe.db.get_value("ToDo", self.todo.name, "description"), "原始描述-" + self.key)

    def test_unlisted_field_is_rejected(self):
        with self.assertRaises(frappe.PermissionError):
            self._update({"allocated_to": "Administrator"})
        with self.assertRaises(frappe.PermissionError):
            self._update({"native_table": {"doctype": "Role"}})

    def test_create_routes_through_declared_action(self):
        from shangshu_core.native_objects import revision
        payload = {"object_id": OBJECT_ID, "expected_revision": revision(OBJECT_ID),
                   "values": {"description": "新建-" + self.key}}
        result = execute_registered_action("platform.object.create", payload, True, frappe.generate_hash(length=24))["result"]
        self.assertTrue(result["name"])
        self.assertEqual(frappe.db.get_value("ToDo", result["name"], "description"), "新建-" + self.key)

    def test_export_returns_workbook(self):
        from shangshu_core.native_objects import revision
        result = invoke_domain_service("platform.object.export",
                                       {"object_id": OBJECT_ID, "expected_revision": revision(OBJECT_ID),
                                        "filters": {"$search": "原始描述-" + self.key}})
        self.assertTrue(result["filename"].endswith(".xlsx"))
        self.assertEqual(result["total"], 1)
        self.assertTrue(base64.b64decode(result["content_base64"]).startswith(b"PK"))
        with self.assertRaises(frappe.TimestampMismatchError):
            invoke_domain_service("platform.object.export",
                                  {"object_id": OBJECT_ID, "expected_revision": 999999, "filters": {}})

    def test_import_preview_is_read_only_then_confirmed_import_writes(self):
        from shangshu_core.native_objects import revision
        book = Workbook()
        sheet = book.active
        sheet.append(["描述", "状态"])
        sheet.append(["导入新建-" + self.key, "Open"])
        sheet.append(["原始描述-" + self.key, "Closed"])
        stream = BytesIO()
        book.save(stream)
        book.close()
        payload = {"object_id": OBJECT_ID, "expected_revision": revision(OBJECT_ID),
                   "filename": "todo.xlsx", "content_base64": base64.b64encode(stream.getvalue()).decode("ascii"),
                   "sheet": sheet.title, "header_row": 1,
                   "mapping": {"description": 1, "status": 2}, "match_field": "description"}
        before = frappe.db.count("ToDo")
        plan = invoke_domain_service("platform.object.import_preview", dict(payload))
        self.assertEqual(plan["summary"]["create"], 1)
        self.assertEqual(plan["summary"]["update"], 1)
        self.assertEqual(plan["summary"]["errors"], 0)
        self.assertEqual(frappe.db.count("ToDo"), before)
        self.assertEqual(frappe.db.get_value("ToDo", self.todo.name, "status"), "Open")
        result = execute_registered_action("platform.object.import", {**payload, "preview_hash": plan["preview_hash"]},
                                           True, frappe.generate_hash(length=24))["result"]
        self.assertEqual(result["create"], 1)
        self.assertEqual(result["update"], 1)
        self.assertEqual(frappe.db.get_value("ToDo", self.todo.name, "status"), "Closed")
        with self.assertRaises(frappe.ValidationError):
            invoke_domain_service("platform.object.import_preview",
                                  {**payload, "mapping": {"description": 1}, "match_field": "status"})

    def test_import_without_create_action_rejects_unmatched_rows(self):
        from shangshu_core import native_objects
        domain, item, block, write, catalog = native_objects.declared(OBJECT_ID)
        trimmed = {key: value for key, value in write.items() if key != "create_action"}
        book = Workbook()
        sheet = book.active
        sheet.append(["描述"])
        sheet.append(["不存在-" + self.key])
        stream = BytesIO()
        book.save(stream)
        book.close()
        payload = {"object_id": OBJECT_ID, "filename": "todo.xlsx",
                   "content_base64": base64.b64encode(stream.getvalue()).decode("ascii"),
                   "sheet": sheet.title, "header_row": 1,
                   "mapping": {"description": 1}, "match_field": "description"}
        with patch.object(native_objects, "_require", return_value=(domain, item, block, trimmed, catalog)):
            plan = native_objects.import_plan({**payload, "expected_revision": native_objects.revision(OBJECT_ID)})
        self.assertEqual(plan["summary"]["create"], 0)
        self.assertTrue(any("不能新增" in error["message"] for error in plan["errors"]))
