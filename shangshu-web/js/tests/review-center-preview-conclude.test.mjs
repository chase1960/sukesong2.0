// 判据：预览页上**看得见「结论类」那张卡**（PKG-096-T01）。
//
// **为什么要有这条**（PKG-096 的起因）：
//   PKG-093 改的那张**结论类**卡（值在原位＝候选：单击暂存／双击改写、待采用时呼吸、
//   明确保存「核对无误」才落结论）**行为**判据早就有了（`review-center-conclude-click.test.mjs`），
//   但**人看不见它**：站上审核中心队列是空的（没有待审官文）⇒ 人打开审核中心看不到那张卡；
//   而唯一的「样例页」（`review-center-preview.html`）**只登记了两份**声明
//   （整组保存／允许部分保存）—— **恰恰没有结论类那一份**。
//   ⇒ 结论类卡**没法被人验收**（用户 2026-10-24 23:29 亲口问过「呼吸去哪里了」，
//     他要看的就是这张卡）。
//
// **测试通过 =** 下面全部成立（一句话）：
// 「预览页登记的声明里**有一份是结论类**（`handling.mode='conclude'`）⇒
//   把预览页**真源码里那几份声明**（不是手搓的）注册进**真的公共壳**、渲染一遍 ⇒
//   切到结论类那一份、打开那张卡 ⇒
//    ① 那三行候选**在原位**（`[data-review-candidate]` 有 3 个）；
//    ② **没有那三个必核勾**（`[data-review-checks]` 一个都没有）；
//    ③ 底栏按钮写「**核对无误**」；
//    ④ 左栏**不摆**那行小标题（声明给空串就不画）。」
//
// ⚠️ **不是读源码找字符串**：第 ①③④ 条把预览页**源码里那份声明**（连它那张卡）
//   原样注册进壳、真渲染一遍 ⇒ 预览页写坏了、壳渲坏了，两边都会红。
//
// ⚠️ **2026-10-25（PKG-097）改这一份**：原来断的是「预览页登记了**三份**声明、**第三份**是结论类」
//   —— 预览页后来补了第四份（右栏是图片那一份）⇒ 按份数/位置断会**假红**。
//   ⇒ 改成**不靠份数、不靠位置**：按 `handling.mode='conclude'` **找**那一份
//   （**原句保留在上面的注释里**，不删）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, settle, loadPreviewDeclarations } from './helpers/review-center-shell.mjs';

/** 按**声明自己说的**找那份结论类（不靠它在列表里的第几位）。 */
function findConcludeDeclaration(declarations) {
  return declarations.find(spec => spec && spec.handling && spec.handling.mode === 'conclude');
}

test('① 预览页登记的声明里**有一份是结论类**（`handling.mode=\'conclude\'`）', () => {
  const { declarations } = loadPreviewDeclarations();
  assert.ok(declarations.length >= 3,
    '预览页只登记了 ' + declarations.length + ' 份声明 —— 样例页改掉了？');

  const conclude = findConcludeDeclaration(declarations);
  assert.ok(conclude, '预览页的声明里**没有一份是结论类**（`handling.mode` ＝ `conclude`）');
  assert.ok((conclude.handling.entries || []).includes('difference'),
    '结论类那一份没有「信息有误／待核实」那个口（「不过」走既有那条路）');
});

test('② 把预览页**真源码里那份结论类声明**注册进**真的公共壳**渲染一遍 ⇒ 那张卡是结论类那一档', async () => {
  const { declarations, cardsOf } = loadPreviewDeclarations();
  const conclude = findConcludeDeclaration(declarations);
  assert.ok(conclude, '预览页的声明里没有结论类那一份');

  const dom = createDom();
  const { window } = loadShell(dom);
  for (const spec of declarations) {
    const registered = window.shangshuReviewCenter.registerDeclaration(spec);
    assert.ok(registered.ok,
      '预览页这份声明注册不过：' + (registered.errors || []).join('；'));
  }

  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();

  /* 切到**结论类那一份**（页头右上那排分档片）。 */
  await window.shangshuReviewCenter.switchTab(conclude.key);
  await settle();

  const open = dom.body.querySelector('[data-review-card-open]');
  assert.ok(open, '切到结论类那一份之后，**一张卡都没有** —— 人还是看不到那张卡');
  open.dispatchEvent({ type: 'click' });
  await settle();

  const left = dom.body.querySelector('[data-review-slot="left"]');
  assert.ok(left, '左栏没出来');

  /* ① 三行候选**在原位**（不是「要核对的」那种另找入口的摆法）。 */
  const candidates = left.querySelectorAll('[data-review-candidate]');
  assert.equal(candidates.length, 3,
    '结论类那张卡上的候选值不是 3 个（在原位的是 ' + candidates.length + ' 个）');
  for (const candidate of candidates) {
    assert.equal(candidate.getAttribute('data-proposal-state'), 'pending',
      '候选值一开始就该是「待采用」（待采用时呼吸）');
  }

  /* ② **没有那三个必核勾**（用户 22:34：「为什么还要多此一举的大勾」）。 */
  assert.equal(dom.body.querySelectorAll('[data-review-checks]').length, 0,
    '结论类那张卡上还摆着必核清单那三个勾');

  /* ③ 底栏按钮写「核对无误」（明确保存才入库）。 */
  const save = dom.body.querySelector('[data-review-save]');
  assert.ok(save, '底栏没有保存按钮');
  assert.match(save.textContent, /核对无误/, '底栏按钮没写「核对无误」：' + save.textContent);
  assert.equal(save.disabled, false, '结论类那张卡不许直接提交（还得先勾那三个？）');

  /* ④ 左栏**不摆**那行小标题（声明给空串就不画）。 */
  assert.equal(left.querySelectorAll('.review-slot-title').length, 0,
    '左栏还摆着那行小标题（声明给了空标题也不画）');

  /* —— 顺手核一件：那张卡上的三行**就是**预览页给的那三行（不是壳自造的）。 —— */
  const cards = cardsOf('concludeCards');
  assert.ok(Array.isArray(cards) && cards.length === 1, '预览页那张结论类卡不见了');
  assert.equal(cards[0].changes.length, 3, '预览页那张卡的候选行不是 3 行');
  assert.ok(!cards[0].checks, '预览页那张卡还带着 `checks` ⇒ 结论类卡上会摆出那三个勾');
});
