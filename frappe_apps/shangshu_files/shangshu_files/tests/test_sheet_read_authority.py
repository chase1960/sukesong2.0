"""Read the real page/Action paths with stale workbook values; persistence boundaries are isolated."""
import copy
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest import mock

from shangshu_files.tests import offline_env


class TestSheetReadAuthority(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = offline_env.OfflineEnv()
        cls.env.__enter__()
        cls.modules = cls.env.import_domain('service', 'promotion', 'sheet', 'object_projection',
                                             'table_relations', 'table_relation_query')

    @classmethod
    def tearDownClass(cls):
        cls.env.__exit__(None, None, None)

    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.sheet, self.service, self.promo = [self.modules[n] for n in ('sheet', 'service', 'promotion')]
        self.doc = SimpleNamespace(name='T', status='Active', file_name='table.xlsx', current_sha256='sha',
            modified='v-file', sheet_meta_json='{}', check_permission=mock.Mock())
        self.meta = {'rows': ['r1', 'r2'], 'primary_sheet': 'S', 'structure_version': 1}
        self.entry = {'rows_raw': [(11, 'note1'), (22, 'note2')], 'headers': ['金额', '备注'],
            'sheet_title': 'S', 'sheet_titles': ['S'], 'widths': {}, 'manual_row_heights': {}, 'readonly': '',
            'column_types': ['number', 'text']}
        self.definition = {'promoted': True, 'columns': [
            {'header': '金额', 'field': 'amount', 'type': 'number', 'promoted': True},
            {'header': '备注', 'promoted': False}]}
        self.pending = {}
        self.hidden = set()
        self.formal = mock.Mock(side_effect=self.formal_read)
        self.audit = mock.Mock()
        self.content = mock.Mock(return_value=b'xlsx')
        self.merge = mock.Mock(wraps=self.service.merge_range_read)
        def patch(obj, name, value): self.stack.enter_context(mock.patch.object(obj, name, value, create=True))
        import frappe
        patch(frappe, 'get_doc', lambda *a, **kw: self.doc)
        patch(frappe, 'db', SimpleNamespace(exists=lambda *a: True))
        patch(self.sheet, '_content', self.content)
        patch(self.sheet, '_parsed', lambda *a: (copy.deepcopy(self.entry),
            {'cache': 'hit', 'parse_ms': 0, 'parse_count': 1}))
        patch(self.sheet, '_ensure_meta_rows', lambda *a, **kw: copy.deepcopy(self.meta))
        patch(self.sheet, '_record_op', self.audit)
        patch(self.sheet, 'content_revision', lambda doc: 5)
        patch(self.sheet, '_can_write', lambda doc: True)
        patch(self.sheet, 'strip_notice', lambda content: None)
        patch(self.service, '_can_download', lambda doc: False)
        patch(self.service, '_can_structure', lambda doc: False)
        patch(self.service, 'merge_range_read', self.merge)
        patch(self.promo, 'unreadable_headers', lambda *a, **kw: self.hidden)
        patch(self.promo, 'load_definition', lambda doc: copy.deepcopy(self.definition))
        patch(self.promo, 'formal_state_for_rows', self.formal)
        patch(self.promo, 'writeback_pending', lambda doc: self.pending)
        patch(self.promo, 'column_domains', lambda definition: {})
        patch(self.promo, '_managed_binding', lambda doc: {'object_id': 'O', 'records': {'r1': 'n1', 'r2': 'n2'}})
        patch(self.modules['object_projection'], 'read_access', lambda *a: None)
        patch(self.modules['table_relation_query'], 'search_payload', lambda *a: None)
        patch(self.modules['table_relations'], 'decorate_response', lambda result: result)
        # This old standalone version query must never run in a merged page read.
        patch(self.env.api, 'read_record_versions', mock.Mock(side_effect=AssertionError('duplicate version read')))

    def formal_read(self, doc, row_ids, *, fields):
        return {'values': {rid: ({'amount': 999} if 'amount' in fields else {}) for rid in row_ids},
                'versions': {rid: 'db-version' for rid in row_ids}}

    def read(self, **kwargs):
        return self.sheet.read_payload('files.sheet_read', {'table': 'T', 'row_ids': ['r1'], **kwargs})

    def test_page_value_version_and_copy_audit_use_one_formal_read(self):
        self.pending = {'r1': {'values': {'amount': 999}}}
        result = self.read(headers=['金额', '备注'], op_id='copy')
        self.assertEqual(result['rows'][0]['values']['金额']['value'], 999)
        self.assertEqual(result['rows'][0]['values']['备注']['value'], 'note1')
        self.assertEqual(result['rows'][0]['record_version'], 'db-version')
        self.formal.assert_called_once_with(self.doc, ['r1'], fields=['amount'])
        self.assertEqual(self.audit.call_args.args[3][0]['before'], 999)
        self.assertTrue(result['merged_read'])

    def test_range_action_uses_same_page_read_without_second_merge(self):
        result = self.service._range_read({'table': 'T', 'row_ids': ['r1'], 'headers': ['金额']})
        self.assertEqual(result['rows'][0]['values']['金额']['value'], 999)
        self.assertEqual(self.merge.call_count, 1)
        self.assertEqual(self.formal.call_count, 1)

    def test_empty_fields_reads_only_version(self):
        result = self.read(headers=[])
        self.assertEqual(result['rows'][0]['values'], {})
        self.assertEqual(result['rows'][0]['record_version'], 'db-version')
        self.formal.assert_called_once_with(self.doc, ['r1'], fields=[])

    def test_hidden_official_field_cannot_reappear_after_merge(self):
        self.hidden = {'金额'}
        result = self.read(headers=['金额', '备注'])
        self.assertTrue(result['rows'][0]['values']['金额']['hidden'])
        self.assertIsNone(result['rows'][0]['values']['金额']['value'])

    def test_missing_official_mapping_fails_instead_of_showing_xlsx(self):
        self.formal.side_effect = ValueError('missing record')
        with self.assertRaisesRegex(ValueError, 'missing record'):
            self.read(op_id='copy')
        self.audit.assert_not_called()

    def test_ordinary_sheet_keeps_values_without_formal_read(self):
        self.definition = {'promoted': False, 'columns': []}
        result = self.read(headers=['金额'])
        self.assertEqual(result['rows'][0]['values']['金额']['value'], 11)
        self.formal.assert_not_called()

    def test_pending_search_is_rejected_before_file_or_search_cache(self):
        self.pending = {'r1': {'values': {'amount': 999}}}
        with self.assertRaisesRegex(Exception, '搜索.*恢复|恢复.*搜索'):
            self.read(search='11')
        self.content.assert_not_called()
        self.formal.assert_not_called()

    def test_page_scope_reaches_formal_reader_without_loading_other_rows(self):
        result = self.sheet.read_payload('files.sheet_read', {'table': 'T', 'page': 2,
                                          'page_length': 1, 'headers': ['金额']})
        self.assertEqual([row['row_id'] for row in result['rows']], ['r2'])
        self.formal.assert_called_once_with(self.doc, ['r2'], fields=['amount'])

    def test_search_without_pending_keeps_existing_cached_search(self):
        with mock.patch.object(self.sheet, 'search_positions', wraps=self.sheet.search_positions) as search:
            result = self.read(search='note1', headers=['金额', '备注'])
        self.assertEqual([row['row_id'] for row in result['rows']], ['r1'])
        self.assertEqual(result['rows'][0]['values']['金额']['value'], 999)
        search.assert_called_once()


if __name__ == '__main__':
    unittest.main()
