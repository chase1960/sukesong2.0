"""Pure candidate edits: preserve target/version and reject ambiguous rewrites."""
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[3] / 'frappe_apps/shangshu_core/shangshu_core/proposal_edit.py'
spec = importlib.util.spec_from_file_location('proposal_edit', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ProposalEditTests(unittest.TestCase):
    def test_single_cell_retains_original(self):
        original = {'table': 'A', 'expected_content_version': 7, 'cells': [{'row_id': 'r1', 'header': '编号', 'value': {'type': 'text', 'value': '00123'}}]}
        patched = module.patch_edited_value(original, {'type': 'text', 'value': '00456'})
        self.assertEqual(patched['cells'][0]['value']['value'], '00456')
        self.assertEqual(original['cells'][0]['value']['value'], '00123')
        self.assertEqual(patched['expected_content_version'], 7)
    def test_mail_named_fields_keep_identity_and_other_content(self):
        original = {'mail': 'M1', 'mailbox': 'B1', 'subject': '旧主题', 'body': '<p>旧</p>', 'to': 'user@example.test', 'expected_modified': 'v1'}
        patched = module.patch_edited_value(original, {'subject': {'type': 'text', 'value': '新主题'}, 'body': {'type': 'text', 'value': '<p>新</p>'}})
        self.assertEqual(patched, {**original, 'subject': '新主题', 'body': '<p>新</p>'})
    def test_unknown_field_rejected(self):
        with self.assertRaisesRegex(ValueError, '不存在.*absent'):
            module.patch_edited_value({'subject': '原文'}, {'absent': {'type': 'text', 'value': 'wrong'}})
    def test_identity_and_version_cannot_be_edited(self):
        for key in ['table', 'mail', 'mailbox', 'row_id', 'expected_content_version', 'expected_modified', 'op_id']:
            with self.assertRaisesRegex(ValueError, '目标或版本'):
                module.patch_edited_value({key: 'original'}, {key: {'type': 'text', 'value': 'other'}})
    def test_ambiguous_multiple_cells_rejected(self):
        with self.assertRaisesRegex(ValueError, '不是单值'):
            module.patch_edited_value({'cells': [{'value': 1}, {'value': 2}]}, {'type': 'number', 'value': 3})
    def test_mixed_shapes_rejected(self):
        with self.assertRaisesRegex(ValueError, '混合'):
            module.patch_edited_value({'value': 1, 'subject': '原文'}, {'type': 'text', 'value': '2', 'subject': {'type': 'text', 'value': '错误'}})
    def test_invalid_shapes_rejected(self):
        for value in ['', {}, [], {'subject': 'raw'}, {'type': 'text'}]:
            with self.assertRaises(ValueError):
                module.patch_edited_value({'subject': 'original', 'value': 'x'}, value)
    def test_existing_typed_value_keeps_type_object(self):
        self.assertEqual(module.patch_edited_value({'value': {'type': 'number', 'value': 1}}, {'type': 'number', 'value': 2})['value'], {'type': 'number', 'value': 2})

if __name__ == '__main__':
    unittest.main()
