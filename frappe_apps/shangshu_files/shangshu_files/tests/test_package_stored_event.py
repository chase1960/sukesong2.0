# -*- coding: utf-8 -*-
"""判据：**包件交接** —— 成员落文件中心 ＋ 成员清单事件广播（**文件域这一侧**）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_files.tests.test_package_stored_event --skip-test-records

**测试通过 = 下面全部成立**（一句话）：
「文件域**声明**了 `files.package.stored` ⇒ `files.package.store` 把**成员**（连同原包）落进
文件中心（**带目录**、**带血缘**）⇒ **同一个包不重复入库、事件只发一次** ⇒ `files.file`
**能按 `container_sha256` 筛**（血缘可查）⇒ **文件中心里没有别的域 id**（域路径靠各域自己声明，
不是中央清单）。」

**为什么这组判据在文件域这边**（域边界）：
· 事件**由文件域声明**（`fde/设计/契约/处理契约与状态转换.md` §5「谁声明，谁的生死挂在事件上」
  ⇒ 事件必须由**保证长期存在的公共件**声明）⇒ 声明面在文件域，判据就在文件域；
· 「按 `container_sha256` 存成员并广播」这个动作**也在文件域**（域与域之间只走公开 Action；
  文件域**不许** import Host 域的实现）⇒ 落库面在文件域，判据就在文件域。
"""
import base64
import hashlib
import io
import json
import os
import unittest
import zipfile

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase

# 成员清单事件（**文件域声明**）。
EVENT_ID = "files.package.stored"

# 判据自己用的目录（**不是别的域的路径** —— 文件域不许知道谁是谁）。
TEST_DIRECTORY = "/com.shangshu.pkg030-judge/收件"


