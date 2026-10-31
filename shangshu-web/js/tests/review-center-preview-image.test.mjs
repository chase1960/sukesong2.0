// 判据：预览页上**看得见「右栏是图片」那一份声明**（PKG-097-T01）。
//
// **为什么要有这条**（缺口是核出来的，不是猜的）：
//   《用例清单》§8.6（责任边界）**明写**：
//   「**本批必须能用不依赖 example 的示例验证「左字段/右图片或文本、允许部分保存」，
//     同时验证 example 的「左字段/右正文、不允许部分保存」。** 这证明它确实是公共能力」
//   ⇒ 核当前实现：预览页原来登记的**三份**声明（整组保存／允许部分保存／结论类）
//     **右栏格式全是 `pdf`** ⇒
//    ① **「右图片或文本」这一半从来没做过** —— 公共壳 `FORMATS` 里**有** `image`／`text`
//       两个渲染器（`renderImage`／`renderText`），但**没有任何一份声明用过它们**；
//    ② ⇒ **「呈现部件由声明接入」这件事人眼看不见**（切声明能改左栏、能改保存策略，
//       **唯独右栏格式从没变过**）；
//    ③ 《用例清单》§10「声明与独立性」那条检查点写的是「**切换声明能改变左右内容和保存策略**」
//       ⇒ **右栏那一半缺证据**。
//   ⇒ 这一条把「**切声明 ⇒ 右栏格式也跟着换**」**钉成判据**。
//
// **测试通过 =** 下面全部成立（一句话）：
// 「预览页登记的声明里**有一份右栏格式是 `image`** ＋ **允许部分保存** ＋ **不依赖 example**
//   ⇒ 把预览页**真源码里那几份声明**（不是手搓的）注册进**真的公共壳**、渲染一遍 ⇒
//   切到右栏是图片那一份、打开那张卡 ⇒
//    ① 右栏那一栏的 `data-review-format` ＝ **`image`**（右栏格式**由声明决定**）；
//    ② 右栏渲染出**图片那一件**（`[data-review-image]` 在、PDF 那个框 `[data-review-original-frame]` 不在）；
//    ③ 底栏按钮写「**确认所选 N 项**」（允许部分保存那一档）—— 不是「整组保存」；
//    ④ 左栏仍是**字段对比**（`data-review-format` ＝ `field-table`）；
//    ⑤ 那张卡是**五项**独立变化（《用例清单》§9 那个场景）。」
//
// ⚠️ **不是读源码找字符串**：把预览页**源码里那份声明**（连它那张卡）
//   原样注册进壳、真渲染一遍 ⇒ 预览页写坏了、壳渲坏了，两边都会红。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, settle, loadPreviewDeclarations } from './helpers/review-center-shell.mjs';

/** 找出那份「右栏用图片格式」的声明。 */
function findImageDeclaration(declarations) {
  return declarations.find(spec => spec && spec.rightSlot && spec.rightSlot.format === 'image');
}

test('① 预览页登记的声明里**有一份右栏用图片格式、允许部分保存、且不依赖 example**', () => {
  const { declarations } = loadPreviewDeclarations();
  assert.ok(declarations.length >= 3,
    '预览页只登记了 ' + declarations.length + ' 份声明 —— 样例页改掉了？');

  const spec = findImageDeclaration(declarations);
  assert.ok(spec,
    '预览页里**没有一份声明的右栏用「图片」格式** ⇒《用例清单》§8.6 那句'
    + '「本批必须能用不依赖 example 的示例验证『左字段/右图片或文本、允许部分保存』」'
    + '**没做到**（现在切声明能改左栏、能改保存策略，唯独右栏格式从没变过）');

  /* 允许部分保存（§8.6 点名的那一档）。 */
  assert.equal(spec.savePolicy && spec.savePolicy.partial, true,
    '右栏是图片那一份不是「允许部分保存」那一档（`savePolicy.partial` ＝ '
    + (spec.savePolicy && spec.savePolicy.partial) + '）');

  /* **不依赖 example**：声明里不出现 example，执行入口走内核那个受管保存动作。 */
  assert.ok(!/example/i.test(String(spec.domain || '')),
    '这份声明的 domain 指向 example（`' + spec.domain + '`）⇒ 它就不是「不依赖 example 的示例」');
  assert.ok(String(spec.execution && spec.execution.saveAction || '').startsWith('kernel.'),
    '这份声明的执行入口不是内核的受管保存动作（`' + (spec.execution && spec.execution.saveAction) + '`）');
});

test('② 把预览页**真源码里那几份声明**注册进**真的公共壳**渲染一遍 ⇒ 切到右栏是图片那一份 ⇒ 右栏真的换成图片、底栏真的换成「确认所选 N 项」', async () => {
  const { declarations } = loadPreviewDeclarations();
  const spec = findImageDeclaration(declarations);
  assert.ok(spec, '预览页里没有右栏用「图片」格式的那份声明');

  const dom = createDom();
  const { window } = loadShell(dom);
  for (const one of declarations) {
    const registered = window.shangshuReviewCenter.registerDeclaration(one);
    assert.ok(registered.ok,
      '预览页这份声明注册不过：' + (registered.errors || []).join('；'));
  }

  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();

  /* 切到**右栏是图片那一份**（页头右上那排分档片）。 */
  await window.shangshuReviewCenter.switchTab(spec.key);
  await settle();

  const open = dom.body.querySelector('[data-review-card-open]');
  assert.ok(open, '切到右栏是图片那一份之后，**一张卡都没有**');
  open.dispatchEvent({ type: 'click' });
  await settle();

  const left = dom.body.querySelector('[data-review-slot="left"]');
  const right = dom.body.querySelector('[data-review-slot="right"]');
  assert.ok(left, '左栏没出来');
  assert.ok(right, '右栏没出来');

  /* ① 右栏的格式**由声明决定**（切声明 ⇒ 那一栏的格式跟着换）。 */
  assert.equal(right.getAttribute('data-review-format'), 'image',
    '右栏那一栏的格式不是「图片」（是 `' + right.getAttribute('data-review-format') + '`）'
    + ' ⇒ 右栏格式没有跟着声明换');

  /* ② 右栏渲染的是**图片那一件**（不是 PDF 那个框）。 */
  assert.ok(right.querySelectorAll('[data-review-image]').length > 0,
    '右栏没有渲染出图片那一件');
  assert.equal(right.querySelectorAll('[data-review-original-frame]').length, 0,
    '右栏还在摆 PDF 那个框（`data-review-original-frame`）');

  /* ③ 底栏按钮是**允许部分保存**那一档（「确认所选 N 项」）。 */
  const save = dom.body.querySelector('[data-review-save]');
  assert.ok(save, '底栏没有保存按钮');
  assert.match(save.textContent, /确认所选/, '底栏按钮不是「确认所选 N 项」：' + save.textContent);
  assert.doesNotMatch(save.textContent, /整组保存/, '底栏按钮写的是「整组保存」—— 那不是允许部分保存那一档');

  /* ④ 左栏仍是**字段对比**（这一份只换右栏，左栏照旧）。 */
  assert.equal(left.getAttribute('data-review-format'), 'field-table',
    '左栏那一栏的格式不是字段对比（是 `' + left.getAttribute('data-review-format') + '`）');

  /* ⑤ **五项**独立变化（《用例清单》§9 那个场景）。 */
  const candidates = left.querySelectorAll('[data-review-candidate]');
  assert.equal(candidates.length, 5,
    '那张卡上的候选值不是 5 项（是 ' + candidates.length + ' 项）');
});
