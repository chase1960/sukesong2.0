/**
 * 判据：长按列头 ⇒ 拖动 ⇒ 把那一列挪到某个位置（2026-10-29 用户口径）。
 *
 * **测试通过 =**（一句话）
 * 「在列头上**按住不放**（长按）⇒ 进入拖动态（列头跟着鼠标走、看得见**落点**在哪）；
 *   松手 ⇒ **那一列真的挪到了落点那个位置**（**写的是「我的个人视图」**，载荷是新列序，
 *   **不是**改文件结构的 `header`/`before_header`）；
 *   而**只点一下就松手**（不是长按）⇒ **不挪**（不误伤单击）；
 *   拖到**自己原来的位置** ⇒ **不挪**（没意义、白改一次结构）。」
 *
 * ⚠️ **为什么不跟「双击改列名」打架**：那是 `dblclick`，这个是「按住 ≥ 阈值才动」⇒ 两条路各走各的。
 * ⚠️ **为什么要有这个**：原来只有「行列操作」那个弹窗（填目标列名）⇒ 挪一次要开一次窗、填一次名；
 *   要把 24 列挪到前头 ⇒ 23 次点开填名 ⇒ 人做不动。
 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

import { mountColumnDrag, LONG_PRESS_MS } from '../src/column-drag.ts';

/** 一个假的宿主：列头命中靠 `locate` 桩给。 */
function harness(options: any = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const rects = options.rects || [
    { colIndex: 0, rect: { left: 0, top: 0, width: 100, height: 24 } },
    { colIndex: 1, rect: { left: 100, top: 0, width: 100, height: 24 } },
    { colIndex: 2, rect: { left: 200, top: 0, width: 100, height: 24 } },
  ];
  const moves: any[] = [];
  const drag = mountColumnDrag(host, {
    locate: (x: number) => {
      const found = rects.find(item => x >= item.rect.left && x < item.rect.left + item.rect.width);
      return found || null;
    },
    headerAt: (colIndex: number) => (rects.find(item => item.colIndex === colIndex) || null),
    headers: () => options.headers || ['A', 'B', 'C'],
    canDrag: () => options.canDrag !== false,
    onMove: (header: string, before: string) => {
      moves.push({ header, before });
      return Promise.resolve();
    },
    newKey: () => 'op-' + (moves.length + 1),
    longPressMs: options.longPressMs ?? LONG_PRESS_MS,
  });
  return { dom, doc, host, moves, drag, rects };
}

function pointer(target: HTMLElement | Document, type: string, x: number, y = 10) {
  // ⚠️ **jsdom 没有 `PointerEvent`** ⇒ 用普通 `Event` 起一个，再把那几个字段补上
  //   （`clientX`／`clientY`／`button`）⇒ 监听器读到的东西跟浏览器里一样。
  // ⚠️ **派发到 `host` 元素上**（不是 `document`）—— jsdom 里从 `document` 派发
  //   **不会冒泡到元素**（document 是根）⇒ 派到 document 的话元素上的监听器收不到。
  const doc = (target as HTMLElement).ownerDocument || (target as Document);
  const win = doc.defaultView as any;
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'button', { value: 0 });
  target.dispatchEvent(event);
  return event;
}

/* ───────────────── ① 长按才进拖动态 ───────────────── */

test('① 按住不动够久 ⇒ 进入拖动态（列头跟着走、看得见落点）', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  assert.equal(h.drag.isDragging(), true, '长按够久了还没进拖动态');
  h.drag.dispose();
});

test('② 只点一下就松手 ⇒ **不挪**（不误伤单击）', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);
  pointer(h.doc, 'pointerup', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  assert.equal(h.drag.isDragging(), false, '点一下就进拖动态了');
  assert.equal(h.moves.length, 0, '点一下就把列挪了');
  h.drag.dispose();
});

/* ───────────────── ② 拖到某个位置 ⇒ 真的挪过去 ───────────────── */

test('③ 长按后拖到第二列头上松手 ⇒ 那一列挪到第二列**前面**', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);          // 按住第一列
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  pointer(h.doc, 'pointermove', 150);          // 拖到第二列头上
  pointer(h.doc, 'pointerup', 150);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.moves.length, 1, '松手后没有发出挪列');
  assert.equal(h.moves[0].header, 'A', '挪的不是按住的那一列');
  assert.equal(h.moves[0].before, 'B', '落点不是「插到第二列前面」');
  h.drag.dispose();
});

