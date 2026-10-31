"""真实批量日志编排的离线判据；SQL与Document是计数替身，原生校验另由实库测试证明。"""
import copy
import json
import re
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import load_module_functions

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/unified_log.py'


class Attr(dict):
    def __getattr__(self, key):
        return self.get(key)
    def __setattr__(self, key, value):
        self[key] = value
    def __delattr__(self, key):
        self.pop(key, None)


class Invalid(Exception):
    pass


class FakeDB:
    def __init__(self):
        self.rows, self.calls, self.points = {}, [], {}
        self.markers = {}
        self.on_marker_lock = None
        self.fail_insert = False

    def get_values(self, doctype, filters, **kwargs):
        self.calls.append(('lookup', kwargs.get('for_update', False)))
        wanted = filters['idempotency_key'][1]
        return [row for row in self.rows.values() if row['what_kind'] == 'action'
                and row['idempotency_key'] in wanted]

    def savepoint(self, name):
        self.points[name] = (copy.deepcopy(self.rows), copy.deepcopy(self.markers))

    def rollback(self, *, save_point):
        self.calls.append(('rollback', save_point))
        self.rows, self.markers = self.points[save_point]

    def bulk_insert(self, doctype, columns, values):
        self.calls.append(('insert', len(values)))
        if self.fail_insert:
            raise Invalid('insert failed')
        for values_ in values:
            row = dict(zip(columns, values_))
            if row['name'] in self.rows:
                raise Invalid('duplicate name')
            self.rows[row['name']] = row

    def sql(self, query, values=(), **kwargs):
        key = values[0] if values else None
        if query.startswith('INSERT INTO `tabSeries`'):
            self.calls.append(('key-lock', key))
            if self.on_marker_lock:
                callback, self.on_marker_lock = self.on_marker_lock, None
                callback(key)
            self.markers.setdefault(key, 0)
            return []
        if query.startswith('SELECT `current` FROM `tabSeries`'):
            return [(self.markers[key],)]
        if query.startswith('UPDATE `tabSeries`'):
            self.markers[key] = 1
            return []
        if query.startswith('SELECT * FROM `tabShangshu Unified Log` WHERE name='):
            self.calls.append(('current-log', key))
            return [self.rows[key]] if key in self.rows else []
        if "name REGEXP '^LOG-" in query:
            self.calls.append(('legacy-log', key))
            return [row for row in self.rows.values() if row['what_kind'] == 'action'
                    and row['idempotency_key'] == key
                    and re.fullmatch(r'LOG-[0-9]{4}-[0-9]{5,}', row['name'])]
        raise AssertionError('Unexpected SQL: ' + query)


class LogDoc(Attr):
    def __init__(self, payload, fixture):
        super().__init__(payload)
        self.__dict__['fixture'] = fixture
        self.flags = Attr()
        self.meta = SimpleNamespace(issingle=False, get_table_fields=lambda: [])

    def set(self, key, value):
        self[key] = value

    def _set_defaults(self):
        self.setdefault('docstatus', 0)
    def set_user_and_timestamp(self):
        self.creation = self.modified = '2026-10-28 12:00:00'
        self.owner = self.modified_by = 'actual-user'
    def set_docstatus(self):
        pass
    def check_permission(self, action):
        self.fixture.steps.append('permission')
    def check_if_latest(self):
        self.fixture.steps.append('new-record')
    def _validate_links(self):
        self.fixture.steps.append('links')
        if self.actor_user == 'missing-user':
            raise Invalid('invalid link')
    def run_method(self, event):
        self.fixture.steps.append(event)
        if event == 'after_insert':
            self.fixture.visible_counts.append(len(self.fixture.db.rows))
            if self.fixture.fail_hook:
                raise Invalid('hook failed')
    def set_new_name(self):
        self.name = self.log_no
    def set_parent_in_children(self):
        pass
    def validate_higher_perm_levels(self):
        self.fixture.steps.append('permlevel')
    def run_before_save_methods(self):
        self.fixture.steps.extend(['before_validate', 'validate', 'before_save'])
    def _validate(self):
        self.fixture.steps.append('native-validate')
        if not self.what_id:
            raise Invalid('missing what_id')
    def get_valid_dict(self, **kwargs):
        return {k: v for k, v in self.items() if k not in ('flags', 'meta', '__islocal')}
    def run_post_save_methods(self):
        self.fixture.steps.extend(['on_update', 'on_change'])
    def insert(self, **kwargs):
        self.fixture.ctx['_prepare_log_insert'](self)
        values = self.get_valid_dict()
        self.fixture.db.bulk_insert(self.doctype, list(values), [tuple(values.values())])
        self.fixture.ctx['_finish_log_insert'](self)
        return self


