/* 邮件页「发信候选／待审」区（PKG-022-T01 · 用户 2026-10-22 12:3x 的原话）。
 *
 * **用户要什么**：「用（agent 确认卡）**同一套组件**，只不过把**交互颜色改成蓝色**，
 *   另外，**如果有代码提出的审核，就要在那一页上有一个全部确认的按钮**（因为**和 ai 审核不是同一套链路**）。」
 *
 * **这一份只管一件事**：把**代码/自动化提出**的邮件审核，画成**蓝色**那一档的候选卡，摆在邮件页上。
 *   · 卡片用**公共组件** `.business-confirm`（chat-module.css / deepseek.css），
 *     蓝色档 = `.review-source-automation`（自带蓝色呼吸点）—— **本文件不重画卡片、不写卡片样式**。
 *   · **绿色（assistant）不进这里**：AI 审核走 agent 的确认卡链路（对话流里一张张过），
 *     与代码提出的审核**不是同一条链路**，所以这里只画代码/自动化那一种。
 *   · 「全部确认」**不在本文件**：它是**全站通用规则**（公共壳 `js/review-batch.js`），
 *     邮件页只是恰好有蓝色审核，于是右上角出现那个按钮 —— **同一个实现，不是各写一份**。
 *
 * **候选从哪来**：邮件域/公共待审目录（`GET api/platform/action-proposals?status=Proposed`）里
 *   能力是 `mail.save_draft` 的那几条。**不读** example 的受管对象。
 *
 * **口径**：批量确认只**保存草稿**，**不发送邮件**（发送是另一个动作 `mail.send`）——
 *   卡片正文里就写着这句话，用户点之前就看得见。
 */
