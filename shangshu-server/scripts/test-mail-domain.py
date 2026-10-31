"""邮件草稿真实链：只在独立自动回归站建夹具，不外接、不发送。"""
import os as _os, sys as _sys
_sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tests')
                if os.path.basename(os.path.dirname(os.path.abspath(__file__))) != 'tests'
                else os.path.dirname(os.path.abspath(__file__)))
import _ss_fixture  # noqa: E402  测试夹具默认归属（**不是产品默认**）
import json
import base64
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
from shangshu_mail.domain import DOMAIN
apps_txt = root / 'sites/apps.txt'
installed = apps_txt.read_text().split()
if 'shangshu_mail' not in installed:
    apps_txt.write_text('\n'.join(installed + ['shangshu_mail']) + '\n')
os.chdir(root / 'sites')
import frappe
frappe.init(site='b-test.localhost', sites_path=str(root / 'sites')); frappe.connect(); frappe.set_user('Administrator')
from shangshu_core.public_api import execute_registered_action, invoke_domain_service, query_dataset, set_domain_enabled
if 'shangshu_mail' not in frappe.get_installed_apps():
    from frappe.installer import install_app
    install_app('shangshu_mail', force=True)
frappe.setup_module_map(include_all_apps=True)
frappe.reload_doc('shangshu_mail','doctype','shangshu_mail_message',force=True)
frappe.reload_doc('shangshu_mail','doctype','shangshu_mail_account',force=True)
from shangshu_mail.install import setup
setup(); frappe.db.commit()
checks = []
created = []
created_proposals = []
source_files = []
people = ['mail-'+frappe.generate_hash(length=10)+'@example.invalid' for _ in range(2)]
def check(label, ok):
    checks.append(bool(ok)); print(('✓ ' if ok else '✗ ')+label)
def act(action, payload, key=None):
    payload = _ss_fixture.fill(action, payload)  # 夹具默认归属（不是产品默认）
    return execute_registered_action(action, payload, True, key or frappe.generate_hash(length=24))['result']
def denied(label, operation):
    try: operation()
    except (frappe.PermissionError, frappe.ValidationError, frappe.TimestampMismatchError): check(label, True)
    else: check(label, False)
def detail(name):
    return invoke_domain_service('mail.detail', {'mail': name})
