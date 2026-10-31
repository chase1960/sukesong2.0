// 判据：审核中心**页头右上那一块**（分档片 ＋「刷新」）**对齐、好看**（用户 2026-10-24 16:54 原话：
// 「其次审核中心右上角那一块你觉得美观吗？视觉也不对齐」）。
//
// **测试通过 =**（一句话）
// 「打开审核中心 ⇒ 页头右上那一块：
//   ① **分档片与标题居中对齐**（不再被顶到标题上方 19px）；
//   ② **分档片那组的高＝公共控件的高**（34px，不是 30px 的小方块）；
//   ③ 分档片是**分段控件**（外层一片浅底壳、内层片**没有边框**、选中片白底绿字）；
//   ④ **页头右上没有「刷新」按钮**（2026-10-24 20:5x 用户拍板「这个去掉」；
//      刷新这件事**没丢** —— 它仍是公共 API）；
//   而且这条规矩**只管审核中心这一页** —— 别的页面（邮件中心／文件中心／Excel 清单页）
//   的页头动作区**没有**被跟着改。」
//
// ⚠ **口径变更（2026-10-24 16:54，用户拍板）**：
//   这一条**原来是 PKG-087-T01 的「基线对齐」**（原话保留如下）：
//     「修法（一整条链，少一环就断在那一层）：动作区跟标题按基线对齐（`align-self:baseline`）……
//      动作区内部按基线排（`align-items:baseline`）……分档片那层按基线排（`.review-decks`）。」
//   **为什么基线对齐反而不对**：`<button>` 在 Chrome 里**不提供可用的基线**
//   ⇒ 那一行的基线被算成**盒子底边** ⇒ 分档片整组被**顶到标题上方 19px**
//   （站上实测：分档片文字底边 y=35、标题文字底边 y=52）。
//   ⇒ 口径改成「**同高 ＋ 居中**」：三个盒子一样高、跟标题同一个中线 ⇒ 一眼对齐。
//   ⚠ PKG-087 那条判据**断的是「声明的值」**（`align-self` 写没写 `baseline`），
//     **没断「算出来的几何」** ⇒ 声明对了、几何仍然歪 ⇒ 这一条补上几何那一半。
//
// ⚠ **断的是「算出来的生效值」** —— 用 `scripts/lib/css-cascade.mjs`
//   （加载顺序 ＋ 特异性）算出真正生效的高度／对齐；
//   **不是** grep 样式表里有没有那句话。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, px } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;

/** 算出来的生效值 —— **算法在公用件里**（`helpers/css-effective.mjs`）。 */
const effective = createEffective(resolver, WIDE);

/** 公共按钮的高（`.btn`）—— 全站按钮就这一个数。 */
const BTN_HEIGHT = 34;

/** 把壳装好、登记示例声明、挂上这一页。 */
async function openPage(dom) {
  const { window } = loadShell(dom);
  registerSampleDeclaration(window, { list: async () => [sampleCard()] });
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return { window, host };
}

test('① **动作区跟标题居中对齐**（不是靠基线凑 —— 按钮没有可用基线）', () => {
  const self = effective(['.review-center-page-head .page-actions'], 'align-self');
  assert.ok(self, '审核中心这一页的动作区没有自己的对齐规则');
  assert.equal(self.value, 'center',
    '动作区没有跟标题居中对齐（align-self 不是 center）：' + self.value);
  assert.match(self.selector, /review-center-page-head/,
    '这条规则没有挂在审核中心自己那一类底下：' + self.selector);

  const items = effective(['.review-center-page-head .page-actions'], 'align-items');
  assert.ok(items, '审核中心这一页的动作区没有自己的排法');
  assert.equal(items.value, 'center',
    '动作区内部不是按中线排（align-items 不是 center）：' + items.value);
});

test('② **分档片那层也按中线排**（片与片之间不靠基线凑）', () => {
  const hit = effective(['.review-decks'], 'align-items');
  assert.ok(hit, '分档片那层没有排法');
  assert.equal(hit.value, 'center',
    '分档片那层不是按中线排（align-items 不是 center）：' + hit.value);

  /* 片**内部**按中线排（片名与件数徽章同一条中线）—— 别改回去。 */
  const deck = effective(['.review-deck'], 'align-items');
  assert.ok(deck, '分档片本身没有排法');
  assert.equal(deck.value, 'center',
    '分档片内部不是按中线排（align-items 不是 center）：' + deck.value);
});

