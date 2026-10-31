"""锁内前像复用：真实公共批写循环；数据库/Document 生命周期为明确计数边界。"""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions

install_real_environment()
from shangshu_core import model_records, managed_changes, managed_batch_storage
import frappe.model.document as native_document

ROOT = Path(__file__).resolve().parents[2]
RECORDS = ROOT / 'frappe_apps/shangshu_core/shangshu_core/model_records.py'


class NativeDocument:
    def __init__(self, values, database, get_doc):
        self.__dict__.update(copy.deepcopy(values))
        self.database, self.get_doc = database, get_doc
        self.flags = SimpleNamespace(for_update=True)
        self.meta = SimpleNamespace(get_valid_columns=lambda: list(database['A']), get_table_fields=lambda: [])

    def get(self, key, default=None):
        return getattr(self, key, default)

    def set(self, key, value):
        setattr(self, key, value)

    def is_new(self):
        return False

    def load_doc_before_save(self, *, raise_exception=False):
        self._doc_before_save = self.get_doc(self.doctype, self.name, for_update=True)

    def save(self, ignore_permissions=False):
        self.load_doc_before_save(raise_exception=True)
        if self._doc_before_save.modified != self.modified:
            raise ValueError('native version mismatch')
        self.before_hook(self)
        self.modified += '+'
        self.database[self.name] = {key: self.get(key) for key in self.meta.get_valid_columns()}
        self.after_hook(self)
        return self


