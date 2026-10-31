import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {JSDOM} from 'jsdom';

function fixture() {
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window as any, host=w.document.querySelector('#host') as HTMLElement;
  new Script('const RENDER={}; window.routeExcel=page=>RENDER.excel(page)').runInContext(dom.getInternalVMContext());
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/excel-loader.js',import.meta.url),'utf8'));
  const controller=new w.AbortController();
  return {dom,w,host,controller,route:()=>w.routeExcel({host,signal:controller.signal}),script:()=>w.document.querySelector('script'),
    close:()=>{controller.abort();dom.window.close();}};
}

test('重脚本尚未返回时已有工具栏、表头、网格占位；不预造记录',async()=>{
  const h=fixture();
  try {
    const pending=h.route();
    assert.equal(h.host.getAttribute('aria-busy'),'true');
    assert.ok(h.host.querySelector('.excel-loading-toolbar'));
    assert.ok(h.host.querySelector('[data-loading-headers]'));
    assert.ok(h.host.querySelector('[data-loading-grid]'));
    assert.equal(h.host.querySelector('[data-loading-grid]')?.textContent,'');
    assert.match(h.host.textContent||'',/正在加载表格组件/);
    assert.equal(h.w.document.querySelectorAll('script').length,1);
    let mounts=0;h.w.shangshuMountExcelPage=()=>{mounts++;};
    h.script().dispatchEvent(new h.w.Event('load'));await pending;
    assert.equal(mounts,1);
  } finally {h.close();}
});

test('脚本下载或版本加载失败原位给重试，重试真正重新请求脚本',async()=>{
  for(const event of ['error','load']) {
    const h=fixture();
    try {
      const pending=h.route();h.script().dispatchEvent(new h.w.Event(event));await pending;
      assert.equal(h.host.getAttribute('aria-busy'),'false');
      assert.equal(h.host.querySelector('[data-open-loading]'),null);
      assert.ok(h.host.querySelector('[role="alert"]')?.textContent);
      const retry=h.host.querySelector<HTMLButtonElement>('[data-loader-retry]');assert.ok(retry);
      retry.click();
      assert.equal(h.host.getAttribute('aria-busy'),'true');
      assert.ok(h.host.querySelector('[data-open-loading]'));
      assert.equal(h.w.document.querySelectorAll('script').length,1);
      let mounts=0;h.w.shangshuMountExcelPage=()=>{mounts++;};
      h.script().dispatchEvent(new h.w.Event('load'));await new Promise(resolve=>setImmediate(resolve));
      assert.equal(mounts,1);
    }finally{h.close();}
  }
});

test('同容器已切到新请求时，旧请求abort和迟到响应不清新骨架、不重复挂载',async()=>{
  const h=fixture(), second=new h.w.AbortController();
  try{
    const first=h.route();
    const next=h.w.routeExcel({host:h.host,signal:second.signal});
    h.controller.abort();
    assert.equal(h.host.getAttribute('aria-busy'),'true');
    assert.equal((h.host.querySelector('[data-open-loading]') as HTMLElement).hidden,false);
    let mounts=0;h.w.shangshuMountExcelPage=()=>{mounts++;};
    h.script().dispatchEvent(new h.w.Event('load'));await Promise.all([first,next]);
    assert.equal(mounts,1);
  }finally{second.abort();h.close();}
});
