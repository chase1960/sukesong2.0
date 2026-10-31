import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

function setup() {
  const dom = new JSDOM('<div id="host"></div>', {url:'http://localhost',runScripts:'outside-only'});
  const w = dom.window as any;
  w.RENDER={};w.currentRole=()=> 'admin';w.currentUserInfo={username:'mail-view-a'};
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for (const name of ['tool-workspace','mail-center']) w.eval(readFileSync(new URL(`../../../shangshu-web/js/${name}.js`,import.meta.url),'utf8'));
  const controller = new w.AbortController();
  w.mountMailCenter(w.document.querySelector('#host'),{signal:controller.signal,examples:true});
  return {w,dom,controller};
}

/* 写信窗已经没有「存草稿」按钮（用户 2026-10-11：只要失焦就保存）。
   保存只剩两个入口：**失焦**自动存（120ms 防抖）、Ctrl/⌘S 手存。
   triggerSave 只派发 blur、不派发 focusout —— focusout 会顺带触发「单字段失焦保存」，
   多发一个请求，测的就不是「整封信存了一次」。 */
async function triggerSave(w:any){
  const ed = w.document.querySelector('.mail-body-editor') || w.document.querySelector('#c-body');
  if (ed) { ed.blur?.(); ed.dispatchEvent(new w.FocusEvent('blur', {bubbles:true})); }
  await new Promise(r => setTimeout(r, 320)); // 比 120ms 防抖长
}
/* 关闭确认从「按钮原地换字」改成了弹窗（用户 2026-10-11：「这个能不能用一个弹窗」）。
   这里既断言弹窗真的出现、两个出口都在，也顺手点掉弹窗完成放弃。 */
function visibleDialogs(w:any){
  return [...w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')]
    .filter((d:any) => d.isConnected && !d.hidden);
}
function discardViaDialog(w:any){
  const dialogs = visibleDialogs(w);
  assert.equal(dialogs.length, 1, `点关闭应弹出 1 个确认弹窗，实际 ${dialogs.length} 个`);
  const text = dialogs.map((d:any) => d.textContent || '').join(' ');
  assert.ok(/继续编辑/.test(text), `弹窗里没有「继续编辑」出口：${text.slice(0,120)}`);
  assert.ok(/放弃修改并关闭/.test(text), `弹窗里没有「放弃修改并关闭」出口：${text.slice(0,120)}`);
  /* 公共弹窗组件（tool-workspace 的 ui.dialog）的按钮是 footer 里带 data-act 的 <button>，
     不再是旧的 [data-discard]。按文字认出口，顺带钉住「两个出口是两个独立按钮」。 */
  const buttons = [...dialogs[0].querySelectorAll('footer button, button')];
  const discard = buttons.find((b: any) => /放弃修改并关闭/.test(b.textContent || ''));
  assert.ok(discard, `弹窗里找不到「放弃修改并关闭」按钮：${dialogs[0].innerHTML.slice(0, 200)}`);
  discard.click();
}

it('3in 当前布局：搜索与列表同栏，阅读与撰写在右侧，不再叠文件夹栏或撰写弹窗',()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document;
    assert.equal(d.querySelector('.mail-rail'),null);
    assert.ok(d.querySelector('.mail-list-pane #search'));
    assert.ok(d.querySelector('.mail-list-pane #mail-rows'));
    const box=d.querySelector('#mail-box');box.value='inbox';box.dispatchEvent(new w.Event('change'));
    d.querySelector('[data-open]').click();
    assert.ok(d.querySelector('.mail-reading-pane #reply'));
    assert.ok(d.querySelector('.detail-head #reply'));
    d.querySelector('#compose').click();
    assert.ok(d.querySelector('.mail-reading-pane #c-subject'));
    assert.ok(d.querySelector('.mail-compose-head #c-subject'));
    assert.ok(d.querySelector('.mail-compose-head #c-send'));
    assert.equal(d.querySelectorAll('.mail-overlay').length,0);
  }finally{controller.abort();dom.window.close();}
});

