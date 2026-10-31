// 判据：全站**页面骨架**统一（PKG-045-T02 · 用户 2026-10-23 12:41 原话：
// 「关于页面视觉统一的问题，我建议做一次重构，基于邮件中心、excel、文件中心的 dom
//   （不要求内部内容一致），把基础结构统一掉」）。
//
// **测试通过 =**（一句话）
// 「**任何页面的页头条**都是同一副骨架 —— 高度 **68px**、元素间距 **12px**、
//   标题 **20px/650**、`h1` **直接就是页头条的子元素**（不再套一层 div）；
//   而**三个参照页**（文件中心 / Excel 清单页 / 邮件中心）自己算出来仍然是
//   **68px / 26px / 12px** —— 没被这次重构改坏；
//   已登记的**例外**（受管表页 `.objects-page` / 应用详情 `.application-shell` /
//   流程产品面 `.pf-root`）保持原样，仍然是例外。」
//
// ⚠️ **病根不是字号**（2026-10-22 已经把标题字号收成 20px/650 了）：
//   字号统一了，但**结构没统一** —— 全站页头条有 **4 种 DOM 形态、6 个高度**
//   （`.page-hd` 平级 32px / `.page-hd.platform-page-head` 嵌套 51px /
//   `.admin-page .page-hd` 列排 55px / `.platform-heading` 32px /
//   `.objects-page>.page-hd` 56px / 参照系 68px）
//   ⇒ 用户看到的「工作台标题高度和其他页面不一致」就是这么来的。
//   ⇒ 这轮**动结构**（收成一种骨架），**不是**逐页调数值；
//     **内容区（卡片／表格／列表）不要求一致**（用户原话「不要求内部内容一致」）—— 这条判据也不管。
//
// ⚠️ **判据断的是「算出来的生效值」**，用 `scripts/lib/css-cascade.mjs`
//   （与检查器同一套）：按 **加载顺序 + 特异性** 算出某个页头条**真正生效**的
//   高度／留白／间距／标题字号 —— 不是「文件里有没有 68px 这几个字」。
//
// ⚠️ **例外仍成立**：`.objects-page`（受管表页）/ `.application-shell`（应用详情）
//   是**全屏工作区**（自带侧栏／索引栏 ＋ 通栏表格），`.pf-root`（流程产品面）是
//   **通栏工作区** —— 它们的页头条**几何照旧**，登记在规范 §9 的例外清单里。
//   本判据把它们单列，**不许被这次重构带红**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResolver, px, sides } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = path.join(ROOT, 'shangshu-web');
const resolver = createResolver(ROOT);

const WIDE = 1440;
const NARROW = 600;

/** 全站页面骨架的**那一个数**（参照系＝邮件中心 / Excel 清单页 / 文件中心）。 */
const STANDARD = { height: 68, gap: 12, titleSize: 20, titleWeight: '650', inset: 26, narrowHeight: 60 };

/* ───────────────────────── 生效值计算（加载顺序 ＋ 特异性） ───────────────────────── */

/**
 * 某个页头条元素**真正生效**的属性值。
 * `candidates` ＝这个元素身上所有可能命中的选择器（它自己的类 ＋ 祖先链上的限定）。
 * 取「特异性最高、同特异性里最后加载」的那一条 —— 与浏览器一致。
 *
 * ⚠ **算法在公用件里**（`helpers/css-effective.mjs`）—— 别再手抄一份。
 */
const effective = createEffective(resolver, WIDE);

/**
 * 页头条的**算出来的生效高度**（px）。
 * 有的页写死 `height:68px`，有的写 `height:auto;min-height:68px`（内容更长时自己撑开）
 * ⇒ 两种都算「高 68px」：先看 height，不是不固定就看 min-height。
 */
function effectiveHeight(candidates, viewport = WIDE) {
  const height = effective(candidates, 'height', viewport);
  if (height) {
    const value = px(height.value);
    if (value !== null) return value;
    if (height.value !== 'auto') return null;      // 其它写法算不出来 ⇒ 判据不猜
  }
  const minHeight = effective(candidates, 'min-height', viewport);
  return minHeight ? px(minHeight.value) : null;
}

