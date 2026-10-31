"""WB-01／WB-04：**核心公共动作写受管列 ⇒ 文件那一格跟着变**（原收敛条目 05）。

**口径**：受管记录的正式值是**唯一权威**，而它还有一份**文件投影**（xlsx 里那一格）
⇒ **正式值变了，投影必须跟着变** —— 不许「谁写的值谁负责补写文件」。

**改之前**：**只有文件域自己的两条写口**（`cell_write`／`formal_write`）会回填；
走**核心公共动作**（`platform.object.update` —— Assistant／自动化／example 走的就是它）
写进去的正式值**不回填** ⇒ 文件与正式值**分叉**（页面读正式值、下载读文件）。

**测试通过 = 下面每一条都成立**：
- **WB-01** 走核心公共动作写一个受管列 ⇒ **文件里那一格的值跟着变**；
- **WB-04** 同一笔写**只回填一次**（文件内容版本**恰 +1**，不是 +2）。

⚠️ **判据要读文件字节，不能读回包** —— 回包会把正式值盖上去 ⇒ 读回包**看不出**
回填有没有发生（那是这条判据最容易踩的坑）。
"""
import base64
import io
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

COL_AMOUNT = 1
FIRST_DATA_ROW = 2


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestCoreActionWriteback(FrappeTestCase):
    """WB-01／WB-04：核心动作写正式值 ⇒ 文件投影跟着变。"""

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
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 准备 ----------

    def _prepare(self):
        """上传 → 晋升 ⇒ 拿到（文件表、受管对象、第一条记录、那格现在的值）。"""
        from shangshu_files import promotion, service
        result = service.upload({"file_name": "WB-核心动作-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        promotion.define({"table": self.table,
                          "definition": fixture.definition(fixture.PROMOTED + fixture.ORDINARY)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table)) or {}
        self.object_id = binding.get("object_id")
        self.created.append((self.object_id, binding.get("application_id")))
        row_id = sorted(binding["records"])[0]
        self.record = binding["records"][row_id]
        return binding

    def _file_cell(self, row, column):
        """**文件字节**里那一格现在的值（不是回包 —— 回包会被正式值盖掉）。"""
        from openpyxl import load_workbook
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        content = sheet._content(doc)   # ⚠️ **只读**（for_write=True 会跟写入自锁）
        book = load_workbook(io.BytesIO(content))
        return book["S-1"].cell(row=row, column=column).value

    def _content_version(self):
        from shangshu_files import sheet
        doc = frappe.get_doc("Shangshu File Center File", self.table)
        return int(sheet.read_payload("files.sheet_read", {"table": self.table}, None)
                   .get("content_version") or 0)

    def _core_update(self, value):
        """**走核心公共动作**写受管列（Assistant／自动化／example 走的就是它）。"""
        from shangshu_core.public_api import execute_registered_action
        from shangshu_core.public_api import domain_execution
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        record = frappe.get_doc(model.physical_doctype, self.record)
        with domain_execution("com.shangshu.core"):
            execute_registered_action(
                "platform.object.update",
                {"object_id": self.object_id, "name": self.record,
                 "expected_revision": model.active_revision,
                 "expected_modified": str(record.modified),
                 "values": {"amount": value}},
                confirmed=True, idempotency_key="wb-core-%s" % uuid.uuid4().hex[:8],
                source="user")
        frappe.db.commit()

    # ---------- WB-01 ----------

    def test_核心动作写受管列文件那一格跟着变(self):
        """核心公共动作写「金额」⇒ **文件里那一格的值跟着变**。

        改之前：只写进数据库，文件里还是旧值 ⇒ 页面读正式值、下载读文件 ⇒ **两处事实分叉**。
        """
        self._prepare()
        before = self._file_cell(FIRST_DATA_ROW, COL_AMOUNT)
        self._core_update(4242.5)
        after = self._file_cell(FIRST_DATA_ROW, COL_AMOUNT)
        self.assertEqual(after, 4242.5,
                         "核心动作写完受管记录，**文件里那一格没跟着变**（两处事实分叉）")
        self.assertNotEqual(after, before, "文件里那一格本来就是这个值（判据没测到东西）")

    # ---------- WB-04 ----------

    def test_同一笔写只回填一次(self):
        """同一笔核心写入 ⇒ 文件内容版本**恰 +1**（回填一次落一次盘，不是两次）。"""
        self._prepare()
        before = self._content_version()
        self._core_update(3131.5)
        after = self._content_version()
        self.assertEqual(after - before, 1,
                         "同一笔写让文件内容版本动了 %d 次（应恰 1 次：只回填一次）"
                         % (after - before))
