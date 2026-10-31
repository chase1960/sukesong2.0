"""个人筛选只装配一次授权和匹配集合，不改稳定行身份与筛选口径。"""
import json
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_personal_sheet_view import view


class CountingChoices(list):
    contains_calls = 0

    def __contains__(self, value):
        self.contains_calls += 1
        return super().__contains__(value)


class SheetViewFilterCost(unittest.TestCase):
    def test_in_values_are_prepared_once_not_scanned_for_each_row(self):
        choices = CountingChoices([str(i) for i in range(500)])
        entry = {'headers': ['状态'], 'rows_raw': [['499'], ['x'], [None], ['0']]}
        result = view.project_rows(entry, ['r1', 'r2', 'r3', 'r4'], {
            'filters': [{'column': '状态', 'operator': 'in', 'value': choices}]})
        self.assertEqual([r['row_id'] for r in result], ['r1', 'r4'])
        self.assertEqual(choices.contains_calls, 0, '不能在每一行线性扫整份选值清单')

    def test_projection_only_evaluates_currently_visible_rows(self):
        typed = Mock(side_effect=lambda value: {'value': value})
        with patch.object(view.sheet, 'value_typed', typed):
            result = view.project_rows({'headers': ['状态'], 'rows_raw': [['yes'], ['secret'], ['yes']]},
                ['r1', 'r2', 'r3'], {'filters': [{'column': '状态', 'operator': 'equals', 'value': 'yes'}]},
                allowed_ids={'r1', 'r3'})
        self.assertEqual(result, [{'row_id': 'r1', 'row_index': 2}, {'row_id': 'r3', 'row_index': 4}])
        self.assertEqual(typed.call_count, 2)

    def test_response_reuses_one_current_access_result_and_keeps_deleted_rows_out(self):
        doc = SimpleNamespace(name='table')
        entry = {'headers': ['状态'], 'rows_raw': [['yes'], ['yes'], ['yes']]}
        meta = {'rows': ['r1', 'r2', 'r3'], 'deleted_rows': ['r3'], 'structure_version': 2}
        stored = SimpleNamespace(revision=1, view_json=json.dumps({
            'filters': [{'column': '状态', 'operator': 'equals', 'value': 'yes'}],
            'freeze': {'rows': 0, 'columns': 0}}))
        access = {'allowed_record_ids': ['r1', 'r3']}
        projection = SimpleNamespace(read_access=Mock(return_value=access))
        hidden = Mock(return_value=set())
        with patch.dict(sys.modules, {'shangshu_files.object_projection': projection}), \
                patch.object(view.promotion, 'unreadable_headers', hidden, create=True), \
                patch.object(view.sheet, 'content_revision', return_value=7, create=True), \
                patch.object(view.promotion, 'load_definition', return_value={'columns':[]}, create=True), \
                patch.object(view.promotion, 'promoted_columns', return_value=[], create=True):
            result = view._response(doc, entry, meta, stored)
        projection.read_access.assert_called_once_with(doc, meta['rows'])
        hidden.assert_called_once_with(doc, companion_access=access)
        self.assertEqual(result['rows'], [{'row_id': 'r1', 'row_index': 2}])
        self.assertEqual(result['total_rows'], 1)
        self.assertEqual(result['source_total_rows'], 1)

    def test_in_empty_and_zero_keep_same_display_text_semantics(self):
        entry = {'headers': ['值'], 'rows_raw': [[0], [False], [''], [None], ['0']]}
        rows = view.project_rows(entry, ['n', 'f', 'e', 'null', 's'], {
            'filters': [{'column': '值', 'operator': 'in', 'value': ['', '0']}]})
        self.assertEqual([r['row_id'] for r in rows], ['n', 'e', 'null', 's'])

    def test_managed_filter_uses_authority_not_stale_xlsx_value(self):
        state = {'values': {'r1': {'status': 'yes'}, 'r2': {'status': None}}, 'versions': {'r1': 'v1', 'r2': 'v2'}}
        read = Mock(return_value=state)
        with patch.object(view.promotion, 'load_definition', return_value={}, create=True), \
                patch.object(view.promotion, 'promoted_columns', return_value=[{'header': '状态', 'field': 'status'}], create=True), \
                patch.object(view.promotion, 'formal_state_for_rows', read, create=True):
            values, promoted = view._formal_projection('doc', ['r1', 'r2'], ['状态'])
            rows = view.project_rows({'headers': ['状态'], 'rows_raw': [['old'], ['yes']]}, ['r1', 'r2'],
                {'filters': [{'column': '状态', 'operator': 'equals', 'value': 'yes'}]}, formal=values, promoted=promoted)
        read.assert_called_once_with('doc', ['r1', 'r2'], fields=['status'])
        self.assertEqual([row['row_id'] for row in rows], ['r1'])

    def test_no_filter_or_sort_does_not_read_formal_values(self):
        with patch.object(view.promotion, 'load_definition', side_effect=AssertionError('no dependencies'), create=True):
            self.assertEqual(view._formal_projection('doc', ['r1'], []), ({}, {}))

    def test_clipped_managed_dependency_fails_instead_of_using_old_xlsx(self):
        with patch.object(view.promotion, 'load_definition', return_value={}, create=True), \
                patch.object(view.promotion, 'promoted_columns', return_value=[{'header': '状态', 'field': 'status'}], create=True), \
                patch.object(view.promotion, 'formal_state_for_rows', return_value={'values': {'r1': {}}, 'versions': {'r1': 'v1'}}, create=True):
            with self.assertRaises(PermissionError): view._formal_projection('doc', ['r1'], ['状态'])


if __name__ == '__main__':
    unittest.main()