try:
    for email in people:
        frappe.get_doc({'doctype':'User','email':email,'first_name':'邮件自动回归','send_welcome_email':0,
                        'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
    frappe.db.commit(); frappe.set_user(people[0])
    payload={'subject':'真实草稿','body':'尚未发送的正文','to':['张工 <reader@example.invalid>'],'cc':['财务 <finance@example.invalid>']}
    key=frappe.generate_hash(length=24)
    first_result=execute_registered_action('mail.save_draft',payload,True,key)
    first=first_result['result']; created.append(first['name'])
    check('写入走公共执行审计',bool(first_result.get('audit')))
    denied('未确认不能写入',lambda:execute_registered_action('mail.save_draft',payload,False,frappe.generate_hash(length=24)))
    check('草稿真正落库',detail(first['name'])['mail']['body']==payload['body'])
    check('收抄件人姓名与地址完整保存',detail(first['name'])['mail']['to']==payload['to'] and detail(first['name'])['mail']['cc']==payload['cc'])
    check('重试不重复创建',act('mail.save_draft',payload,key)['name']==first['name'])
    denied('修改必须带版本',lambda:act('mail.save_draft',{**payload,'mail':first['name']}))
    denied('筛选不能指定他人归属',lambda:query_dataset('mail.message',{'owner':people[1]},1,30))
    long_subject='长主题'*100
    extended=act('mail.save_draft',{**payload,'subject':long_subject});created.append(extended['name'])
    check('契约允许的长主题完整保存',detail(extended['name'])['mail']['subject']==long_subject)
    act('mail.recycle',{'mail':extended['name'],'expected_version':1})
    second=act('mail.save_draft',{**payload,'mail':first['name'],'expected_version':1,'body':'第二版'})
    check('更新递增版本',second['record_version']==2)
    denied('旧版本不得覆盖',lambda:act('mail.save_draft',{**payload,'mail':first['name'],'expected_version':1}))
    denied('非法邮箱拒绝',lambda:act('mail.save_draft',{**payload,'to':['bad\r\nBcc: victim@example.invalid']}))
    denied('显示名不能注入邮件头',lambda:act('mail.save_draft',{**payload,'to':['张工\r\nBcc: victim <reader@example.invalid>']}))
    denied('一个地址项不能夹带多个收件人',lambda:act('mail.save_draft',{**payload,'to':['张工 <reader@example.invalid>; victim@example.invalid']}))
    denied('空草稿拒绝',lambda:act('mail.save_draft',{'subject':'','body':'','to':[],'cc':[]}))
    check('目录仅见本人草稿',query_dataset('mail.message',{},1,30)['total']==1)
    frappe.db.commit(); frappe.set_user(people[1])
    check('其他员工目录不可见',query_dataset('mail.message',{},1,30)['total']==0)
    denied('其他员工不可读详情',lambda:detail(first['name']))
    denied('其他员工不可修改',lambda:act('mail.save_draft',{**payload,'mail':first['name'],'expected_version':2}))
    denied('直接写 DocType 不得绕过动作',lambda:frappe.get_doc({'doctype':'Shangshu Mail Message','subject':'绕过'}).insert(ignore_permissions=True))
    frappe.set_user(people[0])
    trash=act('mail.recycle',{'mail':first['name'],'expected_version':2})
    check('回收不是隐藏，状态真实落库',detail(first['name'])['mail']['status']=='Trash')
    check('回收站可查且正文保留',query_dataset('mail.message',{'scope':'trash'},1,30)['total']==2 and detail(first['name'])['mail']['body']=='第二版')
    denied('回收后不能继续改稿',lambda:act('mail.save_draft',{**payload,'mail':first['name'],'expected_version':trash['record_version']}))
    restored=act('mail.restore',{'mail':first['name'],'expected_version':trash['record_version']})
    check('恢复保留内容并递增版本',restored['record_version']==4 and detail(first['name'])['mail']['body']=='第二版')
    frappe.db.commit(); frappe.destroy()
    frappe.init(site='b-test.localhost',sites_path=str(root/'sites'));frappe.connect();frappe.set_user(people[0])
    check('重连后草稿不丢',detail(first['name'])['mail']['body']=='第二版')
    frappe.set_user('Administrator');set_domain_enabled(DOMAIN,False,'自动回归停用验证');frappe.db.commit()
    frappe.set_user(people[0]);denied('域停用拒绝查询',lambda:query_dataset('mail.message',{},1,30))
    denied('域停用拒绝写入',lambda:act('mail.save_draft',payload))
    frappe.set_user('Administrator');set_domain_enabled(DOMAIN,True,'附件回归继续');frappe.db.commit()
    frappe.set_user(people[0])
    source=act('files.upload',{'file_name':'邮件固定版本-'+frappe.generate_hash(length=8)+'.txt',
        'content_base64':base64.b64encode(b'attachment version one').decode(),'directory':'/','tags':[]})
    source_files.append(source['file'])
    source_file=frappe.db.get_value('Shangshu File Center File',source['file'],'current_file')
    with_attachment=act('mail.save_draft',{**payload,'attachments':[source_file],
        'attachment_labels':[{'file':source_file,'label':'第 1 版','name':'邮件显示原件.txt'}]})
    created.append(with_attachment['name'])
    bound=with_attachment['attachments'][0]
    check('保存返回来源到邮件引用映射与版本展示标签',with_attachment['attachment_bindings'][source_file]==bound['file'] and bound['label']=='第 1 版')
    check('邮件附件名保留选择快照，不显示存储防重名后缀',bound['name']=='邮件显示原件.txt')
    check('附件使用邮件自身挂载关系',bound['file']!=source_file and frappe.db.get_value('File',bound['file'],'attached_to_name')==with_attachment['name'])
    check('引用复用原字节，不复制存储',frappe.db.get_value('File',bound['file'],'file_url')==frappe.db.get_value('File',source_file,'file_url'))
    from io import BytesIO
    from zipfile import ZipFile
    docx=BytesIO()
    with ZipFile(docx,'w') as archive:archive.writestr('word/document.xml','<document><body><p><t>固定合同正文</t></p></body></document>')
    docx_source=act('files.upload',{'file_name':'合同-'+frappe.generate_hash(length=8)+'.docx','content_base64':base64.b64encode(docx.getvalue()).decode()})['file']
    source_files.append(docx_source)
    docx_mail=act('mail.save_draft',{**payload,'attachments':[frappe.db.get_value('Shangshu File Center File',docx_source,'current_file')]});created.append(docx_mail['name'])
    preview_payload={'ref_doctype':'Shangshu Mail Message','ref_name':docx_mail['name'],'file':docx_mail['attachments'][0]['file']}
    check('DOCX预览复用邮件绑定和权限',invoke_domain_service('platform.file.preview',preview_payload)['blocks'][0]['text']=='固定合同正文')
    check('列表只投影附件数量',query_dataset('mail.message',{},1,30)['rows'][0]['attachment_count']==1)
    def content(mail, file):
        from shangshu_core.public_api.http import file_content
        frappe.local.response=frappe._dict()
        file_content('Shangshu Mail Message',mail,file)
        value=frappe.local.response.filecontent
        return value.encode() if isinstance(value,str) else value
    check('保存重开可读固定内容',content(with_attachment['name'],bound['file'])==b'attachment version one')
    denied('下载不能把别的挂载冒充本邮件附件',lambda:content(first['name'],bound['file']))
    denied('附件数量上限在执行前拒绝',lambda:act('mail.save_draft',{**payload,'attachments':[source_file]*21}))
    again=act('mail.save_draft',{**payload,'mail':with_attachment['name'],'expected_version':1,'attachments':[source_file]})
    check('同一来源重选复用挂载而不堆副本',again['attachments'][0]['file']==bound['file'])
    act('files.new_version',{'file':source['file'],'content_base64':base64.b64encode(b'attachment version two').decode(),'note':'换版'})
    act('files.recycle',{'file':source['file']})
    check('来源换版回收不改变已选内容',content(with_attachment['name'],bound['file'])==b'attachment version one')
    frappe.db.commit();frappe.set_user(people[1])
    denied('他人不能下载邮件附件',lambda:content(with_attachment['name'],bound['file']))
    denied('他人不能转存邮件附件',lambda:act('mail.save_draft',{**payload,'attachments':[bound['file']]}))
    denied('他人不能通过预览服务读取DOCX',lambda:invoke_domain_service('platform.file.preview',preview_payload))
    frappe.set_user('Administrator');set_domain_enabled('com.shangshu.files',False,'附件独立性验证');frappe.db.commit()
    frappe.set_user(people[0])
    check('文件域停用后邮件附件独立读取',content(with_attachment['name'],bound['file'])==b'attachment version one')
    check('文件域停用不影响已绑定DOCX预览',invoke_domain_service('platform.file.preview',preview_payload)['blocks'][0]['text']=='固定合同正文')
    saved_again=act('mail.save_draft',{**payload,'mail':with_attachment['name'],'expected_version':2,'attachments':[bound['file']]})
    check('文件域停用后原邮件仍能保存',saved_again['record_version']==3)
    denied('不能借附件接口读停用域的新来源',lambda:act('mail.save_draft',{**payload,'attachments':[source_file]}))
    frappe.set_user('Administrator');set_domain_enabled('com.shangshu.files',True,'恢复附件来源');frappe.db.commit()
    frappe.set_user(people[0])
    from unittest.mock import patch
    from frappe.model.document import Document
    original_insert=Document.insert
    def reject_audit(doc,*args,**kwargs):
        if doc.doctype=='Shangshu Action Execution Audit':
            frappe.throw('附件审计回滚探针',frappe.ValidationError)
        return original_insert(doc,*args,**kwargs)
    # 使用公共执行器的审计失败，不能遗留半封邮件或附件挂载。
    before_mail=frappe.db.count('Shangshu Mail Message',{'owner':people[0]})
    before_refs=frappe.db.count('File',{'attached_to_doctype':'Shangshu Mail Message'})
    with patch.object(Document,'insert',reject_audit):
        denied('审计失败拒绝整次附件保存',lambda:act('mail.save_draft',{**payload,'attachments':[source_file]}))
    check('审计失败不留邮件和挂载',frappe.db.count('Shangshu Mail Message',{'owner':people[0]})==before_mail and frappe.db.count('File',{'attached_to_doctype':'Shangshu Mail Message'})==before_refs)
    without=act('mail.save_draft',{**payload,'mail':with_attachment['name'],'expected_version':3,'attachments':[]})
    check('移除附件不删除来源原件',not without['attachments'] and frappe.db.exists('File',source_file))
    preserved=act('mail.save_draft',{**payload,'attachments':[source_file]});created.append(preserved['name'])
    old_client=act('mail.save_draft',{**payload,'mail':preserved['name'],'expected_version':1})
    check('旧载荷省略附件字段保持已有引用',old_client['attachments']==preserved['attachments'])
    replay_key=frappe.generate_hash(length=24)
    replay_payload={**payload,'mail':preserved['name'],'expected_version':2,'attachments':[source_file]}
    copied=act('mail.save_draft',replay_payload,replay_key)
    check('附件保存重试同键返回同版引用',act('mail.save_draft',replay_payload,replay_key)==copied)
    only=act('mail.save_draft',{'subject':'','body':'','to':[],'cc':[],'attachments':[source_file]});created.append(only['name'])
    check('只有附件也能保存草稿',len(only['attachments'])==1)
    frappe.db.commit();frappe.set_user('Administrator');set_domain_enabled(DOMAIN,False,'邮件停用独立性验证');frappe.db.commit()
    frappe.set_user(people[0])
    denied('邮件停用后拒绝其绑定下载',lambda:content(preserved['name'],copied['attachments'][0]['file']))
    denied('邮件停用后DOCX预览不能绕过域边界',lambda:invoke_domain_service('platform.file.preview',preview_payload))
    from shangshu_core.public_api.http import file_content
    file_content('Shangshu File Center File',source['file'],source_file)
    check('邮件停用不影响来源文件下载',bool(frappe.local.response.filecontent))
    frappe.set_user('Administrator');set_domain_enabled(DOMAIN,True,'恢复邮件');frappe.db.commit();frappe.set_user(people[0])
    from shangshu_core.public_api import bind_record_attachments
    denied('没有受信动作不能直接建立挂载',lambda:bind_record_attachments('Shangshu Mail Message',with_attachment['name'],[source_file]))
    def wrong_target(*args):
        return bind_record_attachments('Shangshu File Center File',source['file'],[source_file])
    with patch('shangshu_mail.service.execute',wrong_target):
        denied('公共动作也不能替另一域挂载文件',lambda:act('mail.save_draft',payload))
    from shangshu_core.public_api import get_record_attachments
    denied('附件元信息投影也必须匹配所属记录',lambda:get_record_attachments('Shangshu Mail Message',first['name'],[bound['file']]))
    # 真数据库 + 受控服务商：验证公开动作/审计/事务/真实字节，不向外网发送。
    from shangshu_mail import account, transport
    from shangshu_core.public_api import list_registered_actions, propose_registered_action, resolve_action_proposal
    configure_definition=next(item for item in list_registered_actions() if item['id']=='mail.account.configure')
    check('企业配置发布新版本，不复用个人邮箱旧协议',configure_definition['version']=='1.1.0'
          and set(configure_definition['input_schema']['properties']['provider']['enum'])
          =={'qq','163','netease-enterprise','netease-enterprise-hz'})
    old_schema=frappe.db.get_value('Shangshu Action Definition','mail.account.configure@1.0.0','input_schema_json')
    if old_schema:
        check('已发布的个人邮箱1.0.0定义保持原样',json.loads(old_schema)['properties']['provider']['enum']==['qq','163'])
    secret='isolated-fake-authorization-not-a-real-secret'
    mailbox={'provider':'qq','email':'demo@qq.com','display_name':'方舟采购','password':secret}
    with patch.object(transport,'test_connection',side_effect=RuntimeError('credential '+secret)):
        denied('错误授权不保存且响应不泄漏原始异常',lambda:act('mail.account.configure',mailbox))
        check('连接失败不会留半个邮箱配置',not account.status()['account']['bound'])
    with patch.object(transport,'test_connection',lambda *args:None):
        configured=act('mail.account.configure',mailbox)
        check('本人页面动作绑定与登录邮箱无关',configured['account']['email']=='demo@qq.com' and configured['account']['bound'])
        account_doc=account.get_account()
        check('配置和状态不返回授权码',secret not in json.dumps(configured))
        check('Frappe框架自动收发关闭避免第二邮件事实',not frappe.db.get_value('Email Account',account_doc.email_account,'enable_incoming') and not frappe.db.get_value('Email Account',account_doc.email_account,'enable_outgoing'))
        check('授权码通过框架加密保存',account.credentials(account_doc)[1]==secret and frappe.db.get_value('Email Account',account_doc.email_account,'password')!=secret)
        audits=frappe.get_all('Shangshu Action Execution Audit',filters={'actor_user':people[0],'action_id':'mail.account.configure'},fields=['input_summary_json','result_summary_json'])
        check('配置审计不含明文授权码',all(secret not in row.input_summary_json+row.result_summary_json for row in audits))
        tool_ids={item['id'] for item in list_registered_actions(tools_only=True)}
        check('邮件写工具复用动作且账号授权不进AI目录',{'mail.save_draft','mail.send','mail.sync'}.issubset(tool_ids) and not any(item.startswith('mail.account.') for item in tool_ids))
        denied('AI来源不能修改邮箱授权',lambda:execute_registered_action('mail.account.configure',mailbox,True,frappe.generate_hash(length=24),source='ai'))
        act('mail.account.status',{'enabled':False})
        denied('暂停邮箱拒绝收发',lambda:act('mail.sync',{}))
        act('mail.account.status',{'enabled':True})
    sent_calls=[]
    def fake_send(address,password,display,mail,attachments,provider=None):
        sent_calls.append((address,mail,attachments))
        return {'status':'Sent','error':'','rejected':[]}
    with patch.object(transport,'send_message',fake_send):
        send_draft=act('mail.save_draft',{**payload,'attachments':[source_file]});created.append(send_draft['name'])
        send_input={'mail':send_draft['name'],'expected_version':1};send_key=frappe.generate_hash(length=24)
        denied('未确认发送不排队也不发信',lambda:execute_registered_action('mail.send',send_input,False,frappe.generate_hash(length=24)))
        queued=act('mail.send',send_input,send_key)
        check('发送先冻结草稿不在事务中发信',queued['status']=='Queued' and not sent_calls)
        denied('冻结后不允许修改收件人或正文',lambda:act('mail.save_draft',{**payload,'mail':send_draft['name'],'expected_version':2}))
        frappe.db.commit()
        sent=detail(send_draft['name'])['mail']
        check('提交后只发一次且落库真实状态',len(sent_calls)==1 and sent['status']=='Sent')
        check('邮件ID与发件头不会被HTML转义污染',sent['message_id'].startswith('<') and sent['from_address']=='方舟采购 <demo@qq.com>')
        check('真正发送固定附件字节和发件身份',sent_calls[0][0]=='demo@qq.com' and sent_calls[0][2][0]['content']==b'attachment version one')
        act('mail.send',send_input,send_key);frappe.db.commit()
        check('同键重放不会再次外发',len(sent_calls)==1)
        denied('新幂等键也不能重发已发送邮件',lambda:act('mail.send',{'mail':sent['name'],'expected_version':sent['record_version']}))
        trashed=act('mail.recycle',{'mail':sent['name'],'expected_version':sent['record_version']})
        restored_sent=act('mail.restore',{'mail':sent['name'],'expected_version':trashed['record_version']})
        check('恢复已发送邮件不能伪装为可改草稿',restored_sent['status']=='Sent')
        # 审计失败即使commit也绝不发送。
        rollback_draft=act('mail.save_draft',payload);created.append(rollback_draft['name']);frappe.db.commit()
        with patch.object(Document,'insert',reject_audit):
            denied('发送审计失败整次排队回滚',lambda:act('mail.send',{'mail':rollback_draft['name'],'expected_version':1}))
        frappe.db.commit()
        check('回滚残留回调不能偷偷发送',len(sent_calls)==1 and detail(rollback_draft['name'])['mail']['status']=='Draft')
        paused=act('mail.save_draft',payload);created.append(paused['name'])
        paused=act('mail.send',{'mail':paused['name'],'expected_version':1})
        act('mail.account.status',{'enabled':False});frappe.db.commit()
        check('提交前暂停邮箱阻止回调外发',len(sent_calls)==1 and detail(paused['name'])['mail']['status']=='Queued')
        with patch.object(transport,'test_connection',lambda *args:None):act('mail.account.status',{'enabled':True})
        # Queued还未调用SMTP，可通过显式确认恢复；Sending绝不能这样重试。
        act('mail.send',{'mail':paused['name'],'expected_version':paused['record_version']});frappe.db.commit()
        check('恢复后显式继续Queued只发一次',len(sent_calls)==2 and detail(paused['name'])['mail']['status']=='Sent')
        stopped=act('mail.save_draft',payload);created.append(stopped['name'])
        act('mail.send',{'mail':stopped['name'],'expected_version':1})
        frappe.set_user('Administrator');set_domain_enabled(DOMAIN,False,'发信回调停用门禁');frappe.db.commit()
        check('域停用不允许回调访问SMTP',len(sent_calls)==2)
        set_domain_enabled(DOMAIN,True,'发信回调测试恢复');frappe.db.commit();frappe.set_user(people[0])
        disabled=act('mail.save_draft',payload);created.append(disabled['name'])
        act('mail.send',{'mail':disabled['name'],'expected_version':1})
        frappe.db.set_value('User',people[0],'enabled',0);frappe.db.commit()
        check('身份停用不允许已排队回调外发',len(sent_calls)==2)
        frappe.db.set_value('User',people[0],'enabled',1);frappe.db.commit()
    with patch.object(transport,'send_message',lambda *args:{'status':'Unknown','error':'发送结果不明，请在原邮箱核对','rejected':[]}):
        unknown=act('mail.save_draft',payload);created.append(unknown['name'])
        act('mail.send',{'mail':unknown['name'],'expected_version':1});frappe.db.commit()
        unknown=detail(unknown['name'])['mail']
        check('结果不明单独展示而不是失败自动重试',unknown['status']=='Unknown')
        denied('不明结果禁止盲重发',lambda:act('mail.send',{'mail':unknown['name'],'expected_version':unknown['record_version']}))
    class FakeInbox:
        def logout(self): pass
    received_payload={'subject':'工厂采购报价回复','body':'单价100元，数量10',
        'to':['demo@qq.com'],'cc':[],'from_address':'工厂 <factory@example.invalid>',
        'message_id':'<isolated-response@example.invalid>','in_reply_to':sent['message_id'],
        'attachments':[{'name':'报价.txt','content':b'price=100'}]}
    with patch.object(transport,'imap_session',lambda *args:FakeInbox()),patch.object(transport,'inbox_uids',lambda conn:('8123',[1])),patch.object(transport,'fetch_message',lambda conn,uid:received_payload):
        sync_result=act('mail.sync',{})
        inbox=query_dataset('mail.message',{'scope':'inbox'},1,30)
        incoming=inbox['rows'][0];created.append(incoming['name'])
        check('收信数据库真实落地并关联原发件',sync_result['added']==1 and incoming['reply_to_mail']==sent['name'])
        incoming=detail(incoming['name'])['mail'];attachment=incoming['attachments'][0]
        check('收到原件字节可授权读取',content(incoming['name'],attachment['file'])==b'price=100')
        check('附件公开来源供Agent读取和归档',attachment['source']=={'ref_doctype':'Shangshu Mail Message','ref_name':incoming['name'],'file':attachment['file']})
        check('多次同步UID去重',act('mail.sync',{})['added']==0)
        reply=act('mail.save_draft',{**payload,'reply_to_mail':incoming['name']});created.append(reply['name'])
        check('回复引用来自原信而非模型猜测',frappe.db.get_value('Shangshu Mail Message',reply['name'],'in_reply_to')==received_payload['message_id'])
        frappe.db.commit();frappe.set_user(people[1])
        check('另一员工看不到邮箱绑定',not account.status()['account']['bound'])
        denied('另一员工不能读收到的邮件',lambda:detail(incoming['name']))
        frappe.set_user(people[0])
    with patch.object(transport,'test_connection',lambda *args:None):
        detached=act('mail.account.disconnect',{})
        check('解除授权保留历史邮件',not detached['account']['bound'] and detail(sent['name'])['mail']['status']=='Sent')
        from frappe.utils.password import get_decrypted_password
        check('解除后框架密文凭据确实移除',not get_decrypted_password('Email Account',account_doc.email_account,raise_exception=False))
        denied('解除后不能继续同步',lambda:act('mail.sync',{}))
    # 企业邮箱的域名不是服务商标识：配置、测试、启用恢复与收发必须沿用显式节点。
    enterprise_provider='netease-enterprise-hz'
    enterprise_secret='isolated-enterprise-authorization-not-a-real-secret'
    enterprise_mailbox={'provider':enterprise_provider,'email':'demo@fangzhou.example.invalid',
        'display_name':'方舟采购杭州','password':enterprise_secret}
    enterprise_tests=[]
    def enterprise_test(address,password,provider=None):
        enterprise_tests.append((address,password,provider))
    with patch.object(transport,'test_connection',enterprise_test):
        try: enterprise_configured=act('mail.account.configure',enterprise_mailbox)
        except frappe.ValidationError: enterprise_configured=None
        check('网易企业自定义域可通过既有配置动作绑定杭州节点',bool(enterprise_configured))
        if enterprise_configured:
            enterprise_doc=account.get_account()
            framework=frappe.get_doc('Email Account',enterprise_doc.email_account)
            check('企业账户记录和连接测试保持显式杭州provider',enterprise_doc.provider==enterprise_provider
                  and enterprise_configured['account']['provider']==enterprise_provider
                  and enterprise_tests[-1]==(enterprise_mailbox['email'],enterprise_secret,enterprise_provider))
            check('企业框架绑定只指向杭州TLS主机而非个人163节点',framework.smtp_server=='smtphz.qiye.163.com'
                  and framework.email_server=='imaphz.qiye.163.com' and str(framework.smtp_port)=='465'
                  and str(framework.incoming_port)=='993' and framework.use_ssl_for_outgoing and framework.use_ssl)
            check('企业授权码仍只经框架加密保存且不回显',account.credentials(enterprise_doc)[1]==enterprise_secret
                  and framework.password!=enterprise_secret and enterprise_secret not in json.dumps(enterprise_configured))
            tests_before=len(enterprise_tests)
            denied('同地址换企业节点不填新授权码必须拒绝',lambda:act('mail.account.configure',{
                **{k:v for k,v in enterprise_mailbox.items() if k!='password'},'provider':'netease-enterprise'}))
            check('拒绝换节点不会把旧授权码交给另一服务器',len(enterprise_tests)==tests_before
                  and account.get_account().provider==enterprise_provider
                  and frappe.db.get_value('Email Account',enterprise_doc.email_account,'smtp_server')=='smtphz.qiye.163.com')
            act('mail.account.test',{})
            act('mail.account.status',{'enabled':False})
            act('mail.account.status',{'enabled':True})
            check('企业连接测试与暂停恢复仍使用保存的杭州节点',len(enterprise_tests)==tests_before+2
                  and all(call[2]==enterprise_provider for call in enterprise_tests)
                  and account.status()['account']['connection_status']=='connected')
            enterprise_sent=[]
            def enterprise_send(address,password,display,mail,attachments,provider=None):
                enterprise_sent.append((address,password,provider,mail))
                return {'status':'Sent','error':'','rejected':[]}
            with patch.object(transport,'send_message',enterprise_send):
                draft=act('mail.save_draft',{**payload,'subject':'杭州企业节点验收'});created.append(draft['name'])
                proposal=propose_registered_action('mail.send',{'mail':draft['name'],'expected_version':1},frappe.generate_hash(length=24),'ai-chat')
                created_proposals.append(proposal['id'])
                check('企业Agent发送提案不立即发送',not enterprise_sent and detail(draft['name'])['mail']['status']=='Draft')
                confirmed=resolve_action_proposal(proposal['id'],'confirmed')
                check('企业原确认链先排队，提交之前零SMTP',confirmed['status']=='confirmed' and not enterprise_sent)
                frappe.db.commit()
                check('企业Agent确认后SMTP收到同一杭州provider',len(enterprise_sent)==1
                      and enterprise_sent[0][:3]==(enterprise_mailbox['email'],enterprise_secret,enterprise_provider)
                      and detail(draft['name'])['mail']['status']=='Sent')
                resolve_action_proposal(proposal['id'],'confirmed');frappe.db.commit()
                check('企业原确认重放不会重复外发',len(enterprise_sent)==1)
            enterprise_imap=[]
            def enterprise_inbox(address,password,provider=None):
                enterprise_imap.append((address,password,provider));return FakeInbox()
            enterprise_received={**received_payload,'to':[enterprise_mailbox['email']],
                'message_id':'<enterprise-hz-response@example.invalid>','in_reply_to':''}
            with patch.object(transport,'imap_session',enterprise_inbox),patch.object(transport,'inbox_uids',lambda conn:('enterprise-hz-8123',[8])),patch.object(transport,'fetch_message',lambda conn,uid:enterprise_received):
                added=act('mail.sync',{})
                rows=query_dataset('mail.message',{'scope':'inbox'},1,30)['rows']
                for row in rows:
                    if row['name'] not in created:created.append(row['name'])
                check('企业同步IMAP收到杭州provider且邮件真实落库',added['added']==1
                      and enterprise_imap[-1]==(enterprise_mailbox['email'],enterprise_secret,enterprise_provider))
                check('企业同步仍按UID去重',act('mail.sync',{})['added']==0)
            # 原有个人邮箱继续可绑定；不让企业节点选择改变个人服务商默认行为。
            for provider,email in [('163','compat@163.com'),('qq','compat@qq.com')]:
                compatible=act('mail.account.configure',{'provider':provider,'email':email,'password':secret})
                stored=frappe.get_doc('Email Account',account.get_account().email_account)
                check('企业节点增量不破坏个人'+provider+'绑定',compatible['account']['provider']==provider
                      and enterprise_tests[-1]==(email,secret,provider)
                      and stored.smtp_server==('smtp.163.com' if provider=='163' else 'smtp.qq.com'))
finally:
    frappe.db.rollback();frappe.set_user('Administrator');set_domain_enabled(DOMAIN,True,'自动回归恢复')
    set_domain_enabled('com.shangshu.files',True,'自动回归恢复');frappe.db.commit()
    from shangshu_mail.service import writing
    with writing():
        for name in created:
            for file in frappe.get_all('File',filters={'attached_to_doctype':'Shangshu Mail Message','attached_to_name':name},pluck='name'):
                frappe.delete_doc('File',file,ignore_permissions=True,force=True)
            if frappe.db.exists('Shangshu Mail Message',name):frappe.delete_doc('Shangshu Mail Message',name,ignore_permissions=True,force=True)
    for name in source_files:
        for file in frappe.get_all('File',filters={'attached_to_doctype':'Shangshu File Center File','attached_to_name':name},pluck='name'):
            frappe.delete_doc('File',file,ignore_permissions=True,force=True)
        frappe.db.delete('Shangshu File Center Version',{'file':name})
        frappe.db.delete('Shangshu File Center File',{'name':name})
    for name in created_proposals:
        frappe.db.delete('Shangshu Action Proposal',{'name':name})
    for email in people:
        binding_name=__import__('hashlib').sha256(email.encode()).hexdigest()[:40]
        binding=frappe.db.get_value('Shangshu Mail Account',binding_name,'email_account')
        if frappe.db.exists('Shangshu Mail Account',binding_name):frappe.db.delete('Shangshu Mail Account',{'name':binding_name})
        email_account_name='Shangshu Personal '+binding_name
        if frappe.db.exists('Email Account',email_account_name):frappe.delete_doc('Email Account',email_account_name,ignore_permissions=True,force=True)
        for identity in frappe.get_all('Shangshu Identity',filters={'user':email},pluck='name'):
            frappe.delete_doc('Shangshu Identity',identity,ignore_permissions=True,force=True)
        if frappe.db.exists('User',email):frappe.delete_doc('User',email,ignore_permissions=True,force=True)
    frappe.db.commit();frappe.destroy()
print(f'通过 {sum(checks)}/{len(checks)}')
raise SystemExit(0 if all(checks) else 1)
