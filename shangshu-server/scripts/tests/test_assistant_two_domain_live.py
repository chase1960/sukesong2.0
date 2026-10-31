"""One real Assistant turn, two domains, no SMTP, actual proposal/receipt trace."""
import os,sys,json,uuid,subprocess,io,base64,importlib.util,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];os.environ['SS_BASE']='http://127.0.0.1:3850'
from test_organization_audit_live import console
sp=importlib.util.spec_from_file_location('api',ROOT/'shangshu-server/scripts/test-n2-structure.py');api=importlib.util.module_from_spec(sp);sp.loader.exec_module(api)
helper=Path(__file__).with_name('mail-default-identity-fixture.py')
def fixture(x):
 p=subprocess.run([sys.executable,str(helper)],input=json.dumps(x),text=True,capture_output=True,check=True);return json.loads(p.stdout)
f=fixture({'mode':'seed'});c=api.Client(os.environ['SS_BASE']);c.login(f['user'],f['password']);mails=[];file=None;checks=[];proposals=[]
def good(r):
 st,d=r
 if st!=200 or d.get('ok') is False:raise AssertionError(str(st)+' '+str(d.get('error')))
 return d.get('result',d)
def act(a,p):return good(c.request('POST','/api/platform/actions/'+a+'/execute',{'payload':p,'confirmed':True,'idempotency_key':uuid.uuid4().hex}))
def svc(a,p):return good(c.request('POST','/api/platform/services/'+a+'/invoke',{'payload':p}))
def check(name,v):
 if not v:raise AssertionError(name)
 checks.append(name);print('PASS '+name,flush=True)
try:
 import openpyxl
 w=openpyxl.Workbook();w.active.append(['备注']);w.active.append(['原值']);b=io.BytesIO();w.save(b)
 file=act('files.upload',{'file_name':f['prefix']+'.xlsx','content_base64':base64.b64encode(b.getvalue()).decode(),'attribution':{'level':'personal','owner_user':f['user']}})['file']
 draft=act('mail.save_draft',{'subject':'原始标题','body':'<p>保持正文</p>','body_format':'HTML','to':[],'cc':[]});mails.append(draft['name'])
 prompt=f"这是合成验收。请在这一次会话完成两个待人工审核提案，不要执行，不发送邮件：1. 使用files.sheet_cells_write将表身份{file}第一个数据行的备注改成跨域已核对；2. 使用mail.save_draft将已有草稿{draft['name']}主题改成跨域邮件已核对，正文和收件人保持原样。请先用工具读取现行版本和schema，再创建两个提案。禁止创建新的邮件或修改其他资源。"
 cid='twodomain'+uuid.uuid4().hex[:12];req=urllib.request.Request(c.base+'/api/chat',data=json.dumps({'message':prompt,'conversation_id':cid}).encode(),headers={'Content-Type':'application/json'},method='POST')
 with c.opener.open(req,timeout=180) as r:raw=r.read().decode()
 events=[]
 for block in raw.split('\n\n'):
  lines=block.splitlines();typ=next((x[7:] for x in lines if x.startswith('event: ')),None);data=next((x[6:] for x in lines if x.startswith('data: ')),None)
  if typ and data:events.append({'event':typ,'data':json.loads(data)})
 Path(ROOT/'docs/reports/r967-20261019/assistant-two-domain-events.json').write_text(json.dumps(events,ensure_ascii=False,indent=2))
 proposals=[{'id':e['data']['id'],'action_id':e['data']['capability']} for e in events if e['event']=='confirm']
 print('PROPOSALS',json.dumps(proposals,ensure_ascii=False),flush=True)
 check('one real Assistant turn produced both domains',len(proposals)==2 and {p['action_id'] for p in proposals}=={'files.sheet_cells_write','mail.save_draft'})
 traces=[]
 for p in proposals:
  pid=p.get('id') or p.get('name');before=good(c.request('GET','/api/platform/audit-chat?actor_user='+f['user']+'&proposal_id='+pid));check(p['action_id']+' trace links real trigger before decision',before['status']=='linked' and before['context']['trigger']==prompt)
  outcome=good(c.request('POST','/api/platform/action-proposals/'+pid+'/resolve',{'decision':'confirmed'}));print('RESOLVED',json.dumps(outcome,ensure_ascii=False),flush=True)
  trace=good(c.request('GET','/api/platform/audit-chat?actor_user='+f['user']+'&proposal_id='+pid));traces.append(trace);print('TRACE_DECISION',json.dumps(trace.get('decision'),ensure_ascii=False),flush=True)
 check('both domain traces share one conversation and turn',len({t['conversation_id'] for t in traces})==1 and len({t['turn_id'] for t in traces})==1)
 for trace in traces:
  decision=trace['decision'];receipts=decision['receipts']
  check('exact one successful receipt '+trace['proposal_id'],len(receipts)==1 and receipts[0]['status']=='Succeeded')
  operation=receipts[0]['audit'];back=good(c.request('GET','/api/platform/audit-chat?actor_user='+f['user']+'&operation_id='+operation))
  check('operation recovers same proposal/trigger '+trace['proposal_id'],back['status']=='linked' and back['proposal_id']==trace['proposal_id'] and back['context']['trigger']==prompt)
 read=svc('files.sheet_read',{'table':file});check('Excel authoritative value saved',read['rows'][0]['values']['备注']['value']=='跨域已核对')
 mail=svc('mail.detail',{'mail':draft['name']})['mail'];check('same draft saved, not sent, body retained',mail['subject']=='跨域邮件已核对' and mail['status']=='Draft' and mail['body']=='<p>保持正文</p>')
 history=good(c.request('GET','/api/chat/history'))['list'];cards=[r.get('cards') for r in history if cid in r['conversation_id']];check('history persisted both domain references',all(any(p['id'] in json.dumps(v) for v in cards) for p in proposals))

 Path(ROOT/'docs/reports/r967-20261019/assistant-two-domain-traces.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2))
 print('RESULT',len(checks),'/',len(checks),flush=True)
finally:
 if file:console("frappe.db.set_value('Shangshu File Center File',%r,'status','Recycled');frappe.db.commit();RESULT['cleaned']=True"%file)
 fixture({'mode':'cleanup','fixture':f,'mails':mails});print('CLEANED',f['prefix'],flush=True)