/* ───────────────────────── 页面族台账 ───────────────────────── */

/**
 * 全站页头条**家族**台账。
 * `box` ＝页头条**这个盒子**身上所有可能命中的选择器；
 * `title` ＝它的**标题**（h1）身上所有可能命中的选择器。
 * （选择器写全，是为了让「算出来的生效值」经得起别人重算。）
 */
const FAMILIES = [
  {
    id: 'platform',
    label: '平台页（工作台／管理页／业务页／兼容页…）',
    box: ['.page-hd', '.page-heading', '.platform-page-head'],
    title: ['.page-hd h1', '.page-heading h1'],
  },
  {
    id: 'file-center',
    label: '文件中心（参照系）',
    box: ['.page-heading', '.file-center-page .file-heading'],
    title: ['.page-heading h1', '.page-hd h1', '.file-center-page .file-heading h1'],
  },
  {
    id: 'excel-picker',
    label: 'Excel 清单页（参照系 · 域内）',
    box: ['.page-heading', '.file-center-page .file-heading', '.excel-picker .file-heading'],
    title: ['.page-heading h1', '.file-center-page .file-heading h1', '.excel-picker .file-heading h1'],
  },
  {
    id: 'mail-center',
    label: '邮件中心（参照系）',
    box: ['.page-heading', '.mail-center-page .mail-heading'],
    title: ['.page-heading h1', '.mail-center-page .mail-heading h1'],
  },
  {
    id: 'sheet-center',
    label: '表格工作面',
    box: ['.page-heading', '.sheet-center-page .sheet-heading'],
    title: ['.page-heading h1', '.sheet-center-page .sheet-heading h1'],
  },
];

/**
 * 各家自己写的标题字号（值必须与骨架同一个数）。
 * `own` ＝这一家自己的写法；它还继承骨架口径（`.page-heading h1` ／ `.page-hd h1`）。
 */
const TITLE_VARIANTS = [
  { label: '管理员页', own: '.admin-page .page-hd h1' },
  { label: '审核中心', own: '.review-center-page .page-hd h1' },
  { label: '域内官文助手', own: '.example-host-page .page-hd h1' },
  { label: '域内邮件规则表', own: '.example-rules-page .page-hd h1' },
  { label: '受管表页', own: '.objects-page>.page-hd h1' },
];

/** 例外族（登记在案的「可以不一样」）：几何照旧，不许被这次重构带红。 */
const EXCEPTIONS = [
  {
    id: 'objects-page',
    label: '受管表页（`.objects-page`）—— 全屏工作区（自带数据集侧栏 ＋ 通栏表格）',
    selectors: ['.page-hd', '.objects-page>.page-hd'],
    expectPadding: '10px 16px',
    expectMinHeight: 56,
  },
  {
    id: 'pf-root',
    label: '流程产品面（`.pf-root`）—— 通栏工作区（页头条 24px ／ 面板 18px）',
    selectors: ['.page-hd', '.pf-page-head'],
    expectPadding: '20px 24px',
  },
];

/* ───────────────────────── ① 参照系不许被改坏 ───────────────────────── */

test('① 三个参照页的页头条：算出来还是 68px / 26px / 12px，标题 20px / 650 / margin 0', () => {
  for (const id of ['file-center', 'excel-picker', 'mail-center']) {
    const family = FAMILIES.find(f => f.id === id);

    const height = effectiveHeight(family.box);
    assert.ok(height !== null, `参照系 ${id} 的页头条**没有高度声明** —— 参照系自己失效了`);
    assert.equal(height, STANDARD.height,
      `参照系 ${id} 的页头条高度现在是 ${height}px —— 三个参照页必须是同一个数（${STANDARD.height}px）`);

    const padding = effective(family.box, 'padding');
    assert.ok(padding, `参照系 ${id} 的页头条**没有留白声明**`);
    assert.equal(px(sides(padding.value)[1]), STANDARD.inset,
      `参照系 ${id} 的页头条左右留白现在是 ${padding.value}`);
    assert.equal(px(sides(padding.value)[3]), STANDARD.inset,
      `参照系 ${id} 的页头条左右留白现在是 ${padding.value}`);

    const gap = effective(family.box, 'gap');
    assert.ok(gap, `参照系 ${id} 的页头条**没有间距声明**`);
    assert.equal(px(gap.value), STANDARD.gap,
      `参照系 ${id} 的页头条元素间距现在是 ${gap.value}`);

    const size = effective(family.title, 'font-size');
    assert.ok(size, `参照系 ${id} 的标题**没有字号声明**`);
    assert.equal(px(size.value), STANDARD.titleSize, `参照系 ${id} 的标题字号现在是 ${size.value}`);
  }
});

