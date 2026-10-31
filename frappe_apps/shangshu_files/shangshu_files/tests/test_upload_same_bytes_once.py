# -*- coding: utf-8 -*-
"""普通上传保留内容去重，显式新资源保留独立身份（文件域）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_files.tests.test_upload_same_bytes_once --skip-test-records

**测试通过 = 下面全部成立**（一句话）：
「未声明new_resource的**同一份字节**再上传一次 ⇒ 文件中心里**只有一条**记录
（**不另存、不改名、不多算一次**）；
而**同名但内容不同**的件 ⇒ 仍然**各存各的**（不许把不同的东西认成同一件）。」

**为什么要有这一条**（2026-10-28 站上实测撞出来的）：
Host 域上传时带 `new_resource: True`（同名必另存，防的是「同名文件追到新内容」）
⇒ 同一份通知书**再投一次**（重试、换批次重传）就多出一条记录：
站上实测 `200101.pdf` 那份字节在「收件」目录里出现了 **7 条**
（`200101.pdf`／`200101 (2).pdf`／…／`200101 (5).pdf`）——
**字节其实只有一份**（Frappe File 按内容摘要去重），但**文件记录多了一堆**
⇒ 人在文件中心看到的是「同一个文件存了五遍」。

上段是历史问题记录，不能覆盖契约“内容相同不等于同一权限资源”。
现行口径：普通上传未声明新资源时保留去重；new_resource=True必须独立。
同一次来源重试由稳定来源键识别，不靠内容hash跨来源合并。
"""
import base64
import hashlib
import io
import unittest
import zipfile
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


# 判据自己用的目录**前缀**（**不是别的域的路径** —— 文件域不许知道谁是谁）。
# ⚠️ **每次跑用不同的子目录**（带 token）：上一轮跑留下的记录/字节还在那儿
# ⇒ 共用同一个目录会撞「磁盘上那个文件已经被上一轮删了」的坑
# ⇒ 每次一个干净目录 ⇒ 只看**这一轮**的结果。
TEST_DIRECTORY_PREFIX = "/com.shangshu.dedupe-judge"


def _minimal_pdf(marker=b"dedupe"):
    """造一份**最小可解析**的 PDF（假 PDF 会被 Frappe 的脚本检查当场炸）。"""
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


