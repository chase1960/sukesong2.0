"""真实 Frappe Document.save 的锁内前像复用；仅临时业务 hook/读次数探针。"""
from contextlib import nullcontext
from unittest.mock import patch

import frappe
from frappe.model.document import Document
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records, managed_batch_storage
from shangshu_core.actions import execute_registered_action
from shangshu_core.tests import test_promotion_records as fixtures


class TestManagedBatchStorage(FrappeTestCase):
    def setUp(self):
        fixtures.TestPromotionRecords.setUp(self)

    def tearDown(self):
        frappe.set_user('Administrator')
        self._cleanup()
        super().tearDown()

    def _cleanup(self):
        fixtures.TestPromotionRecords._cleanup(self)

    def _provision(self, **kwargs):
        return fixtures.TestPromotionRecords._provision(self, **kwargs)

    def fixture(self):
        columns = [
            {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number'},
            {'header': '标记', 'promoted': True, 'field': 'flag', 'type': 'boolean'},
            {'header': '备注', 'promoted': True, 'field': 'note', 'type': 'text', 'rules': {'required': True}},
        ]
        result = self._provision(columns=columns, rows=[{'row_id': name, 'values': {
            'amount': 7, 'flag': False, 'note': 'untouched'}} for name in ('row-A', 'row-B')])
        model = frappe.get_doc(model_records.MODEL, result['object_id'])
        compiled = model_records.compiled_definition(model.name)
        columns = {f['id']: c['fieldname'] for f, c in zip(compiled['fields'], compiled['doctype']['fields'])}
        names = [result['records']['row-A'], result['records']['row-B']]
        frappe.db.commit()
        return model, columns, names

    def payload(self, model, names, values):
        return {'object_id': model.name, 'expected_revision': model.active_revision,
            'records': [{'name': name, 'expected_modified': str(frappe.db.get_value(model.physical_doctype, name, 'modified')),
                         'values': dict(values)} for name in names]}

    def execute(self, payload, suffix, version='1.1.0'):
        return execute_registered_action('platform.object.update_many', payload, confirmed=True,
            idempotency_key=self.key + ':' + suffix, action_version=version)

    def test_native_save_keeps_hook_order_complete_before_image_and_halves_target_loads(self):
        model, columns, names = self.fixture()
        original_get_doc, original_run_method = frappe.get_doc, Document.run_method
        target_loads, before_images = [], []

        def counted(*args, **kwargs):
            if len(args) > 1 and args[0] == model.physical_doctype and args[1] in names:
                target_loads.append(args[1])
            return original_get_doc(*args, **kwargs)

        def hook(doc, method, *args, **kwargs):
            result = original_run_method(doc, method, *args, **kwargs)
            if doc.doctype == model.physical_doctype and doc.name in names:
                if method == 'before_save':
                    previous = doc.get_doc_before_save()
                    before_images.append((doc.name, previous.get(columns['note']), previous.get(columns['flag'])))
                if method == 'on_update' and doc.name == names[0]:
                    # A hook may change a later row without changing modified.
                    frappe.db.set_value(model.physical_doctype, names[1], columns['note'], 'from-first-hook', update_modified=False)
            return result

        baseline = self.payload(model, names, {'amount': 8})
        # 新请求继续走 1.1；仅关闭此处优化建立原生 save 的读取基准，不放宽旧版入口。
        with patch.object(frappe, 'get_doc', counted), \
                patch.object(managed_batch_storage, 'locked_before_doc', lambda *a: nullcontext()):
            self.execute(baseline, 'native-baseline')
        self.assertEqual(target_loads, [names[0], names[0], names[1], names[1]])
        target_loads.clear()
        new = self.payload(model, names, {'amount': None, 'flag': False})
        with patch.object(frappe, 'get_doc', counted), patch.object(Document, 'run_method', hook):
            self.execute(new, 'new')
        self.assertEqual(target_loads, names)
        self.assertEqual(before_images[0][1], 'untouched')
        self.assertEqual(before_images[1][1], 'from-first-hook')
        for name in names:
            row = frappe.db.get_value(model.physical_doctype, name, [columns['amount'], columns['flag']], as_dict=True)
            self.assertIsNone(row[columns['amount']])
            self.assertEqual(row[columns['flag']], 0)
        self.assertEqual(frappe.db.get_value(model.physical_doctype, names[1], columns['note']), 'from-first-hook')

    def test_later_native_hook_sees_first_write_and_failure_rolls_entire_batch_back(self):
        model, columns, names = self.fixture()
        original = Document.run_method
        observed = []
        def hook(doc, method, *args, **kwargs):
            result = original(doc, method, *args, **kwargs)
            if doc.doctype == model.physical_doctype and doc.name == names[1] and method == 'before_save':
                observed.append(frappe.db.get_value(model.physical_doctype, names[0], columns['amount']))
                frappe.throw('later native rule refused', frappe.ValidationError)
            return result
        with patch.object(Document, 'run_method', hook), self.assertRaisesRegex(frappe.ValidationError, 'later native rule refused'):
            self.execute(self.payload(model, names, {'amount': 99}), 'reject')
        self.assertEqual(observed, [99])
        self.assertEqual([frappe.db.get_value(model.physical_doctype, name, columns['amount']) for name in names], [7, 7])

    def test_later_row_timestamp_modified_by_hook_is_not_hidden_by_prefetch(self):
        model, columns, names = self.fixture()
        original = Document.run_method
        def hook(doc, method, *args, **kwargs):
            result = original(doc, method, *args, **kwargs)
            if doc.doctype == model.physical_doctype and doc.name == names[0] and method == 'on_update':
                frappe.db.set_value(model.physical_doctype, names[1], 'modified', '2030-01-01 00:00:00', update_modified=False)
            return result
        with patch.object(Document, 'run_method', hook), self.assertRaises(frappe.TimestampMismatchError):
            self.execute(self.payload(model, names, {'amount': 99}), 'version-reject')
        self.assertEqual([frappe.db.get_value(model.physical_doctype, name, columns['amount']) for name in names], [7, 7])
