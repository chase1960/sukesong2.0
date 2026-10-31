import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {projectHistoryCards} from '../../src/adapters/web/chat-history-cards.ts';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
/**
 * ⚠️ `chatSkeleton` / `chatHistorySkeleton` 是 real-chat.js **文件靠前的顶层助手**（第 22 行起），
 *   本文件只把 `// Historical execution facts` → `function chatPickSession(i)` 这段拿进沙箱跑
 *   ⇒ 抽出来的那段用到骨架助手时，window 上没有 ⇒ **ReferenceError: chatSkeleton is not defined**。
 *   （同类先例：`shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs` ——
 *     抽源码片段在沙箱里跑，片段用到的导入件在沙箱 context 里补上，补的是**真的那个**。）
 */
const skeletonSource=source.slice(source.indexOf('const chatSkeleton ='),source.indexOf('let chatRunning = false;'));
function mount(fetcher:any){const dom=new JSDOM('<section id="h1"></section><section id="h2"></section>',{runScripts:'outside-only'}),w=dom.window as any;w.esc=(s:any)=>String(s??'').replace(/</g,'&lt;');w.api=fetcher;w.shangshuReviewSource=()=>({label:'Assistant'});w.shangshuReviewTarget=(p:any)=>p.target;w.shangshuNavigateReview=async(p:any)=>{w.navigated=p.id;};w.eval(skeletonSource+'\nwindow.chatSkeleton=chatSkeleton;window.chatHistorySkeleton=chatHistorySkeleton;');w.eval(source.slice(source.indexOf('// Historical execution facts'),source.indexOf('function chatPickSession(i)')));return{w,doc:w.document,close:()=>w.close()};}
it('历史cards投影只保留受控事实；任意旧值/错误/工具参数不得返回',()=>{
 const raw={proposals:[{id:'P1',payload:{secret:'hidden'},entity_id:'hidden'}],tools:[{name:'hidden',ok:true,receipt_id:'P1',arg:'hidden',result:'hidden'},{ok:false,receipt_id:'hidden'}],status:{errors:[{message:'hidden'}],reads:['hidden'],no_receipt_claims:['hidden'],empty_attempts:[],states:{mail_sent:99}}};
 const out=projectHistoryCards(raw)!;assert.doesNotMatch(JSON.stringify(out),/hidden|mail_sent/);assert.deepEqual(out.proposals,[{id:'P1'}]);assert.equal(out.tools[0].proposal_id,'P1');assert.equal(out.status?.error_count,1);
});
it('部分采用后拒绝剩余按当前提案投影恢复，保存事实/动作审计/目标可追溯且不说发送',async()=>{
 const t=mount(async()=>({ok:true,json:async()=>({id:'P1',status:'rejected',capability:'mail.save_draft',review:{accepted_count:2},decision_by:'member',execution_audit:'ACT1',target:{module:'mail',mail:'M1'}})}));try{const card=await t.w.chatRestoreProposalCard(t.doc.querySelector('#h1'),{id:'P1',payload:{secret:'hidden'}});assert.match(card.textContent,/已保存 2 项保留/);assert.match(card.textContent,/ACT1/);assert.doesNotMatch(card.textContent,/未执行|已发送|hidden/);card.querySelector('button').click();await Promise.resolve();assert.equal(t.w.navigated,'P1');}finally{t.close();}
});
it('撤权或外来提案回包只显示中性状态，不恢复旧敏感载荷或错误全文',async()=>{
 for(const denied of [true,false]){const t=mount(async()=>({ok:!denied,json:async()=>denied?{ok:false,error:'hidden secret'}:{id:'OTHER',status:'confirmed',payload:{secret:'hidden'}}}));try{const card=await t.w.chatRestoreProposalCard(t.doc.querySelector('#h1'),{id:'P1',summary:'hidden'});assert.match(card.textContent,/无法核实/);assert.doesNotMatch(card.textContent,/hidden|OTHER/);assert.equal(card.querySelector('button'),null);}finally{t.close();}}
});
it('迟到响应只更新原会话；原层被换账号移除后不渲染',async()=>{
 for(const remove of [false,true]){let done:any;const t=mount(()=>new Promise(resolve=>{done=resolve;}));try{const h1=t.doc.querySelector('#h1'),h2=t.doc.querySelector('#h2');const pending=t.w.chatRestoreProposalCard(h1,{id:'P1'});if(remove)h1.remove();else h1.hidden=true;h2.textContent='新会话';done({ok:true,json:async()=>({id:'P1',status:'confirmed',capability:'mail.save_draft'})});await pending;assert.equal(h2.textContent,'新会话');if(!remove)assert.match(h1.textContent,/草稿修改已确认/);else assert.doesNotMatch(h1.textContent,/草稿修改已确认/);}finally{t.close();}}
});
it('历史工具失败和空回答可恢复，但不渲染旧错误正文、不把调用完成当正式写入',()=>{
 const t=mount(async()=>{});try{t.w.chatRestoreHistoryFacts(t.doc.querySelector('#h1'),projectHistoryCards({tools:[{ok:true},{ok:false}],status:{errors:[{message:'hidden'}],empty_attempts:[{}],auto_retried:true,no_receipt_claims:['hidden']}}));const text=t.doc.querySelector('#h1').textContent;assert.match(text,/调用失败/);assert.match(text,/空回答/);assert.match(text,/不代表已确认/);assert.doesNotMatch(text,/hidden/);}finally{t.close();}
});
it('缓存历史卡重核先清旧内容，迟到的旧获权结果不能覆盖新撤权状态',async()=>{
 let n=0,first:any;const t=mount(()=>++n===1?new Promise(resolve=>{first=resolve;}):Promise.resolve({ok:false,json:async()=>({error:'secret'})}));
 try{const body=t.doc.querySelector('#h1'),old=t.w.chatRestoreProposalCard(body,{id:'P1'}),card=body.firstElementChild;await t.w.chatRestoreProposalCard(body,{id:'P1'},card);assert.match(card.textContent,/无法核实/);first({ok:true,json:async()=>({id:'P1',status:'confirmed',capability:'mail.save_draft',decision_by:'secret'})});await old;assert.match(card.textContent,/无法核实/);assert.doesNotMatch(card.textContent,/secret|已确认/);}finally{t.close();}
});
