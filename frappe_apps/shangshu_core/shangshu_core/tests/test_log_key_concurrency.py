"""日志按键互斥的真实多连接反例；仅在指定隔离站运行，不作日常基准负载。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import frappe

from shangshu_core import unified_log


def _digest(key):
    # 测试自算键，用同一用例可对旧全局流水锁实现运行红色反例。
    return hashlib.sha256(key.encode('utf-8')).hexdigest()


def _wait(path, timeout=12):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > deadline:
            raise TimeoutError('worker synchronization: ' + str(path))
        time.sleep(.02)


def _worker(config_path):
    config = json.loads(Path(config_path).read_text())
    if config['site'] != 'pkg132-incremental.localhost':
        raise RuntimeError('isolated site required')
    frappe.init(site=config['site'])
    frappe.connect()
    directory = Path(config['directory'])
    try:
        frappe.set_user('Administrator')
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=8')
        # 先建立看不到A未提交日志的RR快照，再证明锁后读取能看见A的提交。
        old_count = frappe.db.sql('SELECT COUNT(*) FROM `tabShangshu Unified Log` '
            'WHERE idempotency_key=%s', (config['entry']['idempotency_key'],))[0][0]
        (directory / 'ready').write_text(json.dumps({'old_count': old_count}))
        started = time.monotonic()
        doc = unified_log.write_log(**config['entry'])
        frappe.db.commit()
        result = {'ok': True, 'name': doc.name, 'elapsed': time.monotonic() - started,
                  'snapshot_count': old_count}
    except Exception as error:
        result = {'ok': False, 'type': type(error).__name__, 'args': list(error.args)}
        frappe.db.rollback()
    finally:
        frappe.destroy()
    (directory / 'result').write_text(json.dumps(result))


class TestLogKeyConcurrency(unittest.TestCase):
    def setUp(self):
        if frappe.local.site != 'pkg132-incremental.localhost':
            self.skipTest('only the isolated pkg132 site may run committed concurrency fixtures')
        frappe.db.rollback()
        frappe.set_user('Administrator')
        self.identity = frappe.db.get_value('Shangshu Identity', {'user': 'Administrator'}, 'name')
        self.assertTrue(self.identity, 'test site must already have Administrator identity')
        frappe.db.commit()
        self.prefix = 'log-key-concurrency-' + uuid.uuid4().hex
        self.keys, self.workers = set(), []
        self.temp = tempfile.TemporaryDirectory(prefix='ss-log-key-')
        self.directory = Path(self.temp.name)

    def tearDown(self):
        frappe.db.rollback()
        for process, directory in self.workers:
            try:
                process.communicate(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        # 仅删除本测试独有前缀的fixture；不改其他事实、不重置全局series。
        frappe.db.sql('DELETE FROM `tabShangshu Unified Log` WHERE idempotency_key LIKE %s',
                      (self.prefix + '%',))
        for key in self.keys:
            frappe.db.sql('DELETE FROM `tabSeries` WHERE name=%s',
                          ('SS-LOG-KEY-' + _digest(key),))
        frappe.db.commit()
        self.temp.cleanup()

    def entry(self, suffix, **changes):
        key = self.prefix + ':' + suffix
        self.keys.add(key)
        entry = dict(kind='action', what_id='platform.object.update_many',
            actor_user='Administrator', actor_identity=self.identity, result='Succeeded',
            business_object_id='test.log-key-concurrency', business_name='R', idempotency_key=key,
            detail={'record_changes': {'name': 'R', 'data': {
                'changes': [{'field': 'amount', 'before': 1, 'after': 2}]}}})
        entry.update(changes)
        return entry

    def start(self, name, entry):
        directory = self.directory / name
        directory.mkdir()
        config = directory / 'config.json'
        config.write_text(json.dumps({'site': frappe.local.site, 'directory': str(directory), 'entry': entry}))
        env = dict(os.environ)
        env['PYTHONPATH'] = os.pathsep.join(str(p) for p in sys.path if p)
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(config)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.workers.append((process, directory))
        _wait(directory / 'ready')
        return process, directory

    def result(self, worker, timeout=12):
        process, directory = worker
        stdout, stderr = process.communicate(timeout=timeout)
        self.assertEqual(process.returncode, 0, (stdout, stderr))
        result = json.loads((directory / 'result').read_text())
        self.assertTrue(result['ok'], result)
        return result

    def count(self, key):
        return frappe.db.sql('SELECT COUNT(*) FROM `tabShangshu Unified Log` WHERE idempotency_key=%s',
                             (key,))[0][0]

    def test_uncommitted_key_does_not_block_neighbor_and_same_key_reuses_current_row(self):
        entry = self.entry('same')
        first = unified_log.write_log(**entry)
        same = self.start('same', entry)
        prefix = _digest(entry['idempotency_key'])[:3]
        # 两个业务key同前缀，hash索引key也相邻，不能靠碰巧落远处规避gap锁反例。
        for index in range(100000):
            suffix = 'neighbor-' + str(index)
            key = self.prefix + ':' + suffix
            if _digest(key).startswith(prefix):
                neighbor_entry = self.entry(suffix)
                break
        else:
            self.fail('could not generate nearby independent key')
        neighbor = self.start('neighbor', neighbor_entry)
        independent = self.result(neighbor)
        self.assertFalse((same[1] / 'result').exists(), 'same key must wait while A is uncommitted')
        frappe.db.commit()
        replay = self.result(same)
        self.assertEqual(replay['snapshot_count'], 0)
        self.assertEqual(replay['name'], first.name)
        self.assertNotEqual(independent['name'], first.name)
        self.assertEqual(self.count(entry['idempotency_key']), 1)
        self.assertEqual(self.count(neighbor_entry['idempotency_key']), 1)
        print(json.dumps({'case': 'distinct-progress-same-key-wait', 'neighbor_seconds': independent['elapsed'],
            'same_key_seconds': replay['elapsed'], 'same_log': True, 'old_snapshot_count': 0}), flush=True)

    def test_same_key_different_fact_is_rejected_without_another_log(self):
        entry = self.entry('conflict')
        first = unified_log.write_log(**entry)
        frappe.db.commit()
        changed = {**entry, 'business_name': 'OTHER'}
        with self.assertRaises(frappe.ValidationError):
            unified_log.write_log(**changed)
        frappe.db.rollback()
        self.assertEqual(self.count(entry['idempotency_key']), 1)
        self.assertEqual(frappe.db.get_value(unified_log.LOG_DOCTYPE, first.name, 'business_name'), 'R')

    def test_rollback_releases_key_and_retry_creates_exactly_one_log(self):
        entry = self.entry('rollback')
        rolled_back = unified_log.write_log(**entry)
        retry = self.start('retry', entry)
        time.sleep(.15)
        self.assertFalse((retry[1] / 'result').exists())
        frappe.db.rollback()
        actual = self.result(retry)
        self.assertEqual(actual['name'], rolled_back.name)
        self.assertEqual(self.count(entry['idempotency_key']), 1)
        replay = unified_log.write_log(**entry)
        frappe.db.commit()
        self.assertEqual(replay.name, actual['name'])
        self.assertEqual(self.count(entry['idempotency_key']), 1)

    def test_old_identity_and_new_hash_coexist_and_non_action_keys_do_not_deduplicate(self):
        old_entry = self.entry('old')
        old_name = 'LOG-2099-' + str(int(uuid.uuid4().hex, 16))
        old = unified_log._log_document(old_entry, old_name).insert(ignore_permissions=True)
        original_detail = old.detail_json
        frappe.db.commit()
        self.assertEqual(unified_log.write_log(**old_entry).name, old_name)
        new = unified_log.write_log(**self.entry('new'))
        self.assertRegex(new.name, r'^LOG-[0-9a-f]{64}$')
        process_entry = self.entry('process', kind='process')
        processes = unified_log.write_logs([process_entry, process_entry])
        frappe.db.commit()
        self.assertNotEqual(processes[0].name, processes[1].name)
        self.assertEqual(self.count(process_entry['idempotency_key']), 2)
        self.assertEqual(self.count(old_entry['idempotency_key']), 1)
        self.assertEqual(frappe.db.get_value(unified_log.LOG_DOCTYPE, old_name, 'detail_json'), original_detail)


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--worker':
    _worker(sys.argv[2])