(function (global) {
  'use strict';

  const doc = global.document;

  /** 邮件域里可逐项审核的能力。 */
  const MAIL_CAPABILITIES = ['mail.save_draft'];
  const QUEUE_ATTR = 'data-mail-review-queue';
  const CARD_ATTR = 'data-mail-review-card';
  const LIST_CLASS = 'mail-review-queue-list';
  const NOTE_CLASS = 'mail-review-queue-note';
  /** 人话动作名（不外露内部动作号 —— CHAT-NEXT-03 同源口径）。 */
  const CAPABILITY_NAMES = { 'mail.save_draft': '保存邮件草稿' };

  const state = { root: null, queue: null, timer: 0, started: false, signature: '', renderedQueue: null };

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

  /** 来源种类：automation＝代码/自动化（蓝）；assistant＝AI（绿）；其余＝未知（灰）。 */
  function sourceKind(proposal) {
    if (typeof global.shangshuReviewSource === 'function') {
      const source = global.shangshuReviewSource(proposal);
      if (source && source.kind) return source.kind;
    }
    const raw = String((proposal && proposal.created_via) || '').trim();
    if (['code', 'automation', 'execution', 'llm-node'].includes(raw)) return 'automation';
    if (['ai', 'ai-chat', 'assistant'].includes(raw)) return 'assistant';
    const proof = proposal && proposal.source_provenance;
    if (proof && proof.status === 'linked' && proof.trusted === true && proof.kind === 'process') return 'automation';
    return 'unknown';
  }

  /** 来源标签：沿用公共来源口径（real-chat.js 的 shangshuReviewSource），不自己编一套。 */
  function sourceLabel(proposal) {
    if (typeof global.shangshuReviewSource === 'function') {
      const source = global.shangshuReviewSource(proposal);
      if (source && source.label) return String(source.label).split(/\s*·\s*/)[0];
    }
    return '代码自动化';
  }

  function mailRoot() {
    if (!doc) return null;
    return doc.querySelector('.main-scroll[data-page="mail"]') || doc.querySelector('.mail-center-page');
  }

  /**
   * **现在是不是在邮件页**（2026-10-30 用户 11:2x 拍板：壳把「当前页」露给域）。
   *
   * ⚠️ **判不出就当「在」**（返回 true）⇒ 宁可多拉一次，
   *   也不要让邮件页的候选拉没了（这是**待审队列**，少一条就少一件要办的事）。
   *
   * **怎么判**：
   * ① 壳给的那个口（`window.shangshuCurrentPage()`）⇒ 那是权威（壳知道换到哪一页）；
   * ② 壳没给 ⇒ 退回**地址栏**（`#/mail`）—— 旧壳没有那个口时也能判个大概。
   */
  function onMailPage() {
    const current = typeof global.shangshuCurrentPage === 'function' ? global.shangshuCurrentPage() : null;
    if (current && typeof current === 'object') {
      // ⚠️ **两个都认**：`page` 是被请求的页 id（别名页就是它自己），
      //   `impl` 是实现页 ⇒ 邮件页这两个都是 `mail`。
      const ids = [current.page, current.impl, current.hash].map(v => String(v || '').trim());
      if (ids.some(id => id === 'mail')) return true;
      // 壳说了「现在不是邮件页」⇒ 明说 ⇒ 不拉。
      return false;
    }
    // 壳没给那个口 ⇒ 退回地址栏（判不出就当在）。
    const hash = String((global.location && global.location.hash) || '').replace(/^#\//, '').trim();
    if (!hash) return true;                 // 还没有地址 ⇒ 判不出 ⇒ 当在
    return hash === 'mail';
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 队列容器：**列表区里那个候选槽位**（邮件页给的那一块地）。
   * ⚠️ 2026-10-24 22:3x 用户原话：「你说呢？」＋（指认下拉）「就是这里」
   *   ⇒ 「发信候选」**并进「全部邮件」那个状态下拉**（多一档「发信候选（待审）」），
   *   **不再单独摆一个「发信候选 · 待审（0）」区块**（那块在页面上凭空占地方）。
   *   候选卡落在**这一档的槽位**里；那一档不选中时，槽位是藏着的（壳管）。 */
  function ensureSlot() {
    if (!doc) return null;
    const slot = doc.querySelector('#mail-candidates');
    if (!slot) return null;
    let list = slot.querySelector('.' + LIST_CLASS);
    if (!list) {
      list = doc.createElement('div');
      list.className = LIST_CLASS;
      slot.appendChild(list);
    }
    return { slot: slot, list: list };
  }

  function clearList(list) {
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function renderState(target, kind, message, retry) {
    const list = target && target.list;
    if (!list) return;
    clearList(list);
    if (kind === 'loading') {
      list.appendChild(element('p', NOTE_CLASS, '正在读取待审候选…'));
      return;
    }
    if (kind === 'error') {
      list.appendChild(element('p', NOTE_CLASS, message || '待审候选读取失败，请重新加载。'));
      if (retry) {
        const button = element('button', 'btn btn-ghost btn-sm', '重新加载');
        button.type = 'button';
        button.addEventListener('click', () => { void load(); });
        list.appendChild(button);
      }
      return;
    }
    if (kind === 'empty') {
      list.appendChild(element('p', NOTE_CLASS, '暂无代码提出的待审候选。'));
      return;
    }
  }

  /** 下拉那一档的名字后面带上**待审几个**（不切过去也知道有没有）。 */
  function updateBoxLabel(count) {
    if (!doc) return;
    const select = doc.querySelector('#mail-box');
    if (!select) return;
    const options = select.querySelectorAll('option');
    for (const option of options) {
      if (typeof option.getAttribute === 'function' && option.getAttribute('value') === 'candidates') {
        option.textContent = count ? '发信候选（待审 · ' + count + '）' : '发信候选（待审）';
        return;
      }
    }
  }

  /** 一张蓝色候选卡：与 agent 的确认卡**同一个组件**，只是蓝色那一档。 */
  function buildCard(proposal, descriptor) {
    const card = element('article', 'cf-card business-confirm review-source-automation');
    card.setAttribute(CARD_ATTR, proposal.id);
    card.setAttribute('data-confirm-id', proposal.id);
    card.setAttribute('data-review-capability', proposal.capability);
    // 蓝色那一档的标记（与 agent 确认卡同款：类名 + 属性都标上）。
    card.setAttribute('data-review-source', 'automation');

    const heading = element('div', 'cf-heading');
    heading.appendChild(element('span', '', '操作确认'));
    heading.appendChild(element('span', 'cf-tag', '待确认'));
    card.appendChild(heading);

    // 来源标签：蓝色呼吸点用公共 `.review-source-dot`（动画在公共 CSS 里）。
    const sourceTag = element('span', 'cf-tag');
    const dot = element('span', 'review-source-dot');
    dot.setAttribute('aria-hidden', 'true');
    sourceTag.appendChild(dot);
    sourceTag.appendChild(element('span', 'review-status-text', '待你确认'));
    sourceTag.appendChild(doc.createTextNode(' · ' + sourceLabel(proposal)));
    card.appendChild(sourceTag);

    const units = Array.isArray(descriptor && descriptor.units) ? descriptor.units : [];
    const remaining = Number.isInteger(descriptor && descriptor.remaining)
      ? descriptor.remaining : units.filter(unit => String(unit.status || 'pending') === 'pending').length;
    const subjectUnit = units.find(unit => unit && unit.label === '主题');
    const rawSubject = subjectUnit && subjectUnit.value
      ? (subjectUnit.value.value !== undefined ? subjectUnit.value.value : subjectUnit.value) : '';
    const subject = String(rawSubject || '').trim();
    const labels = units.map(unit => (unit && unit.label) || '').filter(Boolean);

    const summary = element('div', 'cf-summary');
    summary.appendChild(element('div', 'cf-title', subject ? '保存草稿：' + subject : '保存草稿'));
    const body = element('div', 'cf-body');
    body.appendChild(doc.createTextNode('待确认 ' + remaining + ' 项建议' + (labels.length ? '（' + labels.join('、') + '）' : '') + '。\n'));
    // 口径就写在卡片上：全部确认**只保存草稿，不发送邮件**。
    body.appendChild(doc.createTextNode('全部确认只保存草稿，不发送邮件。'));
    if (descriptor && descriptor.can_accept === false) {
      body.appendChild(doc.createTextNode('\n当前不能确认：' + (descriptor.accept_unavailable_reason || '请到原位置核对。')));
    }
    summary.appendChild(body);
    card.appendChild(summary);

    const details = element('details', 'cf-details');
    const detailsSummary = element('summary', '', '详情');
    const list = element('dl', '');
    const idTerm = element('dt', '', '提案编号');
    const idValue = element('dd', '', proposal.id);
    const actionTerm = element('dt', '', '动作');
    const actionValue = element('dd', '', CAPABILITY_NAMES[proposal.capability] || '保存邮件草稿');
    list.appendChild(idTerm); list.appendChild(idValue);
    list.appendChild(actionTerm); list.appendChild(actionValue);
    details.appendChild(detailsSummary);
    details.appendChild(list);
    card.appendChild(details);

    const actions = element('div', 'cf-actions');
    const open = element('button', 'cf-btn ok', '在草稿里核对');
    open.type = 'button';
    open.addEventListener('click', () => { void openProposal(proposal); });
    actions.appendChild(open);
    card.appendChild(actions);
    return card;
  }

  /** 跳到草稿页逐项核对（复用公共定位口 shangshuNavigateReview，与 agent 侧同一条路）。 */
  async function openProposal(proposal) {
    const target = proposal.target && proposal.target.mail ? { mail: proposal.target.mail } : null;
    const navigable = {
      id: proposal.id,
      capability: proposal.capability,
      payload: Object.assign({}, proposal.payload || {}, target ? { mail: target.mail } : {}),
    };
    if (typeof global.shangshuNavigateReview === 'function') {
      try { await global.shangshuNavigateReview(navigable); return; } catch (error) { /* 落到下面的兜底 */ }
    }
    const url = new URL(global.location.href);
    if (target) url.searchParams.set('mail', target.mail);
    url.searchParams.set('proposal', proposal.id);
    url.hash = '#/mail';
    global.history.replaceState(null, '', url);
    if (typeof global.go === 'function') await global.go('mail');
  }

  /** 读待审目录 → 只留**代码/自动化提出**的邮件审核 → 画成蓝色候选卡。 */
  async function load(force) {
    const root = mailRoot();
    if (!root) return;
    const target = ensureSlot();
    if (!target) return;                    // 邮件页还没摆那个槽位（还没挂上）
    /* —— **不在屏上就不拉**（2026-10-30 性能：开表时白拉一次）。
       开机那一刻邮件页会**短暂挂载**（壳先挂再换页）⇒ 队列跟着拉了一份
       `action-proposals?limit=200` ⇒ **表格页根本用不着它**（白花开销）。
       ⇒ 只有**邮件页真的在屏上**才拉。
       ⚠️ **判不出就照拉**（老 DOM 实现没有 `getClientRects`）
       —— 宁可多拉一次，也不要让邮件页的候选拉没了。 */
    if (typeof target.slot.getClientRects === 'function'
        && target.slot.getClientRects().length === 0) return;
    /* —— **壳说「当前页不是邮件页」就不拉**（2026-10-30 用户 11:2x 拍板：
       「真要省，得让壳把『当前页』露给域」）。
       ⚠️ **为什么上面那道「槽位在不在屏上」不够**（实测）：
         开机那一趟，壳**先把邮件页挂上**（槽位有 DOM、也有矩形）
         ⇒ 「槽位在屏上」判**不出**这是开机那一次 ⇒ 队列照拉 ⇒ 白花开销仍在。
         ⇒ 域自己判不出（它只看见 DOM，看不见壳换到哪一页）⇒ 靠壳给。
       ⚠️ **判不出就照拉**（壳没给那个口／还没进任何页）⇒ 宁可多拉一次，
         也不要让邮件页的候选拉没了。 */
    if (!onMailPage()) return;
    state.root = root;
    state.queue = target.slot;
    state.list = target.list;
    // 第一次进邮件页：先说「正在读取…」；之后刷新时旧内容先留着，别来回闪。
    if (state.renderedQueue !== target.slot) renderState(target, 'loading');
    const candidates = [];
    try {
      const data = await fetchJson('api/platform/action-proposals?status=Proposed&limit=200');
      const proposals = Array.isArray(data && data.list) ? data.list : [];
      proposals.forEach(proposal => {
        if (proposal
          && typeof proposal.id === 'string'
          && proposal.status === 'proposed'
          && MAIL_CAPABILITIES.includes(proposal.capability)
          && sourceKind(proposal) === 'automation') candidates.push(proposal);
      });
    } catch (error) {
      if (state.queue !== target.slot) return;
      renderState(target, 'error', '待审候选读取失败，请重新加载。', true);
      state.signature = '';
      return;
    }
    if (state.queue !== target.slot) return;
    // 候选没变就别重画：重画会改动 DOM，又会叫醒观察者，成环。
    const signature = candidates.map(candidate => candidate.id).join(',');
    if (!force && signature === state.signature && state.renderedQueue === target.slot) return;
    state.signature = signature;
    state.renderedQueue = target.slot;
    updateBoxLabel(candidates.length);
    if (!candidates.length) {
      renderState(target, 'empty');
      return;
    }
    clearList(target.list);
    for (const proposal of candidates) {
      let descriptor = null;
      try {
        const data = await fetchJson('api/platform/action-proposals/' + encodeURIComponent(proposal.id) + '/review');
        descriptor = data && typeof data === 'object' ? data : null;
      } catch (error) {
        descriptor = null;
      }
      if (state.queue !== target.slot) return;
      target.list.appendChild(buildCard(proposal, descriptor));
    }
  }

  function schedule(force) {
    if (force) state.force = true;
    if (state.timer) return;
    state.timer = global.setTimeout(() => {
      state.timer = 0;
      const forced = state.force;
      state.force = false;
      void load(forced);
    }, 120);
  }

  /** 只有「动到邮件页」的 DOM 变化才值得重读候选 —— 别被右侧对话面板的输入刷醒。 */
  function touchesMail(records) {
    if (!records || !records.length) return true;
    const root = mailRoot();
    if (!root) return true;
    return records.some(record => {
      const target = record && record.target;
      if (!target || typeof target.contains !== 'function') return true;
      return target === root || root.contains(target) || target.contains(root);
    });
  }

  function start() {
    if (state.started) return;
    state.started = true;
    if (!doc) return;
    if (global.MutationObserver && doc.body) {
      const observer = new global.MutationObserver(records => {
        if (!touchesMail(records)) return;
        schedule();
      });
      /* —— **属性变化也要看得见**（2026-10-30 真站撞出来的）：
         候选槽位是 `<div id="mail-candidates" hidden>` ⇒ **默认藏着**
         （用户没切到「发信候选（待审）」那一档时，它整块藏着）。
         切档时改的是 **`hidden` 这个属性**、**没有新节点**
         ⇒ 只看 `childList` 的话 **Observer 根本不知道** ⇒ 队列不拉
         ⇒ 那一档**切出来是空的**（数据本该在切档那刻才拉）。
         ⇒ 这里**连属性一起看**，但**只收窄到 `hidden`**（别的属性变化不醒
         —— 否则任何属性变动都重读候选，白花开销又回来了）。 */
      observer.observe(doc.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'],
      });
    }
    if (doc.addEventListener) {
      // 审核有进展/被确认 ⇒ 候选变了 ⇒ 强制重读一次（不靠集合比对猜）。
      doc.addEventListener('shangshu:review-resolved', () => schedule(true));
      doc.addEventListener('shangshu:review-batch-resolved', () => schedule(true));
    }
    schedule();
  }

  global.shangshuMailReviewQueue = { load, schedule, state, sourceKind, MAIL_CAPABILITIES };

  if (doc && doc.readyState === 'loading' && doc.addEventListener) {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
