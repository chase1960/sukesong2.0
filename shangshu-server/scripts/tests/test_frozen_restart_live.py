"""Explicit prepare/verify/cleanup phases; coordinator alone restarts QA between phases.

Never run against ACCEPTANCE_ONLY. State file contains synthetic resource IDs only.
"""
import argparse, hashlib, importlib.util, json, os, subprocess, uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
os.environ.setdefault('SS_ROOT',str(ROOT))
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('restart_http','shangshu-server/scripts/test-n2-structure.py')
seed=load('restart_seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('restart_cred','shangshu-server/scripts/tests/_ss_cred.py')

def main():
 ap=argparse.ArgumentParser();ap.add_argument('phase',choices=['prepare','verify','cleanup']);ap.add_argument('--state',required=True);a=ap.parse_args()
 base=os.environ.get('SS_BASE','')
 if base!='http://127.0.0.1:3850':ap.error('This probe is restricted to the designated QA 3850, never the clean trial station')
 c=t.Client(base);c.login('Administrator',cred.admin_pw_for(base));path=Path(a.state)
 def good(r):
  st,b=r;assert st==200 and b.get('ok') is not False,(st,b);return b.get('result',b)
 def act(name,p,key=None):return good(t.action(c,name,p,key or uuid.uuid4().hex))
 def svc(name,p):return good(t.service(c,name,p))
 def started():return {n:subprocess.check_output(['docker','inspect','-f','{{.State.StartedAt}}',n],text=True).strip() for n in ['shangshu-local-r967-node-1','shangshu-local-r967-frappe-1']}
 def capture(s):
  sheet=svc('files.sheet_read',{'table':s['table']})
  mail=svc('mail.detail',{'mail':s['mail']})['mail']
  versions=svc('files.versions',{'file':s['table']});ref=versions['current']['frappe_file']
  workbook=good(t.download(c,s['table'],ref))['_bytes']
  attachments=mail.get('attachments') or [];assert attachments,'fixed attachment missing'
  # Compare immutable attachment bytes as well as the attachment identifier.
  fixed=attachments[0]['file']
  import _ss_console
  raw=_ss_console.run("import hashlib\nRESULT['attachment_sha']=hashlib.sha256(frappe.get_doc('File',%r).get_content()).hexdigest()\nRESULT['formal']=frappe.db.get_value('Shangshu File Center File',%r,'formal_values_json')"%(fixed,s['table']))
  assert '__error__' not in raw,raw
  previous=s.get('before',{}).get('action_snapshot',[])
  filters={'name':previous[0]['name']} if previous else {'idempotency_key':s['mail_receipt_key']}
  audit=_ss_console.run("RESULT['audit']=frappe.get_all('Shangshu Action Execution Audit',filters=%r,fields=['name','action_id','status','input_summary_json'])"%filters)
  assert '__error__' not in audit and len(audit['audit'])==1,audit
  return {'rows':sheet['rows'],'content_version':sheet['content_version'],'structure_version':sheet['structure_version'],
          'formal':raw['formal'],'workbook_sha':hashlib.sha256(workbook).hexdigest(),
          'mail':{k:mail.get(k) for k in ['name','subject','body','status','attachments']},'attachment_sha':raw['attachment_sha'],
          'action_snapshot':audit['audit']}
 if a.phase=='prepare':
  assert not path.exists(),'state exists: do not overwrite prior fixture'
  s={'run':'restart-'+uuid.uuid4().hex,'started':started()}
  path.write_text(json.dumps(s));os.chmod(path,0o600)
  h=seed.seed_mixed_table(c,run=s['run'],rows=[{'项目名称':'restart synthetic','金额':721.5,'备注':'preserve ordinary'}],attribution={'level':'personal','owner_user':'Administrator'})
  s['table']=h['table'];path.write_text(json.dumps(s))
  ref=svc('files.versions',{'file':s['table']})['current']['frappe_file']
  s['mail_key']=uuid.uuid4().hex;s['mail_receipt_key']=t.receipt_key(s['mail_key']);path.write_text(json.dumps(s))
  mail=act('mail.save_draft',{'subject':s['run'],'body':'<p>preserve draft</p>','to':[],'cc':[],'attachments':[ref]},s['mail_key'])
  s['mail']=mail['name'];path.write_text(json.dumps(s))
  s['before']=capture(s)
  assert s['before']['formal'],'formal database fixture must exist'
  assert s['before']['mail']['status']=='Draft','must remain a draft'
  assert s['before']['mail']['subject']==s['run']
  assert 'preserve draft' in str(s['before']['mail']['body']),'body fixture missing'
  assert s['before']['rows'][0]['values']['金额']['value']==721.5
  assert s['before']['rows'][0]['values']['备注']['value']=='preserve ordinary'
  path.write_text(json.dumps(s));print('PREPARED synthetic formal/ordinary/draft/fixed attachment',flush=True)
 elif a.phase=='verify':
  s=json.loads(path.read_text());now=started()
  assert all(now[n]!=s['started'][n] for n in now),'both processes must actually restart'
  after=capture(s)
  for key,value in s['before'].items():
   if key=='rows':
    assert len(after[key])==len(value)
    for old,new in zip(value,after[key]):
     assert {k:v for k,v in old.items() if k!='styles'}=={k:v for k,v in new.items() if k!='styles'}
     for column,style in old.get('styles',{}).items():
      assert all(new['styles'][column].get(k)==v for k,v in style.items()),'existing style changed'
    # A schema upgrade may expose additional style properties. Workbook bytes
    # below must still match exactly, so this does not waive format preservation.
   else:assert after[key]==value,key
   print('PASS restart preserves '+key,flush=True)
  s['after']=after;s['restarted']=now;path.write_text(json.dumps(s));print('RESULT PASS',flush=True)
 else:
  s=json.loads(path.read_text())
  if s.get('mail'):
   detail=svc('mail.detail',{'mail':s['mail']})['mail']
   act('mail.recycle',{'mail':s['mail'],'expected_version':detail['record_version']})
  if s.get('table'):act('files.recycle',{'file':s['table']})
  s['cleaned']=True;path.write_text(json.dumps(s));print('CLEANED exact synthetic resources',flush=True)

if __name__=='__main__':main()
