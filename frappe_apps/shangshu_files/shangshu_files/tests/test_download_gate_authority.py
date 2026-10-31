"""**下载闸按受管对象的正式定义判**（DA-01～DA-03 · 用户 2026-10-26 23:0x 决定二）。

**口径**：「定义有一份权威（受管对象的 compiled 定义），其他配置是生成结果」——
文件侧那份（`sheet_meta_json` 的 `promotion`）**只当输入**，不再自己当生效规则评估。

**测试通过 = 下面每一条都成立**：

- **DA-01** 文件侧那份被改窄（表级 access 收到「无人」）⇒ 下载**仍然放行**
  ⇒ 证明闸读的是**受管对象的正式定义**，不是文件侧那份副本；
- **DA-02** 受管对象的正式定义被改窄（表级 download 收到「无人」）⇒ 下载**被拒**
  ⇒ 证明闸**跟着正式定义走**（哪怕文件侧那份是宽的）；
- **DA-03** 受管对象行不在了（绑定还在）⇒ 下载**放行**（回落文件侧，**不静默收紧**）。

**为什么要有这三条**：改之前闸读文件侧那份 ⇒ 正式定义改了而文件侧副本没同步时，
**读和下载会给出不同答案**（这正是决定二要消掉的隐患）。
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
class TestDownloadGateAuthority(FrappeTestCase):
    """DA-01～DA-03：下载闸以**受管对象的正式定义**为准。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.table = None
        self.created = []
        # ⚠️ **判定必须用非管理员身份** —— 管理员有旁路（闸直接放过）⇒ 测不出判定。
        self.staff = "download-gate-staff-" + uuid.uuid4().hex[:8] + "@example.invalid"
        frappe.get_doc({"doctype": "User", "email": self.staff, "first_name": "下载闸员工",
                        "enabled": 1, "send_welcome_email": 0,
                        "roles": [{"role": "Desk User"}]}).insert(ignore_permissions=True)
        frappe.db.commit()

    def tearDown(self):
        frappe.set_user("Administrator")
        if frappe.db.exists("User", self.staff):
            frappe.delete_doc("User", self.staff, ignore_permissions=True, force=True)
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
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 准备 ----------

    def _prepare(self):
        """上传 → 晋升 → 拿到（文件、受管对象、挂在它上面的 File 行）。"""
        from shangshu_files import promotion, service
        result = service.upload({"file_name": "DA-下载闸-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        promotion.define({"table": self.table, "definition": fixture.definition(fixture.PROMOTED)})
        frappe.db.commit()
        doc = frappe.get_doc(promotion.FILE, self.table)
        binding = promotion._managed_binding(doc) or {}
        self.object_id = binding.get("object_id")
        self.created.append((self.object_id, binding.get("application_id")))
        # 挂一个 File 行（下载闸先查「这文件确实挂在那个记录上」）。
        file_row = frappe.get_doc({
            "doctype": "File",
            "file_name": "DA-下载闸-%s.xlsx" % uuid.uuid4().hex[:6],
            "attached_to_doctype": promotion.FILE,
            "attached_to_name": self.table,
            "content": b"DA",
        }).insert(ignore_permissions=True)
        frappe.db.commit()
        self.file_row = file_row.name
        return doc

    def _gate(self):
        """跑下载闸本身（它抛 ⇒ 拒；不抛 ⇒ 放行）—— **以普通员工身份**跑。"""
        from shangshu_core.public_api import http
        frappe.set_user(self.staff)
        try:
            http._field_acl_gate("Shangshu File Center File", self.table, self.file_row)
        finally:
            frappe.set_user("Administrator")

    def _tamper_file_side(self):
        """把**文件侧**那份（`sheet_meta_json` 的 `promotion.access`）改窄。"""
        from shangshu_files import promotion
        doc = frappe.get_doc(promotion.FILE, self.table)
        meta = json.loads(doc.sheet_meta_json or "{}")
        promo = meta.setdefault("promotion", {})
        promo["access"] = {"read": {"scope": "none"}, "write": {"scope": "none"},
                           "download": {"scope": "none"}}
        for column in promo.get("columns") or []:
            column["access"] = {"read": {"scope": "none"}, "write": {"scope": "none"},
                                "download": {"scope": "none"}}
        doc.sheet_meta_json = json.dumps(meta, ensure_ascii=False)
        doc.save(ignore_permissions=True)
        frappe.db.commit()

    def _tamper_authoritative(self):
        """把**受管对象的正式定义**（compiled／active）改窄。"""
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        compiled = json.loads(model.active_json or "{}")
        compiled["access"] = {"read": {"scope": "global"}, "write": {"scope": "global"},
                              "download": {"scope": "none"}}
        for field in compiled.get("fields") or []:
            if isinstance(field, dict):
                field["access"] = {"read": {"scope": "global"}, "write": {"scope": "global"},
                                   "download": {"scope": "none"}}
        model.active_json = json.dumps(compiled, ensure_ascii=False)
        model.save(ignore_permissions=True)
        frappe.db.commit()

    def _drop_object(self):
        """把受管对象行删掉（绑定还在）—— 模拟「对象已不在」。"""
        from shangshu_core import model_records
        frappe.delete_doc(model_records.MODEL, self.object_id, force=True, ignore_permissions=True)
        frappe.db.commit()
        self.created = []

    # ---------- DA-01 ----------

    def test_文件侧那份改窄了下载仍然放行(self):
        """**改之前**：闸读文件侧那份 ⇒ 这一改就会被拒。
        **改之后**：闸读**受管对象的正式定义** ⇒ 文件侧那份改窄了**不影响**下载。"""
        self._prepare()
        self._tamper_file_side()
        self._gate()  # 不抛 ⇒ 放行

    # ---------- DA-02 ----------

    def test_正式定义改窄了下载被拒(self):
        """**正式定义**收窄 ⇒ 下载被拒（哪怕文件侧那份还是宽的）⇒ 闸跟着权威走。"""
        self._prepare()
        self._tamper_authoritative()
        with self.assertRaises(frappe.PermissionError):
            self._gate()

    # ---------- DA-03 ----------

    def test_受管对象不在了下载不静默收紧(self):
        """受管对象行不在（绑定还在）⇒ **放行**（回落文件侧那份）
        ⇒ **不静默收紧存量下载**（真表证据：站上 881 个带绑定的文件里 641 个对象行已不在）。"""
        self._prepare()
        self._drop_object()
        self._gate()  # 不抛 ⇒ 放行


if __name__ == "__main__":
    unittest.main()
