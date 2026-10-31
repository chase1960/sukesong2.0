import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=()=>readFileSync(new URL('../../../shangshu-web/js/file-workbook.js',import.meta.url),'utf8');
const draft=()=>({revision:1,editable:true,reason:'',sheets:[{key:'s0',title:'采购',rows:3,columns:3,cells:[[{t:'s',v:'编号'},{t:'s',v:'数量'},null],[{t:'s',v:'00123'},{t:'n',v:150},null],[null,null,null]]}]});
it('编辑与撤销重绘保持当前表内滚动位置',()=>{
  const t=mount();try{
    const scroll=t.w.document.querySelector('.file-grid-scroll');scroll.scrollLeft=120;scroll.scrollTop=40;
    t.view.setCell(1,1,'180');
    assert.equal(t.w.document.querySelector('.file-grid-scroll').scrollLeft,120);
    assert.equal(t.w.document.querySelector('.file-grid-scroll').scrollTop,40);
    t.view.action('undo');assert.equal(t.w.document.querySelector('.file-grid-scroll').scrollLeft,120);
  }finally{t.close();}
});
it('键盘移动时将当前单元格滚入可见区域，不让选区走到屏幕外',()=>{
  const t=mount();try{
    let target='';t.w.Element.prototype.scrollIntoView=function(){target=this.dataset.cell;};
    const start=t.w.document.querySelector('[data-cell="0:0"]');start.focus();
    start.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
    assert.equal(target,'0:1');
  }finally{t.close();}
});
function mount(editable=true){
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',url:'http://localhost/'}),w=dom.window as any;
  w.eval(source());let changes=0;
  const view=w.mountFileWorkbook({host:w.document.querySelector('#root'),data:draft(),editable,onChange:()=>changes++,notify:()=>{}});
  return {dom,w,view,changes:()=>changes,close:()=>{view.dispose();w.close();}};
}
it('自由表格插入/删除行列、新建工作表与撤销重做不写任何API',()=>{
  const t=mount();try{
    t.view.action('insert_row');t.view.action('insert_column');
    let current=t.view.snapshot();assert.equal(current.workbook.sheets[0].cells[2][2].v,150);
    t.view.action('undo');t.view.action('redo');
    t.view.addSheet('交付');assert.equal(t.view.snapshot().workbook.sheets.length,2);
    assert.equal(t.view.isDirty(),true);assert.ok(t.changes()>0);
    t.view.markSaved();assert.equal(t.view.isDirty(),false);assert.equal(t.view.snapshot().operations.length,0);
    assert.deepEqual(Array.from(t.view.snapshot().workbook.sheets,(s:any)=>s.key),['s0','s1']);
  }finally{t.close();}
});
it('双击直接在单元格编辑，数值保类型、前导零保文字，粘贴整次预检',()=>{
  const t=mount();try{
    t.view.setCell(1,1,'180');t.view.setCell(1,0,'00045');
    assert.deepEqual(JSON.parse(JSON.stringify(t.view.snapshot().workbook.sheets[0].cells[1].slice(0,2))),[{t:'s',v:'00045'},{t:'n',v:180}]);
    t.view.paste('供应商\t数量\n上海某厂\t0');
    assert.equal(t.view.snapshot().workbook.sheets[0].cells[1][1].v,0);
    assert.throws(()=>t.view.paste('x'.repeat(32768)),/长度|过长/);
    t.view.action('undo');assert.equal(t.view.snapshot().workbook.sheets[0].cells[1][0].v,'00045');
    const cell=t.w.document.querySelector('[data-cell="0:0"]');cell.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));
    assert.ok(cell.querySelector('[contenteditable="true"]'));assert.equal(cell.querySelector('input'),null);
  }finally{t.close();}
});
it('只读与保存中禁止行列/粘贴；保持已有值与零修改',()=>{
  const t=mount(false);try{t.view.action('insert_row');t.view.setCell(0,0,'改');t.view.addSheet('不该创建');assert.equal(t.view.isDirty(),false);assert.equal(t.changes(),0);}finally{t.close();}
  const q=mount();try{q.view.setDisabled(true);q.view.setCell(0,0,'改');q.view.action('insert_column');assert.equal(q.view.isDirty(),false);}finally{q.close();}
});
it('工作表重名/最后一张删除、越界粘贴拒绝，不破坏草稿',()=>{
  const t=mount();try{
    assert.throws(()=>t.view.addSheet('采购'),/重名|名称/);
    assert.throws(()=>t.view.action('delete_sheet'),/至少/);
    t.view.setCell(0,0,'=1+1');assert.equal(t.view.snapshot().workbook.sheets[0].cells[0][0].t,'s');
    assert.throws(()=>t.view.paste(Array(101).fill('x').join('\t')),/列|上限/);
    assert.equal(t.view.snapshot().workbook.sheets[0].cells[0][0].v,'=1+1');
  }finally{t.close();}
});

it('Excel区域粘贴的引号、多行单元格及空值不拆错行；键盘仅当前格可达',()=>{
  const t=mount();try{
    t.view.paste('"客户\t意见"\t数量\r\n"同意\n分批交付"\t0\r\n');
    const s=t.view.snapshot().workbook.sheets[0];assert.equal(s.cells[0][0].v,'客户\t意见');assert.equal(s.cells[1][0].v,'同意\n分批交付');assert.equal(s.cells[1][1].v,0);
    assert.equal(t.w.document.querySelectorAll('td[tabindex="0"]').length,1);
    const before=JSON.stringify(s.cells);assert.throws(()=>t.view.paste('"引号未闭合'),/引号/);assert.equal(JSON.stringify(t.view.snapshot().workbook.sheets[0].cells),before);
  }finally{t.close();}
});

it('单元格编辑后Enter和Tab只前进一格，不重复执行父层键盘导航',()=>{
  for(const [key,address] of [['Enter','A2'],['Tab','B1']]){
    const t=mount();try{
      t.w.document.querySelector('[data-cell="0:0"]').dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));
      const input=t.w.document.querySelector('[contenteditable="true"]');input.textContent='已编辑';
      input.dispatchEvent(new t.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
      assert.equal(t.view.snapshot().workbook.sheets[0].cells[0][0].v,'已编辑');
      assert.equal(t.w.document.querySelector('[data-grid-address]').textContent,address);
      assert.equal(t.w.document.querySelector('[contenteditable="true"]'),null);
    }finally{t.close();}
  }
});
