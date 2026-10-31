"""内核 · **受管列的「必填」分两档**（2026-10-30 · PKG-133 · W2）。

**测试通过 = 什么成立**（一句话）：

「一列声明 `rules.required = true` **且** `rules.required_backfill = false`
　⇒ ① 模型字段**照样**标 `required`（⇒ 写这一格仍不许空；
　　⇒ harness-values 那三项约束里的「**能不能留空**」是准的）；
　　② 内核那道「现有记录缺少必填值，请先补齐后重试」的闸**不触发**
　　（⇒ **存量不用补齐**）；
　而**不声明** `required_backfill` 的必填列 ⇒ 模型字段**照旧**标 required
　　**且**回填闸**照旧触发**（老口径一个字没改）。」

⚠️ **为什么要有这一档**（用户 2026-10-29 原话）：
　「**你填完方向/途径 ⇒ 这两列标必填**」—— 必填是**从现在起**的，
　**不是**要求把表里那些还没填的行补齐（方向/途径是业务事实，只能人定）。
　⇒ 内核原来把「必填」直接当成「存量也要补」⇒ 真表（15,501 行）改一次就卡死。

⚠️ **为什么「必填」与「要不要回填」要分开**（踩过的坑）：
　模型字段的 `required` **同时**被两处用：① 内核判断「这次改声明要不要回填存量」；
　② harness-values 的「**能不能留空**」（nullable）。⇒ 早先把它拆成「模型不标 required」时，
　② 跟着错了（那一列被说成「可以留空」，可写入口又拒空值 ⇒ 自相矛盾）。
　⇒ 现在只拆①：**模型字段照样 required**，另带一个 `required_backfill` 键给①看。
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


TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}


class TestRequiredForwardOnly(unittest.TestCase):
    """受管列的「必填」两档。"""

    def setUp(self):
        stub = _public_frappe_stub()
        if stub is None:
            self.skipTest("工具区不在（站上布局）⇒ 这条判据离线跑")
        self.installed = stub.install_minimal_frappe()
        self.addCleanup(stub.uninstall_minimal_frappe, self.installed)
        import importlib
        from shangshu_core import promotion_records, model_schema
        self.promotion_records = importlib.reload(promotion_records)
        self.model_schema = importlib.reload(model_schema)

    def _fields(self, columns):
        definition = self.promotion_records.build_definition(
            "必填两档的表", columns, TABLE_ACCESS)
        return {field["id"]: field for field in definition.get("fields") or []}

    # ---------- ① 模型字段：照旧 required（写这一格仍不许空） ----------

    def test_required_without_the_flag_stays_required(self):
        """**没声明** `required_backfill` 的必填列 ⇒ 模型字段**照旧**标 required（老口径没动）。"""
        fields = self._fields([
            {"header": "案号方向", "promoted": True, "field": "case_direction", "type": "text",
             "rules": {"required": True}},
        ])
        self.assertIs(fields["case_direction"]["required"], True,
                      "默认必填列的模型字段不标 required ⇒ 老口径被改动了")
        self.assertNotIn("required_backfill", fields["case_direction"],
                         "没声明的列不该带这个键（带了 ⇒ 每列都算「变了」⇒ 白白全模型改版）")

    def test_forward_only_required_still_marks_the_field_required(self):
        """「从现在起必填」⇒ 模型字段**照样** required（⇒「能不能留空」是准的）。"""
        fields = self._fields([
            {"header": "案号方向", "promoted": True, "field": "case_direction", "type": "text",
             "rules": {"required": True, "required_backfill": False}},
        ])
        self.assertIs(fields["case_direction"]["required"], True,
                      "「从现在起必填」的列没标 required ⇒ 「能不能留空」会说成可以留空")
        self.assertIs(fields["case_direction"].get("required_backfill"), False,
                      "「从现在起必填」的键没带上 ⇒ 回填闸照样会挡人")

    def test_the_other_columns_are_unaffected(self):
        """别的列**一点不受影响**（不声明 `required` ⇒ 照旧不 required，也不带新键）。"""
        fields = self._fields([
            {"header": "案号方向", "promoted": True, "field": "case_direction", "type": "text",
             "rules": {"required": True, "required_backfill": False}},
            {"header": "备注", "promoted": True, "field": "note", "type": "text"},
        ])
        self.assertIs(fields["case_direction"]["required"], True)
        self.assertIs(fields["note"]["required"], False)
        self.assertNotIn("required_backfill", fields["note"])

    def test_the_value_domain_still_travels_with_the_column(self):
        """值域清单**照旧**跟着这列进模型（这一档只动必填，不动清单）。"""
        fields = self._fields([
            {"header": "案号方向", "promoted": True, "field": "case_direction", "type": "text",
             "rules": {"required": True, "required_backfill": False,
                       "options": ["DD", "DF", "FD"], "allow_custom": False}},
        ])
        self.assertEqual((fields["case_direction"].get("value_domain") or {}).get("options"),
                         ["DD", "DF", "FD"])

    # ---------- ② 回填闸：声明了就放行 ----------

    def _plan(self, proposed_field):
        common = {"id": "app-1", "owner": "com.shangshu.app.1", "kind": "record",
                  "access": TABLE_ACCESS, "unique_keys": [], "title": "表",
                  "reference_revisions": [], "schema_version": 1}
        previous = dict(common, fields=[{"id": "case_direction", "label": "案号方向",
                                         "type": "text", "required": False}])
        proposed = dict(common, fields=[proposed_field])
        return self.model_schema.plan_object_change(previous, proposed)

    def test_the_backfill_gate_fires_without_the_flag(self):
        """**没声明** `required_backfill` ⇒ 回填闸**照旧触发**（存量要补齐）。"""
        plan = self._plan({"id": "case_direction", "label": "案号方向", "type": "text",
                            "required": True})
        reasons = [check["reason"] for check in plan["needs_data_check"]]
        self.assertIn("existing_nulls", reasons,
                      "默认必填列的回填闸没触发 ⇒ 老口径被改动了")

    def test_the_backfill_gate_is_skipped_for_forward_only_required(self):
        """「从现在起必填」⇒ 回填闸**不触发**（存量不用补齐）。"""
        plan = self._plan({"id": "case_direction", "label": "案号方向", "type": "text",
                            "required": True, "required_backfill": False})
        reasons = [check["reason"] for check in plan["needs_data_check"]]
        self.assertNotIn("existing_nulls", reasons,
                         "「从现在起必填」仍触发了回填闸 ⇒ 存量还是得补齐")


if __name__ == "__main__":
    unittest.main()
