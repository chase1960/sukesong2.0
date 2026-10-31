// 判据：审核中心改**看板式布局**（用户 2026-10-23 22:13～22:18 拍板）。
//
// **用户拍板的口径（逐条）**：
//  ① 布局参考**看板的骨架**（顶部筛选片 ＋ 右上几个大数字），**视觉/圆角全用我们自己的**；
//  ② **横向看板列＝不存在** ⇒ 卡片**一行张按「进入审核中心的时间」铺开**（新的在上），
//     **不要日期分隔线**、**不要按时间分档切换**，只在**卡上显示进入时间**；
//  ③ **顶部页头右上＝分档片**：每个进这一页的声明一片 ＋ **件数＝卡张数**，点片＝筛那一类；
//     **不写死三个**（域给几档显示几档）；**「已确认」是与「新通知书更新」平级、永远都在的一档**；
//  ④ **「AI 建议」那块整个去掉**（数字块 ＋ 那条「去处理」指路行都去掉 —— 对话里就看得见没审的卡）；
//  ⑤ **缺件待补只做卡上的一个信息**（就是 PKG-065 那行摘要），**其他地方不许出现**；
//  ⑥ **待审的卡都是灰色的**；**驳回的卡点不开**（只显示快照：标题＋结论＋理由＋时间，无原件、无下载）；
//  ⑦ **搜索必须保留**（契约 §4 明写「支持搜索与待处理/已处理查看」）。
//
// **测试通过 =**（一句话）
// 「打开审核中心 ⇒ **页头右上**摆着**分档片**（域给的每一档一片 ＋ 永远在的「已确认」一片，
//   每片带**卡张数**，点片就筛那一类）；**没有「AI 建议」那块**（也没有那条「去处理」指路行）；
//   卡片**一行铺开**、**按进入审核中心的时间新的在上**、卡上**印着进入时间**；
//   **待审的卡是灰的**；**驳回的卡点不开**（只有标题＋结论＋理由＋时间，没有原件、没有下载）；
//   **搜索还在**。」
//
// ⚠️ **不是读源码找字符串** —— 壳那半用公用夹具 `helpers/review-center-shell.mjs` 装进最小 DOM
//   **真的跑一遍**再查它产出的东西；样式那半用 `scripts/lib/css-cascade.mjs` **真的解析 CSS**
//   （不是 grep 样式表里有没有那句话）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { createResolver } from '../../../scripts/lib/css-cascade.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle, fileCenterVersions } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);

const click = node => node.dispatchEvent({ type: 'click' });
const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');
const chipsOf = dom => dom.body.querySelectorAll('[data-review-deck]');

/** 「已确认」那一档的键（壳内置，永远在）。 */
const DONE_DECK = '__done__';

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

/** 往上找带这个类的祖先（判断「是不是摆在页头里」）。 */
function ancestorWithClass(node, className) {
  let cursor = node;
  while (cursor) {
    if (String(cursor.className || '').split(/\s+/).includes(className)) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

/** 一张带**进入时间**的卡。 */
const cardWithEnteredAt = (id, enteredAt, overrides = {}) => sampleCard(Object.assign({
  id,
  enteredAt,
  changes: [{
    id: id + '#c1', label: '官文信息核对', before: '审查中', after: '实质审查中',
  }],
}, overrides || {}));

test('① 页头右上摆着**分档片**：域给的每一档一片 ＋「已确认」一片永远在，每片带**卡张数**', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [cardWithEnteredAt('C1', '2026-10-23 10:00'), cardWithEnteredAt('C2', '2026-10-23 11:00')],
  }, [{
    key: 'sample.second',
    name: '示例：第二档',
    list: async () => [cardWithEnteredAt('D1', '2026-10-23 09:00')],
  }]);

  const decks = dom.body.querySelector('[data-review-decks]');
  assert.ok(decks, '页头右上没有分档片（那一块不见了）');
  assert.ok(ancestorWithClass(decks, 'page-hd'),
    '分档片不在页头里（用户要的是「顶部页头右上」，不是另起一行）');

  const chips = chipsOf(dom);
  const keys = chips.map(chip => chip.getAttribute('data-review-deck'));
  assert.ok(keys.includes('sample.notice'), '域给的那一档没有片子：' + keys.join('、'));
  assert.ok(keys.includes('sample.second'), '域给的第二档没有片子（不许写死几个）：' + keys.join('、'));
  assert.ok(keys.includes(DONE_DECK), '「已确认」那一档不见了（它要永远在）：' + keys.join('、'));

  /* **件数＝卡张数**（不是「几条变更」）。 */
  const chip = chips.find(item => item.getAttribute('data-review-deck') === 'sample.notice');
  const count = chip.querySelector('[data-review-deck-count]');
  assert.ok(count, '分档片上没有件数');
  assert.equal(String(count.textContent).trim(), '2',
    '件数不是卡张数（这一档有两张卡）：' + count.textContent);
});