it('筛选不清空右侧草稿；切信与 Esc 不丢修改，显式确认关闭才放弃',()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document;
    d.querySelector('#compose').click();
    const input=d.querySelector('#c-subject');input.value='保留输入';input.dispatchEvent(new w.Event('input'));
    const filter=d.querySelector('#mail-box');filter.value='inbox';filter.dispatchEvent(new w.Event('change'));
    d.querySelector('[data-open]').click();
    input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(d.querySelector('#c-subject'),input);
    assert.equal(input.value,'保留输入');
    // 有未保存修改 → 点「关闭」弹确认弹窗，窗口本身还留着（不是按钮原地换字）
    d.querySelector('#c-cancel').click();
    assert.ok(d.querySelector('#c-subject'),'确认弹窗还没确认，窗口不能关');
    discardViaDialog(w);
    assert.equal(d.querySelector('#c-subject'),null);
    assert.equal(d.querySelectorAll('.mail-overlay').length,0,'确认弹窗点掉后必须消失');
  }finally{controller.abort();dom.window.close();}
});

it('主题采用和附件选择都记为未保存，不能切信静默丢弃',async()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document,filter=d.querySelector('#mail-box');filter.value='draft';filter.dispatchEvent(new w.Event('change'));
    d.querySelector('[data-open]').click();d.querySelector('#use-subject').click();
    assert.equal(d.querySelector('#dirty-note').hidden,false);
    // 主题采用后失焦自动存（写信窗已无「存草稿」按钮），存完回到列表
    await triggerSave(w);
    d.querySelector('#compose').click();
    d.querySelector('#pick-lib').click();d.querySelector('#pick-ok').click();
    assert.equal(d.querySelector('#dirty-note').hidden,false);
    assert.equal(d.querySelectorAll('.mail-overlay').length,0);
  }finally{controller.abort();dom.window.close();}
});

it('列表分隔条支持键盘调整、边界和双击复位',()=>{
  const {w,dom,controller}=setup();
  try {
    const handle=w.document.querySelector('[role="separator"]');assert.ok(handle);
    handle.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
    assert.equal(handle.getAttribute('aria-valuenow'),'560');
    handle.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
    assert.equal(handle.getAttribute('aria-valuenow'),'260');
    handle.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));
    assert.equal(handle.getAttribute('aria-valuenow'),'340');
  }finally{controller.abort();dom.window.close();}
});

it('邮箱列表宽度从真实壳身份隔离保存，不共用 guest 偏好',()=>{
  const {w,dom,controller}=setup();
  try{
    w.document.querySelector('[role="separator"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
    controller.abort();w.currentUserInfo={username:'mail-view-b'};w.mountMailCenter(w.document.querySelector('#host'),{examples:true});
    assert.equal(w.document.querySelector('[role="separator"]').getAttribute('aria-valuenow'),'340');
    w.dispatchEvent(new w.Event('pagehide'));w.currentUserInfo={username:'mail-view-a'};w.mountMailCenter(w.document.querySelector('#host'),{examples:true});
    assert.equal(w.document.querySelector('[role="separator"]').getAttribute('aria-valuenow'),'560');
  }finally{w.dispatchEvent(new w.Event('pagehide'));dom.window.close();}
});

/* ---- 用户 2026-10-13 批注 1-1 追加 ----
 原话：「可以了，但是这个正文可以窗格可以拉长吗？这样都看不到了」

 查实：.mail-body-preview 写死 height:340px。2 倍屏上就是截图里那个矮框，
 引用的原信被裁在半截，下面全是空白 —— 框不长高，用户只能在框里滚，看不全。 */

it('读信正文窗格能拉长，不是写死的 340；拉完记住，双击复位',()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document;
    const box=d.querySelector('#mail-box') as any; box.value='inbox'; box.dispatchEvent(new w.Event('change'));
    (d.querySelector('[data-open]') as any).click();

    /* 1. 正文框外面得有个竖向拖拽柄（和列表分隔条同一套操作） */
    const grip=d.querySelector('[data-mail-body-grip]') as any;
    assert.ok(grip,'读信正文框没有拉长用的拖拽柄 —— 用户「这个正文窗格可以拉长吗」');
    assert.equal(grip.getAttribute('role'),'separator','拖拽柄该是 role=separator');

    /* 2. 高度不许写死 340 —— 要能往大调 */
    assert.ok(grip.getAttribute('aria-valuenow'),'拖拽柄没记当前高度');
    const before=Number(grip.getAttribute('aria-valuenow'));
    grip.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const after=Number(grip.getAttribute('aria-valuenow'));
    assert.ok(after>before,
        `按 End 该调到最大高度，实际 ${before} → ${after} —— 框还是矮的`);

    /* 3. 双击复位 */
    grip.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));
    assert.equal(grip.getAttribute('aria-valuenow'),'340','双击该复位到默认 340');
  }finally{controller.abort();dom.window.close();}
});

