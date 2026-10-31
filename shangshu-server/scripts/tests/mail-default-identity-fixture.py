"""Synthetic unbound person with one visible shared identity; no transport credentials."""
import json,sys,secrets,uuid,os
os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
from test_organization_audit_live import console
r=json.load(sys.stdin)
if r['mode']=='seed':
 p='mailidentity'+uuid.uuid4().hex[:10];pw=secrets.token_urlsafe(24);user=p+'@example.invalid';box=p+'-shared'
 out=console('''
from shangshu_core.public_api import execute_registered_action,get_identity
from shangshu_mail.account import writing,account_name
# Isolated fixture console only: bypass account-count throttle with no import/default changes.
import frappe.core.doctype.user.user as user_module
original_throttle=user_module.throttle_user_creation
user_module.throttle_user_creation=lambda: None
try:
 execute_registered_action('platform.identity.create',{'email':%r,'display_name':%r,'initial_password':%r,'role':'staff','collaboration_scope':'related'},confirmed=True,idempotency_key=%r)
finally:
 user_module.throttle_user_creation=original_throttle
execute_registered_action('platform.identity.status',{'email':%r,'enabled':True},confirmed=True,idempotency_key=%r)
dep=execute_registered_action('platform.org.department_create',{'name':%r,'enterprise':get_identity().enterprise_id},confirmed=True,idempotency_key=%r)['result']['department']
frappe.set_user(%r)
with writing():
 doc=frappe.get_doc({'doctype':'Shangshu Mail Account','account_key':%r,'kind':'department','department':dep,'email_address':%r,'display_name':'合成共享身份','enabled':1,'connection_status':'connected'})
 doc.insert(ignore_permissions=True)
frappe.db.commit()
RESULT.update({'department':dep,'mailbox':doc.account_key,'personal':account_name()})
'''%(user,p,pw,p+'-user',user,p+'-enable',p,p+'-dep',user,box,p+'-shared@example.invalid'))
 print(json.dumps({**out,'user':user,'password':pw,'prefix':p}))
elif r['mode']=='received':
 f=r['fixture'];out=console("""
from shangshu_mail import service,account
import json,base64
frappe.set_user(%r)
with account.writing():
 if not frappe.db.exists('Shangshu Mail Account',account.account_name()):frappe.get_doc({'doctype':'Shangshu Mail Account','account_key':account.account_name(),'kind':'personal','email_address':frappe.session.user,'display_name':'合成个人箱','enabled':1,'connection_status':'connected'}).insert(ignore_permissions=True)
with service.writing():
 d=frappe.get_doc({'doctype':'Shangshu Mail Message','status':'Received','subject':'四路径源邮件','body':'<p>来源正文</p><table border="1"><tr><th colspan="2">汇总</th></tr><tr><td rowspan="2">A001</td><td>800</td></tr><tr><td>0</td></tr></table><img src="cid:four-path@invalid">','body_format':'HTML','to_json':json.dumps([%r,'other@example.invalid']),'cc_json':json.dumps(['cc@example.invalid']),'from_address':'sender@example.invalid','record_version':1,'mailbox_id':account.account_name(),'received_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
 att=frappe.get_doc({'doctype':'File','file_name':'source.txt','is_private':1,'attached_to_doctype':'Shangshu Mail Message','attached_to_name':d.name,'content':b'fixed attachment'}).insert(ignore_permissions=True)
 img=frappe.get_doc({'doctype':'File','file_name':'logo.png','is_private':1,'attached_to_doctype':'Shangshu Mail Message','attached_to_name':d.name,'content':base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=')}).insert(ignore_permissions=True)
 d.attachment_ids_json=json.dumps([att.name])
 d.inline_resources_json=json.dumps([{'content_id':'four-path@invalid','file':img.name,'mime_type':'image/png','name':'logo.png'}]);d.save(ignore_permissions=True)
frappe.db.commit();RESULT.update({'mail':d.name,'attachment':att.name,'image':img.name})
"""%(f['user'],f['user']));print(json.dumps(out))
elif r['mode']=='proposal':
 f=r['fixture'];out=console("from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(%r)\np=propose_registered_action('mail.save_draft',{'mail':%r,'expected_version':frappe.db.get_value('Shangshu Mail Message',%r,'record_version'),'subject':'候选主题','body':'<p>候选正文不可误写</p>','body_format':'HTML','to':[],'cc':[]},idempotency_key=%r,source='ai')\nfrappe.db.commit()\nRESULT.update(p)"%(f['user'],r['mail'],r['mail'],f['prefix']+'-proposal-'+r.get('suffix','default')))
 print(json.dumps(out))
else:
 f=r['fixture'];out=console('''
from shangshu_core.public_api import execute_registered_action
from shangshu_mail.account import writing
frappe.set_user(%r)
for i,mail in enumerate(%r):execute_registered_action('mail.recycle',{'mail':mail,'expected_version':frappe.db.get_value('Shangshu Mail Message',mail,'record_version')},confirmed=True,idempotency_key=%r+str(i))
frappe.set_user('Administrator')
with writing():
 frappe.db.set_value('Shangshu Mail Account',%r,'enabled',0)
 for item in frappe.get_all('Shangshu Mail Account',filters={'owner':%r},pluck='name'):frappe.db.set_value('Shangshu Mail Account',item,'enabled',0)
execute_registered_action('platform.identity.status',{'email':%r,'enabled':False},confirmed=True,idempotency_key=%r)
execute_registered_action('platform.org.department_set_status',{'department':%r,'enabled':False},confirmed=True,idempotency_key=%r)
frappe.db.commit()
RESULT['cleaned']=True
'''%(f['user'],r.get('mails',[]),f['prefix']+'-clean-mail-',f['mailbox'],f['user'],f['user'],f['prefix']+'-clean-user',f['department'],f['prefix']+'-clean-dep'))
 print(json.dumps(out))
