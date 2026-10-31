"""仅使用既有独立探针站；拒绝连接项目业务库。"""
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-agent-probe.'):
    raise SystemExit('仅支持隔离探针目录')
site = 'employee-probe.localhost'
config = json.loads((root / 'sites' / site / 'site_config.json').read_text())
if config.get('db_socket') != str(root / 'db.sock') or config.get('db_name') != 'employee_probe':
    raise SystemExit('拒绝操作非隔离数据库')
os.chdir(root / 'sites')
import frappe
frappe.init(site=site)
frappe.connect()
frappe.set_user('Administrator')
from shangshu_core.identity import backfill_collaboration_keys
from shangshu_core.public_api import get_identity, list_collaboration_people

try:
    frappe.reload_doc('shangshu_core', 'doctype', 'shangshu_identity', force=True)
    backfill_collaboration_keys()
    assert get_identity().collaboration_key == 'admin'
    suffix = frappe.generate_hash(length=12).lower()
    email = f'remediation-{suffix}@example.invalid'
    user = frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': '隔离新员工',
                           'user_type': 'System User', 'send_welcome_email': 0,
                           'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    identity = get_identity(email)
    assert identity.collaboration_key == identity.identity_id
    assert any(row['username'] == identity.identity_id for row in list_collaboration_people())
    renamed = f'renamed-{suffix}@example.invalid'
    frappe.rename_doc('User', email, renamed, force=True)
    assert get_identity(renamed).collaboration_key == identity.identity_id
    frappe.db.set_value('User', renamed, 'enabled', 0)
    assert all(row['username'] != identity.identity_id for row in list_collaboration_people())
    try:
        get_identity(renamed)
        raise AssertionError('停用用户不应取得有效身份')
    except frappe.PermissionError:
        pass
    backfill_collaboration_keys()
    assert frappe.db.get_value('Shangshu Identity', identity.name, 'collaboration_key') == identity.identity_id
    frappe.db.commit()
    print('PASS: 新员工目录、稳定引用、改名、停用、重复迁移（隔离真实数据库）')
    frappe.reload_doc('shangshu_core', 'doctype', 'shangshu_process_instance', force=True)
    frappe.reload_doc('shangshu_core', 'doctype', 'shangshu_node_execution', force=True)
    from shangshu_core.public_api import (create_process_definition, save_process_draft, publish_definition,
                                          launch_process, get_process_task, complete_process_task)
    definition = create_process_definition('整改回归：通用金额审批')
    ident = definition['definition_id']
    schema = {'type': 'object', 'additionalProperties': False, 'required': ['amount'],
              'properties': {'amount': {'type': 'number', 'title': '金额'}}}
    graph = {'schema_version': 2, 'form': {'input_schema': schema}, 'nodes': [
        {'id': ident+'.submit', 'type': 'human_task', 'start': True, 'allowed_roles': ['Desk User']},
        {'id': ident+'.branch', 'type': 'condition'},
        {'id': ident+'.manager', 'type': 'human_task', 'allowed_roles': ['System Manager']},
        {'id': ident+'.end', 'type': 'human_task', 'terminal': True},
    ], 'edges': [
        {'id': 'submit', 'source': ident+'.submit', 'target': ident+'.branch'},
        {'id': 'large', 'source': ident+'.branch', 'target': ident+'.manager', 'condition': {
            'source': {'scope':'process_input','field_path':'amount','field_label':'金额'}, 'operator':'gte','value':5000}},
        {'id': 'small', 'source': ident+'.branch', 'target': ident+'.end', 'is_default':True},
        {'id': 'approved', 'source':ident+'.manager','target':ident+'.end'},
    ]}
    saved = save_process_draft(ident, graph, 1)
    publish_definition(ident, saved['draft_revision'])
    frappe.db.set_value('User', renamed, 'enabled', 1)
    frappe.set_user(renamed)
    for amount in (4999,5000,5001):
        key = 'launch-'+str(amount)
        started = launch_process(ident, {'amount':amount}, key, True)
        name = started['name']
        assert launch_process(ident, {'amount':amount}, key, True)['name'] == name
        result = complete_process_task(name, ident+'.submit', {'amount':amount}, 'submit', confirmed=True)
        target = ident+('.manager' if amount>=5000 else '.end')
        assert result['instance']['current_node'] == target
        assert complete_process_task(name, ident+'.submit', {'amount':amount}, 'submit', confirmed=True)['instance']['current_node'] == target
        try:
            complete_process_task(name, ident+'.submit', {}, 'submit', confirmed=True)
            raise AssertionError('同一幂等键不能删改输入')
        except frappe.ValidationError:
            pass
        if amount>=5000:
            try:
                complete_process_task(name,target,{'amount':amount},'forbidden',confirmed=True)
                raise AssertionError('员工不得自批经理节点')
            except frappe.PermissionError:
                pass
            frappe.set_user('Administrator')
            complete_process_task(name,target,{'amount':amount},'approve',confirmed=True)
            frappe.set_user(renamed)
        result = complete_process_task(name,ident+'.end',{'amount':amount},'finish',confirmed=True)
        assert result['instance']['status']=='Completed'
        print(f'PASS: 通用发起→条件→审批→完成 amount={amount}，重复提交及越权检查')
    frappe.db.commit()
    if '--finance' in sys.argv:
        frappe.set_user('Administrator')
        from frappe.installer import install_app
        if 'shangshu_finance' not in frappe.get_installed_apps():
            install_app('shangshu_finance')
        from shangshu_finance.install import ensure_foundation
        ensure_foundation()
        from shangshu_core.public_api import check_registered_manifests
        assert len(check_registered_manifests()['checked']) == 2
        from shangshu_core.public_api import publish_portal_definition
        action_definition=create_process_definition('整改回归：通用注册动作')
        action_id=action_definition['definition_id']
        action_graph={'schema_version':2,'nodes':[
            {'id':action_id+'.start','type':'human_task','start':True},
            {'id':action_id+'.query','type':'action','action_id':'platform.object.query'},
            {'id':action_id+'.end','type':'human_task','terminal':True},
        ],'edges':[{'source':action_id+'.start','target':action_id+'.query'}, {'source':action_id+'.query','target':action_id+'.end'}]}
        saved=save_process_draft(action_id,action_graph,1)
        publish_portal_definition(action_id,saved['draft_revision'])
        launched=launch_process(action_id,{},'start',True)
        complete_process_task(launched['name'],action_id+'.start',{},'human',confirmed=True)
        result=complete_process_task(launched['name'],action_id+'.query',{'object_id':'finance.invoice'},'query',confirmed=True)
        assert result['instance']['current_node']==action_id+'.end'
        result=complete_process_task(launched['name'],action_id+'.end',{},'end',confirmed=True)
        assert result['instance']['status']=='Completed'
        action_graph['nodes'][1]={'id':action_id+'.query','type':'ai_select','candidates':['platform.object.query']}
        saved=save_process_draft(action_id,action_graph,saved['draft_revision'])
        try:
            publish_portal_definition(action_id,saved['draft_revision'])
            raise AssertionError('无领域执行适配的 AI 节点不得在员工入口发布')
        except frappe.ValidationError:
            pass
        print('PASS: 通用人工→受管动作→人工完成；未适配节点发布阻断')
        frappe.db.commit()
        import unittest
        from shangshu_finance.tests.test_finance_chain import TestFinanceChain
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(TestFinanceChain))
        if not result.wasSuccessful():
            raise AssertionError('隔离财务回归失败')
    if '--core' in sys.argv:
        import unittest
        frappe.set_user('Administrator')
        from shangshu_core.install import ensure_foundation as ensure_core_foundation
        ensure_core_foundation()
        suite = unittest.defaultTestLoader.discover(frappe.get_app_path('shangshu_core','tests'),pattern='test_*.py',top_level_dir=str(Path(frappe.get_app_path('shangshu_core')).parent))
        result=unittest.TextTestRunner(verbosity=2).run(suite)
        if not result.wasSuccessful():
            raise AssertionError('隔离内核回归失败')
finally:
    frappe.db.rollback()
    frappe.destroy()
