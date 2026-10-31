"""UI039/094: real HTTP/current ACL; controlled proposal and legacy-original fixtures.
No model, no execution of candidate writes. Requires exclusive scheduled QA window.
"""
import argparse, copy, importlib.util, json, os, uuid
from pathlib import Path
from test_process_provenance_live import fixture, console
ROOT=Path(__file__).resolve().parents[3]
os.environ.setdefault('SS_ROOT',str(ROOT))
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
t=load('structure','shangshu-server/scripts/test-n2-structure.py')
seed=load('seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('cred','shangshu-server/scripts/tests/_ss_cred.py')

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('exclusive scheduled window required')
 base=os.environ['SS_BASE'];run=uuid.uuid4().hex[:12];checks=[];fs=[];handle=None;proposals=[]
 admin=t.Client(base);admin.login('Administrator',cred.admin_pw_for(base))
 def good(result):
  st,b=result;assert st==200 and b.get('ok') is not False,(st,b);return seed._result(st,b)
 def check(label,ok):
  assert ok,label;checks.append(label);print('PASS '+label,flush=True)
 def get(c,path):return good(c.request('GET',path))
 def action(c,name,p):return good(t.action(c,name,p,'projection-'+uuid.uuid4().hex))
 def detail(c,p):
  head=get(c,'/api/platform/action-proposal-get/'+p)
  assert head['payload'] is None and head['original_payload'] is None
  return next(x for x in listed(c,'Rejected' if p==proposals[-1] else 'Proposed') if x['id']==p)
 def count(c):return get(c,'/api/platform/action-proposal-summary')['counts']
 def listed(c,status='Proposed'):
  b=get(c,'/api/platform/action-proposals?status='+status+'&limit=200');return b.get('items',b.get('list',[]))
 def ids(c,status='Proposed'):return {x['id'] for x in listed(c,status)}
 try:
  for _ in range(2):fs.append(fixture({'mode':'seed'}))
  clients=[]
  for f in fs:
   c=t.Client(base);c.login(f['user'],f['password']);clients.append(c)
  actor,reader=clients
  handle=seed.seed_mixed_table(admin,run=run,attribution={'level':'personal','owner_user':'Administrator'})
  table=handle['table']
  for f in fs:action(admin,'platform.org.share_grant',{'resource':table,'user':f['user'],'access':'edit'})
  sheet=good(t.service(actor,'files.sheet_read',{'table':table}));row=sheet['rows'][0]['row_id']
  secret='HIDDEN-CANDIDATE-'+run;oldsecret='HIDDEN-ORIGINAL-'+run;visible='VISIBLE-'+run
  payload={'table':table,'cells':[{'row_id':row,'header':'项目名称','value':{'type':'text','value':secret}},{'row_id':row,'header':'备注','value':{'type':'text','value':visible}}], 'expected_content_version':int(sheet['content_version']),'expected_structure_version':int(sheet['structure_version'])}
  baseline=count(actor);readerbaseline=count(reader)
  # Public proposal creation; only legacy original snapshot is controlled persisted input.
  result=console('USER='+repr(fs[0]['user'])+'\nPAYLOAD='+repr(payload)+'\nKEY='+repr(run)+'\nOLD='+repr(oldsecret)+'\n'+'''
import copy,json
from shangshu_core.public_api import propose_registered_action
frappe.set_user(USER)
ids=[]
for i in range(3):
 p=copy.deepcopy(PAYLOAD)
 if i==1:p['cells']=p['cells'][:1]
 proposal=propose_registered_action('files.sheet_cells_write',p,idempotency_key=KEY+str(i))
 ids.append(proposal['id'])
 # Existing persisted legacy original shape, not a claim current review creates it.
 original=copy.deepcopy(p);original['cells'][0]['value']['value']=OLD
 frappe.db.set_value('Shangshu Action Proposal',proposal['id'],{'original_payload_json':json.dumps(original),'edited_value_json':json.dumps({'synthetic_secret':OLD})})
frappe.db.commit();RESULT['ids']=ids
''');proposals=result['ids'];mixed,hidden,history=proposals
  good(admin.request('POST',f'/api/platform/action-proposals/{history}/resolve',{'decision':'rejected'}))
  check('before field restriction actor sees both mixed cells',len(detail(actor,mixed)['payload']['cells'])==2)
  before=count(actor)
  check('created two pending and one historical candidate visible',before['Proposed']==baseline['Proposed']+2 and before['Rejected']==baseline['Rejected']+1)
  def acl(hide):
   current=good(t.service(admin,'files.sheet_read',{'table':table}));columns=copy.deepcopy(seed.MIXED_COLUMNS)
   if hide:columns[0].update(read_roles=['System Manager'],write_roles=['System Manager'],download_roles=['System Manager'])
   action(admin,'files.promotion_define',{'table':table,'expected_structure_version':int(current['structure_version']),'definition':{'definition_version':1,'columns':columns}})
  acl(True)
  for p in (mixed,history):
   data=detail(actor,p);serialized=json.dumps(data,ensure_ascii=False)
   head=get(actor,'/api/platform/action-proposal-get/'+p)
   check('availability header omits payload and secrets '+p,head['payload'] is None and head['original_payload'] is None and all(s not in json.dumps(head,ensure_ascii=False) for s in (secret,oldsecret,'项目名称')))
   check('current ACL removes secret/header from detail including summary/original '+p,all(s not in serialized for s in (secret,oldsecret,'项目名称')))
   check('visible payload and legacy original survive '+p,len(data['payload']['cells'])==1 and len(data['original_payload']['cells'])==1 and data['edited_value'] is None)
   full=detail(admin,p)
   check('administrator retains original and candidate evidence '+p,secret in json.dumps(full,ensure_ascii=False) and oldsecret in json.dumps(full,ensure_ascii=False))
   units=get(actor,f'/api/platform/action-proposals/{p}/units?offset=0&limit=1')
   check('units count and page contain only readable candidate '+p,units['total']==1 and len(units['items'])==1 and secret not in json.dumps(units) and units['items'][0]['target']['header']=='备注')
   review=get(actor,f'/api/platform/action-proposals/{p}/review')
   check('review units are projected with current field ACL '+p,len(review['units'])==1 and secret not in json.dumps(review))
  for path in [f'/api/platform/action-proposal-get/{hidden}',f'/api/platform/action-proposals/{hidden}/review',f'/api/platform/action-proposals/{hidden}/units']:
   st,b=actor.request('GET',path);check('fully hidden candidate denied '+path,st==403 and secret not in json.dumps(b))
  after=count(actor)
  check('summary counts exclude fully hidden only, retain readable historical',after['Proposed']==before['Proposed']-1 and after['Rejected']==before['Rejected'])
  check('pending list and summary agree',mixed in ids(actor) and hidden not in ids(actor))
  rows=[x for x in listed(actor) if x['id']==mixed]
  check('list summary has no hidden candidate/original',rows and all(s not in json.dumps(rows,ensure_ascii=False) for s in (secret,oldsecret,'项目名称')))
  check('unrelated reader has real table read permission',t.service(reader,'files.sheet_read',{'table':table})[0]==200)
  check('resource reader cannot infer candidate counts',count(reader)==readerbaseline)
  for p in proposals:
   st,b=reader.request('GET','/api/platform/action-proposal-get/'+p);check('unrelated reader denied candidate '+p,st==403 and secret not in json.dumps(b))
  acl(False)
  check('restored field permission restores both mixed cells in same session',len(detail(actor,mixed)['payload']['cells'])==2)
  check('restored field permission restores hidden proposal count',count(actor)==before)
  action(admin,'platform.org.share_revoke',{'resource':table,'user':fs[0]['user']})
  check('resource revocation removes pending and historical counts',count(actor)==baseline)
  for p in (mixed,history):
   for suffix in ('detail','review','units'):
    path='/api/platform/action-proposal-get/'+p if suffix=='detail' else f'/api/platform/action-proposals/{p}/{suffix}'
    st,b=actor.request('GET',path);check('old session rechecks resource for '+suffix+' '+p,st==403 and secret not in json.dumps(b))
  print('RESULT %d/%d'%(len(checks),len(checks)),flush=True)
 finally:
  for p in proposals:
   st,b=admin.request('POST',f'/api/platform/action-proposals/{p}/resolve',{'decision':'rejected'})
   if st!=200:print('CLEANUP proposal status',p,st,flush=True)
  try:
   if handle:
    action(admin,'files.recycle',{'file':handle['table']})
    state=console("RESULT['status']=frappe.db.get_value('Shangshu File Center File',%r,'status')"%handle['table'])
    assert state['status']=='Recycled',state
    print('CLEANUP exact table '+handle['table']+' independently verified Recycled; not hard deleted',flush=True)
  finally:
   for f in fs:fixture({'mode':'cleanup','fixture':f,'mails':[]})
   print('CLEANUP exact identities/mailboxes/departments disabled; proposals retained as audit',flush=True)
if __name__=='__main__':main()
