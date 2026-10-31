"""Isolated enterprise: actual native orders.edit HTTP action drives companion hook."""
import io,json,sys,uuid,urllib.request,urllib.parse
from openpyxl import load_workbook
import _ss_console
from test_organization_audit_live import Client,console,PASSWORD,BASE,check,checks
from test_companion_download_live import action,call
P='nativehook'+uuid.uuid4().hex[:8];USER=P+'@example.invalid'
def main():
 file=None
 try:
  seed=_ss_console.run('''
from shangshu_core.public_api import execute_registered_action
from frappe.core.doctype.user import user as user_module
old=user_module.throttle_user_creation
try:
 user_module.throttle_user_creation=lambda:None
 execute_registered_action('platform.identity.create',{'email':%r,'display_name':%r,'initial_password':%r,'role':'staff'},confirmed=True,idempotency_key=%r)
finally:user_module.throttle_user_creation=old
u=frappe.get_doc('User',%r);u.add_roles('System Manager')
i=frappe.db.get_value('Shangshu Identity',{'user':%r},'name');frappe.db.set_value('Shangshu Identity',i,'enterprise_id',%r)
from shangshu_core.native_objects import declared
RESULT['columns']=[{'field_id':f['id'],'header':f['id']} for f in declared('orders.order')[2]['fields']]
frappe.db.commit()
'''%(USER,P,PASSWORD,P+'user',USER,USER,P))
  if '__error__' in seed:raise RuntimeError(seed['__error__'].replace(PASSWORD,'[redacted]'))
  c=Client(USER)
  order=action(c,'orders.create',{'title':P,'customer':'Synthetic','sku':'SYNTH','quantity':2,'branch':'Stock'})
  file=action(c,'files.create',{'file_name':P+'.xlsx','attribution':{'level':'personal','owner_user':USER}})['file']
  action(c,'platform.object.companion_bind',{'object_id':'orders.order','file_id':file,'field_columns':seed['columns']})
  def read():
   st,b=call(c,'files.sheet_read',{'table':file});assert st==200,(st,b);return b['message']
  def ver(r):return {'expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']}
  r=read();check('native binding reuses original record identity',len(r['rows'])==1 and r['rows'][0]['row_id']==order['order'])
  action(c,'files.sheet_column_append',{'table':file,'header':'Note',**ver(r)})
  r=read();action(c,'files.sheet_cell_write',{'table':file,'row_id':order['order'],'header':'Note','value':{'type':'text','value':'keep-note'},**ver(r)})
  result=action(c,'orders.edit',{'order':order['order'],'revision':order['revision'],'quantity':7})
  r=read();values=r['rows'][0]['values'];check('native dedicated action updates projected source value',values['quantity']['value']==7)
  check('native save hook preserves ordinary companion values',values['Note']['value']=='keep-note')
  st,b=c.call('action_execute',{'action_id':'orders.edit','payload':json.dumps({'order':order['order'],'revision':order['revision'],'quantity':99}),'confirmed':True,'idempotency_key':uuid.uuid4().hex},post=True)
  check('native original revision rule still enforced',st>=400)
  r=read();check('native failed action leaves companion unchanged',r['rows'][0]['values']['quantity']['value']==7)
  for term,header in [('7','quantity'),('keep-note','Note')]:
   status,found=call(c,'files.sheet_read',{'table':file,'search':term})
   data=found.get('message',{})
   check('native companion search current '+header,status==200 and any(row['row_id']==order['order'] and row['values'][header]['value']==(7 if header=='quantity' else 'keep-note') for row in data.get('rows',[])))
  blob=console("RESULT['blob']=frappe.db.get_value('Shangshu File Center File',%r,'current_file')"%file)['blob']
  path='/api/method/shangshu_core.public_api.http.file_content?'+urllib.parse.urlencode({'ref_doctype':'Shangshu File Center File','ref_name':file,'file':blob})
  with c.opener.open(urllib.request.Request(BASE+path,headers={'Host':'shangshu.localhost'}),timeout=30) as response:
   content=response.read();status=response.status
  workbook=load_workbook(io.BytesIO(content),read_only=True,data_only=True)
  try:
   rows=list(workbook.active.values);headers=list(rows[0]);record=dict(zip(headers,rows[1]))
   check('native companion exported workbook has current formal and ordinary values',status==200 and record['quantity']==7 and record['Note']=='keep-note')
  finally:workbook.close()
  count=console("RESULT['count']=frappe.db.count('Shangshu Order',{'enterprise_id':%r})"%P)['count'];check('companion does not duplicate original native record',count==1)
 finally:
  console("from shangshu_core.public_api import execute_registered_action\nif frappe.db.exists('User',%r):execute_registered_action('platform.identity.status',{'email':%r,'enabled':False},confirmed=True,idempotency_key=%r)\nfor f in %r:frappe.db.set_value('Shangshu File Center File',f,'status','Recycled')\nfrappe.db.commit()\nRESULT['cleaned']=True"%(USER,USER,P+'cleanup',[file] if file else []))
  print('CLEANED',json.dumps({'enterprise':P,'file':file}))
 print('RESULT',sum(checks),'/',len(checks));return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
