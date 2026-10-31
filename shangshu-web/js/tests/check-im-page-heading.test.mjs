// 判据：消息页的**页头条**跟工作台一样（用户 2026-10-24 16:45 原话：
// 「首先，消息这一页的样式怎么和工作台的样式不一致，包括标题位置这些」）。
//
// **测试通过 =**（一句话）
// 「打开消息页 ⇒ 页面**顶上有一条全站一样的页头条**
//   （`<header class="page-hd platform-page-head page-heading …">` ＋ `<h1>消息</h1>`）：
//   标题就落在**工作台那个位置**（左留白 26px ＝ 同一条竖线；骨架高 68px；标题 20px/650），
//   左栏里**不再挤着第二个「消息」**（标题只许有一处）；
//   聊天区的高度由**外壳分**（`.im-page` 竖向弹性盒 ＋ `.im-layout` 占剩下的），
//   不再自己写死 `100vh` —— 写死就等于「页头占了 68px、聊天区还按整屏算」⇒ 底下被切掉一截。」
//
// ⚠ **病根不是「样式不一样」，是这一页根本没有页头条**：
//   改之前消息页的整个 DOM 就是 `<div class="im-layout">` —— 标题「消息」是
//   **左栏里的一行小标题**（`.im-list-hd` 里的 `<span>`，14px 粗体），
//   跟工作台的 20px/650 页头条**不是同一个东西**、位置也差着一条栏的宽度。
//
// ⚠ **断的是「算出来的生效值」** —— 用 `scripts/lib/css-cascade.mjs`
//   （加载顺序 ＋ 特异性）算出真正生效的留白／高度／排法；
//   **不是** grep 样式表里有没有那句话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createResolver, sides, px } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;
const NARROW = 600;

/** 消息页的源码（模板字符串里的页头条/左栏都从这里核）。 */
const source = fs.readFileSync(new URL('../real-im.js', import.meta.url), 'utf8');

/** 算出来的生效值 —— **算法在公用件里**（`helpers/css-effective.mjs`）。 */
const effective = createEffective(resolver, WIDE);

/** 留白标准：宽屏 26px ／ 窄屏 16px（参照系＝文件中心 `.file-heading`，与工作台同一个数）。 */
const STANDARD = { wide: 26, narrow: 16 };

test('① 消息页**有页头条**，而且用的是**全站那一副骨架**（`.page-heading`）', () => {
  assert.match(source, /<div class="im-page">/,
    '消息页没有 `.im-page` 外壳（页头条与聊天区没有共同的竖向弹性盒）');
  assert.match(source, /<header class="[^"]*\bpage-heading\b[^"]*">/,
    '消息页的页头条没有挂公共骨架类 `.page-heading` —— 骨架只能有一个');
  /* 页头条里**第一个元素子节点就是 h1**（全站只许一种骨架，不许套标题块 div）。 */
  assert.match(source, /<header class="[^"]*\bpage-heading\b[^"]*">\s*<h1>消息<\/h1>/,
    '消息页的标题不是**直接**挂在页头条上的（套了一层标题块 div），或文案不对');
});

test('② 标题**只许有一处**：左栏里那个「消息」不许再留着', () => {
  assert.doesNotMatch(source, /<span>消息<\/span>/,
    '左栏里还挂着一个小标题「消息」—— 标题出现两处，页头那个就不像页头了');
  assert.doesNotMatch(source, /class="im-list-hd"/,
    '左栏那一行小标题的壳还在（那是「标题挤在左栏里」的病根）');
});

test('③ 页头条的**左留白 26px**（＝工作台同一条竖线，不是 24px 也不是 0）', () => {
  for (const [viewport, want] of [[WIDE, STANDARD.wide], [NARROW, STANDARD.narrow]]) {
    const hit = resolver.resolve('.im-page-head', 'padding', { viewport });
    assert.ok(hit, '消息页的页头条没有自己的留白声明（标题会贴到边上）');
    assert.equal(px(sides(hit.value)[3]), want,
      `消息页页头条的左留白现在是 ${hit.value} —— 应为 ${want}px（与工作台同一条竖线）`);
  }
  /* 左栏的内容（搜索框那一列）也落在同一条竖线上。 */
  const tools = resolver.resolve('.im-list-tools', 'padding', { viewport: WIDE });
  assert.ok(tools, '左栏工具区没有留白声明');
  assert.equal(px(sides(tools.value)[3]), STANDARD.wide,
    `左栏工具区的左留白现在是 ${tools.value} —— 应为 ${STANDARD.wide}px（与标题同一条竖线）`);
});

