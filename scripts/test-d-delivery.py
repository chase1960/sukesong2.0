"""D 定义交付真实迁移回归；只允许独立自动回归站，不复用用户验收库。"""
import json,os,sys
from pathlib import Path

root=Path(sys.argv[1]).resolve()
if root.parent!=Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root/'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立自动回归站')
config=json.loads((root/'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name')!='shangshu_b_tests' or config.get('db_socket')!=str(root/'db.sock'):
    raise SystemExit('数据库边界不匹配')
repo=Path(__file__).resolve().parents[1]
for app in ('shangshu_orders','shangshu_warehouse'):sys.path.insert(0,str(repo/'frappe_apps'/app))
os.chdir(root/'sites')
import frappe
from shangshu_core.install import ensure_foundation
from shangshu_core.public_api import (create_application_definition,prepare_object_change,execute_object_change,
    save_application_draft,get_application_definition,invoke_domain_service,execute_registered_action,set_application_enabled)

def connect():
    frappe.init(site='b-test.localhost');frappe.connect();frappe.set_user('Administrator')
def boundary():
    frappe.db.commit();frappe.destroy();connect()
def inspect(app,operation,**values):
    return invoke_domain_service('platform.application.delivery',{'application_id':app,'operation':operation,**values})

connect();ensure_foundation();frappe.db.commit()
apps=[]
try:
    source=create_application_definition('D 定义交付回归',frappe.generate_hash(length=24));apps.append(source['id'])
    supplier=prepare_object_change(source['id'],{'schema_version':1,'title':'供应商','kind':'record',
        'fields':[{'id':'title','label':'名称','type':'text','required':True}]},frappe.generate_hash(length=24))
    boundary();execute_object_change(supplier['id'],True);boundary()
    order=prepare_object_change(source['id'],{'schema_version':1,'title':'采购单','kind':'record','fields':[
        {'id':'supplier','label':'供应商','type':'reference','target':supplier['object_id']},
        {'id':'amount','label':'金额','type':'decimal','required':True}]},frappe.generate_hash(length=24))
    boundary();execute_object_change(order['id'],True);boundary()
    spec={**source['draft'],'bindings':[{'kind':'datasets','resource_id':item['object_id'],'owner_domain':source['id'],'version':'1'} for item in (supplier,order)],
        'pages':[{'id':'purchase','title':'采购单','object_id':order['object_id'],'fields':['supplier','amount'],'columns':2}],
        'workflows':[{'id':'approval','title':'采购审批','form_id':'purchase','approver_role':'System Manager'}]}
    save_application_draft(source['id'],spec,1);boundary()
    package=inspect(source['id'],'export')['package']
    assert 'SSM ' not in json.dumps(package)  # 不输出物理表名。
    target=create_application_definition('D 导入回归',frappe.generate_hash(length=24));apps.append(target['id']);boundary()
    preview=inspect(target['id'],'import_preview',package=package)
    assert len(preview['models'])==2
    for index,model in enumerate(preview['models']):
        plan=prepare_object_change(target['id'],model['definition'],model['idempotency_key'])
        assert plan['object_id']==model['object_id']
        boundary();execute_object_change(plan['id'],True);boundary()
        resumed=inspect(target['id'],'import_preview',package=package)
        assert sum(item['complete'] for item in resumed['models'])==index+1
    # 两次调用相同键不新建对象，跨请求重试仍只有两张表。
    model=preview['models'][0]
    repeated=prepare_object_change(target['id'],model['definition'],model['idempotency_key'])
    assert repeated['object_id']==model['object_id']
    payload={'application_id':target['id'],'expected_revision':1,'definition':preview['definition'],'dependency_hash':preview['dependency_hash']}
    result=execute_registered_action('platform.application.configure',payload,confirmed=True,idempotency_key=frappe.generate_hash(length=24))
    assert result['result']['draft_revision']==2
    boundary()
    imported=inspect(target['id'],'export')['package']
    assert len(imported['models'])==2 and len(imported['definition']['workflows'])==1
    assert imported['definition']['pages'][0]['object_id'].startswith(target['id'])
    print('PASS: 真实建表、关联重映射、逐步恢复、幂等重试、表单与审批定义保留、导出不含物理表名',flush=True)
finally:
    frappe.db.rollback()
    for app in apps:
        current=get_application_definition(app)
        if current['published_revision']:
            set_application_enabled(app,False,'D 自动回归结束，保留定义证据',current['draft_revision'])
        print('保留自动回归证据（不进入员工应用目录）:',app,flush=True)
    frappe.db.commit();frappe.destroy()
