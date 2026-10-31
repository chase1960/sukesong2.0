"""UI028 real dispatcher regression. Dedicated synthetic managed object; coordinator deploys first.
No production objects, schema imports, customer mail, or process restarts. Run only on r967.
"""
import importlib.util,json,os,secrets,uuid,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ['SS_ROOT']=str(ROOT);os.environ['SS_BASE']='http://127.0.0.1:3850';os.environ['SS_CONTAINER']='shangshu-local-r967-frappe-1'
def load(n,p):
 s=importlib.util.spec_from_file_location(n,ROOT/p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('companion_api','shangshu-server/scripts/test-n2-structure.py');seed=load('companion_seed','shangshu-server/scripts/tests/_ss_seed.py');cred=load('companion_cred','shangshu-server/scripts/tests/_ss_cred.py');console=load('companion_console','shangshu-server/scripts/tests/_ss_console.py');fault=load('companion_fault','shangshu-server/scripts/tests/_ss_fault.py')
BASE=os.environ['SS_BASE'];CONTAINER=os.environ['SS_CONTAINER'];COMPOSE='shangshu-local-r967'
def sql(code):
 r=console.run("frappe.set_user('Administrator')\n"+code);assert not any(k in r for k in ('error','__error__')),r;return r
def action(c,name,p,key=None):
 st,b=t.action(c,name,p,key or uuid.uuid4().hex);assert st==200,(name,st,b);return seed._result(st,b)
def service(c,name,p):
 st,b=t.service(c,name,p);assert st==200,(name,st,b);return seed._result(st,b)
def config(change=None):
 code="import json\np='/home/frappe/frappe-bench/sites/shangshu.localhost/site_config.json'\nd=json.load(open(p));old={'present':'ss_fault_file' in d,'value':d.get('ss_fault_file')}\nc="+repr(change)+"\nif c is not None:\n if c['present']:d['ss_fault_file']=c['value']\n else:d.pop('ss_fault_file',None)\n with open(p,'w') as f:json.dump(d,f)\nprint(json.dumps(old))"
 p=subprocess.run(['docker','exec','-i',CONTAINER,'python3','-'],input=code,text=True,capture_output=True,timeout=15);assert p.returncode==0,p.stderr;return json.loads(p.stdout)
def main():
 c=t.Client(BASE);c.login('Administrator',cred.admin_pw_for(BASE));run=uuid.uuid4().hex[:12];fixture={};file=None;user='companion-'+run+'@example.invalid';pw=secrets.token_urlsafe(24);old=None;armed=False
 try:
  fixture=sql("from shangshu_core.public_api import create_application_definition,prepare_object_change\napp=create_application_definition(%r,%r)\nchange=prepare_object_change(app['id'],{'schema_version':1,'title':%r,'access':{'read_roles':['Desk User'],'write_roles':['Desk User'],'record_scope':'all'},'fields':[{'id':'title','label':'事项','type':'text','required':True},{'id':'amount','label':'金额','type':'decimal'}]},%r)\nfrappe.db.commit()\nRESULT.update(object_id=change['object_id'],application=app['id'],change_id=change['id'])"%('UI028-'+run,'app-'+run,'UI028-'+run,'model-'+run))
  sql("from shangshu_core.public_api import execute_object_change\nexecute_object_change(%r,True)\nfrappe.get_doc({'doctype':'User','email':%r,'first_name':'Companion Test','send_welcome_email':0,'roles':[{'role':'Desk User'}],'new_password':%r}).insert(ignore_permissions=True)\nfrappe.db.commit()\nRESULT['ok']=True"%(fixture['change_id'],user,pw))
  oid=fixture['object_id'];records=[]
  sql("from shangshu_core.public_api import get_application_definition,save_application_draft,publish_application_definition\na=get_application_definition(%r)\nd={**a['draft'],'bindings':[{'kind':'datasets','resource_id':%r,'owner_domain':a['id'],'version':'1'}]}\nsaved=save_application_draft(a['id'],d,a['draft_revision'])\npublish_application_definition(a['id'],saved['draft_revision'])\nfrappe.db.commit();RESULT['ok']=True"%(fixture['application'],oid))
  for title,amount in [('甲',10),('乙',20)]:records.append(action(c,'platform.object.create',{'object_id':oid,'expected_revision':1,'values':{'title':title,'amount':amount}})['name'])
  out=action(c,'files.create',{'file_name':'UI028-'+run+'.xlsx','attribution':{'level':'personal','owner_user':'Administrator'}});file=out['file']
  binding=action(c,'platform.object.companion_bind',{'object_id':oid,'file_id':file,'field_columns':[{'field_id':'title','header':'事项'},{'field_id':'amount','header':'金额'}]})
  def read(who=c):return service(who,'files.sheet_read',{'table':file})
  def version(r):return {'expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']}
  r=read();assert set(x['row_id'] for x in r['rows'])==set(records)
  action(c,'files.sheet_column_append',{'table':file,'header':'备注',**version(r)})
  r=read();action(c,'files.sheet_cells_write',{'table':file,'cells':[{'row_id':rid,'header':'备注','value':{'type':'text','value':'保留-'+str(i)}} for i,rid in enumerate(records)],'op_id':uuid.uuid4().hex,**version(r)})
  r=read();action(c,'files.sheet_style_write',{'table':file,'cells':[{'row_id':records[0],'header':'金额'}],'style':{'bold':True},'op_id':uuid.uuid4().hex,**version(r)})
  def snapshot():
   return sql("from shangshu_files import sheet\nfrom shangshu_core.objects import query_object_records\nimport hashlib\nd=frappe.get_doc(sheet.DOCTYPE,%r)\nRESULT.update(sha=hashlib.sha256(sheet._content(d)).hexdigest(),version=sheet.content_revision(d),rows=sheet._load_meta(d).get('rows'),source=query_object_records(%r)['rows'],ops=frappe.db.count(sheet.OP_DOCTYPE,{'file':d.name}))"%(file,oid))
  before=read();row=next(x for x in before['rows'] if x['row_id']==records[0])
  action(c,'platform.object.update',{'object_id':oid,'name':records[0],'expected_revision':1,'expected_modified':row['source_modified'],'values':{'amount':11}})
  r=read();row=next(x for x in r['rows'] if x['row_id']==records[0]);assert row['values']['金额']['value']==11 and row['values']['备注']['value']=='保留-0'
  from io import BytesIO
  from openpyxl import load_workbook
  def exported():
   versions=service(c,'files.versions',{'file':file});st,data=t.download(c,file,versions['current']['frappe_file']);assert st==200,(st,data)
   return load_workbook(BytesIO(data['_bytes'])).active
  ws=exported();physical=next(x['row_index'] for x in r['rows'] if x['row_id']==records[0]);assert ws.cell(physical,2).font.bold and ws.cell(physical,2).value==11
  assert ws.max_row==3 and ws.max_column==3
  print('PASS actual bind dispatcher and original update preserve ordinary values and XLSX format',flush=True)
  def pack(n=30):
   r=read();return {'object_id':oid,'file_id':file,'expected_revision':1,'definition_revision':binding['definition_revision'],**version(r),'expected_modified':{x['row_id']:x['source_modified'] for x in r['rows']},'op_id':uuid.uuid4().hex,'cells':[{'row_id':rid,'header':header,'value':val} for i,rid in enumerate(records) for header,val in [('金额',{'type':'number','value':n+i}),('备注',{'type':'text','value':'混合-'+str(n+i)})]]}
  p=pack();before=snapshot();out=action(c,'platform.object.companion_write',p,p['op_id']);after=snapshot();assert after['version']==before['version']+1 and after['ops']==before['ops']+1
  action(c,'platform.object.companion_write',p,p['op_id']);assert snapshot()==after
  r=read();undo={'object_id':oid,'file_id':file,'expected_revision':1,'definition_revision':binding['definition_revision'],'undo_of':p['op_id'],'op_id':uuid.uuid4().hex,**version(r)}
  action(c,'platform.object.companion_undo',undo,undo['op_id']);r=read();vals={x['row_id']:x['values'] for x in r['rows']};assert vals[records[0]]['金额']['value']==11 and vals[records[1]]['金额']['value']==20 and vals[records[0]]['备注']['value']=='保留-0'
  print('PASS cross-row mixed single-version save, same-key replay and atomic inverse',flush=True)
  # A later source validation failure must roll back earlier successful source writes.
  p=pack();p['cells'].append({'row_id':records[1],'header':'事项','value':{'type':'empty','value':None}});before=snapshot();st,b=t.action(c,'platform.object.companion_write',p,p['op_id']);assert st in (400,409,417,422),(st,b);assert snapshot()==before
  print('PASS later-row original Action validation rolls back entire package',flush=True)
  assert subprocess.run(['docker','exec',CONTAINER,'test','-e',fault.FAULT_PATH],capture_output=True).returncode==1
  old=config();assert old['value'] in (None,''),old;config({'present':True,'value':fault.FAULT_PATH})
  for i,point in enumerate(['companion-before-save','file-write','post-save','op-record']):
   p=pack(50+i);before=snapshot();ok,detail=fault.arm(COMPOSE,point);assert ok,detail;armed=True
   try:
    st,b=t.action(c,'platform.object.companion_write',p,p['op_id']);assert st!=200,(point,st,b)
    failure=sql("from shangshu_core.action_requests import request_name\nRESULT.update(frappe.db.get_value('Shangshu Action Request',{'request_key':request_name(%r)},['status','failure_reason'],as_dict=True) or {})"%t.receipt_key(p['op_id']))
    assert failure.get('status')=='Failed' and '注入故障：'+point in failure.get('failure_reason',''),failure
   finally:fault.clear(COMPOSE);armed=False
   assert snapshot()==before,point
   p['op_id']=uuid.uuid4().hex;action(c,'platform.object.companion_write',p,p['op_id']);good=snapshot();action(c,'platform.object.companion_write',p,p['op_id']);assert snapshot()==good
   print('PASS exact fault '+point+' atomic rollback and clear/retry/replay',flush=True)
  action(c,'platform.org.share_grant',{'resource':file,'user':user,'access':'edit'});u=t.Client(BASE);u.login(user,pw);read(u)
  action(c,'platform.org.share_revoke',{'resource':file,'user':user});st,b=t.service(u,'files.sheet_read',{'table':file});assert st==403,(st,b)
  p=pack();st,b=t.action(u,'platform.object.companion_write',p,p['op_id']);assert st==403,(st,b)
  print('PASS revoked file grant cannot read or mixed-write; RESULT PASS',flush=True)
 finally:
  if armed:fault.clear(COMPOSE)
  if old is not None:config(old)
  if fixture:
   # Exact test-owned source rows only: keep schema/audit history; recycle values.
   for rid in locals().get('records',[]):
    try:
     current=sql("from shangshu_core.objects import get_object_record\nRESULT.update(get_object_record(%r,%r)['record'])"%(fixture['object_id'],rid))
     action(c,'platform.object.recycle',{'object_id':fixture['object_id'],'name':rid,'expected_revision':1,'expected_modified':current['modified']})
    except Exception as error:print('CLEANUP source recycle pending',rid,type(error).__name__,flush=True)
   sql("if frappe.db.exists('User',%r):frappe.db.set_value('User',%r,'enabled',0)\nfrappe.db.commit();RESULT['ok']=True"%(user,user))
  if file:
   result=seed.seed_cleanup(c,{'table':file});assert not result['active_left'],result
  if fixture:
   sql("from shangshu_core.public_api import get_application_definition,set_application_enabled\na=get_application_definition(%r)\nif a.get('published_revision'):set_application_enabled(a['id'],False,'UI028 synthetic test cleanup',a['draft_revision'])\nfrappe.db.commit();RESULT['ok']=True"%fixture['application'])
  print('CLEANUP',json.dumps({'file':file,'fixture':fixture},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
