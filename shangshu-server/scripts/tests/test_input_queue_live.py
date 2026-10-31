"""Production mount input queue → real HTTP. Exclusive QA window; no restart/send."""
import json,os,sys,subprocess,io
from pathlib import Path
from test_e01_role_matrix import Fixture,result,successful
import _ss_seed

def main():
 if '--execute-live' not in sys.argv:sys.exit('Requires --execute-live and exclusive QA window')
 f=Fixture('inputqueue',('owner',));root=Path(__file__).resolve().parents[3]
 try:
  f.setup();owner=f.clients['owner'];old=_ss_seed.t.action
  def tracked(client,action,payload,*args,**kwargs):
   response=old(client,action,payload,*args,**kwargs)
   if action=='files.upload':
    name=result(response).get('file')
    if name:f.files.append(name);f.file_clients[name]=owner
   return response
  _ss_seed.t.action=tracked
  seed=_ss_seed.seed_mixed_table(owner,run=f.prefix,rows=[{'项目名称':'队列合成','金额':10.5,'备注':'原备注'}],promote_with=f.admin,attribution={'level':'personal','owner_user':f.users['owner']})
  table=seed['table'];rid=seed['row_ids'][0]
  env=dict(os.environ,SS_QUEUE_TABLE=table,SS_QUEUE_COOKIE='; '.join(c.name+'='+c.value for c in owner.jar),SS_BASE=f.base)
  proc=subprocess.run(['node','--import','tsx','scripts/tests/input-queue-http-bridge.ts'],cwd=root/'shangshu-server',env=env,timeout=150)
  f.check('production mount queue actual HTTP bridge',proc.returncode==0)
  read=f.service(owner,'files.row_read',{'table':table,'row_id':rid});cells=result(read).get('cells',{})
  f.check('independent actual row read keeps latest formal and ordinary values',successful(read) and cells.get('金额',{}).get('value')==812.5 and cells.get('备注',{}).get('value')=='恢复后普通值')
  snapshot=f.console_module.run("import json,io,openpyxl\nfrom shangshu_files.sheet import _content\nd=frappe.get_doc('Shangshu File Center File',%r)\nw=openpyxl.load_workbook(io.BytesIO(_content(d)),data_only=False)\nRESULT['xlsx']=list(w.active.values)\nRESULT['formal']=json.loads(d.formal_values_json or '{}')\nRESULT['ops']=frappe.get_all('Shangshu File Center Sheet Op',filters={'file':d.name},fields=['name','op_id'])"%table)
  print('INDEPENDENT_DB_XLSX',json.dumps(snapshot,ensure_ascii=False))
  rows=snapshot.get('xlsx',[]);f.check('independent XLSX bytes retain formal 812.5 and latest ordinary note',len(rows)>1 and rows[1][1]==812.5 and rows[1][2]=='恢复后普通值')
  f.check('five distinct inputs create exactly five successful sheet operations despite replay',len(snapshot.get('ops',[]))==5 and len({o['op_id'] for o in snapshot.get('ops',[])})==5)
  formal=snapshot.get('formal',{});serialized=json.dumps(formal,ensure_ascii=False)
  f.check('independent formal_values contains final typed amount and no ordinary note', formal.get(rid,{}).get('amount')==812.5 and '恢复后普通值' not in serialized)
 finally:f.cleanup()
 print('RESULT',sum(f.checks),'/',len(f.checks));return 0 if all(f.checks) else 1
if __name__=='__main__':sys.exit(main())
