"""Exact synthetic fixtures; credentials returned only to bridge process."""
import json,sys,secrets,uuid,os
os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
from test_organization_audit_live import console
r=json.load(sys.stdin)
if r['mode']=='seed':
 p='assignbridge'+uuid.uuid4().hex[:10];pw=secrets.token_urlsafe(24);users={k:p+'-'+k+'@example.invalid' for k in ('old','new','head')}
 data=console('''
from shangshu_core.public_api import execute_registered_action,get_identity
users=%r
seq=0
def act(a,p):
 global seq
 seq+=1
 return execute_registered_action(a,p,confirmed=True,idempotency_key=%r+str(seq))['result']
for role,user in users.items():act('platform.identity.create',{'email':user,'display_name':%r+' '+role,'initial_password':%r,'role':'staff','collaboration_scope':'related'})
dep=act('platform.org.department_create',{'name':%r,'enterprise':get_identity().enterprise_id})['department']
for user in users.values():act('platform.org.member_assign',{'user':user,'department':dep})
act('platform.org.head_assign',{'user':users['head'],'department':dep})
frappe.db.commit()
RESULT['department']=dep
'''%(users,p,p,pw,p))
 print(json.dumps({**data,'users':users,'password':pw,'prefix':p}))
else:
 f=r['fixture'];out=console('''
from shangshu_core.public_api import execute_registered_action
for i,user in enumerate(%r):execute_registered_action('platform.identity.status',{'email':user,'enabled':False},confirmed=True,idempotency_key=%r+str(i))
execute_registered_action('platform.org.department_set_status',{'department':%r,'enabled':False},confirmed=True,idempotency_key=%r)
for file in %r:
 if frappe.db.exists('Shangshu File Center File',file):frappe.db.set_value('Shangshu File Center File',file,'status','Recycled')
frappe.db.commit()
RESULT['cleaned']=True
'''%(list(f['users'].values()),f['prefix']+'-clean-',f['department'],f['prefix']+'-dep-clean',r.get('files',[])))
 print(json.dumps(out))