class BatchLogs(unittest.TestCase):
    def setUp(self):
        scope = patch.dict(sys.modules, {"shangshu_core.conversation_evidence": SimpleNamespace(current_conversation_key=lambda: "")})
        scope.start()
        self.addCleanup(scope.stop)
        self.db, self.steps, self.visible_counts = FakeDB(), [], []
        self.fail_hook = False
        self.extensions = []
        self.frappe = SimpleNamespace(
            db=self.db, flags=Attr(), local=SimpleNamespace(flags=Attr()),
            session=SimpleNamespace(user='actual-user'), ValidationError=Invalid,
            throw=lambda message, error=Invalid: (_ for _ in ()).throw(error(message)),
            get_doc=lambda payload: LogDoc(payload, self), generate_hash=lambda **kw: 'test',
            get_cached_value=lambda *a: False)
        self.ctx = load_module_functions(SOURCE, {'write_logs', 'write_log'},
            stubs={'frappe': self.frappe}, overrides={'now_datetime': lambda: '2026-10-28 12:00:00'})
        # 本组隔离包调度；真实 collector 的唯一写闸由 test_action_packages 覆盖。
        self.ctx['_assert_log_write'] = lambda *args: None

        document = SimpleNamespace(follow_document=lambda *a: None,
                                   relink_mismatched_files=lambda doc: self.steps.append('relink'))
        scoped = patch.dict(sys.modules, {'frappe.model.document': document,
            'shangshu_core.transaction_failure': SimpleNamespace(raise_if_transaction_failed=lambda error: None)})
        scoped.start()
        self.addCleanup(scoped.stop)
        self.ctx['write_extension'] = lambda *args: self.extensions.append(args)

    def entries(self, count=3):
        return [dict(kind='action', what_id='platform.object.update_many',
                     idempotency_key=f'key-{i}', actor_user='actual-user', actor_identity='identity',
                     business_name=f'R{i}', result='Succeeded', detail={'before': i, 'after': None})
                for i in range(count)]

    def test_500_logs_keep_values_and_native_hooks_with_one_physical_batch(self):
        docs = self.ctx['write_logs'](self.entries(500))
        self.assertEqual(len(self.db.rows), 500)
        self.assertEqual([c for c in self.db.calls if c[0] == 'insert'], [('insert', 500)])
        self.assertEqual(len(self.db.markers), 500)
        self.assertEqual(set(self.db.markers.values()), {1})
        self.assertTrue(all(re.fullmatch(r'LOG-[0-9a-f]{64}', doc.name) for doc in docs))
        self.assertEqual(self.visible_counts, [500] * 500)
        for i, doc in enumerate(docs):
            self.assertEqual(doc.business_name, f'R{i}')
            self.assertEqual(json.loads(doc.detail_json), {'before': i, 'after': None})
            self.assertEqual(doc.owner, 'actual-user')
        for event in ('links', 'before_insert', 'native-validate', 'after_insert', 'on_update', 'on_change'):
            self.assertEqual(self.steps.count(event), 500)

    def test_retry_and_duplicate_key_return_existing_identity(self):
        entries = self.entries()
        first = self.ctx['write_logs'](entries + [entries[0]])
        second = self.ctx['write_logs'](entries)
        self.assertEqual(len(self.db.rows), 3)
        self.assertEqual(first[0].name, first[3].name)
        self.assertEqual([d.name for d in first[:3]], [d.name for d in second])
        self.assertEqual(len(self.db.markers), 3)

    def test_invalid_link_or_missing_required_field_reject_whole_batch(self):
        for patch_ in ({'actor_user': 'missing-user'}, {'what_id': ''}):
            with self.subTest(patch=patch_):
                entries = self.entries()
                entries[1].update(patch_)
                with self.assertRaises(Invalid):
                    self.ctx['write_logs'](entries)
                self.assertEqual(self.db.rows, {})
                self.assertTrue(all(value == 0 for value in self.db.markers.values()))

    def test_insert_and_post_hook_failure_roll_back(self):
        for phase in ('insert', 'hook'):
            with self.subTest(phase=phase):
                self.db.fail_insert = phase == 'insert'
                self.fail_hook = phase == 'hook'
                with self.assertRaises(Invalid):
                    self.ctx['write_logs'](self.entries())
                self.assertEqual(self.db.rows, {})
                self.assertTrue(all(value == 0 for value in self.db.markers.values()))

    def test_extensions_still_receive_each_actual_log_number(self):
        entries = self.entries()
        entries[1]['extension_values'] = {'batch': 'B1'}
        docs = self.ctx['write_logs'](entries)
        self.assertEqual(self.extensions, [(docs[1].name, 'com.shangshu.core', {'batch': 'B1'})])

    def test_target_index_failure_rolls_back_the_complete_main_log_batch(self):
        self.ctx['_write_package_targets'] = lambda docs: (_ for _ in ()).throw(Invalid('target index failed'))
        with self.assertRaisesRegex(Invalid, 'target index failed'):
            self.ctx['write_logs'](self.entries())
        self.assertEqual(self.db.rows, {})

    def test_process_detail_package_label_is_not_interpreted_as_action_package(self):
        entry = self.entries(1)[0]
        entry.update(kind='process', detail={'package': 'domain-specific ordinary detail'})
        result = self.ctx['write_logs']([entry])
        self.assertEqual(len(result), 1)
        self.assertEqual(len(self.db.rows), 1)

    def test_bytes_are_chunked_without_merging_audits(self):
        entries = self.entries()
        for entry in entries:
            entry['detail'] = {'body': '中' * 200000}
        self.ctx['write_logs'](entries)
        self.assertEqual([c for c in self.db.calls if c[0] == 'insert'], [('insert', 1)] * 3)
        self.assertEqual(len(self.db.rows), 3)

    def test_unknown_kind_rejects_before_any_database_work(self):
        with self.assertRaises(Invalid):
            self.ctx['write_logs']([{'kind': 'invented', 'what_id': 'bad'}])
        self.assertEqual(self.db.calls, [])

    def test_current_marker_read_reuses_concurrent_committed_log(self):
        entry = self.entries()[0]
        number = self.ctx['_new_log_number'](entry)
        def concurrent_commit(key):
            # key锁等待返回后必须当前读marker=1及已存在的日志主键。
            doc = self.ctx['_log_document'](entry, number)
            self.ctx['_prepare_log_insert'](doc)
            row = doc.get_valid_dict()
            self.db.rows[row['name']] = row
            self.db.markers['SS-LOG-KEY-' + self.ctx['_action_digest'](entry['idempotency_key'])] = 1
        self.db.on_marker_lock = concurrent_commit
        docs = self.ctx['write_logs']([entry])
        self.assertEqual(docs[0].name, number)
        self.assertEqual(len(self.db.rows), 1)
        self.assertEqual([c for c in self.db.calls if c[0] == 'insert'], [])

    def test_legacy_number_is_reused_without_rewriting_historical_identity(self):
        entry = self.entries()[0]
        doc = self.ctx['_log_document'](entry, 'LOG-2026-99999')
        self.ctx['_prepare_log_insert'](doc)
        self.db.rows[doc.name] = doc.get_valid_dict()
        self.assertEqual(self.ctx['write_logs']([entry])[0].name, doc.name)
        self.assertEqual(self.ctx['write_log'](**entry).name, doc.name)
        self.assertEqual(len(self.db.rows), 1)
        self.assertEqual(set(self.db.markers.values()), {0})

    def test_marker_claiming_missing_log_fails_closed(self):
        entry = self.entries()[0]
        self.db.markers['SS-LOG-KEY-' + self.ctx['_action_digest'](entry['idempotency_key'])] = 1
        with self.assertRaisesRegex(Invalid, '日志幂等索引不一致'):
            self.ctx['write_logs']([entry])
        self.assertFalse(self.db.rows)

    def test_non_action_keys_are_not_silently_deduplicated(self):
        entries = self.entries(2)
        for entry in entries:
            entry.update(kind='process', idempotency_key='same')
        docs = self.ctx['write_logs'](entries)
        self.assertEqual(len(self.db.rows), 2)
        self.assertNotEqual(docs[0].name, docs[1].name)

    def test_existing_key_cannot_hide_a_different_record(self):
        entries = self.entries()
        self.ctx['write_logs'](entries)
        entries[0]['business_name'] = 'different-record'
        with self.assertRaisesRegex(Invalid, '审计幂等键'):
            self.ctx['write_logs'](entries)
        self.assertEqual(len(self.db.rows), 3)


