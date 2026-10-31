"""UI031 controlled registered consumer through real public execution; UI032 atomic ACL."""
import base64,os,sys,json
from io import BytesIO
from openpyxl import Workbook
if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: --execute-live and exclusive window required')
if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 required')
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('readyconsumer',('owner',))
try:
 f.setup();wb=Workbook();wb.active.append(['名称','金额','备注']);wb.active.append(['controlled',None,None]);raw=BytesIO();wb.save(raw)
 response=f.action(f.clients['owner'],'files.upload',{'file_name':f.prefix+'.xlsx','content_base64':base64.b64encode(raw.getvalue()).decode(),'directory':'/','attribution':{'level':'personal','owner_user':f.users['owner']}});assert successful(response),response
 table=result(response)['file']
 code=r'''
import copy,hashlib,json,sys,types
from shangshu_core.public_api import execute_registered_action,invoke_domain_service,register_action
prefix=__PREFIX__;table=__TABLE__;owner=__OWNER__
seq=0;checks=[];calls=[];todos=[]
def check(label,value):
 checks.append({'label':label,'passed':bool(value)})
 assert value,label
def act(action,payload,user='Administrator'):
 global seq
 frappe.set_user(user);seq+=1
 result=execute_registered_action(action,payload,confirmed=True,idempotency_key=prefix+'-'+str(seq))
 assert result.get('result') is not None,(action,result)
 frappe.db.commit()
 return result['result']
def service(name,payload):return invoke_domain_service(name,payload)
def definition():return service('files.promotion_definition',{'table':table})
def define(columns):
 frappe.set_user('Administrator');current=definition()
 return act('files.promotion_define',{'table':table,'expected_structure_version':current['structure_version'],'expected_definition_sha':current['definition_sha'],'definition':{'definition_version':1,'columns':columns}})
def view():return service('files.sheet_read',{'table':table})
def latch():
 v=view();return {'table':table,'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
columns=[{'header':'金额','field':'amount','promoted':True,'type':'number','rules':{'required':True},'read_roles':['Desk User'],'write_roles':['Desk User']}]
define(columns);rid=view()['rows'][0]['row_id']
module_name='shangshu_core.tests._controlled_ready_'+prefix
module=types.ModuleType(module_name)
def guard(action,payload,context):
 result=invoke_domain_service('files.row_require_ready',{'table':payload['table'],'row_id':payload['row_id']})
 return result['ready'] is True
def handler(action,payload,context):
 calls.append(payload['row_id'])
 doc=frappe.get_doc({'doctype':'ToDo','description':prefix+'-business-write','allocated_to':owner}).insert(ignore_permissions=True)
 todos.append(doc.name)
 return {'todo':doc.name}
module.guard=guard;module.handler=handler;sys.modules[module_name]=module
action_id='platform.test.ready.'+prefix
core=frappe.get_doc('Shangshu Domain','com.shangshu.core');original=core.contribution_json
original_sha=hashlib.sha256(original.encode()).hexdigest();candidate=json.loads(original)
candidate.setdefault('actions',[]).append({'id':action_id,'version':'1.0.0','effect':'write','handler':module_name+'.handler','execution_guard':module_name+'.guard'})
staged=json.dumps(candidate,ensure_ascii=False)
try:
 assert frappe.db.get_value('Shangshu Domain',core.name,'contribution_json')==original
 frappe.db.set_value('Shangshu Domain',core.name,'contribution_json',staged,update_modified=False)
 register_action(action_id,'1.0.0','受控就绪消费者','write','required',['Desk User'],{'type':'object','required':['table','row_id'],'properties':{'table':{'type':'string'},'row_id':{'type':'string'}},'additionalProperties':False},{'type':'object'})
 frappe.db.commit()
 def run_consumer(expect_ready):
  before=frappe.db.count('ToDo',{'description':prefix+'-business-write'});n=len(calls)
  rejected=False
  try:act(action_id,{'table':table,'row_id':rid},owner)
  except frappe.ValidationError:rejected=True
  after=frappe.db.count('ToDo',{'description':prefix+'-business-write'})
  check('ready executes exactly one real handler/storage write' if expect_ready else 'draft blocks before handler with zero real business writes',not rejected and len(calls)==n+1 and after==before+1 if expect_ready else rejected and len(calls)==n and after==before)
 run_consumer(False)
 frappe.set_user(owner);act('files.sheet_input_write',{**latch(),'start_row':0,'start_col':1,'value':{'type':'number','value':31},'op_id':prefix+'-fill'},owner)
 run_consumer(True)
 columns.append({'header':'备注','field':'note','promoted':True,'type':'text','rules':{'required':True},'read_roles':['Desk User'],'write_roles':['Desk User']})
 define(columns);run_consumer(False)
 # Restore note as ordinary? Do not unbind: retain one ordinary name cell and formal amount.
 columns[0]['write_roles']=['System Manager'];define(columns)
 def snapshot():
  doc=frappe.get_doc('Shangshu File Center File',table)
  content=frappe.get_doc('File',doc.current_file).get_content()
  return {**{k:doc.get(k) for k in ['formal_values_json','sheet_meta_json','version_count','current_file','current_sha256','modified']},'xlsx_sha':hashlib.sha256(content).hexdigest()}
 frappe.set_user(owner);before=snapshot();rejected=False
 try:act('files.sheet_paste_apply',{**latch(),'start_row':0,'start_col':0,'matrix':[['must-not-write',99]],'matrix_types':[['text','number']],'extend':False,'op_id':prefix+'-denied-mixed'},owner)
 except (frappe.PermissionError,frappe.ValidationError):rejected=True
 after=snapshot();check('mixed ordinary/formal paste with no formal write role rejects whole package DB XLSX versions unchanged',rejected and before==after)
 check('ordinary name and prior formal amount remain intact',view()['rows'][0]['values']['名称']['value']=='controlled' and view()['rows'][0]['values']['金额']['value']==31)
 RESULT.update(checks=checks,handler_calls=len(calls),business_todos=todos,action_id=action_id,original_contribution_sha=original_sha)
finally:
 frappe.set_user('Administrator')
 current=frappe.db.get_value('Shangshu Domain',core.name,'contribution_json')
 assert current==staged,'Concurrent contribution mutation: refusing overwrite'
 frappe.db.set_value('Shangshu Domain',core.name,'contribution_json',original,update_modified=False)
 if frappe.db.exists('Shangshu Action Definition',action_id+'@1.0.0'):
  frappe.db.set_value('Shangshu Action Definition',action_id+'@1.0.0','enabled',0)
 for name in todos:
  if frappe.db.exists('ToDo',name):frappe.delete_doc('ToDo',name,ignore_permissions=True)
 frappe.db.commit();sys.modules.pop(module_name,None)
 RESULT['cleanup']={'contribution_restored':frappe.db.get_value('Shangshu Domain',core.name,'contribution_json')==original,'action_disabled':not frappe.db.get_value('Shangshu Action Definition',action_id+'@1.0.0','enabled'),'business_records_remaining':frappe.db.count('ToDo',{'description':prefix+'-business-write'})}
'''.replace('__PREFIX__',repr(f.prefix)).replace('__TABLE__',repr(table)).replace('__OWNER__',repr(f.users['owner']))
 out=f.console_module.run(code,timeout=180);print('CONSUMER',json.dumps(out,ensure_ascii=False),flush=True)
 f.check('consumer public execution and atomic mixed ACL checks',not out.get('__error__') and len(out.get('checks',[]))==5 and all(x['passed'] for x in out['checks']))
 c=out.get('cleanup',{});f.check('contribution restored action disabled and exact ToDo fixture removed',c.get('contribution_restored') and c.get('action_disabled') and c.get('business_records_remaining')==0)
finally:f.cleanup()
raise SystemExit(f.finish())