/* 用户 2026-10-14 批注 1-1：「可以看到；但是 Uncaught ReferenceError: height is not defined」。
   根因：拖拽起点写成对象简写 `bodyDrag={y:e.clientY,height,…}`，而 `height` 这个变量
   根本不存在（该存的是当前高度 `bodyHeight`）—— 一按上拖拽柄当场抛 ReferenceError。
   此前这条一直没被抓到，是因为上面两个测试只走**键盘**和**双击**，**没派发 pointerdown**。
   测试通过 = 派发 pointerdown/pointermove/pointerup **全程不抛**，且拖完高度真的变了。 */
it('拖动正文拖拽柄不抛 ReferenceError（用户 1-1 实测报错）',()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document;
    const box=d.querySelector('#mail-box') as any; box.value='inbox'; box.dispatchEvent(new w.Event('change'));
    (d.querySelector('[data-open]') as any).click();
    const grip=d.querySelector('[data-mail-body-grip]') as any;
    assert.ok(grip,'前置：正文拖拽柄该在');
    const before=Number(grip.getAttribute('aria-valuenow'));

    const thrown=[];
    const guard=(fn)=>{ try{ fn(); }catch(e){ thrown.push(String(e&&e.message||e)); } };

    /* 真派发指针三连 —— 就是用户拖的那条路 */
    guard(()=>grip.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0,clientY:100,pointerId:1})));
    guard(()=>d.querySelector('#detail').dispatchEvent(new w.PointerEvent('pointermove',{bubbles:true,clientY:180,pointerId:1})));
    guard(()=>d.querySelector('#detail').dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true,pointerId:1})));

    assert.deepEqual(thrown,[],`拖动正文拖拽柄抛错了：${thrown.join(' | ')}`);
    const after=Number(grip.getAttribute('aria-valuenow'));
    assert.ok(after>before,`拖完高度该变大，实际 ${before} → ${after}`);
  }finally{controller.abort();dom.window.close();}
});

it('正文窗格高度按身份保存，重开还在；不共用别的身份的偏好',()=>{
  const {w,dom,controller}=setup();
  try {
    const d=w.document;
    const openDetail=()=>{
      const box=d.querySelector('#mail-box') as any; box.value='inbox'; box.dispatchEvent(new w.Event('change'));
      (d.querySelector('[data-open]') as any).click();
      return d.querySelector('[data-mail-body-grip]') as any;
    };
    let grip=openDetail();
    assert.ok(grip,'前置：正文拖拽柄该在');
    grip.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const saved=Number(grip.getAttribute('aria-valuenow'));
    assert.ok(saved>340,`前置：高度该被调大，实际 ${saved}`);

    /* 换个人重开，不该继承 */
    w.dispatchEvent(new w.Event('pagehide'));
    w.currentUserInfo={username:'mail-view-z'};
    w.mountMailCenter(w.document.querySelector('#host'),{examples:true});
    grip=openDetail();
    assert.equal(grip.getAttribute('aria-valuenow'),'340',
        `换了个身份还带着别人的高度偏好：${grip.getAttribute('aria-valuenow')}`);

    /* 原身份回来，自己的还在 */
    w.dispatchEvent(new w.Event('pagehide'));
    w.currentUserInfo={username:'mail-view-a'};
    w.mountMailCenter(w.document.querySelector('#host'),{examples:true});
    grip=openDetail();
    assert.equal(grip.getAttribute('aria-valuenow'),String(saved),
        `重开没记住自己调的高度，期望 ${saved} 实际 ${grip.getAttribute('aria-valuenow')}`);
  }finally{w.dispatchEvent(new w.Event('pagehide'));controller.abort();dom.window.close();}
});
