"""Synthetic real BFF tests; no external send, no process restarts or fault injection."""
import os,sys,json,uuid,secrets,base64,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];os.environ['SS_ROOT']=str(ROOT);os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
import _ss_console
def console(code):
 global seed
 result=_ss_console.run(code)
 if "__error__" in result:
  if result.get("department"): seed=result
  diagnostic=str(result.get("__trace__") or result["__error__"]).replace(PW,"[secret]")
  raise RuntimeError(diagnostic)
 return result
sp=importlib.util.spec_from_file_location('mail_http_client',ROOT/'shangshu-server/scripts/test-n2-structure.py');api=importlib.util.module_from_spec(sp);sp.loader.exec_module(api)
P='mailchain'+uuid.uuid4().hex[:10];PW=secrets.token_urlsafe(24);USERS={r:P+'-'+r+'@example.invalid' for r in ('a','b')};checks=[];seed={};drafts=[];files=[]
def check(label,condition):
 if not condition:raise AssertionError(label)
 checks.append(label);print('PASS '+label,flush=True)
def call(c,path,p=None):return c.request('POST' if p is not None else 'GET',path,p)
def good(response):
 st,d=response
 if st!=200 or d.get('ok') is False:raise AssertionError('API '+str(st)+' '+str(d.get('error') or d.get('code')))
 return d.get('result',d)
def action(c,id,p):return good(call(c,'/api/platform/actions/'+id+'/execute',{'payload':p,'confirmed':True,'idempotency_key':uuid.uuid4().hex}))
def service(c,id,p):return good(call(c,'/api/platform/services/'+id+'/invoke',{'payload':p}))
def detail(c,id):return service(c,'mail.detail',{'mail':id})['mail']
def listing(c):
 import urllib.parse
 return good(call(c,'/api/platform/datasets/mail.message/records?'+urllib.parse.urlencode({'filters':json.dumps({'mailbox':seed['box'],'scope':'inbox'}),'page':1,'page_length':50})))
