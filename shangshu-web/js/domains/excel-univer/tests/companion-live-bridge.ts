/** Real frontend adapter -> real 3850 HTTP. fetch wrapper supplies browser URL/cookies only. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openTable} from '../src/backend.ts';
const root=resolve(import.meta.dirname,'../../../../..');
const base='http://127.0.0.1:3850';
const handle=resolve(root,'docs/reports/r967-20261019/ui028-bridge-'+randomUUID()+'.json');
const fixtureScript=resolve(root,'shangshu-server/scripts/tests/prepare_object_companion_browser.py');
const nativeFetch=globalThis.fetch;const cookies=new Map<string,string>();const requests:{path:string;status:number}[]=[];
function python(args:string[]){return execFileSync('python3',args,{cwd:root,encoding:'utf8',maxBuffer:2e6});}
// The existing credentials helper reads this dedicated runtime; never print the secret.
const password=python(['-c',"import sys;sys.path.insert(0,'shangshu-server/scripts/tests');from _ss_cred import admin_pw_for;print(admin_pw_for('http://127.0.0.1:3850'),end='')"]);
globalThis.fetch=async(input:any,init:any={})=>{
 const url=new URL(typeof input==='string'?input:input.url,base);assert.equal(url.origin,base);
 const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));
 const response=await nativeFetch(url,{...init,headers});
 for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0];const split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}
 requests.push({path:url.pathname,status:response.status});return response;
};
let prepared=false;
try{
 const login=await fetch('/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'Administrator',password})});assert.equal(login.status,200);assert.equal((await login.json()).ok,true);
 python([fixtureScript,'prepare','--handle',handle]);prepared=true;const f=JSON.parse(readFileSync(handle,'utf8'));console.log('FIXTURE',f.object_id,f.file_id);
 const table=await openTable(f.object_id);assert.equal(table.resourceId,f.file_id);assert.equal(table.key,f.object_id);
 const initial=await table.loadPage(1,100);assert.equal(initial.rows.length,2);const before=structuredClone(initial.rows);
 const amount=table.columns.findIndex(c=>c.fieldId==='金额');assert.ok(amount>=0);assert.equal(table.columns[amount+1].fieldId,'备注');
 const stale=await openTable(f.object_id);await stale.loadPage(1,100);
 const op='bridge-'+randomUUID();const result=await table.pasteApply!({startRow:0,startCol:amount,matrix:[['101','桥接备注甲'],['202','桥接备注乙']],opId:op});
 assert.equal(result.undoAction,'companion');assert.equal(result.actionCount,1);
 const changed=await table.loadPage(1,100);assert.deepEqual(changed.rows.map(r=>[r['金额'],r['备注']]),[[101,'桥接备注甲'],[202,'桥接备注乙']]);
 console.log('PASS actual openTable load -> companion mixed HTTP -> adapter readback');
 // A second adapter still holds the original displayed versions. Real server rejects it.
 const checkpoint=JSON.stringify(changed.rows);const requestStart=requests.length;
 await assert.rejects(stale.pasteApply!({startRow:0,startCol:amount,matrix:[['909','不得保存']],opId:'stale-'+randomUUID()}));
 assert.ok(requests.slice(requestStart).some(r=>r.path.includes('companion_write')&&r.status>=400));
 assert.equal(JSON.stringify((await table.loadPage(1,100)).rows),checkpoint);
 console.log('PASS stale frontend command receives real error receipt; no partial update');
 const undo=table.companionUndoRequest!(op);
 const response=await fetch(undo.path,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({payload:undo.payload,confirmed:true,idempotency_key:'bridge-undo-'+op,source:'user'})});
 const receipt=await response.json();assert.equal(response.status,200,JSON.stringify(receipt));assert.ok(receipt.result?.cells);
 table.adoptVersions?.({contentVersion:receipt.result.content_version,structureVersion:receipt.result.structure_version});
 const restored=await table.loadPage(1,100);
 assert.deepEqual(restored.rows.map(r=>[r.name,r['事项'],r['金额'],r['备注']]),before.map(r=>[r.name,r['事项'],r['金额'],r['备注']]));
 console.log('PASS frontend companionUndoRequest -> actual HTTP -> restored adapter readback');
 console.log('RESULT PASS real frontend/backend bridge; no mocked responses; HTTP calls',requests.length);
}finally{
 globalThis.fetch=nativeFetch;
 if(prepared||existsSync(handle)){python([fixtureScript,'cleanup','--handle',handle]);console.log('CLEANUP',handle);}
}
