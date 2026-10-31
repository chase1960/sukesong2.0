// 判据：审核中心的卡片**按屏取页**（用户 2026-10-28 实拍原话：
//   「而且为什么这个卡片没有铺满？明明有两页，先填满一页再去第二页呀」）。
//
// **为什么有这一条**：
//   原来一页的条数**写死 12** ⇒ 屏幕放得下 3 行时只摆 2 行 ⇒ **下面空一大块**
//   ⇒ 人看着像「没铺满」⇒ 明明后面还有第 2 页，却先摆半屏空着。
//   ⇒ **一页的条数要按屏算**：量到这一屏放得下几张，就向域要几张。
//
// **「测试通过 =」**（一句话）
// 「量到这一屏放得下 **18** 张 ⇒ 向域要这一页时 **`pageLength` 就是 18**（不是固定 12），
//   页面上摆 **18** 张、页脚写「第 1 / 2 页 · 共 24 张」；
//   **量不出来**（没有布局）⇒ 仍旧 **12** 张、仍旧只向域要一次（老行为不破）。」
//
// ⚠️ **不是读源码找字符串** —— 壳那半用公用夹具 `helpers/review-center-shell.mjs`
//   装进最小 DOM **真的跑一遍**再查它产出的东西（请求参数 ＋ 页面上的东西）。
// ⚠️ **量的是「差值」**：列数（第一行有几张）、行距（两行起点差多少）、可用高度
//   —— **不抄 CSS 里的数值**（抄一遍就会和样式脱节）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, pageHost, settle } from './helpers/review-center-shell.mjs';

const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');
const pagerText = dom => {
  const node = dom.body.querySelector('[data-review-pagination-status]');
  return node ? String(node.textContent) : '';
};

/**
 * **装一套桩布局**：6 列一行、卡高 140、行距 150（**间距 10 是量出来的差值，不是抄的**）、
 * 卡片区（自己滚动的那一格）高 470 ⇒ 这一屏放得下 **3 行 × 6 列 = 18 张**。
 */
function installLayout(dom, options = {}) {
  const columns = options.columns || 6;
  const cardHeight = options.cardHeight || 140;
  const rowPitch = options.rowPitch || 150;
  const gridHeight = options.gridHeight || 470;
  dom.__layout = element => {
    if (element.getAttribute('data-review-card-grid')) {
      return { top: 0, left: 0, width: 1400, height: gridHeight };
    }
    if (element.getAttribute('data-review-card')) {
      const parent = element.parentNode;
      const cards = parent ? parent.children.filter(child => child.getAttribute('data-review-card')) : [];
      const index = Math.max(0, cards.indexOf(element));
      return {
        top: 14 + Math.floor(index / columns) * rowPitch,
        left: 18 + (index % columns) * 220,
        width: 208,
        height: cardHeight,
      };
    }
    return null;
  };
}


/**
 * **装一套「行被拉伸」的桩布局**（2026-10-28 站上实拍抓到的那个坑）。
 *
 * 现实：卡片区的行高是 `minmax(max-content, 1fr)` ⇒ **行把余下的高度分给每行** ⇒
 * **卡被拉高**；而卡里那块「吃掉余量」的内容（动作区 `margin-top:auto` 上面那块）
 * **也跟着长高** ⇒ 这时去量「自然高」，量到的其实是**拉高后的高**。
 *
 * ⇒ 行数被算少（1 行）⇒ 一页只剩 1 张 ⇒ **又留一条空带**（用户：「这下面空着页太丑吧」）
 * ⇒ 而且**自己把自己绕进去**（一页 1 张 ⇒ 更空 ⇒ 更被拉高 ⇒ 还是 1 张）。
 *
 * 桩的做法：**量的时候把行拉伸撤掉**（`grid.style.gridAutoRows = 'max-content'`）
 * ⇒ 桩就按**自然高**给盒子；量完还原 ⇒ 桩又给回拉高后的高。
 */
function installStretchedLayout(dom, options = {}) {
  const columns = options.columns || 6;
  const natural = options.natural || 140;
  const stretched = options.stretched || 620;
  const gridHeight = options.gridHeight || 470;
  const blocks = options.blocks || [40, 60, 40];
  dom.__layout = element => {
    if (element.getAttribute('data-review-card-grid')) {
      return { top: 0, left: 0, width: 1400, height: gridHeight };
    }
    const isCard = !!element.getAttribute('data-review-card');
    const parent = element.parentNode;
    const card = isCard ? element
      : (parent && parent.getAttribute && parent.getAttribute('data-review-card') ? parent : null);
    if (!card) return null;
    const grid = card.parentNode;
    const unstretched = !!(grid && grid.style && grid.style.gridAutoRows === 'max-content');
    const siblings = grid ? grid.children.filter(child => child.getAttribute('data-review-card')) : [card];
    const index = Math.max(0, siblings.indexOf(card));
    const top = 14 + Math.floor(index / columns) * 150;
    if (isCard) {
      return { top, left: 18 + (index % columns) * 220, width: 208, height: unstretched ? natural : stretched };
    }
    const blockIndex = card.children.indexOf(element);
    const base = blocks[blockIndex] != null ? blocks[blockIndex] : 40;
    /* 中间那块「吃掉余量」⇒ 拉伸时它变高。 */
    const extra = unstretched ? 0 : (stretched - natural);
    return { top, left: 18 + (index % columns) * 220, width: 208, height: base + (blockIndex === 1 ? extra : 0) };
  };
}