class ManagedBatchStorage(unittest.TestCase):
    def setUp(self):
        self.rows = {name: {'doctype': 'SSM test', 'name': name, 'owner': 'person',
            'modified': 'v1', 'docstatus': 0, 'amount': 1, 'flag': False, 'note': None,
            'required': 'untouched', 'unique': name} for name in ('A', 'B')}
        self.reads, self.saves, self.seen_before = [], [], []
        self.before_hook = lambda doc: None
        self.after_hook = lambda doc: None
        self.controller = NativeDocument
        self.has_children = False
        def get_doc(doctype, name=None, **kwargs):
            if isinstance(doctype, dict):
                return self.controller(doctype, self.rows, get_doc)
            self.reads.append(name)
            doc = self.controller(self.rows[name], self.rows, get_doc)
            doc.flags.for_update = kwargs.get('for_update', False)
            doc.meta.get_table_fields = lambda: ['children'] if self.has_children else []
            doc.before_hook = self.before
            doc.after_hook = self.after
            return doc
        def get_value(doctype, filters, fieldname):
            for name, row in self.rows.items():
                if all((row.get(key) != value[1] if isinstance(value, list) and value[0] == '!='
                        else row.get(key) == value) for key, value in filters.items()):
                    return row.get(fieldname)
            return None
        self.frappe = SimpleNamespace(flags=SimpleNamespace(shangshu_action_pin={}),
            session=SimpleNamespace(user='person'), get_doc=get_doc,
            db=SimpleNamespace(get_value=get_value),
            ValidationError=ValueError, PermissionError=PermissionError, TimestampMismatchError=ValueError,
            throw=lambda message, error=ValueError: (_ for _ in ()).throw(error(message)))
        self.frappe.flags.shangshu_action_pin = {'action_id': 'platform.object.update_many'}
        fields = [{'id': key, 'label': key, 'type': 'text', 'deprecated': False}
                  for key in ('amount', 'flag', 'note', 'required', 'unique')]
        self.compiled = {'title': 'Test', 'fields': fields, 'unique_keys': [['unique']], 'doctype': {'name': 'SSM test',
            'fields': [{'fieldname': field['id']} for field in fields]}}
        self.model = SimpleNamespace(name='com.shangshu.app.test.object.test', active_revision=1, physical_doctype='SSM test')
        self.env = load_module_functions(RECORDS, {'write_records'}, stubs={'frappe': self.frappe})
        self.env.update(_load=lambda *a, **kw: (self.model, self.compiled, {'System Manager'}),
            _values=lambda doc, *a, **kw: {field['id']: doc.get(field['id']) for field in fields},
            _fields=lambda *a, **kw: fields, _apply=self.apply,
            _notify_managed_change=lambda *a, **kw: None, _own=lambda *a: False)
        from contextlib import nullcontext, contextmanager
        self.env['_writing'] = contextmanager(self.env['_writing'])
        from shangshu_core import managed_nulls
        for module, name, value in [(managed_changes, 'frappe', self.frappe),
                                   (managed_nulls, 'preserve_nulls', lambda *a: nullcontext()),
                                   (native_document, 'Document', NativeDocument)]:
            scoped = patch.object(module, name, value)
            scoped.start(); self.addCleanup(scoped.stop)
        # Helpers use the same real module across cases, with this test's DB boundary.
        storage = sys.modules.get('shangshu_core.managed_batch_storage')
        if storage is not None:
            scoped = patch.object(storage, 'frappe', self.frappe)
            scoped.start(); self.addCleanup(scoped.stop)
        scoped = patch.dict(sys.modules, {'frappe': self.frappe})
        scoped.start(); self.addCleanup(scoped.stop)

    def apply(self, doc, compiled, roles, values):
        for key, value in values.items():
            doc.set(key, value)
        if not doc.required:
            raise ValueError('full row required rule')

    def before(self, doc):
        self.seen_before.append({key: doc._doc_before_save.get(key) for key in self.rows[doc.name]})
        self.before_hook(doc)

    def after(self, doc):
        self.saves.append(doc)
        self.after_hook(doc)

    def write(self, records=None, version='1.1.0'):
        return self.env['write_records']('platform.object.update_many', {
            'object_id': self.model.name, 'expected_revision': 1,
            'records': records or [{'name': n, 'expected_modified': 'v1', 'values': {'amount': 2}}
                                  for n in ('A', 'B')]},
            {'confirmed': True, 'action_version': version, 'source': 'user'})

    def test_new_version_saves_each_row_with_one_locked_read_and_complete_before_image(self):
        result = self.write()
        self.assertEqual(result['written'], 2)
        self.assertEqual(self.reads, ['A', 'B'])
        self.assertEqual([doc.name for doc in self.saves], ['A', 'B'])
        self.assertIsNone(self.seen_before[0]['note'])
        self.assertIs(self.seen_before[0]['flag'], False)
        self.assertEqual(self.seen_before[0]['required'], 'untouched')
        self.assertTrue(all('load_doc_before_save' not in doc.__dict__ for doc in self.saves))

    def test_previous_hook_modification_of_later_row_is_read_fresh(self):
        self.after_hook = lambda doc: self.rows['B'].update(required='changed-by-A', note='hook') if doc.name == 'A' else None
        self.write()
        self.assertEqual(self.seen_before[1]['required'], 'changed-by-A')
        self.assertEqual(self.rows['B']['note'], 'hook')

    def test_unique_rule_observes_previous_row_write_and_rejects_second_row(self):
        with self.assertRaisesRegex(ValueError, '业务唯一键'):
            self.write([{'name': n, 'expected_modified': 'v1', 'values': {'unique': 'same'}} for n in ('A', 'B')])
        self.assertEqual([doc.name for doc in self.saves], ['A'])

    def test_changed_later_row_version_and_complete_untouched_rule_still_reject(self):
        self.after_hook = lambda doc: self.rows['B'].update(modified='new') if doc.name == 'A' else None
        with self.assertRaisesRegex(ValueError, '记录已被修改'):
            self.write()
        self.rows['B'].update(modified='v1', required='')
        with self.assertRaisesRegex(ValueError, 'full row required rule'):
            self.write([{'name': 'B', 'expected_modified': 'v1', 'values': {'amount': 9}}])

    def test_old_version_and_special_controller_keep_native_reads(self):
        self.write(version='1.0.0')
        self.assertEqual(self.reads, ['A', 'A', 'B', 'B'])
        self.reads.clear()
        class SpecialDocument(NativeDocument):
            pass
        self.controller = SpecialDocument
        self.write([{'name': 'A', 'expected_modified': 'v1+', 'values': {'amount': 3}}])
        self.assertEqual(self.reads, ['A', 'A'])

    def test_hook_reentrant_before_load_reads_native_state_and_restores_adapter(self):
        self.before_hook = lambda doc: doc.load_doc_before_save(raise_exception=True)
        self.write([{'name': 'A', 'expected_modified': 'v1', 'values': {'amount': 4}}])
        self.assertEqual(self.reads, ['A', 'A'], '只复用首轮校验，hook重入必须重读')
        self.assertNotIn('load_doc_before_save', self.saves[0].__dict__)

    def test_repeated_target_gets_latest_locked_before_image(self):
        self.write([{'name': 'A', 'expected_modified': 'v1', 'values': {'amount': 2}},
                    {'name': 'A', 'expected_modified': 'v1', 'values': {'amount': 3}}])
        self.assertEqual(self.reads, ['A', 'A'])
        self.assertEqual([row['amount'] for row in self.seen_before], [1, 2])
        self.assertEqual(self.rows['A']['amount'], 3)

    def test_child_table_keeps_complete_native_before_load(self):
        self.has_children = True
        self.write()
        self.assertEqual(self.reads, ['A', 'A', 'B', 'B'])


if __name__ == '__main__':
    unittest.main()
