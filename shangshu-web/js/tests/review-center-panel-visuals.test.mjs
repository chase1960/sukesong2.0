// 判据：审核弹窗**这一轮的视觉**（2026-10-28 上午 · UI/UX 审核实测清单）。
//
// **测试通过 = 什么成立**（一句话）：
// 「左栏：搜索区**不是灰块**（工具不是字段）、候选卡与同栏其它块**同一条左缘**、
//   鼠标停在**选中的**卡上**不会**把绿边顶掉、选中卡那道绿杠**真的看得见**；
//   右栏：文件名条与 PDF 工具条**同一块白**（不是与灰桌同色）、**那一栏没有横线**；
//   字段那一行：「当前正式值」**成列**；窄屏（703px）两栏照旧项目那档比例。」
//
// ⚠️ **为什么这些要断**：UI/UX 子 agent 在 3850 上量过——
//   · 文件名条与灰桌**同色**（两边都是 `rgba(0,0,0,.04)`）⇒ 分隔＝零；
//   · 右栏**最后剩下的一根横线**就是 PDF 工具条那道 `border-bottom`（用户点名要删的那根）；
//   · 候选卡比同栏**往里缩 12px**（搜索块 x=137、候选卡 x=149）；
//   · `:hover`（0,4,0）**压过**选中态（0,3,0）⇒ 鼠标一停上去绿边就掉；
//   · 选中卡那道绿杠用 `box-shadow: inset` 画的，而站里有一条全局
//     `body,body *{box-shadow:none!important}` ⇒ **它从来没出现过**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, px, sides } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const effective = createEffective(resolver, 1440);
const WIDE = 1440;
const NARROW = 703;

/** 一条规则算出来的值（null ＝ 没有这条规则）。 */
const value = (candidates, prop, viewport = WIDE) => {
  const hit = effective(candidates, prop, viewport);
  return hit ? hit.value : null;
};

test('① 搜索区**不是灰块**（工具不是字段；旧项目：分区靠标题，灰块只给字段）', () => {
  assert.equal(value(['.review-case-manual'], 'background'), 'transparent',
    '搜索区还涂着灰底（看着像一块字段）');
  assert.equal(px(sides(value(['.review-case-manual'], 'padding'))[0]), 0,
    '搜索区还带内衬（输入框与候选卡对不齐）');
});

test('② 候选卡与同栏其它块**同一条左缘**（不再往里缩 12px）', () => {
  const padding = sides(value(['.review-case-choices'], 'padding'));
  assert.equal(px(padding[3]), 0, '候选区还有左内衬（候选卡比同栏往里缩）');
  assert.equal(px(padding[0]), 0, '候选区还有上内衬');
});

test('③ 鼠标停在**选中的**卡上**不会**把绿边顶掉', () => {
  assert.equal(value(['.review-case-selection .review-case-choice:hover:not(:disabled)'], 'border-color'), null,
    '那条「不带选中限定」的 hover 规则还在（它会盖掉选中态的绿边）');
  const hover = value(['.review-case-selection .review-case-choice:hover:not(:disabled):not([aria-pressed="true"])'], 'border-color');
  assert.ok(hover, 'hover 规则没了（没选中的卡连悬停反馈都没了）');
  assert.equal(value(['.review-case-selection .review-case-choice[aria-pressed="true"]'], 'border-color'), 'var(--green-ink)',
    '选中卡的绿边不是绿墨色');
});

