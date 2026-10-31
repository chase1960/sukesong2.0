// 判据：审核中心的**服务端真分页**（今晚交接 §10.1 第 2 行末段 ＋ §10.2 的差额那条）。
//
// **为什么有这一条**（今晚交接原文）：
//   「当前审核列表的 12 张/页已经有**前端切片**，但这**不证明服务端真分页**。
//     今晚需将 page/page_length/筛选传入实际来源查询，当前页只装配本页卡片和必要凭据摘要；
//     **不能取全体后再 slice**。分页总数与无差异过滤不得互相矛盾。」
//
// **壳侧与域侧的契约**（两边同一份，壳**不自创**）：
//   · 壳调 `declaration.list({ signal, page, pageLength, scope, q })`
//     —— `page` 从 1 起；`pageLength` 默认 12；`scope` ＝ 'pending'｜'done'。
//   · 域回**新形状** `{ cards: [...], total: <该 scope 真实总数> }`。
//   · 域回**旧形状**（数组／没有 total）⇒ 壳**降级自己 slice**（兼容老用法）。
//
// **「测试通过 =」**（一句话）
// 「待审那一档翻页 ⇒ **重新向域要那一页**（请求带 `page`/`pageLength`/`scope`），
//   页面上摆的是**域给的那一页**（不是把旧的全量在前端切一刀）；
//   域回 `{cards,total}` ⇒ 分页条上「共 N 张」用那个 **total**；
//   域回旧数组形状 ⇒ 壳自己切页，**仍能翻**；
//   「已确认」那一档（跨声明）⇒ **每个声明**都收到 `scope:'done'`，
//   总数＝**各声明真实总数之和**；
//   搜索词**交给服务端**（`q`）；域不做服务端搜索时**如实标成前端过滤**。」
//
// ⚠️ **不是读源码找字符串** —— 壳那半用公用夹具 `helpers/review-center-shell.mjs`
//   装进最小 DOM **真的跑一遍**再查它产出的东西（请求参数 ＋ 页面上的东西）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, pageHost, settle } from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click' });
const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');
const cardIdsOf = dom => cardsOf(dom).map(card => card.getAttribute('data-review-card'));
const pagerText = dom => {
  const node = dom.body.querySelector('[data-review-pagination-status]');
  return node ? String(node.textContent) : '';
};

/** 一份**按契约分页**的域：新形状 `{cards, total}`，页里带页号标记（好认出是域给的那一页）。 */
function pagedDeclaration(total, tag) {
  const calls = [];
  const list = async (options = {}) => {
    calls.push(options || {});
    const page = Number(options.page) || 1;
    const pageLength = Number(options.pageLength) || 12;
    const scope = String(options.scope || 'pending');
    const all = Array.from({ length: total }, (_, i) => sampleCard({
      id: tag + '-CARD-' + i,
      title: '第' + page + '页-' + scope + '-官文 ' + i,
      enteredAt: '2026-10-27 10:' + String(59 - (i % 60)).padStart(2, '0'),
    }));
    const start = (page - 1) * pageLength;
    return { cards: all.slice(start, start + pageLength), total };
  };
  return { calls, list };
}

/** 把壳装好、登记声明、挂上这一页。 */
async function openPage(dom, specs) {
  const { window } = loadShell(dom);
  specs.forEach(spec => registerSampleDeclaration(window, spec));
  const host = pageHost(dom);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return window.shangshuReviewCenter;
}

