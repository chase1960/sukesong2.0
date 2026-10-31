import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
test('UI092 production global review navigation keeps chat and directs exact Excel/mail proposal targets with authoritative sources',async()=>{
 const dom=new JSDOM('<section id="chat">原对话</section>',{url:'https://local.test/#/mail',runScripts:'outside-only'});const w=dom.window as any;try{
 const pages:string[]=[],events:any[]=[],modes:string[]=[];w.resolvePage=(p:string)=>p;w.go=async(p:string)=>{pages.push(p);w.location.hash='#/'+p;return true;};w.chatSetMode=(m:string)=>modes.push(m);w.addEventListener('shangshu:review-focus',(e:any)=>events.push(e.detail));w.eval(source.slice(source.indexOf('window.shangshuReviewSource ='),source.indexOf('async function chatReviewJSON')));
 const excel={id:'excel-proposal',capability:'files.sheet_cells_write',created_via:'ai',payload:{table:'original-table',source:'code'}};assert.equal(await w.shangshuNavigateReview(excel,{unit_id:'u1',target:{header:'金额',row_id:'stable-r1'}}),true);assert.equal(w.location.search,'?object=original-table&proposal=excel-proposal');assert.equal(events[0].unit_id,'u1');assert.equal(events[0].field,'金额');assert.equal(w.shangshuReviewSource(excel).kind,'assistant');
 const mail={id:'mail-proposal',capability:'mail.save_draft',created_via:'ai',payload:{mail:'draft-original'}};assert.equal(await w.shangshuNavigateReview(mail,{unit_id:'body_html',target:{header:'body_html'}}),true);assert.equal(w.location.search,'?mail=draft-original&proposal=mail-proposal');assert.equal(events[1].mail,'draft-original');assert.equal(events[1].proposal_id,'mail-proposal');assert.deepEqual(pages,['excel','mail']);assert.equal(w.document.querySelector('#chat').textContent,'原对话');assert.ok(modes.every(m=>m==='split'));
 const code={...excel,created_via:'code',source_provenance:{status:'linked',trusted:true,kind:'process',executor_kind:'llm',definition_version:'v2',process_instance:'run-1',node_id:'node-2',initiator:{kind:'assistant',trusted:true}}};const proof=w.shangshuReviewSource(code);assert.equal(proof.kind,'automation');assert.match(proof.label,/Assistant发起.*LLM节点.*v2.*run-1.*node-2/);
 const previous=w.location.href;w.go=async()=>false;assert.equal(await w.shangshuNavigateReview(excel),false);assert.equal(w.location.href,previous);assert.equal(events.length,2,'blocked navigation emits no false focus');
 }finally{dom.window.close();}
});
