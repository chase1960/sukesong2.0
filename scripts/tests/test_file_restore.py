"""文件恢复行为的隔离单测；不替代 Frappe 数据库与权限集成验收。"""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import package_with_real_path
from _f_business_access_stub import make_business_access_stub


class FileRestoreTests(unittest.TestCase):
    def setUp(self):
        self.frappe = types.ModuleType('frappe')
        self.frappe.flags = types.SimpleNamespace(shangshu_file_review_write=None)
        self.frappe.ValidationError = ValueError
        self.frappe.TimestampMismatchError = RuntimeError
        self.frappe.throw = lambda message, error: self.raise_error(error(message))
        utils = types.ModuleType('frappe.utils')
        utils.get_datetime = lambda value: value
        manager = types.ModuleType('frappe.utils.file_manager')
        manager.save_file = Mock()
        package = types.ModuleType('shangshu_files')
        package.directories = Mock()
        package.access = Mock()
        # `service.py` 顶部 `from shangshu_files import directories, access, relations`，
        # 且模块级 `from shangshu_files.facts import action_fact, action_fact_query`
        # —— 夹具包缺这两个子模块会 ImportError（F01 定性为夹具错误，不是产品问题）。
        package.relations = Mock()
        facts = types.ModuleType('shangshu_files.facts')
        facts.action_fact = Mock()
        facts.action_fact_query = Mock()
        public = types.ModuleType('shangshu_core.public_api')
        public.get_object_record = Mock(return_value={'record': {'name': 'r1'}})
        # service.py 顶层 `from shangshu_core.public_api import business_access`
        # —— 试用开放策略（PKG-132）后文件域的业务资格闸走这一份 ⇒ 夹具要装上它。
        public.business_access = make_business_access_stub()
        self.public = public
        self.modules = patch.dict(sys.modules, {'frappe': self.frappe, 'frappe.utils': utils,
            'frappe.utils.file_manager': manager, 'shangshu_files': package,
            'shangshu_files.facts': facts,
            'shangshu_core.public_api': public})
        self.modules.start()
        # 只伪 directories/access 这两个协作者；包本身补 __path__ 指向真目录，
        # 让 service.py 顶层 `from shangshu_files.facts import ...` 加载**真** facts ——
        # 之前伪成裸模块，这行直接 ModuleNotFoundError（F01 第 13 条）。
        package_with_real_path('shangshu_files', Path(__file__).resolve().parents[2] /
                               'frappe_apps/shangshu_files/shangshu_files')
        path = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/service.py'
        spec = importlib.util.spec_from_file_location('file_restore_under_test', path)
        self.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.service)
        self.doc = types.SimpleNamespace(name='f1', status='Recycled', modified='m1',
            relations_json=json.dumps([{'object_id': 'app.items', 'name': 'r1'}]), save=Mock())
        self.service._writable = Mock(return_value=self.doc)
        self.service._check_location = Mock()

    @staticmethod
    def raise_error(error):
        raise error

    def tearDown(self):
        self.modules.stop()

    def test_legacy_restore_keeps_relations(self):
        original = self.doc.relations_json
        self.service.restore({'file': 'f1'})
        self.assertEqual(self.doc.relations_json, original)
        self.assertEqual(self.doc.status, 'Active')

    def test_explicit_restore_checks_current_target(self):
        self.service.restore({'file': 'f1', 'keep_relations': True, 'expected_modified': 'm1'})
        self.public.get_object_record.assert_called_once_with('app.items', 'r1')

    def test_unlink_only_changes_file_relation_not_business_or_versions(self):
        self.service.restore({'file': 'f1', 'keep_relations': False, 'expected_modified': 'm1'})
        self.assertEqual(json.loads(self.doc.relations_json), [])
        self.public.get_object_record.assert_called_once_with('app.items', 'r1')
        self.doc.save.assert_called_once_with(ignore_permissions=True)
        self.assertIsNone(self.frappe.flags.shangshu_file_review_write)

    def test_revoked_target_cannot_be_silently_unlinked(self):
        self.public.get_object_record.side_effect = PermissionError('revoked')
        with self.assertRaises(PermissionError):
            self.service.restore({'file': 'f1', 'keep_relations': False, 'expected_modified': 'm1'})
        self.assertEqual(self.doc.status, 'Recycled')
        self.doc.save.assert_not_called()

    def test_stale_revision_rejected_before_changing_relations(self):
        with self.assertRaises(RuntimeError):
            self.service.restore({'file': 'f1', 'keep_relations': False, 'expected_modified': 'old'})
        self.doc.save.assert_not_called()
        self.assertEqual(self.doc.status, 'Recycled')

    def test_active_file_cannot_use_restore_to_remove_relations(self):
        self.doc.status = 'Active'
        with self.assertRaises(ValueError):
            self.service.restore({'file': 'f1', 'keep_relations': False, 'expected_modified': 'm1'})
        self.doc.save.assert_not_called()

    def test_save_failure_restores_internal_write_flag(self):
        self.doc.save.side_effect = RuntimeError('save failed')
        with self.assertRaises(RuntimeError):
            self.service.restore({'file': 'f1', 'keep_relations': False, 'expected_modified': 'm1'})
        self.assertIsNone(self.frappe.flags.shangshu_file_review_write)

    def test_explicit_policy_requires_snapshot_before_any_write(self):
        with self.assertRaises(ValueError):
            self.service.restore({'file': 'f1', 'keep_relations': False})
        self.doc.save.assert_not_called()
        self.assertEqual(self.doc.status, 'Recycled')


if __name__ == '__main__':
    unittest.main()
