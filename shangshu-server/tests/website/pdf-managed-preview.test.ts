import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';
const pause=()=>new Promise(r=>setTimeout(r,20));
it('PDF page preview preserves binding and clears revoked page without original download',async()=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any,calls:any[]=[];
 w.fetch=async(url:string,init:any)=>{
  calls.push({url,payload:JSON.parse(init.body).payload});assert.match(url,/platform.file.pdf_page/);const page=calls.at(-1).payload.page;
  return {ok:page===1,status:page===1?200:403,json:async()=>page===1?{result:{page:1,page_count:2,mime_type:'image/png',image_base64:'iVBORw0KGgo='}}:{ok:false,error:'当前预览权限已撤销'}};
 };
 installToast(w);for(const name of ['tool-workspace','file-detail'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${name}.js`,import.meta.url),'utf8'));
 const ui=w.createToolWorkspace(w.document.querySelector('#host'));
 try{
  await w.openFileCenterDetail({ui,file:{name:'布局.pdf'},reference:{doctype:'Shangshu File Center File',name:'f1',file:'v1'}});await pause();
  assert.match(w.document.querySelector('[data-file-visual] img').src,/^data:image\/png;base64,/);assert.equal(w.document.querySelector('iframe'),null);
  assert.match(w.document.querySelector('[data-file-visual]').textContent,/第 1 \/ 2 页/);
  assert.deepEqual(calls[0].payload,{ref_doctype:'Shangshu File Center File',ref_name:'f1',file:'v1',page:1});
  const next=[...w.document.querySelectorAll('.file-pdf-toolbar button')].find((b:any)=>b.textContent==='下一页') as any;next.click();await pause();
  assert.equal(w.document.querySelector('[data-file-visual] img'),null);assert.match(w.document.querySelector('[data-file-visual]').textContent,/权限已撤销/);
  assert.equal(calls.length,2);assert.equal(calls[1].payload.page,2);assert.ok(calls.every(x=>!x.url.includes('file-content')));
 }finally{ui.dispose();dom.window.close();}
});
