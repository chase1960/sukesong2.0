"""运行实际结构入口函数，检查 DDL 提交边界前后持久门闸的行为。"""
import ast
import copy
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import hashlib
import json
import sys
import test_write_zone_schema as seam

CORE = seam.ROOT / 'frappe_apps/shangshu_core/shangshu_core'


def functions(file, names, namespace):
    tree = ast.parse((CORE / file).read_text())
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(CORE / file), 'exec'), namespace)
    return namespace


class ModelChangeFenceTests(unittest.TestCase):
    def setUp(self):
        seam.SchemaFenceTests.setUp(self)
        self.models['change'] = seam.Doc(name='change', object_model='object', status='Planned',
            target_revision=2, compiled_json='{"fields":[]}', error_message='')
        self.gets = []
        def get_doc(kind, name, **kwargs):
            self.gets.append((kind, name, kwargs))
            if kind == 'Shangshu Application Definition': return seam.Doc(name=name)
            doc = copy.deepcopy(self.models[name])
            doc.save = lambda **kw: self.models[name].update({key: value for key, value in doc.items() if key != 'save'})
            return doc
        self.module.frappe.get_doc = get_doc
        self.module.frappe.session = seam.Doc(user='Administrator')
        self.steps = []
        context = {'change': get_doc('Shangshu Schema Change', 'change'),
                   'model': get_doc('Shangshu Object Model', 'object'), 'compiled': {},
                   'done': False, 'started': False}
        def ddl(ctx):
            self.steps.append(('ddl', self.models['object'].scope_fence))
            self.db.commit()
        def permissions(ctx):
            self.steps.append(('permissions', self.models['object'].scope_fence))
            self.db.commit(); ctx['completed'] = True
        self.ns = {'frappe': self.module.frappe, 'MODEL': 'Shangshu Object Model',
            'CHANGE': 'Shangshu Schema Change', 'write_zone_schema': self.module,
            '_designer': lambda: seam.Doc(name='actor'), '_prepare_object_change': lambda *args: context,
            '_lifecycle_lock': lambda: None, '_public': lambda change: {'status': change.status},
            '_apply_object_change_ddl': ddl, '_write_object_permissions': permissions,
            '_verify_object_change': lambda *args: True, '_mark_object_change_failed': lambda ctx: None,
            '_hash': lambda name: 'hash', '_definition': lambda *args, **kwargs: None}
        functions('model_changes.py', {'execute_object_change', '_lock_object_change', '_activate_object_change'}, self.ns)
        self.context = context

    def test_fence_is_present_before_first_ddl_and_until_permissions_complete(self):
        result = self.ns['execute_object_change']('change', confirmed=True)
        self.assertEqual(result, {'status': 'Applied'})
        self.assertEqual(self.steps, [('ddl', 'schema-change:change'), ('permissions', 'schema-change:change')])
        self.assertEqual(self.models['object'].scope_fence, '')
        self.assertEqual(self.db.committed['object'].scope_fence, 'schema-change:change')
        self.assertEqual(sum(call[0] == 'commit' for call in self.db.calls), 2,
                         '不能在原两次模拟DDL提交之外自行提交调用方')

    def test_ddl_failure_keeps_durable_fence(self):
        def fail(ctx):
            self.db.commit()
            raise OSError('DDL interrupted')
        self.ns['_apply_object_change_ddl'] = fail
        with self.assertRaises(OSError): self.ns['execute_object_change']('change', confirmed=True)
        self.db.rollback()
        self.assertEqual(self.models['object'].scope_fence, 'schema-change:change')

    def test_permissions_failure_after_activation_keeps_fence(self):
        def fail(ctx):
            self.db.commit()
            raise OSError('permission verification interrupted')
        self.ns['_write_object_permissions'] = fail
        with self.assertRaises(OSError): self.ns['execute_object_change']('change', confirmed=True)
        self.db.rollback()
        self.assertEqual(self.models['object'].scope_fence, 'schema-change:change')

    def test_applied_but_fenced_recovery_cannot_early_return(self):
        self.models['object'].scope_fence = 'schema-change:change'
        self.models['change'].status = 'Applied'
        self.context['change'].status = 'Applied'
        self.context['model'].scope_fence = 'schema-change:change'
        self.context['done'] = False
        self.ns['execute_object_change']('change', confirmed=True)
        self.assertEqual(len(self.steps), 2)
        self.assertEqual(self.models['object'].scope_fence, '')

    def test_direct_change_entry_rejects_package_before_any_database_work(self):
        with patch.object(sys.modules['shangshu_core.action_packages'], 'reject_migration',
                          side_effect=ValueError('atomic package forbidden')):
            with self.assertRaisesRegex(ValueError, 'atomic package forbidden'):
                self.ns['execute_object_change']('change', confirmed=True)
        self.assertFalse(self.db.calls)

    def test_reference_target_retired_after_ddl_blocks_activation_and_retains_source_fence(self):
        target = copy.deepcopy(self.models['object']); target.name = 'target'
        self.models['target'] = target
        self.context['compiled'] = {'owner': 'app', 'fields': [{'type': 'reference', 'target': 'target'}]}
        def ddl_then_target_retired(ctx):
            self.db.commit()
            self.models['target'].active_revision = 0
            self.db.commit()
        self.ns['_apply_object_change_ddl'] = ddl_then_target_retired
        with self.assertRaisesRegex(ValueError, '引用对象'):
            self.ns['execute_object_change']('change', confirmed=True)
        self.db.rollback()
        self.assertEqual(self.models['object'].scope_fence, 'schema-change:change')
        self.assertEqual(self.models['object'].active_revision, 1)