print('FIXTURE '+P,flush=True)
try:
 seed=console('''
from shangshu_core.public_api import execute_registered_action,get_identity
from shangshu_mail import account,service,delivery
import json,base64
users=%r
seq=0
def act(a,p):
 global seq
 seq+=1
 return execute_registered_action(a,p,confirmed=True,idempotency_key=%r+str(seq))['result']
for r,u in users.items():act('platform.identity.create',{'email':u,'display_name':%r+' '+r,'initial_password':%r,'role':'staff','collaboration_scope':'related'})
dep=act('platform.org.department_create',{'name':%r,'enterprise':get_identity().enterprise_id})['department']
for u in users.values():act('platform.org.member_assign',{'user':u,'department':dep})
frappe.set_user(users['a'])
box=%r
with account.writing():frappe.get_doc({'doctype':'Shangshu Mail Account','account_key':box,'kind':'department','department':dep,'email_address':%r,'display_name':'合成部门箱','enabled':1,'connection_status':'connected'}).insert(ignore_permissions=True)
act('mail.mailbox.grant',{'mailbox':box,'user':users['b'],'rights':{'read':True,'edit_draft':True,'send':False,'manage':False,'signature':False}})
RESULT.update({'department':dep,'box':box,'mails':{},'attachments':{}})
for kind,home in [('shared',box),('personal',account.account_name(users['a']))]:
 with service.writing():
  m=frappe.get_doc({'doctype':'Shangshu Mail Message','status':'Received','subject':%r+' '+kind,'body':'<p>原始来信</p>','body_format':'HTML','to_json':'[]','cc_json':'[]','from_address':'synthetic@example.invalid','record_version':1,'mailbox_id':home,'received_at':frappe.utils.now_datetime()}).insert(ignore_permissions=True)
  f=frappe.get_doc({'doctype':'File','file_name':%r+'-'+kind+'.txt','is_private':1,'attached_to_doctype':'Shangshu Mail Message','attached_to_name':m.name,'content':b'fixed-version-one'}).insert(ignore_permissions=True)
 RESULT['mails'][kind]=m.name;RESULT['attachments'][kind]=f.name
frappe.db.commit()
RESULT['imports']={}
for kind in ('shared','personal'):RESULT['imports'][kind]=delivery.import_mail_attachments(RESULT['mails'][kind],users['a'],[RESULT['attachments'][kind]])
RESULT['centers']={kind:result['attachments'][0].get('file_center') for kind,result in RESULT['imports'].items()}
RESULT['again']=delivery.import_mail_attachments(RESULT['mails']['shared'],users['b'],[RESULT['attachments']['shared']])
frappe.db.commit()
'''%(USERS,P,P,PW,P,P+'-box',P+'@example.invalid',P,P))
 print('IMPORT_RESULTS',json.dumps(seed['imports'],ensure_ascii=False),flush=True)
 files=[x for x in seed['centers'].values() if x]
 check('personal attachment imported through managed worker path',seed['imports']['personal']['attachments'][0]['status']=='imported')
 if seed['centers']['shared']:
  check('shared attachment imported through managed worker path',not seed['imports']['shared']['failed'])
  check('second authorized member import deduplicates',seed['again']['attachments'][0]['status']=='already' and not seed['again']['failed'])
 else:raise AssertionError('shared attachment import failed')
 a=api.Client(os.environ['SS_BASE']);a.login(USERS['a'],PW);b=api.Client(os.environ['SS_BASE']);b.login(USERS['b'],PW)
 for kind,center in seed['centers'].items():
  if not center:continue
  rec=service(a,'files.versions',{'file':center})['file'];check(kind+' attachment owner/link',rec['related_mail']==seed['mails'][kind] and rec['owner_subject_kind']==('Department' if kind=='shared' else 'Employee') and (kind!='shared' or rec['owner_subject']==seed['department']))
 x,y=listing(a),listing(b);check('both users initially unread and department unread',x['unread_counts']=={'mine':1,'dept':1} and y['unread_counts']=={'mine':1,'dept':1})
 mail=seed['mails']['shared'];v=detail(a,mail)['record_version'];check('reading detail alone does not consume personal or department points',listing(a)['unread_counts']=={'mine':1,'dept':1})
 action(a,'mail.set_read',{'mail':mail,'expected_version':v,'read':True});x,y=listing(a),listing(b);check('first read only clears own point and department point',x['unread_counts']=={'mine':0,'dept':0} and y['unread_counts']=={'mine':1,'dept':0});check('read state does not bump content version',detail(b,mail)['record_version']==v)
 action(b,'mail.set_read',{'mail':mail,'expected_version':v,'read':True});check('second reader clears own without recounting department',listing(b)['unread_counts']=={'mine':0,'dept':0})
 action(b,'mail.set_read',{'mail':mail,'expected_version':v,'read':False});check('mark personal unread does not resurrect department point',listing(b)['unread_counts']=={'mine':1,'dept':0})
 payload={'subject':P+' shared draft','body':'<p>version one</p>','body_format':'HTML','to':[],'cc':[],'mailbox':seed['box']};d=action(a,'mail.save_draft',payload);drafts.append(d['name']);before=detail(b,d['name']);updated=action(a,'mail.save_draft',{**payload,'mail':d['name'],'expected_version':d['record_version'],'body':'<p>first writer wins</p>'});st,fail=call(b,'/api/platform/actions/mail.save_draft/execute',{'payload':{**payload,'mail':d['name'],'expected_version':before['record_version'],'body':'must not overwrite'},'confirmed':True,'idempotency_key':uuid.uuid4().hex});check('second writer stale draft rejected and first value retained',st>=400 and detail(b,d['name'])['body']=='<p>first writer wins</p>')
 # Fixed source version attached to a personal draft, later file version changes.
 center=seed['centers']['personal'];vers=service(a,'files.versions',{'file':center});oldfile=vers['current']['frappe_file'];snap=action(a,'mail.save_draft',{'subject':P+' fixed','body':'fixed','to':[],'cc':[],'attachments':[oldfile]});drafts.append(snap['name']);old_att=detail(a,snap['name'])['attachments'][0]['file'];action(a,'files.new_version',{'file':center,'content_base64':base64.b64encode(b'version-two-different').decode()});check('saved mail attachment fixed after source version update',detail(a,snap['name'])['attachments'][0]['file']==old_att and service(a,'files.versions',{'file':center})['current']['frappe_file']!=oldfile)
 # Signature CID via actual API; source image is a normal uploaded file.
 png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=')
 upload=action(a,'files.upload',{'file_name':P+'.png','content_base64':base64.b64encode(png).decode(),'attribution':{'level':'personal','owner_user':USERS['a']}});imagefile=upload['file'];files.append(imagefile);image=service(a,'files.versions',{'file':imagefile})['current']['frappe_file'];cid=P+'@cid.invalid'
 html='<p>签名</p><table><tr><td colspan="2">表格合并</td></tr></table><img src="cid:'+cid+'">';resource={'content_id':cid,'file':image,'mime_type':'image/png','name':'logo.png'}
 action(a,'mail.account.signature',{'mailbox':seed['box'],'enabled':True,'html':html,'resources':[resource]});boxes=service(a,'mail.mailboxes',{})['mailboxes'];sig=next(x['signature'] for x in boxes if x['id']==seed['box']);check('signature CID and resources persist through real API',cid in sig['html'] and sig['resources'][0]['file']==image)
 signed=action(a,'mail.save_draft',{'subject':P+' signature','body':sig['html'],'body_format':'HTML','to':['synthetic@example.invalid'],'cc':[],'mailbox':seed['box'],'inline_resources':sig['resources']});drafts.append(signed['name']);read=detail(b,signed['name']);check('shared draft reopens CID with bound resource',cid in read['body'] and read['inline_resources'][0]['content_id']==cid)
 mime=console('''
from shangshu_mail import transport
import json,hashlib
from email import policy
from email.parser import BytesParser
from unittest.mock import patch
frappe.set_user(%r)
doc=frappe.get_doc('Shangshu Mail Message',%r)
inline=[]
for item in json.loads(doc.inline_resources_json or '[]'):
 file=frappe.get_doc('File',item['file']);inline.append({**item,'content':file.get_content()})
captured=[]
class Capture:
 def send_message(self,message,**kwargs):captured.append(message.as_bytes());return {}
with patch.object(transport,'smtp_session',return_value=Capture()):
 result=transport.send_message('synthetic@qq.com','never-used','合成',{'subject':doc.subject,'body':doc.body,'body_format':doc.body_format,'to':['synthetic@example.invalid'],'cc':[],'message_id':'<offline@invalid>'},[],inline_resources=inline)
raw=captured[0];parsed=BytesParser(policy=policy.default).parsebytes(raw)
html=next(p.get_content() for p in parsed.walk() if p.get_content_type()=='text/html')
images=[p for p in parsed.walk() if p.get_content_maintype()=='image']
RESULT.update({'captured':len(captured),'has_table':'colspan="2"' in html,'cid':images[0]['Content-ID'].strip('<>'),'image_sha':hashlib.sha256(images[0].get_payload(decode=True)).hexdigest(),'db_status':doc.status,'plain':any(p.get_content_type()=='text/plain' for p in parsed.walk())})
'''%(USERS['a'],signed['name']))
 import hashlib
 check('offline production MIME preserves table/CID/image bytes and plain alternative',mime['captured']==1 and mime['has_table'] and mime['cid']==cid and mime['image_sha']==hashlib.sha256(png).hexdigest() and mime['plain'] and mime['db_status']=='Draft')
 # Revocation checked against original mail reference, not stale client grants.
 action(a,'mail.mailbox.revoke',{'mailbox':seed['box'],'user':USERS['b']});st,_=call(b,'/api/platform/services/mail.detail/invoke',{'payload':{'mail':mail}});check('revoked shared mail detail denied',st==403)
 for target in (seed['box'],P+'-missing'):
  st,_=call(b,'/api/platform/actions/mail.sync/execute',{'payload':{'mailbox_id':target},'confirmed':True,'idempotency_key':uuid.uuid4().hex});check('sync denies explicit revoked/missing target '+target,st==403)
 import urllib.parse
 path='/api/platform/file-content?'+urllib.parse.urlencode({'ref':'Shangshu Mail Message','ref_name':mail,'file':seed['attachments']['shared']});st,_=call(b,path);check('old attachment URL denied after mailbox revoke',st==403)
 print('RESULT',len(checks),'/',len(checks),'prefix',P,flush=True)
