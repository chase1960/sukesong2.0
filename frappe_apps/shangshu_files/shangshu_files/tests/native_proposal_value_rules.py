"""Owned-isolation negative case: invalid promoted value creates no proposal/write.

Use an existing synthetic promoted table, row and a deliberately invalid value.
This probe does not create models, upload content or commit any transaction.
"""
import hashlib
from pathlib import Path
import uuid
from unittest.mock import patch

import frappe
from shangshu_core.public_api import invoke_domain_service, propose_registered_action


SITE = 'example-perf-20261029.localhost'


def run(table, row_id, header, invalid_value='__not_an_allowed_option__'):
    if str(frappe.local.site) != SITE:
        raise AssertionError('Only the owned isolated site may run this probe')
    key = 'harness-invalid-proposal-' + uuid.uuid4().hex
    def read():
        result = invoke_domain_service('files.row_read', {
            'table': table, 'row_id': row_id, 'headers': [header]})
        return {name: result.get(name) for name in (
            'cells', 'record_version', 'content_version', 'structure_version')}
    try:
        before = read()
        current = frappe.get_doc('Shangshu File Center File', table)
        file_before = (current.current_file, current.current_sha256)
        kind = ('empty' if invalid_value is None else 'boolean' if isinstance(invalid_value, bool)
                else 'number' if isinstance(invalid_value, (int, float)) else 'text')
        payload = {'table': table, 'expected_content_version': before['content_version'],
            'expected_structure_version': before['structure_version'],
            'cells': [{'row_id': row_id, 'header': header,
                       'value': {'type': kind, 'value': invalid_value}}]}
        if before['record_version']:
            payload['expected_record_versions'] = {row_id: before['record_version']}
        with patch.object(frappe.db, 'commit', side_effect=AssertionError('probe forbids commit')):
            try:
                propose_registered_action('files.sheet_cells_write', payload, idempotency_key=key)
            except frappe.ValidationError as error:
                reason = str(error)
            else:
                raise AssertionError('The invalid test value produced a confirmation card')
            if frappe.db.exists('Shangshu Action Proposal', {'idempotency_key': key}):
                raise AssertionError('An invalid candidate persisted a proposal')
            if read() != before:
                raise AssertionError('An invalid proposal changed values or versions')
            after = frappe.get_doc('Shangshu File Center File', table)
            if (after.current_file, after.current_sha256) != file_before:
                raise AssertionError('An invalid proposal changed file bytes')
        from shangshu_files import service
        return {'site': SITE, 'proposal_created': False, 'values_and_versions_unchanged': True,
            'file_unchanged': True, 'error': reason,
            'source_sha256': hashlib.sha256(Path(service.__file__).read_bytes()).hexdigest(),
            'scope': 'Existing synthetic target; real public proposal capture rejects invalid input; no DDL/upload/commit',
            'rolled_back': True}
    finally:
        frappe.db.rollback()