test('④ 选中卡那道绿杠**真的看得见**（用边框，不靠那个永远不生效的影）', () => {
  const selected = ['.review-case-selection .review-case-choice[aria-pressed="true"]'];
  /* —— 绿杠的**位置**：**选中时**左边加宽到 3px（平时是 1px 细线，框是闭合的 ⇒ 见 ⑥）。 —— */
  assert.equal(value(selected, 'border-left-width'), '3px',
    '选中卡左边那道绿杠不是 3px：' + String(value(selected, 'border-left-width')));
  /* —— 绿杠的**颜色**：选中时是绿墨色（四边一起）。 —— */
  assert.equal(value(selected, 'border-color'), 'var(--green-ink)',
    '选中卡的绿边不是绿墨色');
  assert.equal(value(selected, 'box-shadow'), null,
    '选中态还在靠 box-shadow 画绿杠（站里那条全局规则会让它永远不出现）');
  /* —— 选中时文字**不跳位**（左边框宽了 2px ⇒ 内衬相应减 2px）。 —— */
  assert.equal(value(selected, 'padding-left'), '10px',
    '选中时内衬没减 2px（文字会跳一下）');
});

test('⑤ 右栏：文件名条与 PDF 工具条**同一块白**，**那一栏没有横线**', () => {
  assert.equal(value(['.review-original-bar'], 'background'), 'var(--card)',
    '文件名条不是白底（它跟灰桌同色 ⇒ 分隔等于零）');
  assert.equal(value(['.review-original .file-pdf-toolbar'], 'background'), 'var(--card)',
    'PDF 工具条不是白底');
  assert.equal(px(value(['.review-original .file-pdf-toolbar'], 'border-bottom')), 0,
    'PDF 工具条下面还有一根横线（右栏最后剩下的一根）');
});

test('⑥ 搜索出来的候选卡**四边细线闭合**（左边那一道也在）', () => {
  /* ⚠️ **2026-10-28 上午 · 用户原话**：「这个搜索出来的卡片要细线闭合」——
   *   原来给「选中绿杠」留位的那条**左边框是透明的**（`border-left: 3px solid transparent`）
   *   ⇒ 没选中的卡**左边那一道没有线** ⇒ 看着像个**没合上的框**。
   *   ⇒ 未选中：四边**都是 1px 细线**（闭合）；选中：绿边 ＋ 左边一道 3px 绿杠。 */
  const base = ['.review-case-selection .review-case-choice'];
  const selected = ['.review-case-selection .review-case-choice[aria-pressed="true"]'];
  assert.match(String(value(base, 'border')), /1px/, '候选卡不是 1px 细线：' + String(value(base, 'border')));
  assert.ok(!/transparent/.test(String(value(base, 'border-left') || '')),
    '候选卡左边那一道被设成了透明（细线没闭合）：' + String(value(base, 'border-left')));
  assert.equal(value(selected, 'border-left-width'), '3px',
    '选中卡左边那道绿杠不是 3px：' + String(value(selected, 'border-left-width')));
  assert.equal(value(selected, 'border-color'), 'var(--green-ink)', '选中卡的绿边不是绿墨色');
});

test('⑦ 「当前正式值」**成列**（标签列固定，值列对齐）', () => {
  assert.equal(value(['.review-field-line'], 'display'), 'grid',
    '字段行不是网格（值的起始位置各不相同）');
  assert.match(String(value(['.review-field-line'], 'grid-template-columns')), /6em/,
    '标签列宽度没定死（值还是不成列）');
});

test('⑧ 窄屏（703px）两栏照旧项目那档比例（原件不被压扁）', () => {
  const narrow = String(value(['.os-dialog .review-split-body'], 'grid-template-columns', NARROW));
  assert.match(narrow, /minmax\(280px,\s*328px\)/,
    '窄屏还是宽屏那档比例（左栏下限 360px ⇒ 右栏被压扁）：' + narrow);
  const wide = String(value(['.os-dialog .review-split-body'], 'grid-template-columns', WIDE));
  assert.match(wide, /minmax\(360px,\s*0\.8fr\)/,
    '宽屏那档比例被改动了（旧项目 5507 那条）：' + wide);
});

