// 判据：全站「全部确认」通用规则（PKG-022-T01 · 用户 2026-10-22 12:3x / 12:4x / 12:5x）。
//
// **测试通过 =**（一句话）
// 「**页面上只要有蓝色审核（代码/自动化提出的审核），那一页的右上角就有「全部确认」；
//   绿色（AI 提的）不算；点它走的是提案接受口 `resolve` ＋ `{"decision":"confirmed"}`；
//   邮件那条的口径是「草稿已保存，未发送邮件」；
//   邮件页与表格页用的是**同一个公共壳文件**里的同一个实现。」」
//
// 为什么要有这条：用户原话「就是页面上但凡有蓝色审核字体的都要有」＋「放在右上角吧」＋「excel 那边也是这样的」。
// 这条规则**必须只有一份实现** —— 邮件页和表格页各写一份，迟早两边跑偏。
//
// ⚠️ 这条不许只看「代码里有个按钮」：要看**页面上真的出现了那个按钮**、
//   **点它真的打的是接受口**（断言端点与体）、**说给用户的话里带着「不发送」**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDom, h } from './mini-dom.mjs';

const SHELL_PATH = new URL('../../shangshu-web/js/review-batch.js', import.meta.url);
const MAIL_SOURCE_PATH = new URL('../../shangshu-web/js/domains/mail/mail-review-queue.js', import.meta.url);
const shellSource = fs.readFileSync(SHELL_PATH, 'utf8');
const mailSource = fs.readFileSync(MAIL_SOURCE_PATH, 'utf8');

/** 让出一圈事件循环，等异步链（确认 → 回执 → 重新判定）走完。 */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/**
 * 把公共壳装进一个最小 DOM 里。
 * `reply(path, init)` 决定后端回什么；每一次调用都记在 `calls` 里，判据要断言端点与体。
 */
function loadShell(dom, options = {}) {
  const calls = [];
  const window = {
    document: dom,
    fetch: async (path, init) => {
      calls.push({ path: String(path), init: init || {} });
      const data = await (options.reply ? options.reply(String(path), init || {}) : { ok: true, list: [] });
      return {
        ok: data.ok !== false,
        status: data.status || 200,
        json: async () => data,
      };
    },
    // 判据自己调 sync()，不让桩里的定时器偷偷跑。
    setTimeout: () => 1,
    clearTimeout: () => {},
    MutationObserver: undefined,
    dispatchEvent: () => true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    location: { href: 'http://localhost/index.html#/mail' },
    history: { replaceState: () => {} },
  };
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext(shellSource, context, { filename: 'review-batch.js' });
  return { window, calls, context };
}

/** 邮件页：页头（flex 行）＋ 主体。 */
function mailPage(dom, cards) {
  const heading = h(dom, 'header', { class: 'mail-heading' }, [
    h(dom, 'h1', { text: '邮箱' }),
    h(dom, 'button', { class: 'btn btn-ghost', id: 'mail-sync', text: '立即同步' }),
    h(dom, 'button', { class: 'btn btn-pri', id: 'compose', text: '写信' }),
    h(dom, 'button', { class: 'btn btn-ghost', id: 'examples-toggle', text: '查看交互样例' }),
  ]);
  const body = h(dom, 'div', { class: 'mail-body' });
  (cards || []).forEach(card => body.appendChild(card));
  const scroll = h(dom, 'div', { class: 'main-scroll', 'data-page': 'mail' }, [heading, body]);
  dom.body.appendChild(h(dom, 'main', { id: 'main' }, [scroll]));
  return { heading, body, scroll };
}

/** 表格页：Excel 工作面（页头是网格，工具条在第二行）。 */
function excelPage(dom, cells) {
  const toolrow = h(dom, 'div', { class: 'excel-toolrow', role: 'toolbar' }, [
    h(dom, 'button', { class: 'btn', 'data-undo': '', text: '撤回' }),
    h(dom, 'div', { class: 'excel-search' }, [h(dom, 'input', { type: 'search' })]),
  ]);
  const bar = h(dom, 'header', { class: 'excel-bar' }, [
    h(dom, 'button', { class: 'btn btn-ghost excel-back', text: '返回列表' }),
    h(dom, 'h1', { class: 'excel-title', text: 'Excel 表格' }),
    toolrow,
  ]);
  const canvas = h(dom, 'div', { class: 'excel-grid' }, cells || []);
  const scroll = h(dom, 'div', { class: 'main-scroll', 'data-page': 'excel' }, [bar, canvas]);
  dom.body.appendChild(h(dom, 'main', { id: 'main' }, [scroll]));
  return { bar, toolrow, canvas, scroll };
}

