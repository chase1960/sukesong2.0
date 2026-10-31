// 判据：**工作台页的骨架对齐到文件中心**（文件中心＝唯一参照系，PKG-031-T01）。
//
// **测试通过 =**（一句话）
// 「工作台标题『工作台』的左边缘 ＝ 文件中心标题『文件中心』的左边缘 ＝ **26px**（同一条竖线）；
//   工作台左右两栏（常用应用 ／ 最近流程）之间**没有间隙**、只隔**1px 竖分隔线**
//   （＝ 文件中心「主体 ／ aside」同关系），两栏**不再各画各的卡片外框**；
//   承载它们的滚动容器**不再额外带一层外层留白** ⇒ 横向留白全站只剩**一层**（L1＝26px）；
//   域内两页（官文助手 ／ 邮件规则表）与审核中心独立页也落在同一条 26px 的竖线上。」
//
// 用户原话（2026-10-22）：
//   17:30「工作台的布局和文件中心还是有不同，具体表现在**标题位置**、**主体部分和 aside 的距离**」
//   18:15 在工作台最外层 `<section class="platform-page workbench-page">` 上批注：
//        「**这里有一个 padding，你就按照这个做吧，删掉就行**」
//
// ⚠️ **判据断的是「算出来的像素数」，不是「文件里有没有 26px 这几个字」**：
//   这里把 CSS **解析**出来（`scripts/lib/css-cascade.mjs`，与检查器同一套做法），
//   按 CSS 盒模型把每一层的 margin/padding 加起来，得出**每一块真实的左边缘**。
// ⚠️ **同一个元素上可能有多条规则互相覆盖**：
//   `.platform-page` 给 26px，`.example-host-page` 又用 `padding:0 0 18px` 把它归零；
//   `.main-scroll` 给 24px，`.main-scroll:has(>.platform-page)` 又把外层归零 ——
//   所以下面自己按「**选择器优先级 ＋ 加载次序**」算出真正生效的那一条，
//   不能只取「最后写到的那个选择器」。
//
// ⇒ 以后谁给承载平台页的滚动容器又加回一层外边距、或把两栏之间的间隙改成 10px、
//   或把 1px 分隔线去掉、或让域内页把自己的横向留白归零，这条判据立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createResolver, sides, px } from '../../../scripts/lib/css-cascade.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);

const WIDE = 1440;      // 宽屏视口（桌面）
const NARROW = 600;     // 窄屏视口（≤680px 的那一档）
/** 参照系（L1）的数：宽屏 26px、窄屏 16px —— 来自文件中心 `.file-heading` / `.file-table-area`。 */
const STANDARD = { wide: 26, narrow: 16 };

/* ───────────────────── 级联小工具：算「真正生效」的那一条声明 ───────────────────── */

