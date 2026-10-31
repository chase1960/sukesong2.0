"""UI073 bounded real candidate pages; UI069 real key/payload/identity binding.
Controlled proposal fixture, no model, no execution of the 20,000 candidate cells.
"""
import argparse,base64,io,json,os,uuid
from test_proposal_field_projection_live import t,seed
from test_process_provenance_live import fixture,console

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');a=ap.parse_args()
 if not a.execute_window:ap.error('scheduled window required')
 import openpyxl
 fs=[];table=None;proposal=None;checks=[];clients=[]
 def check(label,v):assert v,label;checks.append(label);print('PASS '+label,flush=True)
 def good(r):
  st,b=r;assert st==200 and b.get('ok') is not False,(st,b);return b.get('result',b)
 def action(c,n,p,key=None):return c.request('POST','/api/platform/actions/'+n+'/execute',{'payload':p,'confirmed':True,'idempotency_key':key or uuid.uuid4().hex})
 def read(c,p):return good(t.service(c,'files.sheet_read',p))
 try:
  for _ in range(2):
   f=fixture({'mode':'seed'});fs.append(f);c=t.Client(os.environ['SS_BASE']);c.login(f['user'],f['password']);clients.append(c)
  owner,other=clients
  w=openpyxl.Workbook();ws=w.active;ws.append(['甲列','乙列'])
  for i in range(10000):ws.append(['old-a-'+str(i),'old-b-'+str(i)])
  buf=io.BytesIO();w.save(buf)
  table=good(action(owner,'files.upload',{'file_name':fs[0]['prefix']+'-candidate-scale.xlsx','content_base64':base64.b64encode(buf.getvalue()).decode(),'attribution':{'level':'personal','owner_user':fs[0]['user']}}))['file']
  good(action(owner,'platform.org.share_grant',{'resource':table,'user':fs[1]['user'],'access':'edit'}))
  snapshot=read(owner,{'table':table,'page_length':500});rid=snapshot['rows'][0]['row_id']
  payload={'table':table,'expected_content_version':int(snapshot['content_version']),'expected_structure_version':int(snapshot['structure_version']),'cells':[{'row_id':rid,'header':'甲列','value':{'type':'text','value':'formal-once'}}]};key=uuid.uuid4().hex
  first=good(action(owner,'files.sheet_cells_write',payload,key));after=read(owner,{'table':table,'page_length':500})
  replay=good(action(owner,'files.sheet_cells_write',payload,key));check('same key and payload replays original result',replay==first)
  changed=json.loads(json.dumps(payload));changed['cells'][0]['value']['value']='must-not-write'
  st,b=action(owner,'files.sheet_cells_write',changed,key);check('same key with different business payload rejected',st>=400 and any(s in json.dumps(b,ensure_ascii=False) for s in ['业务内容已变化']))
  check('other identity really has read access',read(other,{'table':table,'page_length':1})['rows'][0]['row_id']==rid)
  st,b=action(other,'files.sheet_cells_write',payload,key);check('cross identity cannot reuse successful key',st>=400 and '身份' in json.dumps(b,ensure_ascii=False))
  stable=read(owner,{'table':table,'page_length':500});check('binding rejections preserve formal values and version',stable['rows']==after['rows'] and stable['content_version']==after['content_version'])
  historical_key=uuid.uuid4().hex
  old=console('USER='+repr(fs[0]['user'])+'\nPAYLOAD='+repr(payload)+'\nKEY='+repr(historical_key)+'\n'+'''from shangshu_core import action_requests
from shangshu_core.public_api import get_identity
from shangshu_core.actions import _definition
frappe.set_user(USER)
request,created=action_requests.reserve(KEY,get_identity(),'files.sheet_cells_write','0.0.1',PAYLOAD)
assert created
action_requests.fail(request,'controlled historical request version fixture; no handler ran')
frappe.db.commit();RESULT.update({'request':request.name,'current':_definition('files.sheet_cells_write').action_version})
''')
  st,b=action(owner,'files.sheet_cells_write',payload,historical_key);message=json.dumps(b,ensure_ascii=False)
  print('VERSION DIAGNOSTIC RAW',st,old,message,flush=True)
  check('unregistered historical pin fails closed without claiming mixed-version diagnosis',st==404 and '动作未注册或已停用' in message)
  print('VERSION DIAGNOSTIC',message,flush=True)
  unchanged=read(owner,{'table':table,'page_length':500});check('old request diagnostic has no business write',unchanged['rows']==stable['rows'] and unchanged['content_version']==stable['content_version'])
  rows=[]
  for page in range(1,21):rows.extend(read(owner,{'table':table,'page':page,'page_length':500})['rows'])
  assert len(rows)==10000
  cells=[{'row_id':row['row_id'],'header':header,'value':{'type':'text','value':'candidate-'+str(i)+'-'+header}} for i,row in enumerate(rows) for header in ['甲列','乙列']]
  candidate={'table':table,'expected_content_version':int(stable['content_version']),'expected_structure_version':int(stable['structure_version']),'cells':cells}
  result=console('USER='+repr(fs[0]['user'])+'\nPAYLOAD='+repr(candidate)+'\nKEY='+repr(uuid.uuid4().hex)+'\n'+"from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(USER)\np=propose_registered_action('files.sheet_cells_write',PAYLOAD,idempotency_key=KEY)\nfrappe.db.commit();RESULT['proposal']=p['id']")
  proposal=result['proposal']
  head=good(owner.request('GET','/api/platform/action-proposal-get/'+proposal));encoded=json.dumps(head).encode()
  check('20k candidate availability header omits payload with bounded body',head['payload'] is None and head['payload_omitted'] and len(encoded)<10000)
  check('20k candidate header reports true remaining count',head['remaining']==20000)
  listing=good(owner.request('GET','/api/platform/action-proposals?status=Proposed&limit=200'));items=listing.get('items',listing.get('list',[]));entry=next(v for v in items if v['id']==proposal)
  check('large candidate list omits full payload',entry['payload'] is None and entry['payload_omitted'])
  for offset,limit in [(0,1000),(10000,200),(19999,200)]:
   page=good(owner.request('GET',f'/api/platform/action-proposals/{proposal}/units?offset={offset}&limit={limit}'));expected=cells[offset:offset+min(limit,200)]
   check('bounded accurate units page '+str(offset),page['total']==20000 and len(page['items'])==len(expected) and all(v['target']['row_id']==e['row_id'] and v['target']['header']==e['header'] and v['value']==e['value'] for v,e in zip(page['items'],expected)))
   print('PAGE',offset,'bytes',len(json.dumps(page).encode()),'items',len(page['items']),flush=True)
  unchanged=read(owner,{'table':table,'page_length':500});check('20k candidates do not change formal table/version',unchanged['rows']==stable['rows'] and unchanged['content_version']==stable['content_version'])
  print('RESULT %d/%d'%(len(checks),len(checks)),flush=True)
 finally:
  if proposal:clients[0].request('POST','/api/platform/action-proposals/'+proposal+'/resolve',{'decision':'rejected'})
  if table:
   good(action(clients[0],'files.recycle',{'file':table}));state=console("RESULT['status']=frappe.db.get_value('Shangshu File Center File',%r,'status')"%table);assert state['status']=='Recycled';print('CLEANUP table',table,'Recycled independently verified',flush=True)
  for f in fs:fixture({'mode':'cleanup','fixture':f,'mails':[]})
  print('CLEANUP exact synthetic identities disabled, audit retained',flush=True)
if __name__=='__main__':main()
