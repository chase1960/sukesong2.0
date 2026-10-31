"""Actual Frappe identities -> BFF history/delete -> production SQLite namespace.
Synthetic messages are seeded directly; controlled-model continuation is tested in chat-routes.test.ts.
"""
import argparse,json,os,subprocess,urllib.request,uuid
from http.cookiejar import CookieJar
from test_process_provenance_live import fixture

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute-window',action='store_true');args=ap.parse_args()
 if not args.execute_window:ap.error('scheduled window required')
 fs=[];clients=[];keys=[];cid='ns'+uuid.uuid4().hex[:10];base=os.environ['SS_BASE']
 def db(mode):
  code="""import {getRuntimeStore} from './src/core/store.ts';let raw='';for await(const c of process.stdin)raw+=c;const x=JSON.parse(raw),s=getRuntimeStore();
if(x.mode==='seed')for(const [i,key] of x.keys.entries())await s.insert('execution','chat_messages',{conversation_id:key+':'+x.cid,role:'user',content:'SYNTH_NAMESPACE_'+i,created_at:new Date().toISOString()});
const rows=(await s.query('execution','chat_messages')).filter(r=>x.keys.some(k=>r.conversation_id===k+':'+x.cid));
if(x.mode==='cleanup')for(const r of rows)await s.delete('execution','chat_messages',r.id);
console.log(JSON.stringify(rows));"""
  p=subprocess.run(['docker','exec','-i','-w','/srv/shangshu/shangshu-server','shangshu-local-r967-node-1','./node_modules/.bin/tsx','--input-type=module','-e',code],input=json.dumps({'mode':mode,'keys':keys,'cid':cid}),capture_output=True,text=True,timeout=30)
  assert p.returncode==0,p.stderr[-600:];return json.loads(p.stdout.strip().splitlines()[-1])
 def http(op,path,data=None,method=None):
  with op.open(urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'},method=method),timeout=30) as r:return json.load(r)
 try:
  for i in range(2):
   f=fixture({'mode':'seed'});fs.append(f);op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()));clients.append(op)
   http(op,'/api/platform/login',{'username':f['user'],'password':f['password']});keys.append(http(op,'/api/platform/session')['collaboration_key'])
  assert len(set(keys))==2;assert len(db('seed'))==2
  def history(i):return [r for r in http(clients[i],'/api/chat/history')['list'] if cid in r['conversation_id']]
  for i in range(2):
   rows=history(i);assert len(rows)==1 and rows[0]['content']=='SYNTH_NAMESPACE_'+str(i),rows
  print('PASS actual Frappe identities same short cid: history exposes only own SQLite message',flush=True)
  # Complete foreign cid is normalized into caller namespace; never deletes foreign row.
  out=http(clients[1],'/api/chat/conversation/'+keys[0]+':'+cid,method='DELETE');assert out['deleted']==0,out
  assert len(db('read'))==2 and len(history(0))==1 and len(history(1))==1
  print('PASS foreign full cid delete zero affected; independent reopened SQLite keeps both rows',flush=True)
  out=http(clients[1],'/api/chat/conversation/'+cid,method='DELETE');assert out['deleted']==1,out
  rows=db('read');assert len(rows)==1 and rows[0]['conversation_id']==keys[0]+':'+cid
  assert history(1)==[] and len(history(0))==1
  print('PASS own short cid deletes only caller namespace; other actor history unchanged',flush=True)
 finally:
  if keys:db('cleanup')
  for f in fs:fixture({'mode':'cleanup','fixture':f,'mails':[]})
  print('CLEANUP exact synthetic SQLite messages removed; identities disabled',flush=True)
if __name__=='__main__':main()
