"""The real proposal capture hook calls the existing real package-rule validator.

Only metadata/permission/read boundaries are substituted; no copied value rules
or save path. Capture errors must precede proposal persistence in the core.
"""
import ast
import importlib.util
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class Invalid(Exception): pass
class Denied(Exception): pass
class Stale(Exception): pass


def load_functions(relative, names, context):
    path = ROOT / relative
    nodes = [node for node in ast.parse(path.read_text()).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in nodes} == set(names)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), context)


class ProposalValueRules(unittest.TestCase):
    def setUp(self):
        self.permission_calls = []
        self.package_calls = []
        self.read_checks = []
        self.columns = [
            {'header': '状态', 'field': 'state', 'promoted': True, 'type': 'text',
             'rules': {'options': ['待办', '办结'], 'allow_custom': False, 'required': True}},
            {'header': '金额', 'field': 'amount', 'promoted': True, 'type': 'number',
             'rules': {'required': True, 'min': 0}},
            {'header': '继续', 'field': 'continue', 'promoted': True, 'type': 'boolean',
             'rules': {'required': True}},
            {'header': '备注', 'promoted': False},
        ]
        self.meta = {'promotion': {'columns': self.columns}, 'structure_version': 1}
        def throw(message, error): raise error(message)
        self.frappe = SimpleNamespace(throw=throw, ValidationError=Invalid,
            PermissionError=Denied, TimestampMismatchError=Stale)
        def permission(doc, header, definition=None):
            self.permission_calls.append(header)
            if header == '禁止列': raise Denied('not writable')
        context = {'frappe': self.frappe, 'load_definition': lambda doc: self.meta['promotion'],
            'column_by_header': lambda definition, header: next((c for c in definition.get('columns', [])
                                                              if c['header'] == header), None),
            'require_fields_writable': permission}
        load_functions('frappe_apps/shangshu_files/shangshu_files/promotion.py',
            ['_reject', '_check_rules', '_check_value_domain', 'require_package_rules_ok'], context)
        real_package = context['require_package_rules_ok']
        def package(doc, items, definition=None):
            self.package_calls.append(deepcopy(items))
            return real_package(doc, items, definition)
        promotion = SimpleNamespace(_load_meta=lambda doc: self.meta,
            _definition_fingerprint=lambda meta: 'definition-sha', require_package_rules_ok=package)
        self.modules = patch.dict(sys.modules, {'shangshu_files.promotion': promotion})
        self.modules.start();self.addCleanup(self.modules.stop)
        # The production function imports from the real package. A package stub is
        # sufficient here; no persistent model/file API is provided to the hook.
        if 'shangshu_files' not in sys.modules:
            from types import ModuleType
            parent = ModuleType('shangshu_files');parent.promotion = promotion
            self.parent = patch.dict(sys.modules, {'shangshu_files': parent})
        else:
            self.parent = patch.object(sys.modules['shangshu_files'], 'promotion', promotion, create=True)
        self.parent.start();self.addCleanup(self.parent.stop)
        doc = SimpleNamespace(name='table-1', check_permission=lambda op: self.read_checks.append(op))
        self.frappe.get_doc = lambda *args, **kwargs: doc
        self.context = {'frappe': self.frappe, 'DOCTYPE': 'Shangshu File Center File'}
        load_functions('frappe_apps/shangshu_files/shangshu_files/service.py', ['proposal_snapshot'], self.context)
        self.payload = {'table': 'table-1', 'cells': []}

    def capture(self, cells, action='files.sheet_cells_write', purpose='capture', snapshot=None):
        payload = {**self.payload, 'cells': cells}
        if action != 'files.sheet_cells_write': payload = {'table': 'table-1', **cells[0]}
        return self.context['proposal_snapshot'](action, payload, purpose, snapshot)

    def cell(self, header, value, kind='text', row='r-000001'):
        return {'row_id': row, 'header': header, 'value': {'type': kind, 'value': value}}

    def test_fixed_choice_is_rejected_during_capture_before_any_proposal_can_be_created(self):
        with self.assertRaisesRegex(Invalid, '清单'):
            self.capture([self.cell('状态', '不是标准项')])
        self.assertEqual(len(self.package_calls), 1)

    def test_required_empty_is_rejected_and_typed_empty_cannot_smuggle_a_value(self):
        for value, kind in [(None, 'empty'), ('', 'text'), (False, 'empty')]:
            with self.subTest(value=value, kind=kind), self.assertRaisesRegex(Invalid, '不能为空'):
                self.capture([self.cell('状态', value, kind)])

    def test_false_and_zero_remain_values_while_ordinary_columns_stay_flexible(self):
        snapshot = self.capture([self.cell('金额', 0, 'number'), self.cell('继续', False, 'boolean'),
                                 self.cell('备注', None, 'empty')])
        self.assertEqual(snapshot['definition_sha'], 'definition-sha')
        self.assertEqual(self.package_calls[0], [
            {'header': '金额', 'value': 0}, {'header': '继续', 'value': False}, {'header': '备注', 'value': None}])

    def test_batch_checks_permissions_once_per_header_but_every_distinct_value(self):
        with self.assertRaisesRegex(Invalid, '不能小于'):
            self.capture([self.cell('金额', 1, 'number'), self.cell('金额', -1, 'number', row='r-000002')])
        self.assertEqual(self.permission_calls, ['金额'])
        self.assertEqual(len(self.package_calls), 1)

    def test_single_cell_aliases_share_the_same_capture_rule(self):
        for action in ['files.sheet_cell_write', 'files.cell_write']:
            with self.subTest(action=action), self.assertRaises(Invalid):
                self.capture([self.cell('金额', -1, 'number')], action=action)

    def test_other_proposals_and_inspection_do_not_repeat_or_expand_value_checks(self):
        self.capture([], action='files.sheet_cells_write')
        original = self.context['proposal_snapshot']('files.sheet_cells_write', self.payload, 'capture')
        self.package_calls.clear()
        self.context['proposal_snapshot']('files.sheet_cells_write', self.payload, 'inspect', original)
        self.context['proposal_snapshot']('files.sheet_cells_write', self.payload, 'validate', original)
        self.context['proposal_snapshot']('files.sheet_paste_apply', self.payload, 'capture')
        self.assertEqual(self.package_calls, [])


if __name__ == '__main__': unittest.main()
