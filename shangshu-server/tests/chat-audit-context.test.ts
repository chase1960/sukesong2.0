import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotChatContext,saveChatAuditContext,readChatAuditContext} from '../src/core/chat-audit-context.ts';
function memory(){const rows:any[]=[];return {rows,store:{guarantees:{appendOnlyAudit:true},insert:async(_l:any,_e:any,row:any)=>{rows.push({...row,_entity:_e});return row;},query:async(_l:any,_e:any,filter:any)=>rows.filter(r=>r._entity===_e&&Object.entries(filter).every(([k,v])=>r[k]===v))} as any};}
test('触发上下文冻结，缺少后续不猜，后来对话不改快照',async()=>{
 const m=memory(),history=Array.from({length:6},(_,i)=>({role:'user',content:String(i)}));
 const snapshot=snapshotChatContext(history,'trigger');history[5].content='changed';
 await saveChatAuditContext(m.store,'u','u:c','turn',['P','P'],snapshot);
 history.push({role:'user',content:'future'});
 const result:any=await readChatAuditContext('u','P',{store:m.store,authorize:async()=>({collaboration_key:'u'})});
 assert.equal(m.rows.length,1);assert.deepEqual(result.context.before,['2','3','4','5']);assert.deepEqual(result.context.after,[]);assert.equal(result.context.trigger,'trigger');
});
test('组织授权失败前不读存储，不泄露原文或数量',async()=>{
 let touched=false;await assert.rejects(readChatAuditContext('other','P',{authorize:async()=>{throw Error('denied');},store:{query:async()=>{touched=true;return [];}} as any}),/denied/);assert.equal(touched,false);
});
test('不同员工不跨会话，历史无绑定不猜，冲突不选第一个',async()=>{
 const m=memory();await saveChatAuditContext(m.store,'u','u:c','t',['P'],snapshotChatContext([],'secret'));
 assert.deepEqual(await readChatAuditContext('v','P',{store:m.store,authorize:async()=>({collaboration_key:'v'})}),{status:'not_linked'});
 await saveChatAuditContext(m.store,'u','v:c','t',['P2'],snapshotChatContext([],'spoof'));assert.equal(m.rows.length,1);
 await saveChatAuditContext(m.store,'u','u:c','t2',['P'],snapshotChatContext([],'conflict'));
 assert.deepEqual(await readChatAuditContext('u','P',{store:m.store,authorize:async()=>({collaboration_key:'u'})}),{status:'ambiguous'});
});

test('提案独立日志授权失败不会返回已读取的对话和工具事实',async()=>{
 const m=memory();await saveChatAuditContext(m.store,'u','u:c','t',['P'],snapshotChatContext([],'secret'));
 await assert.rejects(readChatAuditContext('u','P',{store:m.store,authorize:async()=>({collaboration_key:'u'}),proposal:async()=>{throw Error('proposal denied');}}),/proposal denied/);
});


test('普通提案来源投影不加载九轮上下文，只有显式上下文读口才查用户消息',async()=>{
 const m=memory();await saveChatAuditContext(m.store,'u','u:c','t',['P'],snapshotChatContext([],'trigger'));
 const query=m.store.query;let messageReads=0;
 m.store.query=async(...args:any[])=>{if(args[1]==='chat_messages')messageReads++;return query(...args);};
 const dependencies={store:m.store,authorize:async()=>({collaboration_key:'u'})};
 const ordinary:any=await readChatAuditContext('u','P',dependencies);
 assert.equal(messageReads,0);assert.equal(ordinary.user_message_window,undefined);
 const explicit:any=await readChatAuditContext('u','P',{...dependencies,includeUserMessageWindow:true});
 assert.equal(messageReads,1);assert.equal(explicit.user_message_window.status,'not_available');
});
