"""仅在专用隔离站验证模型变更，不连接业务库。"""
import json
import os
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch

root=Path(sys.argv[1]).resolve();site="employee-probe.localhost"
if root.parent!=Path('/private/tmp') or not root.name.startswith('shangshu-agent-probe.'):
    raise SystemExit('仅限隔离目录')
if (root/'ACCEPTANCE_ONLY').exists():
    raise SystemExit('此站已交用户验收，禁止追加回归夹具；请另建临时测试站')
config=json.loads((root/'sites'/site/'site_config.json').read_text())
if config.get('db_socket')!=str(root/'db.sock') or config.get('db_name')!='employee_probe':
    raise SystemExit('拒绝业务库')
os.chdir(root/'sites')
import frappe
frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
from shangshu_core.public_api import create_application_definition, prepare_object_change, get_object_change
from shangshu_core.model_changes import MODEL, CHANGE
from shangshu_core.model_changes import execute_object_change, cancel_object_change

if '--crash-change' in sys.argv:
    from shangshu_core.shangshu_core.doctype.shangshu_object_model.shangshu_object_model import ShangshuObjectModel
    # 仅杀死本脚本创建的独立测试进程：模拟 DDL 已提交、指针尚未提交时进程退出。
    with patch.object(ShangshuObjectModel,'save',side_effect=lambda *args,**kwargs:os._exit(73)):
        execute_object_change(sys.argv[sys.argv.index('--crash-change')+1],True)
    raise SystemExit('没有到达预期中断位置')

