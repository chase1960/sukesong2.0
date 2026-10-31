"""财务人工/Agent同一动作面的最小契约回归，不操作业务库。"""
import unittest
import json
from pathlib import Path
from unittest.mock import patch

from shangshu_finance.domain import get_contribution
from shangshu_finance.public_handlers import execute_action


class TestAgentContract(unittest.TestCase):
    def test_domain_release_version_is_consistent(self):
        from shangshu_finance import __version__
        import re
        root=Path(__file__).parents[2]
        manifest_version=re.search(r'^version: (.+)$',(root/'shangshu-plugin.yml').read_text(),re.M).group(1)
        package_version=re.search(r'^version = "(.+)"$',(root/'pyproject.toml').read_text(),re.M).group(1)
        self.assertEqual({__version__,manifest_version,package_version,get_contribution()['version']},{'0.3.1'})

    def test_invoice_projection_does_not_query_nonexistent_columns(self):
        from shangshu_finance.domain import DATASET_SPECS
        source=Path(__file__).parents[1]/'shangshu_finance/doctype/shangshu_finance_invoice/shangshu_finance_invoice.json'
        actual={row['fieldname'] for row in json.loads(source.read_text())['fields']}|{'name','owner','creation','modified'}
        invoice=next(item for item in get_contribution()['objects'] if item['id']=='finance.invoice')
        self.assertTrue({field['id'] for field in invoice['fields']}.issubset(actual))
        self.assertTrue(set(DATASET_SPECS['finance.invoice'][1]).issubset(actual))

    def test_invoice_read_exposes_confirmable_fields_and_revision(self):
        invoice=next(item for item in get_contribution()['objects'] if item['id']=='finance.invoice')
        fields={field['id'] for field in invoice['fields']}
        self.assertTrue({'name','record_version','invoice_date','seller_tax_id','tax_amount'}.issubset(fields))

    def test_claim_read_services_explicitly_declare_read_only_contract(self):
        services={item['id']:item for item in get_contribution()['services']}
        for name in ('finance.claim.list','finance.claim.get','finance.claim.reconcile'):
            with self.subTest(service=name):
                self.assertEqual(services[name].get('effect'),'read')
                self.assertIn(services[name].get('purpose'),('detail','directory'))
                self.assertEqual(services[name]['input_schema']['additionalProperties'],False)

    def test_published_manager_return_enum_reaches_manager_transition(self):
        with patch('shangshu_finance.public_handlers.apply_claim_action') as call:
            execute_action('finance.expense.manager_decide',{'claim':'fixture','action':'return','note':'请补票据'},
                           {'confirmed':True,'idempotency_key':'fixture'})
            self.assertEqual(call.call_args.args[1],'manager_return')

    def test_published_finance_return_enum_reaches_finance_transition(self):
        with patch('shangshu_finance.public_handlers.apply_claim_action') as call:
            execute_action('finance.expense.finance_review',{'claim':'fixture','action':'return','note':'核对金额'},
                           {'confirmed':True,'idempotency_key':'fixture'})
            self.assertEqual(call.call_args.args[1],'finance_return')

    def test_approve_and_resubmit_keep_existing_transition(self):
        for action,value in [('finance.expense.manager_decide','manager_approve'),
                             ('finance.expense.finance_review','finance_approve'),
                             ('finance.expense.submit','resubmit')]:
            with patch('shangshu_finance.public_handlers.apply_claim_action') as call:
                execute_action(action,{'claim':'fixture','action':value},{'confirmed':True,'idempotency_key':'fixture'})
                self.assertEqual(call.call_args.args[1],value)
