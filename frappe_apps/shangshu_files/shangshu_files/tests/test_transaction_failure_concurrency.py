"""真实双连接事务中止；仅允许隔离测试站，禁止在试用站运行。

ToDo 仅作本测试创建的锁探针。业务修改走公共动作和真实 XLSX 夹具；
在实际投影阶段制造数据库等待/死锁，不伪造异常替代数据库行为。
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import frappe

from shangshu_core import actions
from shangshu_core.public_api import execute_registered_action, get_action_request_status
from shangshu_files import promotion, sheet
from shangshu_files.tests.test_action_package_log import TestActionPackageLog


def _wait(path, timeout=15):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('test synchronization timeout: ' + path.name)
        time.sleep(.02)


def _worker(config_path):
    config = json.loads(Path(config_path).read_text())
    if config['site'] != 'pkg132-incremental.localhost':
        raise RuntimeError('isolated site required')
    frappe.init(site=config['site'])
    frappe.connect()
    directory = Path(config['directory'])
    try:
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=10')
        frappe.db.get_value('ToDo', config['gate_b'], 'name', for_update=True)
        if config['mode'] == 'deadlock':
            # InnoDB normally picks the lighter transaction as the victim.
            # Keep this locker heavier than the one-record public Action.
            for name in config['ballast']:
                frappe.db.sql('UPDATE `tabToDo` SET priority=%s WHERE name=%s', ('Medium', name))
        (directory / 'worker-ready').write_text('ready')
        if config['mode'] == 'deadlock':
            _wait(directory / 'projection-entered')
            frappe.db.get_value('ToDo', config['gate_a'], 'name', for_update=True)
            frappe.db.commit()
        else:
            _wait(directory / 'release-worker')
            frappe.db.rollback()
        (directory / 'worker-result').write_text(json.dumps({'ok': True}))
    except Exception as error:
        (directory / 'worker-result').write_text(json.dumps({
            'ok': False, 'type': type(error).__name__, 'args': list(error.args)}))
        frappe.db.rollback()
        raise
    finally:
        frappe.destroy()


class TestTransactionFailureConcurrency(unittest.TestCase):
    def setUp(self):
        if frappe.local.site != 'pkg132-incremental.localhost':
            self.skipTest('destructive concurrency fixture requires isolated site')
        self.fixture = TestActionPackageLog()
        self.fixture.setUp()
        self.gates = []
        self.worker = None
        self.temp = tempfile.TemporaryDirectory(prefix='ss-zone-abort-')
        self.directory = Path(self.temp.name)
        self.old_timeout = int(frappe.db.sql('SELECT @@SESSION.innodb_lock_wait_timeout')[0][0])
        # Seed and commit before any second connection starts; no concurrent DDL.
        for _ in range(130):
            doc = frappe.get_doc({'doctype': 'ToDo', 'description': self.fixture.key,
                                  'status': 'Open', 'priority': 'Low'}).insert(ignore_permissions=True)
            self.gates.append(doc.name)
        frappe.db.commit()

    def tearDown(self):
        (self.directory / 'release-worker').write_text('release')
        frappe.db.rollback()
        if self.worker is not None:
            try:
                self.worker.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                self.worker.kill()
                self.worker.communicate()
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=%s', (self.old_timeout,))
        for name in self.gates:
            frappe.delete_doc('ToDo', name, ignore_permissions=True, force=True)
        frappe.db.commit()
        self.fixture.tearDown()
        self.temp.cleanup()

    def _start_worker(self, mode):
        config = {'site': frappe.local.site, 'directory': str(self.directory), 'mode': mode,
                  'gate_a': self.gates[0], 'gate_b': self.gates[1], 'ballast': self.gates[2:]}
        path = self.directory / 'worker.json'
        path.write_text(json.dumps(config))
        env = dict(os.environ)
        env['PYTHONPATH'] = os.pathsep.join(str(p) for p in sys.path if p)
        self.worker = subprocess.Popen([sys.executable, __file__, '--worker', str(path)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        _wait(self.directory / 'worker-ready')

    def _public_payload(self):
        fixture = self.fixture
        model = frappe.get_doc('Shangshu Object Model', fixture.binding['object_id'])
        return {'object_id': model.name, 'expected_revision': model.active_revision,
                'records': [{'name': fixture.record_name,
                             'expected_modified': str(frappe.db.get_value(
                                 model.physical_doctype, fixture.record_name, 'modified')),
                             'values': {'amount': 67.5}}]}

    def _execute(self, payload, key):
        return execute_registered_action('platform.object.update_many', payload,
            confirmed=True, idempotency_key=key, source='user', action_version='1.1.0')

    def _run_database_failure(self, mode, prior_file_write=False):
        fixture = self.fixture
        before = fixture._snapshot()
        frappe.db.commit()
        if prior_file_write:
            # A really changed the working XLSX, but its outer transaction is
            # not committed. A database abort in B must also restore A's bytes.
            fixture._write(fixture._payload('before-database-abort', amount=91.5, note='must roll back'))
            self.assertNotEqual(sheet._content(fixture.doc()), before['bytes'])
        frappe.db.get_value('ToDo', self.gates[0], 'name', for_update=True)
        self._start_worker(mode)
        payload = self._public_payload()
        key = fixture.key + ':database-' + mode
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=1')
        database_errors = []

        def blocked_projection(*args, **kwargs):
            (self.directory / 'projection-entered').write_text('entered')
            # This is the real database operation that raises 1213 or 1205.
            try:
                frappe.db.get_value('ToDo', self.gates[1], 'name', for_update=True)
            except Exception as database_error:
                database_errors.append(type(database_error).__name__)
                raise
            raise AssertionError('database conflict was not produced')

        error = None
        with mock.patch.object(promotion, '_writeback_rows', side_effect=blocked_projection), \
                mock.patch.object(promotion, 'mark_writeback_pending',
                    side_effect=AssertionError('database abort must not become pending')):
            try:
                self._execute(payload, key)
            except Exception as caught:
                error = caught
        expected = 'QueryDeadlockError' if mode == 'deadlock' else 'QueryTimeoutError'
        print(json.dumps({'mode': mode, 'database_raised': database_errors,
                          'public_returned_error': type(error).__name__ if error else None}), flush=True)
        self.assertEqual(database_errors, [expected])
        self.assertIsNotNone(error, 'database abort was swallowed as success')
        self.assertEqual(type(error).__name__, expected, repr(error))
        self.assertEqual(getattr(error, '_ss_failed_action', (None,))[0], key)
        # Caller intentionally catches the failed Action. Its outer transaction
        # still cannot be committed; a full rollback is mandatory.
        for _ in range(2):
            with self.assertRaises(Exception):
                frappe.db.commit()
        frappe.db.rollback()
        (self.directory / 'release-worker').write_text('release')
        output, errors = self.worker.communicate(timeout=15)
        self.assertEqual(self.worker.returncode, 0, (output, errors))
        worker_result = json.loads((self.directory / 'worker-result').read_text())
        self.assertTrue(worker_result['ok'], worker_result)
        self.assertEqual(fixture._snapshot(), before)
        frappe.db.commit()

        # Use the existing outer HTTP failure-receipt boundary, after rollback.
        actions.persist_http_action_failure(error)
        self.assertEqual(get_action_request_status(key)['status'], 'Failed')
        self.assertEqual(fixture._logs(), before['logs'])
        print(json.dumps({'case': mode, 'actual_db_exception': expected,
                          'caught_parent_commit_rejected': True,
                          'database_file_logs_restored': True,
                          'prior_working_file_restored': prior_file_write}), flush=True)
        return payload, key

    def test_real_deadlock_rolls_back_and_same_key_retries_once(self):
        payload, key = self._run_database_failure('deadlock')
        first = self._execute(payload, key)
        frappe.db.commit()
        self.assertEqual(self.fixture.formal(self.fixture.row_id)['amount'], 67.5)
        replay = self._execute(payload, key)
        frappe.db.commit()
        self.assertTrue(replay['idempotent'])
        self.assertEqual(replay['audit'], first['audit'])
        self.assertEqual(len(self.fixture._logs()), 1)

    def test_real_lock_timeout_rolls_back_prior_successful_file_action(self):
        self._run_database_failure('timeout', prior_file_write=True)

    def test_ordinary_file_error_still_records_pending_and_preserves_formal_value(self):
        fixture = self.fixture
        before = sheet._content(fixture.doc())
        payload = self._public_payload()
        with mock.patch.object(promotion, '_writeback_rows', side_effect=OSError('test storage failure')):
            receipt = self._execute(payload, fixture.key + ':ordinary-file-failure')
        frappe.db.commit()
        self.assertEqual(fixture.formal(fixture.row_id)['amount'], 67.5)
        self.assertEqual(sheet._content(fixture.doc()), before)
        result = receipt['result']['managed_change']['results'][0]['results'][0]['result']
        self.assertTrue(result['pending'])
        self.assertEqual(len(fixture._logs()), 1)


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--worker':
    _worker(sys.argv[2])
