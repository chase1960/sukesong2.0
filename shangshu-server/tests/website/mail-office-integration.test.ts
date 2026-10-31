import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
function setup(){
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'});
 dom.window.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js',import.meta.url),'utf8'));
 return {dom,w:dom.window as any,api:(dom.window as any).mailEditor};
}
test('表格归一化重复保存不膨胀边框声明',()=>{
 const {dom,api}=setup();try{
  const first=api.normalizeMarkup('<table><tr><td>报价</td></tr></table>');let value=first;
  for(let i=0;i<20;i++)value=api.normalizeMarkup(value);
  assert.equal(value,first);
 }finally{dom.window.close();}
});
test('员工撤回自己的段落，不覆盖助手后来修改的其他段落',()=>{
 const {dom,w,api}=setup();try{
  const control=api.mountEditor(w.document.querySelector('#host'),{value:'<p>甲原文</p><p>乙原文</p>'});
  control.editor.querySelector('p').textContent='甲人工';control.editor.dispatchEvent(new w.Event('input',{bubbles:true}));
  control.applyEdit('<p>甲人工</p><p>乙助手</p>',{actor:'assistant'});
  assert.equal(control.undo(),true);
  assert.match(control.editor.textContent,/甲原文/);assert.match(control.editor.textContent,/乙助手/);
  control.destroy();
 }finally{dom.window.close();}
});
test('阅读宽表在正文内横向滚动，不把宽表硬压到不可读',()=>{
 const {dom,api}=setup();try{
  const html=api.previewSrcdoc('<table style="width:1600px"><tr><td>宽表</td></tr></table>');
  assert.match(html,/overflow-x:auto/);assert.match(html,/max-width:none/);
 }finally{dom.window.close();}
});
