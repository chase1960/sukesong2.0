"""Owned-isolation recovery probe using one existing synthetic table proposal.

Recovery is pure read. The probe additionally creates one oversized candidate
through the public proposal API as a negative fixture, then rolls it back.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
import uuid

import frappe
from shangshu_core.public_api import invoke_domain_service, propose_registered_action

SITE = 'example-perf-20261029.localhost'


def run(proposal_id, other_user=None):
    if str(frappe.local.site) != SITE:
        raise AssertionError('Only the owned isolated site may run this probe')
    user = frappe.session.user
    checks = []
    try:
        original = frappe.get_doc('Shangshu Action Proposal', proposal_id)
        raw = original.payload_json
        expected = json.loads(raw)
        before = (raw, str(original.modified), original.status)
        with patch.object(frappe.db, 'commit', side_effect=AssertionError('recovery probe forbids commit')):
            result = invoke_domain_service('platform.action_proposal.values', {'proposal_id': proposal_id})
            if (set(result) != {'id', 'capability', 'payload'} or result['id'] != proposal_id
                    or result['capability'] != original.action_id or result['payload'] != expected):
                raise AssertionError('Recovery changed the original stored delta or its versions')
            current = frappe.get_doc('Shangshu Action Proposal', proposal_id)
            if (current.payload_json, str(current.modified), current.status) != before:
                raise AssertionError('The read-only recovery modified the proposal')
            checks.append('Original delta/versions restored through registered service; proposal unchanged')
            frappe.set_user(other_user or 'Guest')
            try:
                try:
                    invoke_domain_service('platform.action_proposal.values', {'proposal_id': proposal_id})
                except (frappe.PermissionError, frappe.AuthenticationError):
                    checks.append('Unauthorized current identity denied')
                else:
                    raise AssertionError('Unauthorized identity recovered a private proposal')
            finally:
                frappe.set_user(user)
            large = deepcopy(expected)
            if original.action_id == 'platform.object.update_many':
                values = large['records'][0]['values']
                values[next(iter(values))] = '汉' * 400000
            elif original.action_id == 'platform.object.companion_write':
                large['cells'][0]['value'] = {'type': 'text', 'value': '汉' * 400000}
            else:
                raise AssertionError('The fixture action is not a supported table value proposal')
            oversized = propose_registered_action(original.action_id, large,
                idempotency_key='recovery-budget-' + uuid.uuid4().hex)['id']
            try:
                invoke_domain_service('platform.action_proposal.values', {'proposal_id': oversized})
            except frappe.ValidationError as error:
                if '1MiB' not in str(error):
                    raise
                checks.append('Over-1MiB UTF8 stored delta explicitly rejected')
            else:
                raise AssertionError('An oversized delta was returned')
        from shangshu_core import proposal_values
        return {'site': SITE, 'checks': checks, 'rolled_back': True,
            'source_sha256': hashlib.sha256(Path(proposal_values.__file__).read_bytes()).hexdigest(),
            'scope': 'Existing synthetic proposal; real recovery and denied identity; one oversized proposal fixture rolled back, no business writes/DDL/uploads'}
    finally:
        frappe.set_user(user)
        frappe.db.rollback()
