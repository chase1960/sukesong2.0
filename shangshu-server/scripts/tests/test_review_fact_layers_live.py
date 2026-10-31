"""UI103: real proposal/decision/execution layers, no browser or model required."""
import os, sys, uuid, json, importlib.util
from pathlib import Path

def main():
 if '--execute-live' not in sys.argv:
  print('NOT_RUN: requires exclusive QA window and --execute-live'); return 1
 root=Path(__file__).resolve().parents[3]; os.environ['SS_ROOT']=str(root)
 assert os.environ.get('SS_BASE')=='http://127.0.0.1:3850'
 assert os.environ.get('SS_CONTAINER')=='shangshu-local-r967-frappe-1'
 import _ss_seed as seed, _ss_console as console
 from _ss_cred import admin_pw_for
 spec=importlib.util.spec_from_file_location('layer_api',root/'shangshu-server/scripts/test-n2-structure.py')
 api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
 c=api.Client(os.environ['SS_BASE']); c.login('Administrator',admin_pw_for(os.environ['SS_BASE']))
 handle=None; proposals=[]; checks=[]; run=uuid.uuid4().hex
 def check(label,ok):
  assert ok,label
  checks.append(label); print('PASS '+label,flush=True)
 def db(code):
  result=console.run(code); assert '__error__' not in result,result; return result
 def read():
  st,b=api.service(c,'files.sheet_read',{'table':handle['table']}); assert st==200,(st,b)
  return seed._result(st,b)
 def snapshot():
  return db("import json,hashlib\nfrom shangshu_files.sheet import _content\nd=frappe.get_doc('Shangshu File Center File',%r)\nRESULT.update(formal=json.loads(d.formal_values_json or '{}'),sha=hashlib.sha256(_content(d)).hexdigest(),ops=frappe.db.count('Shangshu File Center Sheet Op',{'file':d.name}))"%handle['table'])
 def propose(value):
  v=read(); p={'table':handle['table'],'cells':[{'row_id':v['rows'][0]['row_id'],'header':'金额','value':{'type':'number','value':value}}],'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
  result=db("from shangshu_core.public_api import propose_registered_action\nfrappe.set_user('Administrator')\nRESULT['id']=propose_registered_action('files.sheet_cells_write',%r,idempotency_key=%r)['id']\nfrappe.db.commit()"%(p,uuid.uuid4().hex))
  proposals.append(result['id']); return result['id']
 def resolve(pid,decision,edited=None):
  p={'decision':decision}
  if edited is not None:p['edited_value']=edited
  return c.request('POST','/api/platform/action-proposals/'+pid+'/resolve',p)
 def stored(pid):
  return db("d=frappe.get_doc('Shangshu Action Proposal',%r)\nRESULT.update(status=d.status,payload=d.payload_json,review=d.review_state_json,audit=d.execution_audit,decider=d.decision_by)"%pid)
 try:
  handle=seed.seed_mixed_table(c,run='layers-'+run,attribution={'level':'personal','owner_user':'Administrator'})
  print('FIXTURE '+handle['table'],flush=True)
  before=snapshot(); rejected=propose(123)
  check('proposal creation changes neither formal values nor workbook bytes nor value packets',snapshot()==before)
  st,b=resolve(rejected,'rejected'); check('reject succeeds and preserves all formal facts',st==200 and snapshot()==before and stored(rejected)['status']=='Rejected')
  adopted=propose(234); st,b=resolve(adopted,'confirmed',{'type':'number','value':345})
  check('edited candidate executes actual promoted write',st==200 and read()['rows'][0]['values']['金额']['value']==345)
  record=stored(adopted); original=json.loads(record['payload']); review=json.loads(record['review']); operations=list(review['operations'].values())
  check('original candidate preserved separately from actual edited operation',original['cells'][0]['value']['value']==234 and operations[0]['payload']['cells'][0]['value']['value']==345)
  audit=db("RESULT['row']=frappe.get_doc('Shangshu Action Execution Audit',%r).as_dict()"%record['audit'])['row']
  check('confirmed decision links a successful real execution audit',record['status']=='Confirmed' and record['decider']=='Administrator' and operations[0]['audit']==record['audit'] and audit['status']=='Succeeded')
  stale=propose(456); view=read()
  st,b=api.action(c,'files.sheet_input_write',{'table':handle['table'],'start_row':0,'start_col':1,'value':{'type':'number','value':567},'op_id':run+'-manual','expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']},run+'-manual'); assert st==200,(st,b)
  changed=snapshot(); st,b=resolve(stale,'confirmed')
  check('stale confirmation cannot overwrite newer formal value or claim success',st in (400,409,417,422) and snapshot()==changed and stored(stale)['status']=='Proposed' and not stored(stale)['audit'])
  st,b=resolve(stale,'rejected'); check('failed proposal remains rejectable without undoing human work',st==200 and snapshot()==changed)
  page_ids=[propose(value) for value in (601,602,603)]
  cursor=''; seen=[]
  for expected in reversed(page_ids):
   st,b=c.request('GET','/api/platform/action-proposals?limit=1'+('&after='+cursor if cursor else ''))
   assert st==200,(st,b)
   check('descending proposal page returns next exact authorized target '+expected,len(b['list'])==1 and b['list'][0]['id']==expected and expected not in seen)
   seen.append(expected);cursor=b.get('next_cursor')
  for pid in page_ids:
   st,b=resolve(pid,'rejected');assert st==200,(st,b)
  print('RESULT %s/%s'%(len(checks),len(checks)),flush=True)
 finally:
  for pid in proposals:
   if stored(pid)['status']=='Proposed':
    st,b=resolve(pid,'rejected'); assert st==200,(st,b)
  if handle:
   result=seed.seed_cleanup(c,handle); assert result['active_left']==[]
   print('CLEANUP exact workbook recycled; proposals resolved; immutable evidence retained',flush=True)
 return 0

if __name__=='__main__':sys.exit(main())
