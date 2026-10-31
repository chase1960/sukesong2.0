"""正文提案复用文档编解码和原文件换版；测试替身不冒充真实库验收。"""
import importlib
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
# 真 app 包进 sys.path —— 真包能 import，测试才控得住真模块的属性
# （domain.versions / document.invoke / service.new_version 都是真模块上的点）。
install_real_environment()

ROOT=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files'
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
module=importlib.import_module('shangshu_files.paragraphs')

class ParagraphTests(unittest.TestCase):
    def setUp(self):
        self.frappe=types.ModuleType('frappe');self.frappe.ValidationError=ValueError
        def throw(message,error):raise error(message)
        self.frappe.throw=throw
        self.opened={'revision':1,'editable':True,'reason':'','paragraphs':[{'key':'p0','text':'数量230','editable':True,'reason':''},{'key':'p1','text':'复杂','editable':False,'reason':'复杂格式'}]}
        # 真包 + 真子模块（不再是手搓的 types.ModuleType 假包）：
        # paragraphs.py 里是 `from shangshu_files import document, service`
        # ＋ `from shangshu_files.domain import versions`，假包上根本没有这些子模块。
        self.package=importlib.import_module('shangshu_files')
        self.document=importlib.import_module('shangshu_files.document')
        self.service=importlib.import_module('shangshu_files.service')
        self.domain=importlib.import_module('shangshu_files.domain')
        self.document.invoke=Mock(return_value=self.opened)
        self.service._writable=Mock(return_value=types.SimpleNamespace(name='f1'))
        self.service.new_version=Mock(return_value={'file':'f1','version':3})
        self.service.check_content_revision=Mock(return_value=None)
        self.domain.versions=Mock(return_value={'file':{'name':'f1','version':2,'modified':'m2','can_edit':True}})
        self.payload={'file':'f1','expected_version':2,'expected_modified':'m2','changes':[{'key':'p0','text':'数量240'}]}
        self.modules={'frappe':self.frappe,'shangshu_files':self.package,'shangshu_files.domain':self.domain}

    def test_preview_is_bounded_and_rejects_readonly_duplicate_and_unknown_paragraphs(self):
        self.assertEqual(module.preview(self.opened,self.payload['changes']),[{'key':'p0','number':1,'before':'数量230','after':'数量240'}])
        for changes in [[],[{'key':'p1','text':'不可压平'}],[{'key':'p9','text':'不存在'}],self.payload['changes']*2,[{'key':'p0','text':'a'*4001}],[{'key':'p0','text':'\x00'}]]:
            with self.assertRaises(ValueError):module.preview(self.opened,changes)
        self.opened['editable']=False
        with self.assertRaises(ValueError):module.preview(self.opened,self.payload['changes'])

    def test_read_uses_original_authorized_service_and_no_write_even_for_preview(self):
        with patch.dict(sys.modules,self.modules):
            result=module.read('files.paragraphs',{'file':'f1','version':2,'limit':1},{})
            self.assertEqual(result['paragraphs'][0]['text'],'数量230');self.assertEqual(result['next_start'],2)
            self.document.invoke.assert_called_with('files.document',{'operation':'open','file':'f1','version':2},{})
            self.assertEqual(module.read('files.paragraphs',{'file':'f1','version':2,'changes':self.payload['changes']},{})['changes'][0]['before'],'数量230')
            self.package.service.new_version.assert_not_called()
            self.document.invoke.side_effect=PermissionError('撤权')
            with self.assertRaises(PermissionError):module.read('files.paragraphs',{'file':'f1','version':2},{})

    def test_write_checks_original_owner_revision_then_same_new_version_chain(self):
        service=self.package.service;service._writable.return_value=types.SimpleNamespace(name='f1');service.new_version.return_value={'file':'f1','version':3}
        self.document.invoke.side_effect=[self.opened,{'content_base64':'encoded'}]
        with patch.dict(sys.modules,self.modules):
            self.assertEqual(module.edit(self.payload),{'file':'f1','version':3,'changed_paragraphs':1})
            service.new_version.assert_called_once_with({'file':'f1','expected_version':2,'expected_modified':'m2','content_base64':'encoded','note':''})
            service.check_content_revision.side_effect=RuntimeError('版本冲突');self.document.invoke.reset_mock();service.new_version.reset_mock()
            with self.assertRaises(RuntimeError):module.edit(self.payload)
            self.document.invoke.assert_not_called();service.new_version.assert_not_called()
            service._writable.side_effect=PermissionError('不是本人')
            with self.assertRaises(PermissionError):module.edit(self.payload)

    def test_declared_schema_and_tools_do_not_expose_raw_document_encoding(self):
        with patch.dict(sys.modules,{'frappe':self.frappe}):
            domain=importlib.import_module('shangshu_files.domain');validator=importlib.import_module('shangshu_core.schema_validation')
            schema=next(a[3] for a in domain.ACTIONS if a[0]=='files.edit_paragraphs');validator._validate_schema(self.payload,schema)
            contribution=domain.get_contribution();self.assertIn({'id':'files.edit_paragraphs'},contribution['tools'])
            self.assertNotIn({'id':'files.new_version'},contribution['tools'])
            services={s['id']:s for s in contribution['services']};self.assertEqual(services['files.paragraphs']['purpose'],'detail');self.assertEqual(services['files.document']['purpose'],'file_editor')

if __name__=='__main__':unittest.main()
