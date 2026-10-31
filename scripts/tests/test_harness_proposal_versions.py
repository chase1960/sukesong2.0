"""Run the real files review hook at its read/permission boundary, not a copied rule.

The core supplies the checked describe snapshot to prepare. These tests verify
that no second read rebases it and that legitimate partial-review state can
advance only through that checked snapshot.
"""
import importlib.util
import json
from copy import deepcopy
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class Stale(Exception):
    pass


class Invalid(Exception):
    pass


class Denied(Exception):
    pass


class FilesProposalVersions(unittest.TestCase):
    def setUp(self):
        self.reads = 0
        self.allowed = True
        self.raw = {
            'rows': [
                {'row_id': 'r-000001', 'record_version': 'row-before-1', 'values': {
                    '名称': {'type': 'text', 'value': '旧名称'},
                    '金额': {'type': 'number', 'value': 1}}},
                {'row_id': 'r-000002', 'record_version': 'row-before-2', 'values': {
                    '名称': {'type': 'text', 'value': '另一旧名称'},
                    '金额': {'type': 'number', 'value': 2}}},
            ], 'content_version': 9, 'structure_version': 3, 'writable': True,
        }
        self.payload = {'table': 'table-1', 'sheet': 'sheet-1',
            'expected_content_version': 9, 'expected_structure_version': 3,
            'expected_record_versions': {'r-000001': 'row-before-1', 'r-000002': 'row-before-2'},
            'cells': [
                {'row_id': 'r-000001', 'header': '名称', 'value': {'type': 'text', 'value': '新名称'}},
                {'row_id': 'r-000002', 'header': '金额', 'value': {'type': 'number', 'value': 3}},
            ]}
        def throw(message, error):
            raise error(message)
        def guard(*args):
            if not self.allowed:
                raise Denied('no write')
        def read(*args):
            self.reads += 1
            return deepcopy(self.raw)
        modules = {
            'frappe': SimpleNamespace(throw=throw, ValidationError=Invalid,
                PermissionError=Denied, TimestampMismatchError=Stale),
            'shangshu_files': ModuleType('shangshu_files'),
            'shangshu_files.service': SimpleNamespace(proposal_guard=guard),
            'shangshu_files.sheet': SimpleNamespace(read_payload=read),
            'shangshu_files.proposal_projection': SimpleNamespace(
                project=lambda _action, payload: {'payload': deepcopy(payload), 'redacted': False}),
        }
        self.modules = patch.dict(sys.modules, modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        path = ROOT / 'frappe_apps/shangshu_files/shangshu_files/proposal_review.py'
        spec = importlib.util.spec_from_file_location('harness_files_review_actual', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def describe(self, state=None):
        return self.module.review('files.sheet_cells_write', self.payload, state or {},
            {'operation': 'describe', 'purpose': 'resolve'}, 'actor')

    def prepare(self, snapshot, state=None, selected=None):
        return self.module.review('files.sheet_cells_write', self.payload, state or {},
            {'operation': 'prepare', 'purpose': 'resolve', 'snapshot': snapshot,
             'units': selected or [unit['unit_id'] for unit in snapshot['units']],
             'edited_value': {}, 'op_id': 'review-operation'}, 'actor')['payload']

    def partial(self, snapshot):
        one, two = snapshot['units']
        return {'sequence': 1, 'accepted': {one['unit_id']: {'value': one['value']}},
            'bound_target': {'module': 'excel', 'table': 'table-1'},
            'baselines': {two['unit_id']: deepcopy(two['current_value'])},
            'operations': {'first': {'units': [one['unit_id']]}}}

    def test_first_save_preserves_original_versions_and_scopes_record_cas_to_selected_rows(self):
        snapshot = self.describe()
        selected = [snapshot['units'][1]['unit_id']]
        prepared = self.prepare(snapshot, selected=selected)
        self.assertEqual(prepared['expected_content_version'], 9)
        self.assertEqual(prepared['expected_structure_version'], 3)
        self.assertEqual(prepared['expected_record_versions'], {'r-000002': 'row-before-2'})
        self.assertEqual(len(prepared['cells']), 1)
        self.assertEqual(self.reads, 1, 'prepare must reuse the core-checked snapshot')

    def test_prepare_never_rereads_or_replaces_the_core_checked_snapshot(self):
        snapshot = self.describe()
        self.raw['content_version'] = 10
        self.raw['rows'][0]['record_version'] = 'other-writer'
        prepared = self.prepare(snapshot)
        self.assertEqual(prepared['expected_content_version'], 9)
        self.assertEqual(prepared['expected_record_versions']['r-000001'], 'row-before-1')
        self.assertEqual(self.reads, 1)

    def test_selection_order_does_not_reorder_the_original_registered_write(self):
        snapshot = self.describe()
        prepared = self.prepare(snapshot, selected=[unit['unit_id'] for unit in reversed(snapshot['units'])])
        self.assertEqual(prepared['cells'], self.payload['cells'])

    def test_record_cas_participates_in_the_review_revision_version(self):
        before = self.describe()['version']
        self.raw['rows'][0]['record_version'] = 'row-changed'
        after = self.describe()['version']
        self.assertNotEqual(before, after)
        self.assertEqual(before['record_versions']['r-000001'], 'row-before-1')
        self.assertFalse(self.describe()['initial_version_matches'])

    def test_original_record_cas_mismatch_is_rejected_even_when_content_version_did_not_change(self):
        self.raw['rows'][0]['record_version'] = 'row-changed'
        with self.assertRaises(Stale):
            self.prepare(self.describe())

    def test_rejection_or_staging_does_not_authorize_rebasing_the_first_save(self):
        self.raw['content_version'] = 10
        snapshot = self.describe()
        for state in [ {'sequence': 1, 'rejected': {'x': {}}},
                       {'sequence': 1, 'staged': {'x': {}}} ]:
            with self.subTest(state=state), self.assertRaises(Stale):
                self.prepare(snapshot, state=state)

    def test_legitimate_partial_save_uses_checked_core_baseline_for_remaining_units(self):
        initial = self.describe()
        state = self.partial(initial)
        self.raw['content_version'] = 10
        self.raw['rows'][1]['record_version'] = 'row-after-first-partial'
        checked = self.describe(state)
        prepared = self.prepare(checked, state, [checked['units'][1]['unit_id']])
        self.assertEqual(prepared['expected_content_version'], 10)
        self.assertEqual(prepared['expected_record_versions'], {'r-000002': 'row-after-first-partial'})
        self.assertEqual(self.reads, 2)

    def test_partial_state_without_core_target_or_baseline_is_not_guessed(self):
        checked = self.describe()
        state = self.partial(checked)
        uid = checked['units'][1]['unit_id']
        for key in ['bound_target', 'baselines', 'operations']:
            invalid = deepcopy(state)
            invalid.pop(key)
            with self.subTest(key=key), self.assertRaises(Stale):
                self.prepare(checked, invalid, [uid])

    def test_partial_changed_pending_value_is_not_rebased(self):
        initial = self.describe()
        state = self.partial(initial)
        self.raw['content_version'] = 10
        self.raw['rows'][1]['values']['金额'] = {'type': 'number', 'value': 999}
        checked = self.describe(state)
        with self.assertRaises(Stale):
            self.prepare(checked, state, [checked['units'][1]['unit_id']])

    def test_partial_snapshot_race_keeps_the_checked_version_for_actual_write_to_reject(self):
        initial = self.describe()
        state = self.partial(initial)
        self.raw['content_version'] = 10
        checked = self.describe(state)
        self.raw['content_version'] = 11
        self.raw['rows'][1]['record_version'] = 'raced-writer'
        prepared = self.prepare(checked, state, [checked['units'][1]['unit_id']])
        self.assertEqual(prepared['expected_content_version'], 10)
        self.assertEqual(prepared['expected_record_versions'], {'r-000002': 'row-before-2'})
        self.assertEqual(self.reads, 2)

    def test_untrusted_or_missing_checked_snapshot_is_rejected(self):
        checked = self.describe()
        for snapshot in [None, {}, {**checked, 'target': {'module': 'excel', 'table': 'other'}}]:
            with self.subTest(snapshot=snapshot), self.assertRaises(Invalid):
                self.module.review('files.sheet_cells_write', self.payload, {},
                    {'operation': 'prepare', 'purpose': 'resolve', 'snapshot': snapshot,
                     'units': [checked['units'][0]['unit_id']], 'edited_value': {}, 'op_id': 'op'}, 'actor')

    def test_permission_is_still_checked_before_using_a_snapshot(self):
        checked = self.describe()
        self.allowed = False
        with self.assertRaises(Denied):
            self.prepare(checked)

    def test_single_cell_review_preserves_the_original_record_version(self):
        single = {**self.payload, **self.payload['cells'][0], 'expected_record_version': 'row-before-1'}
        single.pop('cells')
        single.pop('expected_record_versions')
        describe = self.module.review('files.sheet_cell_write', single, {},
            {'operation': 'describe', 'purpose': 'resolve'}, 'actor')
        prepared = self.module.review('files.sheet_cell_write', single, {},
            {'operation': 'prepare', 'purpose': 'resolve', 'snapshot': describe,
             'units': [describe['units'][0]['unit_id']], 'edited_value': {}, 'op_id': 'op'}, 'actor')['payload']
        self.assertEqual(prepared['expected_record_version'], 'row-before-1')
        self.assertNotIn('expected_record_versions', prepared)


if __name__ == '__main__':
    unittest.main()
