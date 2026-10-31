"""表格工作面使用的公共记录契约实库回归；仅限独立自动回归站。"""
import json
import base64
from io import BytesIO
import os
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else '').resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立自动回归站')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('数据库边界不匹配')
repo = Path(__file__).resolve().parents[2]
for app in ('shangshu_core', 'shangshu_finance', 'shangshu_orders', 'shangshu_warehouse', 'shangshu_files', 'shangshu_mail'):
    sys.path.insert(0, str(repo / 'frappe_apps' / app))
os.chdir(root / 'sites')
import frappe
from shangshu_core.public_api import (create_application_definition, prepare_object_change,
    execute_object_change, execute_registered_action, get_object_record, query_object_records,
    get_application_definition, set_application_enabled, save_application_draft, publish_application_definition, invoke_domain_service)

frappe.init(site='b-test.localhost', sites_path=str(root / 'sites'))
frappe.connect(); frappe.set_user('Administrator')
app = None
people=[]
checks = []
def check(label, valid):
    checks.append((label, bool(valid)))
    print(('✓ ' if valid else '✗ ') + label)
def rejected(label, operation, expected):
    try:
        operation()
    except expected:
        check(label, True)
    else:
        check(label, False)

try:
    frappe.reload_doc('shangshu_core','doctype','shangshu_action_execution_audit',force=True)
    frappe.db.commit()  # 审计可选字段升级只在测试准备期，不夹在动作事务内。
    from shangshu_core.domains import ensure_registered_domains
    ensure_registered_domains()  # 与安装/迁移相同的贡献同步，不直接改注册表。
    from shangshu_core.install import ensure_foundation
    ensure_foundation(install_triggers=False)
    app = create_application_definition('表格记录自动回归', 'sheet-'+frappe.generate_hash(length=20))
    definition = {'schema_version': 1, 'title': '办公用品', 'fields': [
        {'id': 'title', 'label': '名称', 'type': 'text', 'required': True},
        {'id': 'quantity', 'label': '数量', 'type': 'integer'},
        {'id': 'date', 'label': '采购日期', 'type': 'date'},
        {'id': 'notes', 'label': '说明', 'type': 'long_text'},
        {'id': 'status', 'label': '状态', 'type': 'choice', 'options':['待买','已买']},
        {'id': 'private_note', 'label': '内部备注', 'type':'text','read_roles':['System Manager'],'write_roles':['System Manager']}]}
    change = prepare_object_change(app['id'], definition, 'schema-'+frappe.generate_hash(length=20))
    frappe.db.commit()  # DDL 必须独立事务，不夹在业务写入中。
    applied = execute_object_change(change['id'], True)
    object_id = change['object_id']
    check('无需上传文件即可建表', applied['status'] == 'Applied')
    capability = query_object_records(object_id)['object']['import']
    check('管理员普通表声明唯一导入服务与动作', capability['available'] and capability['service']=='platform.object.import_preview' and capability['action']=='platform.object.import' and capability['max_bytes']==10485760)
    payload = {'object_id': object_id, 'expected_revision': 1,
               'values': {'title': '打印纸', 'quantity': 3, 'date': '2026-09-22','notes':'长说明中的独有检索词'}}
    key = 'create-'+frappe.generate_hash(length=20)
    created = execute_registered_action('platform.object.create', payload, True, key)
    name = created['result']['name']; modified = created['result']['modified']
    check('新增后有执行审计', bool(created.get('audit')))
    replay = execute_registered_action('platform.object.create', payload, True, key)
    check('同一请求重试不重复建行', replay['result']['name'] == name and query_object_records(object_id)['total'] == 1)
    update = {'object_id': object_id, 'name': name, 'expected_revision': 1,
              'expected_modified': modified, 'values': {'quantity': 8}}
    saved = execute_registered_action('platform.object.update', update, True, 'save-'+frappe.generate_hash(length=20))
    frappe.db.commit(); frappe.destroy()
    frappe.init(site='b-test.localhost', sites_path=str(root / 'sites')); frappe.connect(); frappe.set_user('Administrator')
    record = get_object_record(object_id, name)['record']
    check('重连后真实值保留且其他字段不丢', record['quantity'] == 8 and record['title'] == '打印纸' and record['date'] == '2026-09-22')
    def history(record_name=name):
        return invoke_domain_service('platform.object.history',{'object_id':object_id,'name':record_name})
    timeline=history()
    check('记录历史有操作者、时间和真实前后值',timeline['total']==2 and timeline['items'][0]['actor']=='Administrator' and bool(timeline['items'][0]['time']) and timeline['items'][0]['changes']==[{'field':'quantity','label':'数量','type':'integer','before':3,'after':8}])
    check('幂等重试没有重复历史',len(timeline['items'])==2)
    from datetime import datetime
    check('历史时间包含明确时区，浏览器无需猜测',datetime.fromisoformat(timeline['items'][0]['time']).utcoffset() is not None)
    history_page=invoke_domain_service('platform.object.history',{'object_id':object_id,'name':name,'page':2,'page_length':1})
    check('历史分页保留完整时间线',history_page['total']==2 and len(history_page['items'])==1 and history_page['items'][0]['operation']=='create')
    audit_doc=frappe.get_doc('Shangshu Action Execution Audit',timeline['items'][0]['id'])
    audit_doc.record_changes_json='{}'
    rejected('已有字段历史不可覆盖',lambda:audit_doc.save(ignore_permissions=True),frappe.ValidationError)
    rejected('旧记录版本被拒，不覆盖并发更新', lambda: execute_registered_action('platform.object.update', update, True, 'stale-'+frappe.generate_hash(length=20)), frappe.TimestampMismatchError)
    invalid = {**update, 'expected_modified': record['modified'], 'values': {'quantity': 'abc'}}
    rejected('数值列拒绝文本', lambda: execute_registered_action('platform.object.update', invalid, True, 'invalid-'+frappe.generate_hash(length=20)), frappe.ValidationError)
    invalid = {**update, 'expected_modified': record['modified'], 'values': {'title': ''}}
    rejected('必填列拒绝空值', lambda: execute_registered_action('platform.object.update', invalid, True, 'empty-'+frappe.generate_hash(length=20)), frappe.ValidationError)
    check('失败后正式值仍为已接受版本', get_object_record(object_id, name)['record']['quantity'] == 8)
    check('失败写入不产生成功历史',history()['total']==2)
    from unittest.mock import patch
    from frappe.model.document import Document
    original_insert=Document.insert
    def fail_audit(doc,*args,**kwargs):
        if doc.doctype=='Shangshu Action Execution Audit':
            frappe.throw('测试审计写入失败',frappe.ValidationError)
        return original_insert(doc,*args,**kwargs)
    with patch.object(Document,'insert',fail_audit):
        rejected('审计失败使业务修改一并回滚',lambda:execute_registered_action('platform.object.update',{**update,'expected_modified':record['modified'],'values':{'quantity':9}},True,frappe.generate_hash(length=24)),frappe.ValidationError)
    check('审计失败后原值与历史保持一致',get_object_record(object_id,name)['record']['quantity']==8 and history()['total']==2)
    # 超过一页，验证关键词与排序在数据库全体授权记录上执行。
    for i in range(35):
        execute_registered_action('platform.object.create',{'object_id':object_id,'expected_revision':1,
            'values':{'title':f'跨页物品 {i:02d}'+(' 100%_验收' if i==34 else ''),'quantity':i,'status':'待买' if i%2 else '已买'}},
            True,frappe.generate_hash(length=24))
    found=query_object_records(object_id,{'$search':'100%_验收'})
    check('全表关键词能命中跨页记录且通配符按字面匹配',found['total']==1 and found['rows'][0]['quantity']==34)
    check('原精确筛选保持兼容',query_object_records(object_id,{'title':'打印纸'})['total']==1)
    check('长文本列纳入权限内全表关键词',query_object_records(object_id,{'$search':'独有检索词'})['total']==1)
    ordered=query_object_records(object_id,{'$sort':'quantity','$direction':'desc'},1,5)
    check('数值排序在分页前进行', [r['quantity'] for r in ordered['rows']]==[34,33,32,31,30] and ordered['total']==36)
    check('关键词与精确状态共同筛选',query_object_records(object_id,{'$search':'跨页物品','status':'待买'})['total']==17)
    rejected('排序字段不能注入表达式',lambda:query_object_records(object_id,{'$sort':'quantity desc; drop table x'}),frappe.ValidationError)
    rejected('未知排序方向拒绝',lambda:query_object_records(object_id,{'$direction':'random'}),frappe.ValidationError)
    rejected('超长搜索拒绝',lambda:query_object_records(object_id,{'$search':'x'*201}),frappe.ValidationError)
    public=ordered['object']['query']
    check('查询能力由真实字段投影', 'title' in public['search_fields'] and 'quantity' in public['sort_fields'])
    from openpyxl import load_workbook
    def export(filters=None):
        return invoke_domain_service('platform.object.export',{'object_id':object_id,'filters':filters or {},'expected_revision':1})
    exported=export({'$search':'跨页物品','status':'待买','$sort':'quantity','$direction':'asc'})
    book=load_workbook(BytesIO(base64.b64decode(exported['content_base64'])))
    values=list(book.active.values)
    check('XLSX 全筛选导出不截本页，包含列名与稳定排序',exported['total']==17 and len(values)==18 and values[0][0]=='名称' and values[1][1]==1 and values[-1][1]==33)
    check('全量导出所有正式记录',export()['total']==36)
    formula=execute_registered_action('platform.object.create',{'object_id':object_id,'expected_revision':1,'values':{'title':'=1+1','date':'2026-09-22'}},True,frappe.generate_hash(length=24))
    book=load_workbook(BytesIO(base64.b64decode(export({'title':'=1+1'})['content_base64'])))
    check('公式样式字符串仍是文本，日期可在 Excel 复用',book.active['A2'].value=='=1+1' and book.active['A2'].data_type=='s' and book.active['C2'].value.date().isoformat()=='2026-09-22')
    rejected('导出旧字段版本明确拒绝',lambda:invoke_domain_service('platform.object.export',{'object_id':object_id,'expected_revision':0}),frappe.TimestampMismatchError)
    from unittest.mock import patch
    with patch('shangshu_core.record_export.MAX_ROWS',1):
        rejected('导出超限不生成截断文件',lambda:export(),frappe.ValidationError)
    long=execute_registered_action('platform.object.create',{'object_id':object_id,'expected_revision':1,'values':{'title':'过长文本','notes':'x'*32768}},True,frappe.generate_hash(length=24))
    check('历史前后值不采用 500 字摘要截断',len(next(c['after'] for c in history(long['result']['name'])['items'][0]['changes'] if c['field']=='notes'))==32768)
    rejected('XLSX 单元格超长明确拒绝而不是截断',lambda:export({'title':'过长文本'}),frappe.ValidationError)
    for i in range(101):
        execute_registered_action('platform.object.create',{'object_id':object_id,'expected_revision':1,'values':{'title':f'导出分页 {i:03d}','quantity':i}},True,frappe.generate_hash(length=24))
    batch=export({'$search':'导出分页','$sort':'quantity'})
    book=load_workbook(BytesIO(base64.b64decode(batch['content_base64'])))
    check('超过底层 100 行分页仍导出全量且无重复',batch['total']==101 and book.active.max_row==102 and book.active['B102'].value==100)
    app=get_application_definition(app['id']);spec=app['draft']
    spec['allowed_roles']=['Desk User'];spec['bindings']=[{'kind':'datasets','resource_id':object_id,'owner_domain':app['id'],'version':'1'}]
    saved=save_application_draft(app['id'],spec,app['draft_revision']);publish_application_definition(app['id'],saved['draft_revision'])
    email='sheet-query-'+frappe.generate_hash(length=10)+'@example.invalid';people.append(email)
    frappe.get_doc({'doctype':'User','email':email,'first_name':'表格查询回归','send_welcome_email':0,'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
    frappe.db.commit();frappe.set_user(email)
    own=execute_registered_action('platform.object.create',{'object_id':object_id,'expected_revision':1,'values':{'title':'本人记录'}},True,frappe.generate_hash(length=24))['result']
    frappe.set_user('Administrator')
    execute_registered_action('platform.object.update',{'object_id':object_id,'expected_revision':1,'name':own['name'],'expected_modified':own['modified'],'values':{'private_note':'不能搜索的秘密'}},True,frappe.generate_hash(length=24))
    frappe.set_user(email)
    check('总数仍按本人记录授权',query_object_records(object_id)['total']==1)
    check('员工对象视图不宣称可导入', not query_object_records(object_id)['object']['import']['available'])
    rejected('未批准的员工导出权限不因可读而自动开放',lambda:export(),frappe.PermissionError)
    check('其他人的关键词不泄漏数量',query_object_records(object_id,{'$search':'跨页物品'})['total']==0)
    check('本人记录的隐藏字段也不参与搜索',query_object_records(object_id,{'$search':'不能搜索的秘密'})['total']==0)
    rejected('隐藏字段不能排序推断值',lambda:query_object_records(object_id,{'$sort':'private_note'}),frappe.ValidationError)
    rejected('隐藏字段不能精确筛选',lambda:query_object_records(object_id,{'private_note':'不能搜索的秘密'}),frappe.ValidationError)
    check('能力投影不含隐藏字段','private_note' not in query_object_records(object_id)['object']['query']['search_fields'])
    private_history=history(own['name'])
    check('历史按当前权限隐藏字段名及前后值','private_note' not in json.dumps(private_history) and '不能搜索的秘密' not in json.dumps(private_history,ensure_ascii=False))
    rejected('不能借历史访问别人的记录',lambda:history(name),frappe.PermissionError)
    check('同一行不同操作者可区分',len({item['actor'] for item in private_history['items']})==2)
    audit_doc=frappe.get_doc('Shangshu Action Execution Audit',private_history['items'][0]['id'])
    rejected('普通员工不能从底层读取完整字段历史',lambda:audit_doc.check_permission('read'),frappe.PermissionError)
    rejected('普通员工不能删除历史',lambda:frappe.delete_doc('Shangshu Action Execution Audit',audit_doc.name),frappe.PermissionError)
    lifecycle_payload={'object_id':object_id,'expected_revision':1,'name':own['name'],
                       'expected_modified':get_object_record(object_id,own['name'])['record']['modified']}
    check('既有写权限不自动获得回收权限','recycle' not in query_object_records(object_id)['object']['operations'])
    rejected('未授权员工不能调用回收',lambda:execute_registered_action('platform.object.recycle',lifecycle_payload,True,frappe.generate_hash(length=24)),frappe.PermissionError)
    frappe.set_user('Administrator')
    check('管理员受管普通表声明可恢复回收','recycle' in query_object_records(object_id)['object']['operations'])
    recycle_key=frappe.generate_hash(length=24)
    recycled=execute_registered_action('platform.object.recycle',lifecycle_payload,True,recycle_key)
    check('默认查询排除已回收记录',query_object_records(object_id,{'title':'本人记录'})['total']==0)
    trash=query_object_records(object_id,{'$scope':'trash'})
    check('回收站保留原值和服务端回收时间',trash['total']==1 and trash['rows'][0]['name']==own['name'] and trash['rows'][0]['title']=='本人记录' and bool(trash['rows'][0]['_lifecycle']['recycled_at']))
    check('回收时间带站点时区，页面不猜时间',datetime.fromisoformat(trash['rows'][0]['_lifecycle']['recycled_at']).utcoffset() is not None)
    rejected('原详情入口不能继续办理回收行',lambda:get_object_record(object_id,own['name']),frappe.ValidationError)
    rejected('回收行不能被普通更新复活',lambda:execute_registered_action('platform.object.update',{**lifecycle_payload,'expected_modified':recycled['result']['modified'],'values':{'title':'非法复活'}},True,frappe.generate_hash(length=24)),frappe.ValidationError)
    replay=execute_registered_action('platform.object.recycle',lifecycle_payload,True,recycle_key)
    check('回收重试只有一次实际操作',replay['idempotent'] and replay['result']['modified']==recycled['result']['modified'])
    rejected('旧版本不能恢复',lambda:execute_registered_action('platform.object.restore',lifecycle_payload,True,frappe.generate_hash(length=24)),frappe.TimestampMismatchError)
    restored=execute_registered_action('platform.object.restore',{**lifecycle_payload,'expected_modified':recycled['result']['modified']},True,frappe.generate_hash(length=24))
    check('恢复原行而不是新建替代记录',restored['result']['name']==own['name'] and get_object_record(object_id,own['name'])['record']['title']=='本人记录' and query_object_records(object_id,{'$scope':'trash'})['total']==0)
    check('回收和恢复沿用同一记录审计',history(own['name'])['items'][0]['operation']=='restore' and history(own['name'])['items'][1]['operation']=='recycle')
    frappe.set_user(email)
    rejected('未批准回收角色不能列出回收站',lambda:query_object_records(object_id,{'$scope':'trash'}),frappe.PermissionError)
    frappe.set_user('Administrator')
    rejected('回收仍要求显式确认',lambda:execute_registered_action('platform.object.recycle',{**lifecycle_payload,'expected_modified':restored['result']['modified']},False,frappe.generate_hash(length=24)),frappe.ValidationError)
    with patch.object(Document,'insert',fail_audit):
        rejected('回收审计失败时状态回滚',lambda:execute_registered_action('platform.object.recycle',{**lifecycle_payload,'expected_modified':restored['result']['modified']},True,frappe.generate_hash(length=24)),frappe.ValidationError)
    check('回收失败不改变在用记录',get_object_record(object_id,own['name'])['record']['title']=='本人记录')
    def table(title,fields,**extra):
        schema={'schema_version':1,'title':title,'fields':fields,**extra}
        planned=prepare_object_change(app['id'],schema,frappe.generate_hash(length=24))
        frappe.db.commit();execute_object_change(planned['id'],True)
        return planned['object_id']
    def create(target,values):
        return execute_registered_action('platform.object.create',{'object_id':target,'expected_revision':1,'values':values},True,frappe.generate_hash(length=24))['result']
    def state(target,record,operation='recycle'):
        return execute_registered_action('platform.object.'+operation,{'object_id':target,'expected_revision':1,'name':record['name'],'expected_modified':record['modified']},True,frappe.generate_hash(length=24))['result']
    linked_id=table('引用表',[{'id':'supplier','label':'供应商','type':'reference','target':object_id}])
    check('关联表不宣称支持标量导入', not query_object_records(linked_id)['object']['import']['available'])
    linked=create(linked_id,{'supplier':own['name']})
    rejected('在用主表引用阻止回收目标',lambda:state(object_id,restored['result']),frappe.ValidationError)
    recycled_link=state(linked_id,linked)
    recycled_target=state(object_id,restored['result'])
    rejected('禁止建立指向已回收记录的新关联',lambda:create(linked_id,{'supplier':own['name']}),frappe.ValidationError)
    rejected('目标回收时不能恢复引用记录',lambda:state(linked_id,recycled_link,'restore'),frappe.ValidationError)
    restored_target=state(object_id,recycled_target,'restore')
    restored_link=state(linked_id,recycled_link,'restore')
    check('按目标再引用顺序恢复，原关联值保留',get_object_record(linked_id,linked['name'])['record']['supplier']==own['name'])
    state(linked_id,restored_link)
    child_id=table('采购明细',[{'id':'supplier','label':'供应商','type':'reference','target':object_id},{'id':'amount','label':'数量','type':'integer'}],kind='detail')
    master_id=table('明细主表',[{'id':'items','label':'明细','type':'detail','target':child_id}])
    master=create(master_id,{'items':[{'supplier':own['name'],'amount':7}]})
    before_items=get_object_record(master_id,master['name'])['record']['items']
    rejected('在用明细引用同样阻止回收目标',lambda:state(object_id,restored_target),frappe.ValidationError)
    master_trash=state(master_id,master)
    state(master_id,master_trash,'restore')
    check('明细回收恢复保留原行 ID 和全部值',get_object_record(master_id,master['name'])['record']['items']==before_items)
    # 明确授权的新测试对象：不改用户真实账号权限，不扩大现有对象权限。
    permitted_id=table('本人回收授权',[{'id':'title','label':'名称','type':'text'}],access={'read_roles':['Desk User'],'write_roles':['Desk User'],'recycle_roles':['Desk User'],'record_scope':'own'})
    app=get_application_definition(app['id']);spec=app['draft'];spec['bindings'].append({'kind':'datasets','resource_id':permitted_id,'owner_domain':app['id'],'version':'1'})
    saved=save_application_draft(app['id'],spec,app['draft_revision']);publish_application_definition(app['id'],saved['draft_revision'])
    admin_owned=create(permitted_id,{'title':'管理员的记录'})
    frappe.set_user(email);employee_owned=create(permitted_id,{'title':'明确允许的本人回收'})
    rejected('有回收角色也不能回收别人的记录',lambda:state(permitted_id,admin_owned),frappe.PermissionError)
    employee_trash=state(permitted_id,employee_owned)
    check('明确授权员工能回收且仅见本人回收行',query_object_records(permitted_id,{'$scope':'trash'})['total']==1 and query_object_records(permitted_id)['total']==0)
    state(permitted_id,employee_trash,'restore')
    check('明确授权员工恢复后原归属不变',query_object_records(permitted_id)['total']==1)
    frappe.set_user('Administrator')
    # 模拟旧表定义，迁移只补内部字段，不改变原业务值、归属或版本。
    legacy=table('旧表回收升级',[{'id':'title','label':'名称','type':'text'}])
    old_record=create(legacy,{'title':'升级前记录'});frappe.db.commit()
    physical=frappe.db.get_value('Shangshu Object Model',legacy,'physical_doctype')
    old_type=frappe.get_doc('DocType',physical);old_type.set('fields',[f for f in old_type.fields if not f.fieldname.startswith('ss_recycled')]);old_type.save(ignore_permissions=True);frappe.db.commit();frappe.clear_cache(doctype=physical)
    check('未迁移旧表不虚报回收能力','recycle' not in query_object_records(legacy)['object']['operations'])
    before=frappe.db.get_value(physical,old_record['name'],['owner','modified'],as_dict=True)
    from shangshu_core.record_lifecycle import migrate_record_lifecycle
    migrate_record_lifecycle()
    check('旧表迁移保留业务值和归属/modified',get_object_record(legacy,old_record['name'])['record']['title']=='升级前记录' and frappe.db.get_value(physical,old_record['name'],['owner','modified'],as_dict=True)==before)
    check('旧表升级后可回收','recycle' in query_object_records(legacy)['object']['operations'])
    legacy_trash=state(legacy,old_record)
    # 字段迁移仍允许回收内部列，不能覆盖/丢失回收状态。
    planned=prepare_object_change(app['id'],{'schema_version':1,'title':'旧表回收升级','fields':[{'id':'title','label':'名称','type':'text'},{'id':'memo','label':'备注','type':'text'}]},frappe.generate_hash(length=24),legacy,1)
    frappe.db.commit();execute_object_change(planned['id'],True)
    check('后续改字段保留已回收记录状态',query_object_records(legacy)['total']==0 and query_object_records(legacy,{'$scope':'trash'})['total']==1)
    # 两个真实连接先建立旧快照，再交错提交：不是用 mock 冒充并发保护。
    import threading
    def interleave(label,target,main_operation,worker_operation,snapshot_object=None):
        frappe.db.commit()
        ready=threading.Event();start=threading.Event();done=threading.Event();outcome=[]
        def worker():
            frappe.init(site='b-test.localhost',sites_path=str(root/'sites'));frappe.connect();frappe.set_user('Administrator')
            try:
                get_object_record(snapshot_object or object_id,target['name'])  # 刻意建立提交前的旧快照。
                ready.set()
                if not start.wait(10):raise RuntimeError('并发测试未放行')
                worker_operation();outcome.append('unexpected-success')
            except frappe.ValidationError:outcome.append('rejected')
            except Exception as error:outcome.append(type(error).__name__+':'+str(error))
            finally:frappe.db.rollback();frappe.destroy();done.set()
        thread=threading.Thread(target=worker,daemon=True);thread.start()
        try:
            if not ready.wait(10):raise RuntimeError('并发连接未就绪')
            main_operation();start.set()
            check(label+'：竞争操作等待提交',not done.wait(.2))
            frappe.db.commit();thread.join(10)
            check(label+'：旧快照不能穿透',done.is_set() and outcome==['rejected'])
        finally:
            start.set();frappe.db.rollback();thread.join(10)
    concurrent_target=create(object_id,{'title':'并发回收目标'})
    interleave('先回收再建引用',concurrent_target,lambda:state(object_id,concurrent_target),lambda:create(linked_id,{'supplier':concurrent_target['name']}))
    concurrent_target=create(object_id,{'title':'并发引用目标'})
    interleave('先建引用再回收',concurrent_target,lambda:create(linked_id,{'supplier':concurrent_target['name']}),lambda:state(object_id,concurrent_target))
    # 导入只复用公共预检/确认动作；预检与取消不得出现半批写入。
    import_id=table('XLSX 导入回归',[
        {'id':'code','label':'案号','type':'text','required':True},
        {'id':'title','label':'名称','type':'text','required':True},
        {'id':'quantity','label':'数量','type':'decimal'},
        {'id':'date','label':'日期','type':'date'}])
    from openpyxl import Workbook
    def import_payload(rows):
        book=Workbook();sheet=book.active;sheet.title='采购'
        sheet.append(['案号','名称','数量','日期'])
        for row in rows:sheet.append(row)
        stream=BytesIO();book.save(stream);book.close()
        return {'object_id':import_id,'expected_revision':1,'filename':'采购.xlsx',
            'content_base64':base64.b64encode(stream.getvalue()).decode(),
            'sheet':'采购','header_row':1,'mapping':{'code':1,'title':2,'quantity':3,'date':4},'match_field':'code'}
    def preview_import(payload):return invoke_domain_service('platform.object.import_preview',payload)
    def apply_import(payload,preview,key=None):
        return execute_registered_action('platform.object.import',{**payload,'preview_hash':preview['preview_hash']},True,key or frappe.generate_hash(length=24))
    sample=import_payload([[f'{i:05d}',f'导入名称{i}',12.5,'2026-09-21'] for i in range(20)])
    inspect={k:v for k,v in sample.items() if k in ('filename','content_base64','sheet','header_row')}
    inspect['inspect_only']=True
    inspected=invoke_domain_service('platform.object.import_preview',inspect)
    check('新建表前可检查表头，不要求存在目标表',len(inspected['columns'])==4 and len(inspected['sample'])==10)
    rejected('只读文件检查不得夹带对象映射',lambda:invoke_domain_service('platform.object.import_preview',{**inspect,'mapping':{'title':2}}),frappe.ValidationError)
    preview=preview_import(sample)
    check('导入预检列出新增范围且零写入',preview['summary']=={'create':20,'update':0,'unchanged':0,'errors':0} and query_object_records(import_id)['total']==0)
    rejected('导入缺确认拒绝',lambda:execute_registered_action('platform.object.import',{**sample,'preview_hash':preview['preview_hash']},False,frappe.generate_hash(length=24)),frappe.ValidationError)
    import_key=frappe.generate_hash(length=24);receipt=apply_import(sample,preview,import_key)
    check('20 行导入原记录链，前导零/数字/日期保留',query_object_records(import_id)['total']==20 and query_object_records(import_id,{'code':'00000'})['rows'][0]['date']=='2026-09-21')
    apply_import(sample,preview,import_key)
    check('同请求重试不重复导入',query_object_records(import_id)['total']==20)
    same=preview_import(sample)
    check('同文件再次预检不重复新增',same['summary']=={'create':0,'update':0,'unchanged':20,'errors':0})
    updated=import_payload([['00000','导入修改',13,'2026-09-22'],['NEW','新记录',1,None]])
    planned=preview_import(updated)
    check('按明确匹配列预览新增与具体更新',planned['summary']['create']==1 and planned['summary']['update']==1 and any(c['field']=='title' and c['before']=='导入名称0' and c['after']=='导入修改' for c in planned['rows'][0]['changes']))
    apply_import(updated,planned)
    updated_row=query_object_records(import_id,{'code':'00000'})['rows'][0]
    imported_history=invoke_domain_service('platform.object.history',{'object_id':import_id,'name':updated_row['name']})
    check('导入沿用逐行审计且来源不可混成人工修改',imported_history['total']==2 and all(item.get('source')=='import' for item in imported_history['items']))
    bad=import_payload([['ERR1','坏日期',1,'2026-02-30'],['ERR2','坏数字','abc',None],[None,'缺案号',1,None]])
    errors=preview_import(bad)
    check('错误按工作表/行/列定位且整批未写',len(errors['errors'])==3 and {e['row'] for e in errors['errors']}=={2,3,4} and all(e['sheet']=='采购' and e['column'] for e in errors['errors']) and query_object_records(import_id)['total']==21)
    rejected('带错误的预检不能强行提交',lambda:apply_import(bad,errors),frappe.ValidationError)
    duplicate=preview_import(import_payload([['DUP','一',1,None],['DUP','二',2,None]]))
    check('文件内重复匹配值拒绝任意覆盖',duplicate['summary']['errors']>0)
    create(import_id,{'code':'00000','title':'重复旧值'})
    duplicate_existing=preview_import(updated)
    check('目标匹配列不唯一拒绝更新',duplicate_existing['summary']['errors']>0)
    stale_data=import_payload([['NEW','应被并发保护',1,None]])
    stale_plan=preview_import(stale_data)
    current=query_object_records(import_id,{'code':'NEW'})['rows'][0]
    execute_registered_action('platform.object.update',{'object_id':import_id,'expected_revision':1,'name':current['name'],'expected_modified':current['modified'],'values':{'title':'他人最新值'}},True,frappe.generate_hash(length=24))
    rejected('预检后记录变化要求重新核对而非覆盖',lambda:apply_import(stale_data,stale_plan),frappe.TimestampMismatchError)
    rollback=import_payload([['ROLL1','前行',1,None],['ROLL2','后行',2,None]])
    rollback_plan=preview_import(rollback)
    with patch.object(Document,'insert',fail_audit):
        rejected('导入审计失败回滚整批',lambda:apply_import(rollback,rollback_plan),frappe.ValidationError)
    check('失败导入无前行残留',query_object_records(import_id,{'code':'ROLL1'})['total']==0)
    audit_calls=[]
    def fail_second_import_audit(doc,*args,**kwargs):
        if doc.doctype=='Shangshu Action Execution Audit':
            audit_calls.append(doc.name)
            if len(audit_calls)==2:frappe.throw('第二行审计失败',frappe.ValidationError)
        return original_insert(doc,*args,**kwargs)
    audit_count=frappe.db.count('Shangshu Action Execution Audit')
    with patch.object(Document,'insert',fail_second_import_audit):
        rejected('后行失败同时回滚前行及其审计',lambda:apply_import(rollback,rollback_plan),frappe.ValidationError)
    check('前行数据与成功审计均无残留',query_object_records(import_id,{'code':'ROLL1'})['total']==0 and frappe.db.count('Shangshu Action Execution Audit')==audit_count)
    other=import_payload([['RACE','先预检的新行',1,None]])
    other_plan=preview_import(other)
    create(import_id,{'code':'RACE','title':'后来新增'})
    rejected('预检后出现相同匹配值不得变成静默更新',lambda:apply_import(other,other_plan),frappe.TimestampMismatchError)
    recycled=create(import_id,{'code':'TRASH','title':'已回收'})
    state(import_id,recycled)
    check('导入不能绕过回收站创建同匹配值替身',preview_import(import_payload([['TRASH','替身',1,None]]))['summary']['errors']>0)
    only_title={**import_payload([['X','名称',1,None]]),'mapping':{'title':2},'match_field':'title'}
    check('新增缺少必填列映射明确指出字段',any(e.get('field')=='code' for e in preview_import(only_title)['errors']))
    manual=query_object_records(import_id,{'code':'NEW'})['rows'][0]
    execute_registered_action('platform.object.update',{'object_id':import_id,'expected_revision':1,'name':manual['name'],'expected_modified':manual['modified'],'values':{'title':'人工普通修改'}},True,frappe.generate_hash(length=24),source='import')
    check('HTTP 自报 source 不能伪造导入历史',invoke_domain_service('platform.object.history',{'object_id':import_id,'name':manual['name']})['items'][0]['source']=='record')
    race_file=import_payload([['NEW','并发导入值',1,None]])
    race_plan=preview_import(race_file)
    latest=query_object_records(import_id,{'code':'NEW'})['rows'][0]
    interleave('导入等待人工修改提交',latest,
        lambda:execute_registered_action('platform.object.update',{'object_id':import_id,'expected_revision':1,'name':latest['name'],'expected_modified':latest['modified'],'values':{'title':'并发最新值'}},True,frappe.generate_hash(length=24)),
        lambda:apply_import(race_file,race_plan),snapshot_object=import_id)
    check('并发失败导入保留人工最新值',query_object_records(import_id,{'code':'NEW'})['rows'][0]['title']=='并发最新值')
    frappe.set_user(email)
    rejected('未明确授权员工导入不会顺带扩权',lambda:preview_import(sample),frappe.PermissionError)
    frappe.set_user('Administrator')
finally:
    # 专用回归库保留受管审计/DDL 证据；未发布草稿不进入员工应用目录。
    # 原启停接口不接受未发布应用，不伪造发布仅为了停用。
    if app:
        frappe.set_user('Administrator')
        current = get_application_definition(app['id'])
        if current['status'] == 'Published':
            set_application_enabled(app['id'], False, '自动回归结束，收起测试应用', current['draft_revision'])
            from shangshu_core.model_records import list_definitions
            check('停用应用从管理员日常表格目录收起，不删除模型和记录',not any(item['owner']==app['id'] for item in list_definitions()) and bool(frappe.db.exists('Shangshu Object Model',object_id)))
        else:
            print('自动回归草稿保留于专用库，未发布：'+app['id'])
    for email in people:
        for identity in frappe.get_all('Shangshu Identity',filters={'user':email},pluck='name'):
            frappe.delete_doc('Shangshu Identity',identity,ignore_permissions=True,force=True)
        if frappe.db.exists('User',email):frappe.delete_doc('User',email,ignore_permissions=True,force=True)
    frappe.db.commit(); frappe.destroy()
print(f'通过 {sum(ok for _, ok in checks)}/{len(checks)}')
raise SystemExit(0 if all(ok for _, ok in checks) else 1)
