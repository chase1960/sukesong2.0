"""批量审计真实持久化/原生校验/钩子/回滚；只允许独立测试站运行。"""
import json
import uuid
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import unified_log


class TestUnifiedLogBatch(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.prefix = 'batch-log-' + uuid.uuid4().hex
        from shangshu_core.identity import ensure_identity_for_user
        self.identity = ensure_identity_for_user('Administrator')
        self.created = []

    def tearDown(self):
        if self.created:
            from shangshu_core.tests.test_promotion_records import TestPromotionRecords
            TestPromotionRecords._cleanup(self)
        super().tearDown()

    def entries(self, count=3):
        return [dict(kind='action', what_id='platform.object.update_many',
                     actor_user='Administrator', actor_identity=self.identity,
                     result='Succeeded', business_object_id='test.batch.logs',
                     business_name=f'R{i}', idempotency_key=f'{self.prefix}-{i}',
                     detail={'action_version': '1.0.0', 'record_changes': {
                         'changes': [{'field': 'amount', 'before': i, 'after': None}]}})
                for i in range(count)]

    def stored(self):
        return frappe.get_all(unified_log.LOG_DOCTYPE,
            filters={'idempotency_key': ['like', self.prefix + '%']},
            fields=['name', 'actor_user', 'actor_identity', 'business_name', 'detail_json'],
            limit_page_length=0, order_by='name asc')

    def test_batch_really_inserts_every_complete_row_and_native_metadata(self):
        entries = self.entries()
        with patch.object(frappe.db, 'bulk_insert', wraps=frappe.db.bulk_insert) as bulk:
            docs = unified_log.write_logs(entries)
        self.assertEqual(bulk.call_count, 1)
        self.assertEqual(len(self.stored()), 3)
        for i, doc in enumerate(docs):
            fresh = frappe.get_doc(unified_log.LOG_DOCTYPE, doc.name)
            self.assertEqual(fresh.log_no, fresh.name)
            self.assertEqual(fresh.actor_identity, self.identity)
            self.assertEqual(fresh.business_name, f'R{i}')
            self.assertEqual(json.loads(fresh.detail_json), entries[i]['detail'])
            self.assertEqual(fresh.owner, 'Administrator')
            self.assertTrue(fresh.creation and fresh.modified)
        self.assertEqual(len({d.name for d in docs}), 3)

    def test_duplicate_keys_retry_and_single_entry_keep_identity(self):
        entries = self.entries()
        docs = unified_log.write_logs(entries + [entries[0]])
        retry = unified_log.write_logs(entries)
        single = unified_log.write_log(**entries[0])
        self.assertEqual(len(self.stored()), 3)
        self.assertEqual(docs[0].name, docs[-1].name)
        self.assertEqual(single.name, docs[0].name)
        self.assertEqual([d.name for d in retry], [d.name for d in docs[:3]])

    def test_native_links_and_mandatory_validation_still_reject(self):
        for field, value in (('actor_user', 'absent-user-' + self.prefix), ('what_id', '')):
            entries = self.entries()
            entries[1][field] = value
            with self.assertRaises(frappe.ValidationError):
                unified_log.write_logs(entries)
            self.assertEqual(self.stored(), [])

    def test_after_insert_can_read_entire_batch_and_hook_failure_rolls_back(self):
        controller = type(frappe.get_doc({'doctype': unified_log.LOG_DOCTYPE}))
        original = controller.run_method
        observed = []

        def run(doc, event, *args, **kwargs):
            result = original(doc, event, *args, **kwargs)
            if event == 'after_insert' and str(doc.idempotency_key).startswith(self.prefix):
                observed.append(len(self.stored()))
                if len(observed) == 2:
                    raise RuntimeError('after_insert test failure')
            return result

        with patch.object(controller, 'run_method', run):
            with self.assertRaisesRegex(RuntimeError, 'after_insert test failure'):
                unified_log.write_logs(self.entries())
        self.assertEqual(observed, [3, 3])
        self.assertEqual(self.stored(), [])

    def test_extension_failure_rolls_back_main_rows(self):
        entries = self.entries()
        entries[1]['extension_values'] = {'not_declared': 1}
        entries[1]['domain_id'] = 'com.shangshu.test.absent.' + self.prefix
        with self.assertRaises(frappe.ValidationError):
            unified_log.write_logs(entries)
        self.assertEqual(self.stored(), [])

    def test_existing_append_only_guard_still_applies(self):
        doc = unified_log.write_logs(self.entries())[0]
        fresh = frappe.get_doc(unified_log.LOG_DOCTYPE, doc.name)
        fresh.detail_json = '{}'
        with self.assertRaises(frappe.ValidationError):
            fresh.save(ignore_permissions=True)

    def _managed_payload(self):
        from shangshu_core import promotion_records
        from shangshu_core.tests.test_promotion_records import TestPromotionRecords, rows_for
        self.key, self.table = self.prefix, self.prefix[:50]
        bound = TestPromotionRecords._provision(self, rows=rows_for(2))
        state = promotion_records.read_promoted_values(object_id=bound['object_id'], records=bound['records'], row_ids=list(bound['records']))
        payload = {'object_id': bound['object_id'], 'expected_revision': bound['revision'],
                   'records': [{'name': name, 'expected_modified': state['versions'][row],
                                'values': {'amount': 100 + index}}
                               for index, (row, name) in enumerate(bound['records'].items())]}
        return bound, state, payload

    def test_public_update_many_without_row_keys_keeps_one_package_audit_and_retries_once(self):
        from shangshu_core.public_api import execute_registered_action
        bound, before, payload = self._managed_payload()
        key = self.prefix + ':public-batch'
        first = execute_registered_action('platform.object.update_many', payload,
                                         confirmed=True, idempotency_key=key)
        replay = execute_registered_action('platform.object.update_many', payload,
                                          confirmed=True, idempotency_key=key)
        rows = frappe.get_all(unified_log.LOG_DOCTYPE,
            filters={'what_id': 'platform.object.update_many', 'business_object_id': bound['object_id']},
            fields=['name', 'business_name', 'idempotency_key', 'detail_json'], limit_page_length=0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].idempotency_key, key)
        self.assertEqual(rows[0].business_name, '')
        self.assertEqual(first['audit'], rows[0].name)
        self.assertEqual(first['audit'], replay['audit'])
        self.assertTrue(replay['idempotent'])
        package = json.loads(rows[0].detail_json)['package']
        self.assertEqual(package['record_count'], 2)
        self.assertEqual(package['change_count'], 2)
        self.assertEqual(len(package['steps']), 1)
        self.assertEqual({row['name'] for row in package['steps'][0]['record_changes']},
                         set(bound['records'].values()))

    def test_public_update_many_duplicate_row_keys_rolls_back_records(self):
        from shangshu_core import promotion_records
        from shangshu_core.public_api import execute_registered_action
        bound, before, payload = self._managed_payload()
        for record in payload['records']:
            record['idempotency_key'] = self.prefix + ':same-row-key'
        with self.assertRaisesRegex(frappe.ValidationError, '审计键重复'):
            execute_registered_action('platform.object.update_many', payload,
                                      confirmed=True, idempotency_key=self.prefix + ':public-batch')
        after = promotion_records.read_promoted_values(object_id=bound['object_id'], records=bound['records'], row_ids=list(bound['records']))
        self.assertEqual(before['values'], after['values'])
        self.assertEqual(before['versions'], after['versions'])
        self.assertFalse(frappe.db.exists(unified_log.LOG_DOCTYPE,
            {'what_id': 'platform.object.update_many', 'business_object_id': bound['object_id']}))


    def test_merged_query_source_projection_count_and_pages_on_real_database(self):
        fixtures = [
            ('agent', {}), ('scheduled', {}), ('scheduled', {'executor_source': 'cron'}),
            ('scheduled', {'executor_source': 'scheduler'}), ('agent', {'executor_source': 'ai'}),
            ('agent', {'executor_source': ''}), ('agent', {'executor_source': None}),
            ('agent', {'executor_source': False}), ('agent', {'executor_source': 0.0}),
            ('agent', {'executor_source': [], 'trigger_source': 'scheduled'}),
            ('agent', {'executor_source': 'manual', 'trigger_source': 'agent'}),
            ('agent', {'executor_source': 'AI'}), ('agent', {'executor_source': ' '}),
            ('agent', {'executor_source': 'agent '}),
            ('agent', {'executor_source': 1e-100}), ('agent', {'executor_source': -1e-100}),
            ('agent', {'executor_source': -0.0}), ('agent', {'executor_source': True}),
            ('agent', {'executor_source': [1]}), ('agent', {'executor_source': {'x': 1}}),
            ('agent', {'executor_source': '0'}), ('agent', {'executor_source': 'false'}),
            ('agent', {'executor_source': 'a' * 191 + 'x'}),
            ('agent', {'executor_source': 'a' * 191 + 'y'}),
            ('agent', {'executor_source': '中' * 100}),
        ]
        entries = self.entries(len(fixtures))
        for entry, (source, legacy) in zip(entries, fixtures):
            entry.update(trigger_source=source, detail={'legacy': legacy})
        docs = unified_log.write_logs(entries)
        raw = [doc.as_dict() for doc in docs]
        for source in ('agent', 'ai', 'AI', 'assistant', 'scheduled', 'cron', 'scheduler', ' ', 'agent ',
                       '0', 'false', 'a' * 191 + 'x', 'a' * 191 + 'y', '中' * 100):
            with self.subTest(source=source):
                filters = {'executor_source': source, 'idempotency_key': ['like', self.prefix + '%'],
                           'actor_identity': ['in', [self.identity]]}
                expected = sorted([row for row in raw if unified_log._keep(
                    unified_log.project_action_row(row), {'executor_source': source})],
                    key=lambda row: (row['creation'], row['name']), reverse=True)
                with patch.object(frappe, 'get_all', wraps=frappe.get_all) as fetch:
                    total = unified_log.merged_legacy_count(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters)
                self.assertEqual(total, len(expected))
                self.assertEqual(fetch.call_count, 0)
                actual = []
                for offset in range(0, total, 2):
                    with patch.object(frappe, 'get_all', wraps=frappe.get_all) as fetch:
                        page = unified_log.merged_legacy_rows(unified_log.LEGACY_AUDIT_DOCTYPE, 'action',
                            filters, limit_start=offset, limit_page_length=2)
                    self.assertEqual(len(page), min(2, total - offset))
                    self.assertLessEqual(sum(len(call.kwargs['filters']['name'][1])
                                             for call in fetch.call_args_list), 2)
                    actual.extend(row.name for row in page)
                self.assertEqual(actual, [row['name'] for row in expected])

    def test_generated_source_is_maintained_for_native_inserts_and_keeps_long_values(self):
        entries = self.entries(3)
        values = ('AI', 'agent ', 'a' * 191 + 'suffix')
        for entry, source in zip(entries, values):
            entry.update(detail={'legacy': {'executor_source': source, 'trigger_source': 'agent'}})
        docs = unified_log.write_logs(entries)
        for doc, source in zip(docs, values):
            row = frappe.db.sql('SELECT ssq_action_source_v1,ssq_event_source_v1,ssq_legacy_trigger_v1,'
                                'ssq_action_key_v1 FROM `tabShangshu Unified Log` WHERE name=%s', [doc.name])[0]
            self.assertEqual(row[:3], (source.encode(), source.encode(), b'agent'))
            self.assertEqual(row[3], source.encode() if len(source.encode()) <= 191 else None)
            self.assertEqual(frappe.db.get_value(unified_log.LOG_DOCTYPE, doc.name, 'detail_json'), doc.detail_json)

    def test_event_source_filter_uses_own_projection_and_legacy_alias(self):
        fixtures = ({}, {'executor_source': False}, {'executor_source': 'AI'},
                    {'executor_source': 'agent '}, {'executor_source': 'cron', 'trigger_source': 'scheduled'})
        entries = self.entries(len(fixtures))
        for entry, legacy in zip(entries, fixtures):
            entry.update(kind='event', trigger_source='agent', detail={'legacy': legacy})
        docs = unified_log.write_logs(entries)
        for source in ('agent', 'AI', 'ai', 'agent ', 'cron', 'scheduler'):
            filters = {'executor_source': source, 'idempotency_key': ['like', self.prefix + '%'],
                       'actor_identity': ['in', [self.identity]]}
            expected = {doc.name for doc in docs if unified_log._keep(
                unified_log.project_event_row(doc.as_dict()), {'executor_source': source})}
            actual = unified_log.merged_legacy_rows(unified_log.LEGACY_EVENT_DOCTYPE, 'event', filters,
                                                   projector=unified_log.project_event_row)
            self.assertEqual({row.name for row in actual}, expected)
            self.assertEqual(unified_log.merged_legacy_count(unified_log.LEGACY_EVENT_DOCTYPE, 'event',
                filters, projector=unified_log.project_event_row), len(expected))

    def test_projection_migration_is_idempotent_after_schema_sync(self):
        from shangshu_core.log_query_storage import ensure_log_query_storage
        with patch.object(frappe.db, 'sql_ddl', wraps=frappe.db.sql_ddl) as ddl:
            self.assertEqual(ensure_log_query_storage(), {'version': 1, 'added': 0})
        self.assertEqual(ddl.call_count, 0)

    def test_merged_query_keeps_legacy_rows_and_authorized_ascending_pages(self):
        old = frappe.get_doc({
            'doctype': unified_log.LEGACY_AUDIT_DOCTYPE, 'action_id': 'platform.object.update_many',
            'action_version': '1.0.0', 'actor_identity': self.identity, 'actor_user': 'Administrator',
            'executor_source': 'ai', 'input_summary_json': '{}', 'result_summary_json': '{}',
            'idempotency_key': self.prefix + '-legacy', 'status': 'Succeeded',
        }).insert(ignore_permissions=True)
        docs = unified_log.write_logs(self.entries(5))
        filters = {'idempotency_key': ['like', self.prefix + '%'],
                   'actor_identity': ['in', [self.identity]], 'status': 'Succeeded'}
        expected = sorted([old] + docs, key=lambda doc: (doc.creation, doc.name))
        actual = []
        for offset in (0, 2, 4):
            actual.extend(unified_log.merged_legacy_rows(unified_log.LEGACY_AUDIT_DOCTYPE, 'action',
                filters, order_by='creation asc', limit_start=offset, limit_page_length=2))
        self.assertEqual([row.name for row in actual], [doc.name for doc in expected])
        self.assertEqual(unified_log.merged_legacy_count(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters), 6)
        filters['actor_identity'] = ['in', []]
        self.assertEqual(unified_log.merged_legacy_rows(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters), [])
        self.assertEqual(unified_log.merged_legacy_count(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', filters), 0)

    def test_merged_query_unknown_filter_fails_before_sql(self):
        with patch.object(frappe.db, 'sql', wraps=frappe.db.sql) as query:
            for operation in (unified_log.merged_legacy_count, unified_log.merged_legacy_rows):
                with self.assertRaises(frappe.ValidationError):
                    operation(unified_log.LEGACY_AUDIT_DOCTYPE, 'action', {'unknown_filter': 'ignored?'})
            with self.assertRaises(frappe.ValidationError):
                unified_log.unified_rows('action', {'creation': ['unsupported operator', 'x']})
        self.assertEqual(query.call_count, 0)
