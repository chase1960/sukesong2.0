"""Explicit-window 10k list and 1000-cell HTTP timing; unique disposable mailbox.

No external transport. Seeds once, measures 20 samples, recycles exact actor-owned
messages using the existing action, then disables only the fresh fixture identity.
Cold-process/OS-cache/browser-interactive latency is deliberately not claimed.
"""
import argparse,json,math,os,subprocess,sys,time,uuid,urllib.parse,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ.setdefault('SS_ROOT',str(ROOT))
import _ss_console
def console(code,timeout=240):
 result=_ss_console.run(code,timeout=timeout)
 if '__error__' in result:raise RuntimeError(str(result['__error__'])+' '+str(result.get('__trace__','')))
 return result

def fixture(payload):
 p=subprocess.run([sys.executable,str(Path(__file__).with_name('mail-default-identity-fixture.py'))],input=json.dumps(payload),text=True,capture_output=True)
 if p.returncode:raise RuntimeError('fixture failure; sensitive output suppressed')
 return json.loads(p.stdout)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');ap.add_argument('--count',type=int,default=10000);args=ap.parse_args()
 if not args.execute_window:ap.error('requires scheduled --execute-window')
 assert args.count in (20,10000),'only smoke 20 or acceptance 10000'
 assert os.environ.get('SS_CONTAINER')=='shangshu-local-r967-frappe-1'
 assert os.environ.get('SS_BASE')=='http://127.0.0.1:3850'
 spec=importlib.util.spec_from_file_location('mail_perf_client',ROOT/'shangshu-server/scripts/test-n2-structure.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
 f=fixture({'mode':'seed'});created=[]
 print('FIXTURE '+json.dumps({k:f[k] for k in ('user','prefix','mailbox','department')}),flush=True)
 try:
  seeded=console('''
from shangshu_mail import service
frappe.set_user(%r)
RESULT['mails']=[]
with service.writing():
 for i in range(%d):
  m=frappe.get_doc({'doctype':'Shangshu Mail Message','status':'Received','subject':%r+' search '+str(i),'body':'synthetic','body_format':'HTML','to_json':'[]','cc_json':'[]','from_address':'synthetic@example.invalid','record_version':1,'mailbox_id':%r,'received_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
  RESULT['mails'].append(m.name)
  if i%%200==199:frappe.db.commit()
frappe.db.commit()
'''%(f['user'],args.count,f['prefix'],f['mailbox']))
  created.extend(seeded['mails']);assert len(created)==args.count
  c=api.Client(os.environ['SS_BASE']);c.login(f['user'],f['password'])
  def request(method,path,p=None):
   status,value=c.request(method,path,p)
   assert status==200 and value.get('ok') is not False,(status,value.get('error'))
   return value.get('result',value)
  def action(name,p):return request('POST','/api/platform/actions/'+name+'/execute',{'payload':p,'confirmed':True,'idempotency_key':uuid.uuid4().hex})
  def detail(name):return request('POST','/api/platform/services/mail.detail/invoke',{'payload':{'mail':name}})['mail']
  def timed(label,fn,limit):
   samples=[]
   for _ in range(20):
    t=time.perf_counter();fn();samples.append((time.perf_counter()-t)*1000)
   result={'label':label,'samples_ms':samples,'n':20,'p95_ms':sorted(samples)[math.ceil(.95*len(samples))-1],'max_ms':max(samples),'budget_ms':limit,'within_budget':all(x<=limit for x in samples),'mail_count':args.count,'mode':'HTTP warm process; no cache reset'}
   print(json.dumps(result),flush=True)
   assert result['within_budget'],label+' exceeds budget'
  def listing(search=False):
   filters={'mailbox':f['mailbox'],'scope':'inbox'}
   if search:filters['q']='search'
   value=request('GET','/api/platform/datasets/mail.message/records?'+urllib.parse.urlencode({'filters':json.dumps(filters),'page':1,'page_length':50}))
   assert len(value['rows'])==min(50,args.count)
   assert value['unread_counts']['mine']==args.count
  timed('list 50 + unread counts',listing,2000)
  timed('search 50 + unread counts',lambda:listing(True),1000)
  html='<table>'+''.join('<tr>'+''.join('<td>R%dC%d</td>'%(r,c) for c in range(20))+'</tr>' for r in range(50))+'</table>'
  d=action('mail.save_draft',{'subject':f['prefix']+' 1000 cells','body':html,'body_format':'HTML','to':[],'cc':[]});created.append(d['name']);current=detail(d['name']);size=len(current['body'].encode())
  def save_reopen():
   nonlocal current
   action('mail.save_draft',{'mail':d['name'],'expected_version':current['record_version'],'subject':current['subject'],'body':current['body'],'body_format':'HTML','to':[],'cc':[]})
   current=detail(d['name'])
   assert current['body'].count('<td')==1000 and 'R49C19' in current['body']
   assert len(current['body'].encode())==size and current['status']=='Draft'
  # Explicitly observational: no pre-agreed save+reopen budget is invented.
  samples=[]
  for _ in range(20):
   t=time.perf_counter();save_reopen();samples.append((time.perf_counter()-t)*1000)
  print(json.dumps({'label':'1000 cells HTTP save+reopen','samples_ms':samples,'p95_ms':sorted(samples)[18],'max_ms':max(samples),'normalized_bytes':size,'n':20,'budget_ms':None}),flush=True)
  print('RESULT '+('10k acceptance samples' if args.count==10000 else 'SMOKE ONLY; not 10k evidence'))
 finally:
  # Exact unique actor: captures interrupted seed/draft writes without prefix matching.
  console("""
from shangshu_core.public_api import execute_registered_action
frappe.set_user(%r)
rows=frappe.get_all('Shangshu Mail Message',filters={'owner':%r,'status':['!=','Trash']},fields=['name','record_version'],limit_page_length=20000)
for i,row in enumerate(rows):
 execute_registered_action('mail.recycle',{'mail':row.name,'expected_version':row.record_version},confirmed=True,idempotency_key='mailperf-clean-'+row.name)
 if i%%100==99:frappe.db.commit()
frappe.db.commit()
assert frappe.db.count('Shangshu Mail Message',{'owner':%r,'status':['!=','Trash']})==0
"""%(f['user'],f['user'],f['user']),timeout=1200)
  fixture({'mode':'cleanup','fixture':f,'mails':[]})
  print('CLEANUP exact fresh actor messages recycled; account/identity/department disabled',flush=True)
if __name__=='__main__':main()
