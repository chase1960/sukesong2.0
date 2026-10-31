import {readFileSync} from 'node:fs';

/* 右下角 toast 公共件（shangshu-web/js/toast.js）的测试读取口。

   产品原本就有的提示公共件：
     容器  index.html 的 <div class="toast-zone" id="toast-zone">
     样式  workbench.css 的 .toast-zone / .toast（右下角 + 进出场动画）
     入口  js/toast.js 的 window.toast(title, sub, kind)
   `kind === 'error'` 时节点多一个 `toast-error` 类、`role="alert"`；否则 `role="status"`。
   消息正文在 `.toast-title`，副标题在 `.tt`（无副标题时 hidden）。
   节点 **3.2 秒后自动移除**，断言要在移除前做完；多条会叠在容器里，最后一条是最新的一条。

   以前各测试自己往 DOM 里贴一份 `#notice`（底边居中、无动画），产品那套已删干净，
   测试一律改查 `#toast-zone .toast`。装架子用 installToast，读文案用 toastText / allToastText。 */

const TOAST_SRC = readFileSync(new URL('../../../shangshu-web/js/toast.js', import.meta.url), 'utf8');

/** 给这个 JSDOM 窗口装上 toast 公共件：右下角容器 + window.toast。
    **必须在 eval tool-workspace.js 之前调用** —— notify 转调的就是它，
    没装的话 toast() 静默返回 null，断言会假红。 */
export function installToast(w: any) {
  if (!w.document.getElementById('toast-zone')) {
    w.document.body.insertAdjacentHTML('beforeend', '<div id="toast-zone"></div>');
  }
  w.eval(TOAST_SRC);
  if (typeof w.toast !== 'function') throw new Error('toast 公共件没装上：window.toast 不是函数');
}

/** 容器里现存的全部 toast，按出现顺序（最后一条 = 最新一条）。 */
export function toasts(w: any): any[] {
  return [...w.document.querySelectorAll('#toast-zone .toast')];
}

/** 最新一条 toast 节点；一条都没有时 null。要验 toast-error / role="alert" 就取它。 */
export function lastToast(w: any): any {
  const all = toasts(w);
  return all.length ? all[all.length - 1] : null;
}

/** 最新一条 toast 的文字（标题 + 副标题）；没有则空串 ——
    让 assert.match 输在**文案**上，而不是输在 null 上。 */
export function toastText(w: any): string {
  const node = lastToast(w);
  return node ? (node.textContent || '') : '';
}

/** 本轮弹过的所有 toast 文字。判「从没说过 X」这类反向断言用它 ——
    只看最新一条会漏掉前面弹过的，比 allToastText 松。 */
export function allToastText(w: any): string {
  return toasts(w).map(node => node.textContent || '').join('\n');
}
