import frappe
from unittest.mock import patch
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import execute_registered_action, get_object_record, query_object_records


class TestFunding(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        suffix = frappe.generate_hash(length=10)
        self.users = {}
        for key,role in [('staff','Desk User'), ('other','Desk User'), ('finance','Finance Approver'), ('cashier','Cashier')]:
            user = key + suffix + '@example.invalid'
            frappe.get_doc({'doctype':'User', 'email':user, 'first_name':key, 'send_welcome_email':0,
                            'roles':[{'role':role}]}).insert(ignore_permissions=True)
            self.users[key] = user
            from shangshu_core.public_api import get_identity
            get_identity(user)  # Login provisions identity before an action request.
        self.source = 'order-' + suffix

    def action(self, user, action, values, key=None):
        frappe.db.commit()  # Prior requests/fixtures are durable before this action can roll back.
        frappe.set_user(self.users[user])
        return execute_registered_action('finance.funding.' + action, values, confirmed=True,
                                         idempotency_key=key or frappe.generate_hash(length=24))['result']

    def test_return_resubmit_review_and_cashier_payment(self):
        from shangshu_core.public_api import platform_contributions
        def pending(user):
            frappe.set_user(self.users[user])
            result = platform_contributions(include_work=True)
            self.assertEqual(result['work_errors'], [])
            return {item['name'] for item in result['work_items']}
        initial = {'source':self.source, 'purpose':'外采配件', 'payee':'测试供应商', 'amount_cents':12000}
        request = self.action('staff','request',initial)
        frappe.set_user(self.users['finance'])
        self.assertIn('finance.funding.review', {item['id'] for item in get_object_record('finance.funding_request',request['request'])['actions']})
        self.assertIn(request['request'], pending('finance'))
        self.assertNotIn(request['request'], pending('other'))
        self.assertNotIn(request['request'], pending('cashier'))
        ref = {'request':request['request'], 'revision':request['revision']}
        with self.assertRaises(frappe.PermissionError):
            self.action('other','resubmit',{**ref,'purpose':'越权','payee':'越权','amount_cents':1})
        self.assertEqual(query_object_records('finance.funding_request')['total'], 0)
        with self.assertRaises(frappe.PermissionError):
            get_object_record('finance.funding_request',request['request'])
        with self.assertRaises(frappe.ValidationError):
            self.action('cashier','pay',{**ref,'account':'基本户','receipt':self.source})
        returned = self.action('finance','review',{**ref,'decision':'return','note':'补充采购用途'})
        frappe.set_user(self.users['finance'])
        self.assertNotIn('finance.funding.resubmit', {item['id'] for item in get_object_record('finance.funding_request',request['request'])['actions']})
        self.assertIn(request['request'], pending('staff'))
        self.assertNotIn(request['request'], pending('finance'))
        updated = self.action('staff','resubmit',{'request':request['request'],'revision':returned['revision'],
            'purpose':'设备维修配件','payee':'测试供应商','amount_cents':10000})
        approved = self.action('finance','review',{'request':request['request'],'revision':updated['revision'],
            'decision':'approve','note':'核验通过'})
        frappe.set_user(self.users['cashier'])
        self.assertIn('finance.funding.pay', {item['id'] for item in get_object_record('finance.funding_request',request['request'])['actions']})
        self.assertIn(request['request'], pending('cashier'))
        pay = {'request':request['request'],'revision':approved['revision'],'account':'基本户','receipt':self.source}
        with self.assertRaises(frappe.PermissionError):
            self.action('finance','pay',pay)
        key = self.source + '-paid'
        paid = self.action('cashier','pay',pay,key)
        self.assertEqual(self.action('cashier','pay',pay,key), paid)
        self.assertEqual(paid['status'],'Paid')
        self.assertNotIn(request['request'], pending('cashier'))
        with self.assertRaises(frappe.ValidationError):
            self.action('cashier','pay',{**pay,'revision':paid['revision']})
        self.assertEqual(frappe.db.count('Shangshu Funding Transfer',{'request':request['request']}),1)
        frappe.set_user(self.users['staff'])
        self.assertEqual(get_object_record('finance.funding_request',request['request'])['record']['status'],'Paid')
        transfer = frappe.get_doc('Shangshu Funding Transfer', paid['transfer'])
        self.assertEqual(transfer.amount_cents,10000)
        with self.assertRaises(frappe.PermissionError):
            transfer.save(ignore_permissions=True)

    def test_transfer_failure_rolls_back_and_application_scopes_do_not_expand(self):
        from shangshu_core.public_api import application_catalog
        from shangshu_finance.shangshu_finance.doctype.shangshu_funding_request.shangshu_funding_request import ShangshuFundingRequest
        request = self.action('staff','request',{'source':self.source,'purpose':'采购','payee':'供应商','amount_cents':100})
        ref = {'request':request['request'], 'revision':1}
        with self.assertRaises(frappe.DuplicateEntryError):
            self.action('staff','request',{'source':self.source,'purpose':'采购','payee':'供应商','amount_cents':200})
        approved = self.action('finance','review',{**ref,'decision':'approve','note':'通过'})
        with patch.object(ShangshuFundingRequest,'save',side_effect=RuntimeError('保存申请失败')):
            with self.assertRaises(RuntimeError):
                self.action('cashier','pay',{**ref,'revision':approved['revision'],'account':'基本户','receipt':self.source})
        self.assertEqual(frappe.db.count('Shangshu Funding Transfer',{'request':request['request']}),0)
        self.assertEqual(frappe.db.get_value('Shangshu Funding Request',request['request'],'status'),'Approved')
        frappe.set_user('Administrator')
        for _ in range(2):
            apps = {a['id']:a for a in application_catalog(include_resources=True)}
            expense = apps['com.shangshu.finance.expense_management']['resources']
            funding = apps['com.shangshu.finance.funding']['resources']
            self.assertEqual(len(expense['datasets']),5)
            self.assertFalse(any(a['id'].startswith('finance.funding.') for a in expense['actions']))
            self.assertEqual(len(funding['actions']),4)
            self.assertEqual(len(funding['datasets']),2)

    def test_admin_applicant_cannot_review_or_pay_own_funding_request(self):
        from shangshu_core.public_api import platform_contributions
        frappe.set_user('Administrator')
        user = frappe.get_doc('User', self.users['staff'])
        for role in ('System Manager', 'Finance Approver', 'Cashier'):
            user.append('roles', {'role': role})
        user.save(ignore_permissions=True)
        request = self.action('staff', 'request', {
            'source': self.source, 'purpose': '隔离测试采购', 'payee': '测试供应商', 'amount_cents': 100,
        })
        own_actions = {item['id'] for item in get_object_record('finance.funding_request', request['request'])['actions']}
        self.assertNotIn('finance.funding.review', own_actions, '申请人不应看到本人审批假入口')
        self.assertNotIn(request['request'], {item['name'] for item in platform_contributions(include_work=True)['work_items']})
        ref = {'request': request['request'], 'revision': request['revision']}
        with self.assertRaises(frappe.PermissionError):
            self.action('staff', 'review', {**ref, 'decision': 'approve', 'note': '本人审批'})
        self.assertEqual(frappe.db.get_value('Shangshu Funding Request', request['request'], 'status'), 'Pending')
        approved = self.action('finance', 'review', {**ref, 'decision': 'approve', 'note': '独立复核'})
        frappe.set_user(self.users['staff'])
        own_actions = {item['id'] for item in get_object_record('finance.funding_request', request['request'])['actions']}
        self.assertNotIn('finance.funding.pay', own_actions, '申请人不应看到本人拨款假入口')
        self.assertNotIn(request['request'], {item['name'] for item in platform_contributions(include_work=True)['work_items']})
        with self.assertRaises(frappe.PermissionError):
            self.action('staff', 'pay', {
                'request': request['request'], 'revision': approved['revision'],
                'account': '测试账户', 'receipt': self.source,
            })
        self.assertEqual(frappe.db.get_value('Shangshu Funding Request', request['request'], 'status'), 'Approved')
        self.assertEqual(frappe.db.count('Shangshu Funding Transfer', {'request': request['request']}), 0)