class NullableFenceTests(unittest.TestCase):
    def setUp(self):
        seam.SchemaFenceTests.setUp(self)
        self.db.transaction_writes = 0
        self.module.frappe.flags = SimpleNamespace()
        self.module.frappe.session = SimpleNamespace(user='Administrator')
        self.receipts = []
        self.hash = 'plan-original'
        self.token = 'nullable:' + hashlib.sha256(json.dumps(['object', self.hash], separators=(',', ':')).encode()).hexdigest()
        def ddl(compiled):
            self.assertEqual(self.models['object'].scope_fence, self.token)
            self.db.commit()
        self.ns = {'frappe': self.module.frappe, 'write_zone_schema': self.module,
            'hashlib': hashlib, 'json': json,
            '_engineering_model': lambda obj: (copy.deepcopy(self.models[obj]), {}),
            'preview_migration': lambda obj: {'plan_hash': self.hash, 'ddl': 'ALTER'},
            'apply_schema': ddl, '_schema': lambda doctype: {}, '_ddl': lambda *args: None}
        functions('managed_nulls.py', {'execute_migration'}, self.ns)
        def receipt(*args, **kwargs):
            self.receipts.append((args, kwargs)); return SimpleNamespace(name='receipt')
        self.modules = patch.dict(sys.modules, {
            'shangshu_core.unified_log': SimpleNamespace(write_log=receipt),
            'shangshu_core.identity': SimpleNamespace(get_identity=lambda: SimpleNamespace(name='actor')),
            'shangshu_core.model_changes': SimpleNamespace(_hash=lambda value: 'hash')})
        self.modules.start(); self.addCleanup(self.modules.stop)

    def test_nullable_fence_uses_original_commit_boundaries(self):
        self.ns['execute_migration']('object', self.hash, confirmed=True)
        self.assertEqual(self.models['object'].scope_fence, '')
        self.assertEqual(self.db.committed['object'].scope_fence, '')
        self.assertEqual(sum(call[0] == 'commit' for call in self.db.calls), 3)
        self.assertEqual(len(self.receipts), 1)

    def test_nullable_failure_then_same_plan_recovers_after_physical_hash_changed(self):
        def fail(compiled):
            self.db.commit(); raise OSError('after DDL')
        self.ns['apply_schema'] = fail
        with self.assertRaises(ValueError):
            self.ns['execute_migration']('object', self.hash, confirmed=True)
        self.assertEqual(self.models['object'].scope_fence, self.token)
        self.ns['preview_migration'] = lambda obj: {'plan_hash': 'physical-now-changed', 'ddl': None}
        self.ns['apply_schema'] = lambda compiled: None
        self.ns['execute_migration']('object', self.hash, confirmed=True)
        self.assertEqual(self.models['object'].scope_fence, '')

    def test_nullable_different_recovery_plan_is_rejected_before_ddl(self):
        self.models['object'].scope_fence = self.token; self.db.commit()
        with self.assertRaises(RuntimeError):
            self.ns['execute_migration']('object', 'other', confirmed=True)
        self.assertEqual(self.models['object'].scope_fence, self.token)

    def test_direct_nullable_entry_rejects_package_before_commit(self):
        with patch.object(sys.modules['shangshu_core.action_packages'], 'reject_migration',
                          side_effect=ValueError('atomic package forbidden')):
            with self.assertRaisesRegex(ValueError, 'atomic package forbidden'):
                self.ns['execute_migration']('object', self.hash, confirmed=True)
        self.assertFalse(self.db.calls)