/** 公共确认卡（蓝色那一档）—— 与 agent 的确认卡同一套组件。 */
function blueCard(dom, id, capability) {
  return h(dom, 'article', {
    class: 'cf-card business-confirm review-source-automation',
    'data-review-source': 'automation',
    'data-confirm-id': id,
    'data-review-capability': capability || 'mail.save_draft',
  }, [h(dom, 'div', { class: 'cf-heading' })]);
}

/** 公共确认卡（绿色那一档）—— AI 提的，走 agent 链路。 */
function greenCard(dom, id) {
  return h(dom, 'article', {
    class: 'cf-card business-confirm review-source-assistant',
    'data-review-source': 'assistant',
    'data-confirm-id': id,
    'data-review-capability': 'mail.save_draft',
  }, [h(dom, 'div', { class: 'cf-heading' })]);
}

/** 表格候选浮层里的一格（蓝色候选文字）。 */
function blueCell(dom, id) {
  return h(dom, 'div', {
    class: 'excel-candidate-cell',
    'data-review-source': 'automation',
    'data-proposal-id': id,
  }, [h(dom, 'span', { class: 'excel-candidate-text', text: '候选值' })]);
}

test('① 页面上有蓝色审核 ⇒ 那一页的右上角出现「全部确认」（且在主行动按钮左边）', async () => {
  const dom = createDom();
  const page = mailPage(dom, [blueCard(dom, 'PR-1')]);
  const { window } = loadShell(dom, {
    reply: async () => ({ ok: true, list: [{ id: 'PR-1', capability: 'mail.save_draft', status: 'proposed' }] }),
  });
  const result = await window.shangshuReviewBatch.sync();
  assert.equal(result.shown, true, '有蓝色审核却没出按钮');
  const bar = page.heading.querySelector('[data-review-batch-bar]');
  assert.ok(bar, '页头里没有那条「全部确认」');
  const button = bar.querySelector('[data-review-batch-confirm]');
  assert.ok(button, '没有「全部确认」按钮');
  assert.equal(button.textContent, '全部确认');
  // 位置：页头里、**主行动按钮（写信）左边** —— 主行动保持最右。
  const compose = page.heading.querySelector('#compose');
  assert.ok(compose.previousSibling === bar, '「全部确认」不在主行动按钮左边');
  const kids = Array.prototype.slice.call(page.heading.children);
  assert.ok(kids.indexOf(bar) < kids.indexOf(compose), '「全部确认」跑到主行动按钮右边去了');
});

test('② 页面上只有绿色（AI 提的）审核 ⇒ **不出现**「全部确认」（不越界到 AI 链路）', async () => {
  const dom = createDom();
  const green = greenCard(dom, 'PR-A');
  const page = mailPage(dom, [green]);
  const { window } = loadShell(dom, {
    reply: async () => ({ ok: true, list: [{ id: 'PR-A', capability: 'mail.save_draft', status: 'proposed' }] }),
  });
  const result = await window.shangshuReviewBatch.sync();
  assert.equal(result.shown, false, 'AI 的绿色审核也长出了「全部确认」');
  assert.equal(result.reason, 'no-blue-review');
  assert.equal(page.heading.querySelector('[data-review-batch-bar]'), null, '页头里多了那条按钮');
  // 差分判据：同一页把绿色换成蓝色，**就该**长出按钮 ——
  // 否则「不出按钮」可能只是因为这页根本没有实现（空实现也能骗过这一条）。
  green.className = 'cf-card business-confirm review-source-automation';
  green.setAttribute('data-review-source', 'automation');
  const blue = await window.shangshuReviewBatch.sync();
  assert.equal(blue.shown, true, '换成蓝色审核也没长出按钮 —— 这条判据分辨不出颜色');
  assert.ok(page.heading.querySelector('[data-review-batch-bar]'), '蓝色审核还是没有「全部确认」');
});

