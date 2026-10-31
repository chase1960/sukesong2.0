/**
 * 判据：**挪列不能把整张表冻住** ＋ **拖到边缘要能横向滑过去**。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「按住列头拖了一下、最后**没挪成**（原地松手／点了��下／按 Esc）⇒
 *   **必须告诉上层「预览作废、状态复位」** ⇒ 页面不会一直以为「有未保存修改」
 *   ⇒ **后面粘贴、打字、下拉都还能用**；
 *   而拖到**左右边缘** ⇒ **表自己横向滑** ⇒ 最右边那一列也**能一路拖到最左边**。」
 *
 * ⚠️ **为什么有第一条**（真事故：2026-10-29 15:2x）：
 *   挪列时画布上会先「预览」新顺序 ⇒ 预览期间页面被当成「有未保存修改」；
 *   挪完**忘了复位** ⇒ 后面**粘贴被拒**（「还有未保存修改」）、
 *   **打字被拒**、**下拉选了没反应** ⇒ 人看着就是「怎么都不行」，
 *   **刷新一下又好了**（更迷惑）⇒ 本条就是钉这个的。
 *
 * ⚠️ **为什么有第二条**（用户 2026-10-29 15:3x 原话：
 *   「我把本公司案号拖到最左列，但它在最右边，就会导致拖不过来」）。
 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

import { mountColumnDrag, LONG_PRESS_MS, EDGE_SCROLL_ZONE_PX } from '../src/column-drag.ts';

const RECTS = [
  { colIndex: 0, rect: { left: 0, top: 0, width: 100, height: 24 } },
  { colIndex: 1, rect: { left: 100, top: 0, width: 100, height: 24 } },
];

function harness(options: { hostWidth?: number } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const width = options.hostWidth ?? 200;
  // 宿主在页面里的位置与宽度（jsdom 默认全 0 ⇒ 边缘判定会失真）。
  (host as any).getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 400, right: width, bottom: 400, x: 0, y: 0 });
  const events: { cancel: number; edge: Array<{ direction: number; hovered: number }>; moves: number } = {
    cancel: 0, edge: [], moves: 0,
  };
  const drag = mountColumnDrag(host, {
    locate: (x: number) => RECTS.find(item => x >= item.rect.left && x < item.rect.left + item.rect.width) || null,
    headerAt: (colIndex: number) => RECTS.find(item => item.colIndex === colIndex) || null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => { events.moves += 1; return Promise.resolve(); },
    onCancel: () => { events.cancel += 1; },
    onEdgeScroll: (direction, hovered) => { events.edge.push({ direction, hovered }); },
    newKey: () => 'op-1',
  });
  const dispatch = (type: string, x: number, y = 10) => {
    const win = doc.defaultView as any;
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    Object.defineProperty(event, 'button', { value: 0 });
    host.dispatchEvent(event);
  };
  return { doc, host, drag, events, dispatch };
}

test('① 点一下列头就松手（没挪）⇒ **必须叫上层复位**（不然整张表被冻住）', () => {
  const h = harness();
  h.dispatch('pointerdown', 50);
  h.dispatch('pointerup', 50);
  assert.equal(h.events.cancel, 1, '拖完没挪 ⇒ 没有通知上层复位 ⇒ 页面会一直「有未保存修改」');
  h.drag.dispose();
});

test('② 拖了一圈又拖回原地（没挪）⇒ **同样必须叫上层复位**', async () => {
  const h = harness();
  h.dispatch('pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  h.dispatch('pointermove', 150);
  h.dispatch('pointermove', 50);      // 拖回自己 ⇒ 落点＝自己 ⇒ 不挪
  h.dispatch('pointerup', 50);
  assert.equal(h.events.moves, 0, '拖回原地却挪了');
  assert.equal(h.events.cancel, 1, '拖回原地（没挪）⇒ 没有通知上层复位');
  h.drag.dispose();
});

test('③ 拖到**右边缘** ⇒ 表自己横向滑（往右）', async () => {
  const h = harness({ hostWidth: 200 });
  h.dispatch('pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  h.dispatch('pointermove', 200 - EDGE_SCROLL_ZONE_PX + 1);   // 贴着右边缘
  assert.ok(h.events.edge.length > 0, '拖到边缘也没让表横向滑 ⇒ 最右边那列拖不到最左边');
  assert.equal(h.events.edge[0]?.direction, 1, '贴着右边缘却往左滑了');
  h.drag.dispose();
});

test('④ 拖到**左边缘** ⇒ 表自己横向滑（往左）', async () => {
  const h = harness({ hostWidth: 200 });
  h.dispatch('pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  h.dispatch('pointermove', EDGE_SCROLL_ZONE_PX - 1);          // 贴着左边缘
  assert.ok(h.events.edge.length > 0, '拖到左边缘也没让表横向滑');
  assert.equal(h.events.edge[0]?.direction, -1, '贴着左边缘却往右滑了');
  h.drag.dispose();
});

test('⑤ 在**中间**拖 ⇒ 不许乱滑', async () => {
  const h = harness({ hostWidth: 1000 });
  h.dispatch('pointerdown', 50);
  await new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 30));
  h.dispatch('pointermove', 500);
  assert.equal(h.events.edge.length, 0, '在中间拖也横向滑 ⇒ 会乱滚');
  h.drag.dispose();
});
