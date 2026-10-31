"""Isolated synthetic organization fixtures, actual Frappe HTTP log authorization.

Run only when the integration owner releases the QA write window. Creates new
unique users/departments, emits real registered-action audit rows, then removes
appointments/disables only these exact fixtures. Historical audit evidence stays.
"""
import json,os,secrets,sys,urllib.parse,urllib.request,urllib.error,http.cookiejar,uuid
os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
import _ss_console
from _ss_cred import admin_pw_for
BASE=os.environ.get('SS_FRAPPE_BASE','http://127.0.0.1:3851')
PREFIX='audit'+uuid.uuid4().hex[:10]
PASSWORD=secrets.token_urlsafe(24)
USERS={role:f'{PREFIX}-{role}@example.invalid' for role in ('boss','head','a','child','b','foreign')}
checks=[]
def check(label,condition,detail=''):
 print(('PASS ' if condition else 'FAIL ')+label+(' '+str(detail) if detail else ''))
 checks.append(bool(condition))
def console(code):
 result=_ss_console.run(code)
 if '__error__' in result:raise RuntimeError('fixture/administration failed; diagnostic retained in controlled console result')
 return result
class Client:
 def __init__(self,user):
  self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  status,body=self.call('login',{'usr':user,'pwd':PASSWORD},post=True)
  if status!=200:raise RuntimeError('synthetic login failed: '+str(status))
 def call(self,method,params=None,post=False):
  route='/api/method/'+(method if method=='login' else 'shangshu_core.public_api.http.'+method)
  raw=urllib.parse.urlencode(params or {}).encode()
  req=urllib.request.Request(BASE+route+('' if post else '?'+raw.decode()),data=raw if post else None,
       headers={'Host':'shangshu.localhost','Content-Type':'application/x-www-form-urlencoded'})
  try:
   with self.opener.open(req,timeout=30) as r:return r.status,json.loads(r.read())
  except urllib.error.HTTPError as e:
   body=e.read()
   try:body=json.loads(body)
   except ValueError:body={}
   return e.code,body
 def logs(self,filters=None,page=1,page_length=200):
  return self.call('action_audits',{'filters':json.dumps({'action_id':'files.action_fact',**(filters or {})}),'page':page,'page_length':page_length})
