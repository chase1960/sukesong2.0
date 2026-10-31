"""本轮独立实库验收入口；只允许临时测试根，不触及员工站点。"""
import getpass
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[1]
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.'):
    raise SystemExit('仅允许明确的临时回归根目录')
apps = ['shangshu_core','shangshu_files','shangshu_mail','shangshu_finance','shangshu_orders','shangshu_warehouse']
for app in apps:
    sys.path.insert(0, str(repo/'frappe_apps'/app))
    (root/'apps').mkdir(exist_ok=True)
    target = root/'apps'/app
    if not target.exists():target.symlink_to(repo/'frappe_apps'/app, target_is_directory=True)
if not (root/'apps/frappe').exists():(root/'apps/frappe').symlink_to(root/'frappe', target_is_directory=True)
(root/'logs').mkdir(exist_ok=True)
os.chdir(root/'sites')
import frappe

mode=sys.argv[2]
preview=mode.startswith('preview-')
mode=mode.removeprefix('preview-')
SITE='office-preview.localhost' if preview else 'office-integration.localhost'
DB='office_preview_20261014' if preview else 'office_integration_20261014'
if preview and mode in ('tests','retry-install'):
    raise SystemExit('ACCEPTANCE_ONLY 站禁止自动回归或重装')
if mode in ('install', 'retry-install'):
    from frappe.installer import _new_site
    if Path(SITE).exists() and mode != 'retry-install':raise SystemExit('验收站已存在，不覆盖')
    getpass.getpass=lambda prompt:''
    frappe.init(site=SITE, new_site=True)
    _new_site(db_name=DB,site=SITE,db_root_username='root',db_root_password='',
              admin_password='office-local-acceptance-only',db_type='mariadb',
              db_socket=str(root/'db.sock'),install_apps=apps,force=(mode=='retry-install'))
    print('PASS: isolated install',flush=True)
elif mode == 'seed':
    if not preview:raise SystemExit('只向新建 ACCEPTANCE_ONLY 页面站写入合成验收材料')
    frappe.init(site=SITE);frappe.connect();frappe.set_user('Administrator')
    from shangshu_core.public_api import execute_registered_action
    def action(name,payload):
        return execute_registered_action(name,payload,confirmed=True,
            idempotency_key=frappe.generate_hash(length=24))['result']
    for login,title in [('office-a@example.invalid','验收员工甲'),('office-b@example.invalid','验收员工乙')]:
        if not frappe.db.exists('User',login):
            action('platform.identity.create',{'email':login,'display_name':title,
                'initial_password':'Office-acceptance-2026!','roles':['staff']})
    frappe.set_user('office-a@example.invalid')
    if not frappe.db.exists('Shangshu File Center File',{'owner':frappe.session.user}):
        from openpyxl import Workbook
        from io import BytesIO
        import base64
        wb=Workbook();ws=wb.active;ws.title='报价'
        ws.append(['客户','产品','数量','单价']);ws.append(['方舟贸易','纸箱',150,18.5]);ws.append(['林海工厂','纸袋',80,12])
        out=BytesIO();wb.save(out)
        action('files.upload',{'file_name':'客户报价.xlsx','content_base64':base64.b64encode(out.getvalue()).decode(),
            'attribution':{'level':'personal'}})
        action('mail.save_draft',{'subject':'客户报价确认','body_format':'HTML',
            'body':'<p>您好，请核对以下报价。</p><table><tr><th>产品</th><th>数量</th></tr><tr><td>纸箱</td><td>150</td></tr></table>',
            'to':['client@example.invalid'],'cc':[]})
    frappe.db.commit();print('PASS: ACCEPTANCE_ONLY synthetic preview seed',flush=True)
elif mode == 'migrate':
    from frappe.migrate import SiteMigration
    for index in range(2):
        SiteMigration(skip_search_index=True).run(SITE)
        print('PASS: migrate',index+1,flush=True)
elif mode == 'tests':
    from frappe.test_runner import main
    from shangshu_core.public_api import set_domain_enabled
    for app in apps:
        frappe.init(site=SITE);frappe.connect();frappe.set_user('Administrator')
        # core/finance 的既有启停用例按无在用订单依赖的组合运行；不关闭真实依赖检查。
        for domain in ('com.shangshu.orders','com.shangshu.warehouse'):
            set_domain_enabled(domain,False,'独立回归组合准备',stop_mode='complete')
        if app in ('shangshu_orders','shangshu_warehouse'):
            set_domain_enabled('com.shangshu.warehouse',True,'独立回归组合准备')
        if app=='shangshu_orders':
            set_domain_enabled('com.shangshu.orders',True,'独立回归组合准备')
        frappe.db.commit()
        result=main(site=SITE,app=app,verbose=False)
        if result and not result.wasSuccessful():raise SystemExit('FAIL: '+app)
        print('PASS: app tests',app,flush=True)
else:
    raise SystemExit('未知验收模式')
frappe.destroy()
