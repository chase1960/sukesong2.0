/* 右下角提示 —— **产品本来就有的公共组件**，这里把它抽成独立入口。
   用户 2026-10-12：「notice 是有一个独立的公共组件的，不在这里!!!!」
   「notice 理论上在右下角时有一个公共组件的，你看看有没有？」—— 有，就是这套：

     · 容器  index.html 的 <div class="toast-zone" id="toast-zone">
     · 样式  workbench.css 的 .toast-zone / .toast（右下角 + 进出场动画）
     · 入口  本文件的 window.toast(title, sub, kind)

   我先前没找到它，自造了一套并行的 #notice（底边居中、无动画，还每个页面各贴一份元素）。
   现在一律走这里，#notice 那套删干净。

   为什么不放 app.js：app.js 是整个产品壳的启动脚本，测试和别的工作面要复用提示，
   没必要把整壳拉起来。抽成一个小文件，谁都能用，也只有一份。 */
(function (global) {
  function toast(title, sub, kind) {
    const doc = global.document;
    const zone = doc && doc.getElementById('toast-zone');
    if (!zone) return null;                     // 没有容器就静默：提示不该把业务弄挂
    const isError = kind === 'error';
    const node = doc.createElement('div');
    node.className = isError ? 'toast toast-error' : 'toast';
    node.setAttribute('role', isError ? 'alert' : 'status');
    node.innerHTML = '<span class="ti"></span><div><div class="toast-title"></div><div class="tt"></div></div>';
    node.querySelector('.ti').textContent = isError ? '!' : '✓';
    node.querySelector('.toast-title').textContent = String(title ?? '');
    const line = node.querySelector('.tt');
    line.textContent = sub ? String(sub) : '';
    line.hidden = !sub;
    zone.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 300);
    }, 3200);
    return node;
  }
  global.toast = toast;
})(typeof window !== 'undefined' ? window : globalThis);