test('⑨ 搜索行与候选卡之间**有间距**（用户 2026-10-28 上午：「图二的 padding 呢？」）', () => {
  /* —— 那 12px 原来靠 `[data-review-slot-body="left"] .review-case-body{gap:12px}` 给，
   *   而**这一块不在那个容器里**（它在 `.review-preparation-panel` 里）⇒ 那条规则管不着
   *   ⇒ 搜索行与候选卡**贴在一起**（图二）⇒ 候选区自己补上 12px。 */
  const margin = px(value(['.review-case-choices'], 'margin-top'));
  assert.equal(margin, 12,
    '搜索行与候选卡之间的间距是 ' + margin + 'px（贴在一起就是图二那一版）');
});

test('⑩ 窄栏里「更多」展开**不许把工具条撑破**（用户 2026-10-28 上午：「图一这个被挤出了」）', () => {
  /* —— 703px 下右栏只有 291px，而「更多」里的东西（查找文字 228px ＋ 独立打开 ~60px）要 300px
   *   ⇒ 工具条横向溢出 21px ⇒「独立打开」被切掉半个。 */
  /* ⚠️ 选择器要**一字不差**（判据按选择器原文匹配，不做空白归一）。 */
  assert.equal(value(['.file-pdf-toolbar>.file-pdf-more'], 'max-width'), '100%',
    '「更多」那一块没限宽（窄栏里会把工具条撑破）');
  assert.equal(value(['.file-pdf-more-body'], 'max-width'), '100%',
    '「更多」展开的内容没限宽（会把工具条撑破）');
});

test('⑪ 查找那一片**摊成一行**（用户 2026-10-28 上午：「我说的是这一块，你不觉得很丑吗大哥？」）', () => {
  /* —— 原来「查找文字」是**竖着的一摞**（按钮在上、表单在下），「独立打开」又飘在右边
   *   ⇒ 看着像三块拼起来的。⇒ **展开时这一摞拆开**：按钮留在工具条那一行，
   *   **表单另起一行**，两个控件都在同一行上。 */
  assert.equal(value(['.file-pdf-searchbox[open]'], 'display'), 'contents',
    '「查找文字」展开时没有拆开（按钮还压着表单）');
  assert.equal(value(['.file-pdf-open'], 'align-self'), 'flex-start',
    '「独立打开」自己写了居中（它会飘在表单右边那一行）');
});

test('⑫ 审核弹窗的 PDF 工具条**只剩翻页与缩放**（一行四个控件）', () => {
  /* —— 用户 2026-10-28 上午：「能不能拍成一行，如果不行那就把查找给删掉；
   *   或者把独立打开放到下面」⇒ 审核弹窗右栏那一行**只留翻页与缩放**，
   *   「查找」不进这一行、「独立打开」挪到**底栏**那一排按钮里。 */
  assert.equal(value(['.review-original .file-pdf-searchbox'], 'display'), 'none',
    '「查找文字」还在审核弹窗的工具条上（窄栏里它跟输入框挤不到一行）');
  assert.equal(value(['.review-original .file-pdf-more'], 'display'), 'none',
    '「更多」那一层还在审核弹窗的工具条上（它里面已经没有要放的东西了）');
  assert.equal(value(['.review-original .file-pdf-open'], 'display'), 'none',
    '「独立打开」还在工具条上（它挪到底栏那一排按钮里了）');
});

test('⑬ 卡片列表那个**搜索框填满那一行**（用户 2026-10-28 14:0x 批注：「这个要填满呀」）', () => {
  /* —— 原来那个输入框 `max-width: 360px` ⇒ 一行里左边空一大片、框窄窄一条
   *   ⇒ **填满那一行**（不设上限 ＋ 宽度 100%）。 */
  assert.equal(value(['.review-center-tools input[data-review-search]'], 'max-width'), 'none',
    '搜索框还限着宽（一行里左边空一大片）');
  assert.equal(value(['.review-center-tools input[data-review-search]'], 'width'), '100%',
    '搜索框没有占满那一行的宽度');
  assert.equal(value(['.review-center-tools input[data-review-search]'], 'flex'), '1 1 auto',
    '搜索框没有按那一行的宽度摊开');
});
