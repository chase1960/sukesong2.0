// 判据：审核中心那张卡的**高度**（用户 2026-10-28 站上截图原话：
//   「我猜可能是这个div没有办法装下下一行的卡片了，我在想是不是可以调整下卡片的高度？
//     这下面空着页太丑了吧！」）。
//
// **「测试通过 =」**（一句话）
// 「卡片区**不留空带**：余下的高度**分给那些行**（行铺满），
//   且行高**不会塌成细条**（下限是 **max-content**，不是 min-content ——
//   2026-10-27「卡片被压成 35px 的细条」那个坑不许再踩）；
//   而且**卡里那些留白收紧了**（一行行之间的空隙加起来 ≤ 50px，原来 68px）
//   ⇒ 同样一块地方**能多放一行**卡。」
//
// ⚠️ **断的是「算出来的生效值」** —— 用 `scripts/lib/css-cascade.mjs`
//   （加载顺序 ＋ 特异性）算出真正生效的值；**不是** grep 样式表里有没有那句话。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, px } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;

/** 算出来的生效值（**算法在公用件里**：`helpers/css-effective.mjs`）。 */
const effective = createEffective(resolver, WIDE);

/** 算出来的数值（px）；算不出来（% / em / var）⇒ null。 */
function pxOf(candidates, property) {
  const hit = effective(candidates, property);
  return hit ? px(hit.value) : null;
}

/**
 * **简写里的某一边**（`padding: 10px 14px` ⇒ 上 10 / 下 10；`margin: 2px 0 0` ⇒ 上 2）。
 *
 * ⚠️ **为什么自己拆简写**：`css-cascade` 只按**属性名**取值 ⇒ 简写（`padding`／`margin`）
 *   查不到长写（`padding-top`）⇒ 得自己按 CSS 的简写规则拆开。
 */
function sideOf(candidates, shorthand, side) {
  /* —— **先看长写**（`padding-top`）—— 样式表里多数是这么写的。 —— */
  const longhand = effective(candidates, shorthand + '-' + side);
  if (longhand) return px(longhand.value) || 0;
  const hit = effective(candidates, shorthand);
  if (!hit) return 0;
  const parts = String(hit.value || '').trim().split(/\s+/)
    .map(part => px(part)).filter(part => part !== null);
  if (!parts.length) return 0;
  const [top, right = top, bottom = top, left = right] = parts;
  if (side === 'top') return top;
  if (side === 'bottom') return bottom;
  if (side === 'left') return left;
  return right;
}

test('① **行铺满余下的高度**（不留空带）＋ **行高不塌成细条**', () => {
  const hit = effective(['.review-center-body'], 'grid-auto-rows');
  assert.ok(hit, '卡片区没有写行高的排法');
  const value = String(hit.value || '').replace(/\s+/g, '');
  /* —— **下限是 max-content**（不是 min-content）⇒ 行不会被压成细条。 —— */
  assert.match(value, /^minmax\(max-content,/,
    '行高那条的下限不是 max-content（行会被压成细条 —— 2026-10-27「35px 细条」那个坑）：'
    + value);
  /* —— **上限是 1fr** ⇒ 余下的高度分给这些行 ⇒ 卡片区**不留空带**。 —— */
  assert.match(value, /1fr\)$/,
    '行高那条的上限不是 1fr（余下的高度不会分给这些行 ⇒ 下面留一条空带）：' + value);
});

test('② **卡里的留白收紧了**（一行行之间的空隙加起来 ≤ 50px）⇒ 同样高度能多放一行', () => {
  /* —— **卡里那些「行与行之间」的空隙**（标题块上下 / 正文上边距 / 摘要下边距 /
   *   三行杂项的上边距 / 动作区上边距 / 卡片下内边距）。 —— */
  const parts = [
    [[' .review-card-head'.trim()], 'padding', 'top'],
    [[' .review-card-head'.trim()], 'padding', 'bottom'],
    [['.review-card-body'], 'padding', 'top'],
    [['.review-card-digest'], 'margin', 'bottom'],
    [['.review-card-case'], 'margin', 'top'],
    [['.review-card-entered'], 'margin', 'top'],
    [['.review-card-updated'], 'margin', 'top'],
    [['.review-card .review-actions'], 'padding', 'top'],
    [['.review-card'], 'padding', 'bottom'],
  ];
  let total = 0;
  parts.forEach(([candidates, shorthand, side]) => {
    total += sideOf(candidates, shorthand, side) || 0;
  });
  assert.ok(total <= 50,
    '卡里的留白还有 ' + total + 'px（预算 50px）—— 这么占地方，同一块地方就多放不下一行卡');
});

test('③ **动作区仍靠留白跟正文分开**（撤了细线就得留白；这是 PKG-087 那条的老口径）', () => {
  const padding = pxOf(['.review-card .review-actions'], 'padding-top');
  assert.ok(padding !== null, '动作区没有写上留白');
  assert.ok(padding >= 8,
    '动作区跟正文之间只留了 ' + padding + 'px —— 撤了细线就得靠留白分开，不然两块糊成一片');
});