test('③ **分档片那组的高＝公共控件的高**（34px）—— 不再是一个 30px 的小方块', () => {
  /* 公共控件就这一个高（`.btn`）⇒ 页头上任何一排东西都该是它。 */
  const btn = effective(['.btn'], 'height');
  assert.ok(btn, '公共按钮 `.btn` 的高度不见了');
  assert.equal(px(btn.value), BTN_HEIGHT,
    '公共按钮的高度是 ' + btn.value + ' —— 应为 ' + BTN_HEIGHT + 'px');

  /* 分档片那组的**总高**＝ 壳的内边距上下 ＋ 片高。 */
  const pad = effective(['.review-decks'], 'padding');
  assert.ok(pad, '分档片那层没有内边距声明');
  const parts = String(pad.value).trim().split(/\s+/);
  const top = px(parts[0]);
  const bottom = parts.length > 1 ? px(parts[1]) : top;
  assert.ok(top !== null && bottom !== null,
    '分档片那层的内边距算不出来（' + pad.value + '）');

  const deck = effective(['.review-deck'], 'height');
  assert.ok(deck, '分档片本身没有写高度');
  const deckHeight = px(deck.value);
  assert.ok(deckHeight !== null, '分档片的高度算不出来（' + deck.value + '）');

  const total = top + bottom + deckHeight;
  assert.equal(total, BTN_HEIGHT,
    '分档片那组一共 ' + total + 'px 高 —— 应为 ' + BTN_HEIGHT + 'px（公共控件的高）');
});

test('⑦ 页头右上**没有「刷新」按钮**（2026-10-24 20:5x 用户拍板「这个去掉」）', async () => {
  const dom = createDom();
  const { window } = await openPage(dom);
  assert.ok(!dom.body.querySelector('[data-review-refresh]'),
    '页头右上那个「刷新」按钮还在（用户 20:5x 拍板「这个去掉」）');
  /* 刷新这件事**没丢** —— 它仍是公共 API（重新进这一页就会重读）。 */
  assert.equal(typeof window.shangshuReviewCenter.refreshPage, 'function',
    '公共 API `refreshPage()` 不见了（刷新这件事丢了）');
});

test('④ 分档片是**分段控件**（外层一片浅底壳、内层片没有边框）', () => {
  /* 外层：一片浅底 ＋ 内边距（壳）。 */
  const shell = effective(['.review-decks'], 'background');
  assert.ok(shell, '分档片那层没有底色（不是分段控件）');
  assert.match(shell.value, /--bg-alt/,
    '分档片那层的底色不是浅灰那一档：' + shell.value);

  /* 内层：片本身**没有边框**（边框是「一排独立的按钮」，不是「一组开关」）。 */
  const border = effective(['.review-deck'], 'border');
  const borderWidth = effective(['.review-deck'], 'border-width');
  const none = hit => hit && /^(none|0(px)?)$/i.test(String(hit.value).trim());
  assert.ok(none(border) || none(borderWidth),
    '分档片自己还带着边框（' + ((border && border.value) || (borderWidth && borderWidth.value)) + '）'
    + ' —— 一排带边框的方块看着像四个不相干的按钮');
});

test('⑤ 选中片**白底绿字**（在浅底壳上才看得出选中）', () => {
  const background = effective(['.review-deck[data-review-active="1"]'], 'background');
  assert.ok(background, '选中的分档片没有单独的底色（看不出选中哪一档）');
  assert.match(background.value, /--card/,
    '选中的分档片不是白底（' + background.value + '）');
  const color = effective(['.review-deck[data-review-active="1"]'], 'color');
  assert.ok(color, '选中的分档片没有单独的色');
  assert.match(color.value, /--green-ink/,
    '选中的分档片不是绿字（' + color.value + '）');
});

test('⑥ **只管审核中心这一页**：别的页面的页头动作区没被跟着改', () => {
  const generic = effective(['.page-hd .page-actions'], 'align-items');
  assert.ok(generic, '公共页头动作区的排法不见了');
  assert.equal(generic.value, 'center',
    '公共页头动作区被改了（别的页面的页头跟着变了）：' + generic.value);

  const selfAlign = effective(['.page-hd .page-actions'], 'align-self');
  assert.ok(!selfAlign || selfAlign.value !== 'baseline',
    '公共页头动作区被改成基线对齐了（别的页面的页头跟着变了）：' + (selfAlign && selfAlign.value));
});
