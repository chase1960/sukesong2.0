"""真实guard/多连接并发；RPC Request上下文不是HTTP网络验收。

prepare_fixture/cleanup_fixture含既有受管对象DDL，须由主执行器在排空窗口
显式串行调用。测试本身不做DDL、不patch准入判定、不替换保存器。
仅允许pkg132-incremental.localhost；所有配置/cache改动都限定本组夹具。
"""
import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import frappe

SITE = 'pkg132-incremental.localhost'
ACTION = 'platform.object.update_many'
HTTP = 'shangshu_core.public_api.http.action_execute'
DEFAULT_FIXTURE = '/tmp/scoped-write-zones-fixture-20261028.json'
MODEL = 'Shangshu Object Model'
TRANSPORT = 'in_process_rpc_request_context_not_http_network'


def _site():
    if frappe.local.site != SITE:
        raise RuntimeError('isolated pkg132-incremental site required')


def prepare_fixture(path=DEFAULT_FIXTURE):
    """主执行器显式调用；两份受管对象建在同一应用，全部DDL结束后才启动worker。"""
    _site()
    frappe.set_user('Administrator'); frappe.db.rollback()
    from shangshu_core.promotion_records import provision_promoted_records
    from shangshu_core.tests.test_promotion_records import COLUMNS, TABLE_ACCESS, rows_for
    from shangshu_core.applications import (
        get_application_definition, save_application_draft, publish_application_definition)
    from shangshu_core.write_zone_certification import certify_managed_write_zone
    if frappe.db.get_value('User', 'Administrator', 'follow_created_documents'):
        raise RuntimeError('fixture user follow_created_documents must already be off; not changing user preferences')
    if not frappe.db.get_value('Shangshu Identity', {'user': 'Administrator'}, 'name'):
        raise RuntimeError('fixture Administrator Identity must already exist')
    prefix = 'runtime-zone-' + uuid.uuid4().hex
    results = []
    for index in range(2):
        result = provision_promoted_records(table=prefix + '-table-' + str(index),
            title='并发准入隔离夹具 ' + str(index), columns=COLUMNS, rows=rows_for(1),
            access=TABLE_ACCESS, idempotency_key=prefix + ':prepare:' + str(index),
            application_id=results[0]['application_id'] if results else None)
        results.append(result)
        frappe.db.commit()
    application_id = results[0]['application_id']
    current = get_application_definition(application_id)
    definition = {'schema_version': 1, 'title': '并发准入隔离夹具', 'description': prefix,
        'allowed_roles': ['System Manager', 'Desk User'], 'bindings': [
            {'kind': 'datasets', 'resource_id': result['object_id'], 'owner_domain': application_id,
             'version': str(result['revision'])} for result in results]}
    saved = save_application_draft(application_id, definition, current['draft_revision'])
    publish_application_definition(application_id, saved['draft_revision'])
    frappe.db.commit()
    objects = []
    for result in results:
        certificate = certify_managed_write_zone(result['object_id'])['certificate']
        frappe.db.commit()
        model = frappe.get_doc(MODEL, result['object_id'])
        compiled = json.loads(model.active_json)
        columns = {field['id']: column['fieldname'] for field, column in
                   zip(compiled['fields'], compiled['doctype']['fields'])}
        objects.append({'object_id': model.name, 'physical_doctype': model.physical_doctype,
            'record_name': next(iter(result['records'].values())), 'revision': model.active_revision,
            'amount_column': columns['amount'], 'certificate': certificate})
    frappe.db.commit()
    value = {'site': SITE, 'prefix': prefix, 'application_id': application_id, 'objects': objects,
             'transport': TRANSPORT}
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2))
    return value


def cleanup_fixture(path=DEFAULT_FIXTURE):
    """主执行器在全部worker退出后串行调用；复用原临时受管模型回收夹具。"""
    _site()
    value = json.loads(Path(path).read_text())
    if value['site'] != SITE or not value['prefix'].startswith('runtime-zone-'):
        raise RuntimeError('not a runtime-zone fixture manifest')
    frappe.set_user('Administrator'); frappe.db.rollback()
    from shangshu_core.tests.test_promotion_records import TestPromotionRecords
    fixture = TestPromotionRecords()
    fixture.created = [(item['object_id'], value['application_id']) for item in value['objects']]
    fixture._cleanup()
    return {'cleaned_fixture': value['prefix']}


def _wait(path, timeout=40):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('runtime synchronization: ' + str(path))
        time.sleep(.02)