test('④ 页头条吃**骨架的固定高 68px**（不许这一页自己另立一个高度）', () => {
  const height = effective(['.page-heading'], 'height', WIDE);
  assert.ok(height, '公共骨架 `.page-heading` 的高度不见了');
  assert.equal(px(height.value), 68,
    '公共骨架 `.page-heading` 的高度是 ' + height.value + ' —— 应为 68px');
});

test('⑤ 聊天区的高度**由外壳分**（不许再自己写死整屏高）', () => {
  const page = effective(['.im-page'], 'display', WIDE);
  assert.ok(page, '`.im-page` 没有排法');
  assert.equal(page.value, 'flex', '`.im-page` 不是竖向弹性盒（页头条与聊天区分不了高度）：' + page.value);
  const direction = effective(['.im-page'], 'flex-direction', WIDE);
  assert.ok(direction, '`.im-page` 没有写竖向排列');
  assert.equal(direction.value, 'column', '`.im-page` 不是竖向排列：' + direction.value);

  /* 聊天区占**剩下的**高度（`flex:1` ＋ 自己不再写死 `100vh`）。 */
  const grow = effective(['.im-page .im-layout'], 'flex-grow', WIDE);
  let growValue = grow ? grow.value : null;
  if (growValue === null) {
    /* 写的是简写 `flex:1` ⇒ 断那个（解析器按属性名取，简写不拆）。 */
    const shorthand = effective(['.im-page .im-layout'], 'flex', WIDE);
    assert.ok(shorthand, '消息页的聊天区没有写「占剩下的高度」');
    growValue = String(shorthand.value).trim().split(/\s+/)[0];
  }
  assert.equal(growValue, '1',
    '消息页的聊天区没有占满剩下的高度（flex-grow 不是 1）：' + growValue);
  const height = effective(['.im-page .im-layout'], 'height', WIDE);
  assert.ok(!height || height.value === 'auto',
    '消息页的聊天区还写死了高度（' + (height && height.value) + '）—— '
    + '页头占掉 68px 之后它还按整屏算 ⇒ 底下被切掉一截');
});

test('⑥ 承载消息页的滚动容器**不吃页面留白**（这一族是通栏的，标题自己带 26px）', () => {
  const hit = resolver.resolve('.main-scroll:has(>.im-page)', 'padding', { viewport: WIDE });
  assert.ok(hit, '没有为消息页的外壳写「不吃留白」那一条（聊天区会整体缩进 24px）');
  assert.equal(px(sides(hit.value)[3]), 0,
    '消息页的外壳还带着左右留白（' + hit.value + '）—— 通栏那一族不吃 L1');
});

test('⑦ 页头条下面**不留空档**（它的下边线要直接贴着下面的会话列表）', () => {
  /* 病根（用户 2026-10-24 22:2x 站上批注：「这个和下面的侧栏中间有个小缝隙」）：
     公共 `.page-hd` 自带 `margin-bottom:16px` —— 那一页的页头条**就压在**下面的内容上，
     这 16px 直接变成一条**看得见的空档**：页头条的下边线浮在半空，
     下面那一列（会话列表）跟它之间白出一条 ⇒ 看着像「页头和侧栏没接上」。
     ⚠ 别的页需要那 16px（页头在带留白的容器里，要透气）⇒ **不许动公共件**，
     只许**这一页**把页头条的下边距归零（它的下边线本身就是那道分隔线）。 */
  const head = effective(
    ['.page-hd', '.platform-page-head', '.page-heading', '.im-page-head', '.im-page > .page-hd'],
    'margin-bottom', WIDE);
  assert.ok(head, '消息页的页头条没有自己的外边距声明');
  assert.equal(px(head.value), 0,
    '消息页的页头条下面还空着 ' + head.value
    + '（来自公共 `.page-hd` 的 `margin-bottom:16px`）⇒ 页头条的下边线与下面的会话列表之间'
    + '会白出一条缝；这一页的页头条**直接压在内容上**，不透气');

  /* 下边线本身得在 —— 归零外边距后，它就是页头条与下面那列之间唯一那道分隔线。 */
  const border = effective(['.im-page-head', '.im-page > .page-hd'], 'border-bottom', WIDE);
  assert.ok(border, '消息页的页头条没有下边线（归零外边距后就没有分隔了）');
  assert.match(String(border.value), /1px/,
    '消息页页头条的下边线不是 1px：' + border.value);
});
