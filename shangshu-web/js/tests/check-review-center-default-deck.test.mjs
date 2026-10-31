// 判据：审核中心**一进来要看得见活**（默认落在「有未处理卡的那一片」）＋ **刷新时要看得见在读**。
//
// **为什么有这一条**（2026-10-24 夜班自己上 3850 站真点出来的）：
//   站上审核中心的分档片是「更新 **0** ／ 待核对 **1** ／ 已确认 **33**」，
//   而**进页面默认落在第一片「新通知书带来的更新」**（0 张卡）
//   ⇒ 整页只写着「**当前范围没有记录**」
//   ⇒ **用户以为没有待办**（真正那张待审灰卡在第二片里，点一下才看得见）。
//   ⚠️ 这不是数据问题（PKG-070 的效果在：待核对 1 张、已确认 33 张都对），
//      是**「落在哪一片」这件事没人管**。
//
// **「测试通过 =」**（一句话）
// 「打开审核中心 ⇒ **页面上直接摆着有活的那一档的卡**（第一档没有待办的卡、第二档有一张
//   ⇒ 一进来看到的是**第二档那张卡**，不是一片空白）；**每一档都有活时仍落在第一档**；
//   **用户自己点了片之后不再被自动挪走**；
//   **页头右上没有「刷新」按钮**（2026-10-24 20:5x 用户拍板「这个去掉」），
//   **但刷新时页面上照样看得见「正在读取…」**（刷新走公共 API，不走按钮）。」
//
// ⚠️ **不是读源码找字符串** —— 用公用夹具 `helpers/review-center-shell.mjs` 把壳装进最小 DOM
//   **真的跑一遍**再查它产出的东西。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle, fileCenterVersions } from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click' });
const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');
const chipsOf = dom => dom.body.querySelectorAll('[data-review-deck]');

/** 「已确认」那一档的键（壳内置，永远在）。 */
const DONE_DECK = '__done__';

/** 一张**待处理**的卡（state=pending ⇒ 不算已审过）。 */
const pendingCard = (id, overrides = {}) => sampleCard(Object.assign({
  id,
  state: 'pending',
  enteredAt: '2026-10-23 10:00',
  changes: [{ id: id + '#c1', label: '官文信息核对', before: '审查中', after: '实质审查中' }],
}, overrides || {}));

/** 一张**已审过**的卡（state=confirmed ⇒ 落在「已确认」那一片里）。 */
const doneCard = (id, overrides = {}) => sampleCard(Object.assign({
  id,
  state: 'confirmed',
  enteredAt: '2026-10-23 10:00',
  changes: [{ id: id + '#c1', label: '官文信息核对', before: '审查中', after: '实质审查中' }],
}, overrides || {}));

/** 把壳装好、登记示例声明、挂上这一页。 */
async function openPage(dom, overrides = {}, extra = []) {
  const { window, calls } = loadShell(dom, { readFileCenterVersions: fileCenterVersions });
  registerSampleDeclaration(window, overrides);
  extra.forEach(spec => registerSampleDeclaration(window, spec));
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return { window, calls, host };
}

/** 第二档的声明（第一档是夹具自带的 `sample.notice`）。 */
const secondDeck = {
  key: 'sample.second',
  name: '示例：第二档',
  list: async () => [pendingCard('D1')],
};

test('① 进页面落在**有未处理卡的那一片**：第一档 0 张、第二档 1 张 ⇒ 一进来就看得见第二档那张卡', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [] }, [secondDeck]);

  const ids = cardsOf(dom).map(card => card.getAttribute('data-review-card'));
  assert.deepEqual(ids, ['D1'],
    '一进来没有落在有活的那一片（用户以为没有待办）：' + (ids.length ? ids.join('、') : '一片空白'));

  /* 分档片上也是第二档在选中。 */
  const active = chipsOf(dom).find(chip => chip.getAttribute('data-review-active') === '1');
  assert.ok(active, '没有一片是选中的');
  assert.equal(active.getAttribute('data-review-deck'), 'sample.second',
    '选中的不是有活的那一片');
});

test('② **每一档都有未处理的卡** ⇒ 仍落在第一档（不许乱跳）', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [pendingCard('C1')] }, [{
    key: 'sample.second',
    name: '示例：第二档',
    list: async () => [pendingCard('D1')],
  }]);

  const ids = cardsOf(dom).map(card => card.getAttribute('data-review-card'));
  assert.deepEqual(ids, ['C1'], '不该跳片却跳了：' + ids.join('、'));
});

test('③ **所有档都没有未处理的卡**（只有「已确认」有卡）⇒ 仍落在第一档，不跳到「已确认」', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [doneCard('C1')] }, [{
    key: 'sample.second',
    name: '示例：第二档',
    list: async () => [doneCard('D1')],
  }]);

  const active = chipsOf(dom).find(chip => chip.getAttribute('data-review-active') === '1');
  assert.ok(active, '没有一片是选中的');
  assert.equal(active.getAttribute('data-review-deck'), 'sample.notice',
    '跳到别的片去了（没有待办就该停在第一档）：' + active.getAttribute('data-review-deck'));
});

