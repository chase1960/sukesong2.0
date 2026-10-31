import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {Script} from 'node:vm';

it('Excel 编辑器不进入全站首屏；打开时单飞加载、离页不写回',async()=>{
  const base=new URL('../../../shangshu-web/js/domains/excel-univer/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('domain-entry.json',base),'utf8'));
  assert.deepEqual(manifest.entry,['excel-loader.js']);
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window as any;let mounted=0;
  // 与生产 app.js 一样使用词法路由表；不能用 window.RENDER 掩盖接入错误。
  new Script('const RENDER={}; window.testRoute=page=>RENDER.excel(page)').runInContext(dom.getInternalVMContext());
  w.shangshuRegisterPages=()=>{};w.shangshuRegisterNav=()=>{};
  w.eval(readFileSync(new URL('excel-loader.js',base),'utf8'));
  assert.equal(w.document.querySelectorAll('script').length,0);
  const controller=new w.AbortController();
  const pending=w.testRoute({host:w.document.querySelector('#host'),signal:controller.signal});
  const scripts=w.document.querySelectorAll('script');assert.equal(scripts.length,1);
  controller.abort();w.shangshuMountExcelPage=()=>mounted++;
  scripts[0].dispatchEvent(new w.Event('load'));await pending;
  assert.equal(mounted,0);
  await w.testRoute({host:w.document.querySelector('#host'),signal:new w.AbortController().signal});
  assert.equal(mounted,1);assert.equal(w.document.querySelectorAll('script').length,1);
  dom.window.close();
});
