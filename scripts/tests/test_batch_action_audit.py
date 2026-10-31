"""真实动作执行器的批量审计接线；只替换 handler 和日志持久化边界。"""
import json
import copy
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions

ROOT = Path(__file__).resolve().parents[2]
ACTIONS = ROOT / 'frappe_apps/shangshu_core/shangshu_core/actions.py'
install_real_environment()
from shangshu_core import actions, managed_changes, model_records, promotion_records


class BatchActionAudit(unittest.TestCase):
    def setUp(self):
        self.entries = []
        self.single = []
        self.changes = [
            {'doctype': 'SSM Test', 'name': f'R{i}', 'idempotency_key': f'row-{i}',
             'data': {'object_id': 'object.test', 'revision': 3, 'changes': [
                 {'field': 'amount', 'before': i, 'after': None}]}}
            for i in range(3)]

        def handler(action, value, context):
            context['record_changes'] = self.changes
            return {'written': len(self.changes)}

        def write_logs(entries):
            self.entries.append(entries)
            return [SimpleNamespace(name=f'LOG-{i}') for i in range(len(entries))]

        def write_log(**entry):
            self.single.append(entry)
            return SimpleNamespace(name='single')

        self.frappe = SimpleNamespace(
            flags=SimpleNamespace(), session=SimpleNamespace(user='person@example.invalid'),
            db=SimpleNamespace(get_value=lambda *a: None), get_attr=lambda path: handler,
            ValidationError=ValueError,
            throw=lambda message, error=ValueError: (_ for _ in ()).throw(error(message)))
        self.context = load_module_functions(ACTIONS, {'_execute_action_handler'},
            stubs={'frappe': self.frappe}, overrides={
                '_validate_schema': lambda *a: None,
                'unified_log': SimpleNamespace(write_logs=write_logs, write_log=write_log)})
        provenance = SimpleNamespace(
            current_action_provenance=lambda *a: {'kind': 'human'},
            action_origin_scope=lambda *a, **kw: nullcontext())
        scoped = patch.dict(sys.modules, {'shangshu_core.action_provenance': provenance})
        scoped.start()
        self.addCleanup(scoped.stop)

    def execute(self):
        return self.context['_execute_action_handler'](
            'platform.object.update_many',
            SimpleNamespace(action_version='1.0.0', output_schema_json='{}'),
            {'id': 'com.shangshu.core', 'owner_app': 'shangshu_core'},
            {'handler': 'shangshu_core.test.handler'},
            SimpleNamespace(name='identity-person', identity_id='identity-person', enterprise_id='default'),
            [], {'records': [1, 2, 3]},
            'batch-key', 'user', True)

    def test_one_batch_persists_every_records_complete_audit(self):
        receipt = self.execute()
        self.assertEqual(len(self.entries), 1, '应一次调用批量落库，不是逐行insert')
        self.assertEqual(self.single, [])
        self.assertEqual(receipt['audit'], 'LOG-2')
        for i, row in enumerate(self.entries[0]):
            self.assertEqual(row['idempotency_key'], f'row-{i}')
            self.assertEqual(row['business_name'], f'R{i}')
            self.assertEqual(row['actor_user'], 'person@example.invalid')
            self.assertEqual(row['actor_identity'], 'identity-person')
            self.assertEqual(row['detail']['action_version'], '1.0.0')
            self.assertEqual(row['detail']['record_changes'], self.changes[i]['data'])
            self.assertEqual(json.loads(row['detail']['legacy']['record_changes_json']),
                             self.changes[i]['data'])

    def test_batch_insert_error_is_not_reported_as_success(self):
        def fail(entries):
            raise RuntimeError('audit failed')
        self.context['unified_log'].write_logs = fail
        with self.assertRaisesRegex(RuntimeError, 'audit failed'):
            self.execute()

    def test_missing_row_keys_get_stable_distinct_audit_keys(self):
        for change in self.changes:
            change.pop('idempotency_key')
        self.execute()
        self.execute()
        keys = [entry['idempotency_key'] for entry in self.entries[0]]
        self.assertEqual(len(set(keys)), 3)
        self.assertEqual(keys, [entry['idempotency_key'] for entry in self.entries[1]])

    def test_explicit_duplicate_row_keys_are_rejected_not_silently_merged(self):
        for change in self.changes:
            change['idempotency_key'] = 'same-key'
        with self.assertRaisesRegex(ValueError, '审计键重复'):
            self.execute()
        self.assertEqual(self.entries, [])


