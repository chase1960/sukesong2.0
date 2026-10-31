"""Standalone formal DB write vs pending XLSX projection, on explicit isolated QA."""
import os, sys, json, uuid, subprocess, importlib.util
from pathlib import Path

def main():
 if '--execute-live' not in sys.argv:
  print('NOT_RUN: exclusive QA fault window required');return 1
 root=Path(__file__).resolve().parents[3];os.environ['SS_ROOT']=str(root)
 assert os.environ.get('SS_BASE')=='http://127.0.0.1:3850'
 assert os.environ.get('SS_CONTAINER')=='shangshu-local-r967-frappe-1'
 import _ss_seed as seed, _ss_console as console, _ss_fault as fault
 from _ss_cred import admin_pw_for
 spec=importlib.util.spec_from_file_location('pending_api',root/'shangshu-server/scripts/test-n2-structure.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
 c=api.Client(os.environ['SS_BASE']);c.login('Administrator',admin_pw_for(os.environ['SS_BASE']))
 container=os.environ['SS_CONTAINER'];compose=fault.compose_of(os.environ['SS_BASE']);run=uuid.uuid4().hex
 handle=None;old=None;configured=False;checks=[]
 def config(change=None):
  code="""import json,os,stat,tempfile
p='/home/frappe/frappe-bench/sites/shangshu.localhost/site_config.json'
d=json.load(open(p));prior={'present':'ss_fault_file' in d,'value':d.get('ss_fault_file')}
change=json.loads(%r)
if change is not None:
 if change['present']:d['ss_fault_file']=change['value']
 else:d.pop('ss_fault_file',None)
 fd,tmp=tempfile.mkstemp(dir=os.path.dirname(p));os.fchmod(fd,stat.S_IMODE(os.stat(p).st_mode))
 with os.fdopen(fd,'w') as f:json.dump(d,f);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
print(json.dumps(prior))
"""%json.dumps(change)
  p=subprocess.run(['docker','exec','-i',container,'/home/frappe/frappe-bench/env/bin/python','-'],input=code,text=True,capture_output=True,check=True,timeout=30)
  return json.loads(p.stdout)
 def check(label,ok):
  assert ok,label
  checks.append(label);print('PASS '+label,flush=True)
 def snap():
  r=console.run("import json,hashlib,io\nfrom openpyxl import load_workbook\nfrom shangshu_files.sheet import _content\nd=frappe.get_doc('Shangshu File Center File',%r)\nb=_content(d)\nw=load_workbook(io.BytesIO(b));s=w.active\nRESULT.update(formal=json.loads(d.formal_values_json or '{}'),pending=json.loads(d.sheet_meta_json or '{}').get('writeback_pending',{}),sha=hashlib.sha256(b).hexdigest(),ref=d.current_file,project=s.cell(2,1).value,amount=s.cell(2,2).value,format=s.cell(2,2).number_format,note=s.cell(2,3).value)"%handle['table'])
  assert '__error__' not in r,r;return r
 def write(amount,key):
  st,b=api.action(c,'files.formal_value_write',{'table':handle['table'],'row_id':handle['row_ids'][0],'values':{'amount':amount}},run+key)
  assert st==200,(st,b);return seed._result(st,b)
 try:
  p=subprocess.run(['docker','exec',container,'test','-e',fault.FAULT_PATH]);assert p.returncode==1,'another active fault'
  old=config();assert old['value'] in (None,''),'another configured fault'
  config({'present':True,'value':fault.FAULT_PATH});configured=True
  handle=seed.seed_mixed_table(c,run='pending-'+run,attribution={'level':'personal','owner_user':'Administrator'})
  print('FIXTURE '+handle['table'],flush=True)
  base=snap();normal=write(111,'-normal');before=snap()
  check('normal formal write projects only value and keeps adjacent value/format',normal['formal_written'] and normal['sheet_written'] and before['amount']==111 and before['note']==base['note'] and before['format']==base['format'])
  check('ready current file downloads',seed._got_bytes(*api.download(c,handle['table'],before['ref']))[0])
  armed,why=fault.arm(compose,'file-write');assert armed,why
  try:result=write(222,'-pending')
  finally:assert fault.clear(compose)[0]
  pending=snap();rid=handle['row_ids'][0]
  check('receipt distinguishes persisted formal value from failed projection',result['formal_written'] and not result['sheet_written'] and result['pending'])
  check('real DB changed while real file bytes stayed old and pending persisted',pending['formal'][rid]['amount']==222 and pending['amount']==111 and pending['sha']==before['sha'] and rid in pending['pending'])
  st,b=api.download(c,handle['table'],pending['ref']);check('bare current-file URL rejects pending projection',st in (400,403,409,417,422) and not seed._got_bytes(st,b)[0])
  st,b=api.service(c,'files.versions',{'file':handle['table']});check('version export entry also rejects pending latest file',st in (400,403,409,417,422))
  st,b=api.action(c,'files.formal_value_write',{'table':handle['table'],'row_id':rid,'values':{'project_name':'新项目'}},run+'-other-field')
  assert st==200,(st,b)
  other=seed._result(st,b);partial=snap()
  check('successful unrelated field does not clear failed field pending',other['sheet_written'] and other['pending'] and partial['project']=='新项目' and partial['amount']==111 and partial['pending'][rid]['values']=={'amount':222})
  st,b=api.download(c,handle['table'],partial['ref']);check('partial recovery keeps complete-file export blocked',st in (400,403,409,417,422))
  recovered=write(222,'-recover');after=snap()
  check('explicit recovery projects authoritative value and clears pending',recovered['sheet_written'] and not after['pending'] and after['amount']==222 and after['formal'][rid]['amount']==222)
  check('download reopens after recovery with same adjacent value and format',seed._got_bytes(*api.download(c,handle['table'],after['ref']))[0] and after['note']==base['note'] and after['format']==base['format'])
  stale=console.run("from shangshu_files import promotion\nd=frappe.get_doc('Shangshu File Center File',%r)\ntry:\n promotion._writeback(d,promotion.load_definition(d),%r,{'amount':111})\n RESULT['rejected']=False\nexcept frappe.TimestampMismatchError:\n RESULT['rejected']=True"%(handle['table'],rid))
  check('delayed old projection rejects and preserves latest DB and XLSX',stale.get('rejected') is True and snap()==after)
  print('RESULT %d/%d'%(len(checks),len(checks)),flush=True)
 finally:
  if configured:
   assert fault.clear(compose)[0];config(old);assert config()==old
   print('CLEANUP original fault configuration restored, fault file absent',flush=True)
  if handle:
   receipt=seed.seed_cleanup(c,handle);assert receipt['active_left']==[]
   print('CLEANUP exact workbook recycled; audit/trash retained',flush=True)
 return 0
if __name__=='__main__':sys.exit(main())