try:
    for name in ('shangshu_object_model','shangshu_schema_change'):
        frappe.reload_doc('shangshu_core','doctype',name,force=True)
    frappe.clear_cache()
    frappe.db.commit()
    fixture_title='采购主从验收 · '+frappe.generate_hash(length=6)
    app=create_application_definition(fixture_title,'s2-'+frappe.generate_hash(length=16))
    definition={'schema_version':1,'title':'采购申请','fields':[{'id':'title','label':'申请事项','type':'text','required':True}]}
    key='object-'+frappe.generate_hash(length=16)
    change=prepare_object_change(app['id'],definition,key)
    assert prepare_object_change(app['id'],definition,key)['id']==change['id']
    assert change['status']=='Planned' and change['target_revision']==1
    assert not frappe.db.exists('DocType',change['definition']['doctype']['name'])
    try:
        prepare_object_change(app['id'],dict(definition,title='另一对象'),key)
        raise AssertionError('不同输入不能复用请求')
    except frappe.DuplicateEntryError:pass
    try:
        prepare_object_change(app['id'],definition,key+'next',change['object_id'],1)
        raise AssertionError('未完成变更不能被覆盖')
    except frappe.ValidationError:pass
    with patch.object(frappe,'get_roles',return_value=['Desk User']):
        try:get_object_change(change['id']);raise AssertionError('员工不能查看变更计划')
        except frappe.PermissionError:pass
        for operation in (lambda:execute_object_change(change['id'],True),lambda:cancel_object_change(change['id'])):
            try:operation();raise AssertionError('员工不能执行或取消结构变更')
            except frappe.PermissionError:pass
    doc=frappe.get_doc(CHANGE,change['id']);doc.plan_json='{}'
    try:doc.save(ignore_permissions=True);raise AssertionError('变更计划不能覆盖')
    except frappe.ValidationError:pass
    from shangshu_core.shangshu_core.doctype.shangshu_schema_change.shangshu_schema_change import ShangshuSchemaChange
    before=frappe.db.count(MODEL,{'application':app['id']})
    with patch.object(ShangshuSchemaChange,'insert',side_effect=RuntimeError('planned test failure')):
        try:prepare_object_change(app['id'],definition,key+'fail');raise AssertionError('写计划失败应抛出')
        except RuntimeError:pass
    assert frappe.db.count(MODEL,{'application':app['id']})==before
    frappe.db.commit();frappe.destroy();frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
    assert get_object_change(change['id'])['status']=='Planned'
    try:execute_object_change(change['id']);raise AssertionError('必须确认才能建表')
    except frappe.ValidationError:pass
    applied=execute_object_change(change['id'],True)
    assert applied['status']=='Applied'
    assert frappe.db.table_exists(applied['definition']['doctype']['name'])
    assert execute_object_change(change['id'],True)['status']=='Applied'
    try:prepare_object_change(app['id'],definition,key+'unchanged',change['object_id'],1);raise AssertionError('无变化不应增加修订')
    except frappe.ValidationError:pass
    assert frappe.db.get_value(MODEL,change['object_id'],'revision')==1
    cancelled=prepare_object_change(app['id'],dict(definition,title='取消测试'),key+'cancel')
    assert cancel_object_change(cancelled['id'])['status']=='Cancelled'
    frappe.db.commit()
    assert not frappe.db.exists('DocType',cancelled['definition']['doctype']['name'])
    try:execute_object_change(cancelled['id'],True);raise AssertionError('已取消不能执行')
    except frappe.ValidationError:pass
    crashed=prepare_object_change(app['id'],dict(definition,title='进程中断恢复'),key+'crash')
    frappe.db.commit()
    process=subprocess.run([sys.executable,str(Path(__file__).resolve()),str(root),'--crash-change',crashed['id']],timeout=30)
    assert process.returncode==73
    frappe.db.rollback()
    assert get_object_change(crashed['id'])['status']=='Running'
    assert frappe.db.get_value(MODEL,crashed['object_id'],'active_revision')==0
    assert execute_object_change(crashed['id'],True)['status']=='Applied'
    response_failure=prepare_object_change(app['id'],dict(definition,title='响应中断'),key+'response')
    frappe.db.commit()
    with patch('shangshu_core.model_changes._public',side_effect=RuntimeError('response failed after commit')):
        try:execute_object_change(response_failure['id'],True);raise AssertionError('预期响应中断')
        except RuntimeError:pass
    assert get_object_change(response_failure['id'])['status']=='Applied'
    assert execute_object_change(response_failure['id'],True)['status']=='Applied'
    updated={'schema_version':1,'title':'采购申请','fields':definition['fields']+[{'id':'note','label':'备注','type':'text'}]}
    pending=prepare_object_change(app['id'],updated,key+'update',change['object_id'],1)
    frappe.db.commit()
    # 在 DDL 之后、生效指针保存之前失败，重连后必须能按同一计划恢复。
    from shangshu_core.shangshu_core.doctype.shangshu_object_model.shangshu_object_model import ShangshuObjectModel
    with patch.object(ShangshuObjectModel,'save',side_effect=RuntimeError('after ddl probe failure')):
        try:execute_object_change(pending['id'],True);raise AssertionError('预期中断')
        except RuntimeError:pass
    assert get_object_change(pending['id'])['status']=='Failed'
    assert frappe.db.get_value(MODEL,change['object_id'],'active_revision')==1
    try:cancel_object_change(pending['id']);raise AssertionError('已开始不能取消')
    except frappe.ValidationError:pass
    frappe.db.rollback();frappe.destroy();frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
    assert execute_object_change(pending['id'],True)['status']=='Applied'
    assert frappe.db.get_value(MODEL,change['object_id'],'active_revision')==2
    from shangshu_core.install import ensure_foundation
    from shangshu_core.actions import execute_registered_action
    from shangshu_core.objects import get_object_record, query_object_records
    ensure_foundation(install_triggers=False)
    payload={'object_id':change['object_id'],'expected_revision':2,'values':{'title':'采购打印纸','note':'测试记录'}}
    record_key=key+'record'
    created=execute_registered_action('platform.object.create',payload,True,record_key)
    again=execute_registered_action('platform.object.create',payload,True,record_key)
    assert again['idempotent'] and again['result']['name']==created['result']['name']
    record=get_object_record(change['object_id'],created['result']['name'])['record']
    assert record['title']=='采购打印纸'
    execute_registered_action('platform.object.update',{'object_id':change['object_id'],'name':record['name'],
        'expected_revision':2,'expected_modified':record['modified'],'values':{'note':'修改成功'}},True,key+'edit')
    assert query_object_records(change['object_id'])['rows'][0]['note']=='修改成功'
    try:
        execute_registered_action('platform.object.create',{**payload,'values':{'name':'禁止注入'}},True,key+'unsafe')
        raise AssertionError('未知字段不可写')
    except frappe.PermissionError:pass
    direct=frappe.new_doc(applied['definition']['doctype']['name'])
    direct.set(applied['definition']['doctype']['fields'][0]['fieldname'],'尝试直接写入')
    try:direct.insert(ignore_permissions=True);raise AssertionError('不能绕开受管写入')
    except frappe.PermissionError:pass
    frappe.db.commit();frappe.destroy();frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
    assert get_object_record(change['object_id'],record['name'])['record']['note']=='修改成功'
    from shangshu_core.public_api import save_application_draft, publish_application_definition, get_application_definition, application_catalog
    current=get_application_definition(app['id'])
    binding={'kind':'datasets','resource_id':change['object_id'],'owner_domain':app['id'],'version':'2'}
    saved=save_application_draft(app['id'],{**current['draft'],'bindings':[binding]},current['draft_revision'])
    publish_application_definition(app['id'],saved['draft_revision'])
    assert any(a['id']==app['id'] for a in application_catalog())
    # 真正独立的员工身份，不能读取管理员创建的本人范围记录。
    email='model-probe-'+frappe.generate_hash(length=12)+'@example.invalid'
    frappe.get_doc({'doctype':'User','email':email,'first_name':'模型权限测试','user_type':'System User',
                    'send_welcome_email':0,'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
    try:
        frappe.set_user(email)
        assert query_object_records(change['object_id'])['total']==0
        try:get_object_record(change['object_id'],record['name']);raise AssertionError('员工不能读他人记录')
        except frappe.PermissionError:pass
        own=execute_registered_action('platform.object.create',payload,True,key+'staff')
        assert get_object_record(change['object_id'],own['result']['name'])['record']['title']=='采购打印纸'
    finally:
        frappe.set_user('Administrator')
        # 留存用于真实浏览器复核的记录，用户数据清理只用文档生命周期。
        frappe.delete_doc('User',email,ignore_permissions=True,force=True)
    frappe.db.commit()
    def build_model(title,fields,kind='record',scope='own'):
        planned=prepare_object_change(app['id'],{'schema_version':1,'title':title,'kind':kind,'fields':fields,
            'access':{'read_roles':['Desk User'],'write_roles':['Desk User'],'record_scope':scope}},key+title)
        frappe.db.commit()
        return execute_object_change(planned['id'],True)
    supplier=build_model('供应商',[{'id':'title','label':'公司名称','type':'text','required':True}],scope='all')
    lines=build_model('申请明细',[{'id':'item','label':'品名','type':'text','required':True},
        {'id':'quantity','label':'数量','type':'integer','required':True,'constraints':{'minimum':1}},
        {'id':'internal_note','label':'内部备注','type':'text','read_roles':['System Manager'],'write_roles':['System Manager']}],kind='detail')
    purchase=build_model('采购单',[{'id':'title','label':'申请事项','type':'text','required':True},
        {'id':'supplier','label':'供应商','type':'reference','target':supplier['object_id'],'required':True},
        {'id':'lines','label':'采购明细','type':'detail','target':lines['object_id'],'required':True}])
    vendor=execute_registered_action('platform.object.create',{'object_id':supplier['object_id'],'expected_revision':1,
        'values':{'title':'验收办公用品商店'}},True,key+'vendor')['result']
    purchase_payload={'object_id':purchase['object_id'],'expected_revision':1,'values':{'title':'购买打印纸',
        'supplier':vendor['name'],'lines':[{'item':'A4纸','quantity':2}]}}
    order=execute_registered_action('platform.object.create',purchase_payload,True,key+'purchase')['result']
    assert get_object_record(purchase['object_id'],order['name'])['record']['_display']['supplier']=='验收办公用品商店'
    first_line=get_object_record(purchase['object_id'],order['name'])['record']['lines'][0]
    assert first_line['item']=='A4纸' and first_line['quantity']==2 and first_line['_row_id']
    try:
        execute_registered_action('platform.object.create',{**purchase_payload,'values':{**purchase_payload['values'],
            'lines':[{'item':'A4纸','quantity':0}]}},True,key+'bad-line')
        raise AssertionError('明细也应执行同一约束')
    except frappe.ValidationError:pass
    assert query_object_records(purchase['object_id'])['total']==1
    frappe.db.commit();frappe.destroy();frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
    assert get_object_record(purchase['object_id'],order['name'])['record']['supplier']==vendor['name']
    current=get_application_definition(app['id'])
    bindings=[{'kind':'datasets','resource_id':item['object_id'],'owner_domain':app['id'],'version':'1'} for item in (supplier,purchase)]
    saved=save_application_draft(app['id'],{**current['draft'],'bindings':bindings},current['draft_revision'])
    publish_application_definition(app['id'],saved['draft_revision'])
    email='nested-probe-'+frappe.generate_hash(length=12)+'@example.invalid'
    frappe.get_doc({'doctype':'User','email':email,'first_name':'明细权限验收','user_type':'System User',
        'send_welcome_email':0,'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
    try:
        frappe.set_user(email)
        from shangshu_core.public_api import get_object_definition
        public=get_object_definition(purchase['object_id'])
        assert 'internal_note' not in public['input_schema']['properties']['lines']['items']['properties']
        owned=execute_registered_action('platform.object.create',purchase_payload,True,key+'nested-staff')['result']
        assert 'internal_note' not in get_object_record(purchase['object_id'],owned['name'])['record']['lines'][0]
        own_detail=get_object_record(purchase['object_id'],owned['name'])['record']
        execute_registered_action('platform.object.update',{'object_id':purchase['object_id'],'expected_revision':1,
            'name':owned['name'],'expected_modified':own_detail['modified'],'values':{'lines':[
                {**own_detail['lines'][0],'quantity':3}]}},True,key+'nested-update')
        assert get_object_record(purchase['object_id'],owned['name'])['record']['lines'][0]['quantity']==3
        try:
            execute_registered_action('platform.object.create',{**purchase_payload,'values':{
                **purchase_payload['values'],'lines':[{'item':'纸','quantity':1,'internal_note':'越权'}]}},True,key+'nested-forged')
            raise AssertionError('明细隐藏字段不能伪造写入')
        except frappe.PermissionError:pass
    finally:
        frappe.set_user('Administrator');frappe.delete_doc('User',email,ignore_permissions=True,force=True)
    # 关联表更新不能静默改变主表冻结的输入含义；取消旧计划仍可读取原快照。
    supplier_definition={k:supplier['definition'][k] for k in ('schema_version','title','kind','fields','access')}
    supplier_definition['fields'].append({'id':'phone','label':'电话','type':'text'})
    supplier_update=prepare_object_change(app['id'],supplier_definition,key+'supplier-v2',supplier['object_id'],1)
    frappe.db.commit();execute_object_change(supplier_update['id'],True)
    # 普通关联只保存记录身份，供应商新增字段不改变主表输入结构，不要求无谓重建。
    assert get_object_record(purchase['object_id'],order['name'])['record']['supplier']==vendor['name']
    lines_definition={k:lines['definition'][k] for k in ('schema_version','title','kind','fields','access')}
    lines_definition['fields'].append({'id':'note','label':'行备注','type':'text'})
    lines_update=prepare_object_change(app['id'],lines_definition,key+'lines-v2',lines['object_id'],1)
    frappe.db.commit();execute_object_change(lines_update['id'],True)
    try:
        get_object_record(purchase['object_id'],order['name'])
        raise AssertionError('关联结构变化必须提示重新确认，不能静默漂移')
    except frappe.ValidationError:pass
    refreshed_definition={k:purchase['definition'][k] for k in ('schema_version','title','kind','fields','access')}
    refreshed=prepare_object_change(app['id'],refreshed_definition,key+'purchase-refresh',purchase['object_id'],1)
    frappe.db.commit();execute_object_change(refreshed['id'],True)
    assert get_object_record(purchase['object_id'],order['name'])['record']['supplier']==vendor['name']
    print('PASS model prepare/retry/conflict/permissions/immutable plan/rollback/reconnect + confirmed DDL/cancel/failure recovery/idempotent apply in isolated DB')
    print('PASS governed record create/update/read/replay/unknown-field denial/direct-write denial/reconnect')
    print('PASS application bind/publish/catalog + real employee own-record isolation')
    print('PASS supplier reference + purchase master/detail + nested value validation + reconnect')
    print('PASS reference revision drift denied + explicit parent refresh preserves records')
    print('PASS nested field permission projection + employee create + forged hidden field denied')
    current=get_application_definition(app['id'])
    published_bindings=[{'kind':'datasets','resource_id':item['object_id'],'owner_domain':app['id'],'version':'2'} for item in (supplier,purchase)]
    saved=save_application_draft(app['id'],{**current['draft'],'bindings':published_bindings},current['draft_revision'])
    publish_application_definition(app['id'],saved['draft_revision']);frappe.db.commit()
    print('BROWSER_FIXTURE '+fixture_title)
finally:
    frappe.db.rollback();frappe.destroy()
