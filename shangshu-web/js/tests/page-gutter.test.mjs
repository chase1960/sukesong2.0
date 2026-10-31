// 判据：全站页面的**边距（margin/padding）统一到一套分层标准**。
//
// **测试通过 =**（一句话）
// 「全站所有**平台页**（`.platform-page` 家族：工作台／应用中心／应用设计／应用管理／
//   个人设置／数据页／域内页）的左右留白都来自**同一层**（页面根容器 `.platform-page`
//   的 padding ＝ 26px，窄屏 16px），页面内的每一块**不再自带横向外边距**；
//   于是：页头条的文字、卡片的外沿都落在**同一条 26px 的竖线**上，
//   卡片里的内容落在 26＋16＝42px 上（窄屏 16＋16＝32px）——
//   跟参照系（文件中心 `.file-heading` 26px ＝ `.file-table-area` 26px）是同一个数。」
//
// ⚠️ **判据断的是「算出来的像素数」，不是「文件里有没有 26px 这几个字」**：
//   这里把 CSS **解析**出来（`scripts/lib/css-cascade.mjs`，与检查器同一套做法），
//   按 CSS 盒模型把每一层的 margin/padding 加起来，得出**每一块真实的左边缘**，
//   最后断言这些左边缘**相等**且等于标准值。
//   ⇒ 以后谁给某一页单独加了一行 `margin-left`，或把某一层从 margin 改成 padding，
//     这条判据立刻红。
//
// 为什么要有这条（用户 2026-10-22 16:49 原话）：
//   「你让一个子agent把，margin都查一下，定个稍微的标准出来，现在视觉都不统一，
//     官文助手和邮件规则表也都不一样，还会少元素。」
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, sides, px } from '../../../scripts/lib/css-cascade.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);

const WIDE = 1440;      // 宽屏视口
const NARROW = 600;     // 窄屏视口（≤680px 的那档）

/** 标准：宽屏 26px、窄屏 16px（参照系＝文件中心 `.file-heading` / `.file-table-area`）。 */
const STANDARD = { wide: 26, narrow: 16 };
/** 卡片内层留白 16px（`.platform-section` / `.platform-kpi` 一律 16）⇒ 一级内容左边缘 26＋16＝42。 */
const CARD_PAD = 16;

/* ───────────────────────── 参照系（不许动） ───────────────────────── */
test('① 参照系本身仍是 26px ／ 窄屏 16px（标准是照它反推的，不是照它改）', () => {
  const wide = resolver.resolve('.file-center-page .file-table-area', 'padding', { viewport: WIDE });
  assert.ok(wide, '参照系 `.file-table-area` 的 padding 声明不见了');
  assert.equal(px(sides(wide.value)[1]), STANDARD.wide, `参照系左右留白现在是 ${wide.value}`);
  assert.equal(px(sides(wide.value)[3]), STANDARD.wide, `参照系左右留白现在是 ${wide.value}`);

  const narrow = resolver.resolve('.file-center-page .file-table-area', 'padding', { viewport: NARROW });
  assert.ok(narrow, '参照系窄屏的 `.file-table-area` padding 声明不见了');
  assert.equal(px(sides(narrow.value)[1]), STANDARD.narrow, `参照系窄屏左右留白现在是 ${narrow.value}`);

  /* 页头条与内容列**同一条竖线** —— 这是参照系的做法，也是全站标准。 */
  const heading = resolver.resolve('.file-center-page .file-heading', 'padding', { viewport: WIDE });
  assert.equal(px(sides(heading.value)[3]), STANDARD.wide, `参照系页头条留白现在是 ${heading.value}`);
});

