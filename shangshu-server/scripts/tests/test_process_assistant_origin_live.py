"""Actual tool bridge journal -> finance draft handler start -> downstream proposal.
No LLM, invoice extraction, expense submission, ledger posting, or payment occurs.
"""
import argparse,json,os,subprocess,urllib.request
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture,console

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('requires scheduled window')
 f=fixture({'mode':'seed'});base=os.environ['SS_BASE'];op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
 def http(path,data=None):
  try:r=op.open(urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'}))
  except urllib.error.HTTPError as e:raise RuntimeError('HTTP '+str(e.code)+' '+e.read().decode()[:1200])
  assert r.status==200;return json.load(r)
 try:
  seeded=console('USER='+repr(f['user'])+'\nPREFIX='+repr(f['prefix'])+'\n'+'''
import hashlib,json
frappe.set_user(USER)
f=frappe.get_doc({'doctype':'File','file_name':PREFIX+'.txt','is_private':1,'content':b'UI038 isolated synthetic invoice fixture'}).insert(ignore_permissions=True)
e=frappe.get_doc({'doctype':'Shangshu Document Extraction','file':f.name,'file_sha256':hashlib.sha256(PREFIX.encode()).hexdigest(),'has_text_layer':0,'status':'Succeeded','candidate_tools_json':'["document.vision_extract"]','selected_tool':'document.vision_extract','selection_reason':'controlled fixture, no extraction/model','output_json':'{}'}).insert(ignore_permissions=True)
i=frappe.get_doc({'doctype':'Shangshu Finance Invoice','status':'Confirmed','invoice_number':PREFIX,'invoice_date':frappe.utils.today(),'seller_name':'UI038 synthetic','total_amount':1,'direction':'Input','duplicate_key':PREFIX,'file':f.name,'extraction':e.name,'record_version':1}).insert(ignore_permissions=True)
frappe.db.commit();RESULT['invoice']=i.name
''')
  request=f['prefix']+'-assistant-origin'
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','scripts/tests/process-origin-assistant-propose.ts'],input=json.dumps({**f,**seeded,'request':request}),capture_output=True,text=True,timeout=60)
  if p.returncode:raise RuntimeError('Node bridge failed: '+p.stderr[-1200:])
  proposal=json.loads(p.stdout.strip().splitlines()[-1])['proposal']
  http('/api/platform/login',{'username':f['user'],'password':f['password']})
  result=http('/api/platform/action-proposals/'+proposal+'/resolve',{'decision':'confirmed'})
  downstream=console('USER='+repr(f['user'])+'\nINVOICE='+repr(seeded['invoice'])+'\nPREFIX='+repr(f['prefix'])+'\n'+'''
import json
from shangshu_core.public_api import begin_node_execution,process_node_provenance,propose_registered_action
frappe.set_user(USER)
claim=frappe.get_doc('Shangshu Expense Claim',{'invoice':INVOICE})
instance=frappe.get_doc('Shangshu Process Instance',claim.process_instance)
origin=json.loads(instance.origin_snapshot_json)
assert origin['action_id']=='finance.expense.create_draft' and origin['request_id']==PREFIX+'-assistant-origin'
opened=begin_node_execution(instance.name,instance.current_node,{})
with process_node_provenance(opened['execution'],opened['token']):
 p=propose_registered_action('finance.expense.submit',{'claim':claim.name,'action':'submit'},idempotency_key=PREFIX+'-downstream',source='automation')
frappe.db.commit();RESULT.update({'proposal':p['id'],'instance':instance.name})
''')
  projected=http('/api/platform/action-proposal-get/'+downstream['proposal'])['source_provenance']
  assert projected['trusted'] and projected['initiator']['kind']=='assistant' and projected['initiator']['trusted'],projected
  assert projected['initiator']['request_id']==request
  assert projected['llm_participants'],'existing controlled finance intake participation'
  http('/api/platform/action-proposals/'+downstream['proposal']+'/resolve',{'decision':'rejected'})
  print('PASS actual journal + core original request -> handler-started process -> downstream verified Assistant initiator')
  print('PASS actual existing runtime intake participation retained; no model/content-generation claim')
 finally:
  cleanup=console('USER='+repr(f['user'])+'\nPREFIX='+repr(f['prefix'])+'\n'+'''
from shangshu_core.public_api import resolve_action_proposal
frappe.set_user(USER)
for p in frappe.get_all('Shangshu Action Proposal',filters={'actor_user':USER,'status':'Proposed'},pluck='name'):resolve_action_proposal(p,'rejected')
frappe.set_user('Administrator')
claims=frappe.get_all('Shangshu Expense Claim',filters={'applicant':USER},fields=['name','process_instance','workflow_state'])
assert all(c.workflow_state=='SS Draft' for c in claims)
for c in claims:
 if c.process_instance:frappe.db.set_value('Shangshu Process Instance',c.process_instance,'status','Cancelled')
 # Keep the synthetic draft and immutable audit linked, with disabled identity;
 # invoice marked void, process cancelled, no approval/payment can progress.
for n in frappe.get_all('Shangshu Finance Invoice',filters={'invoice_number':PREFIX},pluck='name'):frappe.db.set_value('Shangshu Finance Invoice',n,'status','Voided')
frappe.db.commit();RESULT['cancelled_draft_processes']=len(claims)
''')
  fixture({'mode':'cleanup','fixture':f,'mails':[]});print('CLEANUP',json.dumps(cleanup),'identity disabled; invoice voided; draft retained as audit fixture')
if __name__=='__main__':main()
