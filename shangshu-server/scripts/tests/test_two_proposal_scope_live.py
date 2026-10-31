"""Two domains pending simultaneously; partial failure never expands confirmation scope."""
import os,sys,json,uuid,subprocess,base64,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];os.environ['SS_ROOT']=str(ROOT);os.environ['SS_BASE']='http://127.0.0.1:3850'
from test_organization_audit_live import console
sp=importlib.util.spec_from_file_location('api',ROOT/'shangshu-server/scripts/test-n2-structure.py');api=importlib.util.module_from_spec(sp);sp.loader.exec_module(api)
import _ss_seed as seed
helper=Path(__file__).with_name('mail-default-identity-fixture.py')
def fx(x):
 p=subprocess.run([sys.executable,str(helper)],input=json.dumps(x),text=True,capture_output=True);assert p.returncode==0,'fixture failed';return json.loads(p.stdout)
f=fx({'mode':'seed'});c=api.Client(os.environ['SS_BASE']);mails=[];file=None;checks=[]
def result(r):
 st,b=r;assert st==200,(st,b);return b.get('result',b)
def action(a,p):return result(c.request('POST','/api/platform/actions/'+a+'/execute',{'payload':p,'confirmed':True,'idempotency_key':uuid.uuid4().hex}))
def detail(id):return result(c.request('POST','/api/platform/services/mail.detail/invoke',{'payload':{'mail':id}}))['mail']
def check(s,v):
 assert v,s;checks.append(s);print('PASS '+s,flush=True)
try:
 c.login(f['user'],f['password']);file=action('files.upload',{'file_name':f['prefix']+'.xlsx','content_base64':base64.b64encode(seed._workbook_bytes(seed.DEFAULT_ROWS)).decode(),'attribution':{'level':'personal','owner_user':f['user']}})['file'];v=result(api.service(c,'files.sheet_read',{'table':file}));draft=action('mail.save_draft',{'subject':'原主题','body':'原正文','to':[],'cc':[]});mails.append(draft['name'])
 p={'table':file,'cells':[{'row_id':v['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':'表先完成'}}],'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
 proposals=console("from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(%r)\nRESULT['sheet']=propose_registered_action('files.sheet_cells_write',%r,idempotency_key=%r,source='ai')['id']\nRESULT['mail']=propose_registered_action('mail.save_draft',%r,idempotency_key=%r,source='ai')['id']\nfrappe.db.commit()"%(f['user'],p,uuid.uuid4().hex,{'mail':draft['name'],'expected_version':draft['record_version'],'subject':'不可误采用候选','body':'候选正文','to':[],'cc':[]},uuid.uuid4().hex))
 sheet,mail=proposals['sheet'],proposals['mail'];result(c.request('POST','/api/platform/action-proposals/'+sheet+'/resolve',{'decision':'confirmed'}));check('confirm one target leaves other domain draft untouched',detail(draft['name'])['subject']=='原主题')
 pending=result(c.request('GET','/api/platform/action-proposal-get/'+mail));check('other proposal still pending',str(pending.get('status') or pending.get('proposal',{}).get('status')).lower() in ('proposed','pending'))
 changed=action('mail.save_draft',{'mail':draft['name'],'expected_version':draft['record_version'],'subject':'人工新主题','body':'人工新正文','to':[],'cc':[]})
 st,b=c.request('POST','/api/platform/action-proposals/'+mail+'/resolve',{'decision':'confirmed'});check('stale mail confirmation rejects version conflict',st in (400,409,417,422) and ('版本' in str(b) or '变化' in str(b) or '原始记录已更新' in str(b)))
 check('failed mail does not roll back confirmed Excel',result(api.service(c,'files.sheet_read',{'table':file}))['rows'][0]['values']['备注']['value']=='表先完成');check('failed candidate does not overwrite manual mail',detail(draft['name'])['subject']=='人工新主题')
 now=detail(draft['name']);action('mail.save_draft',{'mail':draft['name'],'expected_version':now['record_version'],'subject':'人工可继续','body':now['body'],'to':[],'cc':[]});check('human can continue after cross-domain partial failure',detail(draft['name'])['subject']=='人工可继续')
 result(c.request('POST','/api/platform/action-proposals/'+mail+'/resolve',{'decision':'rejected'}));check('reject stale remaining candidate preserves confirmed table',result(api.service(c,'files.sheet_read',{'table':file}))['rows'][0]['values']['备注']['value']=='表先完成')
 print('RESULT',len(checks),'/',len(checks),'proposals',sheet,mail,flush=True)
finally:
 if file:action('files.recycle',{'file':file})
 fx({'mode':'cleanup','fixture':f,'mails':mails});print('CLEANUP exact fixtures recycled/disabled')
