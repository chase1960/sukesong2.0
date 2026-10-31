// 判据：邮件页「发信候选／待审」区（PKG-022-T01 · 用户 2026-10-22 12:3x）。
//
// **测试通过 =**（一句话）
// 「邮件页把**代码/自动化提出**的邮件审核摆成**蓝色**那一档的候选卡（与 agent 确认卡**同一个组件**）；
//   AI 提的（绿色）**不进**这一块；
//   这一页因此有了**蓝色审核**，右上角就有**「全部确认」**，点它走 `resolve` ＋ `{"decision":"confirmed"}`；
//   卡片与回执都写着「**只保存草稿，不发送邮件**」；
//   邮件域**没有另造一套卡片样式**。」
//
// 为什么要有这条：用户原话「用同一套组件，只不过把交互颜色改成蓝色」＋
// 「如果有代码提出的审核，就要在那一页上有一个全部确认的按钮（因为和 ai 审核不是同一套链路）」。
//
// ⚠️ 这条不许只看「代码里有 review-source-automation」：要看**卡片真的用公共组件类名**、
//   **绿色提案真的没混进来**、**右上角真的出了按钮并打对了口**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDom, h } from '../../../../../scripts/tests/mini-dom.mjs';

const MAIL_SOURCE_PATH = new URL('../mail-review-queue.js', import.meta.url);
const MAIL_CSS_PATH = new URL('../../../../css/domains/mail/mail-review-queue.css', import.meta.url);
const SHELL_SOURCE_PATH = new URL('../../../review-batch.js', import.meta.url);
const mailSource = fs.readFileSync(MAIL_SOURCE_PATH, 'utf8');
const mailCss = fs.readFileSync(MAIL_CSS_PATH, 'utf8');
const shellSource = fs.readFileSync(SHELL_SOURCE_PATH, 'utf8');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/** 邮件页骨架：页头（flex 行）＋ 主体（列表区：状态下拉 ＋ 邮件列表 ＋ 候选槽位）。 */
function mailPage(dom) {
  const heading = h(dom, 'header', { class: 'mail-heading' }, [
    h(dom, 'h1', { text: '邮箱' }),
    h(dom, 'button', { class: 'btn btn-ghost', id: 'mail-sync', text: '立即同步' }),
    h(dom, 'button', { class: 'btn btn-pri', id: 'compose', text: '写信' }),
  ]);
  const tools = h(dom, 'div', { class: 'mail-tools' }, [
    h(dom, 'select', { id: 'mail-box', 'aria-label': '邮件状态' }, [
      h(dom, 'option', { value: 'all', text: '全部邮件' }),
      h(dom, 'option', { value: 'candidates', text: '发信候选（待审）' }),
    ]),
  ]);
  /* —— **候选槽位**：候选卡落在这一档里（2026-10-24 22:3x：并进状态下拉，
     不再单独摆一个「发信候选 · 待审」区块）。 —— */
  const candidates = h(dom, 'div', { id: 'mail-candidates', class: 'mail-candidates' });
  const body = h(dom, 'div', { class: 'mail-body' }, [
    tools,
    h(dom, 'div', { class: 'mail-scroll', id: 'mail-rows' }),
    candidates,
  ]);
  const scroll = h(dom, 'div', { class: 'main-scroll mail-center-page', 'data-page': 'mail' }, [heading, body]);
  dom.body.appendChild(h(dom, 'main', { id: 'main' }, [scroll]));
  return { heading, body, scroll, candidates, tools };
}

/**
 * 把「公共壳 + 邮件域」一起装进一个最小 DOM。
 * `reply(path, init)` 决定后端回什么；每次调用都记在 `calls` 里。
 */
