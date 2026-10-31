/**
 * **一帧最多做一次**（2026-10-30 装饰层性能）。
 *
 * ⚠️ **为什么需要**：Univer 的网格是 canvas 虚拟滚动 ⇒ **每个动画帧**都会发
 *   Scroll / Layout 事件 ⇒ 装饰层（候选浮层、拖动高亮、空必填格的红底）
 *   如果**每个事件**都全量重算一遍 ⇒ 一次滚动要跑几十遍 ⇒ **表格卡住**。
 * ⇒ 这层把同一件事**压成一帧一次**（**最后一次参数为准** —— 中间的都作废）。
 *
 * ⚠️ **为什么不用 `setTimeout`**：`setTimeout(…,16)` 与帧不对齐 ⇒ 会抖；
 *   `requestAnimationFrame` 与渲染同帧 ⇒ **看得见的更新都在同一帧里**。
 */
export function frameThrottle<Args extends unknown[]>(run: (...args: Args) => void): (...args: Args) => void {
  let scheduled = false;
  let pending: Args | null = null;
  const flush = () => {
    scheduled = false;
    if (!pending) return;
    const args = pending;
    pending = null;
    try { run(...args); } catch { /* 装饰层不许把人锁住。 */ }
  };
  const win = typeof window !== 'undefined' ? window : null;
  return (...args: Args) => {
    pending = args;
    if (scheduled) return;
    scheduled = true;
    if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  };
}
