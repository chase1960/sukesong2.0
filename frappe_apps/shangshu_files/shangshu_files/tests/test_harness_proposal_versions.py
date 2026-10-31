"""Isolated-site public API regression for original-read versions and partial review.

Creates only ordinary XLSX test tables through registered actions. No schema
migration, customer input, OCR or mail. Run only on an isolated test site.
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (
    accept_action_proposal_units, execute_registered_action,
    get_action_proposal_review, invoke_domain_service,
    propose_registered_action, resolve_action_proposal,
)
from shangshu_core.public_api.http import action_proposal_reject_units


class TestHarnessProposalVersions(FrappeTestCase):
    def setUp(self):
        if frappe.local.site != 'example-perf-20261029.localhost':
            self.skipTest('Only the owned isolated site may run this regression')
        self.previous_user = frappe.session.user
        frappe.set_user('Administrator')
        self.token = uuid.uuid4().hex
        self.table = self.action('files.create', {
            'file_name': 'Harness版本-' + self.token, 'headers': ['名称', '备注'],
            'attribution': {'level': 'personal'},
        })['file']
        self.action('files.sheet_row_append', {**self.pin(), 'count': 2})
        self.rows = [row['row_id'] for row in self.read()['rows'][:2]]
        self.payload = {**self.pin(), 'cells': [
            {'row_id': rid, 'header': '名称', 'value': {'type': 'text', 'value': '候选-' + str(index)}}
            for index, rid in enumerate(self.rows)]}

    def tearDown(self):
        frappe.db.rollback()
        frappe.set_user(getattr(self, 'previous_user', 'Administrator'))
        super().tearDown()

    def action(self, action, payload):
        return execute_registered_action(action, payload, confirmed=True,
            idempotency_key='harness-review-' + uuid.uuid4().hex)['result']

    def read(self):
        return invoke_domain_service('files.sheet_read', {'table': self.table})

    def pin(self):
        read = self.read()
        return {'table': self.table, 'expected_content_version': read['content_version'],
                'expected_structure_version': read['structure_version']}

    def proposal(self):
        return propose_registered_action('files.sheet_cells_write', self.payload,
            idempotency_key='harness-proposal-' + uuid.uuid4().hex)['id']

    def test_partial_save_replay_and_remaining_keep_the_existing_review_flow(self):
        proposal = self.proposal()
        initial = get_action_proposal_review(proposal)
        unit = initial['units'][0]['unit_id']
        first = accept_action_proposal_units(proposal, 'first', initial['review_revision'], [unit], {})
        self.assertEqual(first['accepted_count'], 1)
        self.assertEqual(first['remaining'], 1)
        version = self.read()['content_version']
        replay = accept_action_proposal_units(proposal, 'first', initial['review_revision'], [unit], {})
        self.assertTrue(replay['idempotent'])
        self.assertEqual(self.read()['content_version'], version)
        result = resolve_action_proposal(proposal, 'confirmed')
        self.assertEqual(result['status'], 'confirmed')
        values = {row['row_id']: row['values']['名称']['value'] for row in self.read()['rows']}
        self.assertEqual([values[rid] for rid in self.rows], ['候选-0', '候选-1'])

    def test_rejected_unit_does_not_allow_first_write_to_rebase_onto_new_content(self):
        proposal = self.proposal()
        review = get_action_proposal_review(proposal)
        action_proposal_reject_units(proposal, 'reject-one', review['review_revision'],
                                    [review['units'][0]['unit_id']])
        self.action('files.sheet_cells_write', {**self.pin(), 'cells': [{
            'row_id': self.rows[1], 'header': '名称',
            'value': {'type': 'text', 'value': '人工后续修改'}}]})
        before = self.read()
        current = get_action_proposal_review(proposal)
        with self.assertRaises(frappe.TimestampMismatchError):
            accept_action_proposal_units(proposal, 'first-save', current['review_revision'],
                                         [review['units'][1]['unit_id']], {})
        after = self.read()
        self.assertEqual(after['content_version'], before['content_version'])
        self.assertEqual(after['rows'], before['rows'])

    def test_a_supplied_original_record_version_cannot_be_dropped_by_confirmation(self):
        # An explicit CAS without a matching read version is unverifiable. The
        # ordinary test table deliberately has no managed-row version: confirmation
        # must reject rather than discard that CAS and write anyway.
        self.payload['expected_record_versions'] = {self.rows[0]: 'unverified-original-version'}
        proposal = self.proposal()
        before = self.read()
        review = get_action_proposal_review(proposal)
        self.assertFalse(review['can_accept'])
        with self.assertRaises(frappe.TimestampMismatchError):
            accept_action_proposal_units(proposal, 'bad-record-cas', review['review_revision'], None, {})
        after = self.read()
        self.assertEqual(after['content_version'], before['content_version'])
        self.assertEqual(after['rows'], before['rows'])
