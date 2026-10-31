"""DOCX 安全预览：纯解析器测试，不连接业务数据库。"""
import sys
import unittest
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core'))
from shangshu_core.file_preview import parse_docx

def document(xml, extra=None):
    out=BytesIO()
    with ZipFile(out,'w') as z:
        z.writestr('word/document.xml',xml)
        for name,value in (extra or {}).items():z.writestr(name,value)
    return out.getvalue()

class Preview(unittest.TestCase):
    def test_paragraph_table_and_image_notice(self):
        result=parse_docx(document('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>标题 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>编号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>001</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:drawing/></w:p></w:body></w:document>'))
        self.assertEqual(result['blocks'][0],{'type':'paragraph','text':'标题 & 内容'})
        self.assertEqual(result['blocks'][1],{'type':'table','rows':[['编号','001']]})
        self.assertTrue(result['warnings'])
    def test_untrusted_content_remains_text(self):
        result=parse_docx(document('<document><body><p><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></p></body></document>'))
        self.assertEqual(result['blocks'][0]['text'],'<script>alert(1)</script>')
    def test_damaged_or_entities_rejected(self):
        for content in (b'not zip',document('<document>'),document('<!DOCTYPE doc [<!ENTITY a "x">]><document>&a;</document>')):
            with self.assertRaises(ValueError):parse_docx(content)
    def test_missing_document_or_macro_rejected(self):
        for content in (document('<document/>'),document('<document><body/></document>',{'word/vbaProject.bin':b'macro'})):
            with self.assertRaises(ValueError):parse_docx(content)

if __name__=='__main__':unittest.main()
