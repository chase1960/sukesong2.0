import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../src/core/storage/sqlite.ts';
import {snapshotChatContext,saveChatAuditContext,appendChatAuditEvent,readChatAuditContext,requireAuditStore} from '../src/core/chat-audit-context.ts';
test('SQLite审计触发器禁止update/delete/compareAndSet及直接SQL；删会话不删快照或工具链',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ss-audit-')),path=join(dir,'state.sqlite'),store=new SqliteStore(path);
 try{await saveChatAuditContext(store,'u','u:c','turn',['P'],snapshotChatContext([],'原触发'));
 await appendChatAuditEvent(store,'u','u:c','turn',{kind:'tool_request',tool_call_id:'c1',arguments:'{"amount":12}'});
 const source=(await store.query('execution','chat_audit_sources'))[0],event=(await store.query('execution','chat_audit_events'))[0];
 for(const [entity,row] of [['chat_audit_sources',source],['chat_audit_events',event]] as const){await assert.rejects(store.update('execution',entity,row.id,{context_json:'changed'}),/append-only/);await assert.rejects(store.delete('execution',entity,row.id),/append-only/);await assert.rejects(store.compareAndSet('execution',entity,row.id,1,{context_json:'changed'}),/append-only/);}
 const direct=new DatabaseSync(path);try{assert.throws(()=>direct.prepare("UPDATE records SET body='{}' WHERE entity='chat_audit_sources'").run(),/append-only/);assert.throws(()=>direct.prepare("DELETE FROM records WHERE entity='chat_audit_events'").run(),/append-only/);}finally{direct.close();}
 const message=await store.insert('execution','chat_messages',{conversation_id:'u:c',content:'ordinary'});await store.delete('execution','chat_messages',message);
 const result:any=await readChatAuditContext('u','P',{store,authorize:async()=>({collaboration_key:'u'}),proposal:async()=>({status:'rejected',accepted_count:1})});assert.equal(result.context.trigger,'原触发');assert.equal(result.events[0].tool_call_id,'c1');assert.equal(result.decision.accepted_count,1);
 }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});
test('没有不可变保证的兼容store在任何助手工具前拒绝，不能宣称已留审计',()=>{assert.throws(()=>requireAuditStore({guarantees:{transactions:false,conditionalUpdate:false,stableIds:false}} as any),/不能保证/);});

test('Bitable实际写路径拒绝审计插入，不能以远端普通表冒充不可变',async()=>{
 const {createBitableStore}=await import('../src/core/store.ts');const store=createBitableStore({bitable_app_token:'invalid-test-no-network'} as any);
 for(const entity of ['chat_audit_sources','chat_audit_events'])await assert.rejects(store.insert('execution',entity,{actor_key:'u'}),/不具备不可变/);
});