/**
 * **装一套「卡片区自己滚、外框按视口固定」的桩布局**（2026-10-28 站上实拍抓到的第二个坑）。
 *
 * 现实：卡片区**自己滚** ⇒ **它自己的高是「内容高」（就一行）**；真正的可用空间是
 * 「卡片区顶边 → 分页条顶边」那一段。⇒ 只拿卡片区自己的高当可用高度 ⇒ 行数算成 1
 * ⇒ 一页只摆 1 张（站上实拍：25 张卡拆成 25 页），而且**自己把自己绕进去**。
 */
function installScrollingLayout(dom, options = {}) {
  const columns = options.columns || 6;
  const cardHeight = options.cardHeight || 140;
  const gridTop = options.gridTop || 300;
  const pagerTop = options.pagerTop || 683;
  dom.__layout = element => {
    if (element.getAttribute('data-review-card-grid')) {
      return { top: gridTop, left: 0, width: 1400, height: cardHeight };
    }
    if (element.getAttribute('data-review-pager')) {
      return { top: pagerTop, left: 0, width: 1400, height: 60 };
    }
    if (element.getAttribute('data-review-card')) {
      const parent = element.parentNode;
      const cards = parent ? parent.children.filter(child => child.getAttribute('data-review-card')) : [];
      const index = Math.max(0, cards.indexOf(element));
      return {
        top: gridTop + 14 + Math.floor(index / columns) * 150,
        left: 18 + (index % columns) * 220,
        width: 208,
        height: cardHeight,
      };
    }
    return null;
  };
}

/** 一份**按契约分页**的域（新形状 `{cards, total}`）—— 记下每一次请求的参数。 */
function pagedDeclaration(total, tag) {
  const calls = [];
  const list = async (options = {}) => {
    calls.push(options || {});
    const page = Number(options.page) || 1;
    const pageLength = Number(options.pageLength) || 12;
    const all = Array.from({ length: total }, (_, i) => sampleCard({
      id: tag + '-CARD-' + i,
      title: '官文 ' + i,
      enteredAt: '2026-10-28 10:' + String(59 - (i % 60)).padStart(2, '0'),
    }));
    const start = (page - 1) * pageLength;
    return { cards: all.slice(start, start + pageLength), total };
  };
  return { calls, list };
}

async function openPage(dom, spec) {
  const { window } = loadShell(dom);
  registerSampleDeclaration(window, { key: 'sample.notice', list: spec.list });
  const host = pageHost(dom);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  await settle();
  return window.shangshuReviewCenter;
}

test('① 纯计算：量到「6 列 × 3 行」⇒ 这一屏放得下 18 张（不是固定 12）', () => {
  const { window } = loadShell(createDom());
  const perScreen = window.shangshuReviewCenter.cardsPerScreen;
  assert.equal(typeof perScreen, 'function', '壳没把「一屏放得下几张」这个算法交出来');

  /* —— 6 列、行距 150（卡高 140 ＋ 间距 10）、可用高 470 ⇒ 3 行 ⇒ 18 张。 —— */
  assert.equal(perScreen({ columns: 6, rowPitch: 150, available: 470, gap: 10 }), 18,
    '量出来的一屏张数不对');
  /* —— 量不出来（没有布局）⇒ null（调用方退回默认 12）。 —— */
  assert.equal(perScreen({ columns: 0, rowPitch: 0, available: 0, gap: 0 }), null,
    '量不出来时不该瞎编一个数');
  assert.equal(perScreen(null), null, '量不出来时不该瞎编一个数');
  /* —— **屏幕只放得下 1 行** ⇒ 就是这么多（**不硬撑 12**：
   *   硬撑 12 ⇒ 多出来的几张整个在屏幕外，翻页前还得先滚一遍）。 —— */
  assert.equal(perScreen({ columns: 2, rowPitch: 150, available: 150, gap: 10 }), 2,
    '屏幕只放得下一行时不该硬撑成 12');
  /* —— 屏幕特别高 ⇒ 上限 60（不许一次把全库端回来）。 —— */
  assert.equal(perScreen({ columns: 6, rowPitch: 150, available: 9000, gap: 10 }), 60,
    '一页没有上限（会把全库端回来）');
});

