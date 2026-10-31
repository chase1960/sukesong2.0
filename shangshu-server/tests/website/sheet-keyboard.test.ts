import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText} from '../helpers/toast.ts';

function mount(){
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/sheets',runScripts:'outside-only'});
  const w=dom.window as any;w.RENDER={};w.currentRole=()=> 'admin';
  w.fetch=()=>{throw new Error('交互样例不能写入业务接口');};
  installToast(w);
  for(const file of ['tool-workspace','sheet-center'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8'));
  const controller=new w.AbortController();w.mountSheetCenter(w.document.querySelector('#host'),{signal:controller.signal,examples:true});
  const cell=(row:number,field:string)=>w.document.querySelectorAll(`td[data-field="${field}"]`)[row];
  const key=(el:any,key:string,options={})=>el.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
  const paste=(el:any,text:string)=>{const event=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});el.dispatchEvent(event);return event;};
  return {w,cell,key,paste,close:()=>{controller.abort();dom.window.close();}};
}

it('Enter 提交后到下一行，Tab 换列，Escape 取消并保留单元格焦点',()=>{
  const t=mount();try{
    t.cell(0,'title').focus();t.key(t.cell(0,'title'),'Enter');
    const input=t.w.document.querySelector('.cell-input');input.value='键盘修改';t.key(input,'Enter');
    assert.equal(t.w.document.activeElement,t.cell(1,'title'));
    t.key(t.cell(1,'title'),'Tab');assert.equal(t.w.document.activeElement,t.cell(1,'customer'));
    t.key(t.cell(1,'customer'),'Tab',{shiftKey:true});assert.equal(t.w.document.activeElement,t.cell(1,'title'));
    t.key(t.cell(1,'title'),'F2');t.w.document.querySelector('.cell-input').value='不要保存';t.key(t.w.document.querySelector('.cell-input'),'Escape');
    assert.equal(t.w.document.activeElement,t.cell(1,'title'));assert.doesNotMatch(t.cell(1,'title').textContent,/不要保存/);
  }finally{t.close();}
});

it('矩形粘贴先全部预检，再生成脏格；非法选项与越界不留下部分修改',()=>{
  const t=mount();try{
    t.cell(0,'title').click();assert.equal(t.paste(t.cell(0,'title'),'新名称\t新客户\r\n第二名称\t第二客户').defaultPrevented,true);
    assert.equal(t.w.document.querySelectorAll('.is-dirty').length,4);
    assert.match(t.cell(1,'customer').textContent,/第二客户/);
    t.w.document.querySelector('#discard-edits').click();
    t.paste(t.cell(0,'applicants'),'申请人\t不合法状态');
    assert.equal(t.w.document.querySelectorAll('.is-dirty').length,0);
    assert.match(toastText(t.w),/状态/);
    t.paste(t.cell(11,'note'),'第一行\n超出本页');assert.equal(t.w.document.querySelectorAll('.is-dirty').length,0);
    assert.match(toastText(t.w),/超出/);
  }finally{t.close();}
});

it('Shift 选矩形可复制 TSV，包含制表符和换行的内容不损坏',()=>{
  const t=mount();try{
    t.paste(t.cell(0,'title'),'"名称\t带制表符"\t客户甲\n名称乙\t"客户\n第二行"');
    t.cell(0,'title').click();t.key(t.cell(0,'title'),'ArrowRight',{shiftKey:true});t.key(t.cell(0,'customer'),'ArrowDown',{shiftKey:true});
    let copied='';const event=new t.w.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(_:string,value:string)=>{copied=value;}}});
    t.cell(1,'customer').dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);assert.equal(copied,'"名称\t带制表符"\t客户甲\n名称乙\t"客户\n第二行"');
  }finally{t.close();}
});
