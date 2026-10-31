"""D：旧代码建站/备份，新代码重复迁移、旧实例续办与异库恢复。

模式分进程运行以验证重启加载。仅用于独立自动回归根目录，绝不恢复覆盖原库。
"""
import getpass,json,os,sys
from pathlib import Path

root=Path(sys.argv[1]).resolve();mode=sys.argv[2]
if root.parent!=Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root/'ACCEPTANCE_ONLY').exists():raise SystemExit('拒绝非自动回归站')
source=Path(sys.argv[3]).resolve() if mode=='seed' and len(sys.argv)>3 else Path(__file__).resolve().parents[1]
for app in ('shangshu_core','shangshu_finance','shangshu_warehouse','shangshu_orders'):sys.path.insert(0,str(source/'frappe_apps'/app))
os.chdir(root/'sites')
import frappe
from frappe.installer import _new_site
SITE='d-upgrade.localhost';RESTORE='d-restore.localhost'
getpass.getpass=lambda prompt:''

def connect(site=SITE):
    frappe.init(site=site);frappe.connect();frappe.set_user('Administrator')
def boundary(site=SITE):
    frappe.db.commit();frappe.destroy();connect(site)

if mode=='seed':
    if Path(SITE).exists():raise SystemExit('旧版本源站已存在，不覆盖')
    frappe.init(site=SITE,new_site=True)
    _new_site(db_name='shangshu_d_upgrade',site=SITE,db_root_username='root',db_root_password='',
              admin_password='d-local-only',db_type='mariadb',db_socket=str(root/'db.sock'),
              install_apps=['shangshu_core','shangshu_finance','shangshu_warehouse','shangshu_orders'],force=False)
    frappe.set_user('Administrator')
    from shangshu_core.public_api import create_application_definition,prepare_object_change,execute_object_change,save_application_draft,publish_application_definition
    from shangshu_core.process_portal import launch_process
    app=create_application_definition('升级验收采购','d-upgrade-app')
    plan=prepare_object_change(app['id'],{'schema_version':1,'title':'采购申请','kind':'record','fields':[
        {'id':'title','label':'事项','type':'text','required':True},{'id':'amount','label':'金额','type':'decimal','required':True}]},'d-upgrade-model')
    boundary();execute_object_change(plan['id'],True);boundary()
    spec={**app['draft'],'bindings':[{'kind':'datasets','resource_id':plan['object_id'],'owner_domain':app['id'],'version':'1'}],
          'pages':[{'id':'request','title':'采购申请','object_id':plan['object_id'],'fields':['title','amount']}],
          'workflows':[{'id':'approval','title':'采购审批','form_id':'request','approver_role':'System Manager'}]}
    saved=save_application_draft(app['id'],spec,1);publish_application_definition(app['id'],saved['draft_revision']);boundary()
    launch_process(app['id']+'.process.approval',{'title':'升级前待审批','amount':120},'d-upgrade-instance',True);boundary()
    assert not frappe.db.exists('Shangshu Action Definition',{'action_id':'platform.application.configure'})
    from frappe.utils.backups import new_backup
    backup=new_backup(ignore_files=False,force=True)
    print('PASS: C 基线旧实例与备份已建立；备份文件位于独立站 private/backups',flush=True)
    frappe.destroy()
elif mode=='migrate':
    from frappe.migrate import SiteMigration
    for index in range(2):
        SiteMigration(skip_search_index=True).run(SITE)
        print('PASS: migrate',index+1,flush=True)
    connect()
    from shangshu_core.public_api import get_application_definition,save_application_draft,invoke_domain_service
    name=frappe.db.get_value('Shangshu Application Definition',{'creation_key':'d-upgrade-app'},'name')
    # 创建幂等键存储形式可能版本化，标题仅用于此独立合成站的只读定位。
    if not name:name=frappe.db.get_value('Shangshu Application Definition',{'title':'升级验收采购'},'name')
    if not name:
        rows=frappe.get_all('Shangshu Application Definition',pluck='name');name=next(item for item in rows if get_application_definition(item)['draft']['title']=='升级验收采购')
    app=get_application_definition(name)
    assert save_application_draft(name,app['draft'],app['draft_revision'])['draft_revision']==app['draft_revision']
    exported=invoke_domain_service('platform.application.delivery',{'application_id':name,'operation':'export'})
    assert len(exported['package']['models'])==1
    from shangshu_core.process_portal import get_process_task,complete_process_task
    instances=frappe.get_all('Shangshu Process Instance',filters={'status':'Running'},pluck='name')
    assert instances
    for instance in instances:
        task=get_process_task(instance)['task']
        choice=next(item['id'] for item in task['choices'] if item['title']=='通过')
        complete_process_task(instance,task['node_id'],{},'d-upgrade-approve-'+instance,choice,True)
        assert get_process_task(instance)['instance']['status']=='Completed'
    boundary();print('PASS: 旧草稿保存兼容、定义导出和升级前在途实例续办',flush=True);frappe.destroy()
