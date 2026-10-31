"""UI022/UI075 actual authenticated API; unique fixtures and exact cleanup only."""
import json,sys,uuid,base64,io,subprocess,pathlib
from test_organization_audit_live import Client,console,PASSWORD,check,checks
P='relation'+uuid.uuid4().hex[:8]
USERS={r:f'{P}-{r}@example.invalid' for r in ('a','b','none','foreign')}
def act(c,a,p):return c.call('action_execute',{'action_id':a,'payload':json.dumps(p),'confirmed':1,'idempotency_key':P+'-'+uuid.uuid4().hex},post=True)
def val(r):return r[1].get('message',{}).get('result',{})
def ok(r):return r[0]==200 and bool(val(r)) and val(r).get('applied') is not False and val(r).get('fatal') is not True
def service(c,name,p):return c.call('service_invoke',{'service_id':name,'payload':json.dumps(p)},post=True)
def view(c,t):return service(c,'files.sheet_read',{'table':t})[1].get('message',{})
def create_fixture():
 return console('''
import io,base64,openpyxl
from shangshu_core.public_api import execute_registered_action
users=%r
seq=0
def act(a,p):
 global seq
 seq+=1
 return execute_registered_action(a,p,confirmed=True,idempotency_key=%r+str(seq))['result']
from frappe.core.doctype.user import user as user_module
original_throttle=user_module.throttle_user_creation
user_module.throttle_user_creation=lambda: None # isolated fixture process only
for role,email in users.items():
 act('platform.identity.create',{'email':email,'display_name':%r+' '+role,'initial_password':%r,'role':'staff','collaboration_scope':'related'})
 n=frappe.db.get_value('Shangshu Identity',{'user':email},'name');frappe.db.set_value('Shangshu Identity',n,'enterprise_id',%r+('-foreign' if role=='foreign' else ''))
user_module.throttle_user_creation=original_throttle
frappe.db.commit()
a=act('platform.org.department_create',{'name':%r+' A','enterprise':%r})['department']
b=act('platform.org.department_create',{'name':%r+' B','enterprise':%r})['department']
for role,d in [('a',a),('b',b)]:act('platform.org.member_assign',{'user':users[role],'department':d})
root=a
a=act('platform.org.department_create',{'name':'Child '+root,'enterprise':frappe.db.get_value('Shangshu Department',root,'enterprise_id'),'parent':root})['department']
act('platform.org.member_assign',{'user':users['a'],'department':a})
RESULT['departments']=[root,a,b];RESULT['files']=[]
def upload(owner,name,rows,attribution):
 frappe.set_user(owner)
 wb=openpyxl.Workbook();ws=wb.active
 for row in rows:ws.append(row)
 out=io.BytesIO();wb.save(out)
 r=act('files.upload',{'file_name':name+'.xlsx','content_base64':base64.b64encode(out.getvalue()).decode(),'attribution':attribution})
 RESULT['files'].append(r['file']);return r['file']
RESULT['target']=upload(users['a'],%r+' Target',[['Code','Amount','Contact'],['T1',800,'Alpha'],['T2',900,'Beta']],{'level':'department','department':root})
for role,d in [('a',a),('b',b)]:
 RESULT[role]=upload(users[role],%r+' '+role,[['Code','Reference','Total'],['S1',None,'=SUM(B2:B3)'],['S2',None,None]],{'level':'department','department':d})
frappe.db.commit()
'''%(USERS,P,P,PASSWORD,P,P,P,P,P,P,P))

