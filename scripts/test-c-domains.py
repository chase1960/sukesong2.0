"""C 领域安装/回归：只能访问既有独立回归站，绝不接触验收站。"""
import json
import os
from pathlib import Path
import sys
import unittest

root = Path(sys.argv[1]).resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立回归目录')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('拒绝其他数据库')
repo = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repo / 'frappe_apps/shangshu_warehouse'))
sys.path.insert(0, str(repo / 'frappe_apps/shangshu_orders'))
os.chdir(root / 'sites')
import frappe
frappe.init(site='b-test.localhost')
frappe.connect()
frappe.set_user('Administrator')
try:
    if '--retire-workspace' in sys.argv:
        from shangshu_core.public_api import get_application_definition, set_application_enabled
        workspace_id=sys.argv[sys.argv.index('--retire-workspace')+1]
        workspace=get_application_definition(workspace_id)
        expected={'orders.order','warehouse.stock','warehouse.movement','finance.funding_request','finance.funding_transfer','com.shangshu.orders.create'}
        actual={b['resource_id'] for b in workspace['draft']['bindings']}
        if actual not in (expected, (expected-{'com.shangshu.orders.create'})|{'orders.create'}):
            raise SystemExit('拒绝收起非本链组合应用')
        set_application_enabled(workspace_id,False,'独立回归浏览器检查结束，保留定义及业务记录',workspace['draft_revision'])
        frappe.db.commit()
    if '--install' in sys.argv:
        from frappe.model.sync import sync_for
        sync_for('shangshu_finance', force=True, reset_permissions=True)
        from shangshu_finance.install import after_migrate as finance_migrate
        finance_migrate()
        from frappe.installer import install_app
        install_app('shangshu_warehouse')
        from shangshu_warehouse.install import after_migrate
        after_migrate()
        install_app('shangshu_orders')
        from shangshu_orders.install import setup as orders_setup
        orders_setup()
        frappe.db.commit()
    from shangshu_core.public_api import check_registered_manifests
    from shangshu_core.install import after_migrate as core_migrate
    core_migrate()
    frappe.db.commit()
    print(check_registered_manifests())
    # 旧财务单域契约用例要求没有已启用依赖方；三域依赖另在订单套件验证。
    from shangshu_core.public_api import set_domain_enabled
    set_domain_enabled('com.shangshu.orders', False, '单域兼容回归准备')
    frappe.db.commit()
    suite = unittest.defaultTestLoader.loadTestsFromNames([
        'shangshu_warehouse.tests.test_stock',
        'shangshu_core.tests.test_public_api',
        'shangshu_core.tests.test_runtime',
        'shangshu_core.tests.test_domains',
        'shangshu_core.tests.test_domain_execution',
        'shangshu_finance.tests.test_finance_chain',
        'shangshu_finance.tests.test_funding',
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        frappe.set_user('Administrator')
        set_domain_enabled('com.shangshu.orders', True, '三域回归准备')
        frappe.db.commit()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName('shangshu_orders.tests.test_orders'))
    if result.wasSuccessful():
        if '--workspace' in sys.argv:
            from shangshu_orders.install import create_workspace
            frappe.set_user('Administrator')
            workspace = create_workspace()
            frappe.db.commit()
            print('组合应用:', workspace['id'])
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from shangshu_core.public_api import execute_registered_action, query_object_records
        frappe.set_user('Administrator')
        suffix = frappe.generate_hash(length=12)
        sku = 'C-concurrent-' + suffix
        user = 'warehouse-' + suffix + '@example.invalid'
        frappe.get_doc({'doctype': 'User', 'email': user, 'first_name': '仓管并发回归',
            'send_welcome_email': 0, 'roles': [{'role': 'Warehouse Manager'}]}).insert(ignore_permissions=True)
        execute_registered_action('warehouse.receive', {'sku': sku, 'quantity': 10, 'source': sku + '-in'},
                                  confirmed=True, idempotency_key=sku + '-in')
        frappe.db.commit()
        barrier = Barrier(2)

        def withdraw(index):
            frappe.init(site='b-test.localhost')
            frappe.connect()
            frappe.set_user(user)
            try:
                barrier.wait(timeout=15)
                execute_registered_action('warehouse.issue', {'sku': sku, 'quantity': 7, 'source': sku + str(index)},
                                          confirmed=True, idempotency_key=sku + str(index))
                frappe.db.commit()
                return 'issued'
            except frappe.ValidationError as error:
                frappe.db.rollback()
                if '库存不足' not in str(error):
                    raise
                return 'insufficient'
            finally:
                frappe.destroy()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(withdraw, [1, 2]))
        frappe.db.rollback()
        assert sorted(outcomes) == ['insufficient', 'issued'], outcomes
        assert query_object_records('warehouse.stock', {'sku': sku})['rows'][0]['quantity'] == 3
        print('PASS: 两个真实仓管事务竞争扣库，成功一次、余额3、无负库存')
    raise SystemExit(not result.wasSuccessful())
finally:
    frappe.db.rollback()
    frappe.destroy()