elif mode=='restore':
    if Path(RESTORE).exists():raise SystemExit('恢复目标已存在，不覆盖')
    backups=sorted((Path(SITE)/'private/backups').glob('*database.sql.gz'))
    if len(backups)!=1:raise SystemExit('恢复备份目标不唯一')
    frappe.init(site=RESTORE,new_site=True)
    _new_site(db_name='shangshu_d_restore',site=RESTORE,db_root_username='root',db_root_password='',
              admin_password='d-local-only',db_type='mariadb',db_socket=str(root/'db.sock'),
              source_sql=str(backups[0].resolve()),install_apps=[],force=False)
    frappe.destroy()
    from frappe.migrate import SiteMigration
    SiteMigration(skip_search_index=True).run(RESTORE)
    connect(RESTORE)
    assert frappe.db.count('Shangshu Process Instance',{'status':'Running'})==1
    assert frappe.db.exists('Shangshu Action Definition',{'action_id':'platform.application.configure'})
    print('PASS: 异库恢复后保留升级前待审批状态，新版本迁移成功；未覆盖源库',flush=True)
    frappe.destroy()
elif mode=='files':
    files_site='d-files-verified.localhost'
    if Path(files_site).exists():raise SystemExit('文件恢复目标已存在，不覆盖')
    connect()
    files=[]
    for private in (0,1):
        content='D 合成附件 '+str(private)
        doc=frappe.get_doc({'doctype':'File','file_name':'d-fixture-'+str(private)+'.txt','is_private':private,'content':content}).save(ignore_permissions=True)
        files.append((doc.name,content,private))
    frappe.db.commit()
    from frappe.utils.backups import new_backup
    backup=new_backup(ignore_files=False,force=True)
    paths=[str(Path(item).resolve()) for item in (backup.backup_path_db,backup.backup_path_files,backup.backup_path_private_files)]
    from prepare_restore_backup import prepare
    portable=Path(paths[0]).with_name('portable-'+Path(paths[0]).name)
    assert prepare(paths[0],portable)>0
    paths[0]=str(portable)
    frappe.destroy();frappe.init(site=files_site,new_site=True)
    _new_site(db_name='shangshu_d_files_verified',site=files_site,db_root_username='root',db_root_password='',
              admin_password='d-local-only',db_type='mariadb',db_socket=str(root/'db.sock'),source_sql=paths[0],install_apps=[],force=False)
    frappe.destroy()
    from frappe.installer import extract_files
    for archive in paths[1:]:extract_files(files_site,archive)
    connect(files_site)
    for name,content,private in files:
        doc=frappe.get_doc('File',name);actual=doc.get_content()
        if isinstance(actual,bytes):actual=actual.decode()
        assert actual==content and doc.is_private==private
    print('PASS: 数据库、公有附件、私有附件恢复后内容和私有标记一致；未覆盖源站',flush=True)
    frappe.destroy()
elif mode=='verify-files':
    connect('d-files-verified.localhost')
    triggers=frappe.db.sql('SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()',as_dict=True)
    assert triggers and all(row.DEFINER.startswith('shangshu_d_files_verified@') for row in triggers)
    assert frappe.db.count('Shangshu Process Definition Version')>0
    try:frappe.db.sql('UPDATE `tabShangshu Process Definition Version` SET name=name LIMIT 1')
    except Exception as error:assert '不可变记录禁止 UPDATE' in str(error)
    else:raise AssertionError('恢复后不可变版本保护失效')
    frappe.db.rollback();frappe.destroy();print('PASS: 恢复后触发器归目标账号，不可变历史更新仍被数据库拒绝',flush=True)
elif mode in {'import','acceptance'}:
    destination=RESTORE if mode=='import' else 'd-acceptance.localhost'
    if mode=='acceptance':
        if Path(destination).exists():raise SystemExit('验收目标已存在，不覆盖')
        frappe.init(site=destination,new_site=True)
        _new_site(db_name='shangshu_d_acceptance',site=destination,db_root_username='root',db_root_password='',
                  admin_password='d-local-only',db_type='mariadb',db_socket=str(root/'db.sock'),
                  install_apps=['shangshu_core','shangshu_finance','shangshu_warehouse','shangshu_orders'],force=False)
        frappe.destroy()
    connect(destination)
    from shangshu_core.public_api import create_application_definition,invoke_domain_service,prepare_object_change,execute_object_change,execute_registered_action,publish_application_definition
    package=json.loads(Path(sys.argv[3]).read_text())
    target=create_application_definition('采购管理','d-cross-site-import');boundary(destination)
    preview=invoke_domain_service('platform.application.delivery',{'operation':'import_preview','application_id':target['id'],'package':package})
    for model in preview['models']:
        plan=prepare_object_change(target['id'],model['definition'],model['idempotency_key']);boundary(destination)
        execute_object_change(plan['id'],True);boundary(destination)
    saved=execute_registered_action('platform.application.configure',{'application_id':target['id'],'expected_revision':1,
        'definition':preview['definition'],'dependency_hash':preview['dependency_hash']},confirmed=True,idempotency_key='d-cross-site-save')
    publish_application_definition(target['id'],saved['result']['draft_revision']);boundary(destination)
    if mode=='acceptance':
        print('验收专用站已创建；5 个应用、1 个采购模型、无业务测试记录：',destination,flush=True)
        frappe.destroy();raise SystemExit(0)
    from shangshu_core.process_portal import launch_process,get_process_task,complete_process_task
    instance=launch_process(target['id']+'.process.approval',{'title':'跨站导入后申请','amount':100},'d-cross-site-process',True)['name']
    task=get_process_task(instance)['task'];choice=next(item['id'] for item in task['choices'] if item['title']=='通过')
    complete_process_task(instance,task['node_id'],{},'d-cross-site-approve',choice,True)
    assert get_process_task(instance)['instance']['status']=='Completed'
    boundary(destination);print('PASS: 跨数据库定义导入、建表、发布、表单发起与审批完成',flush=True);frappe.destroy()
else:raise SystemExit('未知模式')
