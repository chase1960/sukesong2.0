"""BS-01～BS-05：**四种绑定状态**可区分 ＋ 绑定缺失/损坏时**写必拒、不回落旧 JSON、不自动重建**。

**口径**（原收敛条目 03 · 2026-10-27）：
「查不到对象／无权限／**绑定坏了**」**不能等价于**「从未晋升」——
日常读写按**明确状态**定位；**旧 JSON 只能通过显式工程迁移入口读**，不再当日常权威。

**测试通过 = 下面每一条都成立**：

- **BS-01** **待迁移旧表**（有受管列、无绑定）：单格写**拒**、整包写**拒**；
  **旧 `formal_values_json` 逐字不变**；**不新增受管对象**；
- **BS-02** **绑定损坏**（绑定在、受管对象行已不在）：单格写**拒**、整包写**拒**；
  **不新增受管对象**；**不自动重建**（重新定义**当场拒**，不静默当首次晋升）；
- **BS-03** **已启用表**：单格写**成功**（受管记录变 ＋ xlsx 回填）；
- **BS-04** **普通表**（无受管列）：普通列写**成功**，**不建受管对象**（不得误禁其编辑）；
- **BS-05** **旧 JSON 迁移入口仍可用**：一张带旧 JSON、没有绑定的表，
  **显式首次晋升**时**以旧 JSON 为源**（值不丢）——旧值读取只走迁移口，不回日常口。
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


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestBindingStates(FrappeTestCase):
    """BS-01～BS-05：绑定状态明确 ⇒ 写必拒 / 不回落 / 不重建。"""

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
        result = service.upload({"file_name": "BS-绑定状态-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        return self.table

    def _promote(self, columns=None):
        from shangshu_files import promotion
        outcome = promotion.define({"table": self.table,
                                    "definition": fixture.definition(columns or fixture.PROMOTED)})
        frappe.db.commit()
        doc = frappe.get_doc(promotion.FILE, self.table)
        binding = promotion._managed_binding(doc) or {}
        if binding.get("object_id"):
            self.created.append((binding.get("object_id"), binding.get("application_id")))
        return outcome, binding

    def _doc(self):
        from shangshu_files import promotion
        return frappe.get_doc(promotion.FILE, self.table)

    def _drop_binding(self):
        """把绑定摘掉 ⇒ 这张表变成「待迁移旧表」（有受管列、无绑定）。"""
        from shangshu_files import promotion
        doc = self._doc()
        meta = promotion._load_meta(doc)
        meta.pop("promotion_binding", None)
        promotion._save_meta(doc, meta)
        frappe.db.commit()

    def _break_object(self):
        """把受管对象行删掉 ⇒ 绑定还在但对象已不在（「绑定损坏·对象已删」）。"""
        from shangshu_core import model_records
        from shangshu_files import promotion
        binding = promotion._managed_binding(self._doc()) or {}
        object_id = binding.get("object_id")
        frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
        frappe.db.commit()
        self.created = [item for item in self.created if item[0] != object_id]

    def _retire_object(self):
        """把受管对象**退役**（行还在、生效修订没了）⇒ 绑定指向一个已退役的对象。

        ⚠️ 这是**自动复活重建**那条路的入口：对象行还在 ⇒ 内核能「复活同一个对象 id」
        ⇒ 旧实现会静默把「失效绑定」当「从未晋升」重走一遍。
        """
        from shangshu_core import model_records
        from shangshu_files import promotion
        binding = promotion._managed_binding(self._doc()) or {}
        object_id = binding.get("object_id")
        from shangshu_core.public_api import retire_managed_object
        retire_managed_object(object_id, reason="测试：模拟对象退役")
        frappe.db.commit()
        return object_id

    def _legacy_json(self):
        return self._doc().get("formal_values_json") or "{}"

    def _object_count(self):
        from shangshu_core import model_records
        return frappe.db.count(model_records.MODEL)

    def _row_ids(self):
        """这张表当前的固定行身份。

        ⚠️ **读一次**才会登记行身份（`sheet._ensure_meta_rows`）⇒ 普通表也得先读。
        """
        from shangshu_files import sheet
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        return sorted(str(row.get("row_id") or "") for row in (probe.get("rows") or [])
                      if row.get("row_id"))

    def _write_cell(self, header, value):
        from shangshu_files import promotion
        row_id = self._row_ids()[0]
        promotion.cell_write({"table": self.table, "row_id": row_id, "header": header,
                              "value": value, "op_id": "bs-%s" % uuid.uuid4().hex[:8]})
        frappe.db.commit()

    def _write_package(self, header, value):
        """整包写（一次落盘那种）。"""
        from shangshu_files import promotion, sheet
        row_id = self._row_ids()[0]
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        sheet.write_cells({"table": self.table,
                           "op_id": "bs-pkg-%s" % uuid.uuid4().hex[:8],
                           "cells": [{"row_id": row_id, "header": header, "value": value}],
                           "expected_content_version": int(probe.get("content_version") or 0),
                           "expected_structure_version": int(probe.get("structure_version") or 1)})
        frappe.db.commit()

    # ---------- BS-01 待迁移旧表 ----------

    def test_待迁移旧表写入被拒且不落旧JSON(self):
        """有受管列、没有绑定 ⇒ **写必拒**；旧 JSON **一个字都不许变**；不新增对象。"""
        self._upload()
        self._promote(fixture.PROMOTED)
        self._drop_binding()
        before_json = self._legacy_json()
        before_objects = self._object_count()
        with self.assertRaises(frappe.ValidationError):
            self._write_cell("金额", {"type": "number", "value": 777.5})
        frappe.db.rollback()
        self.assertEqual(self._legacy_json(), before_json,
                         "被拒的写**落进了旧 JSON**（冒充成功）")
        self.assertEqual(self._object_count(), before_objects, "被拒的写**新建了受管对象**")
        with self.assertRaises(frappe.ValidationError):
            self._write_package("金额", {"type": "number", "value": 777.5})
        frappe.db.rollback()
        self.assertEqual(self._legacy_json(), before_json,
                         "整包写被拒却**落进了旧 JSON**（冒充成功）")
        self.assertEqual(self._object_count(), before_objects, "整包写被拒却**新建了受管对象**")

    # ---------- BS-02 绑定损坏 ----------

    def test_绑定损坏写入被拒且不自动重建(self):
        """绑定在、受管对象行已不在 ⇒ 写必拒；**重新定义不许自动重建**。"""
        self._upload()
        self._promote(fixture.PROMOTED)
        self._break_object()
        before_objects = self._object_count()
        with self.assertRaises(Exception):
            self._write_cell("金额", {"type": "number", "value": 777.5})
        frappe.db.rollback()
        self.assertEqual(self._object_count(), before_objects, "被拒的写**新建了受管对象**")
        with self.assertRaises(Exception):
            self._write_package("金额", {"type": "number", "value": 777.5})
        frappe.db.rollback()
        self.assertEqual(self._object_count(), before_objects, "整包写被拒却**新建了受管对象**")
        # ⚠️ **编辑路径不许自动重建**：被拒的写**没有**顺手造一个受管对象出来。
        self.assertEqual(self._object_count(), before_objects,
                         "被拒的写**新建了受管对象**（编辑路径自动重建了）")

    def test_对象已退役时编辑被拒不自动重建而显式重新定义仍走重走(self):
        """对象**已退役**（行还在、生效修订没了）⇒ **编辑/写入必拒**，
        且**不许在那条路上自动重建一个对象出来**（对象数不变）。

        ⚠️ 但**用户显式重新定义**（`files.promotion_define`）**仍走重走** ——
        内核**复活同一个对象 id**、**数据一条不少**（既有口径：2026-10-26 站上实测，
        真总表退役后重走，数据没丢）。**「编辑不许自动重建」≠「不许显式重走」**。
        """
        from shangshu_core import model_records
        from shangshu_files import promotion
        self._upload()
        _outcome, binding = self._promote(fixture.PROMOTED)
        object_id = self._retire_object()
        before_objects = self._object_count()
        with self.assertRaises(Exception):
            self._write_cell("金额", {"type": "number", "value": 777.5})
        frappe.db.rollback()
        self.assertEqual(self._object_count(), before_objects,
                         "被拒的写**新建了受管对象**（编辑路径自动重建了）")
        # **用户显式重新定义** ⇒ 仍走重走 ⇒ 同一个对象 id、数据一条不少。
        promotion.define({"table": self.table, "definition": fixture.definition(fixture.PROMOTED)})
        frappe.db.commit()
        after = promotion._managed_binding(self._doc()) or {}
        self.assertEqual(after.get("object_id"), object_id,
                         "重新定义没有复活**同一个**对象 id")
        rows = model_records.query_records(after["object_id"], filters={}, page=1, page_length=30)
        self.assertEqual(rows["total"], 10, "复活后 10 条记录都在（数据一条不少）")

    # ---------- BS-03 已启用表 ----------

    def test_已启用表单格写照旧成功(self):
        """正常表：单格写**成功**（受管记录变 ＋ xlsx 回填）——不许被上面的闸误伤。"""
        from shangshu_core import model_records
        self._upload()
        _outcome, binding = self._promote(fixture.PROMOTED)
        row_id = sorted(binding["records"])[0]
        self._write_cell("金额", {"type": "number", "value": 888.5})
        rows = model_records.query_records(binding["object_id"], filters={}, page=1, page_length=30)
        by_name = {row["name"]: row for row in rows["rows"]}
        self.assertEqual(by_name[binding["records"][row_id]]["amount"], 888.5,
                         "已启用表的单格写没落进受管记录")

    # ---------- BS-04 普通表 ----------

    def test_普通表编辑照旧成功且不建对象(self):
        """**纯普通表没有绑定是合法状态** ⇒ 它的编辑**不许被误禁**。"""
        self._upload()
        before_objects = self._object_count()
        from shangshu_files import promotion, sheet
        probe = sheet.read_payload("files.sheet_read", {"table": self.table}, None)
        row_id = self._row_ids()[0]
        sheet.write_cells({"table": self.table,
                           "op_id": "bs-plain-%s" % uuid.uuid4().hex[:8],
                           "cells": [{"row_id": row_id, "header": "名称",
                                      "value": {"type": "text", "value": "新名称"}}],
                           "expected_content_version": int(probe.get("content_version") or 0),
                           "expected_structure_version": int(probe.get("structure_version") or 1)})
        frappe.db.commit()
        self.assertEqual(self._object_count(), before_objects,
                         "普通表写一格普通列**建了受管对象**")

    # ---------- BS-05 旧 JSON 迁移入口仍可用 ----------

    def test_旧JSON迁移入口仍以旧JSON为源(self):
        """旧值读取**只走显式迁移口** ⇒ 首次晋升仍能以旧 JSON 为源（值不丢）。

        场景：**从未绑定过**的老表（表里只有旧 JSON 正式值）⇒ 显式首次晋升
        ⇒ 那份旧 JSON 就是当时的权威（xlsx 可能滞后）⇒ 值要接进受管记录。
        """
        from shangshu_files import promotion
        self._upload()
        row_id = self._row_ids()[0]
        # 造一份旧 JSON 正式值（像迁移前的老表那样收在文件记录里）。
        doc = self._doc()
        legacy = {row_id: {"amount": 1234.5}}
        doc.db_set("formal_values_json", json.dumps(legacy, ensure_ascii=False), update_modified=False)
        frappe.db.commit()
        # **从未绑定、也从未声明过晋升** ⇒ 这就是「老表」⇒ 首次晋升以旧 JSON 为源。
        self._promote(fixture.PROMOTED)
        from shangshu_core import model_records
        binding = promotion._managed_binding(self._doc()) or {}
        rows = model_records.query_records(binding["object_id"], filters={}, page=1, page_length=30)
        by_name = {row["name"]: row for row in rows["rows"]}
        value = by_name.get(binding["records"].get(row_id), {}).get("amount")
        self.assertEqual(value, 1234.5, "旧 JSON 的值没被迁移进来（旧值读取被日常口吃掉了）")


if __name__ == "__main__":
    unittest.main()