test('①b 参照系的标题：字重 650 ／ 外边距 0 —— 与平台页同一个数', () => {
  for (const id of ['file-center', 'excel-picker', 'mail-center']) {
    const family = FAMILIES.find(f => f.id === id);
    const weight = effective(family.title, 'font-weight');
    assert.ok(weight, `参照系 ${id} 的标题没有字重声明`);
    assert.equal(weight.value, STANDARD.titleWeight, `参照系 ${id} 的标题字重现在是 ${weight.value}`);
    const margin = effective(family.title, 'margin');
    assert.ok(margin, `参照系 ${id} 的标题没有外边距声明`);
    assert.equal(px(margin.value), 0, `参照系 ${id} 的标题外边距现在是 ${margin.value}`);
  }
});

/* ───────────────────────── ② 全站页头条同一个数 ───────────────────────── */

test('② 全站每一族页头条：高度 / 间距 / 标题 都是同一个数（不许某页单开一条）', () => {
  for (const family of FAMILIES) {
    const height = effectiveHeight(family.box);
    assert.ok(height !== null, `${family.label} 的页头条没有高度声明`);
    assert.equal(height, STANDARD.height,
      `${family.label} 的页头条高度是 ${height}px —— 应与参照系同一个数（${STANDARD.height}px）`);

    const gap = effective(family.box, 'gap');
    assert.ok(gap, `${family.label} 的页头条没有间距声明`);
    assert.equal(px(gap.value), STANDARD.gap,
      `${family.label} 的页头条元素间距是 ${gap.value} —— 应与参照系同一个数（${STANDARD.gap}px）`);

    const size = effective(family.title, 'font-size');
    assert.ok(size, `${family.label} 的标题没有字号声明`);
    assert.equal(px(size.value), STANDARD.titleSize,
      `${family.label} 的标题字号是 ${size.value} —— 应与参照系同一个数`);

    const weight = effective(family.title, 'font-weight');
    assert.ok(weight, `${family.label} 的标题没有字重声明`);
    assert.equal(weight.value, STANDARD.titleWeight,
      `${family.label} 的标题字重是 ${weight.value} —— 应与参照系同一个数`);
  }
});

test('②b 各家自己写的标题字号（管理员页／审核中心／域内页／受管表页）也还是同一个数', () => {
  for (const variant of TITLE_VARIANTS) {
    const candidates = [variant.own, '.page-heading h1', '.page-hd h1'];
    const size = effective(candidates, 'font-size');
    assert.ok(size, `${variant.label}（${variant.own}）的字号声明不见了`);
    assert.equal(px(size.value), STANDARD.titleSize, `${variant.label} 的字号现在是 ${size.value}`);
    const weight = effective(candidates, 'font-weight');
    assert.ok(weight, `${variant.label} 的字重声明不见了`);
    assert.equal(weight.value, STANDARD.titleWeight, `${variant.label} 的字重现在是 ${weight.value}`);
  }
});

test('②c 窄屏（≤600px）平台页的页头条仍然是骨架那一副（高度 68px），不许被窄屏规则改形', () => {
  /* 参照系在窄屏各有自己的档（邮件中心／表格工作面 60px）—— 那是**它们**的响应式行为，
     本轮不动；这里只盯**平台页**：窄屏也得是骨架的 68px（副标题换行也不许变形）。 */
  const platform = FAMILIES.find(f => f.id === 'platform');
  const height = effectiveHeight(platform.box, NARROW);
  assert.ok(height !== null, '平台页在窄屏没有高度声明');
  assert.equal(height, STANDARD.height,
    `平台页窄屏的页头条高度是 ${height}px —— 应与宽屏同一个数（${STANDARD.height}px）`);
});

