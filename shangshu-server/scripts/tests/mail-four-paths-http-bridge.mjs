import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const base=process.env.SS_BASE||'http://127.0.0.1:3850',mails=[],checks=[];
function fixture(request){const p=spawnSync('python3',[fileURLToPath(new URL('./mail-default-identity-fixture.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env,SS_BASE:base},timeout:120000});if(p.status)throw Error('fixture failed (sensitive output suppressed)');return JSON.parse(p.stdout)}
async function wait(fn){const end=Date.now()+30000;while(!fn()){if(Date.now()>end)throw Error('DOM timeout');await new Promise(r=>setTimeout(r,40))}}
function check(s,b){assert.ok(b,s);checks.push(s);console.log('PASS '+s)}
let seed,dom,dispose,api;const files=[],expanded=process.env.MAIL_COMPLETION==='1';let clip,signatureA;
try{
 seed=fixture({mode:'seed'});const source=fixture({mode:'received',fixture:seed});mails.push(source.mail);
 const login=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:seed.user,password:seed.password})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const http=(p,o={})=>{let signal=o.signal;if(signal&&!(signal instanceof AbortSignal)){const relay=new AbortController();if(signal.aborted)relay.abort();else signal.addEventListener('abort',()=>relay.abort(),{once:true});signal=relay.signal}return fetch(new URL(p,base),{...o,signal,headers:{...o.headers,cookie}})};
 const detail=async id=>{const r=await http('/api/platform/services/mail.detail/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{mail:id}})});assert.equal(r.status,200);const d=await r.json();return (d.result||d).mail};
 async function mount(id){dispose?.();dom?.window.close();dom=new JSDOM('<div id="host"></div>',{url:base+'/index.html'+(id?'?mail='+id:'')+'#/mail',runScripts:'outside-only'});const w=dom.window;w.RENDER={};w.currentRole=()=> 'staff';w.toast=(...v)=>console.log('TOAST',...v);w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};const saves=[];
 w.fetch=async(p,o={})=>{if(p.includes('mail.send'))throw Error('no sending');const r=await http(p,o);if(p.includes('mail.save_draft')){const d=await r.clone().json();saves.push({status:r.status,d,request:JSON.parse(o.body)});const v=d.result||d;if(v.name&&!mails.includes(v.name))mails.push(v.name)}return r};
 for(const f of ['tool-workspace.js','file-reference-picker.js','domains/mail/mail-editor.js','mail-center.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+f,import.meta.url),'utf8'));
 dispose=w.mountMailCenter(w.document.querySelector('#host'),{});await wait(()=>id?w.document.querySelector('#reply, #c-editor'):(w.document.querySelector('#compose')&&!w.document.querySelector('#compose').disabled));return {w,saves}}
 api=async(id,payload,service=false)=>{const r=await http('/api/platform/'+(service?'services/':'actions/')+id+(service?'/invoke':'/execute'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,...(service?{}:{confirmed:true,idempotency_key:crypto.randomUUID()})})});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d.result||d};
 if(expanded){
  const before=await (await http('/api/platform/datasets/mail.message/records?page_length=100')).json();
  for(const to of [['bad-address'],['ok@example.invalid\r\nBcc: other@example.invalid']]){
   const r=await http('/api/platform/actions/mail.save_draft/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{subject:seed.prefix+' invalid',body:'invalid',to,cc:[]},confirmed:true,idempotency_key:crypto.randomUUID()})});const d=await r.json();check('UI044 backend rejects invalid recipient '+to[0].slice(0,11),r.status>=400&&JSON.stringify(d).includes('邮箱格式无效'));
  }
  const after=await (await http('/api/platform/datasets/mail.message/records?page_length=100')).json();check('UI044 invalid recipients create no draft or queued row',JSON.stringify(before)===JSON.stringify(after));
  signatureA=await api('mail.account.signature',{enabled:true,signatures:[{id:'a',name:'业务落款',html:'<p>合成默认甲</p>',resources:[]},{id:'b',name:'简短落款',html:'<p>合成默认乙</p>',resources:[]}],default_signature_id:'a',signature_revision:0});
  const workbook=spawnSync('python3',['-c',"import openpyxl,io,base64;w=openpyxl.Workbook();s=w.active;s.append(['案件','金额']);s.append(['00123',731.25]);s.append(['A&B<核对>',0]);b=io.BytesIO();w.save(b);print(base64.b64encode(b.getvalue()).decode())"],{encoding:'utf8'});assert.equal(workbook.status,0);
  const uploaded=await api('files.upload',{file_name:seed.prefix+'-copy.xlsx',content_base64:workbook.stdout.trim(),attribution:{level:'personal',owner_user:seed.user}});files.push(uploaded.file);
  const table=await api('files.sheet_read',{table:uploaded.file},true);const matrix=table.rows.map(r=>table.headers.map(h=>String(r.values[h].value)));assert.deepEqual(matrix,[['00123','731.25'],['A&B<核对>','0']]);
  const {buildClipboardPayload}=await import('../../../shangshu-web/js/domains/excel-univer/src/clipboard-toolbar.ts');const {serializeClipboardTsv}=await import('../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts');
  clip=buildClipboardPayload({range:{startRow:0,startCol:0,endRow:1,endCol:1},getCellText:(r,c)=>matrix[r][c],isRowLoaded:()=>true,serializeTsv:serializeClipboardTsv});
  console.log('MATRIX_SOURCE',JSON.stringify({file:uploaded.file,rows:matrix,html:clip.html}));
 }
 console.log('SOURCE_ATTACHMENTS',JSON.stringify((await detail(source.mail)).attachments));
 for(const mode of (process.env.MAIL_PATHS?process.env.MAIL_PATHS.split(','):['new','reply','reply-all','forward'])){
  let {w,saves}=await mount(mode==='new'?null:source.mail);
  w.document.querySelector(mode==='new'?'#compose':'#'+mode).click();await wait(()=>w.document.querySelector('#c-editor'));
  const editor=w.document.querySelector('#c-editor');if(mode==='new'){editor.innerHTML='<p>新正文</p><table><tr><th colspan="2">汇总</th></tr><tr><td rowspan="2">A001</td><td>800</td></tr><tr><td>0</td></tr></table>';editor.dispatchEvent(new w.Event('input',{bubbles:true}))}
  if(expanded){
   const range=w.document.createRange();range.selectNodeContents(editor);range.collapse(true);w.getSelection().removeAllRanges();w.getSelection().addRange(range);
   const event=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{types:['text/html','text/plain'],getData:type=>type==='text/html'?clip.html:type==='text/plain'?clip.tsv:''}});editor.dispatchEvent(event);
   await wait(()=>editor.textContent.includes('A&B<核对>'));
  }
  check(mode+' actual composer contains merged source table',!!editor.querySelector('[colspan="2"]')&&!!editor.querySelector('[rowspan="2"]'));
  if(mode==='forward'){const pick=w.document.querySelector('[data-pick-att="'+source.attachment+'"]');if(!pick)console.log('OPTIONAL',w.document.querySelector('#c-att-optional')?.innerHTML,source.attachment);check('forward offers source attachment explicitly',!!pick);pick.click()}
  const subject=w.document.querySelector('#c-subject');subject.value=seed.prefix+' '+mode;subject.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.querySelector('#c-save').click();await wait(()=>saves.length);await wait(()=>!w.document.querySelector('#c-save').disabled);const saved=saves.at(-1);assert.equal(saved.status,200);const row=saved.d.result||saved.d;const formal=await detail(row.name);
  if(expanded){const body=new JSDOM(formal.body).window.document;const copied=[...body.querySelectorAll('table')].find(t=>t.textContent.includes('A&B<核对>'));assert.ok(copied);check(mode+' UI051/052 actual Excel rectangle values survive HTTP readback',JSON.stringify([...copied.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent)))===JSON.stringify(clip.rows));check(mode+' copied rectangle retains inline table/cell format',copied.style.borderCollapse==='collapse'&&[...copied.querySelectorAll('td')].every(td=>td.style.border.includes('1px')&&td.style.padding==='4px 8px'));}
  check(mode+' actual HTTP persisted HTML and Draft',formal.status==='Draft'&&formal.body.includes('colspan="2"')&&formal.body.includes('rowspan="2"'));
  if(mode==='reply'||mode==='reply-all'){const addresses=formal.to.map(x=>typeof x==='string'?x:x.email);check(mode+' recipients use source sender',addresses.includes('sender@example.invalid'));if(mode==='reply-all')check('reply-all preserves other recipient and excludes self',addresses.includes('other@example.invalid')&&!addresses.includes(seed.user))}
  if(mode!=='new')check(mode+' CID reference has persisted resource',formal.body.includes('cid:four-path@invalid')&&formal.inline_resources.some(x=>x.content_id==='four-path@invalid'));
  if(mode==='forward')check('forward retains selected source attachment fixed reference',formal.attachments.some(x=>x.name==='source.txt'));
  ({w}=await mount(row.name));await wait(()=>w.document.querySelector('#c-editor'));check(mode+' fresh mount reads saved merged table',!!w.document.querySelector('#c-editor [colspan="2"]')&&!!w.document.querySelector('#c-editor [rowspan="2"]'));
 }
 if(expanded){
  // Save an untouched signature-A snapshot, then change only account default to B.
  let {w,saves}=await mount(null);w.document.querySelector('#compose').click();await wait(()=>w.document.querySelector('#c-editor'));
  check('UI057 new draft uses default A',w.document.querySelector('#c-editor').textContent.includes('合成默认甲'));
  w.document.querySelector('#c-subject').value=seed.prefix+' signature old';w.document.querySelector('#c-save').click();await wait(()=>saves.length);const oldId=(saves.at(-1).d.result||saves.at(-1).d).name,old=await detail(oldId);
  const cfg=signatureA.signature;assert.ok(cfg?.signatures);
  await api('mail.account.signature',{enabled:true,signatures:cfg.signatures,default_signature_id:'b',signature_revision:cfg.signature_revision});
  const stable=await detail(oldId);check('UI058 changing default leaves old draft body and version stable',stable.body===old.body&&stable.record_version===old.record_version);
  ({w,saves}=await mount(null));w.document.querySelector('#compose').click();await wait(()=>w.document.querySelector('#c-editor'));
  check('UI057 new mount uses persisted default B',w.document.querySelector('#c-editor').textContent.includes('合成默认乙')&&!w.document.querySelector('#c-editor').textContent.includes('合成默认甲'));
  w.document.querySelector('#c-subject').value=seed.prefix+' signature new';w.document.querySelector('#c-save').click();await wait(()=>saves.length);const fresh=await detail((saves.at(-1).d.result||saves.at(-1).d).name);check('UI057 B signature saved and independently read back',fresh.body.includes('合成默认乙')&&!fresh.body.includes('合成默认甲'));
  ({w}=await mount(oldId));await wait(()=>w.document.querySelector('#c-editor'));check('UI058 reopened old draft keeps A not new B',w.document.querySelector('#c-editor').textContent.includes('合成默认甲')&&!w.document.querySelector('#c-editor').textContent.includes('合成默认乙'));
 }
 console.log('RESULT',checks.length+'/'+checks.length,seed.prefix);
}finally{dispose?.();dom?.window.close();if(seed){for(const file of files)await api('files.recycle',{file});assert.equal(fixture({mode:'cleanup',fixture:seed,mails}).cleaned,true);console.log('CLEANUP exact mail fixtures recycled and identities disabled')}}
