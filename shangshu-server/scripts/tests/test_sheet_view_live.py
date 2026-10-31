"""Isolated r967 API acceptance. Run only after coordinator releases deployment."""
import importlib.util,os,secrets,uuid,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ.update(SS_ROOT=str(ROOT),SS_BASE='http://127.0.0.1:3850',SS_CONTAINER='shangshu-local-r967-frappe-1')
def load(n,p):
 s=importlib.util.spec_from_file_location(n,ROOT/p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('view_api','shangshu-server/scripts/test-n2-structure.py');seed=load('view_seed','shangshu-server/scripts/tests/_ss_seed.py');cred=load('view_cred','shangshu-server/scripts/tests/_ss_cred.py');console=load('view_console','shangshu-server/scripts/tests/_ss_console.py')
def sql(code):
 r=console.run(code);assert '__error__' not in r,r;return r
def action(c,a,p,ok=True):
 st,b=t.action(c,a,p,uuid.uuid4().hex)
 if ok:assert st==200,(a,st,b)
 else:assert st in (400,403,409,417,422),(a,st,b)
 return seed._result(st,b) if ok else b
def service(c,a,p):
 st,b=t.service(c,a,p);assert st==200,(a,st,b);result=dict(seed._result(st,b));result.pop('ok',None);return result
run=uuid.uuid4().hex[:12];users=['view-a-'+run+'@example.invalid','view-b-'+run+'@example.invalid'];pwd=secrets.token_urlsafe(25)
a=t.Client(os.environ['SS_BASE']);a.login('Administrator',cred.admin_pw_for(os.environ['SS_BASE']));h=None
try:
 sql("for email in %r:\n frappe.get_doc({'doctype':'User','email':email,'first_name':'View Test','send_welcome_email':0,'roles':[{'role':'Desk User'}],'new_password':%r}).insert(ignore_permissions=True)\nfrappe.db.commit()\nRESULT['ok']=True"%(users,pwd))
 h=seed.seed_mixed_table(a,run='view-'+run,attribution={'level':'personal','owner_user':'Administrator'});table=h['table'];clients=[]
 for u in users:
  action(a,'platform.org.share_grant',{'resource':table,'user':u,'access':'edit'});c=t.Client(os.environ['SS_BASE']);c.login(u,pwd);clients.append(c)
 def read(c=a):return service(c,'files.sheet_read',{'table':table})
 def view(c):return service(c,'files.sheet_view_read',{'table':table})
 def save(c,value,previous=None):
  old=previous or view(c)
  return action(c,'files.sheet_view_save',{'table':table,'expected_revision':old['revision'],'expected_structure_version':old['structure_version'],'view':value})
 def config(value):return {'filters':[{'column':'项目名称','operator':'equals','value':value}],'freeze':{'rows':1,'columns':1}}
 va=save(clients[0],config('夹具乙'));vb=save(clients[1],config('夹具甲'))
 assert va['total_rows']==vb['total_rows']==1 and va['rows'][0]['row_id']!=vb['rows'][0]['row_id']
 for c,v in zip(clients,[va,vb]):
  actual=view(c);assert actual==v,{"saved":v,"reread":actual}
 assert view(a)['revision']==0
 print('PASS independent two-user persisted filter/freeze and administrator default',flush=True)
 stale=va;save(clients[0],config('夹具乙'))
 action(clients[0],'files.sheet_view_save',{'table':table,'expected_revision':stale['revision'],'expected_structure_version':stale['structure_version'],'view':config('夹具甲')},False)
 print('PASS stale personal revision rejected',flush=True)
 before=read();rid=va['rows'][0]['row_id'];op=uuid.uuid4().hex
 def write_payload(**kw):
  r=read();return dict(table=table,expected_content_version=r['content_version'],expected_structure_version=r['structure_version'],op_id=uuid.uuid4().hex,**kw)
 p=write_payload(start_row=0,start_col=2,value={'type':'text','value':'filtered-edit'},target_row_ids=[rid])
 action(clients[0],'files.sheet_input_write',p);r=read();assert r['rows'][1]['values']['备注']['value']=='filtered-edit' and r['rows'][0]==before['rows'][0]
 p=write_payload(start_row=0,start_col=1,matrix=[[77,'filtered-paste']],matrix_types=[['number','text']],target_row_ids=[rid],extend=True)
 action(clients[0],'files.sheet_paste_apply',p);r=read();assert r['rows'][1]['values']['金额']['value']==77
 action(clients[0],'files.sheet_cells_undo',{'table':table,'op_id':p['op_id']});r=read();assert r['rows'][1]['values']['金额']==before['rows'][1]['values']['金额'] and r['rows'][1]['values']['备注']['value']=='filtered-edit'
 p=write_payload(start_row=1,start_col=2,matrix=[['physical-tail']],target_row_ids=[None],append_at_end=True,extend=True)
 action(clients[0],'files.sheet_paste_apply',p,False) # edit sharing does not confer structure ownership
 save(a,config('夹具乙'))
 action(a,'files.sheet_paste_apply',p);r=read();assert len(r['rows'])==len(before['rows'])+1 and r['rows'][-1]['values']['备注']['value']=='physical-tail' and [x['row_id'] for x in r['rows'][:2]]==[x['row_id'] for x in before['rows']]
 print('PASS filtered stable-ID input/paste/undo and physical-tail append',flush=True)
 # Field revocation: saved private predicate must disappear, not return sensitive criteria.
 cols=json.loads(json.dumps(seed.MIXED_COLUMNS));cols[0]['read_roles']=[]
 action(a,'files.promotion_define',{'table':table,'expected_structure_version':r['structure_version'],'definition':{'definition_version':1,'columns':cols}})
 denied=view(clients[0]);assert denied.get('invalid_reason') and denied['view']['filters']==[] and '夹具乙' not in json.dumps(denied,ensure_ascii=False)
 print('PASS field revocation invalidates old predicate without returning it',flush=True)
 action(a,'files.promotion_define',{'table':table,'expected_structure_version':r['structure_version'],'definition':{'definition_version':1,'columns':seed.MIXED_COLUMNS}})
 save(clients[0],config('夹具乙'));r=read()
 action(a,'files.sheet_column_append',{'table':table,'sheet':'','header':'新增列','expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']})
 invalid=view(clients[0]);assert invalid.get('invalid_reason') and invalid['view']['filters']==[]
 print('PASS structure change invalidates saved predicates',flush=True)
 action(a,'platform.org.share_revoke',{'resource':table,'user':users[0]})
 st,b=t.service(clients[0],'files.sheet_view_read',{'table':table});assert st==403 and '夹具乙' not in json.dumps(b,ensure_ascii=False)
 print('PASS table revocation blocks stale personal view; RESULT PASS',flush=True)
finally:
 if h:
  cleanup=seed.seed_cleanup(a,h);assert not cleanup['active_left']
 # Disable ephemeral accounts rather than deleting audit actors.
 sql("for email in %r:\n if frappe.db.exists('User',email):frappe.db.set_value('User',email,'enabled',0)\nfrappe.db.commit()\nRESULT['disabled']=True"%users)
 print('CLEANUP fixture recycled; temporary users disabled (audit identities retained)',flush=True)