test('② 量到一屏放得下 18 张 ⇒ **向域要这一页就是 18 张**，页面摆 18 张、页脚写「第 1 / 2 页」', async () => {
  const dom = createDom();
  installLayout(dom);
  const paged = pagedDeclaration(24, 'A');
  await openPage(dom, paged);

  /* —— **第二次请求带的条数＝量出来的一屏张数**（18），不是写死的 12。 —— */
  assert.ok(paged.calls.length >= 2, '量出来一屏放得下 18 张，却只向域要了一次（没按屏取页）');
  const last = paged.calls[paged.calls.length - 1];
  assert.equal(Number(last.pageLength), 18, '按屏取页没生效（要的还是 12）：' + Number(last.pageLength));
  assert.equal(Number(last.page), 1, '重取的不是当前这一页');

  /* —— **页面摆满一屏**：18 张（不是 12 张留半屏空着）。 —— */
  assert.equal(cardsOf(dom).length, 18, '这一页没摆满一屏：' + cardsOf(dom).length);

  /* —— **页脚照实写**：总数 24、一页 18 ⇒ 2 页。 —— */
  assert.match(pagerText(dom), /共 24 张/, '「共 N 张」不对：' + pagerText(dom));
  assert.match(pagerText(dom), /第 1 \/ 2 页/, '总页数不对：' + pagerText(dom));

  /* —— **不许来回抖**：量一次就稳（不再反复重取）。 —— */
  const count = paged.calls.length;
  await settle();
  assert.equal(paged.calls.length, count, '量出来之后还在反复重取（抖了）');
});

test('③ **量不出来**（没有布局）⇒ 仍旧 12 张、仍旧只向域要一次（老行为不破）', async () => {
  const dom = createDom();
  const paged = pagedDeclaration(24, 'A');
  await openPage(dom, paged);

  assert.equal(paged.calls.length, 1, '量不出来却多要了一次');
  assert.equal(Number(paged.calls[0].pageLength), 12, '量不出来时不该改条数');
  assert.equal(cardsOf(dom).length, 12, '量不出来时不该改这一页摆几张');
  assert.match(pagerText(dom), /第 1 \/ 2 页/, '量不出来时总页数不对：' + pagerText(dom));
});

test('④ **量自然高时不能把「被行拉伸后的高」当自然高**（否则行数越算越少 ⇒ 一页只剩 1 张、还留一条空带）', async () => {
  const dom = createDom();
  installStretchedLayout(dom);
  const paged = pagedDeclaration(25, 'S');
  await openPage(dom, paged);
  await settle();

  /* —— 现实里：卡片区高 470、卡自然高 140 ⇒ 放得下 3 行 × 6 列 ＝ 18 张。
   *   若拿**拉高后的** 620 当自然高 ⇒ 行高 630 ⇒ 只放得下 1 行 ⇒ 一页 1 张。 —— */
  const last = paged.calls[paged.calls.length - 1];
  assert.equal(Number(last.pageLength), 18,
    '量自然高时用了被行拉伸后的高 ⇒ 行数算少 ⇒ 一页只摆 1 张（实际要 ' + Number(last.pageLength) + ' 张）');
  assert.equal(cardsOf(dom).length, 18, '这一页没摆满一屏：' + cardsOf(dom).length);
  assert.match(pagerText(dom), /共 25 张/, '「共 N 张」不对：' + pagerText(dom));
  assert.match(pagerText(dom), /第 1 \/ 2 页/, '总页数不对：' + pagerText(dom));
});

test('⑤ **可用高度要量「卡片区顶边 → 分页条顶边」那段**（卡片区自己滚 ⇒ 它自己的高只有一行）', async () => {
  const dom = createDom();
  installScrollingLayout(dom);
  const paged = pagedDeclaration(25, 'W');
  await openPage(dom, paged);
  await settle();

  /* —— 现实：卡片区顶边 300、分页条顶边 683 ⇒ 可用 383 ⇒ 放得下 2 行（行距 150）⇒ 12 张。
   *   若拿卡片区**自己的高**（内容高＝140 ⇒ 一行）⇒ 一页只摆 6 张。 —— */
  const last = paged.calls[paged.calls.length - 1];
  assert.equal(Number(last.pageLength), 12,
    '可用高度量错了（拿卡片区自己的内容高当可用高度）⇒ 一页只摆 6 张（实际要 ' + Number(last.pageLength) + ' 张）');
  assert.equal(cardsOf(dom).length, 12, '这一页没摆满：' + cardsOf(dom).length);
  assert.match(pagerText(dom), /共 25 张/, '「共 N 张」不对：' + pagerText(dom));
});
