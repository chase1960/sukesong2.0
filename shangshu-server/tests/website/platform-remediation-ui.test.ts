import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/**
 * 数据页的**两栏浏览**那一路（骨架③）：「留在这张表上」的那些数据集。
 * ⚠️ **契约变化（2026-10-25 用户口径）**：带 `object_id` 的表（受管对象／原生表）
 *   点进去**直达 Excel 工作面**（real-objects.js：「显式 && selected.object_id ⇒ 直达那一页」），
 *   那一路**不画表格**；留在数据页上的，是**没有 object_id 的数据集投影**。
 *   ⇒ 这条判据按新口径拆成两半，各钉各的那件事（行为保证一条没减）：
 *   ① 旧请求不覆盖新数据集（两栏浏览这一路的竞态）；
 *   ② 记录能打开详情及关联事项（详情弹窗这一路）。
 */
function dataPageWindow(datasets:any[],api:(url:string)=>any){
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'http://local.test'});
  const w=dom.window as any;
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],
    esc:(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),ICONS:{spark:''},currentUserInfo:{role:'admin'},chatAssist:()=>{},money:String,go:(route:string)=>w.lastRoute=route,toast:()=>{},api});
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
  return {dom,w};
}
test('数据页：旧请求不覆盖新数据集',async()=>{
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  let release:any;
  // 留在数据页上的数据集 = **没有 object_id 的投影**（带 object_id 的直达 Excel 工作面）。
  const datasets=[{id:'a',name:'a',columns:[{field:'name',label:'编号'}]},{id:'b',name:'b',columns:[{field:'name',label:'编号'}]}];
  const {dom,w}=dataPageWindow(datasets,(url:string)=>{
    if(url==='/api/platform/datasets')return {ok:true,json:async()=>({list:datasets})};
    if(url.includes('/datasets/a/records'))return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({rows:[{name:'old-a'}],total:1})}));
    if(url.includes('/datasets/b/records'))return {ok:true,json:async()=>({rows:[{name:'new-b'}],total:1})};
    throw Error('unexpected '+url);
  });
  try{
    const render=w.RENDER.objects({isActive:()=>true});await tick();
    w.document.querySelector('[data-dataset="b"]').click();await tick();
    release();await render;await tick();
    assert.ok(w.document.querySelector('.dataset-work').textContent.includes('new-b'),w.document.querySelector('.dataset-work').textContent);
    assert.ok(!w.document.querySelector('.dataset-work').textContent.includes('old-a'));
  }finally{dom.window.close();}
});
test('数据页：记录能打开详情及关联事项',async()=>{
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const datasets=[{id:'b',object_id:'b',name:'b',columns:[{field:'name',label:'编号'}]}];
  const {dom,w}=dataPageWindow(datasets,(url:string)=>{
    if(url==='/api/platform/datasets')return {ok:true,json:async()=>({list:datasets})};
    if(url.includes('/datasets/b/records'))return {ok:true,json:async()=>({rows:[{name:'new-b'}],total:1})};
    if(url.includes('/objects/b/records/new-b'))return {ok:true,json:async()=>({object:{name:'记录',fields:[{id:'name',label:'编号'}]},record:{name:'new-b'},processes:[{name:'PROC-1'}],actions:[]})};
    throw Error('unexpected '+url);
  });
  try{
    const render=w.RENDER.objects({isActive:()=>true});await tick();
    await render;await tick();
    w.document.querySelector('[data-record]').click();await tick();
    assert.ok(w.document.querySelector('dialog').textContent.includes('new-b'));
    w.document.querySelector('[data-record-processes] button').click();
    assert.equal(w.lastRoute,'flowdesign');
    assert.equal(JSON.parse(w.sessionStorage.getItem('shangshu.process.intent')).instance.name,'PROC-1');
  }finally{dom.window.close();}
});

test('员工报销入口只说明操作和结果，不展示内部识别工具选择规则',()=>{
  const dom=new JSDOM('<main id="main"><div id="pf-surface"></div></main>',{runScripts:'outside-only',url:'http://local.test'});
  const w=dom.window as any;
  Object.assign(w,{RENDER:{},$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)]});
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/finance-process.js',import.meta.url),'utf8'));
    const adapter=w.shangshuProcessAdapters['finance.expense']({main:w.document.querySelector('main')});
    adapter.launch();
    const dialog=w.document.querySelector('dialog');
    assert.match(dialog.textContent,/上传发票.*核对.*报销/);
    assert.doesNotMatch(dialog.textContent,/OCR|候选工具|视觉识别/);
  }finally{dom.window.close();}
});