function loadApp(dom, options = {}) {
  const calls = [];
  const window = {
    document: dom,
    fetch: async (path, init) => {
      calls.push({ path: String(path), init: init || {} });
      const data = await (options.reply ? options.reply(String(path), init || {}) : { ok: true, list: [] });
      return { ok: data.ok !== false, status: data.status || 200, json: async () => data };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    MutationObserver: undefined,
    dispatchEvent: () => true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    location: { href: 'http://localhost/index.html#/mail' },
    history: { replaceState: () => {} },
    go: async () => true,
  };
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext(shellSource, context, { filename: 'review-batch.js' });
  vm.runInContext(mailSource, context, { filename: 'mail-review-queue.js' });
  return { window, calls, context };
}

/** 一条待审提案（目录口回包）。 */
function proposal(id, overrides) {
  return Object.assign({
    id,
    capability: 'mail.save_draft',
    status: 'proposed',
    created_via: 'code',
    target: { module: 'mail', mail: 'MAIL-0007' },
    payload: { mail: 'MAIL-0007' },
  }, overrides || {});
}

/** 逐项审核口回包（域里读它拿「还剩几项建议」和字段名）。 */
function descriptor(proposalId, remaining) {
  return {
    ok: true,
    id: proposalId,
    capability: 'mail.save_draft',
    status: 'proposed',
    remaining: remaining === undefined ? 2 : remaining,
    units: [
      { unit_id: 'subject', label: '主题', status: 'pending', value: { type: 'text', value: '关于季度对账的函' } },
      { unit_id: 'body', label: '正文', status: 'pending', value: { type: 'text', value: '正文草稿' } },
    ],
  };
}

function replyWith(list) {
  return async path => {
    if (path.includes('/resolve')) return { ok: true, id: 'PR-1', status: 'confirmed' };
    if (path.includes('/review')) return descriptor('PR-1');
    return { ok: true, list };
  };
}

test('① 候选区用**蓝色**那一档的公共组件（不是另画的一套卡）', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: replyWith([proposal('PR-1')]) });
  await window.shangshuMailReviewQueue.load();
  const card = page.scroll.querySelector('[data-mail-review-card="PR-1"]');
  assert.ok(card, '邮件页上没有候选卡');
  assert.ok(card.classList.contains('business-confirm'), '候选卡没用公共确认卡组件');
  assert.ok(card.classList.contains('review-source-automation'), '候选卡不是蓝色那一档');
  assert.ok(!card.classList.contains('review-source-assistant'), '候选卡错用了绿色那一档');
  assert.equal(card.getAttribute('data-review-source'), 'automation');
  // 呼吸点用公共 `.review-source-dot`（动画在公共 CSS 里，域里不重写）。
  assert.ok(card.querySelector('.review-source-dot'), '候选卡上没有公共呼吸点');
});

test('① 绿色（AI 提的）审核**不进**候选区 —— 两条链路不混', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, {
    reply: replyWith([proposal('PR-AI', { created_via: 'ai' }), proposal('PR-CODE')]),
  });
  await window.shangshuMailReviewQueue.load();
  assert.ok(page.scroll.querySelector('[data-mail-review-card="PR-AI"]') === null, 'AI 的提案混进了候选区');
  assert.ok(page.scroll.querySelector('[data-mail-review-card="PR-CODE"]'), '代码提出的提案没进候选区');
});

test('② 候选区一有蓝色审核 ⇒ 邮件页右上角就有「全部确认」（同一个公共壳）', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: replyWith([proposal('PR-1')]) });
  await window.shangshuMailReviewQueue.load();
  const result = await window.shangshuReviewBatch.sync();
  assert.equal(result.shown, true, '邮件页有蓝色审核却没有「全部确认」');
  const bar = page.heading.querySelector('[data-review-batch-bar]');
  assert.ok(bar, '邮件页页头里没有那条「全部确认」');
  const button = bar.querySelector('[data-review-batch-confirm]');
  assert.equal(button.textContent, '全部确认');
  // 通用实现只有一份：邮件域自己不打接受口。
  assert.ok(!/\/resolve/.test(mailSource), '邮件域自己又实现了一遍接受口');
});

test('③ 点「全部确认」⇒ 走 `resolve` ＋ `{"decision":"confirmed"}`', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window, calls } = loadApp(dom, { reply: replyWith([proposal('PR-1')]) });
  await window.shangshuMailReviewQueue.load();
  await window.shangshuReviewBatch.sync();
  const bar = page.heading.querySelector('[data-review-batch-bar]');
  const button = bar.querySelector('[data-review-batch-confirm]');
  button.dispatchEvent({ type: 'click', currentTarget: button });
  await settle();
  const resolved = calls.filter(call => call.path.includes('/resolve'));
  assert.equal(resolved.length, 1, '没有打提案接受口');
  assert.equal(resolved[0].path, 'api/platform/action-proposals/PR-1/resolve');
  assert.equal(resolved[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(resolved[0].init.body), { decision: 'confirmed' });
});

test('④ 口径是「存草稿，不发送」—— 卡片上写着，回执里也写着', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: replyWith([proposal('PR-1')]) });
  await window.shangshuMailReviewQueue.load();
  const card = page.scroll.querySelector('[data-mail-review-card="PR-1"]');
  const body = card.querySelector('.cf-body');
  assert.match(body.textContent, /不发送邮件/, '卡片上没写「不发送邮件」');
  assert.match(body.textContent, /只保存草稿/, '卡片上没写「只保存草稿」');

  await window.shangshuReviewBatch.sync();
  const bar = page.heading.querySelector('[data-review-batch-bar]');
  const button = bar.querySelector('[data-review-batch-confirm]');
  button.dispatchEvent({ type: 'click', currentTarget: button });
  await settle();
  const note = bar.querySelector('[data-review-batch-note]');
  assert.match(note.textContent, /未发送/, '回执里没说「未发送」');
});

