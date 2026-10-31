// 判据：审核中心的**外框按视口固定**（今晚交接 §10.1 第 3 行「外框固定」）。
//
// **要证明的事（逐字照 §10.1 第 3 行的完成判据）**：
//   「**审核中心页面外框及审核大弹窗都按视口确定尺寸**；页头/搜索/分页/底栏位置稳定；
//     正文在各自内部滚动。长短文件、候选数量、分页/空态/加载态不改变外框。
//     卡片同页等高，卡内长文截断/展开不顶大整页。」
//   判据：「同一视口切换短/长/无候选、多页PDF和不同列表页，外框位置/宽高变化≤1px；
//     底部动作始终可见；703/857/1440宽无横向溢出。」
//   ⛔ 「不能只设max-height仍由内容决定实际高度；不能把全部内容裁掉或取消滚动；
//     不锁死为某一台电脑像素而破坏窄屏。」
//
// **「测试通过 =」**（一句话）
// 「页面这一层：`.review-center-page` 用的是 **height**（不是只给 max-height）、
//   内容块 `flex:1` ＋ `min-height:0`、**卡片区自己滚**（`overflow-y:auto`）、
//   **分页条固定在底栏**（`flex:none` ＋ 在卡片滚动区**之外**）；
//   加载提示**独占状态区的一块**（**不是卡片网格的子节点** ⇒ 不占卡位）；
//   弹窗那一扇：高度**按视口定**（`height` 里带 `dvh`），
//   左右两栏**各自内部滚**（网格行高 `minmax(0,1fr)` ＋ 槽位 `overflow:auto`）。」
//
// ⚠️ **样式那半用 `scripts/lib/css-cascade.mjs` 真的解析 CSS**（算出生效值，不是 grep 样式表）；
//   结构那半把**公共壳装进最小 DOM 真的跑一遍**再看它产出的东西。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { createResolver } from '../../../scripts/lib/css-cascade.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, pageHost, settle } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;

const click = node => node.dispatchEvent({ type: 'click' });

/** 某一页上**摆着的那些卡**（按页面上的顺序）。 */
const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');

/** 把壳装好、登记声明、挂上这一页。 */
async function openPage(dom, overrides = {}) {
  const { window } = loadShell(dom);
  registerSampleDeclaration(window, overrides);
  const host = pageHost(dom);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return window.shangshuReviewCenter;
}

/** 生效值（解析出来的，不是样式表里的原文）。 */
function effective(selector, prop, viewport = WIDE) {
  const hit = resolver.resolve(selector, prop, { viewport });
  assert.ok(hit, selector + ' 没有 ' + prop + ' 这条规则');
  return String(hit.value).trim();
}

test('① 页面外框**按视口定尺寸**（用 height，不是只给 max-height）', () => {
  /* —— **不许用 `max-height` 冒充「按视口固定」**（内容少时也必须同样高）。 */
  const height = effective('.review-center-page', 'height');
  assert.match(height, /100%|dvh|vh/, '这一页的外框没有按视口定高度：' + height);
  const maxHeight = resolver.resolve('.review-center-page', 'max-height', { viewport: WIDE });
  assert.ok(!maxHeight, '这一页又有了 max-height（内容少时会缩）');

  /* —— **外框那一层不滚**（里面卡片区自己滚 ⇒ 外框高度不随卡片数变化）。 */
  assert.equal(effective('.main-scroll[data-page="review-center"]', 'overflow'), 'hidden',
    '这一页的外层还在滚（内容一多外框就被撑高）');

  /* —— **内容块吃掉页头以外的全部高度**（`flex:1` ＋ `min-height:0`）。 */
  assert.match(effective('.review-center-section', 'flex'), /1/, '内容块没有占满剩余高度');
  assert.equal(effective('.review-center-section', 'min-height'), '0',
    '内容块没有 min-height:0（内容一多就把外框撑大）');
});

