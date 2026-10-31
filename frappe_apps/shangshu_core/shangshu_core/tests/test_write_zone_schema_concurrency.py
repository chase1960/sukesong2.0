"""结构门闸/绑定撤证的真实双连接基础判据；只在指定隔离站串行运行。

一组用例复用一个真实受管对象和一个未晋升 XLSX。业务写走公共动作，
模型变更走原控制器/计划入口；锁阻塞由第二连接真实1205证明，不伪造异常。
"""
import json
import os
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


def _wait(path, timeout=20):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('schema test synchronization: ' + path.name)
        time.sleep(.02)


def _worker(config_path):
    config = json.loads(Path(config_path).read_text())
    if config['site'] != SITE:
        raise RuntimeError('isolated test site required')
    frappe.init(site=config['site']); frappe.connect(); frappe.set_user('Administrator')
    result_path = Path(config['result_path'])
    from shangshu_core import write_zone_schema as zone
    try:
        frappe.db.sql('SET SESSION innodb_lock_wait_timeout=1')
        if config['mode'] == 'crash_after_fence':
            with zone.schema_lock(config['object_id']):
                zone.begin_schema_change(config['object_id'], config['token'])
                frappe.db.commit()
                result_path.write_text(json.dumps({'ok': True, 'fenced': True}))
                # 真退出连接，跳过 finally；命名锁消失但模型持久门闸必须仍然生效。
                os._exit(0)
        elif config['mode'] == 'structure':
            with zone.schema_lock(config['object_id']):
                zone.begin_schema_change(config['object_id'], config['token'])
                frappe.db.commit()
        elif config['mode'] == 'bind':
            from shangshu_core.object_companions import bind_object_companion
            bind_object_companion(config['object_id'], config['file_id'], [
                {'field_id': 'amount', 'header': '金额'}, {'field_id': 'day', 'header': '日期'}])
            frappe.db.commit()
        else:
            raise ValueError('unknown worker mode')
        result_path.write_text(json.dumps({'ok': True}))
    except Exception as error:
        result_path.write_text(json.dumps({'ok': False, 'type': type(error).__name__, 'message': str(error)}))
        frappe.db.rollback()
    finally:
        frappe.destroy()


def _blank_companion_file():
    """按产品口径造一张**空白**伴随工作文件（只有表头，没有数据行）。

    ⚠️ **为什么必须单独造一张（2026-10-28 接手时查出来的真实夹具错误）**：
    产品口径（`shangshu_files/object_projection.py`）是
    「**首次接入须使用空白伴随工作文件，不能猜测已有行对应哪条原记录**」
    ⇒ 绑定要落在**空白**工作簿上。
    原夹具把**晋升表本身**（S-1 带着 10 行数据）当伴随文件 ⇒
    **有没有并发，第一次绑定都会被这句口径拒掉**
    ⇒ 真正要测的那件事（绑定要等在途批次）压根没测到。
    ⇒ 改成走产品自己的建表口 `files.create`（表头＝要绑的两列，**不写占位**）造一张空白表。
    """
    from shangshu_core.public_api import execute_registered_action
    created = execute_registered_action('files.create', {
        'file_name': '伴随工作文件-' + uuid.uuid4().hex[:8],
        'headers': ['金额', '日期'],
        'attribution': {'level': 'personal'},
    }, confirmed=True, idempotency_key='schema-zone-blank-' + uuid.uuid4().hex)['result']
    return created['file_id']


class TestWriteZoneSchemaConcurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if frappe.local.site != SITE:
            raise unittest.SkipTest('only isolated pkg132-incremental site may run this fixture')
        frappe.set_user('Administrator')
        from shangshu_core.tests.test_promotion_records import TestPromotionRecords
        from shangshu_files.tests.test_promotion_managed import TestPromotionToManagedRecords
        cls.fixture = TestPromotionRecords(); cls.fixture.setUp()
        cls.result = cls.fixture._provision()
        cls.object_id = cls.result['object_id']; cls.application_id = cls.result['application_id']
        cls.record_name = next(iter(cls.result['records'].values()))
        cls.upload = TestPromotionToManagedRecords(); cls.upload.setUp(); cls.upload._upload()
        # 晋升表本身留着当「被投影的原记录来源」；**被绑定的**是另一张空白伴随表（见 _blank_companion_file 的说明）。
        cls.upload_table_id = cls.upload.table
        cls.file_id = _blank_companion_file()
        frappe.db.commit()  # 所有夹具 DDL/上传在任何并发事务之前完成。
        cls.directory_owner = tempfile.TemporaryDirectory(prefix='ss-schema-zone-')
        cls.directory = Path(cls.directory_owner.name)
        cls.key = 'schema-zone-' + uuid.uuid4().hex
        cls.children = []

    @classmethod
    def tearDownClass(cls):
        frappe.set_user('Administrator'); frappe.db.rollback()
        for process in cls.children:
            if process.poll() is None:
                process.kill(); process.communicate()
        # 只清本组夹具，已有历史审计不改。解绑后不重新发认证。
        for name in frappe.get_all('Shangshu Object Companion', filters={'object_id': cls.object_id}, pluck='name'):
            frappe.delete_doc('Shangshu Object Companion', name, ignore_permissions=True, force=True)
        frappe.db.commit()
        from shangshu_files import promotion
        # ⚠️ **2026-10-28 接手修正（真实夹具错误）**：删文件前**先删版本行**。
        #   版本表 `Shangshu File Center Version.frappe_file` 是指向 Frappe「File」的链接
        #   ⇒ 删文件删到一半（remove_all 去删附件）会被这句挡下：
        #   「Cannot delete … File … is linked with Shangshu File Center Version」。
        #   ⇒ 先把本组两个文件的版本行清掉，再删文件本身（两个都要删：空白伴随表 ＋ 晋升表）。
        owned = [f for f in (cls.file_id, cls.upload_table_id) if f]
        for file_id in owned:
            for name in frappe.get_all('Shangshu File Center Version', filters={'file': file_id}, pluck='name'):
                frappe.delete_doc('Shangshu File Center Version', name, ignore_permissions=True, force=True)
        frappe.db.commit()
        for file_id in owned:
            if frappe.db.exists(promotion.FILE, file_id):
                frappe.delete_doc(promotion.FILE, file_id, ignore_permissions=True, force=True)
        frappe.db.commit()
        cls.fixture._cleanup()
        cls.directory_owner.cleanup()

    def setUp(self):
        frappe.set_user('Administrator'); frappe.db.rollback()
        from shangshu_core import request_cache
        request_cache.clear()
        self.suffix = uuid.uuid4().hex[:10]

    def tearDown(self):
        frappe.db.rollback()

    def model(self):
        return frappe.get_doc('Shangshu Object Model', self.object_id)

    def public_write(self, suffix, amount=22.5):
        from shangshu_core.public_api import execute_registered_action
        model = self.model()
        version = str(frappe.db.get_value(model.physical_doctype, self.record_name, 'modified'))
        return execute_registered_action('platform.object.update_many', {
            'object_id': model.name, 'expected_revision': model.active_revision,
            'records': [{'name': self.record_name, 'expected_modified': version, 'values': {'amount': amount}}]},
            confirmed=True, action_version='1.1.0', idempotency_key=self.key + ':' + suffix)

    def run_worker(self, mode, token=''):
        label = mode + '-' + uuid.uuid4().hex[:8]
        path = self.directory / (label + '.json')
        result_path = self.directory / (label + '.result')
        path.write_text(json.dumps({'site': SITE, 'mode': mode, 'token': token,
            'object_id': self.object_id, 'file_id': self.file_id, 'result_path': str(result_path)}))
        env = dict(os.environ); env['PYTHONPATH'] = os.pathsep.join(str(p) for p in sys.path if p)
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.children.append(process)
        stdout, stderr = process.communicate(timeout=25)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        _wait(result_path)
        return json.loads(result_path.read_text())

    def certify(self):
        from shangshu_core.write_zone_certification import certify_managed_write_zone
        frappe.db.commit()
        result = certify_managed_write_zone(self.object_id)
        frappe.db.commit()
        self.assertTrue(self.model().write_zone_certification)
        return result

    def test_a_durable_fence_survives_owner_disconnect_and_wrong_token_cannot_clear(self):
        from shangshu_core import write_zone_schema as zone
        token = self.key + ':crash'
        self.assertTrue(self.run_worker('crash_after_fence', token)['ok'])
        frappe.db.rollback()  # 新读视图；不靠父连接旧 snapshot 判断耐久性。
        self.assertEqual(self.model().scope_fence, token)
        model = self.model()
        compiled = json.loads(model.active_json)
        amount_column = next(column['fieldname'] for field, column in
            zip(compiled['fields'], compiled['doctype']['fields']) if field['id'] == 'amount')
        before_amount = frappe.db.get_value(model.physical_doctype, self.record_name, amount_column)
        # 命名锁已随真实连接退出而释放。
        with zone.schema_lock(self.object_id):
            with self.assertRaises(frappe.ValidationError):
                self.public_write('fenced')
        frappe.db.rollback()
        self.assertEqual(frappe.db.get_value(model.physical_doctype, self.record_name, amount_column), before_amount)
        self.assertFalse(frappe.db.exists('Shangshu Unified Log', {'idempotency_key': self.key + ':fenced'}))
        with self.assertRaises(frappe.TimestampMismatchError):
            zone.finish_schema_change(self.object_id, token + '-wrong', lambda model: True)
        frappe.db.rollback()
        self.assertEqual(self.model().scope_fence, token)
        from shangshu_core.write_zone_certification import certify_managed_write_zone
        with self.assertRaises(frappe.ValidationError):
            certify_managed_write_zone(self.object_id)
        frappe.db.rollback()
        zone.finish_schema_change(self.object_id, token, lambda model: model.active_revision > 0)
        frappe.db.commit()
        self.assertFalse(self.model().scope_fence)
        self.public_write('after-recovery'); frappe.db.commit()

    def test_b_controller_rejects_generic_coordination_patch_and_definition_revokes_certificate(self):
        self.certify()
        for field, value in [('scope_fence', 'forged'), ('write_zone_certification', '{"forged":true}')]:
            doc = self.model(); setattr(doc, field, value)
            with self.assertRaises(frappe.PermissionError): doc.save(ignore_permissions=True)
            frappe.db.rollback()
        from shangshu_core.model_changes import prepare_object_change
        from shangshu_core.promotion_records import build_definition
        from shangshu_core.tests.test_promotion_records import COLUMNS, TABLE_ACCESS
        model = self.model()
        prepare_object_change(self.application_id, build_definition('改名并撤销旧认证', COLUMNS, TABLE_ACCESS),
            self.key + ':definition', object_id=model.name, expected_revision=model.revision)
        self.assertFalse(self.model().write_zone_certification)
        frappe.db.rollback()  # 不激活定义、不残留Planned变更，后续仍复用同一份夹具。

    def test_c_public_atomic_package_rejects_each_direct_engineering_entry(self):
        from shangshu_core import model_records, model_changes, managed_nulls, model_lifecycle
        attempts = [lambda: model_changes.execute_object_change('unused-change', confirmed=True),
                    lambda: managed_nulls.execute_migration(self.object_id, 'unused-plan', confirmed=True),
                    lambda: model_lifecycle.retire_managed_object(self.object_id, 'must not retire'),
                    lambda: model_lifecycle.retire_application(self.application_id, 'must not retire')]
        for index, attempt in enumerate(attempts):
            with patch.object(model_records, 'write_records', side_effect=lambda *args, **kwargs: attempt()):
                with self.assertRaisesRegex(frappe.ValidationError, '原子包中不得执行'):
                    self.public_write('direct-ddl-%s' % index)
            frappe.db.rollback()
            self.assertFalse(self.model().scope_fence)
            self.assertTrue(self.model().active_revision)

    def test_d_structure_waits_for_existing_batch_application_model_locks(self):
        from shangshu_core import model_records, write_zone_schema as zone
        with model_records.batch_state():
            model_records._load(self.object_id, write=True)
            blocked = self.run_worker('structure', self.key + ':waiting')
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['type'], 'QueryTimeoutError', blocked)
        frappe.db.rollback()
        self.assertTrue(self.run_worker('structure', self.key + ':waiting')['ok'])
        frappe.db.rollback()
        self.assertEqual(self.model().scope_fence, self.key + ':waiting')
        zone.finish_schema_change(self.object_id, self.key + ':waiting', lambda model: model.active_revision > 0)
        frappe.db.commit()

    def test_z_binding_waits_for_existing_batch_then_revokes_certification(self):
        self.certify()
        from shangshu_core import model_records
        with model_records.batch_state():
            model_records._load(self.object_id, write=True)
            blocked = self.run_worker('bind')
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['type'], 'QueryTimeoutError', blocked)
        frappe.db.rollback()
        self.assertTrue(self.run_worker('bind')['ok'])
        frappe.db.rollback()
        self.assertFalse(self.model().write_zone_certification)
        self.assertTrue(frappe.db.exists('Shangshu Object Companion', {'object_id': self.object_id, 'file_id': self.file_id}))
        from shangshu_core.write_zone_certification import certify_managed_write_zone
        with self.assertRaises(frappe.ValidationError): certify_managed_write_zone(self.object_id)


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--worker':
    _worker(sys.argv[2])
