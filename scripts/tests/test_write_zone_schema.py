"""结构门闸真实 helper 的离线行为；真实 DDL/双连接另由隔离站验收。"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/write_zone_schema.py'


class Doc(dict):
    def __getattr__(self, key):
        if key.startswith('__'):
            raise AttributeError(key)
        return self.get(key)
    def __setattr__(self, key, value):
        self[key] = value
    def get_doc_before_save(self):
        return self.get('_before')


class Database:
    def __init__(self, models):
        self.models = models
        self.committed = copy.deepcopy(models)
        self.calls = []
        self.locks = set()
        self.applications = set()
    def set_value(self, kind, name, values, value=None, update_modified=True):
        if isinstance(values, str): values = {values: value}
        self.calls.append(('set', kind, name, copy.deepcopy(values), update_modified))
        self.models[name].update(values)
    def commit(self):
        self.calls.append(('commit',))
        self.committed = copy.deepcopy(self.models)
    def rollback(self):
        self.models.clear(); self.models.update(copy.deepcopy(self.committed))
    def exists(self, kind, name):
        """**这个 DocType 下的这一行在不在**（2026-10-30 补）。

        ⚠️ **为什么要补**：`write_zone_schema.lock_model` 读所属应用那一步改成了
        「**先问在不在**、在才读」（孤儿受管对象：应用已经被删 ⇒ 跳过读它）。
        ⇒ 替身没有这个方法 ⇒ **那把尺子直接跑不起来**（8 条用例报
        `AttributeError: 'Database' object has no attribute 'exists'`）
        ⇒ **尺子哑了** ⇒ 看起来「闸没松」，其实是「闸没被量」。

        ⇒ 这里按**真实语义**实现：应用在 `self.applications` 里就是在。
        """
        if kind == 'Shangshu Application Definition':
            return name in self.applications
        return name in self.models
    def sql(self, statement, params):
        self.calls.append(('sql', statement, params))
        if 'GET_LOCK' in statement:
            self.locks.add(params[0]); return [(1,)]
        if 'RELEASE_LOCK' in statement:
            self.locks.remove(params[0]); return [(1,)]
        raise AssertionError(statement)


class SchemaFenceTests(unittest.TestCase):
    def setUp(self):
        self.models = {'object': Doc(name='object', application='app', revision=2,
            active_revision=1, active_json='{"fields":[]}', draft_json='{}',
            physical_doctype='SSM test', scope_fence='', write_zone_certification='')}
        self.db = Database(self.models)
        # —— **应用默认是在的**（正常情形：模型行有个活着的应用）
        #    ⇒ `lock_model` 会「先锁应用、再锁模型」（锁顺序要一致 ⇒ 不能反）。
        #    「孤儿」（应用已经被删）那种情形由 `test_lock_model_skips_missing_application` 单独钉。
        self.db.applications.add('app')
        self.gets = []
        def get_doc(kind, name, **kwargs):
            self.gets.append((kind, name, kwargs))
            if kind == 'Shangshu Application Definition':
                return Doc(name=name)
            return copy.deepcopy(self.models[name])
        def fail(message, error=ValueError):
            raise error(message)
        fake = SimpleNamespace(db=self.db, get_doc=get_doc, throw=fail,
            ValidationError=ValueError, TimestampMismatchError=RuntimeError,
            PermissionError=PermissionError)
        self.patch = patch.dict(sys.modules, {'frappe': fake,
            'shangshu_core.action_packages': SimpleNamespace(reject_migration=lambda: None)})
        self.patch.start(); self.addCleanup(self.patch.stop)
        spec = importlib.util.spec_from_file_location('tested_write_zone_schema', SOURCE)
        self.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.module)

    def test_begin_drains_application_then_model_and_never_commits(self):
        self.module.begin_schema_change('object', 'change:one')
        locks = [(kind, name) for kind, name, kw in self.gets if kw.get('for_update')]
        self.assertEqual(locks, [('Shangshu Application Definition', 'app'), ('Shangshu Object Model', 'object')])
        self.assertEqual(self.models['object'].scope_fence, 'change:one')
        self.assertFalse(any(call[0] == 'commit' for call in self.db.calls))

    def test_lock_model_skips_missing_application(self):
        """**孤儿受管对象**（应用已经被删）⇒ 跳过读它，**模型行照锁**。

        ⚠️ **为什么要有这一条**（2026-10-30 真站实测撞出来的内核缺口）：
          「应用不在 ⇒ 当场拒」⇒ 那个对象**永远退不掉**、物理表一直占库。
          ⇒ 退役口改成「应用不在就跳过读它」⇒ **锁顺序在孤儿情形下变成只有模型**。
          ⇒ 这条把那个形状**钉住**（免得以后有人把「跳过」写成「不锁模型」）。
        """
        self.db.applications.discard('app')          # ⇒ 应用不在了
        model = self.module.lock_model('object')
        locks = [(kind, name) for kind, name, kw in self.gets if kw.get('for_update')]
        self.assertEqual(locks, [('Shangshu Object Model', 'object')],
                         '孤儿情形下不该去锁那个已经不存在的应用')
        self.assertEqual(model.name, 'object', '模型行照锁（要拿它的行锁做工程门闸）')

    def test_original_ddl_commit_makes_fence_durable_failure_does_not_clear(self):
        self.module.begin_schema_change('object', 'change:one')
        self.db.commit()  # 代表原 sql_ddl 的提交，不由 helper 新增。
        self.db.rollback()
        with self.assertRaisesRegex(ValueError, '结构'):
            self.module.assert_model_writable(self.models['object'])
        self.assertEqual(self.models['object'].scope_fence, 'change:one')

    def test_same_token_recovers_but_other_token_cannot_replace(self):
        self.module.begin_schema_change('object', 'change:one')
        self.module.recover_schema_change('object', 'change:one')
        with self.assertRaises(RuntimeError):
            self.module.begin_schema_change('object', 'change:two')
        with self.assertRaises(RuntimeError):
            self.module.recover_schema_change('object', 'change:two')
        self.assertEqual(self.models['object'].scope_fence, 'change:one')

    def test_finish_requires_same_token_and_successful_verification(self):
        self.module.begin_schema_change('object', 'change:one')
        for token, verifier in [('change:two', lambda model: True), ('change:one', lambda model: False)]:
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.finish_schema_change('object', token, verifier)
            self.assertEqual(self.models['object'].scope_fence, 'change:one')
        def broken(model):
            raise OSError('核验失败')
        with self.assertRaises(OSError):
            self.module.finish_schema_change('object', 'change:one', broken)
        self.assertEqual(self.models['object'].scope_fence, 'change:one')
        self.module.finish_schema_change('object', 'change:one', lambda model: True)
        self.assertEqual(self.models['object'].scope_fence, '')
        self.assertFalse(any(call[0] == 'commit' for call in self.db.calls))

    def test_clear_is_not_durable_before_callers_final_commit(self):
        self.module.begin_schema_change('object', 'change:one'); self.db.commit()
        self.module.finish_schema_change('object', 'change:one', lambda model: True)
        self.db.rollback()
        self.assertEqual(self.models['object'].scope_fence, 'change:one')

    def test_schema_change_revokes_certificate_and_finish_never_recertifies(self):
        self.module.set_certification('object', {'version': 1, 'profile': 'checked'})
        self.assertTrue(self.models['object'].write_zone_certification)
        self.module.begin_schema_change('object', 'change:one')
        self.assertEqual(self.models['object'].write_zone_certification, '')
        with self.assertRaises(ValueError):
            self.module.set_certification('object', {'version': 1})
        self.module.finish_schema_change('object', 'change:one', lambda model: True)
        self.assertEqual(self.models['object'].write_zone_certification, '')

    def test_revocation_preserves_fence_and_uses_current_model(self):
        stale = copy.deepcopy(self.models['object'])
        self.models['object'].scope_fence = 'change:one'
        self.models['object'].write_zone_certification = '{"version":1}'
        current = self.module.revoke_certification(stale)
        self.assertEqual(current.scope_fence, 'change:one')
        self.assertEqual(self.models['object'].scope_fence, 'change:one')
        self.assertEqual(self.models['object'].write_zone_certification, '')

    def test_generic_model_save_cannot_set_or_clear_coordination_fields(self):
        for field, before, after in [('scope_fence', '', 'forged'), ('scope_fence', 'change:one', ''),
                                     ('write_zone_certification', '', '{"forged":true}')]:
            original = copy.deepcopy(self.models['object']); original[field] = before
            doc = copy.deepcopy(original); doc[field] = after; doc['_before'] = original
            with self.assertRaises(PermissionError):
                self.module.validate_model_update(doc)

    def test_new_model_cannot_smuggle_certificate_or_fence(self):
        for field in ('scope_fence', 'write_zone_certification'):
            doc = copy.deepcopy(self.models['object']); doc[field] = 'forged'
            with self.assertRaises(PermissionError):
                self.module.validate_model_update(doc)

    def test_definition_save_revokes_cert_but_preserves_fence(self):
        original = copy.deepcopy(self.models['object']); original.write_zone_certification = '{"v":1}'
        doc = copy.deepcopy(original); doc['_before'] = original; doc.draft_json = '{"new":true}'
        self.module.validate_model_update(doc)
        self.assertEqual(doc.write_zone_certification, '')
        original.scope_fence = 'change:one'; doc.scope_fence = 'change:one'
        doc.write_zone_certification = original.write_zone_certification
        with self.assertRaises(ValueError):
            self.module.validate_model_update(doc)
        with self.module.schema_operation('object', 'change:one'):
            doc.write_zone_certification = original.write_zone_certification
            self.module.validate_model_update(doc)
        self.assertEqual(doc.scope_fence, 'change:one')

    def test_schema_operation_is_nested_and_restored(self):
        original = copy.deepcopy(self.models['object']); original.scope_fence = 'change:one'
        doc = copy.deepcopy(original); doc['_before'] = original; doc.active_revision = 2
        with self.module.schema_operation('object', 'change:one'):
            with self.module.schema_operation('other', 'change:two'):
                with self.assertRaises(ValueError): self.module.validate_model_update(doc)
            self.module.validate_model_update(doc)
        with self.assertRaises(ValueError): self.module.validate_model_update(doc)

    def test_named_lock_preserves_existing_name_and_survives_commit(self):
        import hashlib
        expected = 'ss_schema_' + hashlib.sha256(json.dumps('object', sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:48]
        with self.module.schema_lock('object'):
            self.assertIn(expected, self.db.locks)
            self.db.commit()
            self.assertIn(expected, self.db.locks)
        self.assertFalse(self.db.locks)

    def test_named_lock_failure_does_not_clear_fence(self):
        with self.assertRaises(OSError):
            with self.module.schema_lock('object'):
                self.module.begin_schema_change('object', 'change:one')
                self.db.commit()
                raise OSError('DDL failed')
        self.assertEqual(self.models['object'].scope_fence, 'change:one')
        self.assertFalse(self.db.locks)

    def test_release_failure_does_not_hide_original_engineering_error(self):
        original, release_error = OSError('DDL failed'), RuntimeError('connection lost')
        real_sql = self.db.sql
        def sql(statement, params):
            if 'RELEASE_LOCK' in statement: raise release_error
            return real_sql(statement, params)
        self.db.sql = sql
        with self.assertRaises(OSError) as caught:
            with self.module.schema_lock('object'):
                raise original
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, release_error)

    def test_reference_targets_use_locked_current_state_and_reject_fence_retirement_or_pin(self):
        target = copy.deepcopy(self.models['object']); target.name = 'target'; target.active_revision = 3
        self.models['target'] = target
        compiled = {'owner': 'app', 'fields': [{'type': 'detail', 'target': 'target'}],
                    'reference_revisions': {'target': 3}}
        self.module.assert_reference_targets(compiled)
        self.models['target'].scope_fence = 'nullable:pending'
        with self.assertRaises(ValueError): self.module.assert_reference_targets(compiled)
        self.models['target'].scope_fence = ''; self.models['target'].active_revision = 0
        with self.assertRaises(ValueError): self.module.assert_reference_targets(compiled)
        self.models['target'].active_revision = 4
        with self.assertRaises(RuntimeError): self.module.assert_reference_targets(compiled)

    def test_self_reference_only_allows_this_same_schema_operation(self):
        self.models['object'].scope_fence = 'schema-change:one'
        compiled = {'owner': 'app', 'fields': [{'type': 'reference', 'target': 'object'}]}
        self.module.assert_reference_targets(compiled, source='object', token='schema-change:one')
        with self.assertRaises(ValueError):
            self.module.assert_reference_targets(compiled, source='object', token='other')


if __name__ == '__main__':
    unittest.main(verbosity=2)
