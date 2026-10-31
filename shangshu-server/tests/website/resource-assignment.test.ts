import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountResourceAttribution} from '../../../shangshu-web/js/resource-attribution.mjs';
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';
const tick=()=>new Promise(r=>setTimeout(r,10));
function setup(respond?:(payload:any)=>any){
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'});const w=dom.window as any;w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 /* 归属是**公共组件**；本文件是经典脚本，JSDOM 里没法 dynamic import 浏览器路径 ——
    按公共件留的口子把同一件组件注入进去。 */
 w.mountResourceAttribution=mountResourceAttribution;
 const calls:any[]=[];let saved=0;
 w.fetch=async(url:string,options:any)=>{const body=JSON.parse(options.body);if(url.includes('/services/'))return {ok:true,json:async()=>({ok:true,people:[{user_name:'a@x',display_name:'甲'}],groups:[{department_id:'dep',department_name:'部门甲'}]})};calls.push(body);const p=body.payload;const result=respond?await respond(p):p.dry_run?{applied:false,resource:'f1',expected_modified:'v1',current:{level:'personal',owner_user:'old@x'},effects:[{user:'old@x',share:{before:true,after:false},assign:{before:true,after:false}}]}:{applied:true,modified:'v2'};return {ok:true,json:async()=>({ok:true,result})};};
 for(const file of ['tool-workspace.js','resource-assignment.js'])w.eval(readFileSync('../shangshu-web/js/'+file,'utf8'));
 const open=()=>w.openResourceAssignment({host:w.document.querySelector('#host'),resource:'f1',title:'测试表',onSaved:()=>{saved++}});
 return {w,dom,calls,open,get saved(){return saved}};
}
function select(w:any,selector:string,value:string){const el=w.document.querySelector(selector);el.value=value;el.dispatchEvent(new w.Event('change'));}
const click=async(w:any)=>{w.document.querySelector('[data-act="1"]').click();await tick()};
it('department clearing is explicit; preview version and a fresh confirm key go to action; common dialog',async()=>{const s=setup();await s.open();assert.ok(s.w.document.querySelector('dialog.os-dialog'));select(s.w,'[data-attribution-level]','department');select(s.w,'[data-attribution-department]','dep');await click(s.w);assert.equal(s.calls[0].payload.owner_user,'');assert.equal(s.calls[0].payload.dry_run,true);assert.match(s.w.document.querySelector('[data-preview]').textContent,/共享.*允许 → 不允许/);await click(s.w);assert.equal(s.calls[1].payload.expected_modified,'v1');assert.notEqual(s.calls[1].idempotency_key,s.calls[0].idempotency_key);assert.equal(s.saved,1);s.dom.window.close();});
it('changing target invalidates preview; personal empty blocked before request',async()=>{const s=setup();await s.open();await click(s.w);assert.equal(s.calls.length,0);select(s.w,'[data-owner]','a@x');await click(s.w);select(s.w,'[data-attribution-level]','department');select(s.w,'[data-attribution-department]','dep');await click(s.w);assert.equal(s.calls.length,2);assert.equal(s.calls[1].payload.dry_run,true);s.dom.window.close();});
it('lost confirmation response keeps frozen payload/key for retry and prevents closing',async()=>{let n=0;const s=setup(p=>{if(p.dry_run)return {applied:false,resource:'f1',expected_modified:'v1',effects:[]};if(++n===1)throw Error('connection lost');return {applied:true,modified:'v2'}});await s.open();select(s.w,'[data-owner]','a@x');await click(s.w);await click(s.w);assert.equal(s.saved,0);assert.equal(s.w.document.querySelector('[data-owner]').disabled,true);assert.equal(s.w.document.querySelector('[data-act="0"]').disabled,true);await click(s.w);assert.deepEqual(s.calls[1],s.calls[2]);assert.equal(s.saved,1);s.dom.window.close();});
it('malformed preview cannot execute; version is mandatory',async()=>{const s=setup(()=>({applied:false,resource:'f1',effects:[]}));await s.open();select(s.w,'[data-owner]','a@x');await click(s.w);await click(s.w);assert.ok(s.calls.every(x=>x.payload.dry_run===true));assert.equal(s.saved,0);assert.match(s.w.document.querySelector('[data-error]').textContent,/不完整/);s.dom.window.close();});
it('HTTP conflict clears prior preview, requiring renewed permission/version preview',async()=>{const s=setup();await s.open();select(s.w,'[data-owner]','a@x');await click(s.w);s.w.fetch=async()=>({ok:false,status:409,json:async()=>({ok:false,error:'归属已变化'})});await click(s.w);assert.equal(s.saved,0);assert.equal(s.w.document.querySelector('[data-owner]').disabled,false);assert.equal(s.w.document.querySelector('[data-act="1"]').textContent,'预览影响');s.dom.window.close();});
it('Excel directory exposes assignment independently from share and never infers native object assignment',async()=>{
 const {mountDirectory}=await import('../../../shangshu-web/js/domains/excel-univer/src/directory.ts');
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost'});const w=dom.window as any;const oldWindow=(globalThis as any).window;(globalThis as any).window=w;let invoked:any;
 w.openResourceAssignment=async(o:any)=>{invoked=o};
 const mounted=mountDirectory(w.document.querySelector('#host'),{load:async()=>({entries:[{key:'f1',title:'可移交不可共享',kind:'xlsx',canAssign:true,canShare:false},{key:'f2',title:'仅共享',kind:'xlsx',canAssign:false,canShare:true},{key:'obj',title:'原对象',kind:'db',canAssign:true}],total:3,truncated:false}),open(){},upload(){}});
 try{await tick();const buttons=[...w.document.querySelectorAll('button')].filter((b:any)=>b.textContent==='调整归属') as any[];assert.equal(buttons.length,1);buttons[0].click();assert.equal(invoked.resource,'f1');assert.equal(typeof invoked.onSaved,'function');}
 finally{mounted.dispose();(globalThis as any).window=oldWindow;w.close()}
});
it('file center real dataset honors can_assign independent of can_edit/share and refreshes after success',async()=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any;let opened:any,reads=0;
 w.RENDER={};w.currentRole=()=> 'admin';w.toast=()=>{};
 w.fetch=async(url:string)=>{if(url.includes('/datasets/'))reads++;return {ok:true,json:async()=>url.includes('/datasets/')?{rows:[{name:'f1',file_name:'负责人可移交',status:'Active',can_assign:true,can_share:false,can_edit:false},{name:'f2',file_name:'所有人可共享',status:'Active',can_assign:false,can_share:true}],total:2}:{directories:[],can_manage:false}}};
 // ⚠️ 2026-10-30（PKG-133）：`file-center.js` 读文件列表用的「一次读一个作用域」是
 //   **动态 import 的 ESM**（`import('./lib/latest-read.mjs')`）—— JSDOM 的 eval 里 import 不了
 //   ⇒ 读列表那条路直接炸 ⇒ 文件中心停在「交互样例」模式 ⇒ **真实数据集的表格根本不画**
 //   （`[data-assign]` 自然一个也没有）。
 //   仓库里已有这个口子（tests/helpers/browser-module-fixtures.ts，别的文件中心判据都在用）。
 for(const file of ['tool-workspace','file-detail','record-reference-picker','file-center'])w.eval(browserModuleSource(w,readFileSync('../shangshu-web/js/'+file+'.js','utf8')));
 w.openResourceAssignment=async(o:any)=>{opened=o};const controller=new w.AbortController();w.mountFileCenter(w.document.querySelector('#host'),{signal:controller.signal});
 try{await tick();assert.equal(w.document.querySelectorAll('[data-assign]').length,1);w.document.querySelector('[data-assign]').click();assert.equal(opened.resource,'f1');const before=reads;await opened.onSaved();assert.equal(reads,before+1);assert.ok(opened.signal);}
 finally{controller.abort();w.close()}
});