def main():
 seed=None
 try:
  seed=console('''
from shangshu_core.public_api import execute_registered_action
users=%r
RESULT['users']=users
RESULT['departments']=[]
seq=0
def act(a,p):
 global seq
 seq+=1
 return execute_registered_action(a,p,confirmed=True,idempotency_key=%r+'-'+str(seq))['result']
for role,email in users.items():
 act('platform.identity.create',{'email':email,'display_name':%r+' '+role,'initial_password':%r,'role':'staff','collaboration_scope':'related'})
 identity=frappe.db.get_value('Shangshu Identity',{'user':email},'name')
 # Only the cross-enterprise fixture has no product-facing enterprise switch.
 frappe.db.set_value('Shangshu Identity',identity,'enterprise_id',%r+('-other' if role=='foreign' else ''))
frappe.db.commit()
a=act('platform.org.department_create',{'name':%r+' A','enterprise':%r})['department'];RESULT['departments'].append(a)
child=act('platform.org.department_create',{'name':%r+' Child','enterprise':%r,'parent':a})['department'];RESULT['departments'].append(child)
b=act('platform.org.department_create',{'name':%r+' B','enterprise':%r})['department'];RESULT['departments'].append(b)
act('platform.org.owner_assign',{'user':users['boss'],'enterprise':%r})
act('platform.org.head_assign',{'user':users['head'],'department':a})
for role,dep in [('a',a),('child',child),('b',b)]:act('platform.org.member_assign',{'user':users[role],'department':dep})
RESULT['head_department']=a
frappe.db.commit()
RESULT['audits']={}
for role,email in users.items():
 frappe.set_user(email)
 RESULT['audits'][role]=[]
 for n in range(2 if role=='a' else 1):
  r=execute_registered_action('files.action_fact',{'op_id':%r+'-'+role+str(n),'action':'fixture.observe','target':%r},confirmed=True,idempotency_key=%r+'-event-'+role+str(n),source='user')
  RESULT['audits'][role].append(r['audit'])
 frappe.db.commit()
frappe.set_user('Administrator')
''' % (USERS,PREFIX,PREFIX,PASSWORD,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX,PREFIX))
  clients={role:Client(email) for role,email in USERS.items()}
  for role,total in [('boss',6),('head',4),('a',2),('b',1),('foreign',1)]:
   st,res=clients[role].logs();data=res.get('message',{})
   check(role+' scoped list/total',st==200 and data.get('total')==total,(st,data.get('total')))
  st,res=clients['head'].logs({'actor_user':USERS['child']});check('head reads child',st==200 and res.get('message',{}).get('total')==1)
  for role,target in [('head','b'),('a','child'),('boss','foreign')]:
   st,_=clients[role].logs({'actor_user':USERS[target]});check(role+' rejects '+target,st==403,st)
   st,_=clients[role].call('audit_actor',{'user':USERS[target]});check(role+' actor evidence rejects '+target,st==403,st)
  st,res=clients['boss'].logs(page=2,page_length=2);data=res.get('message',{})
  check('authorized paging count same set',st==200 and data.get('total')==6 and len(data.get('items',[]))==2 and data.get('has_more') is True)
  st,res=clients['head'].logs({'name':seed['audits']['b'][0]});check('forbidden exact audit not returned/count zero',st==200 and res.get('message',{}).get('total')==0)
  st,res=clients['a'].logs({'name':seed['audits']['a'][0]});item=(res.get('message',{}).get('items') or [{}])[0]
  check('own exact evidence exists/source honest',st==200 and item.get('source')=='user' and item.get('conversation_evidence',{}).get('status')=='not_linked')
  # Same real HTTP boundary for exact immutable request/audit recovery.
  st,res=clients['boss'].call('audit_trace',{'user':USERS['a'],'operation_id':seed['audits']['a'][0]})
  check('trace actual audit recovers original request',st==200 and res.get('message',{}).get('request_id')==PREFIX+'-event-a0')
  st,res=clients['a'].call('audit_trace',{'user':USERS['a'],'request_id':PREFIX+'-event-a0'})
  check('trace exact request recovers audit',st==200 and res.get('message',{}).get('operation_id')==seed['audits']['a'][0])
  st,_=clients['a'].call('audit_trace',{'user':USERS['a'],'operation_id':seed['audits']['b'][0]})
  check('trace another actor audit denied',st==403,st)
  st,_=clients['boss'].call('audit_trace',{'user':USERS['foreign'],'operation_id':seed['audits']['foreign'][0]})
  check('trace foreign enterprise denied',st==403,st)
  st,res=clients['a'].call('audit_trace',{'user':USERS['a'],'request_id':PREFIX+'-missing'})
  check('trace unknown does not fabricate link',st==200 and res.get('message',{}).get('status')=='not_linked')
  proposal=console("from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(%r)\np=propose_registered_action('files.create',%r,idempotency_key=%r)\nRESULT['proposal']=p['id']\nfrappe.db.commit()" % (USERS['a'],{'file_name':PREFIX+' pending.xlsx'},PREFIX+'-proposal'))
  st,res=clients['boss'].call('audit_trace',{'user':USERS['a'],'request_id':PREFIX+'-proposal'})
  check('trace pending proposal recovered without execution',st==200 and res.get('message',{}).get('proposal_id')==proposal['proposal'] and res.get('message',{}).get('operation_id') is None)
  st,res=clients['boss'].call('audit_proposal',{'user':USERS['a'],'proposal_id':proposal['proposal']})
  check('audit proposal read gives no confirm or candidate',st==200 and res.get('message',{}).get('can_confirm') is False and res.get('message',{}).get('payload_included') is False)
  console("from shangshu_core.public_api import execute_registered_action\nexecute_registered_action('platform.org.head_remove',%r,confirmed=True,idempotency_key=%r)\nfrappe.db.commit()" % ({'user':USERS['head'],'department':seed['head_department']},PREFIX+'-revoke'))
  st,_=clients['head'].logs({'actor_user':USERS['child']});check('same session revoked appointment immediate reject',st==403,st)
  st,res=clients['head'].logs();check('revoked head retains own evidence',st==200 and res.get('message',{}).get('total')==1)
  st,res=clients['boss'].logs({'name':seed['audits']['a'][0]})
  old=(res.get('message',{}).get('items') or [{}])[0].get('result_summary',{}).get('identity',{})
  expected=[{'id':seed['head_department'],'title':PREFIX+' A'}]
  check('fact records authenticated original department ID and title',st==200 and old.get('departments')==expected)
  console("from shangshu_core.public_api import execute_registered_action\nexecute_registered_action('platform.org.department_rename',%r,confirmed=True,idempotency_key=%r)\nexecute_registered_action('platform.org.member_remove',%r,confirmed=True,idempotency_key=%r)\nfrappe.db.commit()" % ({'department':seed['head_department'],'name':PREFIX+' renamed'},PREFIX+'-rename',{'user':USERS['a'],'department':seed['head_department']},PREFIX+'-move'))
  st,res=clients['boss'].logs({'name':seed['audits']['a'][0]})
  later=(res.get('message',{}).get('items') or [{}])[0].get('result_summary',{}).get('identity',{})
  check('historical audit keeps old department after rename and member removal',st==200 and later==old)
  st,res=clients['boss'].call('action_execute',{'action_id':'files.action_fact_query','payload':json.dumps({'op_id':PREFIX+'-a0'}),'confirmed':1,'idempotency_key':PREFIX+'-fact-query'},post=True)
  facts=res.get('message',{}).get('result',{}).get('facts',[])
  check('fact query projects persisted snapshot through actual HTTP',st==200 and len(facts)==1 and facts[0].get('identity')==old,(st,len(facts)))

 finally:
  # Exact run identities only; no prefix deletion or unrelated user cleanup.
  result=_ss_console.run('''
from shangshu_core.public_api import execute_registered_action
for n,email in enumerate(%r):
 if frappe.db.exists('User',email):
  execute_registered_action('platform.identity.status',{'email':email,'enabled':False},confirmed=True,idempotency_key=%r+str(n))
for dep in %r:
 execute_registered_action('platform.org.department_set_status',{'department':dep,'enabled':False},confirmed=True,idempotency_key=%r+dep)
frappe.db.commit()
RESULT['disabled_exact_fixture_users']=True
''' % (list(USERS.values()),PREFIX+'-cleanup-user-',(seed or {}).get('departments',[]),PREFIX+'-cleanup-dept-'))
  check('exact fixture users/departments disabled',result.get('disabled_exact_fixture_users') is True)
 print('FIXTURE',json.dumps({'prefix':PREFIX,'users':USERS,'departments':(seed or {}).get('departments',[])},ensure_ascii=False))
 print('RESULT',sum(checks),'/',len(checks))
 return 0 if checks and all(checks) else 1
if __name__=='__main__':sys.exit(main())