test('④ 拖回**自己原来的位置** ⇒ **不挪**（没意义、白改一次结构）', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  pointer(h.doc, 'pointermove', 50);           // 还在自己头上
  pointer(h.doc, 'pointerup', 50);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.moves.length, 0, '原地也发了一次挪列');
  h.drag.dispose();
});

test('⑤ 长按后按 Esc ⇒ 取消，**不挪**', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  pointer(h.doc, 'pointermove', 150);
  h.doc.dispatchEvent(new h.doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pointer(h.doc, 'pointerup', 150);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.moves.length, 0, '按了 Esc 还是挪了');
  h.drag.dispose();
});

test('⑥ 不许挪的时候（`canDrag` 假）⇒ 长按也不进拖动态', async () => {
  const h = harness({ canDrag: false });
  pointer(h.host, 'pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  assert.equal(h.drag.isDragging(), false, '不许挪却进了拖动态');
  h.drag.dispose();
});

/* ───────────────── ⑦ 落点要用**指针的真实 y**（2026-10-29 · 真事故） ───────────────── */

test('⑦ 落点按指针的**真实 y**算（不是写死的 0／10）⇒ 拖到哪一列就是哪一列', async () => {
  /* —— **真事故**：早先 `updateMarker` 里把 y 写死成 0／10，
   *   而列头在画布顶部那条带子上（y≈200）⇒ `locate` 永远命中不了
   *   ⇒ 落点永远算不出来 ⇒ **每一次拖动都变成「挪到末尾」**
   *   ⇒ 用户看到的现象是「我挪走了但是挪不回去」。
   * —— 这一条钉的就是：**y 必须用指针给的那个**。 */
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const moves: any[] = [];
  const seen: number[] = [];
  const handle = mountColumnDrag(host, {
    frame: () => null,
    locate: (x: number, y: number) => {
      seen.push(y);
      // —— 只有 y 在列头带子上（200～230）才算命中 ——
      if (y < 200 || y > 230) return null;
      const rects = [
        { colIndex: 0, rect: { left: 0, top: 200, width: 100, height: 24 } },
        { colIndex: 1, rect: { left: 100, top: 200, width: 100, height: 24 } },
      ];
      const found = rects.find(item => x >= item.rect.left && x < item.rect.left + item.rect.width);
      return found || null;
    },
    headerAt: () => null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: (header: string, before: string) => { moves.push({ header, before }); return Promise.resolve(); },
    newKey: () => 'op-1',
  });
  // —— 派发：按住第一列（y=205）⇒ 拖到第二列（y=205）⇒ 松手 ——
  const dispatch = (type: string, x: number, y: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  dispatch('pointerdown', 50, 205);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  dispatch('pointermove', 150, 205);
  dispatch('pointerup', 150, 205);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(moves.length, 1, '松手后没有发出挪列（落点没算出来）：%r', moves);
  assert.equal(moves[0].header, 'A');
  assert.equal(moves[0].before, 'B', '落点不是「插到第二列前面」：%r', moves[0]);
  assert.ok(seen.every(y => y >= 200), '定位用的是写死的 y，不是指针的真实 y：%r', seen);
  handle.dispose();
});

/* ───────────────── ⑧ 拖动开始／结束 ⇒ 调用方能把提示藏起来／画回来 ───────────────── */

/**
 * ⑬ **拖动残影要跟着鼠标走**（用户 2026-10-29 15:0x 报的「为什么是这个样子的」）。
 *
 * ⚠️ **真事故**：残影是宿主的子元素（**按宿主坐标摆**），而指针给的是**页面坐标**
 *   ⇒ 原来**没减掉宿主在页面里的位置** ⇒ 残影永远偏一段（偏到格子中间去了）。
 */
test('⑬ 拖动残影**跟着鼠标**（不减掉宿主在页面里的位置就会偏）', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  // 宿主在页面里偏了 (72,155) —— 真实页面里就是这样（侧栏 + 工具栏在上面）。
  (host as any).getBoundingClientRect = () => ({ left: 72, top: 155, width: 1000, height: 800, right: 1072, bottom: 955, x: 72, y: 155 });
  const handle = mountColumnDrag(host, {
    locate: (x: number) => {
      const local = x - 72;                       // 页面坐标 ⇒ 宿主坐标
      const rects = [
        { colIndex: 0, rect: { left: 0, top: 0, width: 100, height: 24 } },
        { colIndex: 1, rect: { left: 100, top: 0, width: 100, height: 24 } },
      ];
      return rects.find(item => local >= item.rect.left && local < item.rect.left + item.rect.width) || null;
    },
    headerAt: () => null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
  });
  const dispatch = (type: string, x: number, y: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  dispatch('pointerdown', 72 + 50, 155 + 10);      // 按在第一列头上（页面坐标）
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  const ghost = host.querySelector('.excel-column-drag-ghost') as HTMLElement;
  assert.ok(ghost, '找不到拖动残影');
  assert.equal(ghost.hidden, false, '长按成立了残影却没显示');
  // 残影的中心应当落在指针上 ⇒ 左边 = 指针 - 宿主左边 - 半个宽度 = 0
  assert.equal(ghost.style.left, '0px',
    `残影没跟着鼠标（应为 0px，实际 ${ghost.style.left}）`);
  handle.dispose();
});

/**
 * ⑭ **落点按「左半边 / 右半边」分**（Excel 的手感 —— 用户 2026-10-29 15:0x：
 *   「以前那种挪动就很自然」）。
 */
test('⑭ 在某一列的**右半边**松手 ⇒ 插到**它后面**（不是前面）', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const moves: any[] = [];
  const handle = mountColumnDrag(host, {
    locate: (x: number) => {
      const rects = [
        { colIndex: 0, rect: { left: 0, top: 200, width: 100, height: 24 } },
        { colIndex: 1, rect: { left: 100, top: 200, width: 100, height: 24 } },
        { colIndex: 2, rect: { left: 200, top: 200, width: 100, height: 24 } },
      ];
      return rects.find(item => x >= item.rect.left && x < item.rect.left + item.rect.width) || null;
    },
    headerAt: () => null,
    headers: () => ['A', 'B', 'C'],
    canDrag: () => true,
    onMove: (header: string, before: string) => { moves.push({ header, before }); return Promise.resolve(); },
    newKey: () => 'op-1',
  });
  const dispatch = (type: string, x: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: 210 });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  dispatch('pointerdown', 50);      // 按住 A
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  dispatch('pointermove', 180);     // 落在 B 的**右半边**（B 是 100～200，中线 150）
  dispatch('pointerup', 180);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(moves.length, 1, '松手后没有发出挪列');
  assert.equal(moves[0].header, 'A');
  assert.equal(moves[0].before, 'C', '在右半边松手 ⇒ 应该插到 B 后面（C 前面）');
  handle.dispose();
});

