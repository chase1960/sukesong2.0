"""指定字段必须到达真实取行语句；内部授权元数据不向调用者泄漏。"""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import model_records as records, record_lifecycle, promotion_records, read_scope, result_sets


def fail(message, kind=ValueError):
    raise kind(message)


class Column:
    def __init__(self, key): self.key = key
    def __eq__(self, value): return lambda row: row.get(self.key) == value
    def isin(self, values): return lambda row: row.get(self.key) in values


class Table:
    def __getattr__(self, key): return Column(key)
    def __getitem__(self, key): return Column(key)


class Query:
    """数据库接缝：记录筛选条件、分页和实际读取 ID，不代替生产授权函数。"""
    def __init__(self, rows, trace, conditions=(), chosen=None, length=None, offset=0):
        self.rows, self.trace, self.conditions = rows, trace, conditions
        self.chosen, self.length, self.start = chosen, length, offset
    def copy(self, **changes):
        values = dict(rows=self.rows, trace=self.trace, conditions=self.conditions,
                      chosen=self.chosen, length=self.length, offset=self.start)
        return Query(**{**values, **changes})
    def where(self, condition): return self.copy(conditions=(*self.conditions, condition))
    def select(self, chosen): return self.copy(chosen=chosen)
    def orderby(self, *args, **kwargs): return self
    def limit(self, length): return self.copy(length=length)
    def offset(self, offset): return self.copy(offset=offset)
    def run(self, **kwargs):
        rows = [row for row in self.rows if all(test(row) for test in self.conditions)]
        if isinstance(self.chosen, str) and self.chosen == 'count': return [[len(rows)]]
        rows = rows[self.start:] if self.length is None else rows[self.start:self.start + self.length]
        names = [row['name'] for row in rows]
        self.trace.append(names)
        return names


