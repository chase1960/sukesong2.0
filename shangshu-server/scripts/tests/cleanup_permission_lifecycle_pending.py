"""Exact recovery of two failed synthetic runs; public restore/reject/recycle only."""
import os,sys,json
if '--execute-live' not in sys.argv or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA exclusive window required')
import _ss_console as c
code='''
from shangshu_core.public_api import execute_registered_action,resolve_action_proposal
import uuid
items=[('APROP-2026-00061','mgqrg7930r','permlifef807366ee8e1-owner@example.invalid'),('APROP-2026-00062','ni1mplejf1','permlifebdeb180757ae-member@example.invalid')]
def act(action,payload):
 return execute_registered_action(action,payload,confirmed=True,idempotency_key='permlife-recover-'+uuid.uuid4().hex)
RESULT['items']=[]
for proposal,file,user in items:
 frappe.set_user('Administrator')
 assert frappe.db.get_value('User',user,'enabled')==0
 assert frappe.db.get_value('Shangshu File Center File',file,'status')=='Recycled'
 assert frappe.db.get_value('Shangshu Org Attribution',{'resource':file},'owner_user')==user
 assert frappe.db.get_value('Shangshu Action Proposal',proposal,'status')=='Proposed'
 act('platform.identity.status',{'email':user,'enabled':True});frappe.db.commit()
 try:
  frappe.set_user(user)
  act('files.restore',{'file':file});frappe.db.commit()
  resolve_action_proposal(proposal,'rejected');frappe.db.commit()
 finally:
  frappe.set_user(user)
  if frappe.db.get_value('Shangshu File Center File',file,'status')!='Recycled':
   act('files.recycle',{'file':file});frappe.db.commit()
  frappe.set_user('Administrator')
  act('platform.identity.status',{'email':user,'enabled':False});frappe.db.commit()
 row={'proposal':proposal,'status':frappe.db.get_value('Shangshu Action Proposal',proposal,'status'),'file':file,'file_status':frappe.db.get_value('Shangshu File Center File',file,'status'),'user_enabled':frappe.db.get_value('User',user,'enabled')}
 assert row['status']=='Rejected' and row['file_status']=='Recycled' and row['user_enabled']==0,row
 RESULT['items'].append(row)
'''
out=c.run(code);print(json.dumps(out,ensure_ascii=False,indent=2));assert '__error__' not in out and len(out.get('items',[]))==2,out
