// 判据：工作台（工作台页）的**左右留白**＝参照系的 26px（用户 2026-10-22 15:21 截图批注：
// 「这个 padding 还没改」——指的是工作台顶部那三张卡「流程待办 1 / 我发起的流程 5 / 我的任务 0」那一排）。
//
// **测试通过 =**（一句话）
// 「工作台**四排**（顶部 KPI 排 / 常用应用・最近流程 / 业务概览 / 协作）的左右留白都是 **26px**
//   （窄屏 16px），与参照系（文件中心 `.file-table-area` 的 26px / 窄屏 16px）**同一个数**；
//   并且四排的**左基准线是同一条**（一级内容左边缘都落在 26＋16＝42px 上，窄屏 16＋16＝32px）——
//   也就是说：改完留白之后，顶部那三张卡的文字左边缘与下方「常用应用」等区块的内容左边缘**仍然对齐**。」
//
// ⚠️ **2026-10-22 PKG-029-T01：留白的来源改了一处** ——
//   以前工作台那四排**各自**带 26px（一排用 padding、三排用 margin ⇒ 两套机制），
//   现在横向留白**统一由页面根容器 `.platform-page` 给出**（L1），
//   四排自己**不再带任何横向留白**（用户原话：「这样的 div 是有 margin 的，把 margin 去掉就行」）。
//   ⇒ **算出来的左边缘不变**（仍是 26 / 42），只是「留白由谁给」换了人。
//
// ⚠️ **判据断的是「算出来的像素数」，不是「文件里有没有 26px 这几个字」**：
//   这里把 CSS **解析**出来（解析器做法见 `scripts/lib/css-cascade.mjs`，
//   与 `scripts/check-style-rules.mjs` 同一套思路），
//   再按 CSS 盒模型把每一层的 margin/padding 加起来，得出**每一排真实的左边缘**，
//   最后断言这四条左边缘**相等**且等于期望值。
//   ⇒ 以后谁把某一排改成 26px 却忘了改别的排（或反之），这条判据立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, sides, px } from '../../../scripts/lib/css-cascade.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);

const WIDE = 1440;
const NARROW = 600;
const NARROW_MEDIA = '@media(max-width:680px)';

/** 工作台四排：外层容器 ＋ 里面那一级（算内容左边缘要用）。 */
const ROWS = [
  ['顶部 KPI 排', ['.workbench-status', '.workbench-status>button']],
  ['常用应用／最近流程', ['.workbench-layout', '.platform-section', '.workbench-app-list>button']],
  ['业务概览', ['.workbench-domain', '.platform-section', '.workbench-domain .platform-kpis']],
  ['协作', ['.workbench-collaboration', '.platform-section', '.platform-quick-actions']],
];

const PLATFORM = 'css/platform.css';

/** 某排的**一级内容左边缘**（相对 `.main-scroll` 内容左边缘；`.main-scroll` 自己的 24px 另计）。 */
function workbenchLeftEdges(viewport) {
  const gutter = resolver.pageGutter({ viewport });
  const edges = {};
  for (const [name, chain] of ROWS) {
    const computed = resolver.leftEdge([
      { file: PLATFORM, selector: '.platform-page' },
      ...chain.map(selector => ({ file: PLATFORM, selector })),
    ], { viewport });
    edges[name] = computed.edge;
  }
  return { gutter, edges };
}

test('① 工作台四排**自己不再带横向留白**（留白只由统一的那一层 `.platform-page` 给）', () => {
  for (const [name, chain] of ROWS) {
    /* 只看**外层容器**：里面那一级的 16px 是**卡内内边距**（L3），不是留白。 */
    const own = resolver.leftEdge(
      [{ file: PLATFORM, selector: chain[0] }],
      { viewport: WIDE },
    );
    for (const viewport of [WIDE, NARROW]) {
      const computed = resolver.leftEdge(
        [{ file: PLATFORM, selector: chain[0] }],
        { viewport },
      );
      assert.equal(computed.edge, 0,
        `${name}（${viewport === WIDE ? '宽屏' : '窄屏'}）自己还带着 ${computed.edge}px 的横向留白 —— `
        + '横向留白只能由统一的那一层给，否则同一页里两套口径');
    }
    assert.ok(own);
  }
});

test('② 整页留白＝参照系的 26px（窄屏 16px）—— 工作台是跟着参照系走的，不是参照系跟着工作台走', () => {
  for (const [viewport, want] of [[WIDE, 26], [NARROW, 16]]) {
    const gutter = resolver.pageGutter({ viewport });
    assert.equal(gutter, want,
      `工作台整页留白是 ${gutter}px —— 应与参照系（文件中心 ${want}px）一致`);
  }
  /* 参照系本身仍是 26px（窄屏 16px） */
  const wide = resolver.resolve('.file-center-page .file-table-area', 'padding', { viewport: WIDE });
  assert.ok(wide, '参照系 `.file-table-area` 的 padding 声明不见了');
  assert.equal(px(sides(wide.value)[1]), 26, `参照系左右留白现在是 ${wide.value}`);
  const narrow = resolver.resolve('.file-center-page .file-table-area', 'padding', { viewport: NARROW });
  assert.ok(narrow, '参照系窄屏的 `.file-table-area` padding 声明不见了');
  assert.equal(px(sides(narrow.value)[1]), 16, `参照系窄屏左右留白现在是 ${narrow.value}`);
});

test('③ 改完留白后，工作台四排的左基准线仍是同一条（内容左边缘都落在 42px）', () => {
  const { edges } = workbenchLeftEdges(WIDE);
  for (const [name, value] of Object.entries(edges)) {
    assert.equal(value, 42, `${name} 的内容左边缘是 ${value}px —— 应为 26（整页留白）＋16（卡内内边距）＝42`);
  }
  assert.equal(new Set(Object.values(edges)).size, 1, `四排左边缘不一致：${JSON.stringify(edges)}`);
});

test('④ 窄屏下四排的左基准线也是同一条（32px）', () => {
  const { edges } = workbenchLeftEdges(NARROW);
  for (const [name, value] of Object.entries(edges)) {
    assert.equal(value, 32, `窄屏 ${name} 的内容左边缘是 ${value}px —— 应为 16＋16＝32`);
  }
  assert.equal(new Set(Object.values(edges)).size, 1, `窄屏四排左边缘不一致：${JSON.stringify(edges)}`);
});

test('⑤ 顶部三张卡的文字左边缘 ＝ 下方「常用应用」的内容左边缘（两者相等）', () => {
  const { edges } = workbenchLeftEdges(WIDE);
  assert.equal(edges['顶部 KPI 排'], edges['常用应用／最近流程'],
    '顶部 KPI 排的文字左边缘与「常用应用」的内容左边缘不相等 —— 左基准歪了');
  assert.equal(edges['顶部 KPI 排'], 42);
});
