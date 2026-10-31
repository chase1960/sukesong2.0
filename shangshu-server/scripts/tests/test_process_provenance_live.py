"""Scheduled UI038 probe. Synthetic stored graph, actual runtime/proposal/HTTP;
AI selection is a controlled runtime completion, not an actual model invocation.
"""
import argparse,json,os,sys,subprocess,urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
import _ss_console

def fixture(value):
 p=subprocess.run([sys.executable,str(Path(__file__).with_name('mail-default-identity-fixture.py'))],input=json.dumps(value),capture_output=True,text=True,check=True)
 return json.loads(p.stdout)
def console(code):
 value=_ss_console.run(code)
 if '__error__' in value:raise RuntimeError(value['__error__']+'\n'+value.get('__trace__',''))
 return value

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('requires scheduled window')
 f=fixture({'mode':'seed'});mails=[];base=os.environ['SS_BASE']
 op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
 def http(path,data=None):
  r=op.open(urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'}));assert r.status==200
  return json.load(r)
 try:
  http('/api/platform/login',{'username':f['user'],'password':f['password']})
  code='''
import json,hashlib
from shangshu_core.public_api import get_identity,begin_node_execution,complete_node_execution,process_node_provenance,propose_registered_action
from shangshu_core.actions import _definition
from shangshu_core.action_provenance import current_action_provenance,project_action_provenance
frappe.set_user(USER)
identity=get_identity();made=[]
for has_ai in (False,True):
 key=PREFIX+('-llm' if has_ai else '-code')
 nodes=[{'id':'write','type':'action','action_id':'mail.save_draft','terminal':True}]
 if has_ai:nodes.insert(0,{'id':'extract','type':'ai_select','candidates':['document.pdf_text_extract']})
 graph={'nodes':nodes,'edges':[{'source':'extract','target':'write'}] if has_ai else []}
 graph['nodes'][0]['start']=True
 serialized=json.dumps(graph,sort_keys=True);digest=hashlib.sha256(serialized.encode()).hexdigest()
 definition=frappe.get_doc({'doctype':'Shangshu Process Definition','definition_id':key,'title':'UI038 isolated probe','namespace':'test.ui038','business_object':'Shangshu Mail Message','enterprise_id':identity.enterprise_id,'graph_json':serialized,'status':'Disabled'}).insert(ignore_permissions=True)
 deps={a:{'registry_key':_definition(a).name} for a in ['mail.save_draft','document.pdf_text_extract']}
 version=frappe.get_doc({'doctype':'Shangshu Process Definition Version','version_id':key+'@1','definition':definition.name,'version_number':1,'graph_hash':digest,'graph_json':serialized,'dependency_snapshot_json':json.dumps({'actions':deps}),'published_by':USER,'published_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
 instance=frappe.get_doc({'doctype':'Shangshu Process Instance','definition_version':version.name,'definition_id':key,'graph_hash':digest,'initiator_identity':identity.name,'initiator_user':USER,'enterprise_id':identity.enterprise_id,'status':'Running','current_node':nodes[0]['id'],'started_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
 frappe.db.commit()
 if has_ai:
  opened=begin_node_execution(instance.name,'extract',{})
  complete_node_execution(opened['execution'],opened['token'],selected_tool='document.pdf_text_extract',output_data={'controlled_fixture':True},reason='UI038 controlled selection; no model invocation')
 opened=begin_node_execution(instance.name,'write',{})
 try:
  with process_node_provenance(opened['execution'],'forged'):pass
 except frappe.PermissionError:frappe.clear_messages()
 else:raise AssertionError('forged token accepted')
 with process_node_provenance(opened['execution'],opened['token']):
  p=propose_registered_action('mail.save_draft',{'subject':key,'body':'controlled source proof','to':[],'cc':[]},idempotency_key=key,source='automation')
  snapshot=current_action_provenance('mail.save_draft')
  assert bool(snapshot['llm_participants'])==has_ai
  assert snapshot['executor_kind']=='code'
  try:current_action_provenance('mail.save_draft','not-the-pinned-version')
  except frappe.ValidationError:frappe.clear_messages()
  else:raise AssertionError('wrong version accepted')
 made.append({'proposal':p['id'],'instance':instance.name,'execution':opened['execution'],'has_ai':has_ai})
frappe.db.commit();RESULT['cases']=made
'''
  cases=console('USER='+repr(f['user'])+'\nPREFIX='+repr(f['prefix'])+'\n'+code)['cases']
  for case in cases:
   p=http('/api/platform/action-proposal-get/'+case['proposal']);proof=p['source_provenance']
   assert proof['trusted'] and proof['status']=='linked' and proof['executor_kind']=='code'
   assert bool(proof['llm_participants'])==case['has_ai']
   if not case['has_ai']:assert proof['llm_participants']==[]
   resolved=http('/api/platform/action-proposals/'+case['proposal']+'/resolve',{'decision':'confirmed'})
   print('PASS HTTP proposal current process proof + confirmation',case['has_ai'],flush=True)
   verify=console("""
from shangshu_core.action_provenance import project_action_provenance
frappe.set_user(%r)
p=frappe.get_doc('Shangshu Action Proposal',%r)
rows=frappe.get_all('Shangshu Action Execution Audit',filters={'actor_user':p.actor_user,'action_id':p.action_id},fields=['name','source_snapshot_json'])
rows=[r for r in rows if r.source_snapshot_json==p.source_snapshot_json]
assert rows and any(project_action_provenance(r.source_snapshot_json).get('trusted') for r in rows)
RESULT['audit_count']=len(rows)
"""%(f['user'],case['proposal']))
   print('PASS persisted audit retains source',verify['audit_count'],flush=True)
   console("frappe.db.set_value('Shangshu Process Instance',%r,'initiator_user','Administrator')\nfor n in frappe.get_all('Shangshu Process Subscription',filters={'process_instance':%r,'user':%r},pluck='name'):frappe.delete_doc('Shangshu Process Subscription',n,ignore_permissions=True)\nfrappe.db.commit()"%(case['instance'],case['instance'],f['user']))
   hidden=http('/api/platform/action-proposal-get/'+case['proposal'])['source_provenance']
   assert hidden=={'status':'unavailable','trusted':False},hidden
   print('PASS current process permission revocation hides all source identifiers',flush=True)
  print('RESULT UI038 controlled runtime source and HTTP confirmation passed; model not invoked')
 finally:
  cleaned=console("""
from shangshu_core.public_api import resolve_action_proposal
frappe.set_user(%r)
for p in frappe.get_all('Shangshu Action Proposal',filters={'actor_user':frappe.session.user,'status':'Proposed'},pluck='name'):resolve_action_proposal(p,'rejected')
frappe.set_user('Administrator')
rows=frappe.get_all('Shangshu Process Instance',filters={'definition_id':['like',%r]},pluck='name')
for name in rows:frappe.db.set_value('Shangshu Process Instance',name,'status','Cancelled')
RESULT['instances_cancelled']=len(rows)
RESULT['mails']=frappe.get_all('Shangshu Mail Message',filters={'owner':%r},pluck='name')
frappe.db.commit()
"""%(f['user'],f['prefix']+'%%',f['user']))
  fixture({'mode':'cleanup','fixture':f,'mails':cleaned['mails']})
  print('CLEANUP',json.dumps({'instances_cancelled':cleaned['instances_cancelled'],'mails_recycled':len(cleaned['mails']),'identity_disabled':True,'definitions_disabled':True}))
if __name__=='__main__':main()
