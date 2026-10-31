import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {readSignal} from '../../src/adapters/web/client-abort.ts';
const source=readFileSync(new URL('../../src/adapters/web/platform.ts',import.meta.url),'utf8');
// 取传输层那段源码（`class PlatformError` 到**第一个** `export` 之前）。
// ⚠️ 边界不能写死成某个具体的导出函数名：PKG-015-T01 在这段中间加了
// `export async function readPlatformService`，写死边界就会把它一起切进来 ——
// 切进来的是带 `export` 的 ESM 源码，vm 里 eval 直接 SyntaxError（实测 5 条全红）。
// 判据要的是**传输层的行为**（CSRF 获取/复用/不缓存），不是某个导出函数的位置。
const transportStart=source.indexOf('class PlatformError');
const transportEnd=source.indexOf('\nexport ',transportStart);
const transport=source.slice(transportStart,transportEnd);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({failCsrf=false,failPost=false}={}){
 const gets=[],posts=[],probes=[],current=new Map();let next=0;
 const context={createHash,URLSearchParams,AbortSignal,readSignal,process:{env:{FRAPPE_UPSTREAM:'http://site-a'}},METHOD:{csrf:'csrf',session:'public_api.http.session'},fetch:async(url,options)=>{
  const method=String(options?.method||'GET').toUpperCase();
  const cookie=options.headers.cookie,key=url.split('/api/')[0]+'|'+cookie;
  if(url.endsWith('/csrf')){
   gets.push({url,cookie});const token='csrf-'+(++next);
   await tick();
   if(failCsrf){failCsrf=false;return new Response(JSON.stringify({exc_type:'PermissionError',message:'denied'}),{status:403});}
   // Frappe first-token initialization has no session lock: parallel GETs can each set a token.
   current.set(key,token);await tick();
   return new Response(JSON.stringify({message:{csrf_token:token}}));
  }
  // ⚠️ 2026-10-24 12:5x（PKG-085）：产品 2026-10-22（`de27ad9f9`）在 403 之后加了
  //   **会话探针**（`platformSessionGone`：多问一句「你是谁」，判登录态还在不在）——
  //   那是一条 **GET**（`public_api.http.session`），**不写任何东西**。
  //   桩原来把**任何**非 /csrf 的请求都记成 POST ⇒ 探针被算成「发了写请求」，
  //   「失败绝不执行 POST」那条断言被误伤（实测 posts=1、期望 0）。
  //   ⇒ 按 method 分流：只有非 GET 才算 POST；GET 单独记进 probes。
  if(method==='GET'){
   probes.push({url,cookie});
   return new Response(JSON.stringify({message:{user_name:'probe-user'}}));
  }
  posts.push({url,cookie,token:options.headers['x-frappe-csrf-token']});
  if(failPost||options.headers['x-frappe-csrf-token']!==current.get(key))
   return new Response(JSON.stringify({exc_type:'CSRFTokenError',message:'Invalid Request'}),{status:400});
  return new Response(JSON.stringify({message:{ok:true}}));
 }};
 vm.createContext(context);vm.runInContext(stripTypeScriptTypes(transport,{mode:'transform'}),context);
 const request=(cookie='sid=session-a')=>context.frappePost('service', {headers:{cookie}}, {payload:{}});
 return {request,gets,posts,probes,context};
}
test('new-session parallel POSTs share CSRF initialization and each POST executes once',async()=>{
 const h=harness();const results=await Promise.allSettled([h.request(),h.request(),h.request()]);
 assert.equal(h.gets.length,1);assert.ok(results.every(r=>r.status==='fulfilled'));assert.equal(h.posts.length,3);
});
test('different sessions and upstream sites never share CSRF acquisition',async()=>{
 const h=harness();await Promise.all([h.request('sid=a'),h.request('sid=b')]);assert.equal(h.gets.length,2);
 const a=h.request('sid=a');h.context.process.env.FRAPPE_UPSTREAM='http://site-b';const b=h.request('sid=a');
 await Promise.all([a,b]);assert.equal(h.gets.length,4);
});
test('failed CSRF acquisition is released for a later request; failure never executes POST',async()=>{
 const h=harness({failCsrf:true});const results=await Promise.allSettled([h.request(),h.request()]);
 assert.ok(results.every(r=>r.status==='rejected'));assert.equal(h.gets.length,1);assert.equal(h.posts.length,0);
 // 403 之后只多问了一句「你是谁」——**只读 GET**（身份口），不写任何东西。
 assert.equal(h.probes.length,1,'只多问了一句身份');
 assert.match(h.probes[0].url,/public_api\.http\.session/,'探针走的是身份口');
 await h.request();assert.equal(h.gets.length,2);assert.equal(h.posts.length,1);
});
test('POST CSRF rejection is not retried or replayed',async()=>{
 const h=harness({failPost:true});await assert.rejects(h.request());assert.equal(h.gets.length,1);assert.equal(h.posts.length,1);
});
test('successful acquisition is not retained as a session/auth cache',async()=>{
 const h=harness();await h.request();await h.request();assert.equal(h.gets.length,2);assert.equal(h.posts.length,2);
});
