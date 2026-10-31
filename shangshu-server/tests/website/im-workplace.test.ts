import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localStore as store} from '../../src/core/store.ts';
import {createGroup,markChatRead,recallMessage,listChats} from '../../src/core/im.ts';
import {messagePage,normalizeMessageExtras,validateMessageExtras,setFavorite,listFavorites,messageProjection} from '../../src/core/im-workplace.ts';
beforeEach(()=>{process.env._SS_DATA_DIR=mkdtempSync(join(tmpdir(),'ss-im-workplace-'));});
async function seed(n=125){const chat=await createGroup(store,'a','合成测试',['b']);for(let i=0;i<n;i++)await store.insert('im','messages',{id:'m'+String(i).padStart(4,'0'),chat_id:chat,sender_id:i%2?'b':'a',text:i===2?'特殊查找 %_':'记录 '+i,created_at:new Date(1760000000000+i).toISOString()});return chat;}
test('服务端稳定分页无重叠、跨会话游标拒绝，搜索与定位可达旧消息且不标已读',async()=>{
 const chat=await seed(),page=await messagePage(store,chat,'a',{limit:30});assert.equal(page.list.length,30);assert.equal(page.list.at(-1).id,'m0124');assert.equal(page.has_more,true);
 const prev=await messagePage(store,chat,'a',{limit:30,before:page.list[0].id});assert.equal(prev.list.at(-1).id,'m0094');assert.equal(new Set([...prev.list,...page.list].map(m=>m.id)).size,60);
 const found=await messagePage(store,chat,'a',{q:'%_'});assert.equal(found.list.length,1);assert.equal(found.list[0].id,'m0002');
 const context=await messagePage(store,chat,'a',{around:'m0002',limit:30});assert.ok(context.list.some(m=>m.id==='m0002'));
 await assert.rejects(()=>messagePage(store,chat,'outsider',{}));const other=await createGroup(store,'a','另群',[]);await assert.rejects(()=>messagePage(store,other,'a',{before:'m0002'}));
 assert.equal((await listChats(store,'a'))[0].unread,62);
});
test('收藏不保存正文，撤回或失去会话权限后无泄漏，取消收藏幂等',async()=>{
 const chat=await seed(1);await setFavorite(store,chat,'m0000','a',true);await setFavorite(store,chat,'m0000','a',true);
 assert.equal((await listFavorites(store,'a')).length,1);assert.equal((await listFavorites(store,'b')).length,0);
 const rows=await store.query('im','favorites');assert.equal(rows.length,1);assert.equal(rows[0].text,undefined);
 await store.update('im','messages','m0000',{recalled:true,text:''});assert.equal((await listFavorites(store,'a'))[0].text,'');
 await store.update('im','chats',chat,{member_ids:'["b"]'});assert.equal((await listFavorites(store,'a')).length,0);
 await setFavorite(store,chat,'m0000','a',false);assert.equal((await store.query('im','favorites')).length,0);
});
test('@成员与固定文件引用严格校验；不接受URL、正文副本或任意挂载',async()=>{
 const chat=await seed(1),extras=normalizeMessageExtras({mentions:['b'],files:[{ref_name:'f1',file:'attachment1'}]});await validateMessageExtras(store,chat,extras);
 await assert.rejects(()=>validateMessageExtras(store,chat,normalizeMessageExtras({mentions:['outsider']})));
 assert.throws(()=>normalizeMessageExtras({files:[{url:'https://bad.test'}]}));assert.throws(()=>normalizeMessageExtras({files:[{ref_name:'f1',file:'x',content:'copy'}]}));
 assert.throws(()=>normalizeMessageExtras({mentions:'b'}));assert.deepEqual(extras.files,[{ref_name:'f1',file:'attachment1'}]);
});
test('已读并发保留双方游标，只向本人投影自己消息的当前成员回执',async()=>{
 const chat=await seed(2);await Promise.all([markChatRead(store,chat,'a','m0001'),markChatRead(store,chat,'b','m0001')]);
 const [c]=await store.query('im','chats',{id:chat});assert.ok(JSON.parse(c.last_read).a);assert.ok(JSON.parse(c.last_read).b);
 const [m]=await store.query('im','messages',{id:'m0000'});const own=await messageProjection(store,c,[m],'a');assert.deepEqual(own[0].read_by,['b']);
 const peer=await messageProjection(store,c,[m],'b');assert.equal(peer[0].read_by,undefined);
});
