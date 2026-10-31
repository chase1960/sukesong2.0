// 判据：**邮件审核队列不在屏上就不拉**（2026-10-30 性能）。
//
// **测试通过 =**（一句话)
// 「邮件页**不在屏上**时（开机那一刻壳会短暂挂载邮件页再换页）
//   ⇒ 那份 `action-proposals?limit=200` **一个请求都不发**；
//   邮件页**在屏上**时 ⇒ **照旧发**（候选不能少）；
//   **壳已经告诉域「当前是哪一页」**、而那一页**不是邮件页**时
//   ⇒ **一个请求都不发**（开机那次短暂挂载就是这种情况）。
//
// 为什么要有这条（2026-10-30 用户给的性能报告实测）：
//   开表（表格页）的窗口里，`action-proposals?status=Proposed&limit=200` **被叫了 1 次**
//   （+0ms）⇒ 那是**邮件审核队列**在开机那次短暂挂载时拉的
//   ⇒ 表格页根本用不着它 ⇒ **白花开销**。
//
// ⚠️ **为什么「DOM 槽位在不在屏上」不够**（实测出来的）：
//   开机那一趟，壳**先把邮件页挂上**（槽位有 DOM、也有矩形）
//   ⇒ 「槽位在屏上」这个判断**判不出来是开机那一次**
//   ⇒ 队列照拉 ⇒ 白花开销仍在。
//   ⇒ **要靠壳告诉域「现在这一页是谁」**（用户 2026-10-30 11:2x 拍板：
//   「真要省，得让壳把『当前页』露给域」）。
//   ⇒ 壳给域的那个口是 `window.shangshuCurrentPage()`（core 侧一处小口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDom, h } from '../../../../../scripts/tests/mini-dom.mjs';

const MAIL_SOURCE_PATH = new URL('../mail-review-queue.js', import.meta.url);
const SHELL_SOURCE_PATH = new URL('../../../review-batch.js', import.meta.url);
const mailSource = fs.readFileSync(MAIL_SOURCE_PATH, 'utf8');
const shellSource = fs.readFileSync(SHELL_SOURCE_PATH, 'utf8');

/** 邮件页骨架（与邮件域自己的判据**同一套形状**：`[data-page="mail"]` ＋ `#mail-candidates`）。 */
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
 * 装载邮件队列脚本并调一次 `load()`。
 * @param visible 候选槽位**在不在屏上**（mini-dom 没有布局 ⇒ 由桩来回答）
 * @param currentPage 壳告诉域的「当前页」（**没有这个口**时传 null ⇒ 域判不出 ⇒ 照拉）
 */
function runQueue(dom, { visible, currentPage }) {
  const calls = [];
  const window = {
    document: dom,
    fetch: async (path) => {
      calls.push(String(path));
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
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
  // —— **壳把「当前页」露给域**的那个口（core 一处小口）——
  // 域**只认这个口** ⇒ 壳不给就判不出 ⇒ 判不出时照拉（宁可多拉，不要少候选）。
  // ⚠️ 桩按**真口的样子**返回对象：`{page, impl, hash}`（`page`＝被请求的页 id，
  //   `impl`＝实现页）—— 与 `app.js` 里 `window.shangshuCurrentPage` 一致。
  if (currentPage) {
    window.shangshuCurrentPage = () => ({
      page: currentPage, impl: currentPage, hash: currentPage,
    });
  }
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext(shellSource, context, { filename: 'review-batch.js' });
  vm.runInContext(mailSource, context, { filename: 'mail-review-queue.js' });
  // —— 槽位**在不在屏上**：mini-dom 没有布局 ⇒ 由这个桩回答 ——
  const slot = dom.querySelector('#mail-candidates');
  slot.getClientRects = () => (visible ? [{ width: 10, height: 10 }] : []);
  return { window, calls };
}

test('① 槽位**不在屏上** ⇒ 那份候选清单**一个请求都不发**', async () => {
  const dom = createDom();
  dom.body.appendChild(mailPage(dom));
  const { window, calls } = runQueue(dom, { visible: false });
  await window.shangshuMailReviewQueue.load();
  assert.equal(calls.filter(path => /action-proposals/.test(path)).length, 0,
    '不在屏上还去拉候选清单（白花开销）：' + JSON.stringify(calls));
});

test('② 槽位**在屏上** ⇒ 照旧发（邮件页的候选不能少）', async () => {
  const dom = createDom();
  dom.body.appendChild(mailPage(dom));
  const { window, calls } = runQueue(dom, { visible: true });
  await window.shangshuMailReviewQueue.load();
  assert.equal(calls.filter(path => /action-proposals/.test(path)).length, 1,
    '在屏上却没拉候选清单：' + JSON.stringify(calls));
});

test('③ 壳说「当前页**不是邮件页**」⇒ **一个请求都不发**（开机那趟短暂挂载）', async () => {
  const dom = createDom();
  dom.body.appendChild(mailPage(dom));
  // ⚠️ 槽位**在屏上**（壳先挂邮件页再换页 ⇒ 槽位有矩形），
  //    但壳已经说了「当前是表格页」⇒ **这才是开机那趟的真形状**。
  const { window, calls } = runQueue(dom, { visible: true, currentPage: 'excel' });
  await window.shangshuMailReviewQueue.load();
  assert.equal(calls.filter(path => /action-proposals/.test(path)).length, 0,
    '当前页不是邮件页还去拉候选清单（开机那趟的白花开销）：' + JSON.stringify(calls));
});

test('④ 壳说「当前页**就是邮件页**」⇒ 照旧发（候选不能少）', async () => {
  const dom = createDom();
  dom.body.appendChild(mailPage(dom));
  const { window, calls } = runQueue(dom, { visible: true, currentPage: 'mail' });
  await window.shangshuMailReviewQueue.load();
  assert.equal(calls.filter(path => /action-proposals/.test(path)).length, 1,
    '当前页就是邮件页却没拉候选清单：' + JSON.stringify(calls));
});

test('⑤ 壳**没给**那个口 ⇒ 域**判不出** ⇒ 照拉（宁可多拉一次，不要让邮件页的候选拉没了）', async () => {
  const dom = createDom();
  dom.body.appendChild(mailPage(dom));
  const { window, calls } = runQueue(dom, { visible: true });
  await window.shangshuMailReviewQueue.load();
  assert.equal(calls.filter(path => /action-proposals/.test(path)).length, 1,
    '壳没给口就当没候选了：' + JSON.stringify(calls));
});

test('⑥ 壳给的那个口**真的存在**（core 一处小口，域只认它）', () => {
  const appSource = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  assert.match(appSource, /window\.shangshuCurrentPage\s*=/,
    '壳里没有 `window.shangshuCurrentPage` —— 域拿不到「当前页」，开机那趟白花开销还在');
});
