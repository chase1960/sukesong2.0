/* 三个工作面只共享生命周期与弹层行为；数据、权限、布局仍归原页面。 */
window.createToolWorkspace = function(host, {signal} = {}) {
  const controller = new AbortController(), modals = [], cleanups = new Set(), timers = new Set();
  let disposed = false, leaveGuard = () => true;
  const $ = selector => host.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function later(fn, ms) {
    if (disposed) return;
    const id = setTimeout(() => {timers.delete(id); if (!disposed) fn();}, ms);
    timers.add(id); return id;
  }
  /* 提示一律走右下角的 **toast 公共件**（js/toast.js）。
     用户 2026-10-12：「notice 是有一个独立的公共组件的，不在这里!!!!」——
     不该另造一套 #notice。那套（底边居中、无动画、每页各贴一份元素）已删干净。 */
  function notify(message, kind) {
    if (disposed) return;
    if (typeof globalThis.toast === 'function') globalThis.toast(message, '', kind || 'success');
  }
  function closeModal(force = false) {
    const entry = modals[modals.length - 1];
    if (!entry) return false;
    if (!force && entry.guard && !entry.guard()) return false;
    modals.pop();
    entry.element.remove();
    entry.onClose?.();
    const previous = modals[modals.length - 1];
    if (previous) previous.element.inert = false;
    if (!disposed && entry.focus?.isConnected) entry.focus.focus();
    return true;
  }
  function modal(html, {prefix='os', native=false, className='cr-preview', onClose, onEscape} = {}) {
    if (disposed) return null;
    const element = document.createElement(native ? 'dialog' : 'div');
    element.className = native ? className : `${prefix}-overlay`;
    element.innerHTML = native ? html : `<div class="${prefix}-dialog" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    const previous = modals[modals.length - 1];
    if (previous) previous.element.inert = true;
    const entry = {element, focus:document.activeElement, guard:null,onClose,onEscape};
    modals.push(entry);
    // 原生 dialog 放 body，避免被工作面的 overflow 裁切；退出统一清理。
    (native ? document.body : host).append(element);
    element.addEventListener('mousedown', e => {if(e.target === element && modals.at(-1) === entry) closeModal();}, {signal:controller.signal});
    element.addEventListener('cancel', e => {e.preventDefault(); if(modals.at(-1) === entry) closeModal();}, {signal:controller.signal});
    if (native) element.showModal?.();
    const heading = element.querySelector('h2,h3');
    const panel = native ? element : element.firstElementChild;
    if (heading) panel.setAttribute('aria-label', heading.textContent);
    (element.querySelector('button:not([disabled]),input:not([disabled]),textarea,select') || panel).focus();
    return element;
  }
  /* 公共弹窗 —— 产品的标准弹窗写法（原生 <dialog> + header/main/footer）。
     抽象成一个入口，省得每个页面各拼一套 HTML、各写各的 padding。
     用户 2026-10-12：「这个弹窗也抽象成公共组件」+「确保邮件部分是高内聚低耦合的」。
     样式用**自己的** .os-dialog（定义在公共样式表 workbench.css）——
     不借用任何业务模块的类（先前借了文件中心的 .file-operation-dialog，是耦合，已拆）。 */
  function dialog({title, body = '', actions = [], onEscape, onClose} = {}) {
    const slots = actions.map((_, i) => `<button type="button" class="btn" data-act="${i}"></button>`).join('');
    const element = modal(
      `<header><h2></h2></header><main></main><footer>${slots}</footer>`,
      {native: true, className: 'os-dialog', onEscape, onClose});
    if (!element) return null;
    element.querySelector('h2').textContent = String(title ?? '');
    const main = element.querySelector('main');
    if (typeof body === 'string') main.innerHTML = body;
    else if (body) main.appendChild(body);
    /* ⚠️ FIX-59（用户 2026-10-20 22:42：「图二为什么不能把两个按钮放到图一对应的位置呢？现在好丑」）：
       `modal()` 是在**正文还空着**的时候对焦的 —— 那时页脚里第一个可聚焦元素是「取消」
       ⇒ 弹窗一打开，焦点框（双线绿框）就落在「取消」上，看着像乱按了一下，
       两个弹窗叠在一起时尤其明显（新建表格弹窗 ＋ 它上面的归属弹窗）。
       ⇒ 填完正文**重新对焦**到正文里的第一个可聚焦元素（正文没有可聚焦元素就落在弹窗本身）。
       —— 弹窗之间只差这一个焦点框，其余（宽度 480px、页脚 59px、按钮的横向位置）本来就一致。 */
    const focusTarget = main.querySelector('button:not([disabled]),input:not([disabled]),textarea,select');
    (focusTarget || element).focus();
    element.querySelectorAll('[data-act]').forEach(btn => {
      const action = actions[Number(btn.getAttribute('data-act'))] || {};
      btn.textContent = action.label || '';
      if (action.variant === 'pri') btn.classList.add('btn-pri');
      btn.onclick = () => (typeof action.onClick === 'function' ? action.onClick(element) : closeModal());
    });
    return element;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; controller.abort();
    signal?.removeEventListener('abort', dispose);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    while(modals.length) closeModal(true);
    for(const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  const api = {$, escape, notify, later, modal, dialog, closeModal, dispose, signal:controller.signal,
    get disposed(){return disposed;}, get modalCount(){return modals.length;},
    closeAllModals(){while(modals.length) closeModal(true);},
    canCloseModals(){return modals.every(entry=>!entry.guard||entry.guard());},
    guardModal(element, guard){const entry=modals.find(m=>m.element===element);if(entry)entry.guard=guard;},
    onDispose(fn){if(disposed)fn();else cleanups.add(fn);},
    guardLeave(fn){leaveGuard=fn;},
    toggleExamples(mount, enabled){if(!leaveGuard())return false;dispose();mount(host,{signal,examples:enabled});return true;}
  };
  if (signal?.aborted) {dispose();return api;}
  signal?.addEventListener('abort',dispose,{once:true});
  window.addEventListener('pagehide',dispose,{signal:controller.signal});
  window.addEventListener('shangshu:before-page-change',event=>{if(!leaveGuard())event.preventDefault();},{signal:controller.signal});
  window.addEventListener('beforeunload',event=>{if(!leaveGuard()){event.preventDefault();event.returnValue='';}},{signal:controller.signal});
  document.addEventListener('keydown', e => {
    const entry=modals.at(-1);if(!entry)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!entry.onEscape?.(e))closeModal();}
    if(e.key==='Tab'){
      const focusable=Array.from(entry.element.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(el=>!el.hidden&&!el.closest('[hidden]'));
      const first=focusable[0],last=focusable.at(-1);
      if(!first){e.preventDefault();return;}
      if(!entry.element.contains(document.activeElement)||(e.shiftKey&&document.activeElement===first)||(!e.shiftKey&&document.activeElement===last)){
        e.preventDefault();(e.shiftKey?last:first).focus();
      }
    }
  },{capture:true,signal:controller.signal});
  return api;
};
