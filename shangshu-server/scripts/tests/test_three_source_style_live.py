"""UI025 one styled promoted cell: manual, actual Assistant dispatcher, trusted code node."""
import argparse,base64,io,json,os,subprocess,uuid
from pathlib import Path
from test_e01_role_matrix import Fixture
from test_process_provenance_live import console
ROOT=Path(__file__).resolve().parents[3]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled exclusive window required')
 from openpyxl import Workbook,load_workbook
 from openpyxl.styles import Font,Border,Side,PatternFill
 f=Fixture('threesource',('owner',));proposals=[]
 def good(r):
  st,b=r;assert st==200 and b.get('ok') is not False,(st,b);return b['result'] if isinstance(b.get('result'),dict) and 'id' not in b else b
 def act(c,n,p):return good(f.action(c,n,p))
 def check(label,v):f.check(label,v);assert v,label
 def read():return good(f.view(a,table))
 def payload(value):
  v=read();return {'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version'],'cells':[{'row_id':v['rows'][0]['row_id'],'header':'金额','value':{'type':'number','value':value}}]}
 def exported():
  versions=good(f.service(a,'files.versions',{'file':table}));r=f.t.download(a,table,versions['current']['frappe_file']);assert r[0]==200
  ws=load_workbook(io.BytesIO(r[1]['_bytes'])).active;c=ws['B2']
  return {'value':c.value,'format':c.number_format,'font':str(c.font),'border':str(c.border),'fill':str(c.fill),'ordinary':ws['C2'].value,'row':read()['rows'][0]['row_id']}
 def confirmed(p):proposals.append(p);good(a.request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'confirmed'}))
 def verify(label,value):
  now=exported();check(label+' exact values-only style and ordinary-cell preservation',now['value']==value and {k:v for k,v in now.items() if k!='value'}=={k:v for k,v in baseline.items() if k!='value'})
 try:
  f.setup();a=f.clients['owner'];w=Workbook();ws=w.active;ws.append(['名称','金额','备注']);ws.append(['合成目标',10.5,'普通值保持'])
  ws['B2'].number_format='#,##0.00';ws['B2'].font=Font(name='Arial',size=13,bold=True,color='FF112233');ws['B2'].border=Border(bottom=Side(style='thin',color='FF556677'));ws['B2'].fill=PatternFill('solid',fgColor='FFFFCC88');buf=io.BytesIO();w.save(buf)
  table=act(a,'files.upload',{'file_name':f.prefix+'.xlsx','content_base64':base64.b64encode(buf.getvalue()).decode(),'attribution':{'level':'personal','owner_user':f.users['owner']}})['file']
  v=read();act(f.admin,'files.promotion_define',{'table':table,'expected_structure_version':v['structure_version'],'definition':{'definition_version':1,'columns':[{'header':'名称','promoted':False},{'header':'金额','promoted':True,'field':'amount','type':'number','read_roles':['Desk User'],'write_roles':['Desk User'],'download_roles':['Desk User']},{'header':'备注','promoted':False}]}})
  baseline=exported();act(a,'files.sheet_cells_write',payload(21.25));verify('manual HTTP',21.25)
  cfg={'user':f.users['owner'],'password':f.password,'conversation':f.prefix,'prompt':'把目标正式金额改为32.5，保留原表格式和普通列。','steps':[{'action_id':'files.sheet_cells_write','payload':payload(32.5)}]}
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/assistant-range-structure-worker.ts'],input=json.dumps(cfg),capture_output=True,text=True,timeout=120);assert p.returncode==0,p.stderr[-1200:];out=json.loads(p.stdout.strip().splitlines()[-1]);pid=next(e['data']['id'] for e in out['events'] if e['event']=='confirm');confirmed(pid);verify('Assistant actual dispatcher',32.5)
  code='USER='+repr(f.users['owner'])+'\nKEY='+repr(f.prefix)+'\nPAYLOAD='+repr(payload(43.75))+'\n'+'''
import json,hashlib
from shangshu_core.public_api import get_identity,begin_node_execution,complete_node_execution,process_node_provenance,propose_registered_action
from shangshu_core.actions import _definition
frappe.set_user(USER);identity=get_identity()
graph={'nodes':[{'id':'write','type':'action','action_id':'files.sheet_cells_write','start':True,'terminal':True}],'edges':[]};raw=json.dumps(graph,sort_keys=True);digest=hashlib.sha256(raw.encode()).hexdigest()
d=frappe.get_doc({'doctype':'Shangshu Process Definition','definition_id':KEY,'title':'UI025 controlled code runtime','namespace':'test.ui025','business_object':'Shangshu File Center File','enterprise_id':identity.enterprise_id,'graph_json':raw,'status':'Disabled'}).insert(ignore_permissions=True)
v=frappe.get_doc({'doctype':'Shangshu Process Definition Version','version_id':KEY+'@1','definition':d.name,'version_number':1,'graph_hash':digest,'graph_json':raw,'dependency_snapshot_json':json.dumps({'actions':{'files.sheet_cells_write':{'registry_key':_definition('files.sheet_cells_write').name}}}),'published_by':USER,'published_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
i=frappe.get_doc({'doctype':'Shangshu Process Instance','definition_version':v.name,'definition_id':KEY,'graph_hash':digest,'initiator_identity':identity.name,'initiator_user':USER,'enterprise_id':identity.enterprise_id,'status':'Running','current_node':'write','started_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
frappe.db.commit();opened=begin_node_execution(i.name,'write',{})
with process_node_provenance(opened['execution'],opened['token']):p=propose_registered_action('files.sheet_cells_write',PAYLOAD,idempotency_key=KEY+'-code',source='automation')
complete_node_execution(opened['execution'],opened['token'],output_data={'proposal':p['id']})
frappe.db.commit();RESULT.update({'proposal':p['id'],'instance':i.name,'execution':opened['execution']})
'''
  controlled=console(code);pid=controlled['proposal'];head=good(a.request('GET','/api/platform/action-proposal-get/'+pid));check('code proposal has trusted existing runtime node provenance',head['source_provenance']['trusted'] and head['source_provenance']['executor_kind']=='code');confirmed(pid);verify('trusted code node',43.75)
  print('RUNTIME',json.dumps(controlled),flush=True);print('RESULT',sum(f.checks),'/',len(f.checks),flush=True)
 finally:
  if 'owner' in f.clients:
   for p in proposals:f.clients['owner'].request('POST','/api/platform/action-proposals/'+p+'/resolve',{'decision':'rejected'})
  f.cleanup()
 return f.finish()
if __name__=='__main__':raise SystemExit(main())