/* ───────────────────────── ③ 结构型只有一种（这次的核心判据） ───────────────────────── */

/** 页头条用的类名（卡片里的“小标题”不算页头条）。 */
const HEADING_CLASSES = ['page-hd', 'file-heading', 'mail-heading', 'sheet-heading', 'platform-heading'];

/** 例外：流程产品面 `.pf-page-head` 是**通栏工作区**，它的标题块自带一层 div（登记在案，不改）。 */
const STRUCTURAL_EXCEPTIONS = ['pf-page-head'];

function walk(dir, filter, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

/** 页头条的 DOM 模板（`<div class="page-hd…">…</div>` 这种）。 */
function headingTemplates(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\\"/g, '"');
  const out = [];
  /* 认两种写法：`class="…"`（模板字符串里）与 `class=\"…\"`（转义后的字符串）——
     先把转义引号还原成普通引号，再用同一条正则扫。 */
  const open = /<(div|header|section)\b([^>]*\bclass="([^"]*)"[^>]*)>/g;
  let match;
  while ((match = open.exec(text))) {
    const [, tag, attrs, classList] = match;
    const classes = classList.split(/\s+/).filter(Boolean);
    if (!classes.some(c => HEADING_CLASSES.includes(c))) continue;
    /* 找到配对的结束标签，取出内部 HTML。 */
    const tagRe = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    tagRe.lastIndex = open.lastIndex;
    let depth = 1, inner = null;
    let step;
    while ((step = tagRe.exec(text))) {
      if (step[0].startsWith('</')) {
        depth--;
        if (depth === 0) { inner = text.slice(open.lastIndex, step.index); break; }
      } else {
        depth++;
      }
    }
    if (inner === null) continue;
    out.push({
      file: path.relative(ROOT, file),
      line: text.slice(0, match.index).split('\n').length,
      tag,
      classes,
      inner,
    });
  }
  return out;
}

/** 内部第一个**元素**子节点的标签名（跳过空白与注释）。 */
function firstElementTag(html) {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  const found = cleaned.match(/<\s*([a-z][a-z0-9-]*)/i);
  return found ? found[1].toLowerCase() : null;
}

/**
 * 扫哪些文件：**源码**。
 * ⚠️ 域内的**构建产物**（`excel-univer-entry.js` ＝ vite 打包出来的那个）**不扫** ——
 *   它的真身在 `src/`（域内 `src/directory.ts` 已挂 `.page-heading`）；
 *   产物由域内 `npm run build` 重建，重建前扫它只会把「产物还没重建」当成「结构不统一」。
 *   判法：**显式名单 ＋ 同目录有 vite 配置的 `*-entry.js`**（不靠「行很长」这种猜法 ——
 *   好几份正常源码也有超长行，用猜法会把它们一起漏掉）。
 */
const BUILD_ARTIFACTS = ['js/domains/excel-univer/excel-univer-entry.js'];

function isBuildArtifact(file) {
  const rel = path.relative(WEB, file);
  if (BUILD_ARTIFACTS.includes(rel.split(path.sep).join('/'))) return true;
  const dir = path.dirname(file);
  if (!fs.existsSync(path.join(dir, 'vite.config.ts'))) return false;
  return /-entry\.js$/.test(path.basename(file));
}

const templateFiles = walk(path.join(WEB, 'js'), f => /\.(js|ts|mjs)$/.test(f) && !f.includes('/vendor/'))
  .filter(f => !isBuildArtifact(f));

test('③ 全站页头条的 DOM 只有一种：`h1` 直接是页头条的子元素（不许再套一层 div）', () => {
  const templates = templateFiles.flatMap(headingTemplates);
  assert.ok(templates.length >= 40, `只扫到 ${templates.length} 处页头条模板 —— 扫描面不对`);
  const offenders = [];
  for (const tpl of templates) {
    if (tpl.classes.some(c => STRUCTURAL_EXCEPTIONS.includes(c))) continue;   // 已登记的例外
    const first = firstElementTag(tpl.inner);
    if (first !== 'h1') {
      offenders.push(`${tpl.file}:${tpl.line}  <${tpl.tag} class="${tpl.classes.join(' ')}"> 的第一个元素子节点是 <${first || '?'}>`);
    }
  }
  assert.equal(offenders.length, 0,
    `这些页头条的标题**不是直接子元素**（套了一层 div）—— 全站只许一种骨架：\n  · ${offenders.join('\n  · ')}`);
});