/**
 * ⑫ **按住就拖**（不等那 350 毫秒）⇒ 也要能挪。
 *
 * ⚠️ **为什么有这条**（用户 2026-10-29 15:0x 原话：「挪列我这边还不行」）：
 *   原来「长按计时」一旦发现**指针动了**就**作废** ⇒
 *   人**按住列头马上拖**（最自然、最常见的动作）反而拖不动 ——
 *   必须是「按住**不动** 350 毫秒、然后再拖」才认。
 *   ⇒ 现在：**一动就接管**；「按住不动 350 毫秒」只是**另一条**进拖动态的路（两条都留）。
 */
test('⑫ 按住列头**马上拖**（不等长按那 350 毫秒）⇒ 也要能挪', async () => {
  const h = harness();
  pointer(h.host, 'pointerdown', 50);     // 按住第一列
  pointer(h.doc, 'pointermove', 150);     // 立刻拖走（没等长按成立）
  pointer(h.doc, 'pointerup', 150);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.moves.length, 1, '按住就拖 ⇒ 没挪（长按计时被移动作废了）');
  assert.equal(h.moves[0].header, 'A', '挪的不是按住的那一列');
  assert.equal(h.moves[0].before, 'B', '落点不是「插到第二列前面」');
  h.drag.dispose();
});
test('⑧ 拖动开始与结束都会通知调用方（角标要在拖动期间藏起来）', async () => {
  let starts = 0;
  let ends = 0;
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const handle = mountColumnDrag(host, {
    frame: () => null,
    locate: (x: number, y: number) => ({ colIndex: x < 100 ? 0 : 1, rect: { left: x < 100 ? 0 : 100, top: 200, width: 100, height: 24 } }),
    headerAt: () => null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
    onDragStart: () => { starts += 1; },
    onDragEnd: () => { ends += 1; },
  });
  const dispatch = (type: string, x: number, y: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  dispatch('pointerdown', 50, 205);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  assert.equal(starts, 1, '开始拖动时没有通知调用方（角标该藏起来）');
  dispatch('pointermove', 150, 205);
  dispatch('pointerup', 150, 205);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ends, 1, '拖完时没有通知调用方（角标该画回来）');
  handle.dispose();
});

