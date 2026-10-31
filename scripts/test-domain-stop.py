"""仅独立回归站：真实连接验证停用等待、提交后拒绝及重启恢复。"""
import json
import os
from pathlib import Path
import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Event

root = Path(sys.argv[1]).resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非专用回归站')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_socket') != str(root / 'db.sock') or config.get('db_name') != 'shangshu_b_tests':
    raise SystemExit('拒绝其他数据库')
repo = Path(__file__).resolve().parent.parent
for app in ('shangshu_orders', 'shangshu_warehouse'):
    sys.path.insert(0, str(repo / 'frappe_apps' / app))
os.chdir(root / 'sites')
import frappe
from shangshu_core.public_api import domain_execution, set_domain_enabled, query_dataset, execute_registered_action

DOMAIN = 'com.shangshu.orders'
entered, release, stopping = Event(), Event(), Event()


def connect():
    frappe.init(site='b-test.localhost')
    frappe.connect()
    frappe.set_user('Administrator')


def executing(pending=False):
    connect()
    try:
        with domain_execution(DOMAIN):
            record = None
            if pending:
                record = execute_registered_action('orders.create', {'title':'并发停用阻断探针', 'customer':'隔离测试',
                    'sku':'stop-probe', 'quantity':1, 'branch':'Stock'}, confirmed=True,
                    idempotency_key=frappe.generate_hash(length=24))['result']
                execute_registered_action('orders.submit', {'order':record['order'], 'revision':record['revision']},
                    confirmed=True, idempotency_key=frappe.generate_hash(length=24))
            entered.set()
            if not release.wait(15):
                raise RuntimeError('主线程未释放执行事务')
        frappe.db.commit()
        return record['order'] if record else None
    finally:
        frappe.destroy()


def stop():
    connect()
    try:
        stopping.set()
        result = set_domain_enabled(DOMAIN, False, '真实并发停用回归', stop_mode='complete')
        frappe.db.commit()
        return result
    finally:
        frappe.destroy()


connect()
try:
    set_domain_enabled(DOMAIN, True, '并发回归准备')
    # 仅本专用回归库、固定探针标记；失败重跑也通过正常退回动作收尾，不删审计。
    for probe in frappe.get_all('Shangshu Order', filters={'title':'并发停用阻断探针', 'sku':'stop-probe', 'status':'PendingWarehouse'}, fields=['name','revision']):
        execute_registered_action('orders.decide', {'order':probe.name, 'revision':probe.revision, 'decision':'return', 'note':'隔离探针重跑收尾'},
            confirmed=True, idempotency_key=frappe.generate_hash(length=24))
    frappe.db.commit()
    with ThreadPoolExecutor(max_workers=2) as workers:
        running = workers.submit(executing)
        assert entered.wait(10), '执行线程没有进入'
        stopped = workers.submit(stop)
        assert stopping.wait(10)
        # 数据库连接实际竞争：停用必须超时等待而不是立即声称成功。
        from concurrent.futures import TimeoutError
        try:
            stopped.result(timeout=0.5)
            raise AssertionError('在途事务未结束却已停用')
        except TimeoutError:
            pass
        # 另一领域仍能获取执行屏障，不受该域停用等待影响。
        with domain_execution('com.shangshu.warehouse'):
            assert frappe.db.count('Shangshu Stock Item') >= 0
        frappe.db.commit()
        release.set()
        running.result(timeout=10)
        assert stopped.result(timeout=10)['execution_stopped'] is True
    for continuation in (False, True):
        try:
            with domain_execution(DOMAIN, allow_disabled=continuation):
                raise AssertionError('完整停用后仍执行')
        except frappe.PermissionError:
            pass
    try:
        query_dataset('orders.order')
        raise AssertionError('完整停用后仍查询业务数据')
    except frappe.PermissionError:
        pass
    frappe.db.rollback()
    set_domain_enabled(DOMAIN, True, '并发回归恢复')
    frappe.db.commit()
    assert isinstance(query_dataset('orders.order'), dict)
    frappe.db.rollback()
    entered.clear(); release.clear(); stopping.clear()
    with ThreadPoolExecutor(max_workers=2) as workers:
        running = workers.submit(executing, True)
        if not entered.wait(10):
            running.result(timeout=1)
            raise AssertionError('新订单事务未进入')
        stopped = workers.submit(stop)
        assert stopping.wait(10)
        try:
            stopped.result(timeout=0.5)
            raise AssertionError('未等到事务提交')
        except TimeoutError:
            pass
        release.set()
        record = running.result(timeout=10)
        try:
            stopped.result(timeout=10)
            raise AssertionError('漏掉刚提交的在途业务')
        except frappe.ValidationError as error:
            assert '订单尚在办理' in str(error), str(error)
    frappe.db.rollback()
    assert frappe.db.get_value('Shangshu Domain', DOMAIN, 'enabled')
    revision = frappe.db.get_value('Shangshu Order', record, 'revision')
    execute_registered_action('orders.decide', {'order':record, 'revision':revision, 'decision':'return', 'note':'隔离回归结束'},
        confirmed=True, idempotency_key=frappe.generate_hash(length=24))
    frappe.db.commit()
    print('PASS: 在途等待、其他域可用、提交后全停、旧续办不能绕过、数据查询拒绝、再启用恢复、刚提交在途订单阻止停用')
finally:
    release.set()
    frappe.db.rollback()
    frappe.destroy()
