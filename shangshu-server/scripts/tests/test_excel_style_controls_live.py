"""Production mount input queue → real HTTP. Exclusive QA window; no restart/send."""
import json,os,sys,subprocess,io,tempfile,datetime,copy
import openpyxl
from pathlib import Path
from test_e01_role_matrix import Fixture,result,successful
import _ss_seed

def main():
 if '--execute-live' not in sys.argv:sys.exit('Requires --execute-live and exclusive QA window')
 f=Fixture('stylecontrols',('owner',));root=Path(__file__).resolve().parents[3]
 try:
  f.setup();owner=f.clients['owner'];old=_ss_seed.t.action
  def tracked(client,action,payload,*args,**kwargs):
   response=old(client,action,payload,*args,**kwargs)
   if action=='files.upload':
    name=result(response).get('file')
    if name:f.files.append(name);f.file_clients[name]=owner
   return response
  _ss_seed.t.action=tracked
  original_columns=_ss_seed.MIXED_COLUMNS
  _ss_seed.MIXED_COLUMNS=copy.deepcopy(original_columns)
  for column in _ss_seed.MIXED_COLUMNS:column['download_roles']=['Desk User']
  seed=_ss_seed.seed_mixed_table(owner,run=f.prefix,rows=[{'项目名称':'队列合成','金额':10.5,'备注':datetime.datetime(2026,10,19)}],promote_with=f.admin,attribution={'level':'personal','owner_user':f.users['owner']})
  _ss_seed.MIXED_COLUMNS=original_columns
  table=seed['table'];rid=seed['row_ids'][0]
  output=tempfile.TemporaryDirectory(prefix='style-controls-')
  env=dict(os.environ,SS_QUEUE_TABLE=table,SS_QUEUE_COOKIE='; '.join(c.name+'='+c.value for c in owner.jar),SS_BASE=f.base,SS_STYLE_BEFORE=output.name+'/before.xlsx',SS_STYLE_AFTER=output.name+'/after.xlsx')
  proc=subprocess.run(['node','--import','tsx','scripts/tests/excel-style-controls-http-bridge.ts'],cwd=root/'shangshu-server',env=env,timeout=150)
  f.check('production style controls actual HTTP bridge',proc.returncode==0)
  before=openpyxl.load_workbook(output.name+'/before.xlsx');after=openpyxl.load_workbook(output.name+'/after.xlsx');b=before.active;a=after.active
  f.check('independent actual export retains amount value and selected number format',b['B2'].value==10.5 and b['B2'].number_format=='#,##0.00')
  f.check('independent actual export retains real calendar date and selected date format',b['C2'].value.date()==datetime.date(2026,10,19) and b['C2'].number_format=='yyyy-mm-dd')
  f.check('independent exported wrap and all four thin RGB edges',b['C2'].alignment.wrap_text is True and all(getattr(b['C2'].border,side).style=='thin' and getattr(b['C2'].border,side).color.rgb=='FFD1D5DB' for side in ['top','bottom','left','right']))
  f.check('undo only border restores original edges while number/date/wrap and values remain',all(getattr(a['C2'].border,side).style is None for side in ['top','bottom','left','right']) and a['C2'].alignment.wrap_text is True and a['C2'].number_format=='yyyy-mm-dd' and a['B2'].number_format=='#,##0.00' and a['B2'].value==10.5 and a['C2'].value==b['C2'].value)
  read=f.service(owner,'files.row_read',{'table':table,'row_id':rid});f.check('formal amount independently unchanged',successful(read) and result(read)['cells']['金额']['value']==10.5)
  output.cleanup()
 finally:f.cleanup()
 print('RESULT',sum(f.checks),'/',len(f.checks));return 0 if all(f.checks) else 1
if __name__=='__main__':sys.exit(main())
