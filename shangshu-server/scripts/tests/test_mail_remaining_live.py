"""Scheduled controlled IMAP + real queue/import + attachment HTTP + optional QA model."""
import argparse,json,os,sys,time,subprocess,uuid,hashlib,math,urllib.request,urllib.parse
from pathlib import Path
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture,console
ROOT=Path(__file__).resolve().parents[3];REPORT=ROOT/'docs/reports/r967-20261019'
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');ap.add_argument('--model',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('requires scheduled window')
 f=fixture({'mode':'seed'});mails=[];files=[];op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));base=os.environ['SS_BASE'];tag=f['prefix']
 def http(path,data=None,binary=False):
  req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
  try:
   with op.open(req,timeout=120) as r:return r.read() if binary else json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(str(e.code)+' '+e.read().decode()[:500])
 def svc(name,payload):
  d=http('/api/platform/services/'+name+'/invoke',{'payload':payload});return d.get('result',d)
 def act(name,payload):
  d=http('/api/platform/actions/'+name+'/execute',{'payload':payload,'confirmed':True,'idempotency_key':uuid.uuid4().hex});return d.get('result',d)
 def model(prompt,turn):
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/mail-assistant-continuity-worker.ts'],input=json.dumps({**f,'conversation':tag+'-continuity','prompt':prompt}),text=True,capture_output=True,timeout=210)
  if p.returncode:raise RuntimeError('model worker: '+p.stderr[-1500:])
  out=json.loads(p.stdout.strip().splitlines()[-1]);(REPORT/('mail-continuity-'+tag+'-'+turn+'.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2));return out
 try:
  http('/api/platform/login',{'username':f['user'],'password':f['password']})
  p=subprocess.run([sys.executable,str(Path(__file__).with_name('mail-controlled-imap-fixture.py'))],input=json.dumps({'fixture':f}),text=True,capture_output=True,timeout=120)
  if p.returncode:raise RuntimeError(p.stderr[-1800:])
  received=json.loads(p.stdout);mails.append(received['mail']);print('PASS production IMAP protocol parse + repeated UID no duplicate',json.dumps(received),flush=True)
  deadline=time.monotonic()+60
  while True:
   imported=svc('files.imported_of',{'source_files':received['attachments']})['items']
   if len(imported)==2 and all(i.get('file_center_id') for i in imported):break
   if time.monotonic()>deadline:raise AssertionError('actual queued import did not finish: '+json.dumps(imported))
   time.sleep(2)
  files=[i['file_center_id'] for i in imported];print('PASS actual after-commit queue imported both attachments',files,flush=True)
  detail=svc('mail.detail',{'mail':received['mail']})['mail'];print('DETAIL_KEYS',list(detail),flush=True)
  # Identify bytes independently; parser/File ids retain original attachment order.
  large=received['attachments'][1];ref={'ref_doctype':'Shangshu Mail Message','ref_name':received['mail'],'file':large}
  duration={'download':[],'preview':[]}
  for i in range(20):
   begin=time.perf_counter();raw=http('/api/platform/file-content?'+urllib.parse.urlencode({'ref':ref['ref_doctype'],'ref_name':ref['ref_name'],'file':large}),binary=True);duration['download'].append((time.perf_counter()-begin)*1000)
   assert len(raw)==received['large_bytes'] and hashlib.sha256(raw).hexdigest()==received['large_sha256']
   begin=time.perf_counter();preview=svc('platform.file.preview',ref);duration['preview'].append((time.perf_counter()-begin)*1000)
   assert preview['blocks']==[{'type':'paragraph','text':'UI066 synthetic preview 731.25'}]
  summary={k:{'samples':len(v),'p95_ms':round(sorted(v)[math.ceil(len(v)*.95)-1],3),'max_ms':round(max(v),3)} for k,v in duration.items()}
  print('PERFORMANCE',json.dumps(summary),'10MiB DOCX; no numeric acceptance budget; warm process; no browser rendering',flush=True)
  if args.model:
   draft=act('mail.save_draft',{'subject':tag+' 核对草稿','body':'原草稿','to':[],'cc':[]});mails.append(draft['name'])
   prompt=f'合成验收，只处理来信{received["mail"]}及已有草稿{draft["name"]}。请真实读取来信、其xlsx附件的文件中心入库引用和表数据。先将附件原始项目和金额写进该草稿正文作为核对依据；另按来信正文的核对金额修改附件表中该项目金额。创建两个待人工确认提案，不执行、不发送、不创建新邮件。数值必须来自工具读取，不猜。'
   out=model(prompt,'source');proposals=[e['data'] for e in out['events'] if e['event']=='confirm'];assert {p['capability'] for p in proposals}=={'mail.save_draft','files.sheet_cells_write'},out['reply']
   assert len(proposals)==2
   for p in proposals:http('/api/platform/action-proposals/'+p['id']+'/resolve',{'decision':'confirmed'})
   updated=svc('mail.detail',{'mail':draft['name']})['mail'];assert updated['status']=='Draft' and '731.25' in updated['body'] and '合成甲' in updated['body']
   table=next(i['file_center_id'] for i in imported if i['source_file']==received['attachments'][0]);sheet=svc('files.sheet_read',{'table':table});assert float(sheet['rows'][0]['values']['金额']['value'])==862.4
   print('PASS real QA model same conversation attachment->file center->table->draft and mail->table data source',flush=True)
   same=tag+' 同名待核对';one=act('mail.save_draft',{'subject':same,'body':'甲稿原文','to':[],'cc':[]});two=act('mail.save_draft',{'subject':same,'body':'乙稿原文','to':[],'cc':[]});mails.extend([one['name'],two['name']])
   ambiguous=model(f'接下来请把主题为“{same}”的草稿正文改成“同名已核对”。仍只提案，不发送。','ambiguous')
   assert not any(e['event']=='confirm' for e in ambiguous['events']),ambiguous['reply']
   assert any(w in ambiguous['reply'] for w in ['哪一','哪封','指定','选择']),ambiguous['reply']
   chosen=model('选择正文为乙稿原文的那封，请按刚才要求仅为这封生成待审核提案。','chosen')
   selected=[e['data'] for e in chosen['events'] if e['event']=='confirm'];assert len(selected)==1 and selected[0]['capability']=='mail.save_draft'
   p=http('/api/platform/action-proposal-get/'+selected[0]['id']);assert p['payload']['mail']==two['name']
   http('/api/platform/action-proposals/'+selected[0]['id']+'/resolve',{'decision':'confirmed'})
   assert svc('mail.detail',{'mail':one['name']})['mail']['body']=='甲稿原文'
   assert '同名已核对' in svc('mail.detail',{'mail':two['name']})['mail']['body']
   print('PASS actual model same-name draft clarification and chosen stable-ID isolation',flush=True)
  print('RESULT completed requested stages',flush=True)
 finally:
  # Exact actor cleanup, including partial fixture failure before IDs returned.
  cleanup=console('USER='+repr(f['user'])+'\n'+'''
from shangshu_core.public_api import resolve_action_proposal,execute_registered_action
frappe.set_user(USER)
for p in frappe.get_all('Shangshu Action Proposal',filters={'actor_user':USER,'status':'Proposed'},pluck='name'):resolve_action_proposal(p,'rejected')
RESULT['mails']=frappe.get_all('Shangshu Mail Message',filters={'owner':USER},pluck='name')
# Cleanup runs only after queue completion/failure has been observed by caller.
RESULT['files']=frappe.get_all('Shangshu File Center File',filters={'owner':USER,'status':['!=','Recycled']},pluck='name')
for n in RESULT['files']:execute_registered_action('files.recycle',{'file':n},confirmed=True,idempotency_key=USER+'-cleanup-'+n)
frappe.db.commit()
''')
  fixture({'mode':'cleanup','fixture':f,'mails':cleanup['mails']});print('CLEANUP',tag,json.dumps(cleanup),flush=True)
if __name__=='__main__':main()
