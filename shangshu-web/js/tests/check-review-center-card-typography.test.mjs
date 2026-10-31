// 判据：审核中心那张卡**分区分字重**（PKG-087-T01 · 用户 2026-10-24 13:1x 站上截图原话：
// 「我建议这个卡片也排版一下，要分区分字重，现在像都堆在上面一样」）。
//
// ⚠ **口径变更（2026-10-24 16:54，用户拍板）**：① 原来是「标题区底下**一条细线**」，
//   **现在改成「标题区一个色块」**（用户原话：「审核卡片位置的细线去掉，
//   可以考虑用色块去分区，标题一个色块这样」）⇒ 原话保留在下面那条判据的注释里。
//
// **测试通过 =**（一句话）
// 「审核中心那张卡**分了区、分了字重**：
//   ① **标题区**（类型块 ＋ 凭据名 ＋ 状态枚）—— 字最重（650），**自己一个色块**（**不再靠一条细线**隔开）；
//   ② **正文区**——**先说「要核什么」**（摘要，字重 500、比标题轻、比杂项重），
//      再摆**杂项元信息**（类型·件数／关联案件／进入时间／更新时间，字重 400、字号更小、颜色更淡）；
//   ③ **动作区**（「打开核对」）—— **贴着卡底**，一行铺开时**一排卡的按钮在同一条线上**，
//      **那条细线也撤了**（靠留白跟正文分开）；
//   ④ 摘要那一行**排在杂项之前**（先说要核什么，再摆杂项）；
//   而且**待审的卡还是灰的**（这条不许被改坏）。」
//
// ⚠ **为什么「像都堆在上面」**：原来的排法是——卡头、类型·件数、关联案件灰块、摘要、
//   进入时间、更新时间**全都左对齐、间距都是 6～7px、字重也差不多**
//   ⇒ 一眼看过去就是一摞字，看不出哪句是「要核的」。
//
// ⚠ **断的是「算出来的生效值」** —— 用 `scripts/lib/css-cascade.mjs`
//   （加载顺序 ＋ 特异性）算出真正生效的字号／字重／排法；
//   **不是** grep 样式表里有没有那句话。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { createResolver, px } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective, effectiveWeight } from './helpers/css-effective.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;

/** 算出来的生效值 —— **算法在公用件里**（`helpers/css-effective.mjs`）。 */
const effective = createEffective(resolver, WIDE);

/** 算出来的字号（px）；算不出来（% / em / var）⇒ null。 */
function effectiveSize(candidates) {
  const hit = effective(candidates, 'font-size');
  return hit ? px(hit.value) : null;
}

/** 把壳装好、登记示例声明、挂上这一页。 */
async function openPage(dom, overrides = {}) {
  const { window } = loadShell(dom);
  registerSampleDeclaration(window, overrides);
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return { window, host };
}

/** 一张**有摘要**的待审卡（域给了摘要 ＋ 更新时间）。 */
const cardWithDigest = (overrides = {}) => sampleCard(Object.assign({
  id: 'C1',
  state: 'pending',
  digest: '缴费 950.00 元 · 还缺件：缴费通知书',
  updatedAt: '2026-10-23 19:40',
  enteredAt: '2026-10-23 18:00',
  caseId: 'CASE-001',
}, overrides || {}));

test('① **标题区是一个色块**（分区靠色块，不靠细线 —— 用户 2026-10-24 16:54 拍板）', () => {
  /* 原话（PKG-087-T01 时的口径）：「① **卡头区底下有那条细线**（区是分开的，不是一摞字堆着）」——
     2026-10-24 16:54 用户改口径：「审核卡片位置的细线去掉，可以考虑用色块去分区，
     标题一个色块这样」⇒ 细线**撤掉**，改成**色块**。 */
  const line = effective(['.review-card-head'], 'border-bottom');
  /* 「没有那条线」＝ **根本没声明**（null）**或**声明成 0/none。 */
  const none = hit => !hit || /^(none|0(px)?)$/i.test(String(hit.value).trim());
  assert.ok(none(line),
    '标题区底下那条细线还在（' + (line && line.value) + '）—— 用户 16:54 拍板「细线去掉，用色块」');

  /* 色块：标题区自己有底色（不是靠线跟正文分开）。 */
  const background = effective(['.review-card-head'], 'background');
  assert.ok(background, '标题区没有底色（不是色块）');
  assert.ok(!/^(transparent|none)$/i.test(String(background.value).trim()),
    '标题区是透明底（不是色块）：' + background.value);
});

test('⑨ **动作区那条细线也撤了**（靠留白分开，不靠线）', () => {
  const line = effective(['.review-card .review-actions'], 'border-top');
  const none = hit => !hit || /^(none|0(px)?)$/i.test(String(hit.value).trim());
  assert.ok(none(line),
    '动作区顶上那条细线还在（' + (line && line.value) + '）—— 用户 16:54 拍板「细线去掉」');
  /* 撤了线，得留白把动作区跟正文分开（不然两块糊成一片）。 */
  const padding = effective(['.review-card .review-actions'], 'padding-top');
  assert.ok(padding, '动作区没有写上留白');
  assert.ok(px(padding.value) >= 8,
    '动作区跟正文之间只留了 ' + padding.value + ' —— 撤了细线就得靠留白分开，不然两块糊成一片');
});