test('① 待审那一档翻页 ⇒ **重新向域要那一页**（请求带 page/pageLength/scope），摆的是域给的那一页', async () => {
  const dom = createDom();
  const paged = pagedDeclaration(30, 'A');
  const api = await openPage(dom, [{ key: 'sample.notice', list: paged.list }]);

  /* —— 第一次请求：带上了契约里的那几个参数。 —— */
  assert.equal(paged.calls.length, 1, '进这一页没有向域要卡');
  const first = paged.calls[0];
  assert.equal(Number(first.page), 1, '第一次请求的页码不是 1');
  assert.equal(Number(first.pageLength), 12, '第一次请求没带每页 12 条');
  assert.equal(String(first.scope), 'pending', '第一次请求没带 scope=pending');
  assert.deepEqual(cardIdsOf(dom).slice(0, 2), ['A-CARD-0', 'A-CARD-1'], '第一页摆的不是域给的那一页');
  assert.match(String(cardsOf(dom)[0].textContent), /第1页-pending/,
    '第一页摆的不是域给的第 1 页：' + String(cardsOf(dom)[0].textContent).slice(0, 40));

  /* —— **翻页 ⇒ 重新向域要那一页**（不是把旧的全量在前端切一刀）。 —— */
  click(dom.body.querySelector('[data-review-page="next"]'));
  await settle();
  assert.equal(paged.calls.length, 2, '翻页没有重新向域要那一页（还是在前端切旧数据）');
  const second = paged.calls[1];
  assert.equal(Number(second.page), 2, '翻页那次请求的页码不是 2：' + Number(second.page));
  assert.equal(Number(second.pageLength), 12, '翻页那次请求没带每页 12 条');
  assert.equal(String(second.scope), 'pending', '翻页那次请求没带 scope=pending');
  assert.match(String(cardsOf(dom)[0].textContent), /第2页-pending/,
    '翻页后摆的还是第 1 页的卡（前端切了旧数据，不是域给的那一页）');
  assert.deepEqual(cardIdsOf(dom).slice(0, 2), ['A-CARD-12', 'A-CARD-13'],
    '翻页后摆的不是域给的第 2 页：' + cardIdsOf(dom).slice(0, 2).join('、'));

  /* —— 往回翻也是**向域要那一页**。 —— */
  click(dom.body.querySelector('[data-review-page="previous"]'));
  await settle();
  assert.equal(Number(paged.calls[2].page), 1, '往回翻没有向域要第 1 页');
  assert.match(String(cardsOf(dom)[0].textContent), /第1页-pending/, '往回翻后摆的不是域给的第 1 页');
  assert.ok(api, '壳没起来');
});

test('② 域回 `{cards,total}` ⇒ 分页条上的「共 N 张」用那个 **total**（不是这一页取回来的条数）', async () => {
  const dom = createDom();
  const paged = pagedDeclaration(30, 'A');
  await openPage(dom, [{ key: 'sample.notice', list: paged.list }]);

  assert.equal(cardsOf(dom).length, 12, '这一页不是 12 张');
  assert.match(pagerText(dom), /共 30 张/, '「共 N 张」没用域给的真实总数：' + pagerText(dom));
  assert.match(pagerText(dom), /第 1 \/ 3 页/, '总页数不是按真实总数算的：' + pagerText(dom));
});

test('③ 域回**旧数组形状** ⇒ 壳**降级自己切片**，仍能翻页（老用法不许破）', async () => {
  const dom = createDom();
  const calls = [];
  const legacy = async (options = {}) => {
    calls.push(options || {});
    return Array.from({ length: 25 }, (_, i) => sampleCard({
      id: 'LEG-' + i, title: '老形状官文 ' + i, enteredAt: '2026-10-27 09:' + String(59 - (i % 60)).padStart(2, '0'),
    }));
  };
  await openPage(dom, [{ key: 'sample.notice', list: legacy }]);

  assert.equal(cardsOf(dom).length, 12, '老形状没有摆满一页 12 张');
  assert.match(pagerText(dom), /共 25 张/, '老形状的总数不对：' + pagerText(dom));

  click(dom.body.querySelector('[data-review-page="next"]'));
  await settle();
  assert.equal(cardsOf(dom).length, 12, '老形状翻页后不是 12 张');
  assert.equal(cardsOf(dom)[0].getAttribute('data-review-card'), 'LEG-12',
    '老形状翻页后摆的不是接下来的 12 张：' + cardsOf(dom)[0].getAttribute('data-review-card'));

  click(dom.body.querySelector('[data-review-page="next"]'));
  await settle();
  assert.equal(cardsOf(dom).length, 1, '老形状翻到最后一页不是 1 张');
  assert.equal(cardsOf(dom)[0].getAttribute('data-review-card'), 'LEG-24',
    '老形状最后一页摆错了');
  assert.equal(dom.body.querySelector('[data-review-page="next"]').disabled, true,
    '老形状翻到最后一页「下一页」还是可点的');
});

test('④ 「已确认」那一档（跨声明）⇒ **每个声明**都收到 `scope:done`，总数＝**各声明真实总数之和**', async () => {
  const dom = createDom();
  const a = pagedDeclaration(20, 'A');
  const b = pagedDeclaration(7, 'B');
  await openPage(dom, [
    { key: 'sample.notice', list: a.list },
    { key: 'sample.second', list: b.list },
  ]);

  /* —— 切到「已确认」那一档。 —— */
  click(dom.body.querySelector('[data-review-deck="__done__"]'));
  await settle();

  const doneCalls = a.calls.concat(b.calls).filter(call => String(call.scope) === 'done');
  assert.equal(doneCalls.length, 2, '「已确认」那一档没有**每个声明各要一次**（scope=done）');
  assert.ok(doneCalls.every(call => Number(call.page) >= 1 && Number(call.pageLength) === 12),
    '「已确认」那一档的请求没带 page/pageLength');

  /* —— **总数必须真实**：各声明的真实总数之和（20 + 7 ＝ 27）。 —— */
  assert.match(pagerText(dom), /共 27 张/, '「已确认」那一档的总数不是各声明真实总数之和：' + pagerText(dom));
});

