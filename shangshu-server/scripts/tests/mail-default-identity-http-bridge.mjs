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
 const first=await save(seed.prefix+' personal');const personal=await detail(first.name);check('first actual save remains personal owner/mailbox',personal.owner===seed.user&&personal.mailbox_id===seed.personal);check('first payload did not select shared mailbox',saves[0].request.payload.mailbox===undefined);
 from.value=seed.prefix+'-shared@example.invalid';from.dispatchEvent(new w.Event('change',{bubbles:true}));const shared=await save(seed.prefix+' shared');const sharedRead=await detail(shared.name);check('explicit shared selection changes same draft mailbox',shared.name===first.name&&sharedRead.mailbox_id===seed.mailbox);
 from.value='';from.dispatchEvent(new w.Event('change',{bubbles:true}));const back=await save(seed.prefix+' personal again');const readback=await detail(back.name);check('explicit return retains same draft and restores personal mailbox',back.name===first.name&&readback.mailbox_id===seed.personal&&readback.status==='Draft');
 const listing=await http('/api/platform/datasets/mail.message/records?page=1&page_length=20');check('personal list accessible after final save',listing.ok);
 const proposed=fixture({mode:'proposal',fixture:seed,mail:first.name});assert.ok(proposed.id);dispose();
 dom.reconfigure({url:base+'/index.html?proposal='+encodeURIComponent(proposed.id)+'#/mail'});dispose=w.mountMailCenter(w.document.querySelector('#host'),{});await wait(()=>w.shangshuInlineReviews?.has(proposed.id));
 check('real pending proposal has page controller and no obsolete banner',!w.document.querySelector('.mail-inline-review-bar'));
 w.document.querySelector('[data-mail-review-unit="subject"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await wait(()=>!w.document.querySelector('[data-mail-review-unit="subject"]').classList.contains('is-pending'));
 const accepted=await detail(first.name);check('partial accept saves only selected subject',accepted.subject==='候选主题'&&!accepted.body.includes('候选正文不可误写'));
 const input=w.document.querySelector('#c-subject');input.value='人工改过已接受主题';input.dispatchEvent(new w.Event('input',{bubbles:true}));
 const rejected=await w.shangshuInlineReviews.get(proposed.id).rejectRemaining();check('reject remaining preserves already saved semantics',rejected.status==='rejected'&&rejected.saved_content_preserved===true);
 const terminal=await detail(first.name);check('real rejection saves human formal edit, leaves candidate body out, remains Draft',terminal.subject==='人工改过已接受主题'&&!terminal.body.includes('候选正文不可误写')&&terminal.status==='Draft');
 console.log('RESULT '+checks.length+'/'+checks.length+'; draft='+first.name+'; proposal='+proposed.id+'; prefix='+seed.prefix);
}finally{dispose?.();dom?.window.close();if(seed){const cleaned=fixture({mode:'cleanup',fixture:seed,mails});assert.equal(cleaned.cleaned,true);console.log('PASS exact draft recycled and synthetic identities disabled');}}
