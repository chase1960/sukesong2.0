"""UI017/018/020/104 incremental lifecycle; exact synthetic fixtures, no full matrix."""
import json,os,sys,uuid
if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: exclusive QA window and --execute-live required')
if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 required')
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('permlife',('owner','member','head','peer'));proposals=[];personal=None

def check(label,ok):f.check(label,ok);assert ok,label
def act(client,name,payload):
 r=f.action(client,name,payload);assert (r[0]==200 and r[1].get('ok') is not False and result(r).get('fatal') is not True),(name,r);return result(r)
def service(client,name,payload):
 r=f.service(client,name,payload);assert r[0]==200,r;return result(r)
def read(client,table):return service(client,'files.sheet_read',{'table':table})
def latch(client,table):
 v=read(client,table);return {'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
def denied(r):return r[0] in (400,401,403,409,417)
def state(table):
 out=f.console_module.run("from shangshu_files.sheet import _content\nimport hashlib\nd=frappe.get_doc('Shangshu File Center File',%r)\nRESULT['state']={k:d.get(k) for k in ['formal_values_json','sheet_meta_json','version_count','current_file','modified']}\nRESULT['state']['sha']=hashlib.sha256(_content(d)).hexdigest()\nRESULT['state']['attribution']=frappe.get_all('Shangshu Org Attribution',filters={'resource':d.name},fields=['name','level','owner_user','department','modified'])"%table)
 assert '__error__' not in out,out
 return out['state']
def proposal(client_user,table):
 v=read(f.clients[client_user],table);payload={'table':table,'cells':[{'row_id':v['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':f.prefix+'-candidate-secret'}}],'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
 out=f.console_module.run("from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(%r)\nRESULT['proposal']=propose_registered_action('files.sheet_cells_write',%r,idempotency_key=%r)['id']\nfrappe.db.commit()"%(f.users[client_user],payload,f.prefix+'-proposal-'+uuid.uuid4().hex));assert '__error__' not in out,out
 proposals.append((out['proposal'],table));return out['proposal']
def review(client,pid):return client.request('GET','/api/platform/action-proposals/'+pid+'/review')
def resolve(client,pid,decision):return client.request('POST','/api/platform/action-proposals/'+pid+'/resolve',{'decision':decision})
try:
 f.setup();a=f.clients['owner'];b=f.clients['member'];head=f.clients['head'];peer=f.clients['peer']
 personal=f.upload('owner','personal',{'level':'personal','owner_user':f.users['owner']});pid=proposal('owner',personal)
 oldref=service(a,'files.versions',{'file':personal})['current']['frappe_file']
 check('management reader has content but not owner candidate eligibility',read(head,personal)['rows'] and denied(review(head,pid)))
 target={'resource':personal,'level':'personal','owner_user':f.users['member']}
 hp=act(head,'platform.org.resource_assign',{**target,'dry_run':True});before=state(personal)
 act(f.admin,'platform.org.head_remove',{'user':f.users['head'],'department':f.departments['a']})
 r=f.action(head,'platform.org.resource_assign',{**target,'expected_modified':hp['expected_modified']})
 check('removed head cannot execute former preview and attribution remains unchanged',denied(r) and state(personal)==before)
 act(f.admin,'platform.identity.status',{'email':f.users['peer'],'enabled':False})
 r=f.action(a,'platform.org.resource_assign',{**target,'owner_user':f.users['peer'],'dry_run':True})
 check('disabled user cannot become transfer target',denied(r) and state(personal)==before)
 act(f.admin,'platform.identity.status',{'email':f.users['peer'],'enabled':True})
 act(f.admin,'platform.org.department_set_status',{'department':f.departments['peer'],'enabled':False})
 r=f.action(a,'platform.org.resource_assign',{'resource':personal,'level':'department','department':f.departments['peer'],'owner_user':f.users['owner'],'dry_run':True})
 check('disabled department cannot become transfer target',denied(r) and state(personal)==before)
 act(f.admin,'platform.org.department_set_status',{'department':f.departments['peer'],'enabled':True})
 preview=act(a,'platform.org.resource_assign',{**target,'dry_run':True});payload={**target,'expected_modified':preview['expected_modified']};key=f.prefix+'-transfer'
 def transfer():return a.request('POST','/api/platform/actions/platform.org.resource_assign/execute',{'payload':payload,'confirmed':True,'idempotency_key':key})
 first=transfer();assert successful(first),first;f.file_clients[personal]=b;transferred=state(personal);again=transfer()
 check('successful transfer original key replays same receipt without duplicate attribution',successful(again) and result(again)==result(first) and state(personal)==transferred and len(transferred['attribution'])==1)
 for path in ['/api/platform/action-proposal-get/'+pid,'/api/platform/action-proposals/'+pid+'/review','/api/platform/action-proposals/'+pid+'/units?offset=0&limit=1']:
  r=a.request('GET',path);check('old owner current session candidate/detail/units revoked '+path.rsplit('/',1)[-1],denied(r) and f.prefix+'-candidate-secret' not in json.dumps(r[1]))
 check('old owner original download reference rejected after transfer',denied(f.t.download(a,personal,oldref)))
 r=f.action(a,'files.sheet_column_append',{'table':personal,'header':'forbidden','expected_content_version':read(b,personal)['content_version'],'expected_structure_version':read(b,personal)['structure_version']})
 check('old creator structure request denied and transfer state preserved',denied(r) and state(personal)==transferred)
 check('new owner original download and candidate review are independently allowed',f.t.download(b,personal,oldref)[0]==200 and review(b,pid)[0]==200)
 act(b,'platform.org.share_grant',{'resource':personal,'user':f.users['owner'],'access':'read'})
 check('read reauthorization restores original actor candidate visibility',review(a,pid)[0]==200)
 before=state(personal);r=resolve(a,pid,'confirmed')
 check('read reauthorization does not grant confirmation write or download',denied(r) and state(personal)==before and denied(f.t.download(a,personal,oldref)))
 r=resolve(b,pid,'confirmed');check('new current owner confirms inherited candidate with actual value write',r[0]==200 and read(b,personal)['rows'][0]['values']['备注']['value']==f.prefix+'-candidate-secret')
 act(b,'files.sheet_column_append',{**latch(b,personal),'header':'new-owner-column','op_id':f.prefix+'-structure'})
 check('new owner structure change independently persists','new-owner-column' in read(b,personal)['headers'])
 # A department member is a reader/downloader, not the custodian or proposal reviewer.
 department=f.upload('owner','department',{'level':'department','department':f.departments['a']});dp=proposal('owner',department);ref=service(a,'files.versions',{'file':department})['current']['frappe_file']
 check('member department read/download positive control but no review',read(b,department)['rows'] and f.t.download(b,department,ref)[0]==200 and denied(review(b,dp)))
 act(f.admin,'platform.org.member_remove',{'user':f.users['member'],'department':f.departments['a']})
 act(f.admin,'platform.org.member_assign',{'user':f.users['member'],'department':f.departments['peer']})
 check('job transfer invalidates same-session old table and download links',denied(f.service(b,'files.sheet_read',{'table':department})) and denied(f.t.download(b,department,ref)))
 listing=result(f.listing(b,q=f.prefix+'-department'));check('job transfer directory count excludes inaccessible department resource',listing.get('total')==0)
 act(f.admin,'platform.org.member_assign',{'user':f.users['member'],'department':f.departments['a']})
 check('reauthorization refreshes same-session read/download without adding review',read(b,department)['rows'] and f.t.download(b,department,ref)[0]==200 and denied(review(b,dp)))
 before=state(department);r=f.action(b,'files.sheet_column_append',{**latch(a,department),'header':'forbidden-member','op_id':f.prefix+'-member-structure'})
 check('department read/download reauthorization does not grant structure',denied(r) and state(department)==before)
finally:
 # Resolve only this run's proposals under their current authorized owner/admin.
 for pid,table in proposals:
  r=resolve(f.file_clients[table],pid,'rejected')
  print('PROPOSAL_CLEANUP',pid,json.dumps(r,ensure_ascii=False))
  f.check('exact proposal resolved or already confirmed '+pid,r[0]==200 or '已确认' in json.dumps(r[1],ensure_ascii=False))
 f.cleanup()
raise SystemExit(f.finish())