test('⑤ 搜索词**交给服务端**（`q`）；域不做服务端搜索时**如实标成前端过滤**', async () => {
  const dom = createDom();
  const paged = pagedDeclaration(30, 'A');
  await openPage(dom, [{ key: 'sample.notice', list: paged.list }]);

  const search = dom.body.querySelector('[data-review-search]');
  search.value = '受理';
  search.dispatchEvent({ type: 'input' });
  await settle();

  const withQuery = paged.calls.filter(call => String(call.q || '') === '受理');
  assert.ok(withQuery.length >= 1, '搜索词没有交给服务端（q 参数）');

  /* —— 域**没有**按 q 筛（总数没变）⇒ 如实标成**前端过滤**（不假装真搜索）。 —— */
  const search2 = dom.body.querySelector('[data-review-search]');
  assert.equal(search2.getAttribute('data-review-search-mode'), 'client',
    '域没做服务端搜索，却标成了服务端搜索（假装真搜索）');
});

test('⑥ 域**真的按 q 筛了**（总数变少）⇒ 标成服务端搜索', async () => {
  const dom = createDom();
  const calls = [];
  const list = async (options = {}) => {
    calls.push(options || {});
    const query = String(options.q || '');
    /* —— 域自己按 q 筛（总数变少）—— */
    const total = query ? 4 : 30;
    const page = Number(options.page) || 1;
    const pageLength = Number(options.pageLength) || 12;
    const all = Array.from({ length: total }, (_, i) => sampleCard({
      id: 'Q-CARD-' + i, title: '受理 ' + i, enteredAt: '2026-10-27 08:' + String(59 - (i % 60)).padStart(2, '0'),
    }));
    const start = (page - 1) * pageLength;
    return { cards: all.slice(start, start + pageLength), total };
  };
  await openPage(dom, [{ key: 'sample.notice', list }]);

  const search = dom.body.querySelector('[data-review-search]');
  search.value = '受理';
  search.dispatchEvent({ type: 'input' });
  await settle();

  const search2 = dom.body.querySelector('[data-review-search]');
  assert.equal(search2.getAttribute('data-review-search-mode'), 'server',
    '域真的按 q 筛了（总数变少），却标成了前端过滤');
  assert.match(pagerText(dom), /共 4 张/, '搜索后的总数不是域给的真实总数：' + pagerText(dom));
});

test('⑦ 域**不支持服务端搜索** ⇒ 壳把这一档的其余页也取回来（搜索**不只覆盖当前一页**），且如实标成前端过滤', async () => {
  const dom = createDom();
  const calls = [];
  const list = async (options = {}) => {
    calls.push(options || {});
    const page = Number(options.page) || 1;
    const pageLength = Number(options.pageLength) || 12;
    const all = Array.from({ length: 30 }, (_, i) => sampleCard({
      id: 'S-CARD-' + i,
      /* —— 只有第 25 张带这个词（它在**第 3 页**上 ⇒ 只筛当前页会漏掉它）。 —— */
      title: i === 25 ? '命中词 唯一那张' : '官文 ' + i,
      enteredAt: '2026-10-27 07:' + String(59 - (i % 60)).padStart(2, '0'),
    }));
    const start = (page - 1) * pageLength;
    /* —— **域不支持服务端搜索**（`q` 交了也不筛：总数不变）。 —— */
    return { cards: all.slice(start, start + pageLength), total: 30 };
  };
  await openPage(dom, [{ key: 'sample.notice', list }]);

  const search = dom.body.querySelector('[data-review-search]');
  search.value = '命中词';
  search.dispatchEvent({ type: 'input' });
  await settle();

  /* —— **找得到第 3 页上那张**（不是只筛当前这一页）。 —— */
  assert.deepEqual(cardIdsOf(dom), ['S-CARD-25'],
    '搜索只覆盖了当前那一页（别的页上的命中被漏掉）：' + cardIdsOf(dom).join('、'));
  /* —— **如实标成前端过滤**（不假装真搜索）。 —— */
  assert.equal(dom.body.querySelector('[data-review-search]').getAttribute('data-review-search-mode'),
    'client', '域没做服务端搜索，却标成了服务端搜索');
  /* —— **总数是筛过之后的条数**（1 张）。 —— */
  assert.match(pagerText(dom), /共 1 张/, '搜索后的总数不对：' + pagerText(dom));
});
