"""B 真实数据库回归；仅限独立 shangshu-b-tests.* 目录。"""
import json,os,sys
from pathlib import Path

root=Path(sys.argv[1]).resolve()
if root.parent!=Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root/'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非 B 回归站')
config=json.loads((root/'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name')!='shangshu_b_tests' or config.get('db_socket')!=str(root/'db.sock'):
    raise SystemExit('拒绝其他数据库')
os.chdir(root/'sites')
import frappe
frappe.init(site='b-test.localhost');frappe.connect();frappe.set_user('Administrator')
from shangshu_core.install import ensure_foundation
ensure_foundation()  # 新建测试站也执行迁移后基础设施（包括不可变版本数据库触发器）。
from shangshu_core.public_api import create_application_definition,prepare_object_change,execute_object_change,save_application_draft,publish_application_definition,get_application_definition
from shangshu_core.process_portal import launch_process,get_process_task,complete_process_task,get_process_launch_context
from shangshu_core.runtime import list_process_instances


def rejects(call,error):
    try:call()
    except error:return
    raise AssertionError('预期拒绝但成功')


def handle(name,choice=None,values=None,key=None):
    task=get_process_task(name)['task']
    decision=next((c['id'] for c in task['choices'] if c['title']==choice),None)
    return complete_process_task(name,task['node_id'],values or {},key or frappe.generate_hash(length=24),decision,True)


try:
    suffix=frappe.generate_hash(length=8)
    for role in ['B 审批人','B 复核人']:
        if not frappe.db.exists('Role',role):frappe.get_doc({'doctype':'Role','role_name':role}).insert(ignore_permissions=True)
    users={}
    for key,roles in [('staff',['Desk User']),('other',['Desk User']),('manager',['Desk User','B 审批人']),('boss',['Desk User','B 复核人'])]:
        email=f'b-{key}-{suffix}@example.invalid';users[key]=email
        frappe.get_doc({'doctype':'User','email':email,'first_name':key,'send_welcome_email':0,'user_type':'System User',
                        'roles':[{'role':r} for r in roles]}).insert(ignore_permissions=True)
    app=create_application_definition('采购 B 回归 '+suffix,'b-app-'+suffix)
    change=prepare_object_change(app['id'],{'schema_version':1,'kind':'record','title':'采购申请','fields':[
        {'id':'title','label':'申请事项','type':'text','required':True},
        {'id':'amount','label':'申请金额','type':'decimal','required':True,'constraints':{'minimum':0}},
        {'id':'private_note','label':'审批内部备注','type':'text','read_roles':['B 审批人'],'write_roles':['B 审批人']},
    ],'access':{'read_roles':['Desk User'],'write_roles':['Desk User'],'record_scope':'own'}},'b-table-'+suffix)
    frappe.db.commit();frappe.destroy();frappe.init(site='b-test.localhost');frappe.connect();frappe.set_user('Administrator')
    model=execute_object_change(change['id'],True)
    app=get_application_definition(app['id'])
    spec=app['draft'];spec['bindings']=[{'kind':'datasets','resource_id':model['object_id'],'owner_domain':app['id'],'version':'1'}]
    spec.update(pages=[{'id':'request','title':'采购申请','object_id':model['object_id'],'fields':['title','amount','private_note'],'columns':2}],
                workflows=[{'id':'approval','title':'采购审批','form_id':'request','approver_role':'B 审批人','amount_field':'amount','threshold':5000,'escalation_role':'B 复核人'}],overview=True)
    saved=save_application_draft(app['id'],spec,app['draft_revision']);published=publish_application_definition(app['id'],saved['draft_revision'])
    flow=app['id']+'.process.approval'
    frappe.db.commit()
    names=[]
    frappe.set_user(users['staff'])
    assert 'private_note' not in get_process_launch_context(flow)['schema']['properties']
    rejects(lambda:launch_process(flow,{'title':'越权','amount':1,'private_note':'禁止填写'},'forbidden-'+suffix,True),frappe.ValidationError)
    for amount in [4999,5000,5001]:
        frappe.set_user(users['staff']);key='launch-'+suffix+'-'+str(amount)
        name=launch_process(flow,{'title':'采购打印纸','amount':amount},key,True)['name'];names.append(name)
        assert launch_process(flow,{'title':'采购打印纸','amount':amount},key,True)['name']==name
        assert get_process_task(name)['task']['node_id'].endswith('.review')
        assert 'private_note' not in get_process_task(name)['task']['display_schema']['properties']
        assert 'variables_json' not in get_process_task(name)['instance']
        rejects(lambda:handle(name,'通过'),frappe.PermissionError)
        frappe.set_user(users['other']);rejects(lambda:get_process_task(name),frappe.PermissionError)
        frappe.set_user(users['manager']);task=get_process_task(name)['task'];old_node=task['node_id']
        assert task['schema']['properties']=={}
        rejects(lambda:handle(name,'通过',{'amount':0}),frappe.ValidationError)
        handle(name,'退回修改',key='return-'+name)
        frappe.set_user(users['staff']);assert get_process_task(name)['task']['values']['amount']==amount
        rejects(lambda:handle(name,values={'title':'缺少金额'}),frappe.ValidationError)
        handle(name,values={'title':'补充材料后的采购','amount':amount})
        frappe.set_user(users['manager']);handle(name,'通过',key='approve-'+name)
        state=get_process_task(name)
        assert state['instance']['status']==('Completed' if amount<5000 else 'Running')
        complete_process_task(name,old_node,{},'approve-'+name,flow+'.edge.review_amount',True)
        if amount>=5000:
            assert get_process_task(name)['task']['node_id'].endswith('.extra')
            frappe.set_user(users['boss']);handle(name,'通过')
        assert get_process_task(name)['instance']['status']=='Completed'
    print('PASS: 三个金额边界、真实角色、退回修改重提、越权和重复审批',flush=True)
    frappe.set_user(users['staff'])
    old=launch_process(flow,{'title':'旧版本在途','amount':5000},'old-'+suffix,True)['name']
    old_version=get_process_task(old)['instance']['definition_version']
    frappe.set_user('Administrator');app=get_application_definition(app['id']);spec=app['draft'];spec['workflows'][0]['threshold']=9000;spec['pages'][0]['columns']=1
    saved=save_application_draft(app['id'],spec,app['draft_revision']);publish_application_definition(app['id'],saved['draft_revision'])
    frappe.db.commit();frappe.destroy();frappe.init(site='b-test.localhost');frappe.connect();frappe.set_user(users['manager'])
    handle(old,'通过');assert get_process_task(old)['task']['node_id'].endswith('.extra')
    assert get_process_task(old)['instance']['definition_version']==old_version
    assert get_process_task(old)['task']['columns']==2
    frappe.set_user(users['staff']);new=launch_process(flow,{'title':'新版','amount':5000},'new-'+suffix,True)['name']
    frappe.set_user(users['manager']);handle(new,'通过');assert get_process_task(new)['instance']['status']=='Completed'
    print('PASS: 重连读回、V2 新阈值、V1 在途版本不漂移',flush=True)
    from shangshu_core.runtime import create_process_definition,save_process_draft,publish_definition,get_instance_replay
    from shangshu_core.domains import get_application
    from shangshu_core.applications import set_application_enabled
    frappe.set_user(users['staff'])
    summary=get_application(app['id'])['overview']
    assert summary['tables'][0]['total']==0
    assert not summary['recent_pending']
    from shangshu_core.actions import execute_registered_action
    created=execute_registered_action('platform.object.create',{'object_id':model['object_id'],'expected_revision':1,'values':{'title':'本人记录','amount':42}},confirmed=True,idempotency_key='record-'+suffix)
    from shangshu_core.process_portal import _validate_form_references
    reference_graph={'form':{'reference_fields':{'supplier':model['object_id']}}}
    _validate_form_references(reference_graph,{'supplier':created['result']['name']})
    assert get_application(app['id'])['overview']['tables'][0]['total']==1
    frappe.set_user(users['other'])
    assert get_application(app['id'])['overview']['tables'][0]['total']==0
    rejects(lambda:_validate_form_references(reference_graph,{'supplier':created['result']['name']}),frappe.PermissionError)
    frappe.set_user(users['boss'])
    assert old in [r['name'] for r in get_application(app['id'])['overview']['recent_pending']]
    frappe.set_user('Administrator');latest=get_application_definition(app['id'])
    set_application_enabled(app['id'],False,'B 回归停用',latest['draft_revision'])
    frappe.set_user(users['staff']);rejects(lambda:get_process_launch_context(flow),frappe.PermissionError)
    frappe.set_user(users['boss']);handle(old,'通过')
    assert get_process_task(old)['instance']['status']=='Completed'
    frappe.set_user('Administrator');set_application_enabled(app['id'],True,'B 回归恢复',latest['draft_revision'])
    print('PASS: 总览按真实账号聚合、停用阻断新发起且在途可办',flush=True)
    definition=create_process_definition('B 自动查询 '+suffix)
    did=definition['definition_id'];start=did+'.query';done=did+'.done'
    graph={'nodes':[{'id':start,'type':'action','title':'自动查询','start':True,'action_id':'platform.object.query','automatic':True,
                    'input_mapping':{'object_id':{'field':'object_id'}},'output_mapping':{'record_count':{'field':'total','type':'integer'}}},
                    {'id':done,'type':'human_task','title':'完成','terminal':True,'auto_complete':True}],
           'edges':[{'id':did+'.edge','source':start,'target':done}],
           'form':{'input_schema':{'type':'object','properties':{'object_id':{'type':'string'}},'required':['object_id'],'additionalProperties':False}}}
    saved=save_process_draft(did,graph,definition['draft_revision']);publish_definition(did,saved['draft_revision'])
    frappe.set_user(users['staff'])
    auto=launch_process(did,{'object_id':model['object_id']},'auto-'+suffix,True)['name']
    replay=get_instance_replay(auto)
    assert replay['instance']['status']=='Completed'
    assert json.loads(replay['instance']['variables_json'])['record_count']==1
    assert len(replay['executions'])==2
    assert launch_process(did,{'object_id':model['object_id']},'auto-'+suffix,True)['name']==auto
    frappe.set_user('Administrator');graph['nodes'][0]['output_mapping']['record_count']['type']='string'
    saved=save_process_draft(did,graph,saved['draft_revision']);publish_definition(did,saved['draft_revision'])
    before=frappe.db.count('Shangshu Process Instance',{'definition_id':did})
    frappe.set_user(users['staff']);rejects(lambda:launch_process(did,{'object_id':model['object_id']},'bad-output-'+suffix,True),frappe.ValidationError)
    assert frappe.db.count('Shangshu Process Instance',{'definition_id':did})==before
    frappe.set_user('Administrator');graph['nodes'][0]['input_mapping']['object_id']={'value':42}
    rejects(lambda:__import__('shangshu_core.runtime',fromlist=['validate_graph']).validate_graph(graph),frappe.ValidationError)
    print('PASS: 已注册查询动作自动推进、类型拒绝、输出失败整体回滚、重复发起幂等',flush=True)
    from unittest.mock import patch
    from frappe.model.document import Document
    app=get_application_definition(app['id']);spec=app['draft'];spec['workflows'][0]['threshold']=12345
    saved=save_application_draft(app['id'],spec,app['draft_revision'])
    previous=frappe.db.get_value('Shangshu Application Definition',app['id'],'published_revision')
    process_name=frappe.db.get_value('Shangshu Process Definition',{'definition_id':flow},'name')
    process_version=frappe.db.get_value('Shangshu Process Definition',process_name,'last_published_version')
    count=frappe.db.count('Shangshu Process Definition Version',{'definition':process_name})
    insert=Document.insert
    def failed_release(doc,*args,**kwargs):
        if doc.doctype=='Shangshu Application Release':raise RuntimeError('B 模拟发布中断')
        return insert(doc,*args,**kwargs)
    with patch.object(Document,'insert',failed_release):
        rejects(lambda:publish_application_definition(app['id'],saved['draft_revision']),RuntimeError)
    assert frappe.db.get_value('Shangshu Application Definition',app['id'],'published_revision')==previous
    assert frappe.db.get_value('Shangshu Process Definition',process_name,'last_published_version')==process_version
    assert frappe.db.count('Shangshu Process Definition Version',{'definition':process_name})==count
    print('PASS: 应用发布中断不留下半发布流程版本',flush=True)
    frappe.db.commit()
    print(json.dumps({'application':app['id'],'flow':flow,'users':users},ensure_ascii=False))
finally:
    frappe.db.rollback();frappe.destroy()