test('② 点片就筛那一类：点另一个声明片换那一档的卡，点「已确认」看已审过的卡', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [cardWithEnteredAt('C1', '2026-10-23 10:00')],
  }, [{
    key: 'sample.second',
    name: '示例：第二档',
    list: async () => [cardWithEnteredAt('D1', '2026-10-23 09:00')],
  }]);

  assert.deepEqual(cardsOf(dom).map(card => card.getAttribute('data-review-card')), ['C1'],
    '默认摆的不是第一档的卡');

  const secondChip = chipsOf(dom).find(chip => chip.getAttribute('data-review-deck') === 'sample.second');
  assert.ok(secondChip, '页面上没有第二档的片子（域给几档就得显示几档）');
  click(secondChip);
  await settle();
  assert.deepEqual(cardsOf(dom).map(card => card.getAttribute('data-review-card')), ['D1'],
    '点了第二档的片，卡没换过去');

  /* 「已确认」那一档：摆**已审过**的卡（不是待审的）。 */
  click(chipsOf(dom).find(chip => chip.getAttribute('data-review-deck') === DONE_DECK));
  await settle();
  const ids = cardsOf(dom).map(card => card.getAttribute('data-review-card'));
  assert.ok(!ids.includes('C1'), '「已确认」那一档里还摆着待审的卡');
});

test('③ 页面上**没有「AI 建议」那块**（也没有那条「去处理」指路行）', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [cardWithEnteredAt('C1', '2026-10-23 10:00')] });

  /* ⚠️ **不要写 `assert.equal(元素, null)`** —— node 会去**格式化那个 DOM 元素**做 diff
     （元素带 parentNode 回环）⇒ **整条判据卡住**。一律用 `assert.ok(!元素)`。 */
  assert.ok(!dom.body.querySelector('[data-review-redirect]'),
    '页面上还有那条「去处理」指路行（AI 建议那块没去掉）');
  const names = chipsOf(dom)
    .map(chip => chip.querySelector('[data-review-deck-name]'))
    .filter(Boolean)
    .map(node => String(node.textContent));
  assert.ok(!names.some(name => /AI 建议/.test(name)),
    '分档片里还有「AI 建议」那块：' + names.join('、'));
});

test('④ 卡片**一行铺开**、**按进入审核中心的时间新的在上**、卡上**印着进入时间**', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [
      cardWithEnteredAt('C1', '2026-10-23 10:00'),
      cardWithEnteredAt('C3', '2026-10-23 12:00'),
      cardWithEnteredAt('C2', '2026-10-23 11:00'),
    ],
  });

  const cards = cardsOf(dom);
  assert.deepEqual(cards.map(card => card.getAttribute('data-review-card')), ['C3', 'C2', 'C1'],
    '卡片没有按「进入审核中心的时间」新的在上排');

  const entered = cards[0].querySelector('[data-review-card-entered]');
  assert.ok(entered, '卡上没有印进入时间');
  assert.match(String(entered.textContent), /2026-10-23 12:00/,
    '卡上印的进入时间不对：' + entered.textContent);

  /* **多列多行铺开**（PKG-132 · 卡片多列多行分页；样式是真解析出来的，不是 grep 样式表）。
     ⚠️ 原来这条断的是 `display:flex`（一行铺开）；现在卡片是**网格多列**（交接 10.1 第 3 行）⇒
     判据跟着**当前口径**走：网格 ＋ 自动列 ＋ 卡片区自己滚。 */
  const display = resolver.resolve('.review-center-body', 'display');
  assert.ok(display, '.review-center-body 没有 display 规则');
  assert.equal(String(display.value).trim(), 'grid',
    '卡片区不是多列网格（display 不是 grid）：' + display.value);
  const columns = resolver.resolve('.review-center-body', 'grid-template-columns');
  assert.ok(columns && /auto-fill|auto-fit|repeat\(/.test(String(columns.value)),
    '卡片区不是多列（grid-template-columns 没有自动列）：' + (columns && columns.value));
  /* ⚠️ **横向不滚**（PKG-132 · 外框固定）：卡片是**网格多列**（装不下就换行，不是往右排）
     ⇒ 横向 `overflow-x: hidden`，**纵向自己滚**（`overflow-y: auto`）。 */
  const overflowX = resolver.resolve('.review-center-body', 'overflow-x');
  assert.ok(overflowX, '.review-center-body 没有横向溢出的规则');
  assert.equal(String(overflowX.value).trim(), 'hidden', '横向会滚动（卡片网格不该往右排）：' + overflowX.value);
  const overflowY = resolver.resolve('.review-center-body', 'overflow-y');
  assert.ok(overflowY, '.review-center-body 没有纵向滚动的规则');
  assert.equal(String(overflowY.value).trim(), 'auto', '卡片区不自己滚（卡片多就撑外框）：' + overflowY.value);
});