finally:
 if seed:
  cleanup=console('''
from shangshu_core.public_api import execute_registered_action
from shangshu_mail import account
frappe.set_user(%r)
for i,name in enumerate(%r):
 if frappe.db.exists('Shangshu Mail Message',name):execute_registered_action('mail.recycle',{'mail':name,'expected_version':frappe.db.get_value('Shangshu Mail Message',name,'record_version')},confirmed=True,idempotency_key=%r+str(i))
frappe.set_user('Administrator')
for file in %r:
 if file and frappe.db.exists('Shangshu File Center File',file):frappe.db.set_value('Shangshu File Center File',file,'status','Recycled')
with account.writing():frappe.db.set_value('Shangshu Mail Account',%r,'enabled',0)
for i,user in enumerate(%r):execute_registered_action('platform.identity.status',{'email':user,'enabled':False},confirmed=True,idempotency_key=%r+str(i))
execute_registered_action('platform.org.department_set_status',{'department':%r,'enabled':False},confirmed=True,idempotency_key=%r)
frappe.db.commit()
RESULT['cleaned']=True
'''%(USERS['a'],list(seed.get('mails',{}).values())+drafts,P+'-cm-',files,seed['box'],list(USERS.values()),P+'-cu-',seed['department'],P+'-cd'))
  check('exact fixtures recycled/disabled and audit retained',cleanup.get('cleaned') is True)
