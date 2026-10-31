"""内核 · **动作载荷与动作声明对不上时，一律给中文**（2026-10-29 站上实测）。

**测试通过 = 什么成立**（一句话）：

「拿**故意写坏**的动作声明（`properties` 写成数组／`required` 写成数字／
　`enum` 写成数字／`items` 不是对象）去校验 ⇒ 服务端回的是**中文**
　`ValidationError`（**不是**英文 `TypeError`），而且**说得出是声明里的哪一项**；
　再拿一个**键混型**（`'a'` 与 `3` 同时出现）的载荷 ⇒ 也是**中文**
　「动作包含未声明字段」；最后拿**正常**载荷 ⇒ 照旧通过
　（**不许**把闸收得过紧，把合法的声明与载荷判成非法）。」

⚠️ **为什么要有这一件**（用户原话）：
　「新核心报『payload 有未声明字段』时抛**英文 TypeError** ⇒ 要中文错」。
　⇒ 同一个「报未声明字段」的场景，**声明形状不同 ⇒ 有时中文 417、有时英文 500**
　（人看到英文栈只当「服务器坏了」，看不到自己该改哪）。
　⇒ **声明形状**先收成中文；**载荷键混型**按字符串排（键名照原样打印）。
"""
import sys
import unittest
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_core
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))


def _public_frappe_stub():
    """**公共那一份**拟真替身（仓里只许有那一份造 frappe 替身）。"""
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "scripts" / "shangshu_testkit"
        if candidate.is_dir():
            if str(candidate.parent) not in sys.path:
                sys.path.insert(0, str(candidate.parent))
            from shangshu_testkit import frappe_stub
            return frappe_stub
    return None


class TestSchemaShapeGate(unittest.TestCase):
    """声明形状不对 ⇒ 中文，不是英文 TypeError。"""

    def setUp(self):
        stub = _public_frappe_stub()
        if stub is None:
            self.skipTest("工具区不在（站上布局）⇒ 这条判据离线跑")
        self.installed = stub.install_minimal_frappe()
        self.addCleanup(stub.uninstall_minimal_frappe, self.installed)
        import frappe
        self.frappe = frappe
        import importlib
        from shangshu_core import schema_validation
        # ⚠️ **要重新载入**：模块在导入那一刻就把 `frappe` 绑在自己身上了
        #   ⇒ 换一轮替身（每条用例一轮）之后，它还抓着**上一轮**那个 ⇒
        #   抛出来的异常类与这一轮断言的那个**不是同一个** ⇒ 断言抓不住。
        self.schema_validation = importlib.reload(schema_validation)

    def _assert_chinese(self, schema, payload, hint=""):
        """校验必须抛**中文 ValidationError**（不是英文 TypeError）。"""
        with self.assertRaises(self.frappe.ValidationError) as caught:
            self.schema_validation._validate_schema(payload, schema)
        message = str(caught.exception)
        self.assertNotIn("TypeError", message, "抛的是英文 TypeError：%s" % message)
        self.assertTrue(message.strip(), "错误消息是空的（人看不懂）")
        return message

    # ---------- ① 声明写坏 ⇒ 中文，且说得出是哪一项 ----------

    def test_properties_written_as_a_list_is_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": [{"a": {"type": "string"}}]}, {"a": "x"})
        self.assertIn("properties", message, "没说出是声明里的哪一项坏了：%s" % message)

    def test_required_written_as_a_number_is_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string"}}, "required": 3}, {"a": "x"})
        self.assertIn("required", message, "没说出是声明里的哪一项坏了：%s" % message)

    def test_enum_written_as_a_number_is_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string", "enum": 3}}}, {"a": "x"})
        self.assertIn("enum", message, "没说出是声明里的哪一项坏了：%s" % message)

    def test_items_written_as_a_list_is_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "array", "items": ["x"]}}}, {"a": ["x"]})
        self.assertIn("items", message, "没说出是声明里的哪一项坏了：%s" % message)

    def test_additional_properties_written_as_a_string_is_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": "no"},
            {"a": "x"})
        self.assertIn("additionalProperties", message,
                      "没说出是声明里的哪一项坏了：%s" % message)

    # ---------- ② 载荷键混型 ⇒ 中文「未声明字段」 ----------

    def test_mixed_type_keys_are_reported_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": False},
            {"a": "x", 3: "y"})
        self.assertIn("未声明字段", message, "没按「未声明字段」说：%s" % message)

    # ---------- ③ 正常载荷照旧通过（不许把闸收得过紧） ----------

    def test_a_valid_payload_still_passes(self):
        self.schema_validation._validate_schema(
            {"a": "x", "n": 3},
            {"type": "object",
             "properties": {"a": {"type": "string"}, "n": {"type": "integer"}},
             "required": ["a"], "additionalProperties": False})

    def test_missing_required_field_is_still_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}, {})
        self.assertIn("必填", message, "缺必填字段的说法变了：%s" % message)

    def test_undeclared_field_is_still_refused_in_chinese(self):
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": False},
            {"a": "x", "b": "y"})
        self.assertIn("未声明字段", message, "未声明字段的说法变了：%s" % message)

    def test_nested_object_shape_is_also_gated(self):
        """**嵌套层**同样收成中文（不是只在顶层）。"""
        message = self._assert_chinese(
            {"type": "object", "properties": {"a": {"type": "object", "properties": [{"b": {"type": "string"}}]}}},
            {"a": {"b": "x"}})
        self.assertIn("properties", message, "嵌套层没被收成中文：%s" % message)


if __name__ == "__main__":
    unittest.main()
