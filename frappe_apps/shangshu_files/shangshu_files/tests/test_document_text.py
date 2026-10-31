"""**受管文件的正文分段读取**（`files.document_text`）的行为判据。

**为什么要有这个口**：官文**多为 PDF** ⇒「正文从哪来」必须写清楚，
否则各做各的（旧 example 只读 DOCX 段落，PDF 直接说「抽不出」）。

**口径**（2026-10-21 父线定；`fde/开发/计划/执行计划.md` 第二步补充口径）：
读 PDF ＝ **抽它的文字层**（**不是 OCR、不是截图、不是拿模型去看**）；
**按坐标还原成行/段**（分栏通知书：**先左栏后右栏**，不是先上后下）；
**每段带页码**（页内序号也要有）；**没有文字层的页 ⇒ 明说抽不出、请人工填**。

**测试通过 = 什么成立**（一句话）：
「把一份**有文字层**的 PDF 传进来 ⇒ 抽得出正文，**每段带页码与段号**，
**回包说清总段数与取到的固定版本**；把一份**第二页没有文字层**的 PDF 传进来
⇒ **明说第 2 页抽不出、请人工填**，**不返回空内容当正文**；
把一份**分两栏**的 PDF 传进来 ⇒ **左栏整栏在前、右栏在后**（不是先上后下）；
DOCX ⇒ **段号**；文本 ⇒ **行号**；图片 ⇒ **明说没有文字**；
**大文件按需分段**（取第 2 段**不重复**第 1 段）；**原件哈希变了 ⇒ 拒**。」
"""
import base64
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


# —— 真样本：自己造的 PDF（**有文字层** / **某一页没有文字层** / **分两栏**）——

