"""旧 files.edit_cells 仅适配坐标；普通与受管值均走统一保存。
无效受管值零写；合法受管值必须更新正式记录与 XLSX；普通值保持可用。
"""
import base64
import json
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

from shangshu_files.tests import promotion_fixture as fixture

#: 夹具表头顺序：金额／日期（受管）＋ 名称／备注（普通）。
HEADER_ROW = 1
FIRST_DATA_ROW = 2
COL_AMOUNT = 1
COL_NAME = 3


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestManagedColumnGuard(FrappeTestCase):
    """旧坐标入口不允许绕过正式记录或字段规则。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.table = None
        self.created = []

    def tearDown(self):
        frappe.set_user("Administrator")
        from shangshu_core import model_records
        for object_id, application_id in self.created:
            try:
                model = frappe.get_doc(model_records.MODEL, object_id)
                frappe.db.commit()
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
            except Exception:
                pass
            try:
                frappe.delete_doc("Shangshu Application Definition", application_id, force=True,
                                  ignore_permissions=True)
            except Exception:
                pass
        # ⚠️ **不删上传的文件记录** —— 与既有判据同一口径（全站判据都留文件）。
        #   ⚠️ 曾试过在 tearDown 里删它 ⇒ **连带把后续上传弄坏**
        #   （Frappe 的 File 行一删，私有目录那条路径就取不到了 ⇒ 下一次 insert 报
        #   FileNotFoundError）⇒ 判据自己不能这么清；残留由单独一次清理脚本按文件名前缀清。
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 准备 ----------

    def _upload(self):
        from shangshu_files import service
        result = service.upload({"file_name": "MC-受管列-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        return self.table

    def _promote(self):
        from shangshu_files import promotion
        promotion.define({"table": self.table,
                          "definition": fixture.definition(fixture.PROMOTED + fixture.ORDINARY)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table)) or {}
        if binding.get("object_id"):
            self.created.append((binding.get("object_id"), binding.get("application_id")))
        return binding

    def _edit_payload(self, column, value="新值"):
        """`files.edit_cells` 的载荷（版本 ＋ 内容修订 ＋ 逐格改动）。"""
        from shangshu_files import service, working_file
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        return {
            "file": self.table,
            "expected_version": int(service.upload_version(doc) or 1),
            "expected_content_revision": int(working_file.content_revision(doc) or 0),
            "changes": [{"sheet": "S-1", "row": FIRST_DATA_ROW, "column": column,
                         "value": {"t": "s", "v": value}}],
        }

    def _cell_value(self, row, column):
        """读回那一格现在的值（用于证明「一个字没变」）。"""
        from shangshu_files import sheet
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        target = [r for r in (probe.get("rows") or []) if r.get("row_index") == row]
        if not target:
            return None
        values = target[0].get("values") or {}
        headers = probe.get("headers") or []
        header = headers[column - 1] if column - 1 < len(headers) else None
        return (values.get(header) or {}).get("value")

    # ---------- MC-01 ----------

    def test_受管列无效值被统一规则拒绝且文件没变(self):
        """数字字段收到文字时，统一写入口拒绝且文件原值不变。"""
        from shangshu_files import cells
        self._upload()
        self._promote()
        before = self._cell_value(FIRST_DATA_ROW, COL_AMOUNT)
        with self.assertRaises(frappe.ValidationError) as caught:
            cells.edit(self._edit_payload(COL_AMOUNT, "偷偷改的数"))
        frappe.db.rollback()
        self.assertTrue(str(caught.exception), "必须带明确拒因")
        self.assertEqual(self._cell_value(FIRST_DATA_ROW, COL_AMOUNT), before,
                         "被拒的改动**还是写进了文件**（两处事实分叉）")

    def test_合法受管值必须同时进入正式记录与文件(self):
        from shangshu_files import cells, promotion, sheet
        self._upload()
        self._promote()
        payload = self._edit_payload(COL_AMOUNT)
        payload['changes'][0]['value'] = {'t': 'n', 'v': 900}
        cells.edit(payload, {'idempotency_key': 'managed-office-' + uuid.uuid4().hex})
        doc = frappe.get_doc(promotion.FILE, self.table)
        rid = sheet._load_meta(doc)['rows'][0]
        self.assertEqual(promotion._load_formal(doc, row_ids=[rid], fields=['amount'])[rid]['amount'], 900)
        self.assertEqual(self._cell_value(FIRST_DATA_ROW, COL_AMOUNT), 900)

    # ---------- MC-02 ----------

    def test_普通列经这条动作改照旧能改(self):
        """同一张表的**普通列** ⇒ 照旧能改（不许把这条动作整条禁掉）。"""
        from shangshu_files import cells
        self._upload()
        self._promote()
        cells.edit(self._edit_payload(COL_NAME, "改过的名称"))
        frappe.db.commit()
        self.assertEqual(self._cell_value(FIRST_DATA_ROW, COL_NAME), "改过的名称",
                         "普通列经这条动作没改成（误禁了）")

    # ---------- MC-03 ----------

    def test_没有受管列的表照旧能改(self):
        """没有受管列的表 ⇒ 这条动作照旧能用（它本来是给自由文件改格用的）。"""
        from shangshu_files import cells
        self._upload()
        cells.edit(self._edit_payload(COL_NAME, "自由文件的改动"))
        frappe.db.commit()
        self.assertEqual(self._cell_value(FIRST_DATA_ROW, COL_NAME), "自由文件的改动",
                         "没有受管列的表被这条闸误伤了")


if __name__ == "__main__":
    unittest.main()
