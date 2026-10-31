import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// ⚠️ **「一次读一个作用域」那个助手现在住在公共件**（2026-10-29 那次从 main.ts 拆出去）
//   ⇒ 抽出 main.ts 片段来跑的沙箱**拿不到**它 ⇒ 这里把真的那个放进沙箱。
import {createLatestRead} from '../../../lib/latest-read.mjs';
// ⚠️ 同样地，`personalColumnOrder` 现在住在 `personal-view.ts`（个人列序投影）。
import {personalColumnOrder} from '../src/personal-view.ts';
const main=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function clock(){const pending=new Map();let next=0;return {setTimeout(fn){pending.set(++next,fn);return next;},clearTimeout(id){pending.delete(id);},flush(){const work=[...pending.values()];pending.clear();work.forEach(fn=>fn());}};}
function scheduler(load,failed=()=>{}){
 const timers=clock(),context={exports:{},...timers};vm.createContext(context);
 vm.runInContext(ts.transpileModule(fs.readFileSync(new URL('../src/read-scheduler.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return {queue:new context.exports.ViewportReadScheduler(load,failed),timers};
}
test('rapid scrollbar drag requests only the final viewport, in visible-page order',async()=>{
 const calls=[];const {queue,timers}=scheduler(async p=>calls.push(p));
 for(let p=1;p<=155;p++)queue.schedule([p,p+1]);
 timers.flush();await tick();assert.deepEqual(calls,[155,156]);
});
test('inflight read stays bounded and pending intermediate ranges are replaced',async()=>{
 const first=deferred(),calls=[];let active=0,max=0;
 const {queue,timers}=scheduler(async p=>{calls.push(p);max=Math.max(max,++active);if(p===1)await first.promise;active--;});
 queue.schedule([1,2]);timers.flush();queue.schedule([40,41]);timers.flush();queue.schedule([155]);timers.flush();
 assert.deepEqual(calls,[1]);first.resolve();await tick();assert.deepEqual(calls,[1,155]);assert.equal(max,1);
});
test('failure can be retried and reset drops pending pages',async()=>{
 let attempt=0;const errors=[],calls=[];const {queue,timers}=scheduler(async p=>{calls.push(p);if(++attempt===1)throw Error('offline');},e=>errors.push(e.message));
 queue.schedule([3]);timers.flush();await tick();assert.deepEqual(errors,['offline']);queue.schedule([3]);timers.flush();await tick();
 queue.schedule([4,5]);queue.reset();timers.flush();await tick();assert.deepEqual(calls,[3,3]);
});
function pageHarness(){
 const pending=deferred(),calls=[],context={pageCache:new Map(),loadingPages:new Map(),pageGeneration:0,disposed:false,PAGE_LENGTH:100,totalRows:0,table:{loadPage:()=>{calls.push('read');return pending.promise;}},applyRows:(rows,base)=>calls.push(['paint',rows,base]),reapplyWrap:()=>{},renderProposals:()=>{}};
 vm.createContext(context);vm.runInContext(ts.transpileModule(main.slice(main.indexOf('  async function loadPage(pageNumber:'),main.indexOf('  /** Row-only')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {context,pending,calls};
}
test('same-page concurrent consumers await the real rows, then use cache',async()=>{
 const {context,pending,calls}=pageHarness();const a=context.loadPage(3),b=context.loadPage(3);assert.equal(calls.length,1);
 const rows=[{name:'row-201'}];pending.resolve({rows,total:500});assert.deepEqual(await a,rows);assert.deepEqual(await b,rows);await context.loadPage(3);assert.equal(calls.filter(c=>c==='read').length,1);assert.equal(calls[1][2],200);
});
test('response from previous table cannot paint/cache into reopened table',async()=>{
 const {context,pending,calls}=pageHarness();const read=context.loadPage(3);context.pageGeneration++;pending.resolve({rows:[{name:'old'}],total:500});await read;assert.equal(context.pageCache.size,0);assert.deepEqual(calls,['read']);
});
function searchHarness(){
 const timers=clock(),listeners={},calls=[],pending=deferred();
 const input={value:'专利',addEventListener:(name,fn)=>listeners[name]=fn};
 // ⚠️ `signal` 是**开表那层的信号**（模块作用域里的那一个）⇒ 抽出来的 `runSearch` 片段
 //   在真代码里能看见它，在这里看不见 ⇒ 沙箱里补一个。
 const context={...timers,createLatestRead,signal:new AbortController().signal,table:{},disposed:false,searchSeq:0,searchTerm:'',searchLoading:false,searchPage:0,searchTotalRows:0,searchLoadedRows:0,hits:[],hitIndex:-1,dropHighlight:null,el:{searchInput:input,searchClear:{},searchCount:{}},clearFind(){context.searchTerm='';context.searchSeq++;},renderFindBar(){},goToHit:async i=>calls.push(['hit',i]),async appendSearchPage(){calls.push(['search',context.searchTerm]);context.searchLoading=true;await pending.promise;context.searchLoading=false;return true;}};
 const start=main.indexOf('  async function runSearch(term:');const end=main.indexOf("  el.searchNext.addEventListener",start);
 vm.createContext(context);vm.runInContext(ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {context,timers,listeners,calls,pending,input};
}
test('input followed by Enter sends one request and repeated Enter reuses inflight search',async()=>{
 const {timers,listeners,calls,pending}=searchHarness();listeners.input();listeners.keydown({key:'Enter',preventDefault(){}});timers.flush();listeners.keydown({key:'Enter',preventDefault(){}});assert.deepEqual(calls,[['search','专利']]);pending.resolve();await tick();
});
test('rapid typing and IME composition produce only final committed search',async()=>{
 const {timers,listeners,calls,input,pending}=searchHarness();input.value='z';listeners.input();listeners.compositionstart();timers.flush();assert.equal(calls.length,0);input.value='专利';listeners.compositionend();listeners.input();timers.flush();assert.deepEqual(calls,[['search','专利']]);pending.resolve();await tick();
});
const backend=fs.readFileSync(new URL('../src/backend.ts',import.meta.url),'utf8');
test('opening xlsx and installing page one uses one authorized read; later refresh reads again',async()=>{
 const reads=[];const meta={tableId:'sheet-a',displayName:'表',columns:[{header:'编号',type:'text',readOnly:false}],contentVersion:7,structureVersion:2,totalRows:15500,columnWidths:{},writable:true};
 // ⚠️ `platformTableResource` 是**从 platform-catalog 导入的**（2026-10-29 那次把「表身份读取」
 //   拆了出去）⇒ 抽出来的 backend.ts 片段在沙箱里拿不到它 ⇒ 这里补一个：这张表是 xlsx。
 const context={fetch:async()=>({json:async()=>({list:[]})}),platformObjectList:async()=>({list:[]}),platformTableResource:async()=>'xlsx',personalColumnOrder,xlsxSource:{readPage:async(id,opts)=>{reads.push([id,opts.page,opts.pageLength]);return {meta,rows:[{rowId:'row-a',values:{编号:'00123'}}],total:15500};}},toUnifiedRow:row=>({name:row.rowId,...row.values})};
 const begin=backend.indexOf('function createXlsxTable('),end=backend.indexOf('// —— 统一入口的列表');
 vm.createContext(context);vm.runInContext(ts.transpileModule(backend.slice(begin,end).replace('export async function openTable','async function openTable'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 const table=await context.openTable('sheet-a');const page=await table.loadPage(1,100);assert.equal(reads.length,1);assert.equal(page.rows[0].编号,'00123');assert.equal(table.contentVersion,7);await table.loadPage(1,100);assert.equal(reads.length,2);
});
