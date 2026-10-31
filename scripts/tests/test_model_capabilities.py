"""应用设计读模型回归：不连接数据库、不写验收站。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    from shangshu_core import model_records as records
    import shangshu_core.record_lifecycle as record_lifecycle
except ModuleNotFoundError as error:
    # 门禁用**宿主 Python**，没有 Frappe/shangshu_core；本判据必须在站点运行时里跑。
    # 缺运行时记 skip（不算红、也不冒充通过）；证据以容器内实跑为准。
    raise unittest.SkipTest('requires shangshu_core/Frappe runtime; run inside site: %s' % error)


class ModelCapabilityTests(unittest.TestCase):
    def setUp(self):
        # `design_capabilities` 的 `deletion.supported` 读 `compiled['doctype']['name']`
        # 再查表结构（`record_lifecycle.available`）。本判据按模块说明**不连数据库**，
        # 所以补上真实定义必有的 `doctype`，并把表结构检查固定为「未具备」。
        self.active = {"kind":"record","doctype":{"name":"业务记录"},
                       "fields":[{"id":"title","label":"生效名称","type":"text"}],
                       "access":{"read_roles":["Desk User"],"write_roles":["Manager"],"record_scope":"own"}}
        self.model = SimpleNamespace(name="app.object.table",active_revision=2,active_json=json.dumps(self.active),
                                     draft_json=json.dumps({"fields":[{"label":"未发布名称"}]}))
        self.available = patch.object(record_lifecycle, "available", return_value=False)
        self.available.start()

    def tearDown(self):
        self.available.stop()

    def test_projection_uses_active_definition_and_real_operations(self):
        with patch.object(records,"definition",return_value={"operations":["read"]}) as definition, \
             patch.object(records,"_write_restriction",return_value="对象迁移尚未完成，暂不可写入"):
            result=records.design_capabilities(self.model)
        definition.assert_called_once_with(self.model.name)
        self.assertEqual(result["revision"],2)
        self.assertEqual(result["fields"][0]["label"],"生效名称")
        self.assertEqual(result["operations"],["read"])
        self.assertEqual(result["write_roles"],["Manager"])
        self.assertEqual(result["deletion"],{"supported":False,"mode":"recycle","auto_purge":False})
        self.assertIn("暂不可写入",result["reason"])

    def test_unbuilt_and_detail_are_not_independent_crud(self):
        self.model.active_revision=0
        with patch.object(records,"definition") as definition:
            self.assertEqual(records.design_capabilities(self.model)["status"],"unavailable")
            self.model.active_revision=2
            self.model.active_json=json.dumps(dict(self.active,kind="detail"))
            result=records.design_capabilities(self.model)
            self.assertEqual(result["operations"],[])
            self.assertIn("随主记录",result["reason"])
            definition.assert_not_called()

    def test_permission_failure_is_not_green_and_unexpected_errors_propagate(self):
        with patch.object(records,"definition",side_effect=records.frappe.PermissionError("无权查看")):
            result=records.design_capabilities(self.model)
            self.assertEqual(result["status"],"unavailable")
            self.assertEqual(result["operations"],[])
        with patch.object(records,"definition",side_effect=RuntimeError("数据库故障")):
            with self.assertRaises(RuntimeError):records.design_capabilities(self.model)


if __name__ == "__main__":unittest.main()
