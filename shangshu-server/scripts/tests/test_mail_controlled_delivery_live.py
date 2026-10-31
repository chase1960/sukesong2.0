"""Explicit-window test: production queue/worker with process-local capture, no SMTP."""
import argparse,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ.setdefault('SS_ROOT',str(ROOT))
from test_organization_audit_live import console

def fixture(value):
 p=subprocess.run([sys.executable,str(Path(__file__).with_name('mail-default-identity-fixture.py'))],input=json.dumps(value),capture_output=True,text=True)
 if p.returncode:raise RuntimeError('fixture failed; sensitive output suppressed')
 return json.loads(p.stdout)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('requires explicitly scheduled --execute-window')
 f=fixture({'mode':'seed'});mails=[]
 try:
  source=fixture({'mode':'received','fixture':f});mails.append(source['mail'])
  # All interception lives only in this independent console interpreter. No worker
  # receives a queue job, no production process is patched, no real credentials read.
  code='''
import uuid
from shangshu_core.public_api import execute_registered_action
from shangshu_mail import account,delivery,transport
frappe.set_user(USER)
# Only this synthetic account: satisfy binding presence without creating credentials.
synthetic_account=account.account_name()
original_email_account=frappe.db.get_value('Shangshu Mail Account',synthetic_account,'email_account')
with account.writing():
 frappe.db.set_value('Shangshu Mail Account',synthetic_account,'email_account','controlled-no-credentials')
frappe.db.commit()
queued=[];captured=[];checks=[];created=[]
original_enqueue=frappe.enqueue
original_credentials=account.credentials
original_send=transport.send_message
try:
 frappe.enqueue=lambda method,**kw: queued.append((method,kw))
 account.credentials=lambda binding: ('synthetic@example.invalid','not-a-real-secret')
 for expected in ('Sent','Failed','Unknown'):
  draft=execute_registered_action('mail.save_draft',{'subject':'controlled '+expected,'body':'synthetic','to':['recipient@example.invalid'],'cc':[]},confirmed=True,idempotency_key=uuid.uuid4().hex)
  # Public action result is a receipt whose result contains the domain projection.
  draft=draft.get('result',draft);created.append(draft['name']);frappe.db.commit()
  before=len(captured)
  def capture(*a,**kw):
   captured.append(expected)
   return {'status':expected,'error':'' if expected=='Sent' else ('请在原邮箱核对，勿重复发送' if expected=='Unknown' else '连接前明确失败'),'rejected':[]}
  transport.send_message=capture
  receipt=execute_registered_action('mail.send',{'mail':draft['name'],'expected_version':draft['record_version']},confirmed=True,idempotency_key=uuid.uuid4().hex)
  frappe.db.commit()
  assert frappe.db.get_value('Shangshu Mail Message',draft['name'],'status')=='Queued'
  assert len(captured)==before
  checks.append(expected+' queued without transport in request')
  method,kw=queued[-1]
  assert method is delivery.process_send and kw['timeout']==300 and kw['enqueue_after_commit'] is True
  delivery.process_send(kw['name'],kw['user'])
  doc=frappe.get_doc('Shangshu Mail Message',draft['name'])
  assert doc.status==expected,(doc.status,doc.delivery_error)
  assert bool(doc.sent_at)==(expected=='Sent')
  if expected!='Sent':assert doc.delivery_error
  checks.append(expected+' worker persists truthful result')
  delivery.process_send(kw['name'],kw['user'])
  assert len(captured)==before+1
  checks.append(expected+' worker replay never retransmits')
  try:
   execute_registered_action('mail.send',{'mail':doc.name,'expected_version':doc.record_version},confirmed=True,idempotency_key=uuid.uuid4().hex)
  except Exception:
   frappe.db.rollback();frappe.clear_messages()
  else:raise AssertionError('ended send accepted again')
  assert len(captured)==before+1
  checks.append(expected+' repeat public send rejected')
finally:
 frappe.enqueue=original_enqueue;account.credentials=original_credentials;transport.send_message=original_send
 with account.writing():
  frappe.db.set_value('Shangshu Mail Account',synthetic_account,'email_account',original_email_account)
 frappe.db.commit()
 RESULT.update({'checks':checks,'mails':created,'captured':len(captured)})
'''
  import _ss_console
  result=_ss_console.run('USER='+repr(f['user'])+'\n'+code)
  if '__error__' in result:
   print('CONTROLLED_DIAGNOSTIC',result.get('__error__'),result.get('__trace__'),flush=True)
   raise RuntimeError('controlled worker assertion failed')
  mails.extend(result['mails'])
  for item in result['checks']:print('PASS',item,flush=True)
  assert len(result['checks'])==12 and result['captured']==3
  print('RESULT 12/12 controlled delivery; zero external SMTP')
 finally:
  # Collect only this exact actor's synthetic drafts even if console assertion failed
  # before returning the names. It is a fresh identity, never a user's mailbox.
  remaining=console("RESULT['mails']=frappe.get_all('Shangshu Mail Message',filters={'owner':%r},pluck='name')"%f['user'])
  mails=list(set(mails+remaining['mails']))
  fixture({'mode':'cleanup','fixture':f,'mails':mails})
  print('CLEANUP exact synthetic actor mail/account/identity/department')
if __name__=='__main__':main()
