"""Production search functions; no Frappe instance or customer-data writes."""
import ast
import datetime
import importlib.util
from pathlib import Path
import time
import types
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'frappe_apps/shangshu_files/shangshu_files'
spec = importlib.util.spec_from_file_location('sheet_search', SOURCE / 'sheet_search.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)
namespace = {'datetime': datetime, 'time': time}
tree = ast.parse((SOURCE / 'sheet.py').read_text())
parts = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
         and node.name in ('value_typed', '_literal_text', '_Seg', 'read_payload')]
exec(compile(ast.Module(body=parts, type_ignores=[]), str(SOURCE / 'sheet.py'), 'exec'), namespace)
typed = namespace['value_typed']


class SearchCacheTests(unittest.TestCase):
    def setUp(self):
        search._CACHE.clear()

    def test_same_semantics_for_empty_date_formula_leading_zero_boolean_and_number(self):
        rows = [(None, '', '   ', '00123', 0, False, True, 42, datetime.date(2026, 10, 15), '=SUM(A1)', namespace['_literal_text']('=SUM(B1)')),
                ('跨', '格', 'A', 'B', None)]
        for term in ('00123', '123', '2026-10-15', '=sum', 'true', 'false', '0', '42', '跨', '跨 格', 'a b', '不存在', '\0'):
            with self.subTest(term=term):
                actual, _ = search.search_positions(('site', 'table', 1, 'hash', 1, 11, 2), rows, 11, 2, term, typed)
                expected = search._scan(rows, 11, 2, term, typed)
                self.assertEqual(list(actual), list(expected))

    def test_identity_includes_site_revision_and_hash(self):
        identity = ('site-a', 'table', 1, 'hash-a', 1, 1, 1)
        self.assertEqual(list(search.search_positions(identity, [('old',)], 1, 1, 'old', typed)[0]), [0])
        for identity in [('site-b', 'table', 1, 'hash-a', 1, 1, 1),
                         ('site-b', 'table', 2, 'hash-a', 1, 1, 1),
                         ('site-b', 'table', 2, 'hash-b', 1, 1, 1)]:
            result, status = search.search_positions(identity, [('new',)], 1, 1, 'old', typed)
            self.assertEqual(list(result), [])
            self.assertEqual(status, 'miss')

    def test_new_terms_reuse_text_index_and_repeat_term_reuses_positions(self):
        calls = []
        def convert(raw):
            calls.append(raw)
            return typed(raw)
        key = ('site', 'table', 1, 'hash', 1, 2, 2)
        rows = [('甲', '乙'), ('丙', '丁')]
        first, _ = search.search_positions(key, rows, 2, 2, '甲', convert)
        self.assertEqual(len(calls), 4)
        _, status = search.search_positions(key, rows, 2, 2, '乙', convert)
        self.assertEqual(status, 'hit')
        again, status = search.search_positions(key, rows, 2, 2, '甲', convert)
        self.assertIs(first, again)
        self.assertEqual(status, 'query-hit')
        self.assertEqual(len(calls), 4)

    def test_cache_limits_and_oversized_bypass(self):
        previous = search._MAX_ENTRY_BYTES
        try:
            search._MAX_ENTRY_BYTES = 1100
            result, status = search.search_positions(('big',), [('甲' * 2000,)], 1, 1, '甲', typed)
            self.assertEqual(list(result), [0])
            self.assertEqual(status, 'positions-only')
            self.assertIsNone(search._CACHE[('big',)]['texts'])
            result, status = search.search_positions(('big',), [('甲' * 2000,)], 1, 1, '甲', typed)
            self.assertEqual(status, 'query-hit')
            self.assertEqual(list(result), [0])
        finally:
            search._MAX_ENTRY_BYTES = previous
        for key in range(4):
            for term in range(12):
                search.search_positions((key,), [('abc',)], 1, 1, str(term), typed)
        self.assertLessEqual(len(search._CACHE), search._MAX_ENTRIES)
        self.assertTrue(all(len(e['queries']) <= search._MAX_TERMS for e in search._CACHE.values()))
        self.assertLessEqual(sum(search._entry_bytes(e) for e in search._CACHE.values()), search._MAX_BYTES)

    def test_permission_rechecked_before_cache_or_content(self):
        class DeniedDoc:
            def check_permission(self, _):
                raise PermissionError('denied')
        namespace['frappe'] = types.SimpleNamespace(get_doc=lambda *args: DeniedDoc())
        namespace['DOCTYPE'] = 'file'
        namespace['_content'] = lambda *_: self.fail('unauthorized content read')
        namespace['search_positions'] = lambda *_: self.fail('unauthorized cache read')
        with patch.dict(sys.modules, {'shangshu_files.table_relation_query': types.SimpleNamespace(search_payload=lambda *a:None)}), self.assertRaises(PermissionError):
            namespace['read_payload'](None, {'table': 'file', 'search': 'secret'})


if __name__ == '__main__':
    unittest.main()
