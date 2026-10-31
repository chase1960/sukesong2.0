"""Scheduled-window crash test; kills only its own Node child, never live servers."""
import argparse,json,os,selectors,signal,subprocess,sys,tempfile,uuid
from pathlib import Path
from test_mail_controlled_delivery_live import fixture
from test_organization_audit_live import console
ROOT=Path(__file__).resolve().parents[3]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('requires scheduled --execute-window')
 assert os.environ.get('SS_CONTAINER')=='shangshu-local-r967-frappe-1'
 assert os.environ.get('SS_BASE')=='http://127.0.0.1:3850'
 f=fixture({'mode':'seed'});child=None;proposal=None;request=uuid.uuid4().hex
 try:
  with tempfile.TemporaryDirectory(prefix='ss-audit-crash-') as folder:
   config={'base':'http://127.0.0.1:3851','user':f['user'],'password':f['password'],'store':str(Path(folder)/'journal.sqlite'),'request':request,'mode':'propose'}
   # Direct node PID, no shell or npx wrapper; kill target is unambiguous.
   command=['node','--import','tsx',str(Path(__file__).with_name('chat-audit-crash-worker.ts'))]
   child=subprocess.Popen(command,cwd=ROOT/'shangshu-server',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   child.stdin.write(json.dumps(config));child.stdin.close()
   with selectors.DefaultSelector() as selector:
    selector.register(child.stdout,selectors.EVENT_READ)
    assert selector.select(45),'isolated child did not reach persisted boundary'
    line=child.stdout.readline();ready=json.loads(line);assert ready['ready'];proposal=ready['proposal']
   os.kill(child.pid,signal.SIGKILL);child.wait(timeout=10);assert child.returncode==-signal.SIGKILL
   print('PASS exact child SIGKILL after local request + core proposal commit and before local link',flush=True)
   recovered=subprocess.run(command,cwd=ROOT/'shangshu-server',input=json.dumps({**config,'mode':'recover','proposal':proposal}),capture_output=True,text=True,timeout=45)
   assert recovered.returncode==0,'recovery child failed; inspect controlled stderr without credentials'
   result=json.loads(recovered.stdout.strip().splitlines()[-1]);assert result['recovered'] and result['sources']==1
   print('PASS new process recovers actual core proposal from persisted SQLite; repeated read leaves one link and one request',flush=True)
 finally:
  if child and child.poll() is None:child.kill();child.wait(timeout=10)
  # Exact request id also finds a committed proposal if the child died before READY.
  result=console("RESULT['ids']=frappe.get_all('Shangshu Action Proposal',filters={'idempotency_key':%r},pluck='name')"%request)
  console("from shangshu_core.public_api import resolve_action_proposal\nfrappe.set_user(%r)\nfor p in %r:\n resolve_action_proposal(p,'rejected')\nfrappe.db.commit()"%(f['user'],result['ids']))
  # Rejected proposal remains immutable history.
  fixture({'mode':'cleanup','fixture':f,'mails':[]})
  print('CLEANUP temporary SQLite removed and exact synthetic identity disabled; proposal history retained',flush=True)
if __name__=='__main__':main()
