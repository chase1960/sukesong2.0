import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
let server: Server, base: string;
let cookies: Record<string,string>;
async function request(user:string,path:string,body?:any,method='POST') {
  const response=await fetch(base+'/api/im/'+path,{method:body===undefined?'GET':method,headers:{cookie:cookies[user],'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
beforeEach(async()=>{
  process.env._SS_DATA_DIR=mkdtempSync(join(tmpdir(),'ss-im-office-'));
  const {localStore}=await import('../../src/core/store.ts');
  const {ensureBootstrap,createUser}=await import('../../src/core/auth/users.ts');
  await ensureBootstrap(localStore);
  for(const username of ['one','two'])await createUser(localStore,{username,password:'test-only-password',role:'staff',display_name:username});
  const {buildApp}=await import('../../src/adapters/web/server.ts');
  await new Promise<void>(r=>{server=buildApp().listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+(server.address() as any).port;r();});});
  cookies={};
  for(const username of ['one','two','admin']){
    const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:username==='admin'?'admin':'test-only-password'})});
    cookies[username]=response.headers.get('set-cookie')||'';
    assert.ok(cookies[username]);
  }
});
afterEach(()=>server?.close());
async function chat(){return (await request('one','chats',{type:'dm',peer_id:'two'})).body.id;}
async function messages(id:string){return (await request('one',`chats/${id}/messages`)).body.list;}

test('回复仅引用本会话，撤回后正文不从引用泄漏，读取不标已读',async()=>{
  const id=await chat();
  await request('one',`chats/${id}/messages`,{text:'报价原文',client_msg_id:'source'});
  const original=(await messages(id))[0];
  assert.equal((await request('two',`chats/${id}/messages`,{text:'收到并核对',reply_to:original.id})).status,200);
  let rows=await messages(id);assert.equal(rows[1].reply.id,original.id);assert.equal(rows[1].reply.text,'报价原文');
  const other=(await request('one','chats',{type:'dm',peer_id:'admin'})).body.id;
  assert.notEqual((await request('one',`chats/${other}/messages`,{text:'跨群引用',reply_to:original.id})).status,200);
  assert.equal((await messages(other)).length,0);
  assert.equal((await request('one',`chats/${id}/messages/${original.id}/recall`,{})).status,200);
  rows=await messages(id);assert.equal(rows[1].reply.recalled,true);assert.equal(rows[1].reply.text,'');
  assert.notEqual((await request('two',`chats/${id}/messages`,{text:'再引用',reply_to:original.id})).status,200);
  const own=(await request('one','chats')).body.list[0];assert.equal(own.unread,1);
  const {localStore}=await import('../../src/core/store.ts');
  const saved=await localStore.query('im','messages',{id:rows[1].id});
  assert.equal(saved[0].reply_to,original.id);assert.equal(saved[0].reply,undefined);
});

test('发送幂等键按本人隔离，异内容拒绝，并发重试只写一条',async()=>{
  const id=await chat(),path=`chats/${id}/messages`;
  const body={text:'原文',client_msg_id:'same'};
  const results=await Promise.all([request('one',path,body),request('one',path,body)]);
  assert.ok(results.every(r=>r.status===200));assert.equal((await messages(id)).length,1);
  assert.equal((await request('one',path,{...body,text:'另一条'})).status,409);
  assert.equal((await request('two',path,body)).status,200);assert.equal((await messages(id)).length,2);
  const source=(await messages(id))[0].id;
  assert.equal((await request('one',path,{...body,reply_to:source})).status,409);
});

test('置顶免打扰按本人持久化，其他成员不能代改，并发保留设置和审计',async()=>{
  const id=await chat();
  const patch=(user:string,preferences:any)=>request(user,`chats/${id}`,{preferences},'PATCH');
  const results=await Promise.all([patch('one',{pinned:true}),patch('one',{muted:true})]);
  assert.ok(results.every(r=>r.status===200));
  const own=(await request('one','chats')).body.list[0],other=(await request('two','chats')).body.list[0];
  assert.equal(own.pinned,true);assert.equal(own.muted,true);assert.equal(other.pinned,false);assert.equal(other.muted,false);
  assert.notEqual((await patch('admin',{pinned:true})).status,200);
  assert.notEqual((await patch('one',{muted:'false'})).status,200);
  assert.notEqual((await patch('one',{user_id:'two',pinned:true})).status,200);
  const {localStore}=await import('../../src/core/store.ts');
  assert.ok((await localStore.query('execution','events')).some(e=>e.capability==='im.preferences'&&e.status==='confirmed'));
});

test('归档私聊收到对方新消息重新出现；撤回不制造未读',async()=>{
  const id=await chat();
  await request('one',`chats/${id}`,{},'DELETE');
  await request('two',`chats/${id}/messages`,{text:'有新进展'});
  let list=(await request('one','chats')).body.list;assert.equal(list.length,1);assert.equal(list[0].unread,1);
  const msg=(await messages(id))[0];await request('two',`chats/${id}/messages/${msg.id}/recall`,{});
  list=(await request('one','chats')).body.list;assert.equal(list[0].unread,0);
});