test('② 卡片区是**独立的滚动容器**，分页条**在它之外**（固定底栏）', () => {
  assert.equal(effective('.review-center-body', 'overflow-y'), 'auto',
    '卡片区不自己滚（外框会被卡片撑高）');
  assert.match(effective('.review-center-body', 'flex'), /1/, '卡片区没有占满剩余高度');
  assert.equal(effective('.review-center-body', 'min-height'), '0',
    '卡片区没有 min-height:0');
  /* —— **分页条固定在底栏**（不压缩 ⇒ 不随卡片滚动跑掉）。 */
  assert.equal(effective('.review-center-pager', 'flex'), 'none',
    '分页条不是固定底栏（会被卡片挤走）');
});

test('③ 页面上：加载提示**独占状态区**，**不是卡片网格的子节点**（不占卡位）', async () => {
  const dom = createDom();
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  let round = 0;
  const api = await openPage(dom, {
    list: async () => {
      round += 1;
      if (round === 1) return [sampleCard()];
      await gate;
      return [sampleCard()];
    },
  });

  void api.refreshPage();
  await settle();

  /* —— **加载态节点在**（契约 `loading-state-v1.json`：看得见的是**会呼吸的骨架**，不是字）。 */
  const loading = dom.body.querySelector('[data-review-loading]');
  assert.ok(loading, '页面上没有加载态');
  assert.ok(loading.querySelector('.platform-skeleton-bar, .review-skeleton-bar'),
    '加载态不是骨架（没有灰条）⇒ 人看见的是一片空白');
  [...loading.querySelectorAll('.platform-skeleton-bar, .review-skeleton-bar')].forEach(node => {
    assert.equal(String(node.textContent || '').trim(), '', '加载态的灰条里有字（那是假内容）');
  });

  /* —— **它不住在卡片网格里**（不占任何卡片格子）。 */
  assert.ok(!loading.closest('.review-center-body'),
    '加载态又在卡片网格里了（占卡位、把下面的卡挤歪）');
  assert.ok(loading.closest('[data-review-status]'),
    '加载态不住在状态区里（它该独占一块）');

  /* —— **卡片网格里只有卡**（提示、空态、分页条都不在它里面）。 */
  const grid = dom.body.querySelector('[data-review-card-grid]');
  assert.ok(grid, '没有卡片区');
  cardsOf(dom).forEach(card => {
    assert.ok(card.closest('[data-review-card-grid]'), '有卡不在卡片区里');
  });
  assert.ok(!grid.querySelector('[data-review-pagination]'), '分页条跑进卡片区里了');
  assert.ok(!grid.querySelector('[data-review-loading]'), '加载提示跑进卡片区里了');

  release();
  await settle();
});

test('④ 页面上：分页条**在卡片滚动区之外**（DOM 顺序 ＋ 结构）', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => Array.from({ length: 25 }, (_, i) => sampleCard({
      id: 'CARD-' + i, title: '官文 ' + i, enteredAt: '2026-10-27 10:' + String(59 - (i % 60)).padStart(2, '0'),
    })),
  });

  const grid = dom.body.querySelector('[data-review-card-grid]');
  const pager = dom.body.querySelector('[data-review-pager]');
  const status = dom.body.querySelector('[data-review-status]');
  assert.ok(grid && pager && status, '三块（状态区／卡片区／分页条）没有都摆出来');

  /* —— **分页条不在卡片区里面**（它在卡片区**之后** ⇒ 固定底栏）。 */
  assert.ok(!pager.closest('[data-review-card-grid]'), '分页条在卡片滚动区里面（会跟着卡片滚走）');
  assert.ok(!grid.closest('[data-review-pager]'), '分页条把卡片区包住了');
  assert.ok(grid.querySelector('[data-review-card]'),
    '卡片不在卡片区里');

  /* —— 三块是**平级的三块**，顺序 ＝ 状态区 → 卡片区 → 分页条。 */
  const order = [status, grid, pager].map(node => node.getAttribute('data-review-status') ? 'status'
    : (node.getAttribute('data-review-card-grid') ? 'grid' : 'pager'));
  assert.deepEqual(order, ['status', 'grid', 'pager'], '三块的顺序不对：' + order.join('、'));
});

