"""UI034/083 production dispatcher + controlled model, UI041/068 same proposal chain."""
import argparse,io,copy,importlib.util,json,os,subprocess,uuid,urllib.parse
from pathlib import Path
from test_process_provenance_live import fixture,console
ROOT=Path(__file__).resolve().parents[3];os.environ.setdefault('SS_ROOT',str(ROOT))
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('structure','shangshu-server/scripts/test-n2-structure.py');seed=load('seed','shangshu-server/scripts/tests/_ss_seed.py');cred=load('cred','shangshu-server/scripts/tests/_ss_cred.py')
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');a=ap.parse_args()
 if not a.execute_window:ap.error('scheduled QA window required')
 base=os.environ['SS_BASE'];f=fixture({'mode':'seed'});client=t.Client(base);admin=t.Client(base);client.login(f['user'],f['password']);admin.login('Administrator',cred.admin_pw_for(base));files=[];checks=[];proposals=[];traces=[];conversation=f['prefix']+'-range-tools'
 def good(r):
  st,b=r;assert st==200 and b.get('ok') is not False,(st,b);return b.get('result',b)
 def action(c,n,p):return good(t.action(c,n,p,uuid.uuid4().hex))
 def read(table):return good(t.service(client,'files.sheet_read',{'table':table}))
 def check(name,v):assert v,name;checks.append(name);print('PASS '+name,flush=True)
 def worker(name,cfg):
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/'+name],input=json.dumps({**f,**cfg}),capture_output=True,text=True,timeout=120)
  assert p.returncode==0,p.stderr[-2400:];result=json.loads(p.stdout.strip().splitlines()[-1]);traces.append(result);return result
 def tool(action_id,payload):
  out=worker('assistant-range-structure-worker.ts',{'conversation':conversation,'prompt':'合成验收：按当前范围处理并保留人工审核，员工无需判断文件或正式字段存储。','steps':[{'action_id':action_id,'payload':payload}]})
  dispatch=[e for e in out['events'] if e['event']=='actual-dispatch'];assert [e['name'] for e in dispatch]==['platform_action_schema','platform_action_call']
  check(action_id+' production schema and actual dispatcher invoked',dispatch[0]['receipt'].get('action_id')==action_id and 'input_schema' in dispatch[0]['receipt'])
  ps=[e['data'] for e in out['events'] if e['event']=='confirm'];proposals.extend(p['id'] for p in ps);return out,ps
 def resolve(p):return good(client.request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'confirmed'}))
 def exported(table):
  import openpyxl
  versions=good(t.service(client,'files.versions',{'file':table}));current=versions.get('current',{})
  ref=current.get('frappe_file') or (current.get('source') or {}).get('ref')
  if not ref:
   for v in versions.get('versions',[]):
    ref=v.get('frappe_file') or (v.get('source') or {}).get('ref') or (v.get('source') or {}).get('file')
    if ref:break
  assert ref,versions
  blob=good(t.download(client,table,ref))['_bytes'];ws=openpyxl.load_workbook(io.BytesIO(blob),data_only=True).active
  return ws['B2'].value,ws['C2'].value
 def version(table):
  r=read(table);return {'table':table,'expected_content_version':int(r['content_version']),'expected_structure_version':int(r['structure_version'])}
 try:
  h=seed.seed_mixed_table(client,run=f['prefix'],rows=[{'项目名称':'甲','金额':10.5,'备注':'原备注'},{'项目名称':'乙','金额':20,'备注':'初始化公式前'}],promote_with=admin,attribution={'level':'personal','owner_user':f['user']});table=h['table'];files.append(table)
  columns=copy.deepcopy(seed.MIXED_COLUMNS)
  for col in columns:
   if col.get('promoted'):col.update(read_roles=['Desk User'],write_roles=['Desk User'],download_roles=['Desk User'])
  action(admin,'files.promotion_define',{'table':table,'expected_structure_version':version(table)['expected_structure_version'],'definition':{'definition_version':1,'columns':columns}})
  initial=read(table)
  action(client,'files.sheet_cells_write',{**version(table),'cells':[{'row_id':initial['rows'][1]['row_id'],'header':'备注','value':{'type':'formula','formula':'=B2*2'}}]})
  before=read(table);print('FORMULA BASELINE',json.dumps(before['rows'][1]['values']['备注'],ensure_ascii=False),flush=True);rid=before['rows'][0]['row_id'];p={**version(table),'cells':[{'row_id':rid,'header':'金额','value':{'type':'number','value':88.25}},{'row_id':rid,'header':'备注','value':{'type':'text','value':'ordinary unified'}}]}
  _,ps=tool('files.sheet_cells_write',p);check('one mixed range proposal',len(ps)==1);pid=ps[0]['id']
  check('proposal creation does not write cells',read(table)['rows']==before['rows'])
  check('pending candidate absent from authoritative search',not good(t.service(client,'files.sheet_read',{'table':table,'search':'ordinary unified'}))['rows'])
  check('pending candidate absent from downloaded workbook',exported(table)==(10.5,'原备注'))
  check('pending candidate does not enter formula result',read(table)['rows'][1]['values']['备注']['value']==21)
  recovery=worker('assistant-review-recovery-worker.ts',{'proposal':pid,'table':table});check('unknown success recovered by original op and independent readback',len(recovery['checks'])==4)
  after=read(table);check('formal and ordinary cells both saved',after['rows'][0]['values']['金额']['value']==88.25 and after['rows'][0]['values']['备注']['value']=='ordinary unified')
  check('confirmed values enter search',bool(good(t.service(client,'files.sheet_read',{'table':table,'search':'ordinary unified'}))['rows']))
  check('confirmed values enter downloaded workbook',exported(table)==(88.25,'ordinary unified'))
  check('confirmed value recalculates dependent formula',after['rows'][1]['values']['备注']['value']==176.5)
  tracepath='/api/platform/audit-chat?actor_user='+urllib.parse.quote(f['user'])+'&proposal_id='+pid
  trace=good(client.request('GET',tracepath));check('actual tool request linked to conversation',trace['status']=='linked')
  check('retry produced exactly one successful receipt',len([r for r in trace['decision']['receipts'] if r['status']=='Succeeded'])==1)
  invalid={**version(table),'cells':[{'row_id':rid,'header':'金额','value':{'type':'number','value':-1}},{'row_id':rid,'header':'备注','value':{'type':'text','value':'MUST-NOT-SAVE'}}]}
  out,bad=tool('files.sheet_cells_write',invalid)
  if bad:
   st,body=client.request('POST','/api/platform/action-proposals/'+bad[0]['id']+'/resolve',{'decision':'confirmed'});check('invalid mixed proposal rejected on confirmation',st>=400 or body.get('ok') is False)
  else:check('invalid mixed package rejected by tool',any(e.get('receipt',{}).get('error') for e in out['events']))
  check('invalid mixed package causes zero partial formal or ordinary changes',read(table)['rows']==after['rows'] and read(table)['content_version']==after['content_version'])
  _,created=tool('files.create',{'file_name':f['prefix']+'-tool-created.xlsx','attribution':{'level':'personal','owner_user':f['user']}})
  result=resolve(created[0]['id']);newtable=result['file'];files.append(newtable);check('tool-created table independently readable',read(newtable)['table']==newtable)
  _,cols=tool('files.sheet_column_append',{**version(table),'header':'工具普通列'});resolve(cols[0]['id']);snapshot=read(table)
  check('tool appended ordinary column','工具普通列' in snapshot['headers'])
  _,rows=tool('files.sheet_row_append',{**version(table),'count':1});resolve(rows[0]['id']);check('tool appended one row',len(read(table)['rows'])==len(snapshot['rows'])+1)
  out,_=tool('files.sheet_range_read',{'table':table});check('range read uses same actual tool protocol',any(e.get('receipt',{}).get('result',{}).get('rows') for e in out['events']))
  deleted=good(client.request('DELETE','/api/chat/conversation/'+urllib.parse.quote(traces[0]['conversation'],safe='')));check('actual conversation messages deleted',deleted['deleted']>0)
  post=good(client.request('GET',tracepath));check('deleted conversation retains auditable original tool trigger',post['status']=='linked' and post['context']['trigger']==trace['context']['trigger'])
  print('RESULT %d/%d'%(len(checks),len(checks)),flush=True)
 finally:
  (ROOT/'docs/reports/r967-20261019/assistant-range-structure-traces.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2))
  for p in proposals:client.request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'rejected'})
  for file in files:action(client,'files.recycle',{'file':file})
  fixture({'mode':'cleanup','fixture':f,'mails':[]});print('CLEANUP exact tables recycled; synthetic identity disabled',flush=True)
if __name__=='__main__':main()