def _zip_bytes(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _minimal_pdf(marker=b"pkg030"):
    """造一份**最小可解析**的 PDF。

    ⚠️ 为什么不能拿 `b"%PDF-1.4 fake"` 糊弄：Frappe 存 PDF 时会用 pypdf 查一遍
    「里面有没有脚本」⇒ **假 PDF 会当场炸**（`PdfStreamError`）⇒ 判据会被
    环境问题带偏，看不出真问题。
    """
    stream = b"BT /F1 12 Tf 72 720 Td (" + marker + b") Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, xref_at)
    return bytes(out)


LIST_XML = b"<?xml version=\"1.0\" encoding=\"utf-8\"?><list><item><TONGZHISBM>x.pdf</TONGZHISBM></item></list>"
BODY_PDF = _minimal_pdf(b"body")
ATTACH_PDF = _minimal_pdf(b"attach")


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.tests.test_package_stored_event")
class TestPackageStoredEvent(FrappeTestCase):
    """成员落文件中心 ＋ 成员清单事件广播（文件域这一侧）。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.token = hashlib.sha1(("pkg030-%s" % id(self)).encode()).hexdigest()[:10]
        self.seq = 0
        self.entries = {
            "受理通知书/list.xml": LIST_XML,
            "受理通知书/受理通知书.pdf": BODY_PDF,
            "受理通知书/附件1.pdf": ATTACH_PDF,
        }
        self.archive = _zip_bytes(self.entries)
        self.container_sha256 = hashlib.sha256(self.archive).hexdigest()

    def tearDown(self):
        frappe.set_user("Administrator")
        super().tearDown()

    # ---------- 工具 ----------

    def _act(self, name, payload, key=None):
        from shangshu_core.public_api import execute_registered_action

        self.seq += 1
        outcome = execute_registered_action(
            name, payload, confirmed=True,
            idempotency_key=key or "pkg030-judge-%s-%d" % (self.token, self.seq))
        return outcome.get("result") or {}

    def _members(self):
        return [
            {"name": "受理通知书/list.xml", "kind": "list",
             "sha256": hashlib.sha256(LIST_XML).hexdigest(), "size_bytes": len(LIST_XML),
             "content_base64": base64.b64encode(LIST_XML).decode("ascii")},
            {"name": "受理通知书/受理通知书.pdf", "kind": "body",
             "sha256": hashlib.sha256(BODY_PDF).hexdigest(), "size_bytes": len(BODY_PDF),
             "content_base64": base64.b64encode(BODY_PDF).decode("ascii")},
            {"name": "受理通知书/附件1.pdf", "kind": "attachment",
             "sha256": hashlib.sha256(ATTACH_PDF).hexdigest(), "size_bytes": len(ATTACH_PDF),
             "content_base64": base64.b64encode(ATTACH_PDF).decode("ascii")},
        ]

    def _store_payload(self, directory=None):
        return {
            "container_sha256": self.container_sha256,
            "directory": directory or TEST_DIRECTORY,
            "attribution": {"level": "personal"},
            "container": {"file_name": "受理包.zip",
                          "content_base64": base64.b64encode(self.archive).decode("ascii"),
                          "file_sha256": self.container_sha256},
            "members": self._members(),
        }

    def _files_in(self, directory):
        return frappe.get_all("Shangshu File Center File",
                              filters={"directory": directory},
                              fields=["name", "file_name", "directory", "container_sha256",
                                      "current_sha256", "current_size", "status"])

    def _envelopes(self, event_id=EVENT_ID):
        rows = frappe.get_all("Shangshu Event Envelope",
                              filters={"event_id": event_id},
                              fields=["name", "payload_json", "owner_domain", "idempotency_key"])
        return rows

    # ---------- 判据 ①：事件由**文件域**声明 ----------

    def test_1_the_member_manifest_event_is_declared_by_the_file_domain(self):
        """成员清单事件_声明者是文件域_载荷只有事实"""
        from shangshu_files.domain import EVENTS

        declared = [event for event in EVENTS if event.get("id") == EVENT_ID]
        self.assertEqual(len(declared), 1, "文件域没有声明 %s 事件" % EVENT_ID)
        event = declared[0]
        schema = event.get("payload_schema") or {}
        properties = schema.get("properties") or {}
        self.assertIn("container_sha256", properties, "事件载荷里没有原包摘要（血缘断了）")
        self.assertIn("members", properties, "事件载荷里没有成员清单")
        member_schema = properties.get("members") or {}
        member_props = (member_schema.get("items") or {}).get("properties") or {}
        for field in ("name", "kind", "sha256", "size_bytes", "container_sha256"):
            self.assertIn(field, member_props, "成员载荷里缺字段：%s" % field)
        # **不许有结论字段**（「要不要处理」「是不是通知书」是业务域的判断）
        for forbidden in ("action", "decision", "should_process", "is_notice", "notice"):
            self.assertNotIn(forbidden, member_props, "成员载荷里混进了结论字段：%s" % forbidden)
        # 声明者必须是**长期存在的公共件**（文件域），不是业务域
        self.assertEqual(event.get("owner_domain", "com.shangshu.files"), "com.shangshu.files",
                         "事件声明者不是文件域")

    # ---------- 判据 ②：成员真的落进文件中心（带目录、带血缘） ----------

    def test_2_members_land_in_the_file_center_with_directory_and_lineage(self):
        """成员落文件中心_带目录_带血缘"""
        result = self._act("files.package.store", self._store_payload())
        self.assertTrue(result.get("members"), "没有成员入库：%s" % result)

        rows = self._files_in(TEST_DIRECTORY)
        names = {row["file_name"] for row in rows}
        # 成员各是一条文件中心记录（**原包也在** —— 它是备份与血缘凭证）
        self.assertIn("list.xml", names, "清单成员没落进文件中心")
        self.assertIn("受理通知书.pdf", names, "正文成员没落进文件中心")
        self.assertIn("附件1.pdf", names, "附件成员没落进文件中心")
        self.assertIn("受理包.zip", names, "原包没落进文件中心（备份与血缘凭证丢了）")

        # **每个成员带血缘**：container_sha256 ＝ 原包摘要
        for row in rows:
            self.assertEqual(row.get("container_sha256"), self.container_sha256,
                             "文件「%s」没有血缘（container_sha256 不等于原包摘要）" % row["file_name"])

        # 成员清单里的每一件都对得上文件中心里的记录
        for member in result.get("members") or []:
            self.assertTrue(member.get("file"), "成员没有文件编号：%s" % member.get("name"))

    # ---------- 判据 ③：同一个包不重复入库、事件只发一次 ----------

    def test_3_the_same_package_is_not_stored_twice(self):
        """同一个包不重复入库_事件只发一次"""
        key = "pkg030-judge-idem-%s" % self.token
        self._act("files.package.store", self._store_payload(), key=key)
        before = self._files_in(TEST_DIRECTORY)
        envelopes_before = self._envelopes()
        self._act("files.package.store", self._store_payload(), key=key)
        after = self._files_in(TEST_DIRECTORY)
        self.assertEqual(len(before), len(after),
                         "同一个包再来一次，文件中心里多出 %d 条记录" % (len(after) - len(before)))
        self.assertEqual(len(envelopes_before), len(self._envelopes()),
                         "同一个包再来一次，又发了一条成员清单事件")

    # ---------- 判据 ④：`files.file` 能按 `container_sha256` 筛（血缘可查） ----------

    def test_4_the_dataset_can_be_filtered_by_container_sha256(self):
        """files.file_能按 container_sha256 筛"""
        from shangshu_core.public_api import query_dataset
        from shangshu_files.domain import get_contribution

        contribution = get_contribution()
        obj = next(item for item in contribution["objects"] if item["id"] == "files.file")
        self.assertIn("container_sha256", obj.get("filter_fields") or [],
                      "files.file 的可筛字段里没有 container_sha256（血缘查不到）")
        field_ids = [field["id"] for field in obj.get("fields") or []]
        self.assertIn("container_sha256", field_ids, "files.file 的字段里没有 container_sha256")

        self._act("files.package.store", self._store_payload())
        found = query_dataset("files.file", {"container_sha256": self.container_sha256}, 1, 50)
        rows = found.get("rows") or []
        self.assertTrue(rows, "按 container_sha256 筛不到任何文件（血缘查不到）")
        for row in rows:
            self.assertEqual(row.get("container_sha256"), self.container_sha256,
                             "筛出来的行血缘不对")

    # ---------- 判据 ⑤：文件中心不许硬编码别的域 id ----------

    def test_5_the_file_center_does_not_hardcode_other_domain_ids(self):
        """文件中心不许硬编码别的域 id"""
        import re

        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pattern = re.compile(r"com\.shangshu\.(?!files\b)[a-z-]+")
        offenders = []
        for dirpath, dirnames, filenames in os.walk(root):
            if "tests" in dirnames:
                dirnames.remove("tests")
            for filename in filenames:
                if not filename.endswith(".py"):
                    continue
                path = os.path.join(dirpath, filename)
                with open(path, "r", encoding="utf-8") as handle:
                    for number, line in enumerate(handle.read().splitlines(), 1):
                        if line.lstrip().startswith("#"):
                            continue
                        if pattern.search(line):
                            offenders.append("%s:%d" % (os.path.relpath(path, root), number))
        self.assertEqual(offenders, [],
                         "文件中心源码里硬编码了别的域 id（加新域就得改文件中心的代码）：%s" % offenders)

    # ---------- 判据 ⑥：域自己声明的那块路径，文件中心给建出来 ----------

    def test_6_declared_domain_paths_are_created(self):
        """域路径声明_注册时确保路径存在"""
        from shangshu_core.public_api import list_domains
        from shangshu_files.domain_paths import declared_paths, ensure_declared_paths

        ensure_declared_paths()
        declared = declared_paths()
        self.assertTrue(declared, "一个域都没有声明自己在文件中心的路径")
        for item in declared:
            self.assertTrue(frappe.db.exists("Shangshu File Directory", {"path": item["path"]}),
                            "域「%s」声明的路径没建出来：%s" % (item["domain_id"], item["path"]))
        # 再跑一次不报错（幂等）
        ensure_declared_paths()
        # 声明来自**各域自己**（注册表里读出来的），不是文件中心自己编的一张清单
        registered = {row["id"] for row in list_domains(include_disabled=True)}
        for item in declared:
            self.assertIn(item["domain_id"], registered,
                          "路径声明来自一个没注册的域：%s" % item["domain_id"])


if __name__ == "__main__":
    unittest.main()