/* ───────────────────────── L1：统一的那一层 ───────────────────────── */
test('② L1 页面内容列：`.platform-page` 自己给整页左右留白（26px ／ 窄屏 16px）', () => {
  const wide = resolver.resolve('.platform-page', 'padding', { viewport: WIDE });
  assert.ok(wide, '`.platform-page` 的 padding 声明不见了');
  assert.equal(px(sides(wide.value)[3]), STANDARD.wide, `宽屏页面留白现在是 ${wide.value}`);
  assert.equal(px(sides(wide.value)[1]), STANDARD.wide, `宽屏页面留白现在是 ${wide.value}`);

  const narrow = resolver.resolve('.platform-page', 'padding', { viewport: NARROW });
  assert.ok(narrow, '`.platform-page` 窄屏的 padding 声明不见了');
  assert.equal(px(sides(narrow.value)[3]), STANDARD.narrow, `窄屏页面留白现在是 ${narrow.value}`);
  assert.equal(px(sides(narrow.value)[1]), STANDARD.narrow, `窄屏页面留白现在是 ${narrow.value}`);
});

test('③ L1 是**唯一**给整页留白的那一层：页面内各块横向贡献必须都是 0', () => {
  /* 这些块都是**直接挂在 `.platform-page` 下面**的（DOM 结构在 js/ 里核过）。 */
  const blocks = [
    ['css/platform.css', '.platform-section'],
    ['css/platform.css', '.platform-kpis'],
    ['css/platform.css', '.workbench-status'],
    ['css/platform.css', '.workbench-layout'],
    ['css/platform.css', '.workbench-domain'],
    ['css/platform.css', '.workbench-collaboration'],
    ['css/platform.css', '.apps-grid'],
    ['css/platform.css', '.application-grid'],
    ['css/platform.css', '.applications-intro'],
    ['css/platform.css', '.application-design-body'],
    /* ⚠️ `.pf-surface` **不在这里**：流程产品面 `.pf-root` 不是 `.platform-page` 家族
       （自己占满整宽、没有 L1 可继承）⇒ 它自己的内缩照旧，登记在规范 §9 的例外清单里。 */
  ];
  for (const [file, selector] of blocks) {
    for (const [viewport] of [[WIDE], [NARROW]]) {
      const gutter = STANDARD[viewport === WIDE ? 'wide' : 'narrow'];
      /* 容器**外沿**＝整页留白（L1 的 padding）＋ 各层外边距（卡片的 16px 是**内**边距，不是留白）。 */
      const outer = resolver.leftEdgeOuter([
        { file: 'css/platform.css', selector: '.platform-page' },
        { file, selector },
      ], { viewport });
      const outerEdge = resolver.pageGutter({ viewport }) + outer.edge;
      assert.equal(outerEdge, gutter,
        `${selector}（${viewport === WIDE ? '宽屏' : '窄屏'}）的容器外沿是 ${outerEdge}px —— 应为 ${gutter}px`);
      const chain = resolver.leftEdge([
        { file: 'css/platform.css', selector: '.platform-page' },
        { file, selector },
      ], { viewport });
      assert.equal(chain.steps[1].marginLeft, 0,
        `${selector} 自己还带着 ${chain.steps[1].marginLeft}px 的横向外边距 —— `
        + '横向留白只能由统一的那一层给');
    }
  }
});

/* ───────────────────────── L2：页头条 ───────────────────────── */
test('④ L2 页头条不自带横向留白 ⇒ 标题文字与卡片外沿同在 26px 那条线上', () => {
  /* 平台页的页头类 `.page-hd` 本身**不许有横向留白**（留白由 L1 给）。 */
  for (const [viewport, want] of [[WIDE, STANDARD.wide], [NARROW, STANDARD.narrow]]) {
    const chain = resolver.leftEdge([
      { file: 'css/platform.css', selector: '.platform-page' },
      { file: 'css/workbench.css', selector: '.page-hd' },
    ], { viewport });
    assert.equal(chain.edge, want,
      `页头条文字的左边缘是 ${chain.edge}px —— 应为 ${want}px（与卡片外沿同一条线）`);
  }
});

