"""Only new relation search and source/target rename/undo HTTP cases."""
import json,sys,uuid
import test_table_relations_live as t
from test_organization_audit_live import check,checks

def main():
 seed={}
 try:
  seed=t.create_fixture();c=t.Client(t.USERS['a']);source=seed['a'];target=seed['target']
  def action(a,p):
   r=t.act(c,a,p);assert t.ok(r),(a,r);return t.val(r)
  def versions(table):
   v=t.view(c,table);return {'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']}
  def rename(table,before,after):
   op=uuid.uuid4().hex;r=action('files.sheet_header_rename',{'table':table,'from_header':before,'to_header':after,'op_id':op,**versions(table)});return r.get('structure_undo_op_id') or op
  def undo(table,op):return t.act(c,'files.sheet_structure_undo',{'table':table,'undo_of':op,'op_id':uuid.uuid4().hex,**versions(table)})
  action('platform.org.public_resource',{'resource':target,'enabled':True})
  sv=t.view(c,source);tv=t.view(c,target);rows=[r['row_id'] for r in sv['rows']];trs=[r['row_id'] for r in tv['rows']]
  r=action('files.table_relation_define',{'table':source,'header':'Reference','target_table':target,'target_header':'Amount','expected_structure_version':sv['structure_version']})
  for row,tr in zip(rows,trs):r=action('files.table_relation_set',{'table':source,'header':'Reference','row_id':row,'target_row_id':tr,'expected_revision':r['revision']})
  for text,count in [('800',1),('1700',1),('never-match',0)]:
   st,b=t.service(c,'files.sheet_read',{'table':source,'search':text,'page_length':1});check('live relation/formula search '+text,st==200 and b.get('message',{}).get('total_rows')==count)
  st,b=t.service(c,'files.sheet_read',{'table':source,'search':'800','row_ids':[]});check('search explicit empty row selection',st==200 and b['message']['total_rows']==0 and b['message']['rows']==[])
  op=rename(source,'Reference','RefNew');view=t.view(c,source);check('source rename retains value',view['rows'][0]['values']['RefNew']['value']==800)
  check('source rename undo succeeds',t.ok(undo(source,op)));view=t.view(c,source);check('source undo restores original binding and value',view['rows'][0]['values']['Reference']['value']==800)
  op=rename(target,'Amount','AmountNew');view=t.view(c,source);check('target rename retains all references',view['rows'][0]['values']['Reference']['value']==800)
  check('target rename undo succeeds',t.ok(undo(target,op)));view=t.view(c,source);check('target undo restores relation target header',view['rows'][0]['values']['Reference']['relation_target']['header']=='Amount')
  op=rename(target,'Amount','AmountNew');st,b=t.service(c,'files.table_relation_read',{'table':source,'row_ids':[]});revision=b['message']['definitions'][0]['revision']
  action('files.table_relation_set',{'table':source,'header':'Reference','row_id':rows[0],'target_row_id':trs[1],'expected_revision':revision})
  denied=undo(target,op);check('later row binding prevents old structural undo',denied[0]>=400 and t.view(c,source)['rows'][0]['values']['Reference']['value']==900)
 finally:
  t.console("from shangshu_core.public_api import execute_registered_action\nfor i,u in enumerate(%r):\n if frappe.db.exists('User',u):execute_registered_action('platform.identity.status',{'email':u,'enabled':False},confirmed=True,idempotency_key=%r+str(i))\nfor d in %r:frappe.db.set_value('Shangshu Department',d,'enabled',0)\nfor f in %r:frappe.db.set_value('Shangshu File Center File',f,'status','Recycled')\nfrappe.db.commit()\nRESULT['cleaned']=True"%(list(t.USERS.values()),t.P+'cleanup-',seed.get('departments',[]),seed.get('files',[])))
  print('CLEANED',json.dumps({'prefix':t.P,'files':seed.get('files',[])}))
 print('RESULT',sum(checks),'/',len(checks));return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
