"""UI090: same named tables/headers; production model and hard tool whitelist.
Run only in the scheduled window after unified Node deployment. No SMTP capability.
"""
import argparse,base64,io,json,os,subprocess,urllib.request,uuid
from pathlib import Path
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture,console
ROOT=Path(__file__).resolve().parents[3]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled window required')
 import openpyxl
 f=fixture({'mode':'seed'});files=[];op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));base=os.environ['SS_BASE']
 def http(path,data=None):
  with op.open(urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'}),timeout=120) as r:return json.load(r)
 def svc(name,payload):
  v=http('/api/platform/services/'+name+'/invoke',{'payload':payload});return v.get('result',v)
 def act(name,payload):
  v=http('/api/platform/actions/'+name+'/execute',{'payload':payload,'confirmed':True,'idempotency_key':uuid.uuid4().hex});return v.get('result',v)
 def model(prompt,label):
  cfg={**f,'conversation':f['prefix']+'-table-target','prompt':prompt}
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/mail-assistant-continuity-worker.ts'],input=json.dumps(cfg),capture_output=True,text=True,timeout=210)
  if p.returncode:raise RuntimeError(p.stderr[-1600:])
  out=json.loads(p.stdout.strip().splitlines()[-1]);(ROOT/('docs/reports/r967-20261019/table-disambiguation-'+f['prefix']+'-'+label+'.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2));return out
 try:
  http('/api/platform/login',{'username':f['user'],'password':f['password']})
  title=f['prefix']+'同名案件表.xlsx'
  for marker,amount in [('甲案件',800),('乙案件',1600)]:
   wb=openpyxl.Workbook();ws=wb.active;ws.append(['案件','金额']);ws.append([marker,amount]);buf=io.BytesIO();wb.save(buf)
   files.append(act('files.upload',{'file_name':title,'directory':'/'+f['prefix']+'-'+marker,'content_base64':base64.b64encode(buf.getvalue()).decode(),'attribution':{'level':'personal','owner_user':f['user']}})['file'])
  assert len(set(files))==2
  before=[svc('files.sheet_read',{'table':v}) for v in files]
  assert all(v['table_title']==title for v in before),before
  print('FIXTURE distinct directories, exact same title',files,flush=True)
  out=model('请把名为“'+title+'”的表第一行“金额”改为 810。只生成待审核提案。','ambiguous')
  assert not any(e['event']=='confirm' for e in out['events']),out
  assert any(word in out['reply'] for word in ['哪一','指定','选择','确认']),out['reply']
  assert all(v in out['reply'] for v in files),out['reply']
  for i,v in enumerate(files):
   now=svc('files.sheet_read',{'table':v});assert now['rows']==before[i]['rows'] and now['content_version']==before[i]['content_version']
  print('PASS ambiguous same-name tables zero proposals/writes; distinguishable stable IDs',flush=True)
  chosen=model('选择第一行案件为甲案件的表，按刚才要求生成提案；另一张表不要改。','chosen')
  proposals=[e['data'] for e in chosen['events'] if e['event']=='confirm'];assert len(proposals)==1,proposals
  p=proposals[0];assert p['capability']=='files.sheet_cells_write' and p['payload']['table']==files[0],p
  cells=p['payload']['cells'];assert len(cells)==1 and cells[0]['row_id']==before[0]['rows'][0]['row_id'] and cells[0]['header']=='金额',p
  assert p['payload']['expected_structure_version']==before[0]['structure_version'] and p['payload']['expected_content_version']==before[0]['content_version']
  http('/api/platform/action-proposals/'+p['id']+'/resolve',{'decision':'confirmed'})
  a,b=[svc('files.sheet_read',{'table':v}) for v in files]
  assert a['rows'][0]['values']['金额']['value']==810
  assert b['rows']==before[1]['rows'] and b['content_version']==before[1]['content_version']
  print('PASS chosen table stable ID/row/header/version; HTTP confirmed; target 810 and other 1600 unchanged',flush=True)
 finally:
  console('USER='+repr(f['user'])+'\n'+'''from shangshu_core.public_api import resolve_action_proposal
frappe.set_user(USER)
for p in frappe.get_all('Shangshu Action Proposal',filters={'actor_user':USER,'status':'Proposed'},pluck='name'):resolve_action_proposal(p,'rejected')
frappe.db.commit()
''')
  for v in files:act('files.recycle',{'file':v})
  fixture({'mode':'cleanup','fixture':f,'mails':[]});print('CLEANUP exact tables recycled and identity disabled; two synthetic directory references retained with recycled files',f['prefix'],flush=True)
if __name__=='__main__':main()
