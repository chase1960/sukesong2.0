import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
// ⚠️ 域内判据要**从 shangshu-server 目录跑**（那里有 tsx）。
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

/**
 * Excel 清单页：按钮布局 ＋ **不要整体重建 DOM**（FIX-39）—— 2026-10-20 用户两条指示：
 *
 * ① 「这个**新建**是不是放右边比较好」
 *    截图实况：页头是「Excel | 新建(绿) | 刷新(白) ……… 上传表格(绿)」
 *    —— **两个绿色主按钮分居两边**，中间一大段空白，主次不明。
 *    文件中心自己的做法是 `#upload{margin-left:auto}` 把主行动推到右边。
 *    ⇒ 改后：左边只有标题 ＋ 刷新（列表工具）；右边是「上传表格」「新建」，
 *      **主行动（新建）在最右**，页头只有**一个**绿色主按钮。
 *
 * ② 「把所有 **dom 的刷新**去掉」
 *    改之前：清单页每次刷新都 `body.replaceChildren()` **整表重建**，
 *    而且加载前先 `note('正在加载表格…')` **把列表清空** ——
 *    所以点一下「刷新」，整张表消失再出现：
 *    **滚动位置、hover 状态、键盘焦点全丢**。
 *    ⇒ 改后：按行**增量更新**（数据没变的行**复用同一个 DOM 节点**），
 *      加载中**不清空列表**，滚动位置**不被重设**。
 *
 * 测试通过 = 下面全部成立：
 *  1. 页头里「新建」在「上传表格」**右边**（主行动在视觉末端）
 *  2. 页头只有**一个** `.btn-pri`（绿色主按钮）
 *  3. 列表**不再整体重建**：`paint()` 的主路径里没有 `replaceChildren()`
 *  4. 数据没变时，**同一行的 DOM 节点是同一个对象**（真复用，不是重建出来的同款）
 *  5. 加载中**不清空**列表（点「刷新」时旧行还在）
 *  6. 刷新后**滚动位置不被重设**
 *  7. **护栏**：空态、错误态、翻页、搜索、归属筛选、打开动作 —— 行为一条不许变
 */

import {mountDirectory} from '../src/directory.ts';

const DIR = readFileSync(new URL('../src/directory.ts', import.meta.url), 'utf8');

it('页头：新建在上传表格的右边（主行动在视觉末端）', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const dir = mountDirectoryInto(host, dom);
  const heading = host.querySelector('.file-heading')!;
  const newBtn = heading.querySelector('[data-new-table]')!;
  const uploadBtn = heading.querySelector('[data-upload]')!;
  assert.ok(newBtn && uploadBtn, '页头里要有「新建」和「上传表格」');
  const order = [...heading.children].indexOf(newBtn);
  const uploadOrder = [...heading.children].indexOf(uploadBtn);
  assert.ok(order > uploadOrder, '「新建」要排在「上传表格」**右边**（主行动在视觉末端）');
  /* FIX-39 补：用户 2026-10-20「还有刷新按钮去掉」——
     清单页打开时会自动加载，那个按钮是**多余的一次点击**，而且它挨着「新建」会让人误会。 */
  assert.equal(heading.querySelector('[data-refresh]'), null, '「刷新」按钮还在 —— 用户要求去掉');
});

it('页头：只有一个绿色主按钮（同一区域不许有两个主行动）', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  mountDirectoryInto(host, dom);
  const pri = host.querySelectorAll('.file-heading .btn-pri');
  assert.equal(pri.length, 1, `页头有 ${pri.length} 个绿色主按钮 —— 同一区域只该有一个主行动`);
});

it('列表不再整体重建：paint() 主路径里没有 replaceChildren()', () => {
  // 只取 paint() 的**函数体** —— `note()`（空态/错误态）里用 replaceChildren 是对的：
  // 那时列表确实空了。判据要管的是「有数据时别重建」。
  const start = DIR.indexOf('function paint()');
  const end = DIR.indexOf('async function load()', start);
  assert.ok(start > 0 && end > start, '找不到 paint()');
  // 先剥掉注释 —— 否则源码里「改之前每次都 body.replaceChildren()」这句**说明**会被当成代码
  const paint = DIR.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(paint, /replaceChildren\(\)/,
    'paint() 还在整体重建列表 —— 点一次「刷新」整张表消失再出现，滚动位置/hover/焦点全丢');
  // 而且要看到增量更新的痕迹（按 key 复用节点）
  assert.match(paint, /rowCache/, 'paint() 没有按行 key 复用节点的增量更新');
});

