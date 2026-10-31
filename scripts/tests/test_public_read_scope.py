"""公共范围拒绝隐式全量，不修改权限或把空范围扩大。"""
import types
import unittest
from pathlib import Path
from _f_module_seam import load_module_functions

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/read_scope.py'


def fail(message, error):
    raise error(message)


class TestPublicReadScope(unittest.TestCase):
    def setUp(self):
        fake = types.SimpleNamespace(throw=fail, ValidationError=ValueError)
        self.normalize = load_module_functions(SOURCE, {'normalize_read_scope'},
                                               stubs={'frappe': fake})['normalize_read_scope']

    def test_missing_range_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '不能默认读取整表'):
            self.normalize()

    def test_empty_rows_and_fields_stay_empty(self):
        self.assertEqual(self.normalize(rows=[], fields=[]),
                         {'mode': 'rows', 'purpose': 'interactive', 'rows': [], 'fields': []})

    def test_current_visible_fields_are_not_an_empty_projection(self):
        self.assertIsNone(self.normalize(rows=['r1'])['fields'])

    def test_duplicate_ids_are_stably_deduplicated(self):
        self.assertEqual(self.normalize(rows=['b', 'a', 'b'], fields=['amount', 'amount'])['rows'], ['b', 'a'])

    def test_all_requires_an_explicit_non_interactive_purpose(self):
        with self.assertRaises(ValueError):
            self.normalize({'mode': 'all'})
        for purpose in ['export', 'migration', 'analysis', 'recovery']:
            self.assertEqual(self.normalize({'mode': 'all', 'purpose': purpose})['purpose'], purpose)

    def test_query_is_bounded_by_the_original_query_entry(self):
        self.assertEqual(self.normalize(default_mode='query')['mode'], 'query')
        with self.assertRaises(ValueError):
            self.normalize({'mode': 'query'}, rows=['r1'])

    def test_unknown_keys_and_conflicting_fields_are_rejected(self):
        for scope in [{'row_ids': ['r1']}, {'mode': 'guess'}, {'purpose': 'fast'}]:
            with self.assertRaises(ValueError):
                self.normalize(scope, rows=['r1'])
        with self.assertRaisesRegex(ValueError, '两份不同'):
            self.normalize({'fields': ['a']}, rows=['r1'], fields=['b'])

    def test_no_identity_or_field_name_is_guessed(self):
        for rows in ['r1', [1], [''], [' r1']]:
            with self.assertRaises(ValueError):
                self.normalize(rows=rows)


if __name__ == '__main__':
    unittest.main()
