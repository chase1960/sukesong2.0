"""Explicit-window-only: 3 isolated SIGKILL cases, 3 drift cases, 2 races.
No service kill, global fault config, real model, or SMTP. No work on import.
"""
import argparse,base64,copy,hashlib,importlib.util,json,os,subprocess,time,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[3]

def main():
 p=argparse.ArgumentParser();p.add_argument('--execute-window',action='store_true');p.add_argument('--suite',choices=['crash','drift','race','promotion','all'],default='all');args=p.parse_args()
 if not args.execute_window:raise SystemExit('No execution: requires --execute-window after integration owner releases window')
 os.environ['SS_ROOT']=str(ROOT);os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
 def load(n,path):
  s=importlib.util.spec_from_file_location(n,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
 t=load('recovery_http','shangshu-server/scripts/test-n2-structure.py');seed=load('recovery_seed','shangshu-server/scripts/tests/_ss_seed.py');cred=load('recovery_cred','shangshu-server/scripts/tests/_ss_cred.py');console=load('recovery_console','shangshu-server/scripts/tests/_ss_console.py')
 base=os.environ['SS_BASE'];container=console.CONTAINER
 assert base=='http://127.0.0.1:3850' and container=='shangshu-local-r967-frappe-1','wrong integration target'
 password=cred.admin_pw_for(base)
 def client():
  c=t.Client(base);c.login('Administrator',password);return c
 c=client();handles=[];children=[];checks=[]
 def ok(label,condition):
  if not condition:raise AssertionError(label)
  checks.append(label);print('PASS '+label,flush=True)
 def runconsole(code):
  r=console.run(code);assert '__error__' not in r,r;return r
 def action(a,p,key=None,who=None):
  # Exact key: console writer and HTTP replay must share it (t.action adds suffix).
  return (who or c).request('POST','/api/platform/actions/'+a+'/execute',{'payload':p,'confirmed':True,'idempotency_key':key or uuid.uuid4().hex})
 def result(response):
  st,b=response;assert st==200,(st,b);return seed._result(st,b)
 def read(table):return result(t.service(c,'files.sheet_read',{'table':table}))
 def fresh(mixed=False):
  if mixed:h=seed.seed_mixed_table(c,run='window-'+uuid.uuid4().hex[:12],attribution={'level':'personal','owner_user':'Administrator'})
  else:
   d=result(action('files.upload',{'file_name':'window-'+uuid.uuid4().hex+'.xlsx','content_base64':base64.b64encode(seed._workbook_bytes(seed.DEFAULT_ROWS)).decode(),'attribution':{'level':'personal','owner_user':'Administrator'}}));h={'table':d['file']}
  handles.append(h);return h['table']
 def payload(table,text='new',state=None):
  v=state or read(table);return {'table':table,'cells':[{'row_id':v['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':text}}],'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version'],'op_id':uuid.uuid4().hex}
 def snapshot(table):
  return runconsole("import json,hashlib\nfrom shangshu_files.sheet import _content\nfrom shangshu_files.working_file import content_revision\nd=frappe.get_doc('Shangshu File Center File',%r)\nb=_content(d)\nm=json.loads(d.sheet_meta_json or '{}')\nRESULT.update(formal=json.loads(d.formal_values_json or '{}'),sha=hashlib.sha256(b).hexdigest(),stored_sha=d.current_sha256,revision=content_revision(d),rows=m.get('rows'),structure=m.get('structure_version'),file=d.current_file,ops=frappe.db.count('Shangshu File Center Sheet Op',{'file':d.name}))"%table)
 class Child:
  def __init__(self,table,point,code):
   self.token=uuid.uuid4().hex;self.table=table;self.prefix='/tmp/ss-window-'+self.token;self.pid=None
   gate="""
import os,sys,time,json
from pathlib import Path
TOKEN=sys.argv[1];PREFIX='/tmp/ss-window-'+TOKEN
USED=False
def gate():
 global USED
 if USED:return
 USED=True
 Path(PREFIX+'.ready').write_text(json.dumps({'pid':os.getpid(),'token':TOKEN,'table':TABLE,'point':POINT}))
 end=time.monotonic()+45
 while not Path(PREFIX+'.release').exists():
  if time.monotonic()>end:raise RuntimeError('isolated gate timed out')
  time.sleep(.05)
"""
   hooks={
    'promotion-migrated':"from shangshu_files import promotion as P\noriginal=P._save_formal\ndef wrapped(*a,**k):\n r=original(*a,**k);gate();return r\nP._save_formal=wrapped",
    'promotion-activated':"from shangshu_files import promotion as P\noriginal=P.save_definition\ndef wrapped(*a,**k):\n r=original(*a,**k);gate();return r\nP.save_definition=wrapped",
    'stage':"from shangshu_core.mutable_files import WorkingFileTransaction as W\noriginal=W.stage\ndef wrapped(self,*a,**k):\n r=original(self,*a,**k);gate();return r\nW.stage=wrapped",
    'commit':"from shangshu_core.mutable_files import WorkingFileTransaction as W\noriginal=W.commit\ndef wrapped(self,*a,**k):\n gate();return original(self,*a,**k)\nW.commit=wrapped",
    'enable':"from shangshu_files import promotion as P\noriginal=P._verify_staging\ndef wrapped(*a,**k):\n r=original(*a,**k);gate();return r\nP._verify_staging=wrapped",
    'proposal':"from shangshu_core import actions as A\noriginal=A._assert_proposal_definition\ndef wrapped(*a,**k):\n r=original(*a,**k);gate();return r\nA._assert_proposal_definition=wrapped"}
   source="import frappe,json\nfrappe.init(site='shangshu.localhost',sites_path='/home/frappe/frappe-bench/sites');frappe.connect();frappe.set_user('Administrator')\nTABLE=%r;POINT=%r\n"%(table,point)+gate+'\n'+hooks[point]+"\ntry:\n exec("+repr(code)+")\n frappe.db.commit()\n print('WINDOW_RESULT '+json.dumps({'ok':True}))\nexcept Exception as e:\n frappe.db.rollback()\n print('WINDOW_RESULT '+json.dumps({'ok':False,'error':str(e)}))\nfinally:\n frappe.destroy()\n"
   self.proc=subprocess.Popen(['docker','exec','-w','/home/frappe/frappe-bench',container,'/home/frappe/frappe-bench/env/bin/python','-c',source,self.token],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(self)
  def wait_ready(self):
   end=time.monotonic()+25
   while time.monotonic()<end:
    q=subprocess.run(['docker','exec',container,'cat',self.prefix+'.ready'],capture_output=True,text=True)
    if q.returncode==0:
     m=json.loads(q.stdout);assert m['token']==self.token and m['table']==self.table;self.pid=m['pid'];return
    if self.proc.poll() is not None:raise AssertionError('child ended before gate '+str(self.proc.communicate())[:800])
    time.sleep(.15)
   raise AssertionError('child never reached gate')
  def release(self):subprocess.run(['docker','exec',container,'touch',self.prefix+'.release'],check=True,capture_output=True)
  def kill_verified(self):
   assert self.pid is not None,'must reach token gate before kill'
   code="import os,json,signal\np=%r;m=json.load(open(p+'.ready'));assert m['pid']==%r and m['token']==%r and m['table']==%r\ncmd=open('/proc/'+str(m['pid'])+'/cmdline','rb').read().split(b'\\0');assert %r.encode() in cmd and b'-c' in cmd\nos.kill(m['pid'],signal.SIGKILL)"%(self.prefix,self.pid,self.token,self.table,self.token)
   subprocess.run(['docker','exec',container,'/home/frappe/frappe-bench/env/bin/python','-c',code],check=True,capture_output=True);self.proc.communicate(timeout=15);assert self.proc.returncode!=0
  def finish(self):
   out,err=self.proc.communicate(timeout=45);rows=[json.loads(x[len('WINDOW_RESULT '):]) for x in out.splitlines() if x.startswith('WINDOW_RESULT ')];assert rows,(out,err);return rows[-1]
  def clean(self):
   if self.proc.poll() is None:
    if self.pid:self.kill_verified()
    else:
     # Never kill an unidentified process. Local gate has a hard timeout.
     self.proc.communicate(timeout=65)
   subprocess.run(['docker','exec',container,'rm','-f',self.prefix+'.ready',self.prefix+'.release'],check=True,capture_output=True)
 def action_code(a,p,k):return "from shangshu_core.public_api import execute_registered_action\nexecute_registered_action(%r,%r,confirmed=True,idempotency_key=%r)"%(a,p,k)
 def pending(table):
  return runconsole("import hashlib\nfrom pathlib import Path\nr=Path(frappe.get_site_path('private','files')).resolve();target=r/('ss-working-'+hashlib.sha256(%r.encode()).hexdigest()+'.xlsx');journal=r/'.ss-working-transactions'/(hashlib.sha256(str(target).encode()).hexdigest()+'.pending');RESULT.update(pending=journal.exists(),target=target.exists())"%table)
 try:
  if args.suite in ('crash','all'):
   for mode in ('stage','commit','first-stage'):
    table=fresh(mixed=mode!='first-stage')
    if mode!='first-stage':result(action('files.sheet_cells_write',payload(table,'warm')))
    read(table)  # settle lazy stable-row metadata before baseline snapshot
    before=snapshot(table);p=payload(table,'after-'+mode);key=uuid.uuid4().hex
    if mode!='first-stage':p['cells'].append({'row_id':read(table)['rows'][0]['row_id'],'header':'金额','value':{'type':'number','value':101}})
    child=Child(table,'stage' if mode=='first-stage' else mode,action_code('files.sheet_cells_write',p,key));child.wait_ready();child.kill_verified()
    ok(mode+' left pending journal before recovery',pending(table)['pending'])
    read(table);after=snapshot(table)
    if mode=='commit':ok(mode+' retained committed bytes once',after['revision']==before['revision']+1 and after['ops']==before['ops']+1 and after['sha']==after['stored_sha'])
    else:
     if after!=before:print('SNAPSHOT_DIFF',json.dumps({'before':before,'after':after}),flush=True)
     ok(mode+' restored exact old snapshot',after==before)
    ok(mode+' recovery removes pending',not pending(table)['pending'])
    if mode=='first-stage':ok('uncommitted first working target removed',not pending(table)['target'])
    result(action('files.sheet_cells_write',p,key));once=snapshot(table);result(action('files.sheet_cells_write',p,key));ok(mode+' same key replay does not duplicate',snapshot(table)==once and once['ops']==before['ops']+1)
    audit=runconsole("RESULT['count']=frappe.db.count('Shangshu Action Execution Audit',{'idempotency_key':%r,'status':'Succeeded'})"%key);ok(mode+' exactly one successful audit',audit['count']==1)
  def definition():return {'definition_version':1,'columns':copy.deepcopy(seed.MIXED_COLUMNS)}
  def prepare(table,d):
   v=read(table);r=result(action('files.promotion_define',{'table':table,'expected_structure_version':v['structure_version'],'dry_run':True,'definition':d}));return {'table':table,'expected_structure_version':v['structure_version'],'check_token':r.get('check_token') or r['lifecycle']['check_token'],'definition':d}
  if args.suite in ('promotion','all'):
   for phase in ('promotion-migrated','promotion-activated'):
    table=fresh();enable=prepare(table,definition());read(table);before=snapshot(table)
    def definition_snapshot():
     return runconsole("import json\nd=frappe.get_doc('Shangshu File Center File',%r)\nRESULT.update(meta=json.loads(d.sheet_meta_json or '{}'),formal=json.loads(d.formal_values_json or '{}'))"%table)
    before_definition=definition_snapshot();key=uuid.uuid4().hex
    child=Child(table,phase,action_code('files.promotion_define',enable,key));child.wait_ready();child.kill_verified()
    ok(phase+' crash preserves exact file and formal snapshot',snapshot(table)==before and definition_snapshot()==before_definition)
    result(action('files.promotion_define',enable,key));after=definition_snapshot()
    ok(phase+' retry activates all historic values once',bool(after['meta'].get('promotion')) and len(after['formal'])==len(before['rows']) and all(after['formal'][rid]['amount']==seed.DEFAULT_ROWS[i]['金额'] for i,rid in enumerate(before['rows'])))
    once=snapshot(table);result(action('files.promotion_define',enable,key));ok(phase+' same key replay leaves snapshot unchanged',snapshot(table)==once)
  if args.suite in ('drift','all'):
   for mode in ('value','header','row'):
    table=fresh();d=definition();enable=prepare(table,d);old=payload(table,'stale');v=read(table)
    if mode=='value':result(action('files.sheet_cells_write',payload(table,'during-check')))
    else:
     p={'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version'],'op_id':uuid.uuid4().hex}
     if mode=='header':p.update(from_header='备注',to_header='新备注');a='files.sheet_header_rename';d['columns'][2]['header']='新备注'
     else:p['count']=1;a='files.sheet_row_append'
     result(action(a,p))
    before=snapshot(table);st,b=action('files.promotion_define',enable);ok(mode+' old check rejected',st in (400,409,417,422) and ('结构' in str(b) or '检查' in str(b)));ok(mode+' reject preserves values',snapshot(table)==before)
    result(action('files.promotion_define',prepare(table,d)));new=read(table);ok(mode+' recheck preserves row count',len(new['rows'])==(len(v['rows'])+1 if mode=='row' else len(v['rows'])))
    st,_=action('files.sheet_cells_write',old);ok(mode+' old page write refused',st in (400,409,417,422))
  if args.suite in ('race','all'):
   table=fresh();enable=prepare(table,definition());write=payload(table,'concurrent-kept');child=Child(table,'enable',action_code('files.promotion_define',enable,uuid.uuid4().hex));child.wait_ready()
   other=client()
   with ThreadPoolExecutor(max_workers=1) as pool:
    f=pool.submit(action,'files.sheet_cells_write',write,None,other);time.sleep(.5);early=f.done();child.release();enabled=child.finish();st,b=f.result(timeout=45)
   state=read(table);ok('enable/write race never loses successful value',st!=200 or state['rows'][0]['values']['备注']['value']=='concurrent-kept');ok('enable/write race validates serialization',not early or st!=200 or not enabled['ok'])
   table=fresh(mixed=True);v=read(table);p=payload(table,'proposal-kept',v)
   out=runconsole("from shangshu_core.public_api import propose_registered_action\nr=propose_registered_action('files.sheet_cells_write',%r,idempotency_key=%r);frappe.db.commit();RESULT['id']=r['id']"%(p,uuid.uuid4().hex))
   child=Child(table,'proposal',"from shangshu_core.public_api import resolve_action_proposal\nresolve_action_proposal(%r,'confirmed')"%out['id']);child.wait_ready();d=definition();d['columns'][1]['rules']['max']=10000;other=client()
   with ThreadPoolExecutor(max_workers=1) as pool:
    f=pool.submit(action,'files.promotion_define',{'table':table,'expected_structure_version':v['structure_version'],'definition':d},None,other);time.sleep(.5);blocked=not f.done();child.release();confirmed=child.finish();st,b=f.result(timeout=45)
   ok('definition cannot pass confirmation snapshot lock',blocked);ok('confirmed proposal value retained',confirmed['ok'] and read(table)['rows'][0]['values']['备注']['value']=='proposal-kept');ok('definition completes or rejects cleanly',st in (200,400,409,417,422))
  print('RESULT',len(checks),'/',len(checks),flush=True)
 finally:
  for child in children:child.clean()
  for h in handles:assert seed.seed_cleanup(c,h)['active_left']==[]
  print('CLEANUP exact fixtures recycled; no services stopped',flush=True)
if __name__=='__main__':main()
