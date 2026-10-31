"""晋升目标行性能边界：执行真实函数，记录读取范围，不连接站点。

通过只证明本次 K 行走既有授权记录读口、不会全读对象或为版本号生成表格读包。
权限引擎与数据库事务的真实站点回归另外执行，不以本测试的桩代替。
"""
import ast
import copy
import hashlib
import json
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import read_scope

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/promotion_records.py'
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files/promotion.py'
WORKING = ROOT / 'frappe_apps/shangshu_files/shangshu_files/working_file.py'


def functions(path, names, namespace):
    tree = ast.parse(path.read_text())
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


def throw(message, error=ValueError):
    raise error(message)


class TargetedCoreRead(unittest.TestCase):
    def setUp(self):
        self.records = {'row-%d' % i: 'record-%d' % i for i in range(250)}
        self.rows = [{'name': name, 'amount': i, 'modified': 'v%d' % i,
                      'creation': 'created'} for i, name in enumerate(self.records.values())]
        self.model = types.SimpleNamespace(query_records=Mock(side_effect=self.page),
                                           get_record=Mock(side_effect=self.one),
                                           get_records=Mock(side_effect=self.many))
        self.model._available_bound_records = Mock(side_effect=lambda object_id, names, fields=None: {row['name']: copy.deepcopy(row) for row in self.rows if row['name'] in names})
        self.ns = functions(CORE, {'read_promoted_values'}, {'_fail': throw})
        self.modules = patch.dict('sys.modules', {'shangshu_core': types.SimpleNamespace(model_records=self.model)})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        scope_frappe = patch.object(read_scope, 'frappe', types.SimpleNamespace(throw=throw, ValidationError=ValueError))
        scope_frappe.start()
        self.addCleanup(scope_frappe.stop)

    def page(self, object_id, filters, page, page_length):
        self.assertEqual(object_id, 'object')
        self.assertEqual(filters, {})
        return {'rows': self.rows[(page - 1) * page_length:page * page_length], 'total': len(self.rows)}

    def one(self, object_id, name):
        self.assertEqual(object_id, 'object')
        return {'record': copy.deepcopy(next(row for row in self.rows if row['name'] == name))}

    def many(self, object_id, names, *, fields=None):
        """**一次批量取回**（与逐条读同一口径：缺一条当场拒）。"""
        self.assertEqual(object_id, 'object')
        by_name = {row['name']: row for row in self.rows}
        out = {}
        for name in names:
            if name not in by_name:
                raise LookupError('missing')
            out[name] = copy.deepcopy(by_name[name])
        return out

    def read(self, **kwargs):
        return self.ns['read_promoted_values'](object_id='object', records=self.records, **kwargs)

    def test_full_read_requires_explicit_noninteractive_scope(self):
        with self.assertRaises(ValueError):
            self.read()
        result = self.read(read_scope={'mode': 'all', 'purpose': 'analysis'})
        self.assertEqual(len(result['values']), 250)
        self.assertEqual(result['versions']['row-249'], 'v249')
        self.model.query_records.assert_not_called()
        self.model.get_record.assert_not_called()

    def test_explicit_full_omits_filtered_or_recycled_records_without_querying_other_objects(self):
        self.rows = self.rows[:-1]
        result = self.read(read_scope={'mode': 'all', 'purpose': 'analysis'}, fields=['amount'])
        self.assertNotIn('row-249', result['values'])
        self.assertEqual(len(result['values']), 249)
        self.model._available_bound_records.assert_called_once_with('object', list(self.records.values()), fields=['amount'])
        self.model.get_records.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_one_target_reads_only_one_record(self):
        result = self.read(row_ids=['row-241'])
        self.assertEqual(result, {'values': {'row-241': {'amount': 241}},
                                  'versions': {'row-241': 'v241'}})
        # ⚠️ **现在走批量读口**：一条目标 ⇒ **一次** `get_records`（不是逐条 `get_record`）。
        self.model.get_records.assert_called_once_with('object', ['record-241'], fields=None)
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_two_targets_and_duplicate_read_only_two_records(self):
        result = self.read(row_ids=['row-249', 'row-2', 'row-249'])
        self.assertEqual(set(result['values']), {'row-249', 'row-2'})
        # **两条目标 ⇒ 一次批量取回**（重复的那一条只取一次）⇒ 取数次数**不随行数线性增长**。
        self.model.get_records.assert_called_once_with('object', ['record-249', 'record-2'], fields=None)
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_empty_targets_do_not_mean_all_rows(self):
        self.assertEqual(self.read(row_ids=[]), {'values': {}, 'versions': {}})
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_unknown_workbook_row_does_not_fall_back_to_all(self):
        with self.assertRaises(ValueError):
            self.read(row_ids=['absent'])
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_string_target_list_is_rejected(self):
        with self.assertRaises(ValueError):
            self.read(row_ids='row-2')
        self.model.query_records.assert_not_called()

    def test_record_permission_failure_propagates(self):
        # ⚠️ **现在走批量读口**（`get_records`）—— 判据跟着**真正在跑的那条路**走。
        self.model.get_records.side_effect = PermissionError('record denied')
        with self.assertRaisesRegex(PermissionError, 'record denied'):
            self.read(row_ids=['row-2'])
        self.model.query_records.assert_not_called()

    def test_missing_or_recycled_record_failure_propagates(self):
        for error in (LookupError('missing'), ValueError('recycled')):
            with self.subTest(error=error):
                self.model.get_records.side_effect = error
                with self.assertRaises(type(error)):
                    self.read(row_ids=['row-2'])
                self.model.query_records.assert_not_called()

    def test_field_projection_remains_authoritative(self):
        # 批量读口只回**这个人读得到的字段** ⇒ 读不到的那一列**整列不在**（不是空值冒充）。
        self.model.get_records.side_effect = None
        self.model.get_records.return_value = {'record-2': {'name': 'record-2', 'modified': 'v2'}}
        result = self.read(row_ids=['row-2'])
        self.assertEqual(result['values'], {'row-2': {}})
        self.assertNotIn('amount', result['values']['row-2'])