PDF_A = _minimal_pdf(b"same-bytes")
PDF_B = _minimal_pdf(b"other-bytes")


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.tests.test_upload_same_bytes_once")
class TestUploadSameBytesOnce(FrappeTestCase):
    """同一份字节只落一次。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.token = uuid.uuid4().hex[:10]
        self.seq = 0
        # **这一轮专属的目录**（每次都不一样 ⇒ 不撞上一轮的残留）。
        self.directory = "%s/%s/收件" % (TEST_DIRECTORY_PREFIX, self.token)

    def tearDown(self):
        frappe.set_user("Administrator")
        super().tearDown()

    def _rows(self):
        from shangshu_files import service

        return frappe.get_all(service.DOCTYPE,
                              filters={"directory": self.directory, "status": "Active"},
                              fields=["name", "file_name", "current_sha256", "container_sha256", "version_count"],
                              limit_page_length=0)

    def _act(self, name, payload, key=None):
        from shangshu_core.public_api import execute_registered_action

        self.seq += 1
        outcome = execute_registered_action(
            name, payload, confirmed=True,
            idempotency_key=key or "dedupe-judge-%s-%d" % (self.token, self.seq))
        return outcome.get("result") or {}

    def _upload(self, content, file_name, key=None, *, new_resource=None, container_sha256=None):
        # ⚠️ **文件名带 token**：Frappe 按**文件名**在磁盘上找那个文件
        # （上一轮跑删记录时把磁盘文件一起删了 ⇒ 这次同名会指向一个不存在的文件）
        # ⇒ 每轮用**不同的文件名** ⇒ 只看这一轮的结果。
        payload = {
            "file_name": "%s-%s" % (self.token, file_name),
            "content_base64": base64.b64encode(content).decode("ascii"),
            "attribution": {"level": "personal"},
            "directory": self.directory,
            "note": "去重判据",
        }
        if new_resource is not None:
            payload['new_resource'] = new_resource
        if container_sha256 is not None:
            payload['container_sha256'] = container_sha256
        return self._act("files.upload", payload, key=key)

    # ---------- 判据 ----------

    def test_the_same_bytes_are_stored_only_once(self):
        """**同一份字节传两次 ⇒ 文件中心只有一条记录**。"""
        first = self._upload(PDF_A, "通知书A.pdf")
        second = self._upload(PDF_A, "通知书A.pdf")
        rows = self._rows()
        self.assertEqual(len(rows), 1,
                         "同一份字节存了 %d 条：%s" % (len(rows), [(r["name"], r["file_name"]) for r in rows]))
        self.assertEqual(first.get("file"), second.get("file"),
                         "两次上传给了两个文件编号 ⇒ 那不是同一份字节")

    def test_the_same_bytes_under_a_different_name_are_still_one(self):
        """**同一份字节、换个文件名传 ⇒ 还是一条**（认的是字节，不是名字）。"""
        self._upload(PDF_A, "通知书A.pdf")
        self._upload(PDF_A, "另一个名字.pdf")
        rows = self._rows()
        self.assertEqual(len(rows), 1,
                         "同一份字节存了 %d 条：%s" % (len(rows), [(r["name"], r["file_name"]) for r in rows]))

    def test_different_bytes_with_the_same_name_are_kept_apart(self):
        """**同名但内容不同** ⇒ 仍然**各存各的**（不许把不同的东西认成同一件）。"""
        self._upload(PDF_A, "通知书A.pdf", new_resource=True)
        self._upload(PDF_B, "通知书A.pdf", new_resource=True)
        rows = self._rows()
        self.assertEqual(len(rows), 2,
                         "两份不同的字节被认成了一份：%s" % [(r["name"], r["file_name"]) for r in rows])

    def test_the_reused_record_keeps_its_own_name(self):
        """复用已有那条时，**文件名不许被改名**（不要冒出「通知书A (2).pdf」）。"""
        self._upload(PDF_A, "通知书A.pdf")
        self._upload(PDF_A, "通知书A.pdf")
        rows = self._rows()
        self.assertEqual([r["file_name"] for r in rows], ["%s-通知书A.pdf" % self.token],
                         "复用后文件名被改了：%s" % [r["file_name"] for r in rows])

    def test_explicit_new_resources_do_not_merge_identical_bytes_from_two_sources(self):
        first = self._upload(PDF_A, 'list.pdf', new_resource=True, container_sha256='a' * 64)
        second = self._upload(PDF_A, 'list.pdf', new_resource=True, container_sha256='b' * 64)
        self.assertNotEqual(first['file'], second['file'])
        rows = {row['name']: row for row in self._rows()}
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[first['file']]['container_sha256'], 'a' * 64)
        self.assertEqual(rows[second['file']]['container_sha256'], 'b' * 64)
        self.assertEqual(rows[first['file']]['current_sha256'], hashlib.sha256(PDF_A).hexdigest())
        self.assertEqual(rows[first['file']]['version_count'], 2)
        self.assertEqual(rows[second['file']]['version_count'], 2)

    def test_explicit_new_resource_under_another_name_still_has_its_own_identity(self):
        first = self._upload(PDF_A, 'original.pdf', new_resource=True)
        second = self._upload(PDF_A, 'another.pdf', new_resource=True)
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(len(self._rows()), 2)

    def test_same_source_key_replay_does_not_create_another_explicit_resource(self):
        key = 'new-resource-replay-' + self.token
        first = self._upload(PDF_A, 'same-source.pdf', key=key, new_resource=True)
        second = self._upload(PDF_A, 'same-source.pdf', key=key, new_resource=True)
        self.assertEqual(first['file'], second['file'])
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(self._rows()[0]['version_count'], 2)