/* ───────────────────────── L3：卡片容器 ───────────────────────── */
test('⑤ L3 卡片容器：外沿 26px ／ 卡内一级内容 42px（窄屏 16 ／ 32）', () => {
  for (const [viewport, gutter] of [[WIDE, STANDARD.wide], [NARROW, STANDARD.narrow]]) {
    const card = resolver.leftEdgeOuter([
      { file: 'css/platform.css', selector: '.platform-page' },
      { file: 'css/platform.css', selector: '.platform-section' },
    ], { viewport });
    const cardEdge = resolver.pageGutter({ viewport }) + card.edge;
    assert.equal(cardEdge, gutter, `卡片外沿是 ${cardEdge}px —— 应为 ${gutter}px`);

    const inner = resolver.leftEdge([
      { file: 'css/platform.css', selector: '.platform-page' },
      { file: 'css/platform.css', selector: '.platform-section' },
    ], { viewport });
    assert.equal(inner.edge, gutter + CARD_PAD, `卡内一级内容左边缘是 ${inner.edge}px —— 应为 ${gutter}＋${CARD_PAD}＝${gutter + CARD_PAD}px`);

    /* 嵌套一层再深 16px（嵌套卡片的内容在自己的层级上）。 */
    const nested = resolver.leftEdge([
      { file: 'css/platform.css', selector: '.platform-page' },
      { file: 'css/platform.css', selector: '.platform-section' },
      { file: 'css/platform.css', selector: '.platform-kpi' },
    ], { viewport });
    assert.equal(nested.edge, gutter + CARD_PAD * 2, `嵌套一层的左边缘是 ${nested.edge}px —— 应为 ${gutter}＋${CARD_PAD}×2＝${gutter + CARD_PAD * 2}px`);
  }
});

/* ───────────────────────── 工作台四排 ───────────────────────── */
test('⑥ 工作台四排的左基准是同一条（宽屏 42px ／ 窄屏 32px），且留白只由 L1 给', () => {
  const rows = [
    '顶部 KPI 排',
    '常用应用／最近流程',
    '业务概览',
    '协作',
  ];
  const chains = [
    [['css/platform.css', '.workbench-status'], ['css/platform.css', '.workbench-status>button']],
    [['css/platform.css', '.workbench-layout'], ['css/platform.css', '.platform-section'], ['css/platform.css', '.workbench-app-list>button']],
    [['css/platform.css', '.workbench-domain'], ['css/platform.css', '.platform-section'], ['css/platform.css', '.workbench-domain .platform-kpis']],
    [['css/platform.css', '.workbench-collaboration'], ['css/platform.css', '.platform-section'], ['css/platform.css', '.platform-quick-actions']],
  ];
  for (const [viewport, want] of [[WIDE, STANDARD.wide + CARD_PAD], [NARROW, STANDARD.narrow + CARD_PAD]]) {
    const edges = {};
    chains.forEach((chain, index) => {
      const computed = resolver.leftEdge(
        [{ file: 'css/platform.css', selector: '.platform-page' },
          ...chain.map(([file, selector]) => ({ file: file, selector }))],
        { viewport });
      edges[rows[index]] = computed.edge;
    });
    for (const [name, value] of Object.entries(edges)) {
      assert.equal(value, want, `${name} 的内容左边缘是 ${value}px —— 应为 ${want}px`);
    }
    assert.equal(new Set(Object.values(edges)).size, 1, `四排左边缘不一致：${JSON.stringify(edges)}`);
  }
});

test('⑦ 工作台四排**不再各带横向留白**（用户原话：「这样的 div 是有 margin 的，把 margin 去掉就行」）', () => {
  const rows = ['.workbench-status', '.workbench-layout', '.workbench-domain', '.workbench-collaboration'];
  for (const selector of rows) {
    for (const [viewport, label] of [[WIDE, '宽屏'], [NARROW, '窄屏']]) {
      const own = resolver.leftEdge([{ file: 'css/platform.css', selector }], { viewport });
      assert.equal(own.edge, 0,
        `${selector}（${label}）自己还带着 ${own.edge}px 的横向留白 —— `
        + '横向留白只能由统一的那一层（`.platform-page`）给，否则同一页里两套口径');
    }
  }
});

/* ───────────────────────── 例外：全屏工作区页 ───────────────────────── */
test('⑧ 例外：受管表页（`.objects-page`）是全屏工作区，自己占满整宽（登记在案的例外）', () => {
  const chain = resolver.leftEdge([
    { file: 'css/platform.css', selector: '.platform-page.objects-page' },
  ], { viewport: WIDE });
  assert.equal(chain.edge, 0,
    '受管表页吃了页面留白 ⇒ 全屏工作区不再全屏（例外必须真的例外）');
});
