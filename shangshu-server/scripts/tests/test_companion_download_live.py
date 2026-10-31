"""Companion source field read/download intersection through real HTTP routes."""
import json,sys,uuid,urllib.request,urllib.error,urllib.parse
import _ss_console
from test_organization_audit_live import Client,console,PASSWORD,BASE,check,checks
P='compdl'+uuid.uuid4().hex[:8];USER=P+'@example.invalid';READ=P+'Read';EXPORT=P+'Export'
def call(c,service,p):return c.call('service_invoke',{'service_id':service,'payload':json.dumps(p)},post=True)
def action(c,name,p):
 st,b=c.call('action_execute',{'action_id':name,'payload':json.dumps(p),'confirmed':True,'idempotency_key':uuid.uuid4().hex},post=True)
 if st!=200:raise RuntimeError((name,st,b))
 return b['message']['result']
def main():
 seed={}
 try:
  seed=_ss_console.run('''
from shangshu_core.public_api import create_application_definition,prepare_object_change,execute_object_change,get_application_definition,save_application_draft,publish_application_definition,execute_registered_action
from frappe.core.doctype.user import user as user_module
for role in %r:frappe.get_doc({'doctype':'Role','role_name':role,'desk_access':1}).insert(ignore_permissions=True)
old=user_module.throttle_user_creation
try:
 user_module.throttle_user_creation=lambda:None
 execute_registered_action('platform.identity.create',{'email':%r,'display_name':%r,'initial_password':%r,'role':'staff'},confirmed=True,idempotency_key=%r)
finally:user_module.throttle_user_creation=old
u=frappe.get_doc('User',%r);u.add_roles(%r)
app=create_application_definition(%r,%r);RESULT['application']=app['id']
change=prepare_object_change(app['id'],{'schema_version':1,'title':%r,'access':{'read_roles':['Desk User'],'write_roles':['Desk User'],'record_scope':'all'},'fields':[{'id':'title','label':'Title','type':'text','read_roles':[%r],'write_roles':[%r],'download_roles':[%r]}]},%r)
frappe.db.commit()
execute_object_change(change['id'],True);RESULT['object_id']=change['object_id']
a=get_application_definition(app['id']);saved=save_application_draft(a['id'],{**a['draft'],'bindings':[{'kind':'datasets','resource_id':change['object_id'],'owner_domain':a['id'],'version':'1'}]},a['draft_revision']);publish_application_definition(a['id'],saved['draft_revision'])
execute_registered_action('platform.object.create',{'object_id':change['object_id'],'expected_revision':1,'values':{'title':'SOURCE-CONFIDENTIAL'}},confirmed=True,idempotency_key=%r)
f=execute_registered_action('files.create',{'file_name':%r,'attribution':{'level':'personal','owner_user':'Administrator'}},confirmed=True,idempotency_key=%r)['result']['file'];RESULT['file']=f
execute_registered_action('platform.org.share_grant',{'resource':f,'user':%r,'access':'edit'},confirmed=True,idempotency_key=%r+'share')
execute_registered_action('platform.object.companion_bind',{'object_id':change['object_id'],'file_id':f,'field_columns':[{'field_id':'title','header':'Title'}]},confirmed=True,idempotency_key=%r)
from shangshu_files.sheet import read_payload
r=read_payload('files.sheet_read',{'table':f})
execute_registered_action('files.sheet_column_append',{'table':f,'header':'Note','expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']},confirmed=True,idempotency_key=%r+'note')
d=frappe.get_doc('Shangshu File Center File',f);RESULT['blob']=d.current_file
frappe.db.commit()
'''%([READ,EXPORT],USER,P,PASSWORD,P+'user',USER,READ,P,P+'app',P,READ,READ,EXPORT,P+'model',P+'record',P+'.xlsx',P+'file',USER,P,P+'bind',P))
  if '__error__' in seed:
   print('SEED_DIAGNOSTIC',seed['__error__'].replace(PASSWORD,'[redacted]'));raise RuntimeError('seed failed')
  c=Client(USER)
  def roles(read,export):
   console("u=frappe.get_doc('User',%r)\nu.remove_roles(%r,%r)\nu.add_roles(*%r)\nfrappe.clear_cache(user=%r)\nfrappe.db.commit()\nRESULT['ok']=True"%(USER,READ,EXPORT,([READ] if read else [])+([EXPORT] if export else []),USER))
  def download():
   path='/api/method/shangshu_core.public_api.http.file_content?'+urllib.parse.urlencode({'ref_doctype':'Shangshu File Center File','ref_name':seed['file'],'file':seed['blob']})
   req=urllib.request.Request(BASE+path,headers={'Host':'shangshu.localhost'})
   try:
    with c.opener.open(req,timeout=30) as r:return r.status,r.read()
   except urllib.error.HTTPError as e:return e.code,e.read()
  st,b=call(c,'files.sheet_read',{'table':seed['file']});check('source read allowed before export grant',st==200 and b['message']['rows'][0]['values']['Title']['value']=='SOURCE-CONFIDENTIAL')
  rid=b['message']['rows'][0]['row_id']
  st,ready=call(c,'files.row_require_ready',{'table':seed['file'],'row_id':rid});check('ready fails for absent formal row, not source download policy',st>=400 and '本行仍待补齐' in json.dumps(ready,ensure_ascii=False))
  st,data=download();check('source read does not imply companion download',st>=400 and not data.startswith(b'PK'))
  roles(True,True);st,data=download();check('explicit source field export grant permits workbook',st==200 and data.startswith(b'PK'))
  roles(False,True);st,data=download();check('source export grant cannot replace field read',st>=400 and not data.startswith(b'PK'))
  st,hidden=call(c,'files.sheet_read',{'table':seed['file']});r=hidden.get('message',{})
  check('source field revocation hides confidential value',st==200 and 'SOURCE-CONFIDENTIAL' not in json.dumps(r))
  if 'SOURCE-CONFIDENTIAL' in json.dumps(r):print('SYNTHETIC_LEAK_RESPONSE',json.dumps(r,ensure_ascii=False))
  action(c,'files.sheet_cell_write',{'table':seed['file'],'row_id':rid,'header':'Note','value':{'type':'text','value':'ordinary-still-editable'},'expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']})
  st,after=call(c,'files.sheet_read',{'table':seed['file']});check('ordinary column retains independent authorized edit',st==200 and after['message']['rows'][0]['values']['Note']['value']=='ordinary-still-editable')
  roles(True,False);st,data=download();check('source export revocation immediate',st>=400 and not data.startswith(b'PK'))
 finally:
  console("from shangshu_core.public_api import execute_registered_action,get_application_definition,set_application_enabled\nif frappe.db.exists('User',%r):execute_registered_action('platform.identity.status',{'email':%r,'enabled':False},confirmed=True,idempotency_key=%r)\nfor f in %r:frappe.db.set_value('Shangshu File Center File',f,'status','Recycled')\nfor app in %r:\n if not frappe.db.exists('Shangshu Application Definition',app):continue\n a=get_application_definition(app)\n if a.get('published_revision'):set_application_enabled(app,False,'synthetic cleanup',a['draft_revision'])\nfrappe.db.commit()\nRESULT['cleaned']=True"%(USER,USER,P+'cleanup',[seed['file']] if seed.get('file') else [],[seed['application']] if seed.get('application') else []))
  print('CLEANED',json.dumps({'file':seed.get('file'),'application':seed.get('application')}))
 print('RESULT',sum(checks),'/',len(checks));return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
