import frappe
from frappe.tests.utils import FrappeTestCase
from unittest.mock import patch
from shangshu_core.public_api import execute_registered_action, query_dataset, get_object_record


class TestOrders(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        from shangshu_core.public_api import set_domain_enabled
        set_domain_enabled('com.shangshu.orders', True, '三域用例准备：启用订单依赖方')
        self.suffix = frappe.generate_hash(length=10)
        self.users = {}
        # Synthetic fixture creation only; the production limiter is restored
        # before any action or permission assertion runs.
        with patch('frappe.core.doctype.user.user.throttle_user_creation'):
            for key,role in [('staff','Desk User'),('other','Desk User'),('warehouse','Warehouse Manager'),
                             ('finance','Finance Approver'),('cashier','Cashier')]:
                user = key + self.suffix + '@example.invalid'
                frappe.get_doc({'doctype':'User','email':user,'first_name':key,'send_welcome_email':0,
                    'roles':[{'role':role}]}).insert(ignore_permissions=True)
                self.users[key] = user
                from shangshu_core.public_api import get_identity
                get_identity(user)  # Login provisions identity before an action request.
        self.fields = {'title':'设备配件','customer':'测试客户','sku':self.suffix,'quantity':4,'branch':'Stock'}

    def test_inflight_and_dependency_disable_prechecks_match(self):
        from shangshu_core.public_api import set_domain_enabled
        from shangshu_core.public_api.http import domains
        order = self.action('staff','orders.create',self.fields)
        self.action('staff','orders.submit',{'order':order['order'],'revision':order['revision']})
        frappe.set_user('Administrator')
        rows = {row['id']: row for row in domains(1)}
        self.assertTrue(any('订单尚在办理' in message for message in rows['com.shangshu.orders']['lifecycle']['disable_blockers']))
        with self.assertRaises(frappe.ValidationError):
            set_domain_enabled('com.shangshu.orders',False,'不能丢失在途订单')
        with self.assertRaises(frappe.ValidationError):
            set_domain_enabled('com.shangshu.warehouse',False,'订单仍然依赖库存')
        frappe.set_user(self.users['other'])
        with self.assertRaises(frappe.PermissionError):
            domains(1)
        from shangshu_core.public_api import platform_contributions
        self.assertNotIn(order['order'], [item['name'] for item in platform_contributions(True)['work_items']])
        frappe.set_user(self.users['warehouse'])
        work = platform_contributions(True)
        self.assertFalse(work['work_errors'])
        item = next(item for item in work['work_items'] if item['name'] == order['order'])
        self.assertEqual(item['dataset'], 'orders.order')
        self.assertTrue(item['application'])

    def test_undeclared_cross_domain_action_is_rejected(self):
        previous=getattr(frappe.flags,'shangshu_call_domain',None)
        try:
            frappe.flags.shangshu_call_domain='com.shangshu.finance'
            with self.assertRaisesRegex(frappe.PermissionError,'未声明跨域调用依赖'):
                execute_registered_action('orders.create',self.fields,confirmed=True,idempotency_key=self.suffix)
        finally:
            frappe.flags.shangshu_call_domain=previous

    def action(self, user, action, payload, key=None):
        frappe.db.commit()  # Prior requests/fixtures are durable before this action can roll back.
        frappe.set_user(self.users[user])
        return execute_registered_action(action,payload,confirmed=True,
            idempotency_key=key or frappe.generate_hash(length=24))['result']

    def test_stock_return_resubmit_and_atomic_issue(self):
        from shangshu_orders.shangshu_orders.doctype.shangshu_order.shangshu_order import ShangshuOrder
        self.action('warehouse','warehouse.receive',{'sku':self.suffix,'quantity':5,'source':self.suffix})
        order = self.action('staff','orders.create',self.fields)
        edit=next(a for a in get_object_record('orders.order',order['order'])['actions'] if a['id']=='orders.edit')
        self.assertNotIn('amount_cents',edit['values'])
        self.assertEqual(edit['hidden'],{'order':order['order'],'revision':1})
        self.assertEqual([a['id'] for a in query_dataset('orders.order')['actions']],['orders.create'])
        ref = {'order':order['order'],'revision':order['revision']}
        with self.assertRaises(frappe.PermissionError):
            self.action('other','orders.submit',ref)
        with self.assertRaises(frappe.PermissionError):
            get_object_record('orders.order',order['order'])
        pending = self.action('staff','orders.submit',ref)
        frappe.set_user(self.users['warehouse'])
        # Frappe 系统用户也有 Desk User；仓管可以新建自己的订单，但不能改别人的。
        self.assertIn('Desk User',frappe.get_roles())
        self.assertEqual([a['id'] for a in query_dataset('orders.order')['actions']],['orders.create'])
        with self.assertRaises(frappe.PermissionError):
            self.action('warehouse','orders.edit',{'order':order['order'],'revision':pending['revision'],**self.fields})
        returned = self.action('warehouse','orders.decide',{'order':order['order'],'revision':pending['revision'],
            'decision':'return','note':'调整数量'})
        edited = self.action('staff','orders.edit',{'order':order['order'],'revision':returned['revision'],**self.fields,'quantity':3})
        pending = self.action('staff','orders.submit',{'order':order['order'],'revision':edited['revision']})
        decision = {'order':order['order'],'revision':pending['revision'],'decision':'approve','note':'实物核验通过'}
        with self.assertRaises(frappe.PermissionError):
            self.action('staff','orders.decide',decision)
        with patch.object(ShangshuOrder,'save',side_effect=RuntimeError('订单保存失败')):
            with self.assertRaises(RuntimeError):
                self.action('warehouse','orders.decide',decision)
        self.assertEqual(query_dataset('warehouse.stock',{'sku':self.suffix})['rows'][0]['quantity'],5)
        self.assertEqual(frappe.db.count('Shangshu Stock Movement',{'source':'orders:'+order['order']}),0)
        issued = self.action('warehouse','orders.decide',decision,self.suffix+'-issue')
        self.assertEqual(self.action('warehouse','orders.decide',decision,self.suffix+'-issue'),issued)
        self.assertEqual(issued['status'],'Issued')
        self.assertEqual(query_dataset('warehouse.stock',{'sku':self.suffix})['rows'][0]['quantity'],2)
        other = self.action('staff','orders.create',self.fields)
        pending = self.action('staff','orders.submit',{'order':other['order'],'revision':1})
        with self.assertRaises(frappe.ValidationError):
            self.action('warehouse','orders.decide',{'order':other['order'],'revision':pending['revision'],'decision':'approve','note':'核验'})
        self.assertEqual(frappe.db.get_value('Shangshu Order',other['order'],'status'),'PendingWarehouse')

    def test_external_finance_results_are_read_not_copied(self):
        order = self.action('staff','orders.create',{**self.fields,'branch':'External','payee':'供应商','amount_cents':10000})
        submitted = self.action('staff','orders.submit',{'order':order['order'],'revision':1})
        request = submitted['funding_request']
        frappe.set_user(self.users['warehouse'])
        self.assertEqual(query_dataset('orders.order',{'name':order['order']})['total'],0)

        returned = self.action('finance','finance.funding.review',{'request':request,'revision':1,'decision':'return','note':'补充用途'})
        frappe.set_user(self.users['staff'])
        self.assertEqual(query_dataset('orders.order',{'name':order['order']})['rows'][0]['funding_status'],'Returned')
        updated = self.action('staff','finance.funding.resubmit',{'request':request,'revision':returned['revision'],
            'purpose':'维修配件','payee':'供应商','amount_cents':9000})
        approved = self.action('finance','finance.funding.review',{'request':request,'revision':updated['revision'],
            'decision':'approve','note':'通过'})
        self.action('cashier','finance.funding.pay',{'request':request,'revision':approved['revision'],'account':'基本户','receipt':self.suffix})
        frappe.set_user(self.users['staff'])
        row = query_dataset('orders.order',{'name':order['order']})['rows'][0]
        self.assertEqual(row['funding_status'],'Paid')
        self.assertEqual(frappe.db.get_value('Shangshu Order',order['order'],'status'),'PendingFinance')
        frappe.set_user(self.users['other'])
        self.assertEqual(query_dataset('orders.order',{'name':order['order']})['total'],0)

    def test_one_application_reuses_three_domains_and_disabled_dependencies_block(self):
        from shangshu_orders.install import create_workspace
        from shangshu_core.public_api import application_catalog, set_domain_enabled
        app=create_workspace(self.suffix)
        try:
            self.assertEqual(create_workspace(self.suffix)['id'],app['id'])
            frappe.set_user(self.users['staff'])
            catalog=next(a for a in application_catalog(include_resources=True) if a['id']==app['id'])
            ids={d['id'] for d in catalog['datasets']}
            self.assertIn('orders.order',ids)
            self.assertIn('finance.funding_request',ids)
            self.assertNotIn('warehouse.movement',ids)
            frappe.set_user('Administrator')
            with self.assertRaises(frappe.ValidationError):
                set_domain_enabled('com.shangshu.finance',0,'被组合应用引用不能停用')
        finally:
            # Only this test's unique application; preserve release history while
            # removing its active dependency from subsequent lifecycle tests.
            frappe.set_user('Administrator')
            from shangshu_core.public_api import set_application_enabled
            revision = frappe.db.get_value('Shangshu Application Definition', app['id'], 'draft_revision')
            if revision is not None:
                set_application_enabled(app['id'], False, '清理本用例组合应用', revision)
                frappe.db.commit()