def pdf_bytes(pages):
    """手写一份最小 PDF（`pages`＝每页一行带一行）—— 不用第三方写库，判据自带样本。

    **中文怎么进文字层**：简单字体 + `/Encoding /Differences` 用 `uniXXXX` 字形名
    （pdfium 认这个约定）⇒ 抽出来的就是**真中文**，不是乱码。
    """
    chars = []
    for page in pages:
        for _x, _y, text in page:
            for char in text:
                if char not in chars:
                    chars.append(char)
    codes = {char: 65 + index for index, char in enumerate(chars)}
    differences = " ".join("%d /uni%04X" % (code, ord(char)) for char, code in codes.items())
    contents = []
    for page in pages:
        if not page:
            contents.append(b"")      # 这一页**没有文字层**（扫描件／图片页）
            continue
        blocks = []
        for x, y, text in page:
            blocks.append(("BT /F1 12 Tf %d %d Td <%s> Tj ET"
                           % (x, y, "".join("%02X" % codes[char] for char in text))).encode())
        contents.append(b"\n".join(blocks))
    objects = {}
    page_ids = [4 + 2 * index for index in range(len(contents))]
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = ("<< /Type /Pages /Kids [%s] /Count %d >>"
                  % (" ".join("%d 0 R" % page for page in page_ids), len(contents))).encode()
    objects[3] = ("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding "
                  "<< /Type /Encoding /Differences [%s] >> >>" % differences).encode()
    for index, content in enumerate(contents):
        page_id, content_id = page_ids[index], page_ids[index] + 1
        objects[page_id] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                            "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % content_id).encode()
        objects[content_id] = (b"<< /Length " + str(len(content)).encode()
                               + b" >>\nstream\n" + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += str(number).encode() + b" 0 obj\n" + objects[number] + b"\nendobj\n"
    xref = len(out)
    top = max(objects) + 1
    out += b"xref\n0 %d\n" % top
    out += b"0000000000 65535 f \n"
    for number in range(1, top):
        out += ("%010d 00000 n \n" % offsets[number]).encode()
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (top, xref)
    return bytes(out)


# 一张最小的 1×1 PNG（够当「图片没有文字层」的样本）。
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def docx_bytes(paragraphs):
    """一份最小 DOCX（正文就是那几段）。"""
    import zipfile
    from io import BytesIO

    parts = {
        "[Content_Types].xml":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            + "".join("<w:p><w:r><w:t>%s</w:t></w:r></w:p>" % paragraph for paragraph in paragraphs)
            + '</w:body></w:document>',
    }
    out = BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for name, data in parts.items():
            target.writestr(name, data)
    return out.getvalue()


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.shangshu_files.tests.test_document_text")
class TestDocumentText(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "doc-text-%s" % uuid.uuid4().hex[:8]

    def _upload(self, name, content):
        from shangshu_files import service

        result = service.upload({"file_name": name,
                                 "content_base64": base64.b64encode(content).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        return result["file"]

    def _read(self, payload=None):
        from shangshu_core.public_api import invoke_domain_service

        return invoke_domain_service("files.document_text",
                                      {"file": self.file, **(payload or {})})

    # ---------- ① 有文字层的 PDF ⇒ 抽得出正文，每段带页码与段号 ----------
    def test_a_pdf_with_a_text_layer_gives_paragraphs_with_page_numbers(self):
        content = pdf_bytes([[(72, 700, "官文标题"),
                              (72, 660, "第一段正文"),
                              (72, 640, "第二段正文")]])
        self.file = self._upload("官文-%s.pdf" % self.key, content)
        result = self._read()
        self.assertEqual(result.get("kind"), "pdf", "这不是按 PDF 读的")
        segments = result.get("segments") or []
        self.assertTrue(segments, "有文字层的 PDF 却没抽出正文")
        for segment in segments:
            self.assertEqual(segment.get("page"), 1, "每段都要带页码")
            self.assertTrue(segment.get("paragraph"), "每段都要带页内段号")
            self.assertTrue(segment.get("index"), "每段都要带总序号")
            self.assertTrue(segment.get("text"), "抽出来的段是空的")
        self.assertTrue(result.get("total_segments"), "回包要说清总段数")
        self.assertEqual(result.get("total_segments"), len(segments))
        self.assertTrue(result.get("version"), "回包要说清取到的是哪个固定版本")
        self.assertEqual(result.get("unreadable_pages"), [], "有文字层却说有抽不出的页")
        self.assertEqual(result.get("read_state"), "read")

    # ---------- ② 某一页没有文字层 ⇒ 明说抽不出、请人工填 ----------
    def test_a_page_without_a_text_layer_is_reported_not_faked(self):
        content = pdf_bytes([[(72, 700, "第一页有文字")], []])
        self.file = self._upload("扫描件-%s.pdf" % self.key, content)
        result = self._read()
        self.assertEqual(result.get("unreadable_pages"), [2], "没明说第 2 页抽不出")
        self.assertEqual(result.get("read_state"), "needs_manual", "抽不出的页要标出来")
        self.assertIn("人工", result.get("note") or "", "要说清请人工填")
        for segment in result.get("segments") or []:
            self.assertEqual(segment.get("page"), 1, "不该给没有文字层的页编内容")
            self.assertTrue((segment.get("text") or "").strip(), "空内容不能当正文")

    # ---------- ③ 分两栏 ⇒ 先左栏后右栏（不是先上后下）----------
    def test_a_two_column_pdf_is_read_column_by_column(self):
        # 左右两栏**书写顺序故意交错** ⇒ 直接按内容流拼会乱序
        content = pdf_bytes([[(72, 700, "左栏第一行"), (300, 700, "右栏第一行"),
                              (72, 680, "左栏第二行"), (300, 680, "右栏第二行")]])
        self.file = self._upload("分栏-%s.pdf" % self.key, content)
        result = self._read()
        text = " ".join(segment.get("text") or "" for segment in result.get("segments") or [])
        self.assertIn("左栏第一行", text, "左栏没抽出来")
        self.assertIn("右栏第二行", text, "右栏没抽出来")
        self.assertLess(text.index("左栏第二行"), text.index("右栏第一行"),
                        "分栏要先左栏整栏再右栏（先上后下就是乱序）")

    # ---------- ④ DOCX ⇒ 段号 ----------
    def test_a_docx_gives_numbered_paragraphs(self):
        self.file = self._upload("官文-%s.docx" % self.key,
                                 docx_bytes(["第一段正文", "第二段正文"]))
        result = self._read()
        segments = result.get("segments") or []
        self.assertEqual(result.get("kind"), "docx")
        self.assertEqual(len(segments), 2, "DOCX 的两段没读出来")
        self.assertEqual(segments[0].get("paragraph"), 1, "DOCX 段号不对")
        self.assertEqual(segments[1].get("paragraph"), 2, "DOCX 段号不对")
        self.assertIn("第一段正文", segments[0].get("text") or "")

    # ---------- ⑤ 文本 ⇒ 行号（含编码兜底）----------
    def test_a_text_file_gives_numbered_lines(self):
        self.file = self._upload("正文-%s.txt" % self.key, "第一行\n第二行\n".encode("gb18030"))
        result = self._read()
        segments = result.get("segments") or []
        self.assertEqual(result.get("kind"), "text")
        self.assertTrue(segments, "文本没读出来")
        self.assertEqual(segments[0].get("line"), 1, "文本行号不对")
        self.assertIn("第一行", segments[0].get("text") or "")

    # ---------- ⑥ 图片 ⇒ 没有文字，明说 ----------
    def test_an_image_says_it_has_no_text(self):
        self.file = self._upload("图片-%s.png" % self.key, PNG_1PX)
        result = self._read()
        self.assertEqual(result.get("kind"), "image")
        self.assertEqual(result.get("segments") or [], [], "图片没有文字，不该有正文段")
        self.assertEqual(result.get("read_state"), "needs_manual")
        self.assertIn("人工", result.get("note") or "", "图片要说明白没有文字、请人工填")

    # ---------- ⑦ 大文件按需分段（游标）----------
    def test_the_cursor_returns_the_next_segment_without_repeating_the_first(self):
        # 行距一宽一窄 ⇒ 聚成**好几段**（段与段之间有空行）⇒ 才有「第二段」可取。
        rows = [(72, 700, "第01行"), (72, 680, "第02行"), (72, 620, "第03行"),
                (72, 600, "第04行"), (72, 540, "第05行"), (72, 520, "第06行"),
                (72, 460, "第07行"), (72, 440, "第08行")]
        content = pdf_bytes([rows])
        self.file = self._upload("长文-%s.pdf" % self.key, content)
        first = self._read({"start": 1, "limit": 1})
        second = self._read({"start": 2, "limit": 1})
        self.assertTrue(first.get("segments"), "第一段没读到")
        self.assertTrue(second.get("segments"), "第二段没读到")
        self.assertNotEqual(first["segments"][0].get("index"), second["segments"][0].get("index"),
                            "取第二段却和第一段是同一段")
        self.assertEqual(second["segments"][0].get("index"), 2)
        self.assertNotEqual(first["segments"][0].get("text"), second["segments"][0].get("text"),
                            "取第二段却重复了第一段的内容")
        self.assertEqual(second.get("total_segments"), first.get("total_segments"),
                         "总段数要一致")
        self.assertTrue(second.get("next_start"), "还有下文就该给下一个游标")

    # ---------- ⑧ 原件哈希变了 ⇒ 拒 ----------
    def test_a_changed_original_is_refused(self):
        content = pdf_bytes([[(72, 700, "原件正文")]])
        self.file = self._upload("原件-%s.pdf" % self.key, content)
        # 把**台账里记的原件摘要**改掉（模拟原件被动过、账没跟上）⇒ 必须拒，不能给正文。
        frappe.db.set_value("Shangshu File Center File", self.file, "current_sha256", "0" * 64)
        frappe.db.commit()
        with self.assertRaises(Exception):
            self._read()
        try:
            self._read()
        except Exception as error:  # noqa: BLE001
            self.assertIn("哈希", str(error), "拒因要说清是原件变了")


if __name__ == "__main__":
    unittest.main()
