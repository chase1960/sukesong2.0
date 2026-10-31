/* 全站「全部确认」通用壳（PKG-022-T01 · 用户 2026-10-22 12:3x / 12:4x / 12:5x 三次补充后的定稿）。
 *
 * **规则（原话）**：「就是页面上但凡有蓝色审核字体的都要有」＋「放在右上角吧」＋「excel 那边也是这样的」。
 *   ⇒ **判定**：这一页上出现了**蓝色审核**（代码/自动化提出的审核）⇒ 这一页**右上角**出现「全部确认」。
 *   ⇒ **绿色（assistant）不算**：AI 审核走 agent 的确认卡链路（对话流里一张张过），
 *     与「代码提出的审核」**不是同一条链路**，所以不在业务页批量确认。
 *   ⇒ **口径**：批量确认走 `POST api/platform/action-proposals/<id>/resolve` ＋ `{"decision":"confirmed"}`
 *     —— 与 agent 侧那个「全部确认」**同一个后端口、同一份语义**（确认剩余建议）。
 *     `mail.save_draft` 这条的能力本身就是「保存草稿」，**不发送邮件**（发送是另一个动作 `mail.send`）。
 *
 * **为什么是公共壳而不是各页各写一份**：邮件页、表格页（Excel 工作面）挂载位置完全不同
 * （一个是页头 flex 行、一个是工具条），但**判定规则、后端口、口径**必须只有一份，
 * 否则两边迟早跑偏。⇒ 判定与确认都只在这里；各页只负责「把蓝色审核画出来」。
 *
 * **不造新样式**：确认卡用公共 `.business-confirm`（chat-module.css / deepseek.css），
 *   蓝色那档是 `.review-source-automation`（含呼吸点动画 `review-source-pulse`），
 *   按钮用公共 `.btn .btn-ghost` —— 这里**没有**另写一套卡片/按钮样式。
 */