class TargetedFileRead(unittest.TestCase):
    def setUp(self):
        self.binding = {'object_id': 'object', 'revision': 1,
                        'records': {'r1': 'n1', 'r2': 'n2', 'r3': 'n3'}}
        self.rows = {'r1': {'amount': 10}, 'r2': {'amount': 20}, 'r3': {'amount': 30}}
        self.api = types.SimpleNamespace(read_promoted_values=Mock(side_effect=self.core_read))
        self.doc = types.SimpleNamespace(name='file')
        self.ns = functions(FILES, {'_managed_state', '_managed_values', '_load_formal', 'formal_state'}, {
            'frappe': types.SimpleNamespace(throw=throw, ValidationError=ValueError),
            '_managed_binding': lambda doc: self.binding, '_managed_object_alive': lambda binding: True})
        self.modules = patch.dict('sys.modules', {'shangshu_core.public_api': self.api})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def core_read(self, object_id, records, row_ids=None, fields=None):
        values = {rid: copy.deepcopy(self.rows[rid]) for rid in (self.rows if row_ids is None else row_ids)}
        return {'values': values, 'versions': {rid: 'v1' for rid in values}}

    def test_partial_read_does_not_enable_implicit_full_read(self):
        self.assertEqual(self.ns['_load_formal'](self.doc, row_ids=['r1'], fields=['amount']), {'r1': {'amount': 10}})
        with self.assertRaises(TypeError): self.ns['_load_formal'](self.doc)
        self.assertEqual(self.api.read_promoted_values.call_count, 1)

    def test_target_read_does_not_reuse_an_earlier_snapshot(self):
        self.ns['_load_formal'](self.doc, row_ids=['r1'], fields=['amount'])
        self.rows['r1']['amount'] = 99
        self.assertEqual(self.ns['_load_formal'](self.doc, row_ids=['r1'], fields=['amount']), {'r1': {'amount': 99}})
        self.assertEqual(self.api.read_promoted_values.call_args.kwargs['row_ids'], ['r1'])