test('③b 全站每一个页头条都挂公共骨架类 `.page-heading`（不许某页单开一套）', () => {
  const templates = templateFiles.flatMap(headingTemplates);
  const offenders = templates
    .filter(tpl => !tpl.classes.includes('page-heading'))
    .map(tpl => `${tpl.file}:${tpl.line}  class="${tpl.classes.join(' ')}"`);
  assert.equal(offenders.length, 0,
    '这些页头条没有挂公共骨架类 .page-heading —— 骨架只能有一个：\n  · ' + offenders.join('\n  · '));
});

test('③c 审核中心的页头条（JS 现搭的，扫不到模板）也是同一副骨架', () => {
  /* 审核中心是**用 JS 拼出来的**页头条 ⇒ 上面的模板扫描看不到它 ⇒ 单独断它的写法：
     页头条挂骨架类，且 `h1` **直接挂到页头条上**（不再套一层标题块 div）。 */
  const source = fs.readFileSync(path.join(WEB, 'js', 'review-center.js'), 'utf8');
  assert.ok(/element\('header',\s*'[^']*\bpage-heading\b[^']*'\)/.test(source),
    '审核中心的页头条没有挂公共骨架类 .page-heading');
  assert.ok(/header\.appendChild\(element\('h1'/.test(source),
    '审核中心的标题不是直接挂到页头条上的（套了一层标题块 div）');
  assert.ok(!/const titles = element\('div'\)/.test(source),
    '审核中心还在用标题块 div —— 全站只许一种骨架');
});

/* ───────────────────────── ④ 例外仍成立 ───────────────────────── */

test('④ 例外：受管表页 `.objects-page` 的页头条几何照旧（16px 留白 ＋ 56px 高）', () => {
  const family = EXCEPTIONS.find(e => e.id === 'objects-page');
  const padding = effective(family.selectors, 'padding');
  assert.ok(padding, '受管表页的页头条没有留白声明');
  assert.equal(px(sides(padding.value)[3]), 16,
    `受管表页的页头条左右留白现在是 ${padding.value} —— 例外的几何不许被这次重构改掉`);
  const minHeight = effective(family.selectors, 'min-height');
  assert.ok(minHeight, '受管表页的页头条没有高度声明');
  assert.equal(px(minHeight.value), family.expectMinHeight,
    `受管表页的页头条高度现在是 ${minHeight.value} —— 例外的几何不许被这次重构改掉`);
  const height = effective(family.selectors, 'height');
  assert.ok(!height || height.value === 'auto',
    `受管表页的页头条高度被改成了 ${height?.value} —— 例外必须真的例外（自己撑开，不吃骨架的固定高）`);
});

test('④b 例外：流程产品面 `.pf-page-head` 的页头条几何照旧（24px 留白）', () => {
  const family = EXCEPTIONS.find(e => e.id === 'pf-root');
  const padding = effective(family.selectors, 'padding');
  assert.ok(padding, '流程产品面的页头条没有留白声明');
  assert.equal(px(sides(padding.value)[3]), 24,
    `流程产品面的页头条左右留白现在是 ${padding.value} —— 例外的几何不许被这次重构改掉`);
  const height = effective(family.selectors, 'height');
  assert.ok(!height || height.value === 'auto',
    `流程产品面的页头条高度被改成了 ${height?.value} —— 例外必须真的例外（自己撑开，不吃骨架的固定高）`);
});

test('④c 例外仍登记在规范里（不许悄悄取消）', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(WEB, 'style-rules.json'), 'utf8'));
  const text = JSON.stringify(spec.exceptions || []);
  assert.ok(text.includes('objects-page'), '规范里没有登记「受管表页」这个例外');
  assert.ok(text.includes('pf-root'), '规范里没有登记「流程产品面」这个例外');
  const ids = spec.rules.map(r => r.id);
  assert.ok(ids.includes('PS-01'), '规范里没有页面骨架的规则（PS-xx）');
});