test('⑤ 邮件域**没有另造一套卡片样式**（卡片样式仍在公共 CSS 里）', () => {
  // 注释里提到公共组件不算「写了样式」—— 只看真正的规则。
  const rules = mailCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.business-confirm/.test(rules), '域里给确认卡写了样式');
  assert.ok(!/\.cf-/.test(rules), '域里给确认卡零件写了样式');
  assert.ok(!/<style/.test(mailSource), '域里内联了一块样式');
  // 公共组件样式仍然只有公共 CSS 那一处。
  const publicCss = fs.readFileSync(new URL('../../../../css/chat-module.css', import.meta.url), 'utf8');
  assert.ok(/\.business-confirm\.review-source-automation/.test(publicCss), '公共蓝色档不在 chat-module.css 里');
});

test('空态：没有代码提出的待审候选 ⇒ 说人话，不装出候选', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: replyWith([]) });
  await window.shangshuMailReviewQueue.load();
  const queue = page.candidates;
  assert.ok(queue, '候选槽位没画出来');
  const note = queue.querySelector('.mail-review-queue-note');
  assert.match(note.textContent, /暂无代码提出的待审候选/);
  assert.ok(page.scroll.querySelector('[data-mail-review-card]') === null);
  // 没有蓝色审核 ⇒ 右上角也不该有「全部确认」。
  const result = await window.shangshuReviewBatch.sync();
  assert.equal(result.shown, false);
  assert.ok(page.heading.querySelector('[data-review-batch-bar]') === null);
});

test('加载态：正在读候选时说「正在读取…」，不先画一张空卡片', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: () => new Promise(() => {}) });
  const pending = window.shangshuMailReviewQueue.load();
  const queue = page.candidates;
  assert.ok(queue, '候选槽位没画出来');
  const note = queue.querySelector('.mail-review-queue-note');
  assert.match(note.textContent, /正在读取待审候选/);
  assert.ok(page.scroll.querySelector('[data-mail-review-card]') === null);
  void pending;
});

test('候选卡落在**槽位**里，页面上**不再有**那个独立的「发信候选 · 待审」区块', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, { reply: replyWith([proposal('PR-1')]) });
  await window.shangshuMailReviewQueue.load();

  /* —— 独立区块**不许再有**（用户 2026-10-24 22:3x：并进状态下拉那一档）。 —— */
  /* ⚠️ **不许写成 `assert.equal(元素, null)`** —— Node 断言给那个元素生成差异报告
     时会把整棵 DOM 树 inspect 一遍（实测直接卡死）⇒ 一律用 `=== null` 断。 */
  assert.ok(page.scroll.querySelector('[data-mail-review-queue]') === null,
    '页面上还摆着那个独立的「发信候选 · 待审」区块');
  assert.ok(page.scroll.querySelector('.mail-review-queue-head') === null,
    '页面上还摆着「发信候选 · 待审（0）」那行标题');
  /* —— 候选卡落在**槽位**里（那一档的内容）。 —— */
  const card = page.candidates.querySelector('[data-mail-review-card="PR-1"]');
  assert.ok(card, '候选卡没落进槽位（#mail-candidates）');
  assert.ok(card.classList.contains('business-confirm'), '候选卡没用公共确认卡组件');
});

test('错误态：读不到候选时说人话并给一条出路（重新加载），不把异常原文糊在页面上', async () => {
  const dom = createDom();
  const page = mailPage(dom);
  const { window } = loadApp(dom, {
    reply: async () => { throw Error('HTTP 500 内部炸了：不该被原样端到页面上'); },
  });
  await window.shangshuMailReviewQueue.load();
  const queue = page.candidates;
  const note = queue.querySelector('.mail-review-queue-note');
  assert.match(note.textContent, /待审候选读取失败/);
  assert.ok(!/内部炸了/.test(note.textContent), '把异常原文糊在页面上了');
  const retry = Array.prototype.slice.call(queue.querySelectorAll('button'))
    .find(button => button.textContent === '重新加载');
  assert.ok(retry, '没有给出路（重新加载）');
  assert.ok(retry.classList.contains('btn'), '重新加载按钮没用公共按钮类');
});
