import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('侧栏、同页重绘和已变化的 hash 均先询问离页守卫，拒绝不销毁页面且恢复地址',async()=>{
  const dom=new JSDOM('<aside id="side"></aside><main id="main" class="main"></main>',{runScripts:'outside-only',url:'https://local.test/index.html#/sheets'}),w=dom.window as any;
  let dirty=false,first:any;
  Object.assign(w,{$:(s:string)=>w.document.querySelector(s),$$:(s:string)=>[...w.document.querySelectorAll(s)],curMod:'sheets',lastBusinessMod:'sheets',glassHoverItem:null,
    resolvePage:(s:string)=>['sheets','mail','dash'].includes(s)?s:null,
    revealSideGroupFor:()=>{},ensureAiBusinessLayer:()=>{},updateSideGlass:()=>{},scheduleSideGlassSettle:()=>{},closeSideDrawer:()=>{},
    RENDER:{sheets:(page:any)=>{first=page;page.host.textContent='未保存输入';},mail:(page:any)=>{page.host.textContent='邮箱';},dash:(page:any)=>{page.host.textContent='工作台';}},
    /* 「去开某张表」那一跳的标记（app.js 的模块级变量；这一段切片里没有它们的声明） */
    openingTable:false,openingTableNavMod:null});
  try{
    const code=readFileSync(new URL('../../../shangshu-web/js/app.js',import.meta.url),'utf8');
    w.eval(code.slice(code.indexOf('let pageRenderGeneration'),code.indexOf('/* #main 外壳')));
    w.addEventListener('shangshu:before-page-change',(e:Event)=>{if(dirty)e.preventDefault();});
    await w.go('sheets');dirty=true;const original=first;
    await w.go('mail');assert.equal(w.curMod,'sheets');assert.equal(original.signal.aborted,false);
    await w.go('sheets');assert.equal(first,original,'同页重绘也会丢稿，必须守卫');
    w.history.replaceState(null,'','?application=wrong#/mail');
    await w.go('mail');assert.equal(w.location.hash,'#/sheets');assert.equal(w.location.search,'');
    assert.equal(w.document.querySelector('#main').textContent,'未保存输入');
    dirty=false;await w.go('mail');assert.equal(original.signal.aborted,true);assert.equal(w.curMod,'mail');
  }finally{dom.window.close();}
});
