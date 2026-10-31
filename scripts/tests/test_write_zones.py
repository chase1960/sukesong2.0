"""细锁准入只减少锁范围，不跳保存、规则或审计；真实gap锁由双连接验证。"""
import importlib.util
import hashlib
import json
import sys
import unittest
from collections import deque
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/write_zones.py'


class Callbacks:
    def __init__(self): self._functions = deque()
    def add(self, callback): self._functions.append(callback)
    def run(self):
        while self._functions: self._functions.popleft()()


class WriteZones(unittest.TestCase):
    def setUp(self):
        self.db = SimpleNamespace(transaction_writes=0, auto_commit_on_many_writes=False,
            sql=Mock(), **{key: Callbacks() for key in
                ('before_commit', 'after_commit', 'before_rollback', 'after_rollback')})
        self.flags = SimpleNamespace()
        self.frappe = SimpleNamespace(db=self.db, flags=self.flags, ValidationError=ValueError,
            local=SimpleNamespace(request=SimpleNamespace(method='POST'),
                form_dict={'cmd': 'shangshu_core.public_api.http.action_execute'}, dev_server=False),
            session=SimpleNamespace(user='staff@example.test'),
            conf=SimpleNamespace(developer_mode=False), get_hooks=Mock(return_value=[]))
        self.frappe.throw = lambda message, error: (_ for _ in ()).throw(error(message))
        self.package = SimpleNamespace(current=lambda: None)
        self.provenance = SimpleNamespace(current_action_origin=lambda: None,
                                         _node=SimpleNamespace(get=lambda: None))
        self.failure = SimpleNamespace(raise_if_transaction_failed=lambda error: None,
                                       mark_transaction_failed=lambda error, **kwargs: error)
        cert = SimpleNamespace(certificate_for=lambda model: dict(protocol=1,
            revision=int(model.active_revision), physical_doctype=model.physical_doctype,
            definition_hash=hashlib.sha256(model.active_json.encode()).hexdigest()))
        modules = {'frappe': self.frappe, 'shangshu_core': SimpleNamespace(),
            'shangshu_core.action_packages': self.package,
            'shangshu_core.action_provenance': self.provenance,
            'shangshu_core.transaction_failure': self.failure,
            'shangshu_core.write_zone_certification': cert}
        scope = patch.dict(sys.modules, modules); scope.start(); self.addCleanup(scope.stop)
        spec = importlib.util.spec_from_file_location('tested_write_zones', SOURCE)
        self.zones = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.zones)
        self.model = SimpleNamespace(name='object.a', application='app.a', active_revision=3,
            physical_doctype='SSM ABC', active_json='{"kind":"record","fields":[]}', enterprise_id='E')
        cert = {**self.zones._certificate(self.model), 'certification_id': 'a' * 32}
        self.model.write_zone_certification = json.dumps(cert)
        self.candidate = dict(object_id='object.a', application='app.a', certificate=cert,
                              physical_doctype='SSM ABC', user='staff@example.test')

    def scope(self):
        return self.zones.action_scope('platform.object.update_many', {'object_id': 'object.a'})

    def pin(self, version='1.1.0'):
        self.flags.shangshu_action_pin = dict(action_id='platform.object.update_many', action_version=version)

    def test_unknown_outer_context_and_cli_never_reach_runtime_probe(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate) as prepare:
            for field, value in [('shangshu_domain_execution_depth', 1),
                                 ('shangshu_action_pin', {'action_id': 'domain.outer'}),
                                 ('shangshu_resolving_proposal', 'proposal'),
                                 ('in_migrate', True), ('currently_saving', [('Other', 'R')])]:
                setattr(self.flags, field, value)
                with self.scope(): self.assertEqual(self.zones.application_lock_mode('object.a'), 'exclusive')
                delattr(self.flags, field)
            self.frappe.local.request = None
            with self.scope(): self.assertEqual(self.zones.application_lock_mode('object.a'), 'exclusive')
            prepare.assert_not_called()

    def test_process_execution_and_dirty_or_callback_transaction_are_coarse(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate) as prepare:
            self.frappe.local.form_dict['execution_id'] = 'execution'
            with self.scope(): pass
            self.frappe.local.form_dict.pop('execution_id')
            self.db.transaction_writes = 1
            with self.scope(): pass
            self.db.transaction_writes = 0
            self.db.after_commit.add(lambda: None)
            with self.scope(): pass
            self.db.after_commit._functions.clear()
            self.db.auto_commit_on_many_writes = True
            with self.scope(): pass
            prepare.assert_not_called()

    def test_pinned_old_version_stays_coarse_before_shared_lock(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate) as prepare:
            with self.zones.action_scope('platform.object.update_many', {'object_id': 'object.a'}, '1.0.0'):
                self.pin('1.0.0')
                self.assertEqual(self.zones.application_lock_mode('object.a'), 'exclusive')
            prepare.assert_not_called()

    def test_shared_marker_survives_scope_and_requires_outer_transaction_end(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate), self.scope():
            self.pin()
            self.assertEqual(self.zones.application_lock_mode('object.a'), 'shared')
            self.zones.assert_locked_model(self.model, json.loads(self.model.active_json))
        self.flags.shangshu_action_pin = None
        with self.assertRaises(ValueError):
            with self.zones.action_scope('other.action', {}): pass
        self.db.after_rollback.run()
        with self.zones.action_scope('other.action', {}): pass

    def test_certificate_drift_after_shared_never_upgrades_or_continues(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate), self.scope():
            self.pin(); self.zones.application_lock_mode('object.a')
            self.model.active_revision = 4
            with self.assertRaises(ValueError):
                self.zones.assert_locked_model(self.model, json.loads(self.model.active_json))
            with self.assertRaises(ValueError): self.zones.application_lock_mode('object.other')

    def test_recertification_of_same_definition_is_not_the_same_evidence(self):
        with patch.object(self.zones, '_prepare', return_value=self.candidate), self.scope():
            self.pin(); self.zones.application_lock_mode('object.a')
            raw = json.loads(self.model.write_zone_certification)
            raw['certification_id'] = 'b' * 32
            self.model.write_zone_certification = json.dumps(raw)
            with self.assertRaises(ValueError):
                self.zones.assert_locked_model(self.model, json.loads(self.model.active_json))

    def test_old_definition_only_certificate_does_not_admit(self):
        self.model.write_zone_certification = json.dumps(self.zones._certificate(self.model))
        self.assertFalse(self.zones._matches_certificate(self.model))

    def test_admission_error_does_not_hide_transaction_failure(self):
        error = RuntimeError('driver failed')
        self.failure.raise_if_transaction_failed = Mock(side_effect=error)
        with patch.object(self.zones, '_prepare', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                with self.scope(): pass
        self.assertIs(caught.exception, error)

    def test_configuration_disabled_rows_or_old_snapshot_do_not_admit(self):
        def sql(query, *args, **kwargs):
            if 'tabUser Type' in query: return []
            if 'LOCK IN SHARE MODE' in query: return []
            return [{'name': 'deleted-rule-in-old-read-view', 'disabled': 1}]
        self.db.sql.side_effect = sql
        self.assertFalse(self.zones._configuration_snapshot_empty())
        self.assertTrue(self.zones._lock_configuration())
        queries = [call.args[0] for call in self.db.sql.call_args_list]
        self.assertTrue(any('FORCE INDEX (PRIMARY)' in q and 'LOCK IN SHARE MODE' in q for q in queries))
        self.assertTrue(all('LIMIT' not in q and 'COUNT' not in q for q in queries))
        self.db.sql.side_effect = lambda *a, **kw: [{'name': 'disabled-rule', 'disabled': 1}]
        self.assertFalse(self.zones._lock_configuration())

    def test_user_type_standard_rows_are_allowed_but_nonstandard_are_not(self):
        self.db.sql.side_effect = lambda q, *a, **k: ([{'name': 'System User', 'is_standard': 1}]
                                                     if 'tabUser Type' in q else [])
        self.assertTrue(self.zones._lock_configuration())
        self.db.sql.side_effect = lambda q, *a, **k: ([{'name': 'Custom', 'is_standard': 0}]
                                                     if 'tabUser Type' in q else [])
        self.assertFalse(self.zones._lock_configuration())

    def test_runtime_server_script_map_empty_sentinel_and_stale_maps(self):
        self.assertTrue(self.zones._script_map_empty({'permission_query': {}}))
        self.assertFalse(self.zones._script_map_empty({'SSM ABC': {'Before Save': ['script']}}))
        self.assertFalse(self.zones._script_map_empty({'permission_query': {'SSM ABC': 'script'}}))

    def test_known_hooks_allow_no_extra_target_or_global_handler(self):
        self.frappe.get_doc_hooks = lambda: {'*': self.zones._DOC_EVENTS}
        self.frappe.get_hooks = lambda key, *a: self.zones._HOOK_LISTS.get(key, {})
        self.assertTrue(self.zones._hooks_known(('SSM ABC', 'Shangshu Action Request', 'Shangshu Unified Log')))
        self.frappe.get_doc_hooks = lambda: {'*': self.zones._DOC_EVENTS,
                                            'Shangshu Unified Log': {'after_insert': ['app.hidden_write']}}
        self.assertFalse(self.zones._hooks_known(('SSM ABC', 'Shangshu Action Request', 'Shangshu Unified Log')))

    def test_actual_cache_accessors_cover_request_log_and_assignment_due_date(self):
        maps = {}
        get_map = Mock(side_effect=lambda *a, **kw: maps.get(
            (kw.get('doctype') or a[0], kw.get('name') or a[1]), maps.get(kw.get('name') or a[1], [])))
        workflow = Mock(return_value='')
        milestone = Mock(return_value=[])
        scripts = Mock(return_value={'permission_query': {}})
        modules = {
            'frappe.model.workflow': SimpleNamespace(get_workflow_name=workflow),
            'frappe.integrations.doctype.webhook': SimpleNamespace(get_all_webhooks=lambda: {}),
            'frappe.core.doctype.server_script.server_script_utils': SimpleNamespace(get_server_script_map=scripts),
            'frappe.automation.doctype.milestone_tracker.milestone_tracker': SimpleNamespace(get_milestone_trackers=milestone),
            'frappe.core.doctype.user_type.user_type': SimpleNamespace(get_non_standard_user_types=lambda: {}),
            'frappe.cache_manager': SimpleNamespace(get_doctype_map=get_map),
        }
        values, hashes = {}, {}
        self.frappe.get_all = Mock(return_value=[])
        self.frappe.cache = SimpleNamespace(
            get_value=lambda key, fn: values.setdefault(key, fn()),
            hget=lambda key, name, fn: hashes.setdefault((key, name), fn()))
        closure = ('SSM ABC', 'Shangshu Action Request', 'Shangshu Unified Log')
        with patch.dict(sys.modules, modules):
            self.assertTrue(self.zones._cache_configuration_empty(closure))
            get_map.assert_any_call(doctype='Assignment Rule', name='due_date_rules_for_Shangshu Unified Log',
                filters={'due_date_based_on': ['is', 'set'], 'document_type': 'Shangshu Unified Log', 'disabled': 0})
            self.assertEqual(set(call.args[0] for call in workflow.call_args_list), set(closure))
            hashes[('notifications', 'Shangshu Action Request')] = [{'name': 'stale-cache'}]
            self.assertFalse(self.zones._cache_configuration_empty(closure))
            hashes[('notifications', 'Shangshu Action Request')] = []
            maps['due_date_rules_for_Shangshu Unified Log'] = [{'name': 'stale-due-date-rule'}]
            self.assertFalse(self.zones._cache_configuration_empty(closure))
            maps.clear()
            maps[('Document Naming Rule', 'Shangshu Unified Log')] = [{'name': 'stale-naming-rule'}]
            self.assertFalse(self.zones._cache_configuration_empty(closure))

    def test_identity_current_snapshot_and_actual_request_cache_must_agree(self):
        user = dict(name='staff@example.test', enabled=1, follow_created_documents=0)
        identity = dict(name='I', user=user['name'], status='Active', enterprise_id='E')
        self.db.sql.side_effect = lambda query, *a, **k: [user if '`tabUser`' in query else identity]
        self.frappe.get_cached_value = Mock(return_value=0)
        module = SimpleNamespace(get_identity=lambda: SimpleNamespace(**identity))
        with patch.dict(sys.modules, {'shangshu_core.identity': module}):
            snapshot = self.zones._identity_snapshot()
            self.assertTrue(snapshot)
            self.assertTrue(self.zones._lock_identity(snapshot))
            self.frappe.get_cached_value.return_value = 1
            self.assertIsNone(self.zones._identity_snapshot())
            self.frappe.get_cached_value.return_value = 0
            module.get_identity = lambda: SimpleNamespace(**{**identity, 'enterprise_id': 'OTHER'})
            self.assertIsNone(self.zones._identity_snapshot())

    def test_engine_isolation_and_autocommit_require_real_lock_semantics(self):
        settings = dict(isolation_level='REPEATABLE-READ', auto_commit=0, version='10.6.24-MariaDB')
        bad = set()
        def sql(query, values=(), **kwargs):
            if 'tx_isolation' in query: return [settings]
            return [dict(name=name, engine='MyISAM' if name in bad else 'InnoDB') for name in values]
        self.db.sql.side_effect = sql
        self.assertTrue(self.zones._engine_known(('SSM ABC',)))
        settings['isolation_level'] = 'READ-COMMITTED'
        self.assertFalse(self.zones._engine_known(('SSM ABC',)))
        settings['isolation_level'] = 'REPEATABLE-READ'; settings['auto_commit'] = 1
        self.assertFalse(self.zones._engine_known(('SSM ABC',)))
        settings['auto_commit'] = 0; bad.add('tabSSM ABC')
        self.assertFalse(self.zones._engine_known(('SSM ABC',)))

    def test_current_public_action_id_cannot_authorize_a_different_handler(self):
        resource = dict(handler='shangshu_core.model_records.write_records', transaction='atomic_package',
                        transaction_versions=['1.1.0'], package_actions=[])
        module = SimpleNamespace(raw_resource=lambda *a: ({'id': 'com.shangshu.core'}, resource))
        with patch.dict(sys.modules, {'shangshu_core.domains': module}):
            self.assertTrue(self.zones._action_known())
            resource['execution_guard'] = 'domain.arbitrary_write'
            self.assertFalse(self.zones._action_known())
            resource.pop('execution_guard'); resource['handler'] = 'domain.replacement'
            self.assertFalse(self.zones._action_known())

    def test_log_request_metadata_and_plain_controller_are_part_of_execution_scope(self):
        class Document: pass
        class Request(Document): pass
        class Log(Document): pass
        class Custom(Document): pass
        closure = ('SSM ABC', 'Shangshu Action Request', 'Shangshu Unified Log')
        controllers = dict(zip(closure, (Document, Request, Log)))
        options = {name: {} for name in closure}
        options['Shangshu Action Request']['autoname'] = 'field:request_key'
        options['Shangshu Unified Log']['autoname'] = 'field:log_no'
        self.frappe.get_meta = lambda name: SimpleNamespace(get=lambda key: options[name].get(key),
            get_table_fields=lambda: [], get_global_search_fields=lambda: [], fields=[])
        modules = {
            'frappe.model.base_document': SimpleNamespace(get_controller=lambda name: controllers[name]),
            'frappe.model.document': SimpleNamespace(Document=Document),
            'shangshu_core.shangshu_core.doctype.shangshu_action_request.shangshu_action_request':
                SimpleNamespace(ShangshuActionRequest=Request),
            'shangshu_core.shangshu_core.doctype.shangshu_unified_log.shangshu_unified_log':
                SimpleNamespace(ShangshuUnifiedLog=Log),
        }
        with patch.dict(sys.modules, modules):
            self.assertTrue(self.zones._meta_known(closure))
            options['Shangshu Unified Log']['track_changes'] = 1
            self.assertFalse(self.zones._meta_known(closure))
            options['Shangshu Unified Log'].pop('track_changes')
            options['Shangshu Unified Log']['autoname'] = 'LOG-.YYYY.-.#####'
            self.assertFalse(self.zones._meta_known(closure))
            options['Shangshu Unified Log']['autoname'] = 'field:log_no'; controllers['SSM ABC'] = Custom
            self.assertFalse(self.zones._meta_known(closure))

    def test_document_naming_configuration_is_in_complete_lock_range(self):
        self.db.sql.side_effect = lambda q, *a, **kw: ([{'name': 'disabled-log-naming'}]
            if 'tabDocument Naming Rule' in q else [])
        self.assertFalse(self.zones._lock_configuration())

    def _prepare_without_framework_io(self, stack):
        for name in ('_framework_known', '_hooks_known', '_action_known', '_engine_known',
                     '_meta_known', '_cache_configuration_empty'):
            stack.enter_context(patch.object(self.zones, name, return_value=True))
        user = dict(name='staff@example.test', enabled=1, follow_created_documents=0)
        identity = dict(name='I', user=user['name'], status='Active', enterprise_id='E')
        def sql(query, *args, **kwargs):
            if 'tabShangshu Object Model' in query: return [self.model]
            if '`tabUser`' in query: return [user]
            if 'tabShangshu Identity' in query: return [identity]
            return []
        self.db.sql.side_effect = sql
        self.frappe.get_cached_value = Mock(return_value=0)
        stack.enter_context(patch.dict(sys.modules, {'shangshu_core.identity':
            SimpleNamespace(get_identity=lambda: SimpleNamespace(**identity))}))
        return sql

    def test_existing_naming_rule_coarse_path_does_not_take_new_shared_locks(self):
        with ExitStack() as stack:
            sql = self._prepare_without_framework_io(stack)
            self.db.sql.side_effect = lambda q, *a, **kw: ([{'name': 'naming-rule'}]
                if 'tabDocument Naming Rule' in q else sql(q, *a, **kw))
            with self.scope():
                self.pin(); self.assertEqual(self.zones.application_lock_mode('object.a'), 'exclusive')
            self.assertFalse(any('LOCK IN SHARE MODE' in call.args[0] for call in self.db.sql.call_args_list))

    def test_change_after_configuration_locks_poison_even_if_parent_catches(self):
        for stage in ('configuration', 'identity', 'ordinary_error'):
            with self.subTest(stage=stage), ExitStack() as stack:
                self._prepare_without_framework_io(stack)
                stack.enter_context(patch.object(self.zones, '_lock_configuration', return_value=stage != 'configuration'))
                stack.enter_context(patch.object(self.zones, '_lock_identity', return_value=False,
                    side_effect=OSError('lock phase ordinary failure') if stage == 'ordinary_error' else None))
                # 使用真实事务失败模块证明catch后commit仍拒，不能把普通异常吞回coarse。
                spec = importlib.util.spec_from_file_location('real_zone_transaction_failure', SOURCE.with_name('transaction_failure.py'))
                guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
                stack.enter_context(patch.dict(sys.modules, {'shangshu_core.transaction_failure': guard}))
                self.db.commit = Mock()
                self.db.rollback = Mock(side_effect=self.db.before_commit._functions.clear)
                with self.assertRaises(Exception):
                    with self.scope(): pass
                for _ in range(2):
                    with self.assertRaises(Exception): self.db.commit()
                self.db.rollback()
                self.db.commit()

    def test_pinned_scope_change_after_admission_never_falls_back_to_exclusive(self):
        for change in ('object', 'version', 'user'):
            with self.subTest(change=change), ExitStack() as stack:
                spec = importlib.util.spec_from_file_location('real_zone_transaction_failure', SOURCE.with_name('transaction_failure.py'))
                guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
                stack.enter_context(patch.dict(sys.modules, {'shangshu_core.transaction_failure': guard}))
                self.db.commit = Mock()
                self.db.rollback = Mock(side_effect=self.db.before_commit._functions.clear)
                token = self.zones._current.set(self.candidate)
                try:
                    self.pin('1.0.0' if change == 'version' else '1.1.0')
                    self.frappe.session.user = 'other' if change == 'user' else 'staff@example.test'
                    with self.assertRaises(Exception):
                        self.zones.application_lock_mode('other' if change == 'object' else 'object.a')
                    with self.assertRaises(Exception): self.db.commit()
                    self.db.rollback()
                finally:
                    self.zones._current.reset(token)
                    self.frappe.session.user = 'staff@example.test'


if __name__ == '__main__': unittest.main()