class BatchRecordNotifications(unittest.TestCase):
    """真实批写与通知编排；记录存储替身不替代通知合并、失败处理和回执。"""
    def setUp(self):
        self.object_id = 'com.shangshu.app.test.object.record'
        self.deliveries, self.writes = [], []
        self.failure_name = None
        self.handler_error = False
        self.model = SimpleNamespace(name=self.object_id, active_revision=1)
        self.frappe = SimpleNamespace(
            flags=SimpleNamespace(shangshu_action_pin={'action_id': 'platform.object.update_many'}),
            ValidationError=ValueError, PermissionError=PermissionError, TimestampMismatchError=ValueError,
            throw=lambda message, error=ValueError: (_ for _ in ()).throw(error(message)),
            get_hooks=lambda key: ['projection.handler'], get_attr=lambda path: self.deliver)
        for target, name, value in (
            (model_records, 'frappe', self.frappe),
            (managed_changes, 'frappe', self.frappe),
            (model_records, '_load', lambda *a, **kw: (self.model, {'title': '表'}, {'Desk User'})),
            (model_records, '_write_one_record', self.write_row),
        ):
            scoped = patch.object(target, name, value)
            scoped.start()
            self.addCleanup(scoped.stop)

    def deliver(self, payload):
        self.deliveries.append(copy.deepcopy(payload))
        if self.handler_error:
            raise RuntimeError('投影落盘失败')
        return {'handled': len(payload['records']), 'pending': False}

    def write_row(self, model, compiled, roles, name, expected, values):
        self.writes.append((name, expected, values))
        if name == self.failure_name:
            raise ValueError('记录已被修改')
        return (SimpleNamespace(name=name, modified='v2', doctype='Managed Row'),
                [{'field': key, 'before': None, 'after': value} for key, value in values.items()])

    def write(self, names=('R1', 'R2'), source='automation'):
        context = {'confirmed': True, 'source': source, 'idempotency_key': 'batch'}
        result = model_records.write_records('platform.object.update_many', {
            'object_id': self.object_id, 'expected_revision': 1,
            'records': [{'name': name, 'expected_modified': 'v1', 'values': {'amount': index},
                         'row_id': 'row-' + name, 'idempotency_key': 'key-' + name}
                        for index, name in enumerate(names)]}, context)
        return result, context

    def test_direct_batch_notifies_once_after_all_rows_and_returns_real_result(self):
        result, context = self.write()
        self.assertEqual(self.deliveries, [{'object_id': self.object_id,
            'records': {'R1': {'amount': 0}, 'R2': {'amount': 1}}, 'source': 'automation'}])
        self.assertEqual(result['managed_change'], {'handlers': 1, 'results': [
            {'handlers': 1, 'results': [{'handler': 'projection.handler',
                'result': {'handled': 2, 'pending': False}}]}]})
        self.assertEqual([row['name'] for row in context['record_changes']], ['R1', 'R2'])
        self.assertEqual([row['idempotency_key'] for row in context['record_changes']], ['key-R1', 'key-R2'])
        self.assertEqual([item[1] for item in self.writes], ['v1', 'v1'])
        self.assertFalse(managed_changes.in_batch())

    def test_failed_row_never_notifies_partial_changes(self):
        self.failure_name = 'R2'
        with self.assertRaisesRegex(ValueError, '记录已被修改'):
            self.write(('R1', 'R2', 'R3'))
        self.assertEqual([item[0] for item in self.writes], ['R1', 'R2'])
        self.assertEqual(self.deliveries, [])
        self.assertFalse(managed_changes.in_batch())
        self.assertFalse(getattr(self.frappe.flags, managed_changes._PENDING_KEY, None))

    def test_nested_promotion_batch_flushes_once_at_outer_exit_with_outer_source(self):
        with managed_changes.batch(source='promotion') as outer:
            result, _ = self.write()
            self.assertEqual(self.deliveries, [])
            self.assertEqual(result['managed_change']['handlers'], 0)
            with managed_changes.batch(source='inner'):
                managed_changes.defer_managed_change(object_id=self.object_id, record_name='R3', values={'flag': False})
            self.assertEqual(self.deliveries, [])
        self.assertEqual(len(self.deliveries), 1)
        self.assertEqual(self.deliveries[0]['source'], 'promotion')
        self.assertEqual(self.deliveries[0]['records'],
                         {'R1': {'amount': 0}, 'R2': {'amount': 1}, 'R3': {'flag': False}})
        self.assertEqual(outer.result['handlers'], 1)

    def test_caught_nested_failure_restores_parent_pending_without_failed_rows(self):
        with managed_changes.batch(source='promotion'):
            managed_changes.defer_managed_change(object_id=self.object_id, record_name='R1', values={'amount': 'outer'})
            self.failure_name = 'R2'
            with self.assertRaisesRegex(ValueError, '记录已被修改'):
                self.write()
            self.assertTrue(managed_changes.in_batch())
            self.assertEqual(self.deliveries, [])
        self.assertEqual(self.deliveries[0]['records'], {'R1': {'amount': 'outer'}})

    def test_outer_failure_discards_successful_nested_notifications(self):
        with self.assertRaisesRegex(ValueError, 'outer failed'):
            with managed_changes.batch(source='promotion'):
                self.write()
                raise ValueError('outer failed')
        self.assertEqual(self.deliveries, [])
        self.assertFalse(getattr(self.frappe.flags, managed_changes._PENDING_KEY, None))

    def test_projection_failure_is_reported_using_original_handler_error_semantics(self):
        self.handler_error = True
        result, context = self.write()
        self.assertEqual(result['written'], 2)
        self.assertEqual(len(context['record_changes']), 2)
        self.assertEqual(len(self.deliveries), 1)
        self.assertEqual(result['managed_change']['results'][0]['results'][0],
                         {'handler': 'projection.handler', 'error': '投影落盘失败'})

    def test_real_promotion_wrapper_keeps_batch_pending_until_its_end_and_returns_result(self):
        self.frappe.get_doc = lambda *a, **kw: self.model

        def execute(action_id, payload, **kwargs):
            result = model_records.write_records(action_id, payload, {
                'confirmed': kwargs['confirmed'], 'source': kwargs['source'],
                'idempotency_key': kwargs['idempotency_key']})
            self.assertEqual(self.deliveries, [], '内层公共动作不能先投影')
            return {'result': result}

        with patch.object(promotion_records, 'frappe', self.frappe), \
                patch.object(promotion_records, '_current_versions', return_value={'R1': 'v1', 'R2': 'v1'}), \
                patch.object(actions, 'execute_registered_action', execute):
            result = promotion_records.write_promoted_values(
                object_id=self.object_id, records={'row-R1': 'R1', 'row-R2': 'R2'},
                values_by_row={'row-R1': {'amount': 0}, 'row-R2': {'amount': False}},
                expected_modified_by_row={'row-R1': 'v1', 'row-R2': 'v1'},
                idempotency_key='promotion')
        self.assertEqual(len(self.deliveries), 1)
        self.assertEqual(self.deliveries[0]['source'], 'promotion')
        self.assertEqual(self.deliveries[0]['records'], {'R1': {'amount': 0}, 'R2': {'amount': False}})
        self.assertEqual(result['managed_change']['handlers'], 1)
        self.assertEqual(result['managed_change']['results'][0]['results'][0]['result']['handled'], 2)


if __name__ == '__main__':
    unittest.main()
