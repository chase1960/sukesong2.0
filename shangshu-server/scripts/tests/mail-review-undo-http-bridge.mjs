/** Production editor history + real draft/proposal HTTP. No send capability. */
import {JSDOM} from 'jsdom';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const base=process.env.SS_BASE,dir=fileURLToPath(new URL('.',import.meta.url));let seed,mail,dom;const checks=[];
function py(script,input){const p=spawnSync('python3',['-c',script],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,PYTHONPATH:dir},timeout:120000});if(p.status)throw Error(p.stderr.slice(-1600));return JSON.parse(p.stdout)}
function fixture(x){const p=spawnSync('python3',[dir+'mail-default-identity-fixture.py'],{input:JSON.stringify(x),encoding:'utf8',env:process.env,timeout:120000});assert.equal(p.status,0,'fixture failed');return JSON.parse(p.stdout)}
function check(label,v){assert.ok(v,label);checks.push(label);console.log('PASS '+label)}
try{
 seed=fixture({mode:'seed'});const login=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:seed.user,password:seed.password})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 async function http(path,p){const r=await fetch(base+path,{headers:{cookie,'content-type':'application/json'},...(p?{method:'POST',body:JSON.stringify(p)}:{})});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.notEqual(b.ok,false);return b.result&&typeof b.result==='object'&&!b.id?b.result:b}
 const action=(name,payload)=>http('/api/platform/actions/'+name+'/execute',{payload,confirmed:true,idempotency_key:randomUUID()});
 const detail=async()=> (await http('/api/platform/services/mail.detail/invoke',{payload:{mail}})).mail;
 mail=(await action('mail.save_draft',{subject:seed.prefix+' undo','body':'<p>第一段原文</p><p>第二段原文</p>',body_format:'HTML',to:[],cc:[]})).name;
 dom=new JSDOM('<div id="editor"></div>',{url:base,runScripts:'outside-only'});const w=dom.window;w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js',import.meta.url),'utf8'));
 const editor=w.mailEditor.mountEditor(w.document.querySelector('#editor'),{value:(await detail()).body});
 async function save(){const d=await detail();return action('mail.save_draft',{mail,expected_version:d.record_version,body:editor.getHtml(),body_format:'HTML',subject:d.subject,to:d.to,cc:d.cc})}
 async function accept(body){
  const d=await detail();const code=`from shangshu_core.public_api import propose_registered_action\nfrappe.set_user(${JSON.stringify(seed.user)})\np=propose_registered_action('mail.save_draft',${JSON.stringify({mail,expected_version:d.record_version,subject:d.subject,to:d.to,cc:d.cc,body,body_format:'HTML'})},idempotency_key=${JSON.stringify(randomUUID())})\nfrappe.db.commit();RESULT['id']=p['id']`;
  const p=py('import json,sys;from test_process_provenance_live import console;print(json.dumps(console(json.load(sys.stdin))))',code);
  const review=await http('/api/platform/action-proposals/'+p.id+'/review');await http('/api/platform/action-proposals/'+p.id+'/accept',{op_id:randomUUID(),expected_review_revision:review.review_revision});const saved=await detail();await editor.applyEdit(saved.body,{actor:'assistant'});return p.id;
 }
 await editor.applyEdit('<p>本人改第一段</p><p>第二段原文</p>',{actor:'user'});await save();
 await accept('<p>本人改第一段</p><p>助手改第二段</p>');
 const undo=editor.undoDetailed();console.log('UNDO RECEIPT',JSON.stringify(undo),editor.getHtml());check('production editor withdraws own separate paragraph while keeping assistant paragraph',undo.undone>0&&editor.getHtml().includes('第一段原文')&&editor.getHtml().includes('助手改第二段'));
 await save();const saved=await detail();check('same real draft persists own inverse and accepted assistant paragraph',saved.body.includes('第一段原文')&&saved.body.includes('助手改第二段')&&saved.status==='Draft');
 await editor.applyEdit('<p>本人再次改第一段</p><p>助手改第二段</p>',{actor:'user'});await save();await accept('<p>助手覆盖第一段</p><p>助手改第二段</p>');
 const before=await detail(),html=editor.getHtml(),conflict=editor.undoDetailed();check('same paragraph conflict refused by production editor',conflict.undo_state==='rejected_conflict'&&conflict.undone===0&&editor.getHtml()===html);
 const after=await detail();check('refused inverse preserves real draft version and assistant body',after.record_version===before.record_version&&after.body===before.body);console.log('RESULT '+checks.length+'/'+checks.length);
}finally{dom?.window.close();if(seed){fixture({mode:'cleanup',fixture:seed,mails:mail?[mail]:[]});console.log('CLEANUP exact draft recycled and synthetic identities disabled')}}
