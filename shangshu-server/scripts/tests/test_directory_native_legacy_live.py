"""UI002 native directory and controlled legacy no-attribution fixture."""
import os,sys,json
if '--execute-live' not in sys.argv or os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit exclusive QA3850 required')
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('dirlegacy',('owner','peer'));legacy=None;snapshot=None

def check(label,ok):f.check(label,ok);assert ok,label
def act(name,payload):
 r=f.action(f.clients['owner'],name,payload);assert successful(r),(name,r);return result(r)
def con(code):
 r=f.console_module.run(code);assert '__error__' not in r,r;return r
def view(file):
 r=f.view(f.clients['owner'],file);assert r[0]==200,r;return result(r)
def row(file):
 r=f.listing(f.clients['owner']);assert r[0]==200,r
 rows=result(r)['rows'];matches=[x for x in rows if x['name']==file];assert len(matches)==1,(file,r);return matches[0]
def versions(v):return {k:v[k] for k in ('content_version','structure_version')}
try:
 f.setup()
 # Existing companion binding requires System Manager; confine this to synthetic user.
 seed=con("frappe.get_doc('User',%r).add_roles('System Manager')\nfrom shangshu_core.native_objects import declared\nRESULT['columns']=[{'field_id':x['id'],'header':x['id']} for x in declared('orders.order')[2]['fields']]\nfrappe.db.commit()"%f.users['owner'])
 order=act('orders.create',{'title':f.prefix,'customer':'Synthetic','sku':'SYNTH','quantity':2,'branch':'Stock'})
 native=act('files.create',{'file_name':f.prefix+'-native.xlsx','attribution':{'level':'personal','owner_user':f.users['owner']}})['file']
 act('platform.object.companion_bind',{'object_id':'orders.order','file_id':native,'field_columns':seed['columns']})
 # Remove fixture setup role before evaluating actual owner capabilities.
 con("frappe.get_doc('User',%r).remove_roles('System Manager')\nfrappe.db.commit()"%f.users['owner'])
 response=f.clients['owner'].request('GET','/api/platform/objects');assert response[0]==200,response
 matches=[x for x in response[1]['list'] if x['id']=='orders.order'];assert len(matches)==1,response
 r=matches[0];print('NATIVE_DIRECTORY',json.dumps(r,ensure_ascii=False))
 check('native catalog uses source object key and companion binding',r['companion']['file_id']==native and r['id']=='orders.order')
 check('native ownership metadata is explicit rather than invented personal owner',bool(r.get('attribution')) and (r['attribution'].get('owner_user')==f.users['owner'] or r['attribution'].get('source')=='application'))
 check('native operation capabilities and real revision metadata present',all(isinstance(r.get(k),bool) for k in ['can_edit','can_download','can_structure','can_share']) and bool(r['modified']))
 check('native field write schema is subset of declared fields',set(r['input_schema']['properties'])<=set(x['id'] for x in r['fields']))
 check('native companion excluded from uploaded file directory to avoid duplicate entry',not any(x['name']==native for x in result(f.listing(f.clients['owner']))['rows']))
 v=view(native);check('native directory entry opens original source row without duplication',len(v['rows'])==1 and v['rows'][0]['row_id']==order['order'] and v['rows'][0]['values']['quantity']['value']==2)
 # Create an isolated resource normally, then model the historical missing record.
 legacy=f.upload('owner','legacy',{'level':'personal','owner_user':f.users['owner']})
 snapshot=con("a=frappe.get_doc('Shangshu Org Attribution',{'resource':%r})\nRESULT['snapshot']=a.as_dict()\nfrappe.delete_doc('Shangshu Org Attribution',a.name,ignore_permissions=True)\nfrappe.db.commit()"%legacy)['snapshot']
 r=row(legacy);print('LEGACY_DIRECTORY',json.dumps(r,ensure_ascii=False))
 check('legacy absence represented honestly without fabricated ownership',r['ownership'] is None and r['attribution'] is None)
 check('legacy owner directory capabilities match existing fallback',r['my_access']['read'] and r['my_access']['write'] and r['my_access']['structure'] and r['my_access']['download'])
 v=view(legacy);check('legacy directory entry opens original data',v['rows'][0]['values']['备注']['value']=='原值')
 act('files.sheet_cell_write',{'table':legacy,'row_id':v['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':'legacy-owner-write'},'expected_content_version':v['content_version'],'expected_structure_version':v['structure_version']})
 check('legacy existing owner write actually persists',view(legacy)['rows'][0]['values']['备注']['value']=='legacy-owner-write')
finally:
 if snapshot:
  restored=con("snapshot=%r\nassert not frappe.db.exists('Shangshu Org Attribution',{'resource':%r})\nfrappe.get_doc(snapshot).insert(ignore_permissions=True,set_name=snapshot['name'])\nfrappe.db.commit()\nRESULT['restored']=frappe.db.get_value('Shangshu Org Attribution',snapshot['name'],['resource','level','owner_user'],as_dict=True)"%(snapshot,legacy))
  f.check('controlled historical attribution restored exactly',restored['restored']=={k:snapshot[k] for k in ['resource','level','owner_user']})
 f.cleanup()
raise SystemExit(f.finish())
