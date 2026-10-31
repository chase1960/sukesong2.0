"""文件只读契约：固定附件定位不依赖名称、不混用内部版本游标。"""
import unittest

from unittest.mock import patch
from shangshu_files import domain
from shangshu_files.domain import get_contribution


class TestReadContract(unittest.TestCase):
    def test_version_lookup_accepts_exactly_one_stable_reference(self):
        service = next(item for item in get_contribution()['services'] if item['id'] == 'files.versions')
        contract = service['input_schema']
        self.assertEqual(set(contract['properties']), {'file', 'attachment'})
        self.assertEqual(contract['required'], [])
        self.assertFalse(contract['additionalProperties'])
        for payload in ({}, {'file': 'record', 'attachment': 'blob'}, {'file': ''}, {'attachment': ''},
                        {'attachment': 'blob', 'file_name': 'guess.pdf'}):
            with self.subTest(payload=payload), patch.object(domain.frappe, 'db', object(), create=True), \
                    patch.object(domain.frappe, 'throw', side_effect=ValueError('invalid')), self.assertRaises(ValueError):
                domain.versions('files.versions', payload, {})

    def test_internal_counter_is_not_labeled_as_version_count(self):
        field = next(item for item in get_contribution()['objects'][0]['fields'] if item['id'] == 'version_count')
        self.assertEqual(field['label'], '下一版本序号')
        self.assertIn('不是版本数', field['description'])
        self.assertIn('files.versions', field['description'])