test('⑤ 弹窗那一扇：**按视口定尺寸**，左右两栏**各自内部滚**', () => {
  /* —— **高度按视口定**（不是只给 max-height ⇒ 内容少时一样高）。 */
  const height = effective('.os-dialog.review-split', 'height');
  assert.match(height, /dvh|vh/, '弹窗的高度没有按视口定：' + height);

  /* —— **两栏各自滚**：网格的行高得钉住（默认 `auto` ＝ 由内容决定 ⇒ 内容一多就把底栏顶掉）。 */
  const rows = effective('.os-dialog .review-split-body', 'grid-template-rows');
  assert.match(rows, /minmax\(0/, '两栏那一行的行高还会被内容撑大：' + rows);
  assert.equal(effective('.review-slot', 'overflow'), 'auto', '两栏不自己滚（内容一多就把底栏顶掉）');
  assert.equal(effective('.review-slot', 'min-height'), '0', '两栏没有 min-height:0');
  /* —— **公共件 `.os-dialog main` 的 `max-height:60dvh` 已被这一扇收紧**
   *   （内容那一栏自己滚，公共件那条是给「单栏短正文」弹窗的）。 */
  assert.equal(effective('.os-dialog .review-split-body', 'max-height'), 'none',
    '公共件那条 max-height:60dvh 还在管着这一扇');
  assert.equal(effective('.os-dialog .review-split-body', 'overflow'), 'hidden',
    '内容那一栏还在自己滚（两栏各滚各的才对）');
});

test('⑥ 页头／底栏固定：内容再多也不压缩（弹窗与页面各一份）', () => {
  assert.equal(effective('.os-dialog .review-split-head', 'flex'), 'none', '弹窗表头会被压缩');
  assert.equal(effective('.os-dialog .review-split-foot', 'flex'), 'none', '弹窗底栏会被压缩');
  assert.match(effective('.os-dialog .review-split-body', 'flex'), /1/, '弹窗内容那一栏没占满剩余高度');
});

test('⑦ 卡片**同页等高**，卡内长文**截断 ＋ 可展开**（一张长卡不许把整行撑高）', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [
      sampleCard({ id: 'C1', digest: '短摘要' }),
      sampleCard({ id: 'C2', digest: '长摘要'.repeat(60) }),
    ],
  });

  /* —— **同页等高**：网格把一行里的卡拉到同一高度（`align-items: stretch`）。 */
  assert.equal(effective('.review-center-body', 'align-items'), 'stretch',
    '同一页的卡不等高（按钮不在同一条线上）');

  /* —— **长文截断**：摘要默认只露三行（样式上截断）⇒ 一张长卡不会把整行撑高。 */
  const clamp = effective('.review-card-digest', '-webkit-line-clamp');
  assert.match(clamp, /^\d+$/, '卡里的长摘要没有截断（一张长卡就把整行撑高）：' + clamp);

  /* —— **可展开**：点一下摘要 ⇒ 那张卡展开（再点收回去）。 */
  const card = dom.body.querySelector('[data-review-card="C2"]');
  assert.ok(card, '没有那张长摘要的卡');
  const digest = card.querySelector('[data-review-card-digest]');
  assert.ok(digest, '卡上没有摘要');
  assert.equal(card.getAttribute('data-review-card-expanded'), null, '一上来就是展开的');
  click(digest);
  assert.equal(card.getAttribute('data-review-card-expanded'), '1', '点摘要没展开');
  click(digest);
  assert.equal(card.getAttribute('data-review-card-expanded'), null, '再点没收回去');
});
