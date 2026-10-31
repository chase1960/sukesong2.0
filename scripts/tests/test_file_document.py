"""DOCX局部正文编码回归；内存夹具，不接员工站。"""
import importlib.util
from io import BytesIO
from pathlib import Path
import unittest
import sys
import types
from unittest.mock import Mock, patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('file_document', ROOT / 'frappe_apps/shangshu_files/shangshu_files/document.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def fixture(body=None, extra=None):
    out = BytesIO()
    with ZipFile(out, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', '<w:document xmlns:w="'+W+'"><w:body>'+(body or '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>采购说明</w:t></w:r></w:p><w:p><w:r><w:t>数量150</w:t></w:r></w:p>')+'<w:sectPr/></w:body></w:document>')
        z.writestr('word/header1.xml', '<w:hdr xmlns:w="'+W+'"><w:p><w:r><w:t>企业抬头</w:t></w:r></w:p></w:hdr>')
        z.writestr('word/media/image1.png', b'original-image-bytes')
        for name, value in (extra or {}).items(): z.writestr(name, value)
    return out.getvalue()

class DocumentTests(unittest.TestCase):
    def test_service_authorizes_fixed_attachment_before_content_and_never_writes(self):
        frappe=types.ModuleType('frappe');frappe.get_doc=Mock();frappe.ValidationError=ValueError
        api=types.ModuleType('shangshu_core.public_api');api.get_record_attachments=Mock(side_effect=PermissionError('无权'))
        domain=types.ModuleType('shangshu_files.domain');domain.versions=Mock(return_value={'file':{'file_name':'采购.docx'},'versions':[{'version_no':2,'frappe_file':'fixed2'}]})
        with patch.dict(sys.modules,{'frappe':frappe,'shangshu_core.public_api':api,'shangshu_files.domain':domain}):
            with self.assertRaises(PermissionError):module.invoke('files.document',{'operation':'open','file':'f1','version':2},{})
            frappe.get_doc.assert_not_called()
            api.get_record_attachments.side_effect=None;frappe.get_doc.return_value.get_content.return_value=fixture()
            self.assertTrue(module.invoke('files.document',{'operation':'open','file':'f1','version':2},{})['editable'])
            encoded=module.invoke('files.document',{'operation':'encode','file':'f1','version':2,'changes':[{'key':'p1','text':'230'}]},{})
            self.assertTrue(encoded['content_base64']);frappe.get_doc.return_value.save.assert_not_called()

    def test_replace_body_only_keeps_other_parts_and_paragraph_style(self):
        source = fixture(); opened = module.decode(source)
        self.assertTrue(opened['editable'])
        self.assertEqual([p['text'] for p in opened['paragraphs']], ['采购说明','数量150'])
        result = module.encode(source, [{'key':'p1','text':'数量230 & 交货\n请核对'}])
        self.assertEqual(module.decode(result)['paragraphs'][1]['text'], '数量230 & 交货\n请核对')
        with ZipFile(BytesIO(source)) as a, ZipFile(BytesIO(result)) as b:
            for name in a.namelist():
                if name!='word/document.xml': self.assertEqual(a.read(name),b.read(name))
            self.assertIn(b'<w:b/>', b.read('word/document.xml'))
            self.assertIn(b'<w:jc w:val="center"/>', b.read('word/document.xml'))
        self.assertEqual(module.encode(source, []), source)

    def test_tables_mixed_styles_and_embedded_content_are_not_flattened(self):
        body='<w:p><w:r><w:t>普通</w:t></w:r></w:p><w:p><w:r><w:t>正常</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r></w:p><w:p><w:r><w:drawing/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表中原文</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        source=fixture(body); opened=module.decode(source)
        self.assertFalse(opened['paragraphs'][1]['editable'])
        self.assertFalse(opened['paragraphs'][2]['editable'])
        with self.assertRaises(ValueError): module.encode(source,[{'key':'p1','text':'不可压平'}])
        with ZipFile(BytesIO(module.encode(source,[{'key':'p0','text':'正常修改'}]))) as z:
            self.assertIn('表中原文',z.read('word/document.xml').decode())
            self.assertIn('<w:drawing/>',z.read('word/document.xml').decode())

    def test_same_style_split_runs_and_empty_paragraph(self):
        source=fixture('<w:p><w:r><w:t>拆</w:t></w:r><w:r><w:t>分</w:t></w:r></w:p><w:p/>')
        result=module.encode(source,[{'key':'p0','text':'  原格式  '},{'key':'p1','text':'补充正文'}])
        self.assertEqual([p['text'] for p in module.decode(result)['paragraphs']],['  原格式  ','补充正文'])

    def test_protection_revision_signature_and_macros_read_only(self):
        for extra in [{'word/settings.xml':'<w:settings xmlns:w="'+W+'"><w:documentProtection w:enforcement="1"/></w:settings>'},{'word/settings.xml':'<w:settings xmlns:w="'+W+'"><w:trackRevisions/></w:settings>'},{'_xmlsignatures/sig1.xml':'<signature/>'},{'word/vbaProject.bin':b'macro'}]:
            source=fixture(extra=extra);self.assertFalse(module.decode(source)['editable'])
            with self.assertRaises(ValueError):module.encode(source,[{'key':'p0','text':'修改'}])

    def test_invalid_xml_duplicate_changes_control_chars_and_unknown_keys_rejected(self):
        source=fixture()
        for changes in [[{'key':'p99','text':'无此段'}],[{'key':'p0','text':'x'},{'key':'p0','text':'y'}],[{'key':'p0','text':'\x00'}]]:
            with self.assertRaises(ValueError):module.encode(source,changes)
        with self.assertRaises(ValueError):module.decode(fixture(extra={'word/settings.xml':'<!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>'}))
        with self.assertRaises(ValueError):module.decode(b'not zip')

if __name__=='__main__': unittest.main()