(function (global) {
  'use strict';

  const doc = global.document;

  /** 蓝色审核＝代码/自动化提出的审核；绿色（assistant）＝AI 提的，不进批量确认。 */
  const BLUE_KIND = 'automation';
  /** 与 real-chat.js 的 chatHasInlineReview 同一份清单：只有这三类能力可批量确认。 */
  const BATCH_CAPABILITIES = ['mail.save_draft', 'files.sheet_cell_write', 'files.sheet_cells_write'];
  const BAR_ATTR = 'data-review-batch-bar';
  const CONFIRM_ATTR = 'data-review-batch-confirm';
  const NOTE_ATTR = 'data-review-batch-note';
  /**
   * 蓝色审核标记 —— 两边写法都收：
   *   · 公共确认卡/待审条用**类名**（`.business-confirm.review-source-automation`、`.ai-pending-cue.review-source-automation`）；
   *   · 表格候选浮层用**属性**（`.excel-candidate-cell[data-review-source="automation"]`）。
   * 同一把尺子量所有页，所以邮件页与表格页走的是**同一个实现**。
   */
  const BLUE_SELECTOR = '[data-review-source="automation"], .review-source-automation';
  /** 页头/工具条容器：复用既有容器（右上角），**不自己造浮层位置**。 */
  const HEADER_SELECTORS = [
    '.page-hd', '.mail-heading', '.excel-toolrow',
    '.file-heading', '.sheet-heading', '.excel-picker-toolbar',
  ];

  const state = { bar: null, targets: [], listError: null, timer: 0, started: false, receipt: '', receiptFor: [], observer: null, syncing: false };

  function fetchJson(path, options) {
    return global.fetch(path, Object.assign({ credentials: 'include', cache: 'no-store' }, options || {}))
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok || (data && data.ok === false)) {
          throw Error((data && (data.error || data.message)) || ('HTTP ' + response.status));
        }
        return data;
      });
  }

  /** 业务页根：`.main-scroll[data-page=<模块>]`。对话页不算（AI 审核走 agent 链路）。 */
  function pageRoot() {
    if (!doc) return null;
    const main = doc.querySelector('#main');
    if (!main) return null;
    const scroll = main.querySelector('.main-scroll') || main;
    if (scroll.dataset && scroll.dataset.page === 'chat') return null;
    return scroll;
  }

  function isBlueReview(element) {
    if (!element || element.nodeType !== 1) return false;
    // 自己那条提示不算「页面有蓝色审核」（否则会自己触发自己）。
    if (element.closest('[' + BAR_ATTR + ']')) return false;
    const kind = element.dataset ? element.dataset.reviewSource : '';
    if (kind === 'assistant' || kind === 'unknown') return false;
    if (kind === BLUE_KIND) return true;
    return Boolean(element.classList && element.classList.contains('review-source-' + BLUE_KIND));
  }

  /** 这一页上的蓝色审核元素（确认卡、待审条、表格候选浮层都算）。 */
  function blueReviews(root) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll(BLUE_SELECTOR)).filter(isBlueReview);
  }

  /** 提案号：公共确认卡用 data-confirm-id，表格候选浮层用 data-proposal-id。 */
  function proposalIdOf(element) {
    const holder = element.closest('[data-confirm-id], [data-proposal-id]') || element;
    const dataset = holder.dataset || {};
    const id = dataset.confirmId || dataset.proposalId;
    return typeof id === 'string' && id ? id : null;
  }

  /** 能力号：域里的卡片自己带了最准（data-review-capability），没有就从待审目录查。 */
  function capabilityOf(element) {
    const holder = element.closest('[data-review-capability]');
    const value = holder && holder.dataset ? holder.dataset.reviewCapability : '';
    return typeof value === 'string' && value ? value : null;
  }

  function headerContainer(root) {
    if (!root || !root.querySelector) return null;
    for (const selector of HEADER_SELECTORS) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  /**
   * 右上角的落点：
   *   ① 页头右侧动作组 `.acts` → 放进它的最前面（那组本来就在最右）；
   *   ② 主行动按钮 `.btn-pri` → 放在它**左边**（主行动保持最右，视觉规范 §2.2）；
   *   ③ 都没有 → 放容器最后（工具条这类一行到底的地方，本来就在最右）。
   */
  function anchorFor(container) {
    const children = Array.prototype.slice.call(container.children || []);
    const acts = children.find(child => child.classList && child.classList.contains('acts'));
    if (acts) return { parent: acts, before: acts.firstChild || null };
    const primary = children.find(child => child.classList && child.classList.contains('btn-pri'));
    if (primary) return { parent: container, before: primary };
    return { parent: container, before: null };
  }

  function buildBar() {
    const bar = doc.createElement('div');
    bar.setAttribute(BAR_ATTR, '1');
    bar.setAttribute('style', 'display:flex;align-items:center;gap:6px');
    // 蓝色呼吸点用公共 `.ai-pending-cue` ＋ `.review-source-dot`（动画在公共 CSS 里，这里不重写）。
    const cue = doc.createElement('span');
    cue.className = 'ai-pending-cue review-source-automation';
    const dot = doc.createElement('span');
    dot.className = 'review-source-dot';
    dot.setAttribute('aria-hidden', 'true');
    const note = doc.createElement('span');
    note.setAttribute(NOTE_ATTR, '1');
    cue.appendChild(dot);
    cue.appendChild(note);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost';
    button.setAttribute(CONFIRM_ATTR, '1');
    button.textContent = '全部确认';
    button.addEventListener('click', onConfirmClick);
    bar.appendChild(cue);
    bar.appendChild(button);
    return bar;
  }

  function hideBar() {
    if (state.bar && state.bar.parentNode) state.bar.parentNode.removeChild(state.bar);
    state.targets = [];
  }

  /** 写文字前先比一下：**内容没变就别写** —— 写了就会触发 DOM 变化，
   *  而 DOM 变化又会把这段判定叫醒 ⇒ 「读一遍 → 改文字 → 被叫醒 → 再读一遍」成环。 */
  function setText(element, value) {
    if (!element) return;
    const next = value === undefined || value === null ? '' : String(value);
    if (element.textContent === next) return;
    element.textContent = next;
  }

  function render(root, targets) {
    const container = headerContainer(root);
    if (!container) return false;
    let bar = state.bar;
    if (!bar) { bar = buildBar(); state.bar = bar; }
    const anchor = anchorFor(container);
    // 已经在该在的位置就别再插一次 —— 每次插都会触发 DOM 变化，又会叫醒判定，成环。
    if (bar.parentNode !== anchor.parent || bar.nextSibling !== anchor.before) {
      anchor.parent.insertBefore(bar, anchor.before);
    }
    state.targets = targets;
    const note = bar.querySelector('[' + NOTE_ATTR + ']');
    const button = bar.querySelector('[' + CONFIRM_ATTR + ']');
    // 刚确认完这一批：把回执留在页面上，别被下一次 sync 刷成「待审 N 项」。
    if (state.receipt) {
      setText(note, state.receipt);
      if (button) { button.disabled = true; setText(button, '已确认'); }
      return true;
    }
    setText(note, '代码提出的待审 ' + targets.length + ' 项');
    if (button) { button.disabled = false; setText(button, '全部确认'); }
    return true;
  }

  /** 用户能看到的口径：草稿只存不发；表格只写建议值。 */
  function batchMessage(receipts) {
    const failed = receipts.filter(receipt => !receipt.ok);
    if (failed.length) return '有 ' + failed.length + ' 项未确认，请到原位置核对。';
    const mail = receipts.filter(receipt => receipt.capability === 'mail.save_draft').length;
    const sheet = receipts.filter(receipt => receipt.capability !== 'mail.save_draft').length;
    const parts = [];
    if (mail) parts.push('草稿已保存，未发送邮件');
    if (sheet) parts.push('建议值已保存');
    return '已全部确认：' + (parts.join('；') || '已确认') + '。';
  }

  /**
   * 全部确认＝**确认这批剩余建议**。
   * 与 agent 侧同一个后端口、同一份语义：`POST api/platform/action-proposals/<id>/resolve` ＋ `{"decision":"confirmed"}`。
   * （`mail.save_draft` 这条动作本身就是「保存草稿」，发送是另一个动作，所以这里**不会**把邮件发出去。）
   */
  async function confirmAll(targets) {
    const receipts = [];
    for (const target of targets || []) {
      try {
        const data = await fetchJson('api/platform/action-proposals/' + encodeURIComponent(target.id) + '/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'confirmed' }),
        });
        receipts.push({ id: target.id, capability: target.capability, ok: true, status: data && data.status });
      } catch (error) {
        receipts.push({ id: target.id, capability: target.capability, ok: false, error: error.message });
      }
    }
    return receipts;
  }

  async function onConfirmClick(event) {
    const button = event.currentTarget;
    const bar = button.closest('[' + BAR_ATTR + ']');
    const note = bar && bar.querySelector('[' + NOTE_ATTR + ']');
    const targets = state.targets.slice();
    if (!targets.length) return;
    button.disabled = true;
    if (note) note.textContent = '正在确认…';
    const receipts = await confirmAll(targets);
    state.receipt = batchMessage(receipts);
    state.receiptFor = targets.map(target => target.id);
    if (note) note.textContent = state.receipt;
    button.disabled = receipts.some(receipt => !receipt.ok);
    if (global.dispatchEvent && global.CustomEvent) {
      global.dispatchEvent(new global.CustomEvent('shangshu:review-batch-resolved', { detail: { receipts } }));
    }
    // 确认完这一批，页面上的蓝色审核应当消失 —— 重新判定一次，让规则自己收口。
    await sync();
  }

  /**
   * 判定并落位。**只有一页上确实有蓝色审核、且这些审核的能力可批量确认时才出按钮。**
   * 返回 {shown, reason, targets} —— 判定口径可被外部核对。
   */
  async function sync() {
    const root = pageRoot();
    if (!root) { hideBar(); return { shown: false, reason: 'no-page' }; }
    const blue = blueReviews(root);
    if (!blue.length) { hideBar(); return { shown: false, reason: 'no-blue-review' }; }
    // ⚠️ **同一时刻只跑一轮** —— 没有这道闸，多个触发（观察器 + 事件 + 定时器）
    //   会同时发起好几轮读取，请求数成倍涨（PKG-128-T02 · R05）。
    if (state.syncing) return { shown: Boolean(state.bar), reason: 'in-flight', targets: [] };
    state.syncing = true;
    let proposals = [];
    state.listError = null;
    try {
      const data = await fetchJson('api/platform/action-proposals?status=Proposed&limit=200');
      proposals = Array.isArray(data && data.list) ? data.list : [];
    } catch (error) {
      state.listError = error;
    } finally {
      state.syncing = false;
    }
    const byId = new Map();
    proposals.forEach(item => { if (item && typeof item.id === 'string') byId.set(item.id, item); });
    const targets = [];
    for (const element of blue) {
      const id = proposalIdOf(element);
      if (!id || targets.some(target => target.id === id)) continue;
      const proposal = byId.get(id) || null;
      const capability = capabilityOf(element)
        || (proposal && typeof proposal.capability === 'string' ? proposal.capability : null);
      // 不可批量确认的（不是那三类能力）不出现这个按钮。
      if (!capability || BATCH_CAPABILITIES.indexOf(capability) < 0) continue;
      // 目标已不存在、只能放弃的（review_access=reject_only）不给「全部确认」。
      if (proposal && proposal.review_access === 'reject_only') continue;
      targets.push({ id, capability, element });
    }
    if (!targets.length) { hideBar(); return { shown: false, reason: 'not-batchable' }; }
    // 回执只对**刚确认的那一批**有效；换成别的提案就把旧回执收掉。
    const currentIds = targets.map(target => target.id);
    if (state.receipt && !currentIds.every(id => state.receiptFor.includes(id))) {
      state.receipt = '';
      state.receiptFor = [];
    }
    const placed = render(root, targets);
    return {
      shown: placed,
      reason: placed ? 'blue-review' : 'no-header',
      targets: targets.map(target => ({ id: target.id, capability: target.capability })),
    };
  }

  function schedule() {
    if (state.timer) return;
    state.timer = global.setTimeout(() => { state.timer = 0; void sync(); }, 120);
  }

  /** 只有「动到业务页」的 DOM 变化才值得重新判定 —— 别被右侧对话面板的输入刷醒。 */
  function touchesPage(records) {
    if (!records || !records.length) return true;
    const root = pageRoot();
    if (!root) return true;
    return records.some(record => {
      const target = record && record.target;
      if (!target || typeof target.contains !== 'function') return true;
      // ⚠️ **工具条自己那点变化不算「业务页变了」** —— 它是这段判定自己画上去的。
      //   不排除它 ⇒ 「改工具条文字 → 触发观察 → 再读一遍 → 再改工具条」成环
      //   ⇒ 页面停着不动，请求数也一直涨（PKG-128-T02 · R05）。
      if (isOwnBar(target)) return false;
      return target === root || root.contains(target) || target.contains(root);
    });
  }

  /** 这个元素在不在**我们自己的工具条**里。 */
  function isOwnBar(element) {
    if (!element || typeof element.closest !== 'function') return false;
    return Boolean(element.closest('[' + BAR_ATTR + ']'));
  }

  /** 停掉这一页的监听与定时器（离页时收摊）。
   *  **为什么必须有**（审查报告 R07 · PKG-128-T02）：
   *   观察器挂在 `document.body` 上，**离页不会把它摘掉** ⇒ 离开那一页以后，
   *   别处的 DOM 变化照样把它叫醒 ⇒ 它照样发请求、照样在旧页上画东西。
   *  ⇒ 现在离页就断开、停定时器；下次进页面再重新接上。 */
  function stopWatching() {
    if (state.observer) {
      try { state.observer.disconnect(); } catch (error) { /* 已经断了就算了 */ }
      state.observer = null;
    }
    if (state.timer) {
      try { global.clearTimeout(state.timer); } catch (error) { /* 清不掉就算了 */ }
      state.timer = 0;
    }
  }

  /** 接上这一页的监听。 */
  function startWatching() {
    if (state.observer || !doc) return;
    if (global.MutationObserver && doc.body) {
      const observer = new global.MutationObserver(records => {
        if (!touchesPage(records)) return;
        schedule();
      });
      observer.observe(doc.body, { childList: true, subtree: true });
      state.observer = observer;
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    if (!doc) return;
    startWatching();
    if (doc.addEventListener) {
      doc.addEventListener('shangshu:review-resolved', schedule);
      doc.addEventListener('shangshu:review-progress', schedule);
      doc.addEventListener('shangshu:review-batch-resolved', schedule);
    }
    /* ⚠️ **离页要把观察器摘掉**（PKG-128-T02 · R07）：
     *   换页时公共壳会先派发 `shangshu:before-page-change`（`app.js` 的 `go()` 里），
     *   这里一收到就断开观察器、停掉待发的定时器 ⇒ 旧页不再在后台偷偷发请求。
     *   紧接着新页挂上来时，公共壳会派发 `shangshu:page-mounted` ⇒ 重新接上。
     *   ⚠️ 用 `before-page-change` 收、用 `page-mounted` 接 —— **不要两个都用前者**：
     *   前者是在换页**之前**派发的（那时新页还没挂上），后者才是新页真的挂上了。
     */
    if (global.addEventListener) {
      global.addEventListener('shangshu:before-page-change', stopWatching);
      global.addEventListener('shangshu:page-mounted', () => { startWatching(); schedule(); });
    }
    if (global.addEventListener) {
      global.addEventListener('pagehide', stopWatching);
    }
    schedule();
  }

  global.shangshuReviewBatch = {
    BLUE_KIND,
    BATCH_CAPABILITIES,
    BLUE_SELECTOR,
    isBlueReview,
    blueReviews,
    proposalIdOf,
    capabilityOf,
    headerContainer,
    anchorFor,
    batchMessage,
    confirmAll,
    sync,
    start,
    state,
  };

  if (doc && doc.readyState === 'loading' && doc.addEventListener) {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