/** 优先级比较：[id, 类/伪类, 标签/伪元素] 逐项比。 */
function compareSpec(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * 选择器优先级。`:has()` 取它参数里**最具体**那个的优先级（CSS 规范如此）。
 * 只覆盖本判据用得到的选择器形态（类 / 属性 / 伪类 / 标签 / 组合子）。
 */
function specificity(selector) {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  const hasRe = /:has\(([^()]*)\)/g;
  for (const match of selector.matchAll(hasRe)) {
    let best = [0, 0, 0];
    for (const part of match[1].split(',')) {
      const spec = specificity(part.trim());
      if (compareSpec(spec, best) > 0) best = spec;
    }
    ids += best[0];
    classes += best[1];
    tags += best[2];
  }
  let rest = selector.replace(hasRe, ' ');
  ids += (rest.match(/#[A-Za-z0-9_-]+/g) || []).length;
  classes += (rest.match(/\.[A-Za-z0-9_-]+/g) || []).length;
  classes += (rest.match(/\[[^\]]*\]/g) || []).length;
  const pseudoElements = (rest.match(/::[A-Za-z-]+/g) || []).length;
  const pseudoClasses = (rest.match(/(?<!:):[A-Za-z-]+/g) || []).length;
  classes += pseudoClasses;
  tags += pseudoElements;
  rest = rest
    .replace(/#[A-Za-z0-9_-]+/g, ' ')
    .replace(/\.[A-Za-z0-9_-]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/::[A-Za-z-]+/g, ' ')
    .replace(/:[A-Za-z-]+/g, ' ');
  tags += (rest.match(/(?:^|[\s>+~])[a-z][A-Za-z0-9-]*/g) || []).length;
  return [ids, classes, tags];
}

/**
 * 某个**元素**上某属性的**真正生效值**。
 * candidates：[{ file, selector }] —— selector 必须**真的能命中这个元素**。
 * 赢的规则 ＝ 优先级高的；同优先级 ＝ 加载顺序靠后（同文件里行号靠后）的。
 */
function effective(candidates, prop, viewport) {
  let win = null;
  for (const cand of candidates) {
    const abs = path.join(resolver.webRoot, cand.file);
    const hit = resolver.resolveIn(abs, cand.selector, prop, viewport);
    if (!hit) continue;
    const spec = specificity(cand.selector);
    const order = resolver.order.indexOf(abs);
    const better = !win
      || compareSpec(spec, win.spec) > 0
      || (compareSpec(spec, win.spec) === 0
        && (order > win.order || (order === win.order && hit.line >= win.line)));
    if (better) win = { value: hit.value, file: cand.file, line: hit.line, spec, order };
  }
  return win;
}

/** 生效值的左内边距（px）；没声明内边距就是 0。 */
function padLeft(candidates, viewport) {
  /* 先按 `padding` 简写取，再让 `padding-left` 长写覆盖（长写后写、同优先级时压住简写）。 */
  const shorthand = effective(candidates, 'padding', viewport);
  let value = 0;
  if (shorthand) {
    const parsed = px(sides(shorthand.value)[3]);
    value = parsed === null ? 0 : parsed;
  }
  const longhand = effective(candidates, 'padding-left', viewport);
  if (longhand) {
    const parsed = px(longhand.value);
    if (parsed !== null) value = parsed;
  }
  return value;
}

/** 生效值的上内边距（px）；没声明就是 0。 */
function padTop(candidates, viewport) {
  const hit = effective(candidates, 'padding', viewport);
  if (!hit) return 0;
  const value = px(sides(hit.value)[0]);
  return value === null ? 0 : value;
}

/* ───────────────────── 窄屏外壳层（mobile.css 的 !important） ───────────────────── */

/** `css/mobile.css` 里窄屏那一档的媒体查询上限。 */
const MOBILE_MAX = 768;

/**
 * 窄屏（≤768px）外壳层：mobile.css 的 `.main-scroll{padding:56px 14px 40px !important}`。
 * ⚠️ 它带 `!important` ⇒ **压着所有 `.main-scroll`**（文件中心的 `.main-scroll.file-center-page{padding:0}`
 *    不是 !important，窄屏也被它压着）⇒ 两个页面在窄屏是**同一个数**（外壳层相同 ＋ 各自页面层 16px）。
 * ⚠️ 这一层是**移动端外壳自己**的（顶部 56px 给左上角悬浮汉堡让位）—— **不在本轮动的范围**。
 *    这里从文件里**实读**，不许写死。
 */
function mobileShellPadding() {
  const file = path.join(resolver.webRoot, 'css/mobile.css');
  const raw = fs.readFileSync(file, 'utf8');
  const at = raw.indexOf('@media (max-width: 768px)');
  assert.ok(at >= 0, 'mobile.css 里找不到窄屏那一档（≤768px）的媒体查询');
  const matched = /\.main-scroll\s*\{([^}]*)\}/.exec(raw.slice(at));
  assert.ok(matched, 'mobile.css 窄屏那一档里没有 `.main-scroll` 的规则');
  assert.match(matched[1], /!important/,
    '窄屏 `.main-scroll` 的规则不带 !important 了 —— 窄屏口径要重新核');
  const padding = /padding\s*:\s*([^;]+)/.exec(matched[1]);
  assert.ok(padding, '窄屏 `.main-scroll` 没有 padding');
  /* 剥掉 !important（它是优先级标记，不是值的一部分）。 */
  return sides(padding[1].replace(/\s*!important\s*$/i, '').trim());
}

/**
 * 外壳层（`.main-scroll` 那一层）的左内边距。
 * 宽屏：按级联算真正生效的那一条；窄屏：mobile.css 的 !important 压着一切。
 */
function shellLeft(viewport, candidates) {
  if (viewport <= MOBILE_MAX) return px(mobileShellPadding()[3]);
  const hit = effective(candidates, 'padding', viewport);
  if (!hit) return 0;
  const value = px(sides(hit.value)[3]);
  return value === null ? 0 : value;
}

/* ───────────────────── 各元素：能命中它的候选选择器 ───────────────────── */

/** 承载平台页的滚动容器（页面根容器 `.platform-page` 是它的**直接子节点**）。 */
const SHELL_PLATFORM = [
  { file: 'css/deepseek.css', selector: '.main-scroll' },
  { file: 'css/platform.css', selector: '.main-scroll:has(>.platform-page)' },
];

/** 文件中心的滚动容器（它自己同时是 `.main-scroll` 与 `.file-center-page`）。 */
const SHELL_FILE_CENTER = [
  { file: 'css/deepseek.css', selector: '.main-scroll' },
  { file: 'css/file-center.css', selector: '.file-center-page' },
  { file: 'css/file-center.css', selector: '.main-scroll.file-center-page' },
];

/** 平台页的页面根容器。 */
const ROOT_PLATFORM = [{ file: 'css/platform.css', selector: '.platform-page' }];

/** 域内两页的页面根容器：`.example-host-page` / `.example-rules-page` **就是** `.platform-page` 那一个元素。 */
const ROOT_example = page => [
  { file: 'css/platform.css', selector: '.platform-page' },
  { file: 'css/domains/example-domain/example-domain.css', selector: page },
];

/** 审核中心独立页：`.review-center-page` 也是 `.platform-page` 那一个元素。 */
const ROOT_REVIEW = [
  { file: 'css/platform.css', selector: '.platform-page' },
  { file: 'css/review-center.css', selector: '.review-center-page' },
];

/** 平台页的页头条（工作台／域内两页／审核中心都用它）。 */
const HEADING = [{ file: 'css/workbench.css', selector: '.page-hd' }];

/** 文件中心的标题栏。 */
const HEADING_FILE_CENTER = [{ file: 'css/file-center.css', selector: '.file-center-page .file-heading' }];

/**
 * 文件中心的页面层 ＝ 0：文件中心的「页面根容器」就是那个 `.main-scroll.file-center-page`
 * （它自己，外层留白 0），已经算在 SHELL_FILE_CENTER 里 ⇒ 这一层不再另算。
 */
const ROOT_FILE_CENTER = [];

/**
 * 标题文字的左边缘 ＝ 外壳层 ＋ 页面根容器 ＋ 标题栏，三层加起来。
 */
function titleLeftEdge(shell, root, heading, viewport) {
  return shellLeft(viewport, shell) + padLeft(root, viewport) + padLeft(heading, viewport);
}

/* ───────────────────────── ⓪ 小工具自检 ───────────────────────── */

test('⓪ 级联小工具自检：优先级算对了（算错了下面的数就全错了）', () => {
  assert.deepEqual(specificity('.main-scroll'), [0, 1, 0]);
  assert.deepEqual(specificity('.main-scroll:has(>.platform-page)'), [0, 2, 0]);
  assert.deepEqual(specificity('.main-scroll.file-center-page'), [0, 2, 0]);
  assert.deepEqual(specificity('.file-center-page .file-heading'), [0, 2, 0]);
  assert.deepEqual(specificity('.workbench-layout>.workbench-recent'), [0, 2, 0]);
  assert.deepEqual(specificity('.platform-page'), [0, 1, 0]);
});

/* ───────────────────────── ① 标题位置 ───────────────────────── */

test('① 工作台标题的左边缘 ＝ 文件中心标题的左边缘 ＝ 26px（同一条竖线）', () => {
  const workbench = titleLeftEdge(SHELL_PLATFORM, ROOT_PLATFORM, HEADING, WIDE);
  const fileCenter = titleLeftEdge(SHELL_FILE_CENTER, ROOT_FILE_CENTER, HEADING_FILE_CENTER, WIDE);
  assert.equal(workbench, STANDARD.wide,
    `工作台标题「工作台」的左边缘是 ${workbench}px —— 应为 ${STANDARD.wide}px（与文件中心同一个数）`);
  assert.equal(fileCenter, STANDARD.wide,
    `文件中心标题「文件中心」的左边缘是 ${fileCenter}px —— 应为 ${STANDARD.wide}px（参照系本身不许动）`);
  assert.equal(workbench, fileCenter,
    `工作台标题在 ${workbench}px、文件中心标题在 ${fileCenter}px —— 两条竖线没对齐`);
});

test('①b 参照系不许被这次改动带着走（文件中心标题仍 26px，标题栏仍贴在内容区上沿）', () => {
  const heading = effective(HEADING_FILE_CENTER, 'padding', WIDE);
  assert.ok(heading, '文件中心的标题栏样式不见了');
  assert.equal(px(sides(heading.value)[3]), STANDARD.wide,
    `文件中心标题栏左右留白现在是 ${heading.value}`);
  const shell = effective(SHELL_FILE_CENTER, 'padding', WIDE);
  assert.ok(shell, '文件中心的滚动容器样式不见了');
  assert.equal(px(sides(shell.value)[0]), 0,
    `文件中心的滚动容器顶部多了留白（${shell.value}）—— 标题栏不再贴着内容区上沿`);
});

/* ───────────────────────── ② 主体 ／ aside ───────────────────────── */

test('② 工作台两栏之间**没有间隙**，只隔 **1px 竖分隔线**（同文件中心「主体 ／ aside」）', () => {
  /* 间隙 ＝ 0（文件中心的 `.file-content` 是 flex，没写 gap ⇒ 也是 0）。 */
  const gap = resolver.resolve('.workbench-layout', 'gap', { viewport: WIDE });
  assert.ok(gap, '工作台两栏那一排的样式不见了');
  assert.equal(px(gap.value), 0,
    `工作台两栏之间还有 ${gap.value} 的间隙 —— 应为 0（同文件中心「主体 ／ aside」之间没有间隙）`);

  /* 分隔线 ＝ 1px（文件中心 `aside.file-details` 的 `border-left:1px solid var(--line)`）。 */
  const reference = resolver.resolve('.file-center-page .file-details', 'border-left', { viewport: WIDE });
  assert.ok(reference, '参照系 `aside.file-details` 的左边框不见了');
  const separator = resolver.resolve('.workbench-layout>.workbench-recent', 'border-left', { viewport: WIDE });
  assert.ok(separator, '工作台右栏（最近流程）没有自己的左边框 ⇒ 两栏之间什么也没有隔开');
  assert.equal(px(separator.value.split(/\s+/)[0]), 1,
    `工作台两栏之间的分隔线是 ${separator.value} —— 应为 1px`);
  assert.equal(separator.value, reference.value,
    `工作台的分隔线「${separator.value}」与文件中心的「${reference.value}」不是同一个写法`);

  /* 右栏（aside）的内容离分隔线的距离 ＝ 1px 线 ＋ 20px 内缩（文件中心 `aside.file-details` 同一个数）。 */
  const inset = padLeft([
    { file: 'css/platform.css', selector: '.platform-section' },
    { file: 'css/platform.css', selector: '.workbench-layout>.workbench-recent' },
  ], WIDE) + px(reference.value.split(/\s+/)[0]);
  assert.equal(inset, 21,
    `工作台右栏内容离分隔线 ${inset}px —— 应为 21px（1px 线 ＋ 20px 内缩，同文件中心）`);
});

test('②b 两栏**不再各画各的卡片外框**（同文件中心：主体是通栏，只有一根分隔线）', () => {
  const frame = resolver.resolve('.workbench-layout>.platform-section', 'border', { viewport: WIDE });
  assert.ok(frame, '工作台两栏那一排的样式不见了');
  assert.equal(px(frame.value), 0,
    `两栏还各自带着 ${frame.value} 的卡片外框 —— 应为 0（同文件中心「主体」是通栏，不画外框）`);
});

/* ───────────────────────── ③ 只留一层横向留白 ───────────────────────── */

test('③ 承载工作台的滚动容器**没有多出来的外层留白**（横向只剩 L1 那一层 26px）', () => {
  const shell = effective(SHELL_PLATFORM, 'padding', WIDE);
  assert.ok(shell, '滚动容器的样式不见了');
  assert.equal(px(sides(shell.value)[3]), 0,
    `滚动容器横向还带着 ${shell.value} —— 横向留白只能由 L1（.platform-page 的 26px）给，`
    + '不能再叠一层（用户批注：「这里有一个 padding，你就按照这个做吧，删掉就行」）');
  assert.equal(px(sides(shell.value)[1]), 0, '滚动容器右边还带着外层留白');

  /* 顶部不留多余空白（工作台第一行内容与文件中心标题栏一样贴在内容区上沿）。 */
  assert.equal(padTop(SHELL_PLATFORM, WIDE), 0,
    `滚动容器顶部还有 ${padTop(SHELL_PLATFORM, WIDE)}px 空白 —— 工作台第一行不再与文件中心标题栏对齐`);
});

test('③b 域内两页（官文助手 ／ 邮件规则表）也跟着落在同一条 26px 的竖线上', () => {
  for (const page of ['.example-host-page', '.example-rules-page']) {
    const edge = titleLeftEdge(SHELL_PLATFORM, ROOT_example(page), HEADING, WIDE);
    assert.equal(edge, STANDARD.wide,
      `${page} 的标题左边缘是 ${edge}px —— 应为 ${STANDARD.wide}px`
      + '（域内页自己的容器不许把公共壳给的横向留白归零）');
  }
});

test('③c 审核中心独立页也落在同一条 26px 的竖线上', () => {
  const edge = titleLeftEdge(SHELL_PLATFORM, ROOT_REVIEW, HEADING, WIDE);
  assert.equal(edge, STANDARD.wide,
    `审核中心独立页的标题左边缘是 ${edge}px —— 应为 ${STANDARD.wide}px`);
});

test('③d 卡内 16px 没动：工作台四排的内容左边缘仍是 42px（这一轮只动外层与两栏间距）', () => {
  const chain = resolver.leftEdge([
    { file: 'css/platform.css', selector: '.platform-page' },
    { file: 'css/platform.css', selector: '.workbench-layout' },
    { file: 'css/platform.css', selector: '.platform-section' },
    { file: 'css/platform.css', selector: '.workbench-app-list>button' },
  ], { viewport: WIDE });
  assert.equal(chain.edge, 42,
    `工作台「常用应用」的内容左边缘是 ${chain.edge}px —— 应为 26（整页留白）＋16（卡内内边距）＝42`);
});

/* ───────────────────────── ④ 窄屏：两个页面仍然是同一个数 ───────────────────────── */

test('④ 窄屏（≤680px）工作台与文件中心仍是同一个数（外壳层相同 ＋ 各自页面层 16px）', () => {
  const workbench = titleLeftEdge(SHELL_PLATFORM, ROOT_PLATFORM, HEADING, NARROW);
  const fileCenter = titleLeftEdge(SHELL_FILE_CENTER, ROOT_FILE_CENTER, HEADING_FILE_CENTER, NARROW);
  assert.equal(workbench, fileCenter,
    `窄屏工作台标题在 ${workbench}px、文件中心标题在 ${fileCenter}px —— 两个页面又不一致了`);
  assert.equal(padLeft(ROOT_PLATFORM, NARROW), STANDARD.narrow,
    `窄屏平台页的页面层留白是 ${padLeft(ROOT_PLATFORM, NARROW)}px —— 应为 ${STANDARD.narrow}px`);
  assert.equal(padLeft(HEADING_FILE_CENTER, NARROW), STANDARD.narrow,
    `窄屏文件中心标题栏的留白是 ${padLeft(HEADING_FILE_CENTER, NARROW)}px —— 应为 ${STANDARD.narrow}px`);
});
