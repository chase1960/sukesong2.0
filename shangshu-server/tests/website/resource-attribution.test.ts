import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountResourceAttribution} from '../../../shangshu-web/js/resource-attribution.mjs';

/* 归属控件（公共件）：部门要**翻完所有页**（少一页就选不到那个部门），
   提交给后端的只有选中的那个值（不多带别的）。
   PKG-016 之后归属是**摊开式** —— 点选项卡就切档、挑中部门就落值，
   没有「点触发按钮 → 弹一扇窗 → 确定」那套了。 */
test('新建和上传共用归属控件，获权部门完整分页且仅提交选择值',async()=>{
 const dom=new JSDOM('<main></main>',{url:'http://localhost/',runScripts:'outside-only'}),urls:string[]=[];
 const w=dom.window as any;
 w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js',import.meta.url),'utf8'));
 try{
  const host=w.document.querySelector('main')!;
  const ui=w.createToolWorkspace(host);
  const picker=mountResourceAttribution(host,{defaultLevel:'personal',ui,fetcher:async(url)=>{
   urls.push(String(url));const second=new URL(String(url),'http://localhost').searchParams.get('page')==='2';
   return {ok:true,json:async()=>({rows:second?[{name:'authorized-2',title:'二部'}]:[{name:'authorized-1',title:'一部'}],total:2})} as Response;
  }});
  assert.deepEqual(picker.read(),{ok:true,value:{level:'personal'}});
  await picker.load();assert.equal(urls.length,2);assert.ok(urls.every(u=>JSON.parse(new URL(u,'http://localhost').searchParams.get('filters')!).enabled===1));
  // 摊开式：点「获权部门」切档 → 挑第二页那个部门（挑中即生效，没有「确定」那一步）
  const tab=[...host.querySelectorAll('[data-attribution-tab]')].find(b=>(b.textContent||'').includes('获权部门'))!;
  tab.dispatchEvent(new w.Event('click'));
  const option=host.querySelector('[data-attribution-dept-value="authorized-2"]');
  assert.ok(option,'第二页的部门没进候选列表（分页没翻完）');
  option.dispatchEvent(new w.Event('click'));
  assert.deepEqual(picker.read(),{ok:true,value:{level:'department',department:'authorized-2'}});
  picker.lock(true);assert.ok(picker.level.disabled&&picker.department.disabled);picker.reset('');assert.equal(picker.read().ok,false);
 }finally{dom.window.close();}
});
