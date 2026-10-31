"""UI104 real authenticated API checks; run only after integration deployment release.
Uses exact synthetic identities/files; retains action audit and disables fixtures.
"""
import json,sys,uuid
from test_organization_audit_live import Client,console,PASSWORD,check,checks
PREFIX='owner'+uuid.uuid4().hex[:10]
USERS={r:f'{PREFIX}-{r}@example.invalid' for r in ('old','new','head','peer','foreign')}
def action(client,name,payload):
 return client.call('action_execute',{'action_id':name,'payload':json.dumps(payload),'confirmed':1,'idempotency_key':PREFIX+'-'+uuid.uuid4().hex},post=True)
def result(response):return response[1].get('message',{}).get('result',{})
def ok(response):return response[0]==200 and response[1].get('message',{}).get('status') not in ('failed','error') and bool(result(response))
def main():
 seed={};files=[]
 try:
  seed=console('''
from shangshu_core.public_api import execute_registered_action
users=%r
seq=0
def act(a,p):
 global seq
 seq+=1
 r=execute_registered_action(a,p,confirmed=True,idempotency_key=%r+str(seq))
 return r['result']
for role,email in users.items():
 act('platform.identity.create',{'email':email,'display_name':%r+' '+role,'initial_password':%r,'role':'staff','collaboration_scope':'related'})
 name=frappe.db.get_value('Shangshu Identity',{'user':email},'name')
 frappe.db.set_value('Shangshu Identity',name,'enterprise_id',%r+('-foreign' if role=='foreign' else ''))
frappe.db.commit()
a=act('platform.org.department_create',{'name':%r+' A','enterprise':%r})['department']
c=act('platform.org.department_create',{'name':%r+' Child','enterprise':%r,'parent':a})['department']
b=act('platform.org.department_create',{'name':%r+' Peer','enterprise':%r})['department']
act('platform.org.head_assign',{'user':users['head'],'department':a})
for role,dep in [('old',c),('new',c),('peer',b)]:act('platform.org.member_assign',{'user':users[role],'department':dep})
RESULT.update({'a':a,'child':c,'peer':b})
frappe.db.commit()
'''%(USERS,PREFIX,PREFIX,PASSWORD,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX))
  cs={r:Client(u) for r,u in USERS.items()}
  created=action(cs['old'],'files.create',{'file_name':PREFIX+'.xlsx','attribution':{'level':'personal','owner_user':USERS['old']}})
  check('create personal file through API',ok(created));fid=result(created).get('file');files.append(fid)
  if not fid:raise RuntimeError('file creation failed')
  target={'resource':fid,'level':'personal','owner_user':USERS['new']}
  preview=action(cs['old'],'platform.org.resource_assign',{**target,'dry_run':True});p=result(preview)
  check('owner preview gives version and actual losses',ok(preview) and bool(p.get('expected_modified')) and any(e.get('user')==USERS['old'] and e.get('write')=={'before':True,'after':False} for e in p.get('effects',[])))
  bad=action(cs['old'],'platform.org.resource_assign',target);check('confirm missing preview version denied',not ok(bad))
  for owner in (USERS['foreign'],'missing-'+PREFIX+'@example.invalid',''):
   bad=action(cs['old'],'platform.org.resource_assign',{**target,'owner_user':owner,'dry_run':True});check('invalid target denied '+('empty' if not owner else 'foreign-or-absent'),not ok(bad))
  done=action(cs['old'],'platform.org.resource_assign',{**target,'dry_run':False,'expected_modified':p.get('expected_modified')});check('owner transfer applies',ok(done) and result(done).get('applied') is True)
  bad=action(cs['old'],'platform.org.resource_assign',{**target,'owner_user':USERS['old'],'dry_run':True});check('old creator cannot take ownership back',not ok(bad))
  bad=action(cs['old'],'files.update_meta',{'file':fid,'file_name':'forbidden.xlsx'});check('old creator cannot write via direct API',not ok(bad))
  good=action(cs['new'],'files.update_meta',{'file':fid,'file_name':PREFIX+'-new.xlsx'});check('new owner can write',ok(good))
  denied_read=action(cs['old'],'files.sheet_range_read',{'table':fid});check('old creator loses read absent independent grant',not ok(denied_read))
  ls=cs['old'].call('dataset_records',{'dataset_id':'files.file','filters':json.dumps({'scope':'sheet','q':PREFIX}),'page':1,'page_length':100})
  listing=ls[1].get('message',{})
  check('old creator directory count excludes transferred file',ls[0]==200 and listing.get('total')==0)
  granted=action(cs['new'],'platform.org.share_grant',{'resource':fid,'user':USERS['old'],'access':'edit'});check('current owner grants independent edit',ok(granted))
  shared_write=action(cs['old'],'files.update_meta',{'file':fid,'file_name':PREFIX+'-shared.xlsx'});check('explicit shared edit survives owner history',ok(shared_write))
  shared_read=action(cs['old'],'files.sheet_range_read',{'table':fid});check('explicit shared edit permits read',ok(shared_read))
  shared_assign=action(cs['old'],'platform.org.resource_assign',{**target,'dry_run':True});check('shared edit does not grant assignment',not ok(shared_assign))
  shared_share=action(cs['old'],'platform.org.share_grant',{'resource':fid,'user':USERS['peer'],'access':'edit'});check('shared edit does not grant re-sharing',not ok(shared_share))
  revoked=action(cs['new'],'platform.org.share_revoke',{'resource':fid,'user':USERS['old']});check('current owner revokes explicit share',ok(revoked))
  head=action(cs['head'],'platform.org.resource_assign',{**target,'owner_user':USERS['old'],'dry_run':True});check('head manages descendant personal owner',ok(head))
  peer=action(cs['peer'],'platform.org.resource_assign',{**target,'dry_run':True});check('peer cannot preview assignment',not ok(peer))
  cross=action(cs['head'],'platform.org.resource_assign',{**target,'owner_user':USERS['peer'],'dry_run':True});check('head cannot move outside managed range',not ok(cross))
  dep={'resource':fid,'level':'department','department':seed['child']}
  missing=action(cs['new'],'platform.org.resource_assign',{**dep,'dry_run':True});check('department custodian must be explicit',not ok(missing))
  dp=action(cs['new'],'platform.org.resource_assign',{**dep,'owner_user':USERS['new'],'dry_run':True});check('department target preview',ok(dp))
  applied=action(cs['new'],'platform.org.resource_assign',{**dep,'owner_user':USERS['new'],'expected_modified':result(dp).get('expected_modified')});check('department keeps explicit current custodian',ok(applied))
  stale=action(cs['head'],'platform.org.resource_assign',{**target,'expected_modified':p.get('expected_modified')});check('stale preview cannot overwrite current attribution',not ok(stale))
  clear=action(cs['head'],'platform.org.resource_assign',{**dep,'owner_user':'','dry_run':True})
  cleared=action(cs['head'],'platform.org.resource_assign',{**dep,'owner_user':'','expected_modified':result(clear).get('expected_modified')});check('head can explicitly clear department custodian',ok(cleared) and result(cleared).get('current',{}).get('owner_user') is None)
  bad=action(cs['new'],'files.update_meta',{'file':fid,'file_name':'forbidden-cleared.xlsx'});check('former custodian loses write after clear',not ok(bad))
  observed=console("RESULT['rows']=frappe.get_all('Shangshu Org Attribution',filters={'resource':%r},fields=['owner_user','department'])\nRESULT['creator']=frappe.db.get_value('Shangshu File Center File',%r,'owner')"%(fid,fid))
  check('single authoritative attribution and creator only history',len(observed['rows'])==1 and not observed['rows'][0]['owner_user'] and observed['creator']==USERS['old'])
 finally:
  cleanup=console('''
from shangshu_core.public_api import execute_registered_action
for i,user in enumerate(%r):
 if frappe.db.exists('User',user):execute_registered_action('platform.identity.status',{'email':user,'enabled':False},confirmed=True,idempotency_key=%r+str(i))
for dep in %r:
 execute_registered_action('platform.org.department_set_status',{'department':dep,'enabled':False},confirmed=True,idempotency_key=%r+dep)
for file in %r:
 if file and frappe.db.exists('Shangshu File Center File',file):frappe.db.set_value('Shangshu File Center File',file,'status','Recycled')
frappe.db.commit()
RESULT['cleaned']=True
'''%(list(USERS.values()),PREFIX+'-clean-user-',list(seed.values()),PREFIX+'-clean-dept-',files))
  check('exact fixtures disabled',cleanup.get('cleaned') is True)
 print('FIXTURE',json.dumps({'prefix':PREFIX,'files':files,'departments':seed},ensure_ascii=False))
 print('RESULT',sum(checks),'/',len(checks));return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