class RetirementFenceTests(unittest.TestCase):
    def setUp(self):
        seam.SchemaFenceTests.setUp(self)
        self.exists = True
        self.receipts = []
        fake = self.module.frappe
        fake.conf = SimpleNamespace(maintenance_mode=False)
        fake.flags = SimpleNamespace(in_migrate=False)
        previous_get = fake.get_doc
        def get_doc(kind, name=None, **kwargs):
            if isinstance(kind, dict):
                return SimpleNamespace(insert=lambda **kw: self.receipts.append(kind))
            return previous_get(kind, name, **kwargs)
        fake.get_doc = get_doc
        fake.delete_doc = lambda *args, **kwargs: setattr(self, 'exists', False)
        self.db.exists = lambda kind, name: self.exists if kind == 'DocType' else True
        self.db.get_value = lambda kind, name, fields, **kwargs: copy.deepcopy(self.models[name])
        old_sql = self.db.sql
        self.table_exists = True
        def sql(statement, params):
            if 'information_schema.tables' in statement:
                return [(1,)] if self.table_exists else []
            return old_sql(statement, params)
        self.db.sql = sql
        def ddl(statement):
            self.assertTrue(self.models['object'].scope_fence)
            self.db.commit(); self.table_exists = False
        self.ns = {'frappe': fake, 'write_zone_schema': self.module, 'hashlib': hashlib, 'json': json,
            'MODEL': 'Shangshu Object Model', 'DEFINITION': 'Shangshu Application Definition',
            'RETIREMENT': 'Shangshu Object Model Retirement', '_actor': lambda actor=None: actor or 'actor',
            'lock_lifecycle': lambda: None,
            '_fail': lambda message: (_ for _ in ()).throw(ValueError(message)),
            '_referencing_objects': lambda obj: [], '_physical_table': lambda doctype: 'tab'+doctype,
            'now_datetime': lambda: '2026-10-28', 'execute_ddl': ddl}
        functions('model_lifecycle.py', {'retire_managed_object', 'retire_application'}, self.ns)

    def test_retirement_keeps_fence_until_physical_delete_and_receipt_complete(self):
        result = self.ns['retire_managed_object']('object', 'done')
        self.assertTrue(result['retired'])
        self.assertFalse(self.models['object'].active_revision)
        self.assertEqual(self.models['object'].scope_fence, '')
        self.assertEqual(self.db.committed['object'].scope_fence, '')
        self.assertEqual(len(self.receipts), 1)

    def test_retirement_failure_with_inactive_pointer_is_recoverable_same_plan_only(self):
        def fail(statement):
            self.db.commit(); raise OSError('DROP failed')
        normal = self.ns['execute_ddl']; self.ns['execute_ddl'] = fail
        with self.assertRaises(OSError): self.ns['retire_managed_object']('object', 'done')
        fence = self.models['object'].scope_fence
        self.assertTrue(fence); self.assertFalse(self.models['object'].active_revision)
        with self.assertRaises(RuntimeError): self.ns['retire_managed_object']('object', 'different plan')
        self.ns['execute_ddl'] = normal
        self.ns['retire_managed_object']('object', 'done')
        self.assertEqual(self.models['object'].scope_fence, '')
        self.assertEqual(len(self.receipts), 1)

    def test_doctype_delete_failure_cannot_be_swallowed_and_open_gate(self):
        def fail(*args, **kwargs): raise OSError('metadata delete failed')
        self.module.frappe.delete_doc = fail
        with self.assertRaises(OSError): self.ns['retire_managed_object']('object', 'done')
        self.assertTrue(self.models['object'].scope_fence)
        self.assertFalse(self.receipts)

    def test_application_retry_includes_inactive_objects_with_pending_fence(self):
        self.module.frappe.conf.maintenance_mode = True
        self.models['app'] = seam.Doc(name='app', status='Published')
        token = 'retire:' + hashlib.sha256(json.dumps(
            ['object', 2, 'actor', '随应用下线：done'], separators=(',', ':')).encode()).hexdigest()
        self.models['object'].active_revision = 0; self.models['object'].scope_fence = token
        def get_all(kind, filters=None, fields=None, or_filters=None):
            return [{'name': 'object'}] if (self.models['object'].active_revision
                or (or_filters and self.models['object'].scope_fence)) else []
        self.module.frappe.get_all = get_all
        self.db.commit()
        result = self.ns['retire_application']('app', 'done')
        self.assertEqual(result['retired_objects'], ['object'])
        self.assertEqual(self.models['object'].scope_fence, '')

    def test_application_retry_does_not_silently_skip_another_schema_fence(self):
        self.module.frappe.conf.maintenance_mode = True
        self.models['object'].active_revision = 0; self.models['object'].scope_fence = 'nullable:other'
        self.module.frappe.get_all = lambda kind, filters=None, fields=None, or_filters=None: (
            [{'name': 'object'}] if or_filters else [])
        with self.assertRaises(RuntimeError): self.ns['retire_application']('app', 'done')

    def test_application_retirement_requires_explicit_maintenance_window(self):
        with self.assertRaisesRegex(ValueError, '维护'):
            self.ns['retire_application']('app', 'done')
        self.assertFalse(self.db.calls)

    def test_both_retirement_entries_reject_package_before_maintenance_or_writes(self):
        with patch.object(sys.modules['shangshu_core.action_packages'], 'reject_migration',
                          side_effect=ValueError('atomic package forbidden')):
            for function, target in [('retire_managed_object', 'object'), ('retire_application', 'app')]:
                with self.assertRaisesRegex(ValueError, 'atomic package forbidden'):
                    self.ns[function](target, 'done')
        self.assertFalse(self.db.calls)

    def test_incoming_references_use_current_read_and_include_both_relation_types(self):
        self.module.frappe.parse_json = json.loads
        self.module.frappe.get_all = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('stale snapshot'))
        def current_sql(query, as_dict=False):
            self.assertIn('LOCK IN SHARE MODE', query)
            return [{'name': kind, 'active_json': json.dumps({'fields': [
                {'type': kind, 'target': 'object'}]})} for kind in ('reference', 'detail')]
        self.db.sql = current_sql
        functions('model_lifecycle.py', {'_referencing_objects'}, self.ns)
        self.assertEqual(self.ns['_referencing_objects']('object'), ['reference', 'detail'])

    def test_unparseable_active_definition_blocks_retirement_before_fence_or_ddl(self):
        self.module.frappe.parse_json = json.loads
        original_sql = self.db.sql
        def current_sql(query, *args, **kwargs):
            if 'SELECT name, active_json' in query:
                return [{'name': 'broken-active-model', 'active_json': '{bad'}]
            return original_sql(query, *args, **kwargs)
        self.db.sql = current_sql
        functions('model_lifecycle.py', {'_referencing_objects'}, self.ns)
        with self.assertRaisesRegex(ValueError, 'broken-active-model.*无法核验'):
            self.ns['retire_managed_object']('object', 'done')
        self.assertFalse(self.models['object'].scope_fence)
        self.assertTrue(self.table_exists)
        self.assertFalse(self.receipts)


if __name__ == '__main__': unittest.main(verbosity=2)