class TargetedWriteback(unittest.TestCase):
    def setUp(self):
        self.definition = {'columns': [{'field': 'amount', 'header': '金额'}]}
        self.rows = {'r1': {'amount': 10, 'note': 'untouched'}, 'r2': {'amount': 20}}
        self.doc = types.SimpleNamespace(name='file', content_revision=12, version_count=3)
        self.sheet = types.SimpleNamespace(
            read_payload=Mock(side_effect=AssertionError('版本读取不应生成整份表格读包')),
            write_cells=Mock(side_effect=lambda payload, context, **kw: {
                'cells': payload['cells'], 'content_version': 13, 'structure_version': 7,
                'op_id': payload['op_id'], 'timing': {'fast_path': 'surgery'}}))
        self.formal = Mock(side_effect=lambda doc, row_ids=None, fields=None: {
            rid: copy.deepcopy(self.rows[rid]) for rid in (self.rows if row_ids is None else row_ids)})
        self.get_doc = Mock(return_value=self.doc)
        self.ns = functions(FILES, {'_writeback', '_writeback_rows'}, {
            'FILE': 'Shangshu File Center File',
            'frappe': types.SimpleNamespace(get_doc=self.get_doc, throw=throw, TimestampMismatchError=ValueError),
            'load_definition': lambda doc: copy.deepcopy(self.definition),
            '_load_meta': lambda doc: {'structure_version': 7},
            '_load_formal': self.formal,
            'promoted_columns': lambda definition: definition['columns'],
            '_typed_for': lambda col, value: {'type': 'number', 'value': value}})
        revision = functions(WORKING, {'content_revision'}, {})['content_revision']
        self.modules = patch.dict('sys.modules', {
            'shangshu_files': types.SimpleNamespace(sheet=self.sheet),
            'shangshu_files.working_file': types.SimpleNamespace(content_revision=revision)})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def test_one_target_reads_current_row_and_writes_once(self):
        result = self.ns['_writeback'](self.doc, self.definition, 'r1', {'amount': 10}, op_id='op')
        self.assertEqual(result['written'], 1)
        self.formal.assert_called_once_with(self.doc, row_ids=['r1'], fields=['amount'])
        self.get_doc.assert_called_once_with('Shangshu File Center File', 'file', for_update=True)
        self.sheet.read_payload.assert_not_called()
        payload = self.sheet.write_cells.call_args.args[0]
        self.assertEqual((payload['expected_content_version'], payload['expected_structure_version']), (12, 7))
        self.assertEqual(payload['cells'], [{'row_id': 'r1', 'header': '金额', 'value': {'type': 'number', 'value': 10}}])
        self.assertTrue(self.sheet.write_cells.call_args.kwargs['projection_only'])
        self.assertEqual(self.rows['r1']['note'], 'untouched')

    def test_two_target_rows_share_one_file_write(self):
        result = self.ns['_writeback_rows'](self.doc, self.definition, {'r1': {'amount': 10}, 'r2': {'amount': 20}}, op_id='two')
        self.assertEqual(result['written'], 2)
        self.formal.assert_called_once_with(self.doc, row_ids=['r1', 'r2'], fields=['amount'])
        self.sheet.write_cells.assert_called_once()
        self.sheet.read_payload.assert_not_called()

    def test_superseded_value_or_definition_never_writes_file(self):
        for definition, value in ((self.definition, 11), ({'columns': [{'field': 'amount', 'header': '旧标题'}]}, 10)):
            with self.subTest(value=value, definition=definition):
                with self.assertRaisesRegex(ValueError, '正式值或字段定义'):
                    self.ns['_writeback'](self.doc, definition, 'r1', {'amount': value})
                self.sheet.write_cells.assert_not_called()

    def test_rejected_read_never_writes_file(self):
        self.formal.side_effect = PermissionError('read denied')
        with self.assertRaises(PermissionError):
            self.ns['_writeback'](self.doc, self.definition, 'r1', {'amount': 10})
        self.sheet.write_cells.assert_not_called()


