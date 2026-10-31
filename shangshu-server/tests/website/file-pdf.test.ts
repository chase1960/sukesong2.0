import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const pause=()=>new Promise(r=>setTimeout(r,25));
function setup(options:any={}){
  const dom=new JSDOM('<div id="pdf"></div>',{runScripts:'outside-only',url:'https://example.test/'}),w=dom.window as any;
  const pages:number[]=[],renders:any[]=[],calls:any[]=[];let destroyed=0,cancelled=0;
  w.HTMLCanvasElement.prototype.getContext=()=>({});
  const doc={numPages:3,async getPage(n:number){pages.push(n);return {getViewport:({scale}:any)=>({width:600*scale,height:800*scale}),render(p:any){renders.push(p);return {promise:Promise.resolve(),cancel(){cancelled++;}};},async getTextContent(){return {items:options.items||[{str:n===2?'采购说明 数量230':'普通正文'+n}]};},cleanup(){}};}};
  const lib={GlobalWorkerOptions:{},getDocument(config:any){calls.push(config);return {promise:options.failure?Promise.reject(Error('bad')):Promise.resolve(doc),destroy(){destroyed++;return Promise.resolve();}};}};
  w.eval(readFileSync(new URL('../../../shangshu-web/js/file-pdf.mjs',import.meta.url),'utf8').replace('export function mountPdf','window.mountPdf = function'));
  const dispose=w.mountPdf(w.document.querySelector('#pdf'),{url:'blob:pdf',name:'验收.pdf',current:()=>true,loadLibrary:async()=>lib,...options});
  return {w,dom,dispose,pages,renders,calls,get destroyed(){return destroyed;},close(){dispose();dom.window.close();}};
}
it('PDF不依赖原生插件，按页渲染、翻页缩放且没有写接口',async()=>{
  const t=setup();try{await pause();assert.equal(t.w.document.querySelectorAll('canvas').length,1);assert.deepEqual(t.pages,[1]);
    assert.equal(t.calls[0].isEvalSupported,false);assert.equal(t.calls[0].enableXfa,false);assert.match(t.calls[0].cMapUrl,/^\/vendor\//);
    t.w.document.querySelector('[data-pdf-next]').click();await pause();assert.deepEqual(t.pages,[1,2]);
    const zoom=t.w.document.querySelector('[data-pdf-zoom]');zoom.value='150';zoom.dispatchEvent(new t.w.Event('change'));await pause();assert.equal(t.renders.at(-1).viewport.width,900);
    /* ⚠️ **契约变化（2026-10-28 凌晨 · PKG-132）**：页码/总页数**只在工具条上出现一次**
       （用户 20:2x 原话：「无重复『第1/1页·只读原件』整行」）⇒
       状态位**不再**重复「第 X / Y 页」那一行（画完一页后**让位给正文**）。
       ⇒ 这条判据跟着改口径：**页码看工具条**，状态位不许重复。 */
    assert.equal(t.w.document.querySelector('[data-pdf-count]').textContent,'/ 3','总页数没显示在工具条上');
    assert.equal(t.w.document.querySelector('[data-pdf-page]').value,'2','工具条上的当前页码不对');
    assert.equal(t.w.document.querySelector('[data-pdf-status]').textContent.trim(),'','状态位又重复了一遍页码那一行');
  }finally{t.close();}
});
it('文字搜索给出可跳转页和摘要；没有文字不谎称OCR结果',async()=>{
  const t=setup();try{await pause();t.w.document.querySelector('[data-pdf-query]').value='数量230';t.w.document.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));await pause();
    const hit=t.w.document.querySelector('[data-pdf-hit]');assert.ok(hit);assert.match(hit.textContent,/第 2 页.*数量230/);hit.click();await pause();assert.equal(t.w.document.querySelector('[data-pdf-page]').value,'2');
    t.w.document.querySelector('[data-pdf-query]').value='不存在';t.w.document.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));await pause();assert.match(t.w.document.querySelector('[data-pdf-results]').textContent,/未找到.*扫描件/);
  }finally{t.close();}
});
it('PDF损坏时明确失败；卸载销毁worker；迟到解析不写回旧视图',async()=>{
  const failed=setup({failure:true});await pause();assert.match(failed.w.document.querySelector('[data-pdf-status]').textContent,/无法.*下载原件/);failed.close();assert.ok(failed.destroyed);
  let resolve:any;const t=setup({loadLibrary:()=>new Promise(r=>{resolve=r;})});t.dispose();resolve({getDocument(){throw Error('不应解析');}});await pause();assert.equal(t.w.document.querySelector('canvas'),null);t.close();
});
it('PDF子集字体分批绘制时按可见位置还原同一行，中文短语仍可查找',async()=>{
  const t=setup({items:[{str:'采 ',transform:[12,0,0,12,10,700],width:12},{str:'数量',transform:[12,0,0,12,34,700],width:24},{str:'购  ',transform:[12,0,0,12,22,700],width:12}]});
  try{await pause();
    // ⚠️ **这件事换了个地方做**：本页的**文字层**已从界面上撤掉（2026-10-28 09:38，
    //   产品原话：「留着它只会白抽一遍没人看的文字」）⇒ 页面上不再有 `.file-pdf-text`。
    //   「**按可见位置还原同一行**」这件事现在由**文字查找**那条路承担
    //   （file-pdf.mjs 的 `textOf`：按 transform 的 y 分行、按 x 排序、抹掉汉字之间的空格）。
    //   ⇒ 这条判据改盯**真正在做这件事的那一处**：能不能按读法搜到「采购数量」这一串。
    //   （为什么这一搜能证明还原对了：内容流顺序是「采 」「数量」「购  」，不按位置还原的话
    //     拼出来是「采数量购」，**搜不到**「采购数量」。）
    assert.equal(t.w.document.querySelector('.file-pdf-text'),null,'本页不再画文字层（免得白抽一遍没人看的文字）');
    t.w.document.querySelector('[data-pdf-query]').value='采购数量';t.w.document.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));await pause();
    const hit=t.w.document.querySelector('[data-pdf-hit]');assert.ok(hit,'按可见位置还原成「采购数量」之后，这一串要搜得到');
    assert.match(hit.textContent,/采购数量/,'命中那一条里要能看到还原后的「采购数量」');
  }finally{t.close();}
});
