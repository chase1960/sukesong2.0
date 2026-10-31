"""UI041/095 actual Assistant proposals, partial review, actor trace and inverse interleaving."""
import argparse,json,os,subprocess,uuid,urllib.parse
from pathlib import Path
from test_e01_role_matrix import Fixture,result
ROOT=Path(__file__).resolve().parents[3]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled exclusive window required')
 f=Fixture('reviewundo',('owner','head','peer'));ps=[];traces=[]
 def check(name,v):f.check(name,v);assert v,name
 def good(r):
  st,b=r;assert st==200 and b.get('ok') is not False,(st,b);return b['result'] if isinstance(b.get('result'),dict) and 'id' not in b else b
 def act(name,p):return good(f.action(a,name,p))
 def read():return good(f.view(a,table))
 def latch():
  v=read();return {'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
 def model(prompt,steps):
  cfg={'user':f.users['owner'],'password':f.password,'conversation':f.prefix,'prompt':prompt,'steps':steps}
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/assistant-range-structure-worker.ts'],input=json.dumps(cfg),capture_output=True,text=True,timeout=120)
  assert p.returncode==0,p.stderr[-2400:];out=json.loads(p.stdout.strip().splitlines()[-1]);traces.append(out);proposals=[x['data']['id'] for x in out['events'] if x['event']=='confirm'];ps.extend(proposals);return proposals
 def propose(cells):return model('请将选定范围生成审核建议，保留本人输入和独立撤销。',[{'action_id':'files.sheet_cells_write','payload':{**latch(),'cells':cells}}])[0]
 def review(p):return good(a.request('GET','/api/platform/action-proposals/'+p+'/review'))
 def accept(p,units):
  v=review(p);return good(a.request('POST','/api/platform/action-proposals/'+p+'/accept',{'op_id':uuid.uuid4().hex,'expected_review_revision':v['review_revision'],'units':units}))
 try:
  f.setup();a=f.clients['owner'];table=f.upload('owner','interleave',{'level':'personal','owner_user':f.users['owner']});initial=read();rid=initial['rows'][0]['row_id']
  manual=f.prefix+'-manual-name';act('files.sheet_input_write',{**latch(),'start_row':0,'start_col':0,'value':{'type':'text','value':'本人名称'},'op_id':manual})
  model('先读取这张表，稍后只审核金额与备注。',[{'action_id':'files.sheet_range_read','payload':{'table':table}}])
  p=propose([{'row_id':rid,'header':'金额','value':{'type':'number','value':22}},{'row_id':rid,'header':'备注','value':{'type':'text','value':'不应写入的剩余建议'}}]);v=review(p)
  unit=next(x['unit_id'] for x in v['units'] if x['target']['header']=='金额');accepted=accept(p,[unit]);check('one unit accepted while one remains',accepted['accepted_count']==1 and accepted['remaining']==1 and accepted['status']=='proposed')
  good(a.request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'rejected'}));v=review(p)
  check('reject remainder retains accepted unit status',v['status']=='rejected' and v['accepted_count']==1 and sum(x['status']=='accepted' for x in v['units'])==1 and sum(x['status']=='rejected' for x in v['units'])==1)
  current=read();check('partial accept and remaining reject preserve formal distinction',current['rows'][0]['values']['金额']['value']==22 and current['rows'][0]['values']['备注']==initial['rows'][0]['values']['备注'])
  path='/api/platform/audit-chat?actor_user='+urllib.parse.quote(f.users['owner'])+'&proposal_id='+p
  head=good(f.clients['head'].request('GET',path));check('department head can trace actual subordinate proposal',head['status']=='linked')
  check('trace preserves prior user request and trigger',head['context']['before']==['先读取这张表，稍后只审核金额与备注。'] and head['context']['trigger']=='请将选定范围生成审核建议，保留本人输入和独立撤销。')
  st,denied=f.clients['peer'].request('GET',path);check('cross department employee denied conversation evidence',st==403 and '稍后只审核' not in json.dumps(denied,ensure_ascii=False))
  traces.append({'audit':head})
  act('files.sheet_cells_undo',{'table':table,'op_id':manual});current=read()
  check('manual inverse on another cell preserves accepted Assistant value',current['rows'][0]['values']['名称']==initial['rows'][0]['values']['名称'] and current['rows'][0]['values']['金额']['value']==22)
  conflicting=f.prefix+'-manual-amount';act('files.sheet_input_write',{**latch(),'start_row':0,'start_col':1,'value':{'type':'number','value':55},'op_id':conflicting})
  p2=propose([{'row_id':rid,'header':'金额','value':{'type':'number','value':66}}]);accept(p2,None);before=read()
  st,b=f.action(a,'files.sheet_cells_undo',{'table':table,'op_id':conflicting});after=read()
  print('CONFLICT RECEIPT',st,json.dumps(b,ensure_ascii=False),flush=True)
  refused=st in (400,409,417) or (st==200 and result((st,b)).get('applied')==0 and any(x.get('reason')=='changed' for x in result((st,b)).get('skipped',[])))
  check('same-cell Assistant acceptance blocks conflicting manual inverse',refused and after['rows']==before['rows'] and after['content_version']==before['content_version'] and after['rows'][0]['values']['金额']['value']==66)
  print('RESULT %d/%d'%(sum(f.checks),len(f.checks)),flush=True)
 finally:
  (ROOT/'docs/reports/r967-20261019/review-undo-audit-traces.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2))
  if 'owner' in f.clients:
   for p in ps:f.clients['owner'].request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'rejected'})
  f.cleanup()
 return f.finish()
if __name__=='__main__':raise SystemExit(main())
