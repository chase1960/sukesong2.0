import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toasts} from '../helpers/toast.ts';

/* 提示的架子换成产品本来就有的右下角 toast 公共件（js/toast.js + #toast-zone）。
   旧架子里那个 <div id="notice"> 是各页自造的劣等品，产品已删，测试也不许再贴。 */
function setup() {
  const dom = new JSDOM('<main><button id="open">打开</button></main>', {runScripts:'outside-only'});
  const w = dom.window as any;
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  const signal = new w.AbortController();
  const ui = w.createToolWorkspace(w.document.querySelector('main'), {signal:signal.signal});
  return {dom, w, ui, signal};
}

it('公共弹层只关闭最顶层，恢复原焦点，销毁时清理原生弹层', () => {
  const {dom,w,ui,signal} = setup();
  try {
    w.document.querySelector('#open').focus();
    const first = ui.modal('<button id="inside">选择附件</button>', {prefix:'mail'});
    first.querySelector('button').focus();
    ui.modal('<button>核对</button>', {prefix:'mail'});
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    assert.equal(w.document.querySelectorAll('.mail-overlay').length, 1);
    assert.equal(w.document.activeElement.id, 'inside');
    ui.closeModal();
    assert.equal(w.document.activeElement.id, 'open');
    ui.modal('<button>关闭</button>', {native:true,className:'cr-preview'});
    /* 先证明确实弹得出来 —— 否则「销毁后没有提示」可能只是因为提示根本没接上（假绿）。
       notify(msg) → toast(msg,'')，副标题为空且 hidden。 */
    ui.notify('活着时的提示');
    const live = toasts(w);
    assert.equal(live.length, 1, `活着时 notify 没弹出 toast：${live.length}`);
    assert.equal(live[0].querySelector('.toast-title')?.textContent, '活着时的提示');
    signal.abort();
    assert.equal(w.document.querySelectorAll('dialog,.mail-overlay').length, 0);
    assert.equal(ui.signal.aborted, true);
    ui.notify('迟到的消息');
    assert.equal(toasts(w).length, 1, '已销毁的实例还在往右下角弹提示');
    assert.ok(!/迟到的消息/.test(w.document.querySelector('#toast-zone')!.textContent || ''),
        '销毁后仍弹出了「迟到的消息」');
  } finally {dom.window.close();}
});

it('Esc和遮罩必须经过同一未保存守卫，Tab限制在顶层弹窗', () => {
  const {dom,w,ui} = setup();
  try {
    const dialog = ui.modal('<button id="a">继续编辑</button><button id="b">保存</button>', {prefix:'sheet'});
    let allowed = false, attempts = 0;
    ui.guardModal(dialog, () => {attempts++; return allowed;});
    dialog.dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true}));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(attempts, 2);
    assert.equal(dialog.isConnected, true);
    dialog.querySelector('#b').focus();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    assert.equal(w.document.activeElement.id, 'a');
    allowed=true;
    assert.equal(ui.closeModal(), true);
    assert.equal(dialog.isConnected, false);
  } finally {ui.dispose();dom.window.close();}
});

it('已中止的页面不挂监听器、不再创建弹层', () => {
  const {dom,ui,signal} = setup();
  try {signal.abort(); assert.equal(ui.modal('<button>迟到</button>'), null);ui.dispose();}
  finally {dom.window.close();}
});

it('离页和刷新共用守卫，拒绝时样例重挂载不销毁输入；销毁后解除',()=>{
  const {dom,w,ui}=setup();let allowed=false,mounted=false;
  try{
    ui.guardLeave(()=>allowed);
    const leave=new w.Event('shangshu:before-page-change',{cancelable:true});
    assert.equal(w.dispatchEvent(leave),false);
    const unload=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented,true);
    ui.toggleExamples(()=>{mounted=true;},true);assert.equal(mounted,false);assert.equal(ui.disposed,false);
    allowed=true;assert.equal(w.dispatchEvent(new w.Event('shangshu:before-page-change',{cancelable:true})),true);
    ui.dispose();allowed=false;
    assert.equal(w.dispatchEvent(new w.Event('shangshu:before-page-change',{cancelable:true})),true);
  }finally{ui.dispose();dom.window.close();}
});