test('② **字重分三级**：标题 ＞ 摘要 ＞ 杂项（不能一个样）', () => {
  const title = effectiveWeight(effective, ['.review-card-title']);
  const digest = effectiveWeight(effective, ['.review-card-digest']);
  const meta = effectiveWeight(effective, ['.review-card-meta']);

  assert.ok(title > digest,
    '标题不比摘要重（分不出主次）：标题 ' + title + ' / 摘要 ' + digest);
  assert.ok(digest > meta,
    '摘要不比杂项重（要核的那句跟杂项一个样）：摘要 ' + digest + ' / 杂项 ' + meta);
});

test('③ **字号也分两级**：摘要比杂项大（光靠字重还不够，得能一眼扫到）', () => {
  const digest = effectiveSize(['.review-card-digest']);
  const meta = effectiveSize(['.review-card-meta']);
  assert.ok(digest !== null, '摘要的字号算不出来');
  assert.ok(meta !== null, '杂项的字号算不出来');
  assert.ok(digest > meta,
    '摘要不比杂项大（要核的那句跟杂项一样大）：摘要 ' + digest + ' / 杂项 ' + meta);
});

test('④ **杂项要弱下去**（字号更小、颜色更淡）—— 不然它跟摘要抢眼', () => {
  const meta = effective(['.review-card-meta'], 'color');
  assert.ok(meta, '杂项没有颜色规则');
  assert.match(meta.value, /--fg3/,
    '杂项的颜色不是最淡那一档（跟要核的那句抢眼）：' + meta.value);
});

test('⑤ **摘要排在杂项之前**（先说要核什么，再摆杂项）', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [cardWithDigest()] });

  const card = dom.body.querySelector('[data-review-card]');
  assert.ok(card, '卡没出来');
  const digest = card.querySelector('[data-review-card-digest]');
  const meta = card.querySelector('.review-card-meta');
  assert.ok(digest, '卡上没有摘要那一行');
  assert.ok(meta, '卡上没有杂项那一行');

  /* 两者**同一个爹**（卡正文那一块）⇒ 才谈得上「谁在前」。 */
  assert.ok(digest.parentNode && meta.parentNode && digest.parentNode === meta.parentNode,
    '摘要与杂项不在同一块里（分区的排法散了）');
  const order = digest.parentNode.children;
  assert.ok(order.indexOf(digest) < order.indexOf(meta),
    '摘要没排在杂项之前（还是先摆杂项、后说要核什么）');
});

test('⑥ **动作区贴着卡底**（一排卡的按钮在同一条线上）', () => {
  /* 卡本身是**竖向弹性盒** ⇒ 动作区才能被推到卡底。 */
  const display = effective(['.review-card'], 'display');
  assert.ok(display, '卡片没有排法');
  assert.equal(display.value, 'flex', '卡片不是弹性盒（动作区推不到卡底）：' + display.value);
  const direction = effective(['.review-card'], 'flex-direction');
  assert.ok(direction, '卡片没有写竖向排列');
  assert.equal(direction.value, 'column', '卡片不是竖向排列：' + direction.value);

  /* 动作区**自己**占剩下的高度（`margin-top:auto`）。 */
  const margin = effective(['.review-card .review-actions'], 'margin-top');
  assert.ok(margin, '卡上的动作区没有规则');
  assert.equal(margin.value, 'auto',
    '卡上的动作区没有推到卡底（margin-top 不是 auto）：' + margin.value);

  /* 一排卡**等高**（靠 `.review-center-body` 拉伸 ⇒ 按钮在同一条线上）。 */
  const align = effective(['.review-center-body'], 'align-items');
  assert.ok(align, '卡片区没有排法');
  assert.equal(align.value, 'stretch',
    '一排卡不等高（按钮不在同一条线上）：' + align.value);
});

test('⑦ **待审的卡还是灰的**（这条不许被这次排版改坏）', () => {
  const pending = effective(['.review-card[data-review-card-state="pending"]'], 'background');
  const normal = effective(['.review-card'], 'background');
  assert.ok(pending, '待审的卡没有单独的底色规则（没灰）');
  assert.ok(normal, '普通卡没有底色规则');
  assert.notEqual(pending.value, normal.value,
    '待审的卡与别的卡底色一样（没灰）');
  assert.match(pending.value, /--bg-alt/,
    '待审的卡底色不是浅灰那一档：' + pending.value);
});

test('⑧ **域没给摘要就不多那一行**（分区分字重，不许编内容）', async () => {
  const dom = createDom();
  await openPage(dom, { list: async () => [sampleCard({ id: 'C2', state: 'pending' })] });

  const card = dom.body.querySelector('[data-review-card]');
  assert.ok(!card.querySelector('[data-review-card-digest]'),
    '域没给摘要，卡上却多了一行摘要');
  /* 摘要那一块空着也不许留白行 —— 卡上照样摆得下（杂项还在）。 */
  assert.ok(card.querySelector('.review-card-meta'), '杂项那一行不见了');
});