test('③ 点「全部确认」⇒ 走提案接受口 `resolve` ＋ `{"decision":"confirmed"}`', async () => {
  const dom = createDom();
  const page = mailPage(dom, [blueCard(dom, 'PR-1')]);
  const { window, calls } = loadShell(dom, {
    reply: async path => (path.includes('/resolve')
      ? { ok: true, id: 'PR-1', status: 'confirmed' }
      : { ok: true, list: [{ id: 'PR-1', capability: 'mail.save_draft', status: 'proposed' }] }),
  });
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

test('④ 批量确认的口径是「存草稿，不发送」—— 回执里写明未发送', async () => {
  const dom = createDom();
  const page = mailPage(dom, [blueCard(dom, 'PR-1')]);
  const { window } = loadShell(dom, {
    reply: async path => (path.includes('/resolve')
      ? { ok: true, id: 'PR-1', status: 'confirmed' }
      : { ok: true, list: [{ id: 'PR-1', capability: 'mail.save_draft', status: 'proposed' }] }),
  });
  await window.shangshuReviewBatch.sync();
  const bar = page.heading.querySelector('[data-review-batch-bar]');
  const button = bar.querySelector('[data-review-batch-confirm]');
  button.dispatchEvent({ type: 'click', currentTarget: button });
  await settle();
  const note = bar.querySelector('[data-review-batch-note]');
  assert.match(note.textContent, /未发送/, '回执里没说「未发送」');
  assert.match(note.textContent, /草稿/, '回执里没说「草稿」');
});

test('⑤ 表格页（Excel 工作面）同样满足规则，且用的是**同一个公共壳实现**', async () => {
  const dom = createDom();
  const page = excelPage(dom, [blueCell(dom, 'PR-9')]);
  const { window } = loadShell(dom, {
    reply: async () => ({ ok: true, list: [{ id: 'PR-9', capability: 'files.sheet_cells_write', status: 'proposed' }] }),
  });
  const result = await window.shangshuReviewBatch.sync();
  assert.equal(result.shown, true, '表格页有蓝色候选却没有「全部确认」');
  const bar = page.toolrow.querySelector('[data-review-batch-bar]');
  assert.ok(bar, '表格页工具条里没有那条「全部确认」');
  const button = bar.querySelector('[data-review-batch-confirm]');
  assert.equal(button.textContent, '全部确认');
  // 「通用实现只有一份」：邮件域那边**没有**自己再实现一遍接受口。
  assert.ok(!/\/resolve/.test(mailSource), '邮件域自己又打了一遍接受口（通用实现不是只有一份）');
  assert.ok(/\/resolve/.test(shellSource), '公共壳里没有接受口');
  // 两个页面上的按钮是**同一套标记**做的（同一个模块产出）。
  assert.equal(bar.getAttribute('data-review-batch-bar'), '1');
  assert.equal(button.getAttribute('data-review-batch-confirm'), '1');
});

test('不可批量确认的能力（不是那三类）⇒ 不出「全部确认」；只能放弃的（reject_only）也不出', async () => {
  const dom = createDom();
  const page = mailPage(dom, [blueCard(dom, 'PR-2', 'invoice.book')]);
  const { window } = loadShell(dom, {
    reply: async () => ({ ok: true, list: [{ id: 'PR-2', capability: 'invoice.book', status: 'proposed' }] }),
  });
  const other = await window.shangshuReviewBatch.sync();
  assert.equal(other.shown, false, '不可批量确认的能力也长出了按钮');
  assert.equal(other.reason, 'not-batchable');
  assert.equal(page.heading.querySelector('[data-review-batch-bar]'), null);

  const dom2 = createDom();
  const page2 = mailPage(dom2, [blueCard(dom2, 'PR-3')]);
  const second = loadShell(dom2, {
    reply: async () => ({ ok: true, list: [{ id: 'PR-3', capability: 'mail.save_draft', status: 'proposed', review_access: 'reject_only' }] }),
  });
  const result = await second.window.shangshuReviewBatch.sync();
  assert.equal(result.shown, false, '只能放弃的提案也长出了「全部确认」');
  assert.equal(page2.heading.querySelector('[data-review-batch-bar]'), null);
});
