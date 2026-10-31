import unittest
from unittest.mock import patch

from shangshu_finance.domain import workbench_cards


class WorkbenchPermissionTests(unittest.TestCase):
    def test_funding_list_exposes_existing_request_action_only(self):
        from shangshu_finance.funding import contributions
        datasets = {row['id']: row for row in contributions()['datasets']}
        self.assertEqual(datasets['finance.funding_request'].get('collection_actions'), ['finance.funding.request'])
        self.assertFalse(datasets['finance.funding_transfer'].get('collection_actions'))

    def test_unreadable_metrics_are_not_queried_or_faked_as_zero(self):
        with patch('frappe.has_permission', side_effect=lambda dt, **kw: dt == 'Shangshu Expense Claim'), patch('shangshu_finance.domain._visible', return_value=[]) as query:
            cards = workbench_cards()
        self.assertEqual([c['id'] for c in cards], ['finance.pending_claims'])
        self.assertEqual([c.args[0] for c in query.call_args_list], ['Shangshu Expense Claim'])

    def test_authorized_empty_metrics_remain_zero(self):
        with patch('frappe.has_permission', return_value=True), patch('shangshu_finance.domain._visible', return_value=[]):
            self.assertEqual(len(workbench_cards()), 3)

    def test_query_errors_are_not_swallowed(self):
        with patch('frappe.has_permission', return_value=True), patch('shangshu_finance.domain._visible', side_effect=RuntimeError('database unavailable')):
            with self.assertRaises(RuntimeError):
                workbench_cards()
