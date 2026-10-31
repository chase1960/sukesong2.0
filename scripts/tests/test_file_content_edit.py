"""文件换版并发前置条件单测；不替代真实数据库/域启停验收。"""
import base64
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, install_stub_package


def _throw(message, error=Exception):
    raise error(message)


install_real_environment()
# 真 app 包进 sys.path —— service.py 顶部 `from shangshu_files import directories, access, relations`
# 在手搓的假包上根本没有 relations / facts 这些子模块（加载就 ImportError）。
# 框架依赖（frappe 整棵子模块树）用**桩包**，再把桩调成这个测试要的形状：
# ValidationError=ValueError、TimestampMismatchError=RuntimeError、throw 真的会抛。
# （原来手搓的 types.ModuleType('frappe') 没有 __path__，
#   `from frappe.query_builder.functions import Count` 这类真依赖直接 ModuleNotFoundError。）
frappe = install_stub_package('frappe', ValidationError=ValueError, TimestampMismatchError=RuntimeError,
                              throw=_throw)
install_stub_package('frappe.utils', get_datetime=lambda value: value)
install_stub_package('frappe.utils.file_manager', save_file=Mock())


def _xlsx_bytes():
    """一份**真能解析**的 xlsx —— 上传前那道校验（`safe_open`）要过。"""
    import io
    from openpyxl import Workbook
    book=Workbook();book.active['A1']='编号'
    out=io.BytesIO();book.save(out);return out.getvalue()


class FileContentEditTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/service.py'
        spec = importlib.util.spec_from_file_location('file_content_edit_under_test', path)
        self.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.service)
        # 协作者：directories/access 走真包里的真模块（service.py 顶部那句 import 需要它们真实存在），
        # 测试要控的那点用 Mock 顶掉 —— service.py 每轮重新加载，替换只落在这一份上。
        self.service.directories = Mock()
        self.service.access = Mock()
        self.doc = types.SimpleNamespace(name='f1', file_name='说明.md', status='Active', modified='m1', version_count=3)
        self.service._writable = Mock(return_value=self.doc)
        self.service._append_version = Mock(return_value=3)
        self.service._attribution_of = Mock(return_value=None)
        self.payload = {'file': 'f1', 'content_base64': base64.b64encode(b'edited').decode(),
                        'expected_modified': 'm1', 'expected_version': 2}

    @staticmethod
    def raise_error(error):
        raise error

    def test_stale_content_version_rejected_before_append(self):
        self.payload['expected_version'] = 1
        with self.assertRaisesRegex(RuntimeError, '版本|修改'):
            self.service.new_version(self.payload)
        self.service._append_version.assert_not_called()

    def test_stale_metadata_revision_rejected_before_append(self):
        self.payload['expected_modified'] = 'm0'
        with self.assertRaisesRegex(RuntimeError, '修订|修改'):
            self.service.new_version(self.payload)
        self.service._append_version.assert_not_called()

    def test_old_upload_without_preconditions_remains_compatible(self):
        payload = {key: value for key, value in self.payload.items() if not key.startswith('expected_')}
        self.assertEqual(self.service.new_version(payload), {'file': 'f1', 'version': 3})

    def test_empty_text_can_be_saved_as_new_version_not_uploaded_as_empty_file(self):
        self.payload['content_base64'] = ''
        self.assertEqual(self.service.new_version(self.payload)['version'], 3)
        self.assertEqual(self.service._append_version.call_args.args[1], b'')
        with self.assertRaisesRegex(ValueError, '为空'):
            self.service._read_content('')

    def test_partial_revision_pair_is_rejected(self):
        self.payload.pop('expected_modified')
        with self.assertRaisesRegex(ValueError, '同时|完整'):
            self.service.new_version(self.payload)

    def test_new_workbook_create_only_does_not_append_existing_file(self):
        # 现行口径（三处**有意**改的，不是缺陷）：
        #  ① **同名 xlsx 恒是「新表」** —— 自动改名落新表、旧表不动
        #     （用户 2026-10-20 原话：「这个 excel 以后会有版本的说法吗？不是只有多种表格吗？」）
        #     ⇒ 表格**没有「版本」这个概念**，`create_only` 拦不住它；
        #  ② **同名普通文件** ＋ `create_only` ⇒ 当场拒（不许悄悄追版本）；
        #  ③ 上传前**先验这真是一份能解析的 xlsx**（f18390c66）。
        # 这条判据原来编码的是**旧口径**（「同名 xlsx 追版本、created=0」）⇒ 按现行口径改写；
        # **测的还是同一件事**：新建表格入口不许把已有表悄悄追加成一个版本。
        frappe=sys.modules['frappe']
        def get_value(doctype, filters, field):
            # 同名已存在；**改名后的候选名**没有 ⇒ 自动改名落在「新表 (2).xlsx」
            name=filters.get('file_name') or ''
            return None if name.startswith('新表 (') else 'f1'
        frappe.db=Mock();frappe.db.get_value.side_effect=get_value
        doc=types.SimpleNamespace(name='f1');doc.insert=Mock(return_value=doc);doc.db_set=Mock()
        frappe.get_doc=Mock(return_value=doc)
        self.service.directories.resolve.return_value=types.SimpleNamespace(path='/',name='files-root')
        self.service._apply_attribution=Mock()
        payload={'file_name':'新表.xlsx','content_base64':base64.b64encode(_xlsx_bytes()).decode(),
                 'create_only':True,'attribution':{'level':'personal'}}
        result=self.service.upload(payload)
        self.assertEqual(result['created'],1)                                       # 恒新表，不追版本
        self.service._writable.assert_not_called()                                   # 没有把旧表当版本追加
        self.assertEqual(frappe.get_doc.call_args.args[0]['file_name'],'新表 (2).xlsx')# 自动改名，旧表不动
        # 同名**普通文件** ＋ create_only ⇒ 当场拒，一件都不建
        self.service._append_version.reset_mock()
        payload={'file_name':'说明.txt','content_base64':base64.b64encode(b'plain').decode(),
                 'create_only':True}
        with self.assertRaisesRegex(ValueError,'同名|名称'):self.service.upload(payload)
        self.service._writable.assert_not_called();self.service._append_version.assert_not_called()
        # 同名**普通文件**、不带 create_only ⇒ 追版本（这才是「版本」这个概念还活着的地方）
        payload.pop('create_only')
        self.assertEqual(self.service.upload(payload)['created'],0)

    def test_empty_office_file_and_revoked_write_permission_are_rejected(self):
        self.doc.file_name = '合同.docx'
        self.payload['content_base64'] = ''
        with self.assertRaisesRegex(ValueError, '为空'):
            self.service.new_version(self.payload)
        self.service._writable.side_effect = PermissionError('权限已撤回')
        with self.assertRaises(PermissionError):
            self.service.new_version(self.payload)
        self.service._append_version.assert_not_called()


if __name__ == '__main__':
    unittest.main()
