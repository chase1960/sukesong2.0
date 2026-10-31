// Actual product JS + actual BFF HTTP; JSDOM supplies only DOM events/layout.
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const base=process.env.SS_BASE||'http://127.0.0.1:3850', files=[];
function fixture(request){const run=spawnSync('python3',[fileURLToPath(new URL('./resource-assignment-fixture.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env,SS_BASE:base},timeout:120000});if(run.status!==0)throw Error('Fixture helper failed (credential-bearing output suppressed)');return JSON.parse(run.stdout);}
async function login(username,password){const r=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200,'synthetic login');const cookies=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return async(path,opts={})=>fetch(new URL(path,base),{...opts,headers:{...opts.headers,cookie:cookies}});}
async function json(http,path,payload){const r=await http(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();assert.ok(r.ok&&d.ok!==false,'HTTP '+r.status+' '+(d.error||path));return d.result||d;}
const checks=[];function check(name,condition){assert.ok(condition,name);checks.push(name);console.log('PASS '+name);}
async function waitUntil(test){const end=Date.now()+30000;while(!test()){if(Date.now()>end)throw Error('DOM action timeout');await new Promise(r=>setTimeout(r,30));}}
async function transfer(http,resource,target){const dom=new JSDOM('<div id="host"></div>',{url:base,runScripts:'outside-only'}),w=dom.window;let saved=false;const calls=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(path,options)=>{if(path.includes('/actions/'))calls.push(JSON.parse(options.body));return http(path,options)};
 for(const f of ['tool-workspace.js','resource-assignment.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+f,import.meta.url),'utf8'));
 try{await w.openResourceAssignment({host:w.document.querySelector('#host'),resource,title:'独立归属桥接',onSaved:()=>{saved=true}});
 const select=(s,v)=>{const el=w.document.querySelector(s);el.value=v;el.dispatchEvent(new w.Event('change'));assert.equal(el.value,v,'real option exists')};
 check('real directory includes synthetic target',!!w.document.querySelector('[data-owner] option[value="'+target.user+'"]'));
 select('[data-level]',target.level);if(target.level==='department')select('[data-dept]',target.department);select('[data-owner]',target.clear?'':target.user);
 w.document.querySelector('[data-act="1"]').click();await waitUntil(()=>!w.document.querySelector('[data-act="1"]').disabled);
 assert.equal(w.document.querySelector('[data-error]').textContent,'');check('real preview exposes permission impact',!w.document.querySelector('[data-preview]').hidden);
 w.document.querySelector('[data-act="1"]').click();await waitUntil(()=>saved||!!w.document.querySelector('[data-error]')?.textContent);
 check('real confirm succeeded',saved);check('token-bound fresh confirmation request',calls.length===2&&calls[0].payload.dry_run===true&&calls[1].payload.dry_run===false&&!!calls[1].payload.expected_modified&&calls[0].idempotency_key!==calls[1].idempotency_key);
 }finally{w.close();}}
let seed;
try{
 seed=fixture({mode:'seed'});const old=await login(seed.users.old,seed.password),next=await login(seed.users.new,seed.password),head=await login(seed.users.head,seed.password);
 const created=await json(old,'/api/platform/actions/files.create/execute',{payload:{file_name:seed.prefix+'.xlsx',attribution:{level:'personal',owner_user:seed.users.old}},confirmed:true,idempotency_key:randomUUID()});const fid=created.file;assert.ok(fid);files.push(fid);
 await transfer(old,fid,{level:'personal',user:seed.users.new});
 const read=async http=>json(http,'/api/platform/services/files.versions/invoke',{payload:{file:fid}});
 const own=await read(next);check('detail confirms new personal owner and assignment/share rights',own.file.attribution.owner_user===seed.users.new&&own.file.can_assign===true&&own.file.can_share===true);
 const denied=await old('/api/platform/services/files.versions/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{file:fid}})});check('old owner detail no longer readable',!denied.ok);
 await transfer(next,fid,{level:'department',department:seed.department,user:seed.users.new,clear:true});
 const managed=await read(head);check('detail confirms department and explicit empty manager',managed.file.attribution.department===seed.department&&!managed.file.attribution.owner_user);check('head assignment does not grant sharing/edit',managed.file.can_assign===true&&managed.file.can_share===false&&managed.file.can_edit===false);
 console.log('RESULT '+checks.length+'/'+checks.length+'; file='+fid+'; synthetic prefix='+seed.prefix);
}finally{if(seed){const clean=fixture({mode:'cleanup',fixture:seed,files});assert.equal(clean.cleaned,true);console.log('PASS exact fixtures recycled/disabled; audit retained');}}