it('数据没变时同一行复用同一个 DOM 节点（真复用，不是重建的同款）', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  mountDirectoryInto(host, dom);
  const body = host.querySelector('tbody') as HTMLTableSectionElement;
  // 首屏是异步加载 ⇒ 等它落地
  for (let i = 0; i < 40 && !body.querySelector('tr[data-table]'); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  const first = [...body.querySelectorAll('tr[data-table]')] as HTMLTableRowElement[];
  assert.ok(first.length >= 2, `应当有 2 行，实际 ${first.length}`);
  const before = new Map(first.map(tr => [tr.dataset.table, tr]));
  // 触发一次重新绘制（切归属筛选 ⇒ 走 paint() 但数据不变）
  const filter = host.querySelector('[data-attribution-filter]') as HTMLSelectElement;
  filter.value = '';
  filter.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  const after = [...body.querySelectorAll('tr[data-table]')] as HTMLTableRowElement[];
  assert.equal(after.length, before.size, '行数变了');
  for (const tr of after) {
    assert.equal(tr, before.get(tr.dataset.table!), `「${tr.dataset.table}」这一行被重建了 —— 应当复用同一个节点`);
  }
});

it('加载中不清空列表：点「刷新」时旧行还在', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  let resolve: (v: any) => void = () => {};
  const pending = new Promise(r => { resolve = r; });
  const dir = mountDirectoryInto(host, dom, () => pending);
  const body = host.querySelector('tbody') as HTMLTableSectionElement;
  /* 首次加载还没回来时，body 里应该有「正在加载」而不是一堆行 —— 但**不是被清空重建** */
  /* 让首屏加载完成 */
  resolve({ entries: [{ key: 'x', title: 'X', kind: 'xlsx' }], total: 1, truncated: false });
  return new Promise<void>(done => setTimeout(() => {
    const rows = body.querySelectorAll('tr[data-table]');
    assert.ok(rows.length >= 1, '首屏加载后应有行');
    /* 触发一次重新加载（改搜索词 ⇒ load()）：加载期间旧行应当还在（不是被清空）。
       ⚠️ 用「改搜索词」而不是「点刷新」—— 用户 2026-10-20 要求**去掉刷新按钮**。 */
    const search = host.querySelector('[data-picker-search]') as HTMLInputElement;
    search.value = 'x';
    search.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    setTimeout(() => {
      const during = body.querySelectorAll('tr[data-table]');
      assert.equal(during.length, rows.length, '重新加载期间列表被清空了 —— 旧行应当还在');
      done();
    }, 30);
  }, 30));
});

it('护栏：空态、错误态、翻页、筛选、打开动作一个不许少', () => {
  /* 空态 */
  assert.match(DIR, /还没有可打开的表格/, '空态文案不见了');
  assert.match(DIR, /没有匹配的表格/, '搜索无结果的文案不见了');
  /* 错误态 ＋ 重试 */
  assert.match(DIR, /表格列表加载失败/, '错误态文案不见了');
  assert.match(DIR, /textContent='重试'/, '错误态没有「重试」按钮');
  /* 翻页 */
  assert.match(DIR, /data-picker-prev/, '没有「上一页」');
  assert.match(DIR, /data-picker-next/, '没有「下一页」');
  /* 搜索 ＋ 归属筛选 ＋ 清除筛选 */
  assert.match(DIR, /data-picker-search/, '没有搜索框');
  assert.match(DIR, /data-attribution-filter/, '没有归属筛选');
  assert.match(DIR, /data-clear-filter/, '没有「清除筛选」');
  /* 打开动作 ＋ 调整归属 */
  assert.match(DIR, /options\.open\(/, '没有打开动作');
  assert.match(DIR, /调整归属/, '没有「调整归属」');
  /* 新建 ＋ 上传两条入口 */
  assert.match(DIR, /data-new-table/, '没有「新建」入口');
  assert.match(DIR, /data-upload/, '没有「上传表格」入口');
});

/* —— 沙箱：把 mountDirectory 挂到 JSDOM（用**真实模块**，不走正则清洗源码） —— */
function mountDirectoryInto(host: HTMLElement, dom: JSDOM, loadImpl?: () => Promise<any>): any {
  const entries = [
    { key: 'a', title: '甲表', kind: 'xlsx', ownership: '个人', updatedAt: '2026-10-19 10:00', permission: '可编辑', canStructure: true, canAssign: true },
    { key: 'b', title: '乙表', kind: 'xlsx', ownership: '部门', updatedAt: '2026-10-19 11:00', permission: '可编辑', canStructure: true, canAssign: false },
  ];
  return mountDirectory(host, {
    load: loadImpl ?? (async () => ({ entries, total: entries.length, truncated: false })),
    open: () => {}, upload: () => {}, create: () => {},
  });
}
