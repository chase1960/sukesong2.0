"""r967-only mixed transaction fault checks; restores site config and recycles its own fixture."""
import importlib.util
import json
import os
import subprocess
import uuid
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[3]
os.environ['SS_ROOT']=str(ROOT)
os.environ['SS_BASE']='http://127.0.0.1:3850'
os.environ['SS_CONTAINER']='shangshu-local-r967-frappe-1'
BASE=os.environ['SS_BASE']; CONTAINER=os.environ['SS_CONTAINER']
BENCH='/home/frappe/frappe-bench'; CONFIG=BENCH+'/sites/shangshu.localhost/site_config.json'

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

t=load('fault_api','shangshu-server/scripts/test-n2-structure.py')
seed=load('fault_seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('fault_cred','shangshu-server/scripts/tests/_ss_cred.py')
fault=load('fault_points','shangshu-server/scripts/tests/_ss_fault.py')
console=load('fault_console','shangshu-server/scripts/tests/_ss_console.py')
compose=fault.compose_of(BASE)
assert compose=='shangshu-local-r967' and console.CONTAINER==CONTAINER

# Print only this one non-secret config key, never the site config/credentials.
def config(change=None):
    code='''import json,os,stat,tempfile
p=%r
d=json.load(open(p)); prior={'present':'ss_fault_file' in d,'value':d.get('ss_fault_file')}
change=json.loads(%r)
if change is not None:
 if change['present']:d['ss_fault_file']=change['value']
 else:d.pop('ss_fault_file',None)
 fd,name=tempfile.mkstemp(dir=os.path.dirname(p))
 os.fchmod(fd,stat.S_IMODE(os.stat(p).st_mode))
 with os.fdopen(fd,'w') as stream:json.dump(d,stream,indent=1);stream.flush();os.fsync(stream.fileno())
 os.replace(name,p)
print(json.dumps(prior))
'''%(CONFIG,json.dumps(change))
    proc=subprocess.run(['docker','exec','-i',CONTAINER,BENCH+'/env/bin/python','-'],input=code,capture_output=True,text=True,timeout=30)
    assert proc.returncode==0,'site config operation failed'
    return json.loads(proc.stdout)

def checked_console(code):
    result=console.run(code)
    assert '__error__' not in result,result
    return result

def snapshot(table):
    return checked_console('''import hashlib,json
from shangshu_files.working_file import content_revision
from shangshu_files.sheet import _content
doc=frappe.get_doc('Shangshu File Center File',%r)
content=_content(doc)
meta=json.loads(doc.sheet_meta_json or '{}')
RESULT.update(formal=json.loads(doc.formal_values_json or '{}'),sha=hashlib.sha256(content).hexdigest(),
 stored_sha=doc.current_sha256,revision=content_revision(doc),rows=meta.get('rows'),
 structure=meta.get('structure_version'),file=doc.current_file,
 op_count=frappe.db.count('Shangshu File Center Sheet Op',{'file':doc.name}))
'''%table)

def read(client,table):
    st,b=t.service(client,'files.sheet_read',{'table':table});assert st==200,(st,b)
    return seed._result(st,b)

import secrets
client=t.Client(BASE);client.login('Administrator',cred.admin_pw_for(BASE))
run=uuid.uuid4().hex[:12];handle=None;old=None;changed=False;user='structure-'+run+'@example.invalid';pwd=secrets.token_urlsafe(25)
def action(name,payload,key=None,actor=client):
 return t.action(actor,name,payload,key or uuid.uuid4().hex)
def versions(v):return {'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
try:
 p=subprocess.run(['docker','exec',CONTAINER,'test','-e',fault.FAULT_PATH],capture_output=True,timeout=10);assert p.returncode==1
 old=config();assert old['value'] in (None,'');config({'present':True,'value':fault.FAULT_PATH});changed=True
 handle=seed.seed_mixed_table(client,run='structure-'+run,attribution={'level':'personal','owner_user':'Administrator'});table=handle['table'];print('FIXTURE',table,flush=True)
 for point in ['file-write','post-save','op-record']:
  before=snapshot(table);view=read(client,table);op=uuid.uuid4().hex
  payload={'table':table,'row_id':view['rows'][0]['row_id'],'op_id':op,**versions(view)}
  ok,detail=fault.arm(compose,point);assert ok,detail
  try:
   st,body=action('files.sheet_row_move',payload,op);assert st!=200,(point,st,body)
   failure=checked_console("from shangshu_core.action_requests import request_name\nRESULT.update(frappe.db.get_value('Shangshu Action Request', {'request_key': request_name(%r)}, ['status','failure_reason'], as_dict=True) or {})"%t.receipt_key(op))
   assert failure.get('status')=='Failed' and ('注入故障：'+point) in failure.get('failure_reason',''),failure
  finally:
   ok,detail=fault.clear(compose);assert ok,detail
  assert snapshot(table)==before,(point,before,snapshot(table))
  payload['op_id']=uuid.uuid4().hex;st,body=action('files.sheet_row_move',payload,payload['op_id']);assert st==200,(st,body)
  success=snapshot(table);assert success['revision']==before['revision']+1 and success['formal']==before['formal']
  st,body=action('files.sheet_row_move',payload,payload['op_id']);assert st==200 and snapshot(table)==success,(st,body)
  v=read(client,table);st,body=action('files.sheet_structure_undo',{'table':table,'undo_of':payload['op_id'],**versions(v)});assert st==200,(st,body)
  assert snapshot(table)['sha']==before['sha'];assert snapshot(table)['rows']==before['rows'];assert snapshot(table)['formal']==before['formal']
  print('PASS',point,'exact injected failure atomic rollback; retry/replay; exact structure undo',flush=True)
 # Concurrent content change is never erased by structural inverse.
 v=read(client,table);op=uuid.uuid4().hex;st,b=action('files.sheet_column_insert',{'table':table,'header':'临时列','op_id':op,**versions(v)},op);assert st==200,(st,b)
 v=read(client,table);st,b=action('files.sheet_cells_write',{'table':table,'cells':[{'row_id':v['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':'later-edit'}}],'op_id':uuid.uuid4().hex,**versions(v)});assert st==200,(st,b)
 before=snapshot(table);v=read(client,table);st,b=action('files.sheet_structure_undo',{'table':table,'undo_of':op,**versions(v)});assert st in (400,403,409,417,422),(st,b);assert snapshot(table)==before
 print('PASS later edit blocks inverse with zero writes',flush=True)
 checked_console("frappe.get_doc({'doctype':'User','email':%r,'first_name':'Structure test','send_welcome_email':0,'roles':[{'role':'Desk User'}],'new_password':%r}).insert(ignore_permissions=True)\nfrappe.db.commit();RESULT['ok']=True"%(user,pwd))
 st,b=action('platform.org.share_grant',{'resource':table,'user':user,'access':'edit'});assert st==200,(st,b)
 employee=t.Client(BASE);employee.login(user,pwd);v=read(employee,table);before=snapshot(table)
 st,b=action('files.sheet_row_move',{'table':table,'row_id':v['rows'][0]['row_id'],**versions(v)},actor=employee);assert st==403,(st,b);assert snapshot(table)==before
 st,b=action('platform.org.share_revoke',{'resource':table,'user':user});assert st==200
 st,b=action('files.sheet_row_restore',{'table':table,'row_id':v['rows'][0]['row_id'],**versions(v)},actor=employee);assert st==403,(st,b);assert snapshot(table)==before
 print('PASS edit share does not grant structure; revoked user cannot restore; RESULT PASS',flush=True)
finally:
 if changed:
  fault.clear(compose);config(old);assert config()==old;print('RESTORED fault configuration',flush=True)
 if handle:
  cleanup=seed.seed_cleanup(client,handle);assert not cleanup['active_left'];print('RECYCLED',handle['table'],flush=True)
 checked_console("if frappe.db.exists('User',%r):frappe.db.set_value('User',%r,'enabled',0)\nfrappe.db.commit();RESULT['ok']=True"%(user,user))
