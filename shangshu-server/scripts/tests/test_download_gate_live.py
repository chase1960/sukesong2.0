"""Actual HTTP complete-file routes and new mail snapshot authorization. No sending."""
import sys,json,uuid,urllib.request,urllib.error
import _ss_console
from test_organization_audit_live import Client,console,PASSWORD,BASE,check,checks
P='export'+uuid.uuid4().hex[:8];USER=P+'@example.invalid'
def action(c,name,p):return c.call('action_execute',{'action_id':name,'payload':json.dumps(p),'confirmed':1,'idempotency_key':uuid.uuid4().hex},post=True)
def result(r):return r[1].get('message',{}).get('result',{})
def service(c,name,p):return c.call('service_invoke',{'service_id':name,'payload':json.dumps(p)},post=True)
def raw(c,path):
 req=urllib.request.Request(BASE+path,headers={'Host':'shangshu.localhost'})
 try:
  with c.opener.open(req,timeout=30) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def policy(table,download,read=True):
 column={'header':'Secret','promoted':True,'field':'secret','type':'text','read_roles':['Desk User'] if read else [],'download_roles':['Desk User'] if download else []}
 console("from shangshu_files.promotion import save_definition\ndoc=frappe.get_doc('Shangshu File Center File',%r)\nsave_definition(doc,{'definition_version':1,'columns':[%r]})\nfrappe.db.commit()\nRESULT['ok']=True"%(table,column))
def main():
 seed={};mails=[]
 try:
  seed=_ss_console.run('''
import io,base64,openpyxl
from frappe.core.doctype.user import user as user_module
from shangshu_core.public_api import execute_registered_action
old=user_module.throttle_user_creation
try:
 user_module.throttle_user_creation=lambda:None
 execute_registered_action('platform.identity.create',{'email':%r,'display_name':%r,'initial_password':%r,'role':'staff'},confirmed=True,idempotency_key=%r)
finally:user_module.throttle_user_creation=old
frappe.db.commit();frappe.set_user(%r)
w=openpyxl.Workbook();w.active.append(['Secret']);w.active.append(['PRIMARY-SENSITIVE']);w.create_sheet('Other').append(['OTHER-SENSITIVE']);w.active.column_dimensions['A'].hidden=True;w['Other'].sheet_state='hidden'
out=io.BytesIO();w.save(out);content=base64.b64encode(out.getvalue()).decode()
r=execute_registered_action('files.upload',{'file_name':%r,'content_base64':content,'attribution':{'level':'personal','owner_user':%r}},confirmed=True,idempotency_key=%r)['result']
RESULT['table']=r['file'];d=frappe.get_doc('Shangshu File Center File',r['file']);RESULT['old']=d.current_file
from shangshu_core.public_api import invoke_domain_service
v=invoke_domain_service('files.sheet_read',{'table':d.name})
execute_registered_action('files.sheet_cell_write',{'table':d.name,'row_id':v['rows'][0]['row_id'],'header':'Secret','value':{'type':'text','value':'PRIMARY-NEW'},'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']},confirmed=True,idempotency_key=%r)
d.reload();RESULT['current']=d.current_file
RESULT['urls']={fid:frappe.db.get_value('File',fid,'file_url') for fid in [RESULT['old'],RESULT['current']]}
frappe.db.commit()
'''%(USER,P,PASSWORD,P+'user',USER,P+'.xlsx',USER,P+'upload',P+'version'))
  if '__error__' in seed:
   print('SEED_DIAGNOSTIC',seed['__error__'].replace(PASSWORD,'[redacted]'));raise RuntimeError('seed prerequisite failed')
  c=Client(USER);table=seed['table'];policy(table,False)
  st,b=service(c,'files.versions',{'file':table});check('download affordance follows field download deny',st==200 and b['message']['file']['can_download'] is False)
  for file in dict.fromkeys([seed['old'],seed['current']]):
   path='/api/method/shangshu_core.public_api.http.file_content?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode({'ref_doctype':'Shangshu File Center File','ref_name':table,'file':file})
   st,data=raw(c,path);check('API denies complete current/history field export',st>=400 and not data.startswith(b'PK'))
   st,data=raw(c,seed['urls'][file]);check('private URL denies same complete workbook',st>=400 and not data.startswith(b'PK'))
  denied=action(c,'mail.save_draft',{'subject':P,'body':'test','to':[],'cc':[],'attachments':[seed['old']]})
  check('immutable source cannot bypass download deny through draft',denied[0]>=400)
  policy(table,True,False)
  denied=action(c,'mail.save_draft',{'subject':P,'body':'test','to':[],'cc':[],'attachments':[seed['current']]})
  check('download grant cannot bypass field read deny',denied[0]>=400)
  policy(table,True,True)
  st,data=raw(c,seed['urls'][seed['current']]);check('authorized private URL delivers XLSX',st==200 and data.startswith(b'PK'))
  import io,openpyxl
  book=openpyxl.load_workbook(io.BytesIO(data));check('authorized full export contains hidden primary column and hidden other sheet',book.active.column_dimensions['A'].hidden and book.active['A2'].value=='PRIMARY-NEW' and book['Other'].sheet_state=='hidden' and book['Other']['A1'].value=='OTHER-SENSITIVE')
  saved=action(c,'mail.save_draft',{'subject':P,'body':'fixed','to':[],'cc':[],'attachments':[seed['current']]});r=result(saved);check('authorized fixed draft attachment created',saved[0]==200 and bool(r.get('name')))
  if r.get('name'):
   mails.append(r['name']);attachment=console("d=frappe.get_doc('Shangshu Mail Message',%r)\nRESULT['file']=__import__('json').loads(d.attachment_ids_json)[0]"%r['name'])['file']
   policy(table,False,False)
   path='/api/method/shangshu_core.public_api.http.file_content?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode({'ref_doctype':'Shangshu Mail Message','ref_name':r['name'],'file':attachment})
   st,data=raw(c,path);check('formed snapshot remains governed by target mail after source restriction',st==200 and data.startswith(b'PK'))
 finally:
  console("from shangshu_core.public_api import execute_registered_action\nif frappe.db.exists('User',%r):execute_registered_action('platform.identity.status',{'email':%r,'enabled':False},confirmed=True,idempotency_key=%r)\nfor f in %r:frappe.db.set_value('Shangshu File Center File',f,'status','Recycled')\nfor m in %r:frappe.db.set_value('Shangshu Mail Message',m,'status','Trash')\nfrappe.db.commit()\nRESULT['cleaned']=True"%(USER,USER,P+'cleanup',[seed['table']] if seed.get('table') else [],mails))
  print('CLEANED',json.dumps({'table':seed.get('table'),'mails':mails}))
 print('RESULT',sum(checks),'/',len(checks));return 0 if all(checks) and checks else 1
if __name__=='__main__':sys.exit(main())
