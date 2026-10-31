import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountDirectory} from '../../../shangshu-web/js/domains/excel-univer/src/directory.ts';

/*
  FIX-53 —— Excel 清单页顶部那排「搜索表名 / 全部归属 / 清除筛选」的间距（用户 2026-10-20 17:0x）。

  用户原话：「**复用是对的，但是 padding 没有带过来，是有问题的**」＋ 一张截图
  （三个控件**紧挨在一起**，中间的间距不对）。

  根因：Excel 清单页（`directory.ts`）**照抄了文件中心的 markup**（`.file-tools` ＋
  `.file-search` ＋ `select` ＋ 按钮 ＋ 计数），**但没抄文件中心 JS 里那一步**：
  `file-center.js:35-37` 会把所有控件**收进一个 `.file-filter-row` div**。
  而 **`.file-tools` 自己的 `gap` 是 0**（`file-center.css:211`
  `.file-center-page .file-tools{padding-block:12px;gap:0}`）——
  间距是**内层 `.file-filter-row` 提供的**（`file-center.css:212` `gap:8px`）。
  ⇒ Excel 清单页少了这一层 ⇒ 三个控件直接贴在 `gap:0` 的 `.file-tools` 里 ⇒ 挤成一排。

  修法：让 Excel 清单页的 **DOM 结构与文件中心一致**（同样用 `.file-filter-row` 包装）——
  样式本来就是**公共的**（`.file-filter-row` 的规则在 `css/file-center.css` 里），
  所以**不是另写一套样式**，是让复用**真的落到结构上**。

  测试通过 = 下面全部成立：
  1. Excel 清单页的 `.file-tools` 里，**筛选控件都在 `.file-filter-row` 这一层里**
     （搜索框 / 归属下拉 / 清除筛选 / 计数）—— 缺这层就是没复用上；
  2. **文件中心与 Excel 清单页的筛选栏 DOM 结构一致**（同一个 `.file-tools > .file-filter-row`）；
  3. **护栏**：`.file-tools` 自己的 `gap` 仍是 0、`.file-filter-row` 的 `gap` 仍是 8px
     —— 间距**由内层提供**这条口径不许被改掉（否则文件中心自己会变形）；
  4. **护栏**：Excel 清单页的归属筛选**仍然是一个原生 `<select>`**
     —— 它是**筛选**（按归属筛选），不是「选择归属」，**不许**换成归属弹窗那套
     （FIX-52 那套是**选归属**用的，语义不同）。
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

const rows = Array.from({length: 3}, (_, i) => ({key: String(i), title: `表 ${i}`, kind: 'xlsx' as const}));

function mount() {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  mountDirectory(host, {load: async () => ({entries: rows, total: 3, truncated: false}), open: () => {}});
  return host;
}

it('FIX-53 Excel 清单页的筛选控件都在 .file-filter-row 这一层里（间距靠它提供）', () => {
  const host = mount();
  const tools = host.querySelector('.file-tools');
  assert.ok(tools, '找不到 .file-tools');
  const row = tools.querySelector(':scope > .file-filter-row');
  assert.ok(row,
    'Excel 清单页的 .file-tools 里**没有** .file-filter-row 这一层 —— '
    + '而 .file-tools 自己的 gap 是 0（间距由内层 .file-filter-row 提供，gap:8px）'
    + '⇒ 控件会挤成一排。文件中心是有的（file-center.js:35-37 会把它们收进去）。');
  for (const selector of ['.file-search', '[data-attribution-filter]', '[data-clear-filter]', '.file-count']) {
    assert.ok(row.querySelector(selector),
      `筛选控件 ${selector} 不在 .file-filter-row 里 —— 它跟别的控件贴在一起（gap:0）`);
  }
});

it('FIX-53 Excel 清单页与文件中心的筛选栏 DOM 结构一致（同一件复用）', () => {
  const host = mount();
  const tools = host.querySelector('.file-tools')!;
  const row = tools.querySelector(':scope > .file-filter-row')!;
  // 文件中心：`.file-tools` 的直接子节点**只有**那一行（`file-layouts` 之后被移走）。
  const directChildren = Array.from(tools.children).map(el => el.className);
  assert.deepEqual(directChildren, ['file-filter-row'],
    `.file-tools 的直接子节点应当只有 .file-filter-row 一层（现在：${JSON.stringify(directChildren)}）`);
  // 两边用的是**同一个**类名 ⇒ 公共样式（css/file-center.css 的 .file-filter-row 规则）直接生效。
  assert.ok(row.classList.contains('file-filter-row'));
});

it('FIX-53 护栏：间距由内层 .file-filter-row 提供，这条口径不许被改掉', () => {
  const css = read('shangshu-web/css/file-center.css');
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 只看**顶层**规则（媒体查询里的不算），并按「选择器完全相同」精确取，
  // 免得把 `.file-tools .file-directory-tools` 之类也当成 `.file-tools`。
  const topLevel = new Map<string, string>();
  for (const block of clean.split('}')) {
    const brace = block.indexOf('{');
    if (brace < 0) continue;
    const sel = block.slice(0, brace).split('}').pop()!.trim().replace(/\s+/g, ' ');
    if (!sel || sel.includes('@') || sel.includes('{')) continue;
    topLevel.set(sel, block.slice(brace + 1));
  }
  const tools = topLevel.get('.file-center-page .file-tools');
  const row = topLevel.get('.file-center-page .file-filter-row');
  assert.ok(tools, '找不到 .file-center-page .file-tools 的顶层规则');
  assert.ok(row, '找不到 .file-center-page .file-filter-row 的顶层规则');
  assert.match(tools, /gap:0/,
    '.file-tools 的 gap 应当仍是 0 —— 间距由内层 .file-filter-row 提供，'
    + '改这里会把文件中心自己的布局也弄乱');
  assert.match(row, /gap:8px/,
    '.file-filter-row 的 gap 应当仍是 8px —— 那才是控件之间真正的间距');
});

it('FIX-53 护栏：归属筛选仍是一个原生 <select>（它是筛选，不是「选择归属」）', () => {
  const host = mount();
  const filter = host.querySelector('[data-attribution-filter]');
  assert.ok(filter, '找不到按归属筛选的下拉');
  assert.equal(filter.tagName, 'SELECT',
    '「按归属筛选」是**筛选**（筛列表），不是**选归属**（决定这份东西归谁）—— '
    + '两者语义不同，不许换成归属弹窗那套（FIX-52 那套是选归属用的）');
});