/* ───────────────── ⑨ **按在列头上就藏**（不等长按成立） ───────────────── */

test('⑨ 按在列头上**立刻**藏起提示（不等长按成立）⇒ 拖动期间看不见乱跑的角标', async () => {
  /* —— **真事故**（用户 2026-10-29 报「受管列的锁图案会跟着鼠标走到别的位置」）：
   *   Univer **自己也会拖列**（一按就启动它的预览）⇒ 等我的长按（350ms 不动）成立才藏，
   *   **早就晚了**（Univer 的预览已经在跑、角标已经在乱跑）。
   * ⇒ **一按就藏**（不管最后是谁在拖）⇒ 拖动期间那些会动的角标根本看不见。
   * —— 这一条钉的就是「**按下的那一刻**就通知」。 */
  let starts = 0;
  let ends = 0;
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const handle = mountColumnDrag(host, {
    frame: () => null,
    locate: (x: number, y: number) => ({ colIndex: x < 100 ? 0 : 1, rect: { left: x < 100 ? 0 : 100, top: 200, width: 100, height: 24 } }),
    headerAt: () => null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
    onDragStart: () => { starts += 1; },
    onDragEnd: () => { ends += 1; },
  });
  const dispatch = (type: string, x: number, y: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  // —— **只按下，还没到长按阈值** ⇒ 提示就该藏了 ——
  dispatch('pointerdown', 50, 205);
  assert.equal(starts, 1, '按下时没有藏起提示（长按成立之前角标就已经在乱跑了）');
  // —— **马上松手**（连长按都没到）⇒ 提示要画回来（不然永远藏着）——
  dispatch('pointerup', 50, 205);
  assert.equal(ends, 1, '松手时没有把提示画回来（角标会永远消失）');
  handle.dispose();
});

test('⑩ 指针按下后**移动了**（长按作废）⇒ 松手时提示也要画回来', async () => {
  let starts = 0;
  let ends = 0;
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const handle = mountColumnDrag(host, {
    frame: () => null,
    locate: (x: number, y: number) => ({ colIndex: x < 100 ? 0 : 1, rect: { left: x < 100 ? 0 : 100, top: 200, width: 100, height: 24 } }),
    headerAt: () => null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
    onDragStart: () => { starts += 1; },
    onDragEnd: () => { ends += 1; },
  });
  const dispatch = (type: string, x: number, y: number) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  dispatch('pointerdown', 50, 205);
  assert.equal(starts, 1);
  dispatch('pointermove', 200, 205);     // 动了 ⇒ 长按作废（`pressed` 被清）
  dispatch('pointerup', 200, 205);
  assert.equal(ends, 1, '指针动过之后松手，提示没画回来（角标会永远消失）');
  handle.dispose();
});

/* ───────────────── ⑪ 按在**格子上**不许挡（选格子还得能用） ───────────────── */

test('⑪ 按在不是列头的地方 ⇒ **不挡事件**（选格子、双击编辑都照旧）', async () => {
  /* —— 我们的接管**只在列头上生效**：
   *   按在列头上 ⇒ 挡住 Univer 的原生拖列（它只改画布、不落库，还会让角标错位）；
   *   按在**格子**上 ⇒ 事件照常过去 ⇒ 选格子、双击改单元格都照旧。 */
  let starts = 0;
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  let seenOnHost = 0;
  const handle = mountColumnDrag(host, {
    frame: () => null,
    // —— 只有 y 在列头带子上（200～230）才算命中列头 ——
    locate: (_x: number, y: number) => (y >= 200 && y <= 230)
      ? { colIndex: 0, rect: { left: 0, top: 200, width: 100, height: 24 } }
      : null,
    headerAt: () => null,
    headers: () => ['A'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
    onDragStart: () => { starts += 1; },
  });
  const win = doc.defaultView as any;
  const dispatch = (type: string, x: number, y: number) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  // —— **按在格子上**（y=400，不在列头带）⇒ 不该触发我们的接管 ——
  dispatch('pointerdown', 50, 400);
  assert.equal(starts, 0, '按在格子上也接管了（选格子会被挡）');
  handle.dispose();
  void seenOnHost;
});