test('@只对会话成员生效，引用成员变化时拒绝；扩展载荷参与幂等校验',async()=>{
 const id=await chat();const path=`chats/${id}/messages`;
 assert.equal((await request('one',path,{text:'请核对',mentions:['two'],client_msg_id:'mention1'})).status,200);
 assert.equal((await request('one',path,{text:'请核对',mentions:[],client_msg_id:'mention1'})).status,409);
 assert.equal((await request('one',path,{text:'越界',mentions:['admin']})).status,400);
 assert.equal((await request('two','chats')).body.list[0].mention_unread,1);
 assert.equal((await request('two',`chats/${id}/messages?page=1&mentioned=1`)).body.list.length,1);
 assert.notEqual((await request('one',path,{text:'非法文件',files:[{url:'https://bad.test'}]})).status,200);
});

test('明确转发创建目标副本、不转@，失权/撤回不允许新增，重试不重复',async()=>{
 const id=await chat(),target=(await request('two','chats',{type:'dm',peer_id:'admin'})).body.id;
 await request('one',`chats/${id}/messages`,{text:'原始公告',mentions:['two']});const m=(await messages(id))[0];
 const path=`chats/${id}/messages/${m.id}/forward`,body={target_chat_id:target,client_msg_id:'forward1',confirmed:true};
 assert.equal((await request('two',path,{...body,confirmed:false})).status,400);
 assert.equal((await request('one',path,body)).status,400);
 assert.equal((await request('two',path,body)).status,200);assert.equal((await request('two',path,body)).status,200);
 let rows=(await request('admin',`chats/${target}/messages`)).body.list;assert.equal(rows.length,1);assert.equal(rows[0].text,'原始公告');assert.equal(rows[0].forwarded,true);assert.deepEqual(rows[0].mentions,[]);
 await request('one',`chats/${id}/messages/${m.id}/recall`,{});
 assert.equal((await request('two',path,{...body,client_msg_id:'forward2'})).status,400);
 rows=(await request('admin',`chats/${target}/messages`)).body.list;assert.equal(rows[0].text,'原始公告');
});

test('固定文件引用经当前会话授权，撤权后拒绝新发送但已有回执仍幂等',async()=>{
 const id=await chat(),target=(await request('two','chats',{type:'dm',peer_id:'admin'})).body.id;
 const nativeFetch=globalThis.fetch,upstream=process.env.FRAPPE_UPSTREAM;let allowed=true,reads=0;
 process.env.FRAPPE_UPSTREAM='http://im-file-contract.invalid';
 globalThis.fetch=async(input:any,init?:any)=>{
  if(!String(input).startsWith(process.env.FRAPPE_UPSTREAM!))return nativeFetch(input,init);
  assert.ok(init.headers.cookie);reads++;
  if(String(input).endsWith('.session')){const user=Object.keys(cookies).find(k=>cookies[k]===init.headers.cookie);assert.ok(user);return new Response(JSON.stringify({message:{identity_id:user,user_name:user,collaboration_key:user}}));}
  if(String(input).includes('csrf'))return new Response(JSON.stringify({message:{csrf_token:'synthetic'}}));
  assert.equal(JSON.parse(init.body).service_id,'files.versions');
  return new Response(JSON.stringify(allowed?{message:{result:{file:{name:'original'},versions:[{source:{file:'fixed-v1'}}]}}}:{message:'无权限'}),{status:allowed?200:403});
 };
 try{
  const path=`chats/${id}/messages`,body={text:'',files:[{ref_name:'original',file:'fixed-v1'}],client_msg_id:'file1'};
  assert.equal((await request('one',path,body)).status,200);assert.ok(reads>=2);
  const m=(await messages(id))[0];assert.deepEqual(m.files,body.files);assert.equal(m.text,'');
  const forward=`chats/${id}/messages/${m.id}/forward`,payload={target_chat_id:target,client_msg_id:'forward-file',confirmed:true};
  assert.equal((await request('two',forward,payload)).status,200);
  allowed=false;
  assert.equal((await request('one',path,body)).status,200);
  assert.equal((await request('two',forward,payload)).status,200);
  assert.equal((await request('one',path,{...body,client_msg_id:'file2'})).status,400);
  assert.equal((await request('two',forward,{...payload,client_msg_id:'forward-file2'})).status,400);
  assert.equal((await messages(id)).length,1);
  assert.equal((await request('one',path,{...body,text:'换载荷'})).status,409);
 }finally{globalThis.fetch=nativeFetch;if(upstream===undefined)delete process.env.FRAPPE_UPSTREAM;else process.env.FRAPPE_UPSTREAM=upstream;}
});