class TargetedAtomicPlan(unittest.TestCase):
    def setUp(self):
        self.doc = types.SimpleNamespace(name='file')
        self.meta = {'rows': ['r1', 'r2', 'r3', 'r4']}
        self.rows = {'r1': {'amount': 10}, 'r2': {'amount': 20}, 'r3': {'amount': 30}}
        self.binding = {'object_id': 'object', 'records': {'r1': 'n1', 'r2': 'n2', 'r3': 'n3'}}
        self.column = {'field': 'amount', 'header': '金额', 'promoted': True}
        self.read_state = Mock(side_effect=lambda doc, binding, row_ids, fields=None: {
            'values': {rid: copy.deepcopy(self.rows[rid]) for rid in row_ids},
            'versions': {rid: 'before-' + rid for rid in row_ids}})
        self.write = Mock()
        self.permissions = Mock()
        self.rules = Mock()
        self.flags = types.SimpleNamespace()
        self.ns = functions(FILES, {'_atomic_formal_state', 'plan_atomic_values', 'commit_atomic_values', '_formal_diff', 'declared_fields'}, {
            'frappe': types.SimpleNamespace(throw=throw, ValidationError=ValueError, flags=self.flags),
            'load_definition': lambda doc: {'columns': [self.column]},
            'promoted_columns': lambda definition: definition['columns'],
            'column_by_header': lambda definition, header: self.column if header == '金额' else None,
            '_managed_binding': lambda doc: self.binding,
            '_managed_state': self.read_state,
            '_load_formal': Mock(side_effect=AssertionError('不许整表读取')),
            'formal_state': Mock(side_effect=AssertionError('不许整表读取')),
            'require_fields_writable': self.permissions, '_check_rules': self.rules,
            '_write_managed': self.write,
            'row_readiness': lambda definition, row: {'status': 'ready' if row else 'draft'}})
        self.modules = patch.dict('sys.modules', {'shangshu_files.sheet': types.SimpleNamespace(_fault=lambda point: None)})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def cells(self, rows=('r1', 'r2')):
        return [{'row_id': rid, 'header': '金额', 'before': {'value': self.rows[rid]['amount']},
                 'after': {'type': 'number', 'value': self.rows[rid]['amount'] + 1}} for rid in rows]

    def test_two_row_plan_and_commit_never_touch_third_row(self):
        cells = self.cells()
        candidate = self.ns['plan_atomic_values'](self.doc, self.meta, cells, row_ids=['r1', 'r2'])
        self.assertEqual(candidate, {'r1': {'amount': 11}, 'r2': {'amount': 21}})
        self.assertEqual(cells[0]['formal_before_version'], 'before-r1')
        self.ns['commit_atomic_values'](self.doc, candidate, 'op', row_ids=['r1', 'r2'])
        self.assertEqual(self.write.call_args.args[2], candidate)
        self.assertEqual([call.kwargs['row_ids'] for call in self.read_state.call_args_list], [['r1', 'r2'], ['r1', 'r2']])
        self.assertEqual(self.rows['r3'], {'amount': 30})
        self.assertFalse(self.flags.shangshu_files_own_writeback)
        self.permissions.assert_called_once()
        self.assertEqual(self.rules.call_count, 2)

    def test_undo_removing_last_formal_value_does_not_clear_other_rows(self):
        cells = [{'row_id': 'r1', 'header': '金额', 'after': {'type': 'empty', 'value': None},
                  'restore_formal_absent': True}]
        candidate = self.ns['plan_atomic_values'](self.doc, self.meta, cells, row_ids=['r1'])
        self.assertEqual(candidate, {})
        self.ns['commit_atomic_values'](self.doc, candidate, 'undo', row_ids=['r1'])
        self.assertEqual(self.write.call_args.args[2], {'r1': {'amount': None}})
        self.assertEqual(self.rows['r2'], {'amount': 20})

    def test_unbound_ordinary_row_remains_draft_without_formal_write(self):
        cells = [{'row_id': 'r4', 'header': '备注', 'after': {'type': 'text', 'value': 'note'}}]
        candidate = self.ns['plan_atomic_values'](self.doc, self.meta, cells, row_ids=['r4'])
        self.assertEqual(candidate, {})
        self.assertEqual(self.meta['promotion_row_states']['r4'], {'status': 'draft'})
        self.ns['commit_atomic_values'](self.doc, candidate, row_ids=['r4'])
        self.write.assert_not_called()

    def test_incomplete_scope_is_rejected_before_reading(self):
        with self.assertRaisesRegex(ValueError, '全部修改'):
            self.ns['plan_atomic_values'](self.doc, self.meta, self.cells(), row_ids=['r1'])
        self.read_state.assert_not_called()
        self.write.assert_not_called()

    def test_candidate_outside_scope_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '超出'):
            self.ns['commit_atomic_values'](self.doc, {'r3': {'amount': 90}}, row_ids=['r1'])
        self.write.assert_not_called()

    def test_core_rule_failure_propagates_and_restores_projection_flag(self):
        self.write.side_effect = ValueError('业务唯一键冲突')
        with self.assertRaisesRegex(ValueError, '唯一键'):
            self.ns['commit_atomic_values'](self.doc, {'r1': {'amount': 99}}, row_ids=['r1'])
        self.assertFalse(self.flags.shangshu_files_own_writeback)