class RecordReadProjection(unittest.TestCase):
    def setUp(self):
        self.model = SimpleNamespace(physical_doctype='Managed Row')
        self.compiled = {'kind': 'record', 'fields': [
            {'id': 'title', 'type': 'text', 'deprecated': False},
            {'id': 'amount', 'type': 'decimal', 'deprecated': False},
            {'id': 'secret', 'type': 'text', 'deprecated': False},
            {'id': 'lines', 'type': 'detail', 'target': 'child', 'deprecated': False}],
            'doctype': {'fields': [{'fieldname': f} for f in ('f_title', 'f_amount', 'f_secret', 'f_lines')]}}
        self.row = {'name': 'R1', 'modified': 'v1', 'creation': 'created', 'owner': 'one',
                    'ss_recycled': 0, 'f_title': '案件', 'f_amount': 7, 'f_secret': '隐藏'}
        self.frappe = SimpleNamespace(session=SimpleNamespace(user='one'), throw=fail,
            ValidationError=ValueError, PermissionError=PermissionError, DoesNotExistError=LookupError)
        self.bulk = Mock(return_value=[self.row])
        for target, name, value in (
            (records, 'frappe', self.frappe),
            (read_scope, 'frappe', self.frappe),
            (records, '_load', Mock(return_value=(self.model, self.compiled, {'Desk User'}))),
            (records, '_fields', Mock(side_effect=lambda compiled, roles, *a: [
                field for field in compiled['fields'] if field['id'] != 'secret'])),
            (records, '_bulk_rows', self.bulk),
            (records, '_own', Mock(return_value=True)),
            (record_lifecycle, 'available', Mock(return_value=True)),
        ):
            scoped = patch.object(target, name, value)
            scoped.start()
            self.addCleanup(scoped.stop)

    def test_scalar_selection_avoids_unrequested_detail_and_other_columns(self):
        with patch.object(records, '_record', side_effect=AssertionError('不能整行取文档')), \
                patch.object(records, '_references', wraps=records._references):
            result = records.get_records('object', ['R1'], fields=['amount'])
        self.assertEqual(self.bulk.call_args.args[2],
                         ['name', 'modified', 'creation', 'owner', 'ss_recycled', 'f_amount'])
        self.assertEqual(result, {'R1': {'name': 'R1', 'modified': 'v1', 'creation': 'created', 'amount': 7}})

    def test_empty_projection_returns_only_identity_and_versions(self):
        result = records.get_records('object', ['R1'], fields=[])
        self.assertEqual(set(result['R1']), {'name', 'modified', 'creation'})
        self.assertEqual(self.bulk.call_args.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled'])

    def test_fixed_metadata_fields_are_valid_but_owner_is_not_public(self):
        result = records.get_records('object', ['R1'], fields=['name', 'modified', 'creation', 'amount'])
        self.assertEqual(set(result['R1']), {'name', 'modified', 'creation', 'amount'})
        with self.assertRaises(ValueError):
            records.get_records('object', ['R1'], fields=['owner'])

    def test_hidden_or_unknown_field_is_rejected_before_record_query(self):
        for fields, error in ((['secret'], PermissionError), (['invented'], ValueError)):
            with self.subTest(fields=fields), self.assertRaises(error):
                records.get_records('object', ['R1'], fields=fields)
        self.bulk.assert_not_called()

    def test_empty_rows_stay_empty_and_missing_scope_is_not_full_read(self):
        self.assertEqual(records.get_records('object', [], fields=['amount']), {})
        self.bulk.assert_not_called()
        with self.assertRaises(ValueError):
            records.get_records('object', None, fields=['amount'])

    def test_projection_cannot_skip_owner_or_recycle_checks(self):
        self.row['owner'] = 'other'
        with self.assertRaises(PermissionError):
            records.get_records('object', ['R1'], fields=[])
        self.row['owner'] = 'one'
        self.row['ss_recycled'] = 1
        with self.assertRaises(ValueError):
            records.get_records('object', ['R1'], fields=['amount'])

    def test_target_must_exist_even_for_empty_projection(self):
        self.bulk.return_value = []
        with self.assertRaises(LookupError):
            records.get_records('object', ['R1'], fields=[])

    def test_requested_detail_is_read_by_parent_scope_without_other_parent_columns(self):
        class Row(dict):
            __getattr__ = dict.get
        child = {'fields': [{'id': 'amount', 'type': 'decimal'}, {'id': 'secret', 'type': 'text'}],
                 'doctype': {'name': 'Managed Child', 'fields': [
                     {'fieldname': 'c_amount'}, {'fieldname': 'c_secret'}]}}
        child_rows = Mock(return_value=[Row(name='L1', parent='R1', idx=1, c_amount=3)])
        with patch.object(records, '_references', return_value={'child': child}), \
                patch.object(self.frappe, 'get_all', child_rows, create=True):
            result = records.get_records('object', ['R1'], fields=['lines'])
        self.assertEqual(self.bulk.call_args.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled'])
        self.assertEqual(child_rows.call_args.kwargs['filters'], {
            'parent': ['in', ['R1']], 'parenttype': 'Managed Row', 'parentfield': 'f_lines'})
        self.assertEqual(child_rows.call_args.kwargs['fields'], ['name', 'parent', 'idx', 'c_amount'])
        self.assertEqual(result['R1']['lines'], [{'amount': 3, '_row_id': 'L1'}])
        self.assertNotIn('secret', result['R1']['lines'][0])

    def test_reference_labels_are_batched_only_for_requested_targets(self):
        self.compiled['fields'].append({'id': 'customer', 'type': 'reference', 'target': 'customers'})
        self.compiled['doctype']['fields'].append({'fieldname': 'f_customer'})
        target = SimpleNamespace(physical_doctype='Customer Row')
        schema = {'fields': [{'id': 'title', 'type': 'text'}, {'id': 'notes', 'type': 'long_text'}],
                  'doctype': {'fields': [{'fieldname': 'c_title'}, {'fieldname': 'c_notes'}]}}
        parent_rows = [{**self.row, 'name': 'R%d' % i, 'f_customer': 'C%d' % i} for i in range(1, 4)]
        def loaded(object_id):
            return ((target, schema, {'Desk User'}) if object_id == 'customers'
                    else (self.model, self.compiled, {'Desk User'}))
        def fetch(doctype, names, fields):
            if doctype == 'Managed Row':
                return parent_rows
            return [{'name': 'C1', 'owner': 'one', 'ss_recycled': 0, 'c_title': '客户甲'},
                    {'name': 'C2', 'owner': 'other', 'ss_recycled': 0, 'c_title': '不可泄漏'}]
        self.bulk.side_effect = fetch
        with patch.object(records, '_load', side_effect=loaded) as load, \
                patch.object(records, '_record', side_effect=AssertionError('关联标签不能逐行读全记录')):
            result = records.get_records('object', ['R1', 'R2', 'R3'], fields=['customer'])
        self.assertEqual(self.bulk.call_count, 2)
        self.assertEqual(self.bulk.call_args.args,
                         ('Customer Row', ['C1', 'C2', 'C3'], ['name', 'owner', 'ss_recycled', 'c_title']))
        self.assertEqual(result['R1']['_display'], {'customer': '客户甲'})
        self.assertEqual(result['R2']['_display'], {'customer': '关联记录不可访问'})
        self.assertEqual(result['R3']['_display'], {'customer': '关联记录不可访问'})
        self.assertEqual(sum(call.args == ('customers',) for call in load.call_args_list), 1)

    def database_scope(self, rows):
        trace = []
        query = Query(rows, trace)
        patches = (
            patch.object(self.frappe, 'qb', SimpleNamespace(
                DocType=lambda doctype: Table(), from_=lambda table: query), create=True),
            patch.object(records, 'Coalesce', lambda field, default: field),
            patch.object(records, 'Count', lambda value: 'count'),
            patch.object(records, 'Criterion', SimpleNamespace(all=lambda tests: lambda row: all(t(row) for t in tests))),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.bulk.side_effect = lambda doctype, names, fields: [row for row in rows if row['name'] in names]
        return trace

    def test_all_bound_read_filters_before_values_and_never_expands_unbound_rows(self):
        rows = [{**self.row, 'name': 'R%d' % i} for i in range(1002)]
        rows[1]['owner'] = 'other'
        rows[2]['ss_recycled'] = 1
        trace = self.database_scope(rows)
        result = records._available_bound_records('object',
            ['R%d' % i for i in range(1001)], fields=['amount'])
        self.assertEqual(len(result), 999)
        self.assertNotIn('R1', result)
        self.assertNotIn('R2', result)
        self.assertNotIn('R1001', result)
        self.assertEqual(len(trace), 3)
        self.assertTrue(all(len(names) <= 500 for names in trace))
        for call in self.bulk.call_args_list:
            self.assertNotIn('R1', call.args[1])
            self.assertNotIn('R2', call.args[1])
            self.assertEqual(call.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled', 'f_amount'])

    def test_query_page_omits_definition_and_selects_only_requested_fields(self):
        self.model.application, self.model.active_revision = 'app', 1
        self.compiled['title'] = '案件'
        self.database_scope([{**self.row, 'name': 'R%d' % i} for i in range(3)])
        caps = {'search_max_length': 200, 'search_fields': ['title'], 'sort_fields': ['name']}
        with patch.object(records, '_subject', return_value={}), \
                patch.object(records, '_fields_for_op', side_effect=lambda c, r, o, s: c['fields']), \
                patch.object(records, '_query_capabilities', return_value=caps), \
                patch.object(records, 'definition', side_effect=AssertionError('分页不装配整份定义')), \
                patch.object(result_sets, 'issue', return_value={'id': 'rs-test'}), \
                patch.object(records.query_receipt, 'build_receipt', return_value={}):
            result = records.query_records('object', page=2, page_length=1,
                                           fields=['amount'], include_definition=False)
        self.assertEqual(result['object'], None)
        self.assertEqual(result['total'], 3)
        self.assertEqual(result['rows'], [{'name': 'R1', 'modified': 'v1', 'creation': 'created', 'amount': 7}])
        self.assertEqual(self.bulk.call_args.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled', 'f_amount'])

    def test_trash_projection_retains_lifecycle_and_requires_its_access(self):
        self.row.update(ss_recycled=1, ss_recycled_at='yesterday', ss_recycled_by='one')
        with patch.object(records, '_subject', return_value={}), \
                patch.object(record_lifecycle, 'require_access') as authorize, \
                patch.object(record_lifecycle, 'metadata', return_value={'state': 'trash'}), \
                patch.object(self.frappe, '_dict', side_effect=lambda row: row, create=True):
            result = records._read_record_batch(self.model, self.compiled, {'Desk User'},
                ['R1'], [self.compiled['fields'][1]], scope='trash')
        authorize.assert_called_once()
        self.assertEqual(result['R1']['_lifecycle'], {'state': 'trash'})
        self.assertEqual(self.bulk.call_args.args[2], ['name', 'modified', 'creation', 'owner', 'ss_recycled',
                                                      'ss_recycled_at', 'ss_recycled_by', 'f_amount'])
        with patch.object(records, '_subject', return_value={}), \
                patch.object(record_lifecycle, 'require_access', side_effect=PermissionError('trash denied')), \
                self.assertRaises(PermissionError):
            records._read_record_batch(self.model, self.compiled, {'Desk User'},
                                      ['R1'], [], scope='trash')

    def test_promoted_read_passes_logical_fields_without_querying_all_objects(self):
        with patch.object(records, 'get_records', return_value={'R1': {
                'name': 'R1', 'modified': 'v1', 'creation': 'created', 'amount': 7}}) as read, \
                patch.object(records, 'query_records', side_effect=AssertionError('不能整对象查')):
            result = promotion_records.read_promoted_values(object_id='object', records={'r1': 'R1'},
                row_ids=['r1'], fields=['amount'])
        read.assert_called_once_with('object', ['R1'], fields=['amount'])
        self.assertEqual(result['values'], {'r1': {'amount': 7}})
        self.assertEqual(result['versions'], {'r1': 'v1'})


if __name__ == '__main__':
    unittest.main()