def _insert_configuration(name):
    # 直接DML隔离PRIMARY空隙锁效果；disabled且只关联ToDo，不触发任何业务规则。
    frappe.db.sql('INSERT INTO `tabDocument Naming Rule` '
        '(name, creation, modified, owner, modified_by, docstatus, idx, document_type, disabled, '
        'prefix, prefix_digits, counter, priority) VALUES '
        '(%s,NOW(6),NOW(6),%s,%s,0,0,%s,1,%s,5,0,1)',
        (name, 'Administrator', 'Administrator', 'ToDo', name + '-',))


@contextmanager
def _rpc_context(config):
    from werkzeug.test import EnvironBuilder
    from werkzeug.wrappers import Request
    form = frappe._dict(cmd=HTTP, action_id=ACTION, payload=json.dumps(config['payload']),
                        confirmed='1', idempotency_key=config['key'], source='user')
    request = Request(EnvironBuilder(method='POST', path='/api/method/' + HTTP, json=dict(form)).get_environ())
    old_request = getattr(frappe.local, 'request', None)
    old_form = getattr(frappe.local, 'form_dict', None)
    frappe.local.request, frappe.local.form_dict = request, form
    try:
        yield
    finally:
        frappe.local.request, frappe.local.form_dict = old_request, old_form


@contextmanager
def _stale_workflow_cache(config):
    kind = config.get('stale_cache')
    if not kind:
        yield
        return
    import redis
    cache = frappe.cache
    resolve = getattr(cache, '_get_current_object', None)
    cache = resolve() if callable(resolve) else cache
    key = cache.make_key('workflow')
    doctype = config['physical_doctype']
    original = redis.Redis.hget(cache, key, doctype)
    if kind == 'redis':
        cache.hset('workflow', doctype, config['key'] + ':absent-workflow')
        # 只移除该worker刚暖入的本地键，确保guard实际从Redis读取。
        frappe.local.cache.pop(key, None)
    elif kind == 'local':
        frappe.local.cache.setdefault(key, {})[doctype] = config['key'] + ':absent-workflow'
    else:
        raise ValueError('unknown cache fixture kind')
    try:
        yield
    finally:
        # 精确保留原Redis字节/缺失状态；不清全局cache，不触其他DocType字段。
        if kind == 'redis':
            if original is None:
                redis.Redis.hdel(cache, key, doctype)
            else:
                redis.Redis.hset(cache, key, doctype, original)


def _worker(config_path):
    config = json.loads(Path(config_path).read_text())
    if config['site'] != SITE:
        raise RuntimeError('isolated test site required')
    frappe.init(site=SITE); frappe.connect(); frappe.set_user('Administrator')
    directory = Path(config['directory'])
    observations = {'transport': TRANSPORT, 'app_locks': [], 'shared_queries': []}
    result = None
    try:
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=%s', (config.get('lock_timeout', 3),))
        mode = config['mode']
        if mode == 'insert_configuration':
            _insert_configuration(config['configuration'])
            frappe.db.commit(); result = {'ok': True, 'configuration': config['configuration'], 'committed': True}
        elif mode == 'update_configuration':
            frappe.db.sql('UPDATE `tabDocument Naming Rule` SET priority=priority+1 WHERE name=%s',
                          (config['configuration'],))
            frappe.db.commit(); result = {'ok': True, 'committed': True}
        elif mode == 'certify':
            from shangshu_core.write_zone_certification import certify_managed_write_zone
            value = certify_managed_write_zone(config['object_id'])
            frappe.db.commit(); result = {'ok': True, 'committed': True, **value}
        elif mode == 'rpc':
            original_sql = frappe.db.sql
            paused = False
            def observe_sql(query, *args, **kwargs):
                nonlocal paused
                sql = str(query)
                if 'LOCK IN SHARE MODE' in sql.upper():
                    observations['shared_queries'].append(sql)
                if 'tabShangshu Application Definition' in sql and (
                        'LOCK IN SHARE MODE' in sql.upper() or 'FOR UPDATE' in sql.upper()):
                    observations['app_locks'].append('shared' if 'LOCK IN SHARE MODE' in sql.upper() else 'exclusive')
                if (config.get('pause_before_app') and not paused and
                        'tabShangshu Application Definition' in sql and 'LOCK IN SHARE MODE' in sql.upper()):
                    paused = True
                    (directory / 'before-app-lock').write_text(json.dumps({
                        'reason': getattr(frappe.flags, 'shangshu_write_zone_reason', None)}))
                    _wait(directory / 'continue')
                return original_sql(query, *args, **kwargs)
            with _rpc_context(config), _stale_workflow_cache(config), patch.object(frappe.db, 'sql', side_effect=observe_sql):
                if config.get('warm_configuration'):
                    rows = frappe.db.sql('SELECT name FROM `tabDocument Naming Rule` WHERE name=%s',
                                         (config['warm_configuration'],))
                    (directory / 'snapshot-ready').write_text(json.dumps({'rows': len(rows)}))
                    _wait(directory / 'continue')
                from shangshu_core.public_api.http import action_execute
                started = time.monotonic()
                receipt = action_execute(ACTION, json.dumps(config['payload']), confirmed=1,
                                         idempotency_key=config['key'], source='user')
                result = {'ok': True, 'audit': receipt['audit'], 'action_seconds': time.monotonic() - started,
                          'reason': getattr(frappe.flags, 'shangshu_write_zone_reason', None), **observations}
                if config.get('hold'):
                    # 完整public Action、成功日志/target/请求回执都已写；外事务尚未提交。
                    result['in_transaction_logs'] = int(frappe.db.sql(
                        'SELECT COUNT(*) FROM `tabShangshu Unified Log` WHERE idempotency_key=%s',
                        (config['key'],))[0][0])
                    result['in_transaction_targets'] = int(frappe.db.sql(
                        'SELECT COUNT(*) FROM `tabShangshu Log Target` WHERE log_no=%s',
                        (receipt['audit'],))[0][0])
                    from shangshu_core.action_requests import request_name
                    result['in_transaction_request'] = frappe.db.get_value(
                        'Shangshu Action Request', request_name(config['key']), 'status')
                    (directory / 'held').write_text(json.dumps(result))
                    _wait(directory / 'release')
                    if (directory / 'release').read_text() == 'rollback':
                        frappe.db.rollback(); result['committed'] = False
                    else:
                        frappe.db.commit(); result['committed'] = True
                else:
                    frappe.db.commit(); result['committed'] = True
        else:
            raise ValueError('unknown worker mode')
    except Exception as error:
        result = {'ok': False, 'type': type(error).__name__, 'message': str(error),
                  'reason': getattr(frappe.flags, 'shangshu_write_zone_reason', None), **observations}
        frappe.db.rollback()
    finally:
        frappe.db.rollback(); frappe.destroy()
    (directory / 'result').write_text(json.dumps(result, default=str))


class TestWriteZonesConcurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if frappe.local.site != SITE:
            raise unittest.SkipTest('only the isolated pkg132 site may run these committed fixtures')
        path = Path(os.environ.get('SS_WRITE_ZONE_FIXTURE', DEFAULT_FIXTURE))
        if not path.is_file():
            raise RuntimeError('root must first run prepare_fixture() serially: ' + str(path))
        cls.fixture = json.loads(path.read_text())
        if cls.fixture['site'] != SITE or len(cls.fixture['objects']) != 2:
            raise RuntimeError('invalid runtime fixture')

    def setUp(self):
        frappe.set_user('Administrator'); frappe.db.rollback()
        self.prefix = self.fixture['prefix'] + ':' + uuid.uuid4().hex[:8]
        self.temp = tempfile.TemporaryDirectory(prefix='ss-runtime-zone-')
        self.directory = Path(self.temp.name)
        self.workers, self.configurations = [], set()

    def tearDown(self):
        frappe.db.rollback()
        for process, directory in self.workers:
            (directory / 'continue').write_text('continue')
            (directory / 'release').write_text('rollback')
        for process, directory in self.workers:
            try:
                process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill(); process.communicate()
        for name in self.configurations:
            frappe.db.sql('DELETE FROM `tabDocument Naming Rule` WHERE name=%s', (name,))
        frappe.db.commit()
        self.temp.cleanup()

    def payload(self, index, amount):
        item = self.fixture['objects'][index]
        return {'object_id': item['object_id'], 'expected_revision': item['revision'], 'records': [{
            'name': item['record_name'], 'expected_modified': str(frappe.db.get_value(
                item['physical_doctype'], item['record_name'], 'modified')), 'values': {'amount': amount}}]}

    def value(self, index):
        item = self.fixture['objects'][index]
        return frappe.db.get_value(item['physical_doctype'], item['record_name'], item['amount_column'])

    def start(self, label, mode='rpc', **options):
        directory = self.directory / label
        directory.mkdir()
        config = {'site': SITE, 'mode': mode, 'directory': str(directory), **options}
        path = directory / 'config.json'; path.write_text(json.dumps(config))
        env = dict(os.environ); env['PYTHONPATH'] = os.pathsep.join(str(p) for p in sys.path if p)
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.workers.append((process, directory))
        return process, directory

    def event(self, worker, name):
        process, directory = worker
        deadline = time.monotonic() + 40
        while not (directory / name).exists():
            if (directory / 'result').exists():
                self.fail('worker finished before ' + name + ': ' + (directory / 'result').read_text())
            if process.poll() is not None:
                out, err = process.communicate(); self.fail(out + err)
            if time.monotonic() > deadline: self.fail('worker never reached ' + name)
            time.sleep(.02)
        return json.loads((directory / name).read_text())

    def result(self, worker):
        process, directory = worker
        stdout, stderr = process.communicate(timeout=45)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        result = json.loads((directory / 'result').read_text())
        print(json.dumps({'worker': directory.name, **result}, ensure_ascii=False), flush=True)
        return result

    def release(self, worker, commit=False):
        (worker[1] / 'release').write_text('commit' if commit else 'rollback')
        return self.result(worker)

    def assert_shared(self, held):
        self.assertTrue(held['ok'], held)
        self.assertEqual(held['reason'], 'shared', held)
        self.assertEqual(held['app_locks'], ['shared'], held)
        self.assertEqual(held['in_transaction_logs'], 1)
        self.assertEqual(held['in_transaction_targets'], 1)
        self.assertEqual(held['in_transaction_request'], 'Succeeded')

    def logs(self, key):
        # ⚠️ **2026-10-28 接手修正**：这里原来直接返回 `frappe.db.sql(...)`（**元组**），
        #   而下面的断言写的是 `assertEqual(self.logs(key), [])` ⇒ **空的时候是 `() != []`**
        #   ⇒ 明明「一条日志都没有」却判成红。
        #   ⇒ 改成返回**列表**：断言一个字都不用动，意思还是「没有日志行」。
        return list(frappe.db.sql('SELECT name FROM `tabShangshu Unified Log` WHERE idempotency_key=%s', (key,)))

    def request_status(self, key):
        from shangshu_core.action_requests import request_name
        return frappe.db.get_value('Shangshu Action Request', request_name(key), 'status')

    def configuration(self, suffix):
        name = self.prefix + ':configuration:' + suffix
        self.configurations.add(name)
        return name

    def test_a_same_object_waits_but_other_object_commits_complete_action_first(self):
        a_key, b_key, c_key = (self.prefix + ':' + suffix for suffix in ('A', 'B', 'C'))
        a_amount, c_amount = float(self.value(0)) + 1.25, float(self.value(1)) + 2.25
        a_payload = self.payload(0, a_amount); b_payload = self.payload(0, a_amount + 1)
        c_payload = self.payload(1, c_amount)
        a = self.start('A', payload=a_payload, key=a_key, hold=True)
        held = self.event(a, 'held'); self.assert_shared(held)
        b = self.start('B-wait', payload=b_payload, key=b_key, lock_timeout=1)
        blocked = self.result(b)
        self.assertFalse(blocked['ok']); self.assertEqual(blocked['type'], 'QueryTimeoutError', blocked)
        self.assertIn('shared', blocked['app_locks'])
        c = self.start('C-independent', payload=c_payload, key=c_key)
        committed = self.result(c)
        self.assertTrue(committed['ok'] and committed['committed'], committed)
        self.assertEqual(committed['reason'], 'shared'); self.assertEqual(committed['app_locks'], ['shared'])
        self.assertFalse((a[1] / 'release').exists()); self.assertIsNone(a[0].poll())
        # 第三连接新read-view确认C的完整提交，不能只用worker的handler返回冒充。
        frappe.db.rollback()
        self.assertEqual(float(self.value(1)), c_amount)
        self.assertEqual(len(self.logs(c_key)), 1); self.assertEqual(self.logs(a_key), [])
        self.assertEqual(self.request_status(c_key), 'Succeeded')
        self.assertIsNone(self.request_status(a_key))
        self.assertEqual(int(frappe.db.sql('SELECT COUNT(*) FROM `tabShangshu Log Target` WHERE log_no=%s',
                                          (committed['audit'],))[0][0]), 1)
        self.assertTrue(self.release(a, commit=True)['committed'])
        retry = self.result(self.start('B-old-version', payload=b_payload, key=b_key))
        self.assertFalse(retry['ok']); self.assertEqual(retry['type'], 'TimestampMismatchError', retry)
        frappe.db.rollback()
        self.assertEqual(float(self.value(0)), a_amount)
        self.assertEqual(len(self.logs(a_key)), 1); self.assertEqual(self.logs(b_key), [])
        self.assertEqual(self.request_status(b_key), 'Failed')

    def test_b_empty_configuration_range_blocks_insert_until_transaction_ends(self):
        a = self.start('A-gap', payload=self.payload(0, float(self.value(0)) + 10.125), key=self.prefix + ':A', hold=True)
        self.assert_shared(self.event(a, 'held'))
        name = self.configuration('empty-gap')
        blocked = self.result(self.start('insert-blocked', mode='insert_configuration', configuration=name, lock_timeout=1))
        self.assertFalse(blocked['ok']); self.assertEqual(blocked['type'], 'QueryTimeoutError', blocked)
        self.release(a)
        inserted = self.result(self.start('insert-after-release', mode='insert_configuration', configuration=name))
        self.assertTrue(inserted['ok'] and inserted['committed'], inserted)

    def test_c_existing_unrelated_configuration_uses_coarse_without_new_shared_locks(self):
        name = self.configuration('existing-disabled')
        _insert_configuration(name); frappe.db.commit()
        a = self.start('A-coarse', payload=self.payload(0, float(self.value(0)) + 10.125), key=self.prefix + ':A', hold=True)
        held = self.event(a, 'held')
        self.assertEqual(held['reason'], 'configuration', held)
        self.assertEqual(held['app_locks'], ['exclusive']); self.assertEqual(held['shared_queries'], [])
        changed = self.result(self.start('configuration-update', mode='update_configuration', configuration=name, lock_timeout=1))
        self.assertTrue(changed['ok'] and changed['committed'], changed)
        self.assertFalse((a[1] / 'release').exists())
        self.release(a)

    def test_d_deleted_configuration_in_old_read_view_cannot_admit_shared(self):
        name = self.configuration('old-read-view')
        _insert_configuration(name); frappe.db.commit()
        a = self.start('A-old-view', payload=self.payload(0, float(self.value(0)) + 10.125), key=self.prefix + ':A',
                       warm_configuration=name, hold=True)
        self.assertEqual(self.event(a, 'snapshot-ready')['rows'], 1)
        frappe.db.sql('DELETE FROM `tabDocument Naming Rule` WHERE name=%s', (name,)); frappe.db.commit()
        (a[1] / 'continue').write_text('continue')
        held = self.event(a, 'held')
        self.assertEqual(held['reason'], 'configuration', held)
        self.assertEqual(held['app_locks'], ['exclusive']); self.assertEqual(held['shared_queries'], [])
        self.release(a)

    def test_e_actual_stale_redis_and_local_workflow_cache_never_admit_shared(self):
        item = self.fixture['objects'][0]
        for kind in ('redis', 'local'):
            with self.subTest(kind=kind):
                before = self.value(0); key = self.prefix + ':' + kind
                result = self.result(self.start('stale-' + kind, payload=self.payload(0, float(before) + 10.125), key=key,
                    stale_cache=kind, physical_doctype=item['physical_doctype']))
                self.assertEqual(result['reason'], 'cached_configuration', result)
                self.assertNotIn('shared', result['app_locks']); self.assertEqual(result['shared_queries'], [])
                self.assertFalse(result['ok'], 'absent workflow should also reject ordinary save')
                frappe.db.rollback()
                self.assertEqual(self.value(0), before); self.assertEqual(self.logs(key), [])

    def test_f_recertification_after_real_admission_rejects_old_evidence(self):
        item = self.fixture['objects'][0]
        before = self.value(0)
        old = json.loads(frappe.db.get_value(MODEL, item['object_id'], 'write_zone_certification'))
        key = self.prefix + ':nonce'
        a = self.start('A-old-cert', payload=self.payload(0, float(before) + 10.125), key=key, pause_before_app=True)
        self.assertEqual(self.event(a, 'before-app-lock')['reason'], 'shared')
        certified = self.result(self.start('recertify', mode='certify', object_id=item['object_id'], lock_timeout=5))
        self.assertTrue(certified['ok'] and certified['committed'], certified)
        self.assertNotEqual(certified['certificate']['certification_id'], old['certification_id'])
        (a[1] / 'continue').write_text('continue')
        rejected = self.result(a)
        self.assertFalse(rejected['ok']); self.assertIn('凭据已变化', rejected['message'])
        frappe.db.rollback()
        self.assertEqual(self.value(0), before); self.assertEqual(self.logs(key), [])
        expected_log = 'LOG-' + hashlib.sha256(key.encode()).hexdigest()
        self.assertEqual(int(frappe.db.sql('SELECT COUNT(*) FROM `tabShangshu Log Target` WHERE log_no=%s',
                                          (expected_log,))[0][0]), 0)


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--worker':
    _worker(sys.argv[2])