test('④ **用户自己点了片之后不再被自动挪走**（点第二档 ⇒ 之后重新读数据仍停在第二档）', async () => {
  const dom = createDom();
  let round = 0;
  const { window } = await openPage(dom, {
    /* 第一轮：第二档有卡；再读一次时两档都没卡 ⇒ 若会自动挪走，这一轮就能看出来。 */
    list: async () => [pendingCard('C1')],
  }, [{
    key: 'sample.second',
    name: '示例：第二档',
    list: async () => {
      round += 1;
      return round === 1 ? [pendingCard('D1')] : [];
    },
  }]);

  const secondChip = chipsOf(dom).find(chip => chip.getAttribute('data-review-deck') === 'sample.second');
  assert.ok(secondChip, '页面上没有第二档的片子');
  click(secondChip);
  await settle();
  assert.deepEqual(cardsOf(dom).map(card => card.getAttribute('data-review-card')), ['D1'],
    '点了第二档的片，卡没换过去');

  /* 再读一次（模拟刷新）：两档都没未处理的卡了 ⇒ **不许**把用户挪走。 */
  await window.shangshuReviewCenter.refreshPage();
  await settle();
  const active = chipsOf(dom).find(chip => chip.getAttribute('data-review-active') === '1');
  assert.ok(active, '没有一片是选中的');
  assert.equal(active.getAttribute('data-review-deck'), 'sample.second',
    '用户点过的那一片被自动挪走了');
});

test('⑤ 点「刷新」时**页面上看得见加载态**（不许干等 6.5 秒像没点）', async () => {
  const dom = createDom();
  let release = null;
  let round = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { window } = await openPage(dom, {
    list: async () => {
      round += 1;
      /* **第一次**读要立刻回来（页面得先打开）；**第二次**（刷新那趟）卡住
         ⇒ 好观察「读还没结束时页面上有没有交代」。 */
      if (round === 1) return [pendingCard('C1')];
      await gate;
      return [pendingCard('C1')];
    },
  });

  /* ⚠️ **2026-10-24 20:5x 用户拍板：页头右上那个「刷新」按钮去掉了**
     （用户在站上指着它说「这个去掉」）⇒
     ① 页头上**不许再有**那个按钮；
     ② 「刷新时要看得见加载态」这件事**不许丢** —— 它走**公共 API**（`refreshPage()`），
        不走按钮。
     ⚠️ **2026-10-28 契约变了**（`loading-state-v1.json`）：看得见的加载态**不许用文字**
        ⇒ 现在人看见的是**会呼吸的骨架**（原来那句「正在读取…」撤了）。 */
  assert.ok(!dom.body.querySelector('[data-review-refresh]'),
    '页头右上那个「刷新」按钮还在（用户 2026-10-24 20:5x 拍板「这个去掉」）');
  void window.shangshuReviewCenter.refreshPage();
  /* 读还没结束 ⇒ 页面上要有交代（**看得见的**是骨架，不是字）。 */
  await settle();
  const section = dom.body.querySelector('[data-review-page-section]');
  assert.ok(section, '没有审核中心那一块');
  const loading = dom.body.querySelector('[data-review-loading]');
  assert.ok(loading, '刷新时页面上没有加载态（用户以为没点上）');
  assert.ok(loading.querySelector('.platform-skeleton-bar, .review-skeleton-bar'),
    '刷新时的加载态不是骨架（没有灰条）⇒ 人看见的是一片空白');
  [...loading.querySelectorAll('.platform-skeleton-bar, .review-skeleton-bar')].forEach(node => {
    assert.equal(String(node.textContent || '').trim(), '', '加载态的灰条里有字（那是假内容）');
  });
  /* ⚠️ **2026-10-27（PKG-132 ·「外框固定／加载提示不占卡位」）改的落点**：
   *   加载态以前是 append 进 `.review-center-body`（**卡片网格**）的
   *   ⇒ 它占掉一整行、把下面的卡往下挤（加载态一进来整页版式就变了）。
   *   ⇒ 现在它住在**独立的状态区**里（`[data-review-status]`），
   *   **不占任何卡片格子**。 */
  const grid = dom.body.querySelector('.review-center-body');
  assert.ok(grid, '没有卡片网格');
  assert.ok(!loading.closest('.review-center-body'),
    '加载态又回到卡片网格里了（占卡位、把下面的卡挤歪）');
  assert.ok(loading.closest('[data-review-status]'),
    '加载态不住在状态区里（它该独占一块，不占卡位）');

  release();
  await settle();
  assert.ok(!/正在读取/.test(String(dom.body.querySelector('[data-review-page-section]').textContent)),
    '读完了还留着加载那句话（读屏那一层也该撤掉）');
  assert.ok(!dom.body.querySelector('[data-review-loading]'),
    '读完了加载态还挂在页面上');
});
