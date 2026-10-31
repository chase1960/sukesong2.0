/**
 * 判据：**改列宽的手柄不能被「挪列」那套掐断**（用户 2026-10-29 15:0x 报「不能调列宽」）。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「按住列头**最边上那几像素**（那就是 Excel 里拖一下就能改列宽的手柄）⇒
 *   这个按下**必须能传到表格画布上** ⇒ Univer 才收得到、才拖得动列宽；
 *   而按住列头**中间** ⇒ 按下**照样被掐断** ⇒ Univer 自己那套「拖列」（只改画布、刷新就丢）
 *   不会跟我们的『长按挪列』打架。」
 *
 * ⚠️ **为什么会有这条**（真事故）：
 *   `column-drag.ts` 为了挡住 Univer 的原生拖列，在按到列头时调了 `stopImmediatePropagation`
 *   ⇒ **整个列头带子**上的按下都被掐了。
 *   而**改列宽的手柄就长在列头的边上** ⇒ 那一带也被掐 ⇒ **列宽永远拖不动**。
 *   ⇒ 现在分清两种按下：**边上那几像素＝改列宽（放行）**，中间＝挪列（掐断）。
 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

import { mountColumnDrag, WIDTH_HANDLE_ZONE_PX } from '../src/column-drag.ts';

/** 两列：左边 0～100，右边 100～200（**宿主坐标**）。 */
const RECTS = [
  { colIndex: 0, rect: { left: 0, top: 0, width: 100, height: 24 } },
  { colIndex: 1, rect: { left: 100, top: 0, width: 100, height: 24 } },
];

function harness() {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"><div id="canvas"></div></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const canvas = doc.getElementById('canvas') as HTMLElement;
  let canvasSaw = 0;
  canvas.addEventListener('pointerdown', () => { canvasSaw++; });
  const drag = mountColumnDrag(host, {
    locate: (x: number) => RECTS.find(item => x >= item.rect.left && x < item.rect.left + item.rect.width) || null,
    headerAt: (colIndex: number) => RECTS.find(item => item.colIndex === colIndex) || null,
    headers: () => ['A', 'B'],
    canDrag: () => true,
    onMove: () => Promise.resolve(),
    newKey: () => 'op-1',
  });
  return { doc, host, canvas, drag, canvasSeen: () => canvasSaw };
}

/** 往**画布**上派一个按下（冒泡到 host）——浏览器里就是这个路径。 */
function pressOnCanvas(h: ReturnType<typeof harness>, x: number) {
  const win = h.doc.defaultView as any;
  const event = new win.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: 10 });
  Object.defineProperty(event, 'button', { value: 0 });
  h.canvas.dispatchEvent(event);
  return event;
}

test('① 按在列头**边上那几像素**（改列宽的手柄）⇒ 事件**必须能到画布**（否则列宽拖不动）', () => {
  const h = harness();
  // x=100 是 A/B 的边界；命中的是**右边那一列**的左边（上一列的右边＝宽度手柄）。
  pressOnCanvas(h, 100);
  assert.equal(h.canvasSeen(), 1,
    '按在列宽手柄上的按下被掐断了 ⇒ Univer 收不到 ⇒ 列宽永远拖不动');
  h.drag.dispose();
});

test('② 按在列头**中间** ⇒ 按下**照样被掐断**（不许 Univer 自己那套拖列启动）', () => {
  const h = harness();
  pressOnCanvas(h, 150);   // B 列中间，离两条边都远
  assert.equal(h.canvasSeen(), 0, '列头中间的按下没有被掐断 ⇒ 两套拖动会打架');
  h.drag.dispose();
});

test('③ 手柄那一带要**够窄**（别把半个列头都让出去）', () => {
  assert.ok(WIDTH_HANDLE_ZONE_PX > 0 && WIDTH_HANDLE_ZONE_PX <= 12,
    `手柄区 ${WIDTH_HANDLE_ZONE_PX}px：太宽会让「按住列头中间」也拖不动列`);
});
