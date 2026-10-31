import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../src/core/storage/sqlite.ts';
import {appendChatAuditEvent,snapshotChatContext,readChatAuditTrace,type AuditTrace} from '../src/core/chat-audit-context.ts';

async function fixture(fn:(store:SqliteStore)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'ss-recovery-'));const store=new SqliteStore(join(dir,'state.sqlite'));try{await fn(store);}finally{await store.close();rmSync(dir,{recursive:true,force:true});}}
const trace:AuditTrace={status:'linked',actor_user:'alice',request_id:'request-server-only',action_id:'mail.draft',proposal_id:'P',operation_id:'AUDIT-1'};
async function request(store:SqliteStore,actor='company-a:alice',action='mail.draft'){
 await appendChatAuditEvent(store,actor,actor+':chat','turn',{kind:'tool_request',request_id:'request-server-only',action_id:action,tool:'mail_draft',tool_call_id:'call-1',arguments:'{"subject":"实际请求"}',context:snapshotChatContext([],'写邮件')});
}
function deps(store:SqliteStore,actor='company-a:alice',value=trace){return {store,authorize:async()=>({collaboration_key:actor}),trace:async()=>value,proposal:async()=>({scope:'audit_only',can_confirm:false,accepted_count:1,proposal:{status:'rejected'},receipts:[{audit:'AUDIT-1'}]})};}
test('远端提案成功、本地link缺失可按审计号恢复；并发及反复查询不重复、不重执行',()=>fixture(async store=>{
 await request(store);assert.equal((await store.query('execution','chat_audit_sources')).length,0);
 const results=await Promise.all([readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store)),readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store))]);
 for(const result of results){assert.equal(result.status,'linked');assert.equal((result as any).context.trigger,'写邮件');assert.equal((result as any).decision.accepted_count,1);}
 assert.equal((await store.query('execution','chat_audit_sources')).length,1);
 assert.equal((await readChatAuditTrace('alice',{request_id:'request-server-only'},deps(store))).status,'linked');
 assert.equal((await store.query('execution','chat_audit_sources')).length,1);
}));
test('不同企业或员工即使同request id也不能关联；内核actor不匹配拒绝',()=>fixture(async store=>{
 await request(store);
 for(const actor of ['company-b:alice','company-a:bob'])assert.equal((await readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store,actor))).status,'not_linked');
 await assert.rejects(readChatAuditTrace('bob',{operation_id:'AUDIT-1'},deps(store)),/身份不匹配/);
}));
test('伪造request id、动作不符及旧无请求事实不猜关联',()=>fixture(async store=>{
 assert.equal((await readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store))).status,'not_linked');
 await request(store);
 await assert.rejects(readChatAuditTrace('alice',{request_id:'forged'},deps(store)),/请求关联不匹配/);
 assert.equal((await readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store,'company-a:alice',{...trace,action_id:'file.delete'}))).status,'not_linked');
 assert.equal((await store.query('execution','chat_audit_sources')).length,0);
}));
test('每次恢复重验日志权；撤权拒绝且不追加link',()=>fixture(async store=>{
 await request(store);
 await assert.rejects(readChatAuditTrace('alice',{operation_id:'AUDIT-1'},{...deps(store),proposal:async()=>{throw Error('revoked');}}),/revoked/);
 assert.equal((await store.query('execution','chat_audit_sources')).length,0);
 let touched=false;await assert.rejects(readChatAuditTrace('alice',{operation_id:'AUDIT-1'},{...deps(store),authorize:async()=>{throw Error('denied');},trace:async()=>{touched=true;return trace;}}),/denied/);assert.equal(touched,false);
}));
test('无提案直接动作仍按真实审计查回触发和工具请求，动态工具匹配真实action',()=>fixture(async store=>{
 await appendChatAuditEvent(store,'company-a:alice','company-a:alice:chat','turn',{kind:'tool_request',request_id:'request-server-only',tool:'platform_action_call',arguments:JSON.stringify({action_id:'mail.draft',payload:{subject:'actual'}}),context:snapshotChatContext([],'保存')});
 const result:any=await readChatAuditTrace('alice',{operation_id:'AUDIT-1'},deps(store,'company-a:alice',{...trace,proposal_id:undefined}));assert.equal(result.status,'linked');assert.equal(result.context.trigger,'保存');assert.equal((await store.query('execution','chat_audit_sources')).length,0);
}));
