"""显式原子包的真实执行器/审计构造；替身仅限身份、handler 与持久化边界。"""
import copy
import json
import sys
import unittest
from contextlib import nullcontext
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions

install_real_environment()
from shangshu_core import actions as _loaded_actions, action_packages as _loaded_packages
ROOT = Path(__file__).resolve().parents[2]
ACTIONS = ROOT / 'frappe_apps/shangshu_core/shangshu_core/actions.py'


class Request(SimpleNamespace):
    def save(self, **kwargs):
        return self

    def db_set(self, key, value=None, **kwargs):
        self.__dict__.update(key if isinstance(key, dict) else {key: value})


class CommitHooks:
    def __init__(self):
        self.callbacks = []

    def add(self, callback):
        self.callbacks.append(callback)

    def run(self):
        for callback in list(self.callbacks):
            callback()


class ActionPackages(unittest.TestCase):
    def setUp(self):
        self.logs, self.requests, self.saved_receipts = [], {}, {}
        self.handlers, self.resources, self.versions, self.effects = {}, {}, {}, {}
        self.fail_log = False
        self.points, self.rollbacks = {}, []
        self.before_commit, self.commits = CommitHooks(), []
        self.changes = [
            {'doctype': 'Managed Row', 'name': 'R%d' % i, 'row_id': 'sheet-%d' % i,
             'idempotency_key': 'row-%d' % i, 'data': {
                 'object_id': 'object.test', 'revision': 3, 'object_title': '原表名',
                 'changes': [{'field': 'amount', 'label': '原字段名', 'before': i, 'after': None},
                             {'field': 'active', 'before': True, 'after': False}]}}
            for i in range(3)]

        def savepoint(name):
            self.points[name] = (copy.deepcopy(self.logs), set(self.requests))

        def rollback(save_point=None):
            self.rollbacks.append(save_point)
            logs, names = self.points.get(save_point, ([], set()))
            self.logs[:] = logs
            for key in set(self.requests) - names:
                del self.requests[key]
            if save_point is None:
                self.before_commit.callbacks.clear()

        def commit():
            self.before_commit.run()
            self.commits.append('committed')

        def reserve(key, identity, action_id, version, value, **kwargs):
            request = self.requests.get(key)
            if request:
                return request, False
            request = Request(key=key, name='REQ-' + key, action_id=action_id,
                              action_version=version, status='Running', execution_audit=None)
            self.requests[key] = request
            return request, True

        def succeed(request, receipt):
            request.status = 'Succeeded'
            request.execution_audit = receipt['audit']
            request.result = copy.deepcopy(receipt['result'])
            self.saved_receipts[request.key] = receipt

        def fail(request, reason):
            request.status, request.failure_reason = 'Failed', reason

        def write_log(**entry):
            if self.fail_log:
                raise RuntimeError('audit store unavailable')
            self.logs.append(copy.deepcopy(entry))
            return SimpleNamespace(name='LOG-%d' % len(self.logs))

        self.frappe = SimpleNamespace(
            flags=SimpleNamespace(), local=SimpleNamespace(), session=SimpleNamespace(user='actor@example.invalid'),
            ValidationError=ValueError, PermissionError=PermissionError, DoesNotExistError=KeyError,
            db=SimpleNamespace(exists=lambda *a: False, get_value=lambda *a: None,
                               savepoint=savepoint, rollback=rollback, commit=commit,
                               before_commit=self.before_commit),
            generate_hash=lambda **kwargs: str(len(self.points) + 1),
            get_attr=lambda path: self.handlers[path],
            throw=lambda message, error=ValueError: (_ for _ in ()).throw(error(message)))
        self.request_api = SimpleNamespace(
            find_request=lambda key: self.requests.get(key), reserve=reserve,
            audit_keys_of=lambda properties: [], succeed=succeed, fail=fail,
            replay=lambda request: {'action_id': request.action_id,
                'action_version': request.action_version, 'result': request.result,
                'audit': request.execution_audit, 'idempotent': True})
        modules = {
            'frappe': self.frappe,
            'shangshu_core.lifecycle': SimpleNamespace(assert_declared_call=lambda domain: None),
            'shangshu_core.action_provenance': SimpleNamespace(
                process_action_version=lambda action: None,
                current_action_origin=lambda: None,
                _node=ContextVar('test_package_process_node', default=None),
                current_action_provenance=lambda *a: {'kind': 'human'},
                action_origin_scope=lambda *a, **kw: nullcontext()),
        }
        scoped = patch.dict(sys.modules, modules)
        scoped.start(); self.addCleanup(scoped.stop)
        # A real collector imported by a preceding case must see this case's request state.
        existing = sys.modules.get('shangshu_core.action_packages')
        if existing is not None:
            scoped = patch.object(existing, 'frappe', self.frappe)
            scoped.start(); self.addCleanup(scoped.stop)
        from shangshu_core import write_zones
        scoped = patch.object(write_zones, 'frappe', self.frappe)
        scoped.start(); self.addCleanup(scoped.stop)
        self.env = load_module_functions(ACTIONS, {'execute_registered_action'}, stubs={
            'frappe': self.frappe, 'action_requests': self.request_api,
            'resource_execution': lambda *a: lambda f: f,
            'unified_log': SimpleNamespace(write_log=write_log,
                write_logs=lambda entries: [write_log(**entry) for entry in entries]),
        }, overrides={
            'raw_resource': lambda kind, action: (
                {'id': 'com.shangshu.core', 'owner_app': 'shangshu_core'}, self.resources[action]),
            '_definition': lambda action, version=None: SimpleNamespace(
                action_version=version or self.versions[action], input_schema_json='{}',
                output_schema_json='{}', confirmation_policy='required', effect=self.effects[action]),
            '_assert_action_role': lambda action: ['Desk User'],
            'get_identity': lambda: SimpleNamespace(name='identity', identity_id='identity', enterprise_id='company'),
            'assert_domain_enabled': lambda domain: None,
        })
        self.env.update({
            '_definition': lambda action, version=None: SimpleNamespace(
                action_version=version or self.versions[action], input_schema_json='{}',
                output_schema_json='{}', confirmation_policy='required', effect=self.effects[action]),
            '_assert_action_role': lambda action: ['Desk User'],
        })

    def register(self, action, handler, *, package=False, version='1.1.0', children=(), effect='write'):
        path = 'shangshu_core.test.' + action
        self.handlers[path] = handler
        self.resources[action] = {'handler': path}
        if package:
            self.resources[action].update(transaction='atomic_package', transaction_versions=['1.1.0'],
                                          package_actions=list(children))
        self.versions[action] = version
        self.effects[action] = effect

    def execute(self, action, key=None, payload=None):
        return self.env['execute_registered_action'](action, payload or {}, confirmed=True,
            idempotency_key=key or action, source='user')

    def batch_handler(self, action, payload, context):
        context['record_changes'] = copy.deepcopy(self.changes)
        return {'object_id': 'object.test', 'revision': 3, 'written': 3,
                'records': ['R0', 'R1', 'R2'], 'record_version_checked': True}

    def test_declared_batch_has_one_log_with_complete_versioned_record_evidence(self):
        self.register('platform.object.update_many', self.batch_handler, package=True)
        receipt = self.execute('platform.object.update_many', 'batch-key')
        self.assertEqual(len(self.logs), 1)
        entry = self.logs[0]
        self.assertEqual(entry['idempotency_key'], 'batch-key')
        self.assertEqual(receipt['audit'], 'LOG-1')
        package = entry['detail']['package']
        self.assertEqual(package['version'], 1)
        self.assertEqual(package['record_count'], 3)
        self.assertEqual(package['change_count'], 6)
        self.assertEqual(len(package['steps']), 1)
        step = package['steps'][0]
        self.assertEqual(step['action_id'], 'platform.object.update_many')
        self.assertEqual(step['action_version'], '1.1.0')
        self.assertEqual(step['idempotency_key'], 'batch-key')
        self.assertEqual(step['record_changes'], self.changes)
        self.assertIsNone(entry['detail']['record_changes'])
        self.assertIsNone(entry['detail']['legacy']['record_changes_json'])
        self.assertNotIn('input_summary', step)
        self.assertNotIn('result_summary', step)
        self.assertEqual(json.dumps(entry['detail'], ensure_ascii=False).count('"field": "amount"'), 3,
                         '完整明细只在 package.steps 存一份')
        self.assertEqual(self.requests['batch-key'].execution_audit, receipt['audit'])

    def test_nested_actions_collect_before_root_log_and_all_receipts_point_to_root(self):
        children = []
        def parent(action, payload, context):
            children.append(self.execute('child', 'child-1'))
            children.append(self.execute('child', 'child-2'))
            self.assertEqual(self.logs, [], '子动作尚不可独立落审计')
            return {'children': children, 'applied': 6}
        self.register('parent', parent, package=True, children=['child'])
        self.register('child', self.batch_handler)
        result = self.execute('parent')
        self.assertEqual(len(self.logs), 1)
        self.assertEqual([r['audit'] for r in children], [result['audit']] * 2)
        self.assertEqual({r.execution_audit for r in self.requests.values()}, {result['audit']})
        steps = self.logs[0]['detail']['package']['steps']
        self.assertEqual(sorted(s['idempotency_key'] for s in steps), ['child-1', 'child-2', 'parent'])
        self.assertEqual(sum(len(s['record_changes']) for s in steps), 6)
        self.assertTrue(all('input_summary' in step and 'result_summary' in step
                            for step in steps if step['idempotency_key'] != 'parent'))

    def test_large_package_keeps_every_record_and_same_request_replays_one_log(self):
        self.changes = [{**copy.deepcopy(self.changes[i % 3]),
                         'name': 'R%d' % i, 'idempotency_key': 'row-%d' % i}
                        for i in range(120)]
        calls = []
        def handler(action, payload, context):
            calls.append(action)
            context['record_changes'] = copy.deepcopy(self.changes)
            return {'written': 120}
        self.register('batch', handler, package=True)
        first = self.execute('batch')
        again = self.execute('batch')
        self.assertEqual(calls, ['batch'])
        self.assertEqual(len(self.logs), 1)
        package = self.logs[0]['detail']['package']
        self.assertEqual(package['record_count'], 120)
        self.assertEqual(package['change_count'], 240)
        self.assertEqual(package['steps'][0]['record_changes'], self.changes)
        self.assertTrue(again['idempotent'])
        self.assertEqual(again['result'], first['result'])
        self.assertEqual(again['audit'], first['audit'])

    def test_caught_child_failure_poisoned_root_and_next_action_has_no_collector(self):
        def broken(action, payload, context):
            raise ValueError('child rule denied')
        def parent(action, payload, context):
            try:
                self.execute('broken')
            except ValueError:
                pass
            return {'claimed_success': True}
        self.register('parent', parent, package=True, children=['broken'])
        self.register('broken', broken)
        with self.assertRaisesRegex(ValueError, 'child rule denied'):
            self.execute('parent')
        self.assertEqual(self.logs, [])
        self.assertEqual(self.requests['parent'].status, 'Failed')
        self.register('ordinary', lambda *a: {'ok': True})
        receipt = self.execute('ordinary')
        self.assertEqual(len(self.logs), 1)
        self.assertNotIn('package', self.logs[0]['detail'])
        self.assertEqual(receipt['audit'], 'LOG-1')

    def test_undeclared_single_and_old_successful_receipt_keep_existing_shape(self):
        calls = []
        def single(action, payload, context):
            calls.append(action)
            context['record_change'] = copy.deepcopy(self.changes[0])
            return {'name': 'R0'}
        self.register('ordinary', single, version='1.0.0')
        first = self.execute('ordinary', key='old-success')
        self.assertNotIn('package', self.logs[0]['detail'])
        self.assertEqual(self.logs[0]['detail']['record_changes'], self.changes[0]['data'])
        self.resources['ordinary'].update(transaction='atomic_package', transaction_versions=['1.1.0'])
        self.versions['ordinary'] = '1.1.0'
        replay = self.execute('ordinary', key='old-success')
        self.assertTrue(replay['idempotent'])
        self.assertEqual(first['audit'], replay['audit'])
        self.assertEqual(calls, ['ordinary'])
        self.assertEqual(len(self.logs), 1)
        for status in (None, 'Failed'):
            key = 'old-' + str(status)
            if status:
                self.requests[key] = Request(key=key, name='REQ-'+key, action_id='ordinary',
                    action_version='1.0.0', status=status, execution_audit=None)
            with self.assertRaisesRegex(ValueError, '版本已更新'):
                self.env['execute_registered_action']('ordinary', {}, confirmed=True,
                    idempotency_key=key, action_version='1.0.0')
        self.assertEqual(calls, ['ordinary'])
        self.assertEqual(len(self.logs), 1)
        self.assertEqual(self.requests['old-Failed'].status, 'Failed')

    def test_savepoint_rollback_failure_blocks_commit_and_keeps_root_receipt_binding(self):
        def handler(*args):
            raise ValueError('rule failed')
        self.register('parent', handler, package=True)
        def broken_rollback(**kwargs):
            raise RuntimeError('database lost savepoint')
        self.frappe.db.rollback = broken_rollback
        with self.assertRaisesRegex(RuntimeError, '数据库回滚失败') as caught:
            self.execute('parent')
        self.assertEqual(caught.exception._ss_failed_action[0], 'parent')
        # 保存点已不可用；不得再写失败回执覆盖原异常，留给HTTP完整回滚后登记。
        self.assertEqual(self.requests['parent'].status, 'Running')
        with self.assertRaisesRegex(RuntimeError, '数据库回滚失败'):
            self.frappe.db.commit()
        self.assertEqual(self.commits, [])

    def test_deadlock_keeps_original_error_when_savepoint_and_request_are_gone(self):
        class QueryDeadlockError(Exception): pass
        self.frappe.QueryDeadlockError = QueryDeadlockError
        original = QueryDeadlockError('database deadlock')
        def handler(*args): raise original
        self.register('parent', handler, package=True)
        self.frappe.db.rollback = lambda **kwargs: (_ for _ in ()).throw(RuntimeError('savepoint gone'))
        failed = []
        self.request_api.fail = lambda *args: failed.append(args)
        with self.assertRaises(QueryDeadlockError) as caught: self.execute('parent')
        self.assertIs(caught.exception, original)
        self.assertEqual(original._ss_failed_action[0], 'parent')
        self.assertEqual(failed, [])
        self.assertEqual(self.logs, [])
        with self.assertRaises(QueryDeadlockError): self.frappe.db.commit()

    def test_handler_cannot_claim_success_after_catching_transaction_failure(self):
        class QueryTimeoutError(Exception): pass
        self.frappe.QueryTimeoutError = QueryTimeoutError
        original = QueryTimeoutError('timeout')
        def handler(*args):
            from shangshu_core.transaction_failure import raise_if_transaction_failed
            try: raise_if_transaction_failed(original)
            except QueryTimeoutError: pass
            return {'claimed_success': True}
        self.register('parent', handler, package=True)
        with self.assertRaises(QueryTimeoutError) as caught: self.execute('parent')
        self.assertIs(caught.exception, original)
        self.assertEqual(self.logs, [])
        self.assertEqual(self.requests['parent'].status, 'Running')
        self.register('next', lambda *a: {'ok': True})
        with self.assertRaises(QueryTimeoutError): self.execute('next')
        self.assertNotIn('next', self.requests)

    def test_package_summary_keeps_original_current_value_trimming(self):
        def handler(action, payload, context):
            context['record_changes'] = copy.deepcopy(self.changes)
            return {'amount': 999, 'written': len(self.changes)}
        self.register('batch', handler, package=True)
        receipt = self.execute('batch')
        self.assertEqual(receipt['result']['amount'], 999)
        self.assertNotIn('amount', self.logs[0]['detail']['result_summary'])
        self.assertEqual(self.logs[0]['detail']['package']['steps'][0]['record_changes'], self.changes)

    def test_root_log_failure_never_returns_success_or_leaks_scope(self):
        self.register('batch', self.batch_handler, package=True)
        self.fail_log = True
        with self.assertRaisesRegex(RuntimeError, 'audit store unavailable'):
            self.execute('batch')
        self.assertEqual(self.logs, [])
        self.assertEqual(self.requests['batch'].status, 'Failed')
        self.fail_log = False
        self.register('ordinary', lambda *a: {'ok': True})
        self.execute('ordinary')
        self.assertNotIn('package', self.logs[0]['detail'])

    def test_undeclared_or_external_child_cannot_expand_package(self):
        for name, children, effect in [('undeclared', [], 'write'), ('external', ['external'], 'external/read')]:
            with self.subTest(child=name):
                calls = []
                self.register(name, lambda *a: calls.append(name), effect=effect)
                def parent(action, payload, context):
                    try:
                        self.execute(name)
                    except ValueError:
                        pass
                    return {'claimed_success': True}
                root = 'root-' + name
                self.register(root, parent, package=True, children=children)
                with self.assertRaisesRegex(ValueError, '子动作未登记'):
                    self.execute(root)
                self.assertEqual(calls, [])
                self.assertEqual(self.logs, [])
                self.assertEqual(self.requests[root].status, 'Failed')

    def test_package_checkpoints_restore_in_reverse_and_do_not_run_after_success(self):
        from shangshu_core import action_packages
        events = []
        self.assertFalse(action_packages.register_package_rollback(lambda: events.append('outside')))
        def parent(action, payload, context):
            self.assertTrue(action_packages.register_package_rollback(lambda: events.append('first'), key='file-A'))
            self.assertFalse(action_packages.register_package_rollback(lambda: events.append('duplicate'), key='file-A'))
            self.assertTrue(action_packages.register_package_rollback(lambda: events.append('second')))
            if payload.get('fail'):
                raise ValueError('resource write failed')
            return {'ok': True}
        self.register('parent', parent, package=True)
        with self.assertRaisesRegex(ValueError, 'resource write failed'):
            self.execute('parent', 'bad', {'fail': True})
        self.assertEqual(events, ['second', 'first'])
        self.assertIsNone(action_packages.current())
        self.execute('parent', 'good')
        self.assertEqual(events, ['second', 'first'])
        self.assertIsNone(action_packages.current())

    def test_previously_succeeded_child_cannot_be_spliced_into_new_root_package(self):
        calls = []
        self.register('child', lambda *a: calls.append('child') or {'name': 'R0'})
        previous = self.execute('child', 'already-done')
        previous_log = copy.deepcopy(self.logs)
        previous_request = self.requests['already-done']
        def parent(action, payload, context):
            return {'child': self.execute('child', 'already-done')}
        self.register('parent', parent, package=True, children=['child'])
        with self.assertRaisesRegex(ValueError, '不能拼接旧执行'):
            self.execute('parent')
        self.assertEqual(calls, ['child'])
        self.assertEqual(self.logs, previous_log)
        self.assertIs(self.requests['already-done'], previous_request)
        self.assertEqual(previous_request.status, 'Succeeded')
        self.assertEqual(previous_request.execution_audit, previous['audit'])
        self.assertEqual(self.requests['parent'].status, 'Failed')

    def test_compensation_failure_keeps_root_failure_binding_and_blocks_commit(self):
        from shangshu_core import action_packages
        restored = []
        def restore_failure():
            raise RuntimeError('checkpoint unavailable')
        def parent(action, payload, context):
            action_packages.register_package_rollback(lambda: restored.append('earlier-resource'))
            action_packages.register_package_rollback(restore_failure)
            raise ValueError('handler failed')
        self.register('parent', parent, package=True)
        with self.assertRaisesRegex(RuntimeError, '资源回滚失败') as caught:
            self.execute('parent')
        failure = getattr(caught.exception, '_ss_failed_action', None)
        self.assertIsNotNone(failure, '替换异常仍须携带HTTP失败回执绑定')
        self.assertEqual(failure[0], 'parent')
        self.assertEqual(restored, ['earlier-resource'])
        self.assertEqual(self.requests['parent'].status, 'Failed')
        self.assertEqual(self.logs, [])
        self.assertIsNone(action_packages.current())
        with self.assertRaisesRegex(RuntimeError, '资源回滚失败'):
            self.frappe.db.commit()
        self.assertEqual(self.commits, [])

    def test_conditional_package_false_keeps_native_calls_and_foreign_guard_is_rejected(self):
        calls = []
        self.register('child', lambda *a: calls.append('child') or {'ok': True})
        def parent(action, payload, context):
            calls.append('parent')
            return {'child': self.execute('child')}
        self.register('parent', parent, package=True)
        self.resources['parent']['package_guard'] = 'shangshu_core.test.native_guard'
        self.handlers['shangshu_core.test.native_guard'] = lambda payload: False
        self.execute('parent')
        self.assertEqual(calls, ['parent', 'child'])
        self.assertEqual(len(self.logs), 2)
        self.assertTrue(all('package' not in entry['detail'] for entry in self.logs))
        baseline_logs = copy.deepcopy(self.logs)
        self.register('foreign', lambda *a: calls.append('foreign'), package=True)
        self.resources['foreign']['package_guard'] = 'another_app.guard'
        self.handlers['another_app.guard'] = lambda payload: True
        with self.assertRaisesRegex(ValueError, '动作原域'):
            self.execute('foreign')
        self.assertEqual(calls, ['parent', 'child'])
        self.assertEqual(self.logs, baseline_logs)

    def test_caught_migration_attempt_still_fails_package(self):
        from shangshu_core import action_packages
        def parent(action, payload, context):
            try:
                action_packages.reject_migration()
            except ValueError:
                pass
            return {'claimed_success': True}
        self.register('parent', parent, package=True)
        with self.assertRaisesRegex(ValueError, 'DDL'):
            self.execute('parent')
        self.assertEqual(self.logs, [])
        self.assertEqual(self.requests['parent'].status, 'Failed')
        self.assertIsNone(action_packages.current())


if __name__ == '__main__':
    unittest.main()
