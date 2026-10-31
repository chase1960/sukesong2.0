"""Real QA-model ambiguity diagnostic with raw streamed text retained."""
import argparse,json,os,subprocess,urllib.request,uuid
from pathlib import Path
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture,console
ROOT=Path(__file__).resolve().parents[3]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');ap.add_argument('--label',default='raw');ap.add_argument('--choose',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled window required')
 f=fixture({'mode':'seed'});mails=[];op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));base=os.environ['SS_BASE']
 def http(path,data):
  with op.open(urllib.request.Request(base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})) as r:return json.load(r)
 try:
  http('/api/platform/login',{'username':f['user'],'password':f['password']})
  title=f['prefix']+' 同名待核对'
  for body in ['甲稿原文','乙稿原文']:
   value=http('/api/platform/actions/mail.save_draft/execute',{'payload':{'subject':title,'body':body,'to':[],'cc':[]},'confirmed':True,'idempotency_key':uuid.uuid4().hex});mails.append(value['result']['name'])
  cfg={**f,'conversation':f['prefix']+'-ambiguity','prompt':f'请把主题为“{title}”的草稿正文改成“同名已核对”。只提案，不发送。'}
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/mail-assistant-continuity-worker.ts'],input=json.dumps(cfg),capture_output=True,text=True,timeout=210)
  if p.returncode:raise RuntimeError(p.stderr[-1600:])
  out=json.loads(p.stdout.strip().splitlines()[-1]);path=ROOT/('docs/reports/r967-20261019/mail-disambiguation-'+args.label+'.json');path.write_text(json.dumps(out,ensure_ascii=False,indent=2))
  print('REPLY',out['reply']);print('CONFIRMATIONS',sum(e['event']=='confirm' for e in out['events']));print('RAW', ''.join(e['data']['delta'] for e in out['events'] if e['event']=='text'))
  if args.choose:
   assert not any(e['event']=='confirm' for e in out['events'])
   assert any(word in out['reply'] for word in ['哪一','哪封','指定','选择']) and '甲稿原文' in out['reply'] and '乙稿原文' in out['reply']
   assert not any(e['data'].get('no_receipt_claims') for e in out['events'] if e['event']=='status')
   cfg['prompt']='选择正文为乙稿原文的那封，请按刚才要求仅为这封生成待审核提案。'
   p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/mail-assistant-continuity-worker.ts'],input=json.dumps(cfg),capture_output=True,text=True,timeout=210)
   if p.returncode:raise RuntimeError(p.stderr[-1600:])
   chosen=json.loads(p.stdout.strip().splitlines()[-1]);(ROOT/('docs/reports/r967-20261019/mail-disambiguation-'+args.label+'-chosen.json')).write_text(json.dumps(chosen,ensure_ascii=False,indent=2))
   proposals=[e['data'] for e in chosen['events'] if e['event']=='confirm'];assert len(proposals)==1 and proposals[0]['capability']=='mail.save_draft'
   assert proposals[0]['payload']['mail']==mails[1],proposals[0]
   http('/api/platform/action-proposals/'+proposals[0]['id']+'/resolve',{'decision':'confirmed'})
   one=http('/api/platform/services/mail.detail/invoke',{'payload':{'mail':mails[0]}});one=one.get('result',one)['mail']
   two=http('/api/platform/services/mail.detail/invoke',{'payload':{'mail':mails[1]}});two=two.get('result',two)['mail']
   assert one['body']=='甲稿原文' and '同名已核对' in two['body'] and two['status']=='Draft'
   print('PASS real model clarification survives guard; chosen stable-ID proposal only; independent readback not sent')

 finally:
  console('USER='+repr(f['user'])+'\n'+'''from shangshu_core.public_api import resolve_action_proposal
frappe.set_user(USER)
for p in frappe.get_all('Shangshu Action Proposal',filters={'actor_user':USER,'status':'Proposed'},pluck='name'):resolve_action_proposal(p,'rejected')
frappe.db.commit()
''')
  fixture({'mode':'cleanup','fixture':f,'mails':mails});print('CLEANUP',f['prefix'])
if __name__=='__main__':main()
