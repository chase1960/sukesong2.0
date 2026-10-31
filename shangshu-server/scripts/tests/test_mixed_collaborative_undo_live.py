"""Two real actors: mixed sheet/formal inverse atomicity and actor ownership."""
import hashlib,json,os,sys
if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: require --execute-live')
if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 required')
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('mixedundo',('owner','member'))
def check(label,ok):f.check(label,ok);assert ok,label
def service(client,name,payload):
 r=f.service(client,name,payload);assert r[0]==200,r;return result(r)
def act(client,name,payload):
 r=f.action(client,name,payload);assert successful(r),(name,r);return result(r)
try:
 f.setup();a=f.clients['owner'];b=f.clients['member'];table=f.upload('owner','mixed',{'level':'personal','owner_user':f.users['owner']})
 act(a,'platform.org.share_grant',{'resource':table,'user':f.users['member'],'access':'edit'})
 definition=service(f.admin,'files.promotion_definition',{'table':table})
 act(f.admin,'files.promotion_define',{'table':table,'expected_structure_version':definition['structure_version'],'expected_definition_sha':definition['definition_sha'],'definition':{'definition_version':1,'columns':[{'header':'金额','field':'amount','promoted':True,'type':'number','rules':{},'read_roles':['Desk User'],'write_roles':['Desk User'],'download_roles':['Desk User']}]}})
 def view():return service(a,'files.sheet_read',{'table':table})
 def latch():
  v=view();return {'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
 def paste(key,amount,note):return act(a,'files.sheet_paste_apply',{**latch(),'start_row':0,'start_col':1,'matrix':[[amount,note]],'matrix_types':[['number','text']],'extend':False,'op_id':key})
 def input_b(col,value,kind='text'):return act(b,'files.sheet_input_write',{**latch(),'start_row':0,'start_col':col,'value':{'type':kind,'value':value},'op_id':f.prefix+'-b-'+str(col)+'-'+str(value)})
 def snapshot():
  v=view();v.pop('diagnostics',None);versions=service(a,'files.versions',{'file':table});status,data=f.t.download(a,table,versions['current']['frappe_file']);assert status==200
  db=f.console_module.run("d=frappe.get_doc('Shangshu File Center File',%r)\nRESULT['state']={k:d.get(k) for k in ['formal_values_json','sheet_meta_json','version_count','current_file','current_sha256','modified']}"%table)
  assert '__error__' not in db,db
  return {'view':v,'xlsx_sha':hashlib.sha256(data['_bytes']).hexdigest(),'db':db['state']}
 original=view()['rows'][0]['values'];key=f.prefix+'-mixed1';p=paste(key,31,'A-mixed1')
 check('one package writes both ordinary and formal cells',bool(p['formal_written']) and bool(p['sheet_written']) and p['action_count']==1)
 input_b(0,'B-unrelated');act(a,'files.sheet_cells_undo',{'table':table,'op_id':key});v=view()['rows'][0]['values']
 check('A inverse restores both mixed cells while preserving B unrelated edit',v['金额']['value']==original['金额']['value'] and v['备注']['value']==original['备注']['value'] and v['名称']['value']=='B-unrelated')
 key=f.prefix+'-mixed2';paste(key,42,'A-mixed2');before=snapshot();denied=f.action(b,'files.sheet_cells_undo',{'table':table,'op_id':key});after=snapshot()
 print('CROSS_ACTOR',json.dumps({'status':denied[0],'body':denied[1],'diff':{k:[before[k],after[k]] for k in before if before[k]!=after[k]}},ensure_ascii=False),flush=True)
 check('B cannot undo A package; DB XLSX and versions unchanged',denied[0] in (400,403,409,417) and before==after)
 input_b(1,99,'number');before=snapshot();denied=f.action(a,'files.sheet_cells_undo',{'table':table,'op_id':key});after=snapshot()
 check('same formal cell conflict rejects whole mixed inverse with DB XLSX versions unchanged',denied[0] in (400,409,417) and before==after)
 v=after['view']['rows'][0]['values'];check('conflict leaves B formal 99 and A ordinary value intact',v['金额']['value']==99 and v['备注']['value']=='A-mixed2')
 history=service(a,'files.op_history',{'file':table,'limit':100})['ops'];packet=next(x for x in history if x['op_id']==key)
 check('rejected inverse leaves original operation packet available and immutable',not packet['undone'] and len(packet['cells'])==2 and {c['after']['value'] for c in packet['cells']}=={42,'A-mixed2'})
 print('STATE',json.dumps({'table':table,'stable_row_id':after['view']['rows'][0]['row_id'],'unchanged_after_conflict':after['xlsx_sha'],'content_version':after['view']['content_version']},ensure_ascii=False),flush=True)
finally:f.cleanup()
raise SystemExit(f.finish())
