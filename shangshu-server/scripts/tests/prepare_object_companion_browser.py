"""Explicit prepare/cleanup for coordinator's UI028 browser fixture on r967."""
import argparse,importlib.util,json,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('companion_live',HERE/'test_object_companion_live.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['prepare','cleanup']);parser.add_argument('--handle',required=True,type=Path);args=parser.parse_args()
 c=m.t.Client(m.BASE);c.login('Administrator',m.cred.admin_pw_for(m.BASE))
 if args.phase=='prepare':
  if args.handle.exists():raise RuntimeError('Handle already exists; use cleanup or another path')
  run='browser-'+uuid.uuid4().hex[:12];h={'base':m.BASE,'run':run,'records':[],'state':'preparing'}
  def save():args.handle.parent.mkdir(parents=True,exist_ok=True);args.handle.write_text(json.dumps(h,ensure_ascii=False,indent=2))
  save()
  h.update(m.sql("from shangshu_core.public_api import create_application_definition,prepare_object_change\na=create_application_definition(%r,%r)\nc=prepare_object_change(a['id'],{'schema_version':1,'title':%r,'access':{'read_roles':['Desk User'],'write_roles':['Desk User'],'record_scope':'all'},'fields':[{'id':'title','label':'事项','type':'text','required':True},{'id':'amount','label':'金额','type':'decimal'}]},%r)\nfrappe.db.commit();RESULT.update(object_id=c['object_id'],application=a['id'],change_id=c['id'])"%('UI028-'+run,'app-'+run,'UI028-'+run,'model-'+run)));save()
  m.sql("from shangshu_core.public_api import execute_object_change\nexecute_object_change(%r,True);frappe.db.commit();RESULT['ok']=True"%h['change_id'])
  m.sql("from shangshu_core.public_api import get_application_definition,save_application_draft,publish_application_definition\na=get_application_definition(%r)\nd={**a['draft'],'bindings':[{'kind':'datasets','resource_id':%r,'owner_domain':a['id'],'version':'1'}]}\ns=save_application_draft(a['id'],d,a['draft_revision']);publish_application_definition(a['id'],s['draft_revision']);frappe.db.commit();RESULT['ok']=True"%(h['application'],h['object_id']))
  for title,amount in [('浏览器甲',10),('浏览器乙',20)]:
   r=m.action(c,'platform.object.create',{'object_id':h['object_id'],'expected_revision':1,'values':{'title':title,'amount':amount}});h['records'].append(r['name']);save()
  h['file_id']=m.action(c,'files.create',{'file_name':'UI028-'+run+'.xlsx','attribution':{'level':'personal','owner_user':'Administrator'}})['file'];save()
  h['binding']=m.action(c,'platform.object.companion_bind',{'object_id':h['object_id'],'file_id':h['file_id'],'field_columns':[{'field_id':'title','header':'事项'},{'field_id':'amount','header':'金额'}]});save()
  def read():return m.service(c,'files.sheet_read',{'table':h['file_id']})
  def versions(r):return {'expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']}
  m.action(c,'files.sheet_column_append',{'table':h['file_id'],'header':'备注',**versions(read())})
  m.action(c,'files.sheet_cells_write',{'table':h['file_id'],'cells':[{'row_id':rid,'header':'备注','value':{'type':'text','value':'浏览器原备注-'+str(i+1)}} for i,rid in enumerate(h['records'])],'op_id':uuid.uuid4().hex,**versions(read())})
  h['url']=m.BASE+'/index.html?object='+h['object_id']+'#/excel';h['view']=read();h['state']='ready';save();print(json.dumps(h,ensure_ascii=False,indent=2))
 else:
  h=json.loads(args.handle.read_text());assert h['base']==m.BASE and h['run'].startswith('browser-')
  if h.get('state')=='cleaned':print('Already cleaned');return
  for rid in h['records']:
   r=m.sql("from shangshu_core.objects import get_object_record\nRESULT.update(get_object_record(%r,%r)['record'])"%(h['object_id'],rid))
   m.action(c,'platform.object.recycle',{'object_id':h['object_id'],'name':rid,'expected_revision':1,'expected_modified':r['modified']})
  if h.get('file_id'):
   out=m.seed.seed_cleanup(c,{'table':h['file_id']});assert not out['active_left'],out
  if h.get('application'):
   m.sql("from shangshu_core.public_api import get_application_definition,set_application_enabled\na=get_application_definition(%r)\nif a.get('published_revision'):set_application_enabled(a['id'],False,'UI028 browser fixture cleanup',a['draft_revision'])\nfrappe.db.commit();RESULT['ok']=True"%h['application'])
  h['state']='cleaned';args.handle.write_text(json.dumps(h,ensure_ascii=False,indent=2));print('CLEANED '+str(args.handle))
if __name__=='__main__':main()
