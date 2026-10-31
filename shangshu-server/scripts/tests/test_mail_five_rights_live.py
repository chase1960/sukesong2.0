"""UI059 five explicit mailbox rights, real HTTP and controlled send boundary."""
import argparse,json,os,uuid,urllib.request,urllib.error
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture,console
RIGHTS=['read','edit_draft','send','manage','signature']
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled window required')
 fs=[];mails=[];checks=[];base=os.environ['SS_BASE']
 def client(f):
  op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));request(op,'/api/platform/login',{'username':f['user'],'password':f['password']});return op
 def request(op,path,data=None):
  try:
   with op.open(urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'}),timeout=30) as r:return r.status,json.load(r)
  except urllib.error.HTTPError as e:return e.code,json.load(e)
 def good(r):
  status,d=r;assert status==200 and d.get('ok') is not False,(status,d);return d.get('result',d)
 def action(op,name,p):return request(op,'/api/platform/actions/'+name+'/execute',{'payload':p,'confirmed':True,'idempotency_key':uuid.uuid4().hex})
 def svc(op,name,p):return request(op,'/api/platform/services/'+name+'/invoke',{'payload':p})
 def check(label,ok):assert ok,label;checks.append(label);print('PASS',label,flush=True)
 try:
  owner=fixture({'mode':'seed'});fs.append(owner);guest=fixture({'mode':'seed'});fs.append(guest);a=client(owner);b=client(guest);box=owner['mailbox']
  draft=good(action(a,'mail.save_draft',{'mailbox':box,'subject':owner['prefix']+' rights','body':'original','to':['recipient@example.invalid'],'cc':[]}));mails.append(draft['name'])
  def grant(enabled):
   rights={r:r in enabled for r in RIGHTS};good(action(a,'mail.mailbox.grant',{'mailbox':box,'user':guest['user'],'rights':rights}))
   boxes=good(svc(a,'mail.mailboxes',{}))['mailboxes'];entry=next(x for x in boxes if x['id']==box)
   guest_boxes=good(svc(b,'mail.mailboxes',{}))['mailboxes'];listed=next((x for x in guest_boxes if x['id']==box),None)
   if 'read' in enabled:check('settings readback '+','.join(enabled),listed and listed['rights']==rights)
   else:check('zero-right grant readback has no enabled right or privileged settings',listed is not None and not any(listed['rights'].values()) and 'signature' not in listed and 'grantees' not in listed)
   return rights
  grant([]);check('read denied without grant',svc(b,'mail.detail',{'mail':draft['name']})[0]==403)
  for selected in ['read','edit_draft','signature','manage','send']:
   rights=grant(['read']+([] if selected=='read' else [selected]));current=good(svc(a,'mail.detail',{'mail':draft['name']}))['mail']
   check(selected+' profile can read',svc(b,'mail.detail',{'mail':draft['name']})[0]==200)
   edit=action(b,'mail.save_draft',{'mail':draft['name'],'expected_version':current['record_version'],'subject':current['subject'],'body':'edited-'+selected,'to':current['to'],'cc':[]})
   check(selected+' edit right independently enforced',edit[0]==(200 if selected=='edit_draft' else 403))
   sig=action(b,'mail.account.signature',{'mailbox':box,'enabled':True,'html':'<p>signature-'+selected+'</p>'})
   check(selected+' signature right independently enforced',sig[0]==(200 if selected=='signature' else 403))
   if selected=='signature':
    boxes=good(svc(a,'mail.mailboxes',{}))['mailboxes'];check('signature config persisted', 'signature-signature' in next(x for x in boxes if x['id']==box)['signature']['html'])
   manage=action(b,'mail.mailbox.grant',{'mailbox':box,'user':guest['user'],'rights':rights})
   check(selected+' manage right independently enforced',manage[0]==(200 if selected=='manage' else 403))
   current=good(svc(a,'mail.detail',{'mail':draft['name']}))['mail']
   if selected!='send':check(selected+' does not grant send',action(b,'mail.send',{'mail':draft['name'],'expected_version':current['record_version']})[0]==403)
   else:
    result=console('USER='+repr(guest['user'])+'\nBOX='+repr(box)+'\nMAIL='+repr(draft['name'])+'\n'+'''
import uuid
from shangshu_core.public_api import execute_registered_action
from shangshu_mail import account,delivery,transport
frappe.set_user(USER)
old=frappe.db.get_value('Shangshu Mail Account',BOX,'email_account')
with account.writing():frappe.db.set_value('Shangshu Mail Account',BOX,'email_account','controlled-no-credentials')
frappe.db.commit()
enqueue,credentials,send=frappe.enqueue,account.credentials,transport.send_message
queued=[];sent=[]
try:
 frappe.enqueue=lambda method,**kw:queued.append((method,kw))
 account.credentials=lambda binding:('synthetic@example.invalid','unused')
 transport.send_message=lambda *a,**kw:(sent.append(1) or {'status':'Failed','error':'controlled pre-transmission failure','rejected':[]})
 execute_registered_action('mail.send',{'mail':MAIL,'expected_version':frappe.db.get_value('Shangshu Mail Message',MAIL,'record_version')},confirmed=True,idempotency_key=uuid.uuid4().hex)
 frappe.db.commit()
 assert frappe.db.get_value('Shangshu Mail Message',MAIL,'status')=='Queued' and len(queued)==1 and not sent
 method,kw=queued[0];assert method is delivery.process_send
 delivery.process_send(kw['name'],kw['user'])
 assert frappe.db.get_value('Shangshu Mail Message',MAIL,'status')=='Failed' and len(sent)==1
 RESULT['controlled_send']=True
finally:
 frappe.enqueue=enqueue;account.credentials=credentials;transport.send_message=send
 with account.writing():frappe.db.set_value('Shangshu Mail Account',BOX,'email_account',old)
 frappe.db.commit()
''')
    check('send positive queues only with send right; captured worker zero external SMTP',result['controlled_send'])
  good(action(a,'mail.mailbox.revoke',{'mailbox':box,'user':guest['user']}));check('revocation immediately denies old authenticated session read',svc(b,'mail.detail',{'mail':draft['name']})[0]==403)
  print('RESULT',len(checks),'/',len(checks),flush=True)
 finally:
  if fs:
   fixture({'mode':'cleanup','fixture':fs[0],'mails':mails})
   for f in fs[1:]:fixture({'mode':'cleanup','fixture':f,'mails':[]})
  print('CLEANUP exact mail recycled and identities/mailboxes/departments disabled',flush=True)
if __name__=='__main__':main()