class QueryDB:
    """运行生产 SQL 的 SQLite 接缝；只适配 MariaDB 占位符和 JSON 标量函数。"""
    columns = ('name log_no creation occurred_at actor_user actor_identity conversation_key trigger_source domain_id '
               'what_kind what_id result business_object_id business_name reference_doctype '
               'reference_name idempotency_key detail_json source_doctype source_name action_id '
               'executor_source status payload input_summary_json ssq_action_source_v1 '
               'ssq_event_source_v1 ssq_legacy_trigger_v1 ssq_action_key_v1 '
               'ssq_event_key_v1 ssq_legacy_key_v1').split()

    def __init__(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.calls, self.payload_rows = [], []
        self.conn.create_function('JSON_EXTRACT', 2, self.json_extract)
        self.conn.create_function('JSON_UNQUOTE', 1, lambda raw: (json.loads(raw) if isinstance(json.loads(raw), str) else raw) if raw is not None else None)
        self.conn.create_function('JSON_TYPE', 1, self.json_type)
        self.conn.create_function('JSON_LENGTH', 1, lambda raw: len(json.loads(raw)) if isinstance(json.loads(raw), (dict, list)) else 1)
        for table in ('Shangshu Unified Log', 'Shangshu Action Execution Audit', 'Shangshu Log Target'):
            self.conn.execute('CREATE TABLE `tab' + table + '` (' + ', '.join('`' + c + '` TEXT' for c in self.columns) + ')')

    @staticmethod
    def json_extract(raw, path):
        value = json.loads(raw)
        for key in path.removeprefix('$.').split('.'):
            if not isinstance(value, dict) or key not in value:
                return None
            value = value[key]
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

    @staticmethod
    def json_type(raw):
        if raw is None:
            return None
        value = json.loads(raw)
        return ('NULL' if value is None else 'BOOLEAN' if isinstance(value, bool) else
                'INTEGER' if isinstance(value, int) else 'DOUBLE' if isinstance(value, float) else
                'STRING' if isinstance(value, str) else 'ARRAY' if isinstance(value, list) else 'OBJECT')

    def add(self, table, **row):
        if table == 'Shangshu Unified Log':
            # 离线夹具按 Python 既有投影提供生成值；MariaDB DDL/精确表达式另跑原生判据。
            try:
                detail = json.loads(row.get('detail_json') or '{}')
            except ValueError:
                detail = {}
            legacy = detail.get('legacy') or {}
            original = legacy.get('executor_source')
            projected = original or row.get('trigger_source')
            row['ssq_action_source_v1'] = projected if isinstance(projected, str) else None
            row['ssq_event_source_v1'] = original if isinstance(original, str) else None
            row['ssq_legacy_trigger_v1'] = legacy.get('trigger_source') if isinstance(legacy.get('trigger_source'), str) else None
            for key, col in (('action', 'action_source'), ('event', 'event_source'), ('legacy', 'legacy_trigger')):
                value = row['ssq_' + col + '_v1']
                row['ssq_' + key + '_key_v1'] = value if value is not None and len(value.encode('utf-8')) <= 191 else None
        self.conn.execute('INSERT INTO `tab' + table + '` (' + ','.join('`' + c + '`' for c in row)
                          + ') VALUES (' + ','.join('?' for _ in row) + ')', list(row.values()))

    def sql(self, query, values=None, as_dict=False):
        self.calls.append((query, values))
        query = re.sub(r'%\((\w+)\)s', r':\1', query)
        query = re.sub(r'\bBINARY\s+', '', query)
        query = re.sub(r' FORCE INDEX \(`ssq_source_scope_v1`\)', '', query)
        rows = self.conn.execute(query, values or {}).fetchall()
        self.payload_rows.extend(r['name'] for r in rows if 'detail_json' in r.keys())
        return [Attr(dict(r)) if as_dict else tuple(r) for r in rows]

    def get_all(self, table, filters=None, fields=None, order_by=None,
                limit_start=0, limit_page_length=0, **kwargs):
        params, clauses = {}, []
        for i, (key, value) in enumerate((filters or {}).items()):
            operator, operand = (value if isinstance(value, (list, tuple)) else ('=', value))
            if str(operator).lower() in ('in', 'not in'):
                slots = []
                for j, item in enumerate(operand):
                    param = f'p{i}_{j}'
                    params[param] = item
                    slots.append(':' + param)
                clauses.append('`' + key + '` ' + operator + ' (' + ','.join(slots) + ')')
            else:
                params[f'p{i}'] = operand
                clauses.append('`' + key + '` ' + operator + f' :p{i}')
        sql = 'SELECT ' + ','.join(fields or ['*']) + ' FROM `tab' + table + '`'
        if clauses:
            sql += ' WHERE ' + ' AND '.join(clauses)
        if order_by:
            sql += ' ORDER BY ' + order_by
        if limit_page_length:
            sql += f' LIMIT {int(limit_page_length)} OFFSET {int(limit_start)}'
        rows = self.sql(sql, params, as_dict=True)
        return rows

    def count(self, table, filters):
        return self.get_all(table, filters, fields=['count(*) AS total'])[0]['total']


class MergedLogQueries(unittest.TestCase):
    def setUp(self):
        self.db = QueryDB()
        self.frappe = SimpleNamespace(db=self.db, get_all=self.db.get_all, _dict=Attr,
            ValidationError=Invalid,
            throw=lambda message, error=Invalid: (_ for _ in ()).throw(error(message)))
        self.ctx = load_module_functions(SOURCE,
            {'unified_rows', 'merged_legacy_count', 'merged_legacy_rows', 'project_action_row', '_keep'},
            stubs={'frappe': self.frappe}, overrides={'now_datetime': lambda: '2026-10-28 12:00:00'})
        self.old = 'Shangshu Action Execution Audit'
        self.new = 'Shangshu Unified Log'

    def add_new(self, name, source='agent', legacy=None, **kw):
        row = dict(name=name, log_no=name, creation='2026-10-28 12:00:00',
                   actor_identity='allowed', actor_user='me', what_kind='action', what_id='update',
                   trigger_source=source, result='Succeeded', detail_json=json.dumps({'legacy': legacy or {}}))
        row.update(kw)
        self.db.add(self.new, **row)
        return row

    def count(self, filters=None):
        return self.ctx['merged_legacy_count'](self.old, 'action', filters)

    def rows(self, filters=None, **kwargs):
        return self.ctx['merged_legacy_rows'](self.old, 'action', filters, **kwargs)

    def test_count_is_database_aggregate_without_fetching_detail_payloads(self):
        for i in range(300):
            self.add_new(f'N{i:04}', legacy={'input_summary_json': 'x' * 2000})
        self.db.add(self.old, name='OLD', actor_identity='allowed', creation='2025-01-01')
        self.assertEqual(self.count({'actor_identity': ['in', ['allowed']]}), 301)
        self.assertEqual(self.db.payload_rows, [])
        self.assertEqual(len(self.db.calls), 1)
        self.assertTrue(any('count(' in query.lower() for query, _ in self.db.calls))

    def test_package_target_filter_counts_package_once_and_preserves_actor_scope(self):
        self.add_new('PACK', what_id='files.sheet_cells_write')
        self.add_new('FOREIGN', actor_identity='forbidden')
        for log, record in [('PACK', 'R1'), ('PACK', 'R2'), ('FOREIGN', 'R1')]:
            self.db.add('Shangshu Log Target', log_no=log, reference_doctype='Managed',
                        reference_name=record, business_object_id='object', business_name=record)
        filters = {'business_object_id': 'object', 'actor_identity': ['in', ['allowed']]}
        self.assertEqual(self.count(filters), 1)
        self.assertEqual([r.name for r in self.rows(filters, limit_page_length=1)], ['PACK'])
        self.assertEqual([r.name for r in self.rows({**filters, 'business_name': 'R2'})], ['PACK'])
        self.assertEqual(self.rows({**filters, 'business_name': 'absent'}), [])
        self.assertEqual(self.db.payload_rows, ['PACK', 'PACK'])

    def test_history_action_whitelist_applies_to_singletons_not_package_roots(self):
        self.add_new('PACK', what_id='files.sheet_cells_write')
        self.add_new('OLD', what_id='platform.object.update', reference_doctype='Managed', reference_name='R1')
        self.add_new('OTHER', what_id='unrelated', reference_doctype='Managed', reference_name='R1')
        self.db.add('Shangshu Log Target', log_no='PACK', reference_doctype='Managed', reference_name='R1',
                    business_object_id='object', business_name='R1')
        filters = {'reference_doctype': 'Managed', 'reference_name': 'R1'}
        ids = ['platform.object.update']
        self.assertEqual([r.name for r in self.rows(filters, record_action_ids=ids)], ['PACK', 'OLD'])
        self.assertEqual(self.ctx['merged_legacy_count'](self.old, 'action', filters, record_action_ids=ids), 2)

    def test_target_filters_must_match_the_same_link_not_different_package_rows(self):
        self.add_new('PACK')
        for obj, name in [('A', 'R1'), ('B', 'R2')]:
            self.db.add('Shangshu Log Target', log_no='PACK', reference_doctype='Managed', reference_name=name,
                        business_object_id=obj, business_name=name)
        self.assertEqual(self.count({'business_object_id': 'A', 'reference_name': 'R2'}), 0)

    def test_record_history_does_not_count_other_logical_object_on_same_reference(self):
        for name, obj in [('RIGHT', 'A'), ('OTHER', 'B')]:
            self.add_new(name, what_id='files.sheet_cells_write')
            self.db.add('Shangshu Log Target', log_no=name, reference_doctype='Managed', reference_name='R1',
                        business_object_id=obj, business_name='R1')
        filters = {'reference_doctype': 'Managed', 'reference_name': 'R1'}
        kwargs = {'record_action_ids': ['platform.object.update'], 'record_object_id': 'A'}
        self.assertEqual([r.name for r in self.rows(filters, **kwargs)], ['RIGHT'])
        self.assertEqual(self.ctx['merged_legacy_count'](self.old, 'action', filters, **kwargs), 1)

    def test_source_filter_happens_before_page_limit_and_count_matches(self):
        for i in range(12):
            self.add_new(f'N{i:02}', legacy={'executor_source': 'ai' if i < 5 else 'manual'})
        filters = {'executor_source': 'ai', 'actor_identity': ['in', ['allowed']]}
        self.assertEqual([r.name for r in self.rows(filters, limit_page_length=3)], ['N04', 'N03', 'N02'])
        self.assertEqual(self.count(filters), 5)

    def test_source_query_reads_persistent_projection_without_json_work_or_ddl(self):
        self.add_new('N01', legacy={'executor_source': 'agent '})
        self.rows({'executor_source': 'agent '}, limit_page_length=1)
        self.count({'executor_source': 'agent '})
        sql = '\n'.join(query for query, _ in self.db.calls)
        self.assertIn('ssq_action_key_v1', sql)
        self.assertIn('ssq_legacy_key_v1', sql)
        self.assertNotIn('JSON_', sql)
        self.assertNotIn('ALTER TABLE', sql)
        self.assertIn('FORCE INDEX (`ssq_source_scope_v1`)', sql)

    def test_long_source_preserves_full_value_beyond_binary_key_without_forced_index(self):
        wanted = '中' * 100 + 'x'
        self.add_new('LONG', legacy={'executor_source': wanted})
        self.add_new('OTHER', legacy={'executor_source': '中' * 100 + 'y'})
        self.assertEqual([r.name for r in self.rows({'executor_source': wanted})], ['LONG'])
        self.assertEqual(self.count({'executor_source': wanted}), 1)
        sql = '\n'.join(query for query, _ in self.db.calls)
        self.assertIn('ssq_action_source_v1', sql)
        self.assertNotIn('FORCE INDEX', sql)

    def test_point_lookup_with_source_does_not_force_full_covering_index_scan(self):
        self.add_new('EXACT', legacy={'executor_source': 'ai'}, idempotency_key='exact-key')
        self.assertEqual(self.count({'executor_source': 'ai', 'idempotency_key': 'exact-key'}), 1)
        self.assertNotIn('FORCE INDEX', self.db.calls[0][0])

    def test_source_raw_aliases_and_falsey_legacy_fallback_match_original_projection(self):
        fixtures = [
            ('agent', {}), ('scheduled', {}), ('scheduled', {'executor_source': 'cron'}),
            ('scheduled', {'executor_source': 'scheduler'}), ('agent', {'executor_source': 'ai'}),
            ('agent', {'executor_source': ''}), ('agent', {'executor_source': None}),
            ('agent', {'executor_source': False}), ('agent', {'executor_source': 0}),
            ('agent', {'executor_source': 'manual', 'trigger_source': 'agent'}),
            ('unknown', {'executor_source': 'custom'}), ('agent', {'executor_source': 'AI'}),
            ('agent', {'executor_source': 0.0}), ('agent', {'executor_source': []}),
            ('agent', {'executor_source': {}}), ('agent', {'executor_source': ' '}),
            ('agent', {'executor_source': 'agent '}), ('agent', {'executor_source': True}),
            ('agent', {'executor_source': 1}), ('agent', {'executor_source': ['x']}),
        ]
        raw = [self.add_new(f'N{i:02}', source, legacy) for i, (source, legacy) in enumerate(fixtures)]
        for requested in ('agent', 'ai', 'AI', 'assistant', 'scheduled', 'cron', 'scheduler', 'custom', ' ', 'agent '):
            with self.subTest(source=requested):
                expected = sorted([row['name'] for row in raw
                    if self.ctx['_keep'](self.ctx['project_action_row'](row), {'executor_source': requested})], reverse=True)
                self.assertEqual([r.name for r in self.rows({'executor_source': requested})], expected)
                self.assertEqual(self.count({'executor_source': requested}), len(expected))

    def test_deep_page_fetches_only_current_page_payloads_and_keeps_both_histories(self):
        for i in range(100):
            self.add_new(f'N{i:03}')
            self.db.add(self.old, name=f'O{i:03}', creation='2026-10-28 12:00:00', actor_identity='allowed')
        page = self.rows(limit_start=150, limit_page_length=7)
        self.assertEqual([r.name for r in page], [f'N{i:03}' for i in range(49, 42, -1)])
        self.assertEqual(len(self.db.payload_rows), 7)
        all_names = []
        for start in range(0, 200, 17):
            all_names.extend(r.name for r in self.rows(limit_start=start, limit_page_length=17))
        self.assertEqual(len(all_names), 200)
        self.assertEqual(len(set(all_names)), 200)

    def test_ascending_pages_are_stable_across_old_and_new_rows(self):
        for name in ('B', 'D'):
            self.add_new(name)
        for name in ('A', 'C'):
            self.db.add(self.old, name=name, creation='2026-10-28 12:00:00')
        self.assertEqual([r.name for r in self.rows(order_by='creation asc', limit_page_length=2)], ['A', 'B'])
        self.assertEqual([r.name for r in self.rows(order_by='creation asc', limit_start=2, limit_page_length=2)], ['C', 'D'])

    def test_creation_and_identity_filters_apply_to_both_stores_before_limit(self):
        self.add_new('A', creation='2026-10-01', legacy={'status': 'Succeeded'})
        self.add_new('B', creation='2026-10-28')
        self.add_new('C', actor_identity='forbidden', creation='2026-10-29', legacy={'actor_identity': 'allowed'})
        self.db.add(self.old, name='D', creation='2026-10-28', actor_identity='allowed', action_id='update')
        filters = {'creation': ['>=', '2026-10-20'], 'actor_identity': ['in', ['allowed']],
                   'action_id': ['in', ['update']]}
        self.assertEqual([r.name for r in self.rows(filters)], ['D', 'B'])
        self.assertEqual(self.count(filters), 2)

    def test_unknown_filter_or_operator_rejects_before_any_database_read(self):
        for filters in ({'invented_filter': 'anything'}, {'creation': ['raw sql', '1=1']}):
            for entry in (lambda: self.rows(filters), lambda: self.count(filters),
                          lambda: self.ctx['unified_rows']('action', filters)):
                with self.subTest(filters=filters, entry=entry), self.assertRaises(Invalid):
                    entry()
                self.assertEqual(self.db.calls, [])

    def test_equal_names_in_different_histories_are_not_deduplicated(self):
        self.add_new('SAME', legacy={'input_summary_json': 'new-fact'})
        self.db.add(self.old, name='SAME', creation='2026-10-28 12:00:00', input_summary_json='old-fact')
        first = self.rows(limit_page_length=1)
        second = self.rows(limit_page_length=1, limit_start=1)
        self.assertEqual([row['input_summary_json'] for row in first + second], ['old-fact', 'new-fact'])
        self.assertEqual(self.count(), 2)

    def test_status_mapping_invalid_json_and_empty_identity_scope(self):
        self.add_new('SUCCEEDED', detail_json='not valid json')
        self.add_new('FAILED', result='Failed')
        self.add_new('DELIVERING', result='Delivering')
        self.db.add(self.old, name='OLD', status='Published', creation='2026-10-01')
        self.assertEqual([r.name for r in self.rows({'status': 'Published'})], ['DELIVERING', 'OLD'])
        self.assertEqual(self.count({'status': 'Published'}), 2)
        self.assertEqual([r.name for r in self.rows({'executor_source': 'agent', 'status': 'Succeeded'})], ['SUCCEEDED'])
        self.assertEqual(self.rows({'actor_identity': ['in', []]}), [])
        self.assertEqual(self.count({'actor_identity': ['in', []]}), 0)

    def test_unknown_sort_table_and_invalid_page_fail_before_sql(self):
        entries = [lambda: self.rows(order_by='creation desc; DROP TABLE anything'),
                   lambda: self.rows(limit_page_length=-1),
                   lambda: self.rows(limit_start=True),
                   lambda: self.ctx['merged_legacy_rows']('arbitrary table', 'action')]
        for entry in entries:
            with self.assertRaises(Invalid):
                entry()
            self.assertEqual(self.db.calls, [])

    def test_legacy_source_filter_is_exact_and_row_payload_projection_stays_intact(self):
        self.db.add(self.old, name='OLD', creation='2026-10-01', executor_source='ai', payload='untouched')
        self.add_new('NEW', legacy={'executor_source': 'ai', 'action_version': '1.4.0', 'input_summary_json': '{"a":1}'})
        rows = self.rows({'executor_source': 'ai'})
        self.assertEqual([(r.name, r.executor_source) for r in rows], [('NEW', 'ai'), ('OLD', 'ai')])
        self.assertEqual(rows[0]['input_summary_json'], '{"a":1}')
        self.assertEqual(rows[1]['payload'], 'untouched')
        self.assertEqual(self.count({'executor_source': 'assistant'}), 0)


if __name__ == '__main__':
    unittest.main()
