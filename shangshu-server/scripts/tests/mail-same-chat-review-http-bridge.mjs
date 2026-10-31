import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const base=process.env.SS_BASE||'http://127.0.0.1:3850',mails=[];
function fixture(request){const r=spawnSync('python3',[fileURLToPath(new URL('./mail-default-identity-fixture.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env,SS_BASE:base},timeout:120000});if(r.status!==0)throw Error('Mail fixture failed (sensitive output suppressed)');return JSON.parse(r.stdout);}
async function wait(test){const until=Date.now()+30000;while(!test()){if(Date.now()>until)throw Error('mail DOM timeout');await new Promise(r=>setTimeout(r,40));}}
const checks=[];const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS '+label)};
let seed,dom,dispose;
try{
 seed=fixture({mode:'seed'});const login=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:seed.user,password:seed.password})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const http=(p,o={})=>{let signal=o.signal;if(signal&&!(signal instanceof AbortSignal)){const relay=new AbortController();if(signal.aborted)relay.abort();else signal.addEventListener('abort',()=>relay.abort(),{once:true});signal=relay.signal;}return fetch(new URL(p,base),{...o,signal,headers:{...o.headers,cookie}});};
 dom=new JSDOM('<div id="host"></div>',{url:base+'/index.html#/mail',runScripts:'outside-only'});const w=dom.window,saves=[];w.RENDER={};w.currentRole=()=> 'staff';w.toast=(...v)=>console.log('TOAST',...v);w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(path,options={})=>{if(path.includes('mail.send'))throw Error('Test forbids all send actions');const r=await http(path,options).catch(e=>{console.log('HTTP_EXCEPTION',path,e.message);throw e});if(!r.ok){const problem=await r.clone().json().catch(()=>({}));console.log('HTTP_FAILURE',path,r.status,problem.error||problem.code||'');}if(path.includes('mail.save_draft')){const d=await r.clone().json();saves.push({request:JSON.parse(options.body),response:d,status:r.status});const result=d.result||d;if(result.name&&!mails.includes(result.name))mails.push(result.name)}return r};
 for(const f of ['tool-workspace.js','file-reference-picker.js','domains/mail/mail-editor.js','mail-center.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+f,import.meta.url),'utf8'));
 dispose=w.mountMailCenter(w.document.querySelector('#host'),{});await wait(()=>w.document.querySelector('#compose')&&!w.document.querySelector('#compose').disabled);await wait(()=>w.document.querySelector('#mailbox-switch option[value="'+seed.mailbox+'"]'));
 w.document.querySelector('#compose').click();const from=w.document.querySelector('#c-from');check('unbound personal option retained despite shared sender',from.selectedOptions[0].getAttribute('data-mailbox')==='');check('unbound personal send disabled',w.document.querySelector('#c-send').disabled);
 async function save(subject){const before=saves.length,el=w.document.querySelector('#c-subject');el.value=subject;el.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.querySelector('#c-save').click();await wait(()=>saves.length>before);await wait(()=>!w.document.querySelector('#c-save').disabled);const item=saves.at(-1);assert.equal(item.status,200);assert.notEqual(item.response.ok,false);return item.response.result||item.response;}
 async function detail(id){const r=await http('/api/platform/services/mail.detail/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{mail:id}})});const d=await r.json();assert.equal(r.status,200);return (d.result||d).mail;}
 const first=await save(seed.prefix+' same subject');const readback=await detail(first.name);
 const second=await http('/api/platform/actions/mail.save_draft/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{subject:readback.subject,body:'第二封原正文',to:[],cc:[]},confirmed:true,idempotency_key:seed.prefix+'-second'})});assert.equal(second.status,200);const sr=await second.json(),secondMail=(sr.result||sr).name;mails.push(secondMail);
 const proposed=fixture({mode:'proposal',fixture:seed,mail:first.name,suffix:'first'}),other=fixture({mode:'proposal',fixture:seed,mail:secondMail,suffix:'second'});dispose();
 dom.reconfigure({url:base+'/index.html?proposal='+encodeURIComponent(proposed.id)+'#/mail'});dispose=w.mountMailCenter(w.document.querySelector('#host'),{});await wait(()=>w.shangshuInlineReviews?.has(proposed.id));
 const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
 w.esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 w.money=String;w.chatScrollBottom=()=>{};w.chatUpdateFab=()=>{};w.chatConfirmFollowUp=async()=>{};w.api=(path,o={})=>w.fetch('/'+path,o);
 w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));w.shangshuNavigateReview=async()=>true;
 const chat=w.document.createElement('section');chat.dataset.conversation='one-synthetic-conversation';w.document.body.append(chat);w.chatBindPendingReviews();
 const getProposal=async id=>{const r=await http('/api/platform/action-proposal-get/'+id);assert.equal(r.status,200);return r.json()};
 const primary=await getProposal(proposed.id),secondary=await getProposal(other.id);
 w.chatAddConfirmCard(chat,{...primary,id:proposed.id,capability:'mail.save_draft'});w.chatAddConfirmCard(chat,{...secondary,id:other.id,capability:'mail.save_draft'});
 const card=()=>chat.querySelector('[data-confirm-id="'+proposed.id+'"]'),otherCard=()=>chat.querySelector('[data-confirm-id="'+other.id+'"]');
 await wait(()=>card()?.querySelector('.cf-btn.ok')&&!card().querySelector('.cf-btn.ok').disabled);
 check('same conversation renders two distinct target cards',!!otherCard()&&chat.querySelectorAll('[data-confirm-id]').length===2);
 card().querySelector('.cf-btn.ok').click();await wait(()=>card().classList.contains('resolved'));
 const final=await detail(first.name);check('actual chat all-confirm saves target draft only',final.subject==='候选主题'&&final.body.includes('候选正文不可误写')&&final.status==='Draft');
 check('same named other draft untouched', (await detail(secondMail)).body==='第二封原正文');
 const remaining=await getProposal(other.id);check('other proposal stays pending and card unresolved',String(remaining.status).toLowerCase()==='proposed'&&!otherCard().classList.contains('resolved'));
 check('chat result does not claim sent',card().textContent.includes('未发送'));
 console.log('RESULT '+checks.length+'/'+checks.length+' same-conversation cards');
}finally{dispose?.();dom?.window.close();if(seed){const cleaned=fixture({mode:'cleanup',fixture:seed,mails});assert.equal(cleaned.cleaned,true);console.log('PASS exact draft recycled and synthetic identities disabled');}}
