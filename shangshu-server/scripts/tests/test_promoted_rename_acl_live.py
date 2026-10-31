"""UI101 real role: promoted rename inverse and historical log revocation."""
import copy,json,os,sys
if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: require --execute-live and exclusive QA window')
if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 environment required')
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('renameacl',('owner',))
def check(label,ok):
 f.check(label,ok)
 assert ok,label
def service(client,name,payload):
 response=f.service(client,name,payload);assert response[0]==200,response
 return result(response)
def action(client,name,payload):
 response=f.action(client,name,payload);assert successful(response),(name,response)
 return result(response)
try:
 f.setup();owner=f.clients['owner'];table=f.upload('owner','rename',{'level':'personal','owner_user':f.users['owner']})
 def view():return service(f.admin,'files.sheet_read',{'table':table})
 def definition():return service(f.admin,'files.promotion_definition',{'table':table})
 def history(client):return service(client,'files.op_history',{'file':table,'limit':100})['ops']
 def rename(old,new,key):
  before=view();return action(owner,'files.sheet_header_rename',{'table':table,'from_header':old,'to_header':new,'op_id':key,'expected_content_version':before['content_version'],'expected_structure_version':before['structure_version']})
 def define(columns,sha=None):
  current=definition();return f.action(f.admin,'files.promotion_define',{'table':table,'expected_structure_version':current['structure_version'],'expected_definition_sha':sha if sha is not None else current['definition_sha'],'definition':{'definition_version':1,'columns':columns}})
 cols=[{'header':'金额','field':'amount','promoted':True,'type':'number','rules':{},'read_roles':['Desk User'],'write_roles':['Desk User'],'download_roles':['Desk User']}]
 check('define existing amount as one formal field',successful(define(cols)))
 before=view();rid=before['rows'][0]['row_id'];key=f.prefix+'-value'
 action(owner,'files.sheet_input_write',{'table':table,'start_row':0,'start_col':1,'value':{'type':'number','value':31},'op_id':key,'expected_content_version':before['content_version'],'expected_structure_version':before['structure_version']})
 packet=next(p for p in history(owner) if p['op_id']==key)
 check('ordinary owner can read pre-rename value history positive control',packet['cells'][0]['after']['value']==31)
 old_definition=definition();rename('金额','应缴金额',f.prefix+'-rename');renamed=definition();after=view()
 check('rename retains formal identity and fixed row id',renamed['columns'][0]['field']=='amount' and after['rows'][0]['row_id']==rid and after['rows'][0]['values']['应缴金额']['value']==31)
 action(owner,'files.sheet_structure_undo',{'table':table,'undo_of':f.prefix+'-rename','op_id':f.prefix+'-undo','expected_content_version':after['content_version'],'expected_structure_version':after['structure_version']})
 restored=view();restored_def=definition()
 check('real structure inverse restores header, formal value and current binding',restored['rows'][0]['values']['金额']['value']==31 and restored['rows'][0]['row_id']==rid and restored_def['columns'][0]['field']=='amount' and restored_def['binding_current'])
 rename('金额','应缴金额',f.prefix+'-rename2')
 stale=define(cols,old_definition['definition_sha'])
 check('old definition fingerprint rejected against fresh structure version',stale[0] in (400,409,417) and '定义' in json.dumps(stale[1],ensure_ascii=False))
 renamed=definition();restricted=copy.deepcopy(renamed['columns']);restricted[0]['read_roles']=['System Manager']
 check('revoke read on renamed formal field',successful(define(restricted)))
 owner_ops=history(owner);old=next(p for p in owner_ops if p['op_id']==key)
 check('real ordinary role cannot read old-header history after rename and revocation',old['cells']==[] and old.get('cells_redacted',0)>0)
 admin_old=next(p for p in history(f.admin) if p['op_id']==key)
 check('admin history retains unchanged original immutable snapshot',admin_old['cells']==packet['cells'])
 owner_view=service(owner,'files.sheet_read',{'table':table})
 check('current body also hides the renamed field',all(r.get('values',{}).get('应缴金额')=={'type':'hidden','hidden':True,'value':None} for r in owner_view['rows']))
finally:
 f.cleanup()
raise SystemExit(f.finish())