class PendingManagedRows(unittest.TestCase):
    def setUp(self):
        self.doc = types.SimpleNamespace(name='file')
        self.binding = {'object_id': 'object', 'revision': 1, 'records': {'r1': 'n1'}}
        self.meta = {'rows': ['r1', 'r2'], 'promotion_binding': self.binding,
                     'promotion_pending_rows': {'r2': {'object_id': 'object', 'origin_op_id': 'append-1'}}}
        self.created = Mock(return_value={'records': {'r2': 'n2'}})
        self.updated = Mock(return_value={'written': 1})
        self.read = Mock()
        self.api = types.SimpleNamespace(create_promoted_records=self.created,
            write_promoted_values=self.updated, read_promoted_values=self.read)
        self.ns = functions(FILES, {'_managed_state', '_require_pending_managed_row',
            '_create_pending_managed_rows', '_write_managed'}, {
            'json': json, 'hashlib': hashlib,
            'frappe': types.SimpleNamespace(throw=throw, ValidationError=ValueError, TimestampMismatchError=RuntimeError),
            '_load_meta': lambda doc: copy.deepcopy(self.meta),
            '_save_meta': lambda doc, meta: setattr(self, 'meta', copy.deepcopy(meta)),
            '_save_binding': self.bind})
        self.modules = patch.dict('sys.modules', {'shangshu_core.public_api': self.api})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def bind(self, doc, binding):
        self.meta['promotion_binding'] = copy.deepcopy(binding)

    def write(self, values=None, **kwargs):
        return self.ns['_write_managed'](self.doc, self.binding, values or {'r2': {'amount': 20}},
                                         idempotency_key='input-1', **kwargs)

    def test_explicit_new_row_has_no_formal_values_until_first_valid_write(self):
        self.assertEqual(self.ns['_managed_state'](self.doc, self.binding, row_ids=['r2'], fields=['amount']),
                         {'values': {}, 'versions': {}})
        self.read.assert_not_called()
        self.created.assert_not_called()
        result = self.write()
        self.assertEqual(result['written'], 1)
        self.assertEqual(self.binding['records'], {'r1': 'n1', 'r2': 'n2'})
        self.assertEqual(self.meta['promotion_pending_rows'], {})
        self.assertEqual(self.created.call_args.kwargs['rows'], [{'row_id': 'r2', 'values': {'amount': 20}}])
        self.updated.assert_not_called()

    def test_missing_old_binding_is_not_silently_rebuilt(self):
        self.meta['promotion_pending_rows'] = {}
        with self.assertRaisesRegex(ValueError, '没有可核实的新增来源'):
            self.write()
        self.created.assert_not_called()
        self.updated.assert_not_called()

    def test_marker_from_another_object_or_unknown_row_is_rejected(self):
        original = copy.deepcopy(self.meta)
        for invalid in ('object', 'row', 'origin'):
            with self.subTest(invalid=invalid):
                self.meta = copy.deepcopy(original)
                if invalid == 'object': self.meta['promotion_pending_rows']['r2']['object_id'] = 'other'
                if invalid == 'row': self.meta['rows'] = ['r1']
                if invalid == 'origin': self.meta['promotion_pending_rows']['r2']['origin_op_id'] = ''
                with self.assertRaises(ValueError): self.write()
                self.created.assert_not_called()

    def test_creation_rule_failure_leaves_mapping_and_pending_marker_unchanged(self):
        self.created.side_effect = ValueError('必填或唯一键不通过')
        before = copy.deepcopy(self.meta)
        with self.assertRaisesRegex(ValueError, '必填或唯一键'):
            self.write()
        self.assertEqual(self.meta, before)
        self.assertEqual(self.binding['records'], {'r1': 'n1'})
        self.updated.assert_not_called()

    def test_existing_rows_keep_existing_update_and_new_row_is_created_once(self):
        result = self.write({'r1': {'amount': 11}, 'r2': {'amount': 20}})
        self.assertEqual(result['written'], 2)
        self.assertEqual(self.updated.call_args.kwargs['values_by_row'], {'r1': {'amount': 11}})
        self.write({'r2': {'amount': 21}})
        self.created.assert_called_once()
        self.assertEqual(self.updated.call_args.kwargs['values_by_row'], {'r2': {'amount': 21}})

    def test_nonexistent_record_cannot_accept_a_claimed_existing_version(self):
        with self.assertRaises(RuntimeError):
            self.write(expected_modified_by_row={'r2': 'stale-record-version'})
        self.created.assert_not_called()


if __name__ == '__main__':
    unittest.main()
