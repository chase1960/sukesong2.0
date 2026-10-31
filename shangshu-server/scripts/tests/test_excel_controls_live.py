"""Production mount input queue → real HTTP. Exclusive QA window; no restart/send."""
import json,os,sys,subprocess,io
from pathlib import Path
from test_e01_role_matrix import Fixture,result,successful
import _ss_seed

def main():
 if '--execute-live' not in sys.argv:sys.exit('Requires --execute-live and exclusive QA window')
 f=Fixture('controls',('owner',));root=Path(__file__).resolve().parents[3]
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
  proc=subprocess.run(['node','--import','tsx','scripts/tests/excel-controls-http-bridge.ts'],cwd=root/'shangshu-server',env=env,timeout=150)
  f.check('production mount controls actual HTTP bridge',proc.returncode==0)
  read=f.service(owner,'files.row_read',{'table':table,'row_id':rid});cells=result(read).get('cells',{})
  f.check('same promoted resource retains formal amount and updated ordinary header/value',successful(read) and cells.get('金额',{}).get('value')==10.5 and cells.get('跟进意见',{}).get('value')=='00123')
  snapshot=f.console_module.run("import json,io,openpyxl\nfrom shangshu_files.sheet import _content\nd=frappe.get_doc('Shangshu File Center File',%r)\nw=openpyxl.load_workbook(io.BytesIO(_content(d)),data_only=False)\nRESULT['xlsx']=list(w.active.values)\nRESULT['bold']=w.active['C2'].font.bold\nRESULT['height']=w.active.row_dimensions[2].height\nRESULT['width']=w.active.column_dimensions['C'].width\nRESULT['formal']=json.loads(d.formal_values_json or '{}')\nRESULT['ops']=frappe.get_all('Shangshu File Center Sheet Op',filters={'file':d.name},fields=['name','op_id'])"%table)
  print('INDEPENDENT_DB_XLSX',json.dumps(snapshot,ensure_ascii=False))
  rows=snapshot.get('xlsx',[]);f.check('independent XLSX header and values persist',len(rows)>1 and rows[0][2]=='跟进意见' and rows[1][1]==10.5 and rows[1][2]=='00123')
  f.check('font/row-height/column-width independently persisted',snapshot.get('bold') is True and snapshot.get('height')==29.25 and snapshot.get('width',0)>20)
  f.check('formal amount remains independent of ordinary copy/paste',snapshot.get('formal',{}).get(rid,{}).get('amount')==10.5)
 finally:f.cleanup()
 print('RESULT',sum(f.checks),'/',len(f.checks));return 0 if all(f.checks) else 1
if __name__=='__main__':sys.exit(main())