test('⑤ **待审的卡是灰的**（待审那张底色是浅灰那一档，已审过的那张不是）', async () => {
  const pending = resolver.resolve('.review-card[data-review-card-state="pending"]', 'background');
  const normal = resolver.resolve('.review-card', 'background');
  assert.ok(pending, '待审的卡没有单独的底色规则（没灰）');
  assert.ok(normal, '普通卡没有底色规则');
  assert.notEqual(String(pending.value).trim(), String(normal.value).trim(),
    '待审的卡与别的卡底色一样（没灰）');
  assert.match(String(pending.value), /--bg-alt/,
    '待审的卡底色不是浅灰那一档：' + pending.value);
});

test('⑥ **驳回的卡点不开**：只有快照（标题＋结论＋理由＋时间），没有原件、没有下载', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [cardWithEnteredAt('R1', '2026-10-23 19:00', {
      state: 'rejected',
      decision: '驳回',
      reason: '缺受理通知书',
      reviewedAt: '2026-10-23 20:10',
    })],
  });

  const doneChip = chipsOf(dom).find(chip => chip.getAttribute('data-review-deck') === DONE_DECK);
  assert.ok(doneChip, '页面上没有「已确认」那一档的片子（它要永远在）');
  click(doneChip);
  await settle();

  const cards = cardsOf(dom);
  assert.equal(cards.length, 1, '已确认那一档里没有这张驳回的卡');
  const card = cards[0];
  assert.ok(!card.querySelector('[data-review-card-open]'),
    '驳回的卡上还有「打开核对」（那就能改 ⇒ 不该能点开）');
  assert.match(String(card.textContent), /驳回/, '卡上没写结论');
  const reason = card.querySelector('[data-review-card-reason]');
  assert.ok(reason, '卡上没有理由那一行');
  assert.match(String(reason.textContent), /缺受理通知书/, '理由不对：' + reason.textContent);
  const reviewed = card.querySelector('[data-review-card-reviewed]');
  assert.ok(reviewed, '卡上没有审核时间那一行');
  assert.match(String(reviewed.textContent), /2026-10-23 20:10/, '审核时间不对：' + reviewed.textContent);

  /* 点那张卡也不开弹窗（没有原件、没有下载）。 */
  click(card);
  await settle();
  assert.ok(!dom.body.querySelector('[data-review-split]'), '点了驳回的卡还是弹出了弹窗');
  assert.ok(!card.querySelector('[data-review-card-open]'), '点开之后冒出「打开核对」了');
});

test('⑦ **搜索还在**（分档片搬走了，搜索不许跟着没）', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [cardWithEnteredAt('C1', '2026-10-23 10:00')] });
  assert.ok(dom.body.querySelector('[data-review-search]'), '搜索框不见了');
});

test('⑧ 卡上的时间**只印到秒**（内核给的是带微秒的原始时间 ⇒ 印到卡上要修掉那截小数）', async () => {
  /* 站上实看发现的：卡上印的是「进入审核中心：2026-10-23 18:56:30.586396」
     ⇒ 业务方看不懂、也不需要看到微秒。 */
  const dom = createDom();
  await openPage(dom, {
    list: async () => [cardWithEnteredAt('C1', '2026-10-23 18:56:30.586396')],
  });

  const entered = cardsOf(dom)[0].querySelector('[data-review-card-entered]');
  assert.ok(entered, '卡上没有印进入时间');
  assert.match(String(entered.textContent), /2026-10-23 18:56:30/,
    '卡上印的进入时间不对：' + entered.textContent);
  assert.ok(!/\.\d+/.test(String(entered.textContent)),
    '卡上印着带小数的时间（业务方看不懂，要修到秒）：' + entered.textContent);
});

test('⑨ 时间**修到秒**不许把日期和时分秒改掉（认不出来的写法就**原样印**，不许自己编）', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [
      cardWithEnteredAt('C1', '2026-10-23 18:56:30.586396'),
      cardWithEnteredAt('C2', '2026-10-23 09:05:07'),
      cardWithEnteredAt('C3', '前天下午'),
    ],
  });

  const texts = cardsOf(dom).map(card => {
    const node = card.querySelector('[data-review-card-entered]');
    return node ? String(node.textContent) : '';
  });
  assert.ok(texts.some(text => text.indexOf('2026-10-23 18:56:30') >= 0 && text.indexOf('.') < 0),
    '带微秒的那张没修到秒：' + texts.join(' ｜ '));
  assert.ok(texts.some(text => text.indexOf('2026-10-23 09:05:07') >= 0),
    '本来就只到秒的那张被改坏了：' + texts.join(' ｜ '));
  assert.ok(texts.some(text => text.indexOf('前天下午') >= 0),
    '认不出来的写法被丢掉或被编了：' + texts.join(' ｜ '));
});
