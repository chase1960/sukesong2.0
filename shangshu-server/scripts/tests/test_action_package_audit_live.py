"""Actual input/paste/failed-write/undo packets and authoritative audit cardinality.

Explicit isolated-site execution only. One unique mixed workbook; normal recycle
in finally. Does not claim clipboard rendering or all frontend undo-stack coverage.
"""
import sys, os, json, uuid, importlib.util
from pathlib import Path

def main():
 if '--execute-live' not in sys.argv:
  print('NOT_RUN: require --execute-live and exclusive QA window');return 1
 root=Path(__file__).resolve().parents[3]
 os.environ['SS_ROOT']=str(root)
 if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':
  raise RuntimeError('Explicit isolated QA base/container required')
 import _ss_seed as seed, _ss_console as console
 from _ss_cred import admin_pw_for
 spec=importlib.util.spec_from_file_location('package_api',root/'shangshu-server/scripts/test-n2-structure.py')
 t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
 client=t.Client(os.environ['SS_BASE']);client.login('Administrator',admin_pw_for(os.environ['SS_BASE']))
 handle=None;run=uuid.uuid4().hex;passed=[]
 def check(label,ok):
  assert ok,label
  passed.append(label);print('PASS '+label,flush=True)
 def read():
  status,body=t.service(client,'files.sheet_read',{'table':handle['table']});assert status==200
  return seed._result(status,body)
 def definition():
  status,body=t.service(client,'files.promotion_definition',{'table':handle['table']});assert status==200
  return seed._result(status,body)
 def history():
  status,body=t.service(client,'files.op_history',{'file':handle['table'],'limit':100});assert status==200
  return seed._result(status,body)['ops']
 def audits(key):
  result=console.run("RESULT['rows']=frappe.get_all('Shangshu Action Execution Audit',filters={'idempotency_key':%r},fields=['name','action_id','status','input_summary_json'])"%t.receipt_key(key))
  assert '__error__' not in result;return result['rows']
 def act(action,payload,key):
  status,body=t.action(client,action,payload,key);assert status==200,(action,status,body)
  return seed._result(status,body)
 try:
  handle=seed.seed_mixed_table(client,run='packet-'+run,rows=[{'项目名称':'one','金额':1,'备注':'old1'},{'项目名称':'two','金额':2,'备注':'old2'},{'项目名称':'three','金额':3,'备注':'old3'}],attribution={'level':'personal','owner_user':'Administrator'})
  print('FIXTURE '+handle['table'],flush=True)
  before=read();count=len(history());original_definition=definition()
  original_fields=[c['field'] for c in original_definition['columns'] if c.get('promoted')]
  check('initial promotion creates formal bindings without ordinary input packets',len(original_fields)==2 and count==0)
  for kind in ['table.open','copy.range']:
   key=run+'-'+kind
   result=act('files.action_fact',{'op_id':key,'action':kind,'target':handle['table'],'detail':{'table_name':handle['file_name']}},key)
   check(kind+' observation has one fact and zero value packets',result['action_count']==1 and len(history())==count)
  view=read();key=run+'-input'
  result=act('files.sheet_input_write',{'table':handle['table'],'start_row':0,'start_col':2,'value':{'type':'text','value':'00123'},'op_id':key,'expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']},key)
  entry=next(item for item in history() if item['op_id']==key)
  check('input remains input, one packet one cell one successful core audit',entry['action_id']=='files.sheet_input_write' and len(entry['cells'])==1 and len(audits(key))==1 and audits(key)[0]['status']=='Succeeded')
  check('input retains before and after with stable row/header',entry['cells'][0]['row_id']==view['rows'][0]['row_id'] and entry['cells'][0]['header']=='备注' and entry['cells'][0]['before']['value']=='old1' and entry['cells'][0]['after']['value']=='00123')
  view=read();key=run+'-paste';matrix=[[11,'new1','extra1','x1'],[22,'new2','extra2','x2'],[33,'new3','extra3','x3']]
  payload={'table':handle['table'],'start_row':0,'start_col':1,'matrix':matrix,'matrix_types':[['number','text','text','text']]*3,'extend':True,'op_id':key,'expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']}
  result=act('files.sheet_paste_apply',payload,key)
  entries=[item for item in history() if item['op_id']==key]
  check('3x4 mixed paste is one packet with twelve cell snapshots',len(entries)==1 and len(entries[0]['cells'])==12 and result['action_count']==1 and result['formal_written'] and result['sheet_written'])
  check('mixed paste produces exactly one successful core action audit',len(audits(key))==1 and audits(key)[0]['action_id']=='files.sheet_paste_apply' and audits(key)[0]['status']=='Succeeded')
  act('files.sheet_paste_apply',payload,key)
  check('same-key replay adds no packet or successful audit',len([item for item in history() if item['op_id']==key])==1 and len(audits(key))==1)
  view=read();bad=run+'-invalid';count=len(history())
  status,_=t.action(client,'files.sheet_input_write',{'table':handle['table'],'start_row':0,'start_col':1,'value':{'type':'text','value':'not-a-number'},'op_id':bad,'expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']},bad)
  current=read()
  check('invalid promoted value rejects without version or operation packet change',status not in (0,200) and current['content_version']==view['content_version'] and len(history())==count)
  failed=console.run("from shangshu_core.action_requests import request_name\nRESULT['rows']=frappe.get_all('Shangshu Action Request',filters={'request_key':request_name(%r)},fields=['status','failure_reason'])"%t.receipt_key(bad))
  check('rejected write has durable failed request and no successful audit',not audits(bad) and len(failed.get('rows',[]))==1 and failed['rows'][0]['status']=='Failed' and bool(failed['rows'][0]['failure_reason']))
  undone=act('files.sheet_cells_undo',{'table':handle['table'],'op_id':key},run+'-undo')
  entry=next(item for item in history() if item['op_id']==key)
  check('undo retains original immutable snapshots and marks original packet undone',entry['undone']==1 and entry['cells']==entries[0]['cells'] and len(undone['cells'])==12)
  check('undo has its own one core audit rather than deleting original fact',len(audits(run+'-undo'))==1 and len(audits(key))==1)
  current_definition=definition()
  check('ordinary expanded columns do not create formal fields or change definition revision',current_definition['definition_version']==original_definition['definition_version'] and [c['field'] for c in current_definition['columns'] if c.get('promoted')]==original_fields)
  view=read()
  act('files.sheet_header_rename',{'table':handle['table'],'from_header':'金额','to_header':'应缴金额','op_id':run+'-rename','expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']},run+'-rename')
  renamed=definition();later=read()
  check('promoted column rename retains formal field identity and row identities',next(c for c in renamed['columns'] if c['header']=='应缴金额')['field']=='amount' and [r['row_id'] for r in later['rows']]==[r['row_id'] for r in view['rows']])
  historical=next(item for item in history() if item['op_id']==key)
  check('header rename does not rewrite historical paste snapshots',historical['cells']==entries[0]['cells'])

  print('RESULT %d/%d actual package/audit checks'%(len(passed),len(passed)),flush=True)
 finally:
  if handle:
   result=seed.seed_cleanup(client,handle);assert result['active_left']==[]
   print('CLEANUP exact workbook recycled; audit and trash history retained',flush=True)
 return 0
if __name__=='__main__':sys.exit(main())