def main():
 seed={};files=[]
 try:
  seed=create_fixture()
  files=seed['files'];cs={r:Client(u) for r,u in USERS.items()};target=seed['target'];source=seed['a']
  t=view(cs['a'],target);s=view(cs['a'],source)
  rows=[r['row_id'] for r in s['rows']];targets=[r['row_id'] for r in t['rows']]
  base={'table':source,'header':'Reference','target_table':target,'target_header':'Amount','expected_structure_version':s['structure_version']}
  denied=act(cs['a'],'files.table_relation_define',base);check('nonpublic upward relation denied',not ok(denied))
  pub=act(cs['a'],'platform.org.public_resource',{'resource':target,'enabled':True});check('owner publishes enterprise read only',ok(pub))
  if not ok(pub):
   print('PUBLISH_DIAGNOSTIC',json.dumps(pub,ensure_ascii=False));raise RuntimeError('publication prerequisite failed')
  for who in ('b','none'):
   st,d=service(cs[who],'files.sheet_read',{'table':target});check(who+' public read',st==200 and d.get('message',{}).get('rows',[{}])[0].get('values',{}).get('Amount',{}).get('value')==800)
  st,_=service(cs['foreign'],'files.sheet_read',{'table':target});check('foreign public read denied',st==403)
  defined=act(cs['a'],'files.table_relation_define',base);check('define permitted public reference',ok(defined));revision=val(defined).get('revision')
  for row,tr in zip(rows,targets):
   linked=act(cs['a'],'files.table_relation_set',{'table':source,'header':'Reference','row_id':row,'target_row_id':tr,'expected_revision':revision});check('link fixed row',ok(linked));revision=val(linked).get('revision')
  s=view(cs['a'],source);check('live display and formal SUM 1700',s['rows'][0]['values']['Reference']['value']==800 and s['rows'][0]['values']['Total']['value']==1700)
  check('relation exposed readonly',s['readonly_columns']==['Reference'])
  st,d=service(cs['a'],'files.table_relation_read',{'table':source,'row_ids':[]});check('empty row request definitions only',st==200 and d['message']['values']==[] and len(d['message']['definitions'])==1)
  bad=act(cs['a'],'files.sheet_cell_write',{'table':source,'row_id':rows[0],'header':'Reference','value':{'type':'number','value':123},'expected_content_version':s['content_version'],'expected_structure_version':s['structure_version']});check('direct scalar overwrite denied',not ok(bad))
  t=view(cs['a'],target)
  changed=act(cs['a'],'files.sheet_cell_write',{'table':target,'row_id':targets[0],'header':'Amount','value':{'type':'number','value':900},'expected_content_version':t['content_version'],'expected_structure_version':t['structure_version']});check('maintainer changes single source',ok(changed))
  s2=view(cs['a'],source);check('source refresh gives current 1800 without second write',s2['rows'][0]['values']['Reference']['value']==900 and s2['rows'][0]['values']['Total']['value']==1800 and s2['content_version']==s['content_version'])
  denied=act(cs['b'],'files.sheet_cell_write',{'table':target,'row_id':targets[0],'header':'Amount','value':{'type':'number','value':1},'expected_content_version':view(cs['b'],target)['content_version'],'expected_structure_version':t['structure_version']});check('public does not permit reverse write',not ok(denied))
  bs=view(cs['b'],seed['b']);defined=act(cs['b'],'files.table_relation_define',{**base,'table':seed['b'],'expected_structure_version':bs['structure_version']});check('second department references same source',ok(defined))
  linked=act(cs['b'],'files.table_relation_set',{'table':seed['b'],'header':'Reference','row_id':bs['rows'][0]['row_id'],'target_row_id':targets[0],'expected_revision':val(defined)['revision']});check('second department links',ok(linked))
  st,d=service(cs['b'],'files.table_relation_export',{'table':seed['b']});check('public read does not grant target export',st==403)
  st,d=service(cs['a'],'files.table_relation_export',{'table':source});check('authorized snapshot export',st==200 and bool(d.get('message',{}).get('content_base64')))
  if st==200:
   import openpyxl
   exported=openpyxl.load_workbook(io.BytesIO(base64.b64decode(d['message']['content_base64'])),data_only=True)
   check('export includes current values and formula cache',exported.active['B2'].value==900 and exported.active['B3'].value==900 and exported.active['C2'].value==1800)
  bridge=subprocess.run(['node',str(pathlib.Path(__file__).with_name('table-relations-http-bridge.mjs'))],input=json.dumps({'user':USERS['a'],'password':PASSWORD,'table':source,'header':'Reference','row':rows[0],'target_row':targets[0],'revision':revision}),text=True,capture_output=True,timeout=60)
  print('BRIDGE_RESULT',bridge.stdout.strip())
  if bridge.returncode:print('BRIDGE_ERROR',bridge.stderr.replace(PASSWORD,'[redacted]')[-1800:])
  check('actual TypeScript relation client through BFF',bridge.returncode==0)
  if bridge.returncode==0:revision=json.loads(bridge.stdout.strip().splitlines()[-1])['revision']
  for query,expected in [('900',2),('1800',1),('800',0)]:
   status,found=service(cs['a'],'files.sheet_read',{'table':source,'search':query,'page_length':1})
   result=found.get('message',{});check('dynamic reference search '+query,status==200 and result.get('total_rows')==expected and len(result.get('rows',[]))==min(expected,1))
  revoked=act(cs['a'],'platform.org.public_resource',{'resource':target,'enabled':False});check('revoke public grant',ok(revoked))
  st,d=service(cs['b'],'files.table_relation_read',{'table':seed['b'],'row_ids':[bs['rows'][0]['row_id']]});v=d.get('message',{}).get('values',[{}])[0]
  check('old reference revoked no value/target leak',st==200 and v.get('status')=='unavailable' and 'value' not in v and 'target' not in v and 'direct_target' not in v)
  status,found=service(cs['b'],'files.sheet_read',{'table':seed['b'],'search':'900'})
  check('revoked target excluded from search count',status==200 and found.get('message',{}).get('total_rows')==0)
  removed=act(cs['a'],'files.table_relation_remove',{'table':source,'header':'Reference','expected_revision':revision});check('unlink whole column',ok(removed))
  if not ok(removed):print('REMOVE_DIAGNOSTIC',json.dumps(removed,ensure_ascii=False))
 finally:
  console('''
from shangshu_core.public_api import execute_registered_action
for i,user in enumerate(%r):
 if frappe.db.exists('User',user):execute_registered_action('platform.identity.status',{'email':user,'enabled':False},confirmed=True,idempotency_key=%r+str(i))
for d in %r:execute_registered_action('platform.org.department_set_status',{'department':d,'enabled':False},confirmed=True,idempotency_key=%r+d)
for f in %r:
 if frappe.db.exists('Shangshu File Center File',f):frappe.db.set_value('Shangshu File Center File',f,'status','Recycled')
frappe.db.commit()
RESULT['cleaned']=True
'''%(list(USERS.values()),P+'-clean-',seed.get('departments',[]),P+'-dep-',files))
  print('CLEANED_FIXTURE',json.dumps({'prefix':P,'files':files,'departments':seed.get('departments',[])},ensure_ascii=False))
 print('FIXTURE',json.dumps({'prefix':P,'files':files},ensure_ascii=False));print('RESULT',sum(checks),'/',len(checks));return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