test('前后各4条用户消息带对应内部调用，跨员工拒绝、缺锚点不猜，查询走索引',async()=>{
 const {readUserMessageWindow}=await import('../src/core/chat-audit-context.ts');
 const dir=mkdtempSync(join(tmpdir(),'chat-window-')),path=join(dir,'s.sqlite');
 const {openSqliteStore}=await import('../src/core/storage/sqlite.ts');
 const store=openSqliteStore(path);
 try{
  for(let i=0;i<13;i++){
   await store.insert('execution','chat_messages',{id:`m${String(i).padStart(2,'0')}`,conversation_id:'u:c',turn_id:`t${i}`,role:'user',content:`用户${i}`,created_at:'2026-10-30T00:00:00Z'});
   await store.insert('execution','chat_audit_events',{actor_key:'u',conversation_id:'u:c',turn_id:`t${i}`,event_json:JSON.stringify({kind:'tool_result',value:i})});
  }
  const result:any=await readUserMessageWindow(store,'u','u:c','t6');
  assert.deepEqual(result.messages.map((m:any)=>m.content),Array.from({length:9},(_,i)=>`用户${i+2}`));
  assert.deepEqual(result.messages.map((m:any)=>m.internal_calls[0].value),[2,3,4,5,6,7,8,9,10]);
  assert.equal(result.before_has_more,true);assert.equal(result.after_has_more,true);
  await assert.rejects(readUserMessageWindow(store,'v','u:c','t6'),/归属/);
  assert.equal((await readUserMessageWindow(store,'u','u:c','old')).status,'not_available');
  const db=new DatabaseSync(path);
  const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT body FROM records WHERE layer=? AND entity=? AND json_extract(body,'$."conversation_id"') IS ? AND json_extract(body,'$."role"') IS ? AND (json_extract(body,'$."created_at"'),id) > (?,?) ORDER BY json_extract(body,'$."created_at"'),id LIMIT 5`).all('execution','chat_messages','u:c','user','2026-10-30T00:00:00Z','m06');
  assert.match(JSON.stringify(plan),/chat_message_window_v1/);assert.doesNotMatch(JSON.stringify(plan),/TEMP B-TREE|SCAN records/);db.close();
 }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});

test('万条历史只读取九条用户消息及其调用，索引不覆盖其他业务实体',async(t)=>{
 const {readUserMessageWindow}=await import('../src/core/chat-audit-context.ts');
 const {openSqliteStore}=await import('../src/core/storage/sqlite.ts');
 const dir=mkdtempSync(join(tmpdir(),'chat-window-volume-')),path=join(dir,'s.sqlite'),store=openSqliteStore(path);
 try{
  await store.transaction!(async(tx)=>{
   for(let i=0;i<10000;i++){
    const id=`m${String(i).padStart(5,'0')}`;
    await tx.insert('execution','chat_messages',{id,conversation_id:'u:c',turn_id:`t${i}`,role:'user',content:`消息${i}`,created_at:'2026-10-30T00:00:00Z'});
    if(i>=4996&&i<=5004)await tx.insert('execution','chat_audit_events',{actor_key:'u',conversation_id:'u:c',turn_id:`t${i}`,event_json:JSON.stringify({kind:'tool_result',index:i})});
   }
  });
  let queried=0,loaded=0;const query=store.query.bind(store);
  const bounded={...store,guarantees:store.guarantees,query:async(...args:Parameters<typeof query>)=>{
    assert.ok(args[3]?.limit,'窗口读取必须有数据库LIMIT');queried++;
    const rows=await query(...args);loaded+=rows.length;return rows;
  }} as any;
  const start=performance.now();const window:any=await readUserMessageWindow(bounded,'u','u:c','t5000');
  const ms=performance.now()-start;
  assert.equal(window.messages.length,9);assert.equal(queried,12);assert.equal(loaded,20);
  assert.deepEqual(window.messages.map((m:any)=>m.internal_calls[0].index),[4996,4997,4998,4999,5000,5001,5002,5003,5004]);
  const db=new DatabaseSync(path);
  for(const index of ['chat_message_window_v1','chat_message_turn_v1','chat_event_turn_v1']){
    const row=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(index) as any;
    assert.match(row.sql,/WHERE layer='execution' AND entity='chat_/);
  }
  db.close();t.diagnostic(`10000 user messages: ${ms.toFixed(2)}ms, ${queried} bounded queries, ${loaded} rows loaded`);
 }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});


test('超长内部结果明确标记截断，调用里不重复四条上下文正文',async()=>{
 const {readUserMessageWindow}=await import('../src/core/chat-audit-context.ts');
 const {openSqliteStore}=await import('../src/core/storage/sqlite.ts');
 const dir=mkdtempSync(join(tmpdir(),'chat-window-budget-')),store=openSqliteStore(join(dir,'s.sqlite'));
 try{
  await store.insert('execution','chat_messages',{conversation_id:'u:c',turn_id:'t',role:'user',content:'x'.repeat(17000),created_at:'2026-10-30T00:00:00Z'});
  await store.insert('execution','chat_audit_events',{actor_key:'u',conversation_id:'u:c',turn_id:'t',event_json:JSON.stringify({kind:'tool_result',context:{trigger:'duplicate-context'},result:'r'.repeat(300000)})});
  const result:any=await readUserMessageWindow(store,'u','u:c','t');
  assert.equal(result.messages[0].content.length,16000);assert.equal(result.messages[0].content_truncated,true);
  assert.equal(result.messages[0].internal_calls_status,'budget_exceeded');assert.equal(result.messages[0].internal_calls_has_more,true);
  assert.equal(result.messages[0].internal_calls[0].truncated,true);
  assert.doesNotMatch(JSON.stringify(result),/duplicate-context/);assert.ok(JSON.stringify(result).length<285000);
 }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});
