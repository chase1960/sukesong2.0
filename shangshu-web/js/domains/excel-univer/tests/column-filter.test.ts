import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
// ⚠️ 域内判据要**从 shangshu-server 目录跑**（那里有 tsx）。
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {
  mergeColumnFilter,
  mountColumnFilterOverlay,
  openColumnFilterPanel,
  placeColumnFilterPanel,
  valueLabel,
  type ColumnFilterAnchor,
} from '../src/column-filter.ts';
import {emptyPersonalView, type PersonalView} from '../src/personal-view.ts';

/**
 * 列头筛选面板（FIX-54）—— 用户 2026-10-20 19:33：
 * 「b，就像excel一样，他是在列这边的一个小的弹窗，而现在的是居中的，有点不好操作，懂我意思吧」
 *
 * 面板从「居中的大弹窗（公共模态 `<dialog class="os-dialog">`）」改成
 * 「**贴在列头下面的小浮层**」。**内容一个字没改**（排序/筛选器/值清单/应用/清除），
 * 改的只是**怎么摆**。
 *
 * 测试通过 = 下面全部成立：
 *  1. 点列头那颗漏斗 ⇒ 出来的是**浮层**（**不是** `dialog.os-dialog` 那种居中模态），
 *     且浮层的**顶部**落在那颗漏斗按钮的**下方**、横向跟那一列对齐（**不居中**）；
 *  2. 点浮层**外面** ⇒ 浮层关掉；
 *  3. **Esc** ⇒ 只关浮层，**表格不动**（不碰筛选/排序，也不连带关别的东西）；
 *  4. 筛选行为**一条没变**：勾值真能筛、清除能恢复、排序真能改顺序；
 *  5. **护栏**：老四个 operator（包含/等于/为空/不为空）一个没少；
 *  6. 不可读的列：不给开面板，值清单也拿不到；
 *  7. 下方放不下 ⇒ 浮层**往上翻**（像 Excel 那样在列头上方展开）；
 *  8. 触发按钮的 `aria-haspopup`/`aria-expanded` 随开合更新。
 */

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

function mount() {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  /* JSDOM 30 没有 showModal —— 自己补上（别的判据还要它）。 */
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.eval(readFileSync(new URL('../../../tool-workspace.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host') as HTMLElement;
  const ui = w.createToolWorkspace(host);
  /* 域内模块用的是**全局 document**（生产环境就是页面的 document）——
     这里把全局指到 JSDOM 的 document，跑的是真代码。 */
  const saved = { document: (globalThis as any).document, window: (globalThis as any).window };
  (globalThis as any).document = w.document; (globalThis as any).window = w;
  return { dom, w, host, ui, restore() { (globalThis as any).document = saved.document; (globalThis as any).window = saved.window; } };
}

const FRAME = { clip: { left: 0, top: 28, width: 600, height: 400 }, headerRect: (index: number) => ({ left: index * 90, top: 0, width: 90, height: 28 }) };

/** 面板的选项（大部分判据共用）。 */
function panelOptions(overrides: Record<string, any> = {}) {
  return {
    column: { id: 'C1', label: '名称', readable: true },
    view: emptyPersonalView(),
    sortDirection: null as 'asc' | 'desc' | null,
    loadValues: async () => ({ column: 'C1', values: ['甲', '乙', '丙'], has_blank: false, total: 3, truncated: false }),
    applyFilter: async () => {},
    applySort: async () => {},
    clearFilter: async () => {},
    ...overrides,
  } as any;
}

/** 打开一个浮层面板，返回浮层元素。 */
function openPanel(t: any, options: any = panelOptions()) {
  const handle = openColumnFilterPanel(options);
  assert.ok(handle, '面板没开起来');
  return { handle, element: handle.element };
}

/* ——————— 1. 浮层，不是居中模态 ——————— */

it('点列头那颗漏斗 ⇒ 出来的是贴在列头下面的浮层（不是居中的模态弹窗）', async () => {
  const t = mount();
  try {
    let anchor: ColumnFilterAnchor | null = null;
    const overlay = mountColumnFilterOverlay(t.host, {
      frame: () => FRAME,
      columns: () => [{ id: 'C1', label: 'C1' }, { id: 'C2', label: 'C2' }, { id: 'C3', label: 'C3' }],
      marked: () => new Set(['C2']),
      panel: (columnId, at) => {
        anchor = at;
        return openColumnFilterPanel(panelOptions({ column: { id: columnId, label: 'C2', readable: true }, anchor: at }));
      },
    });
    overlay.refresh();
    await tick();
    const icons = [...t.host.querySelectorAll('.excel-column-filter-button')] as HTMLButtonElement[];
    assert.equal(icons.length, 1, `小图标该只有一个，实际 ${icons.length} 个`);
    assert.match(icons[0].getAttribute('aria-label') || '', /C2/, '小图标画在错的列上了');

    icons[0].dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
    await tick();

    /* ① 不是居中模态：整个页面里不该多出任何 <dialog>。 */
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, '面板用了居中模态弹窗（<dialog>）');
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 0, '面板用了公共弹窗（dialog.os-dialog）');
    const panel = t.w.document.querySelector('.excel-column-filter-pop') as HTMLElement;
    assert.ok(panel, '没出浮层面板');
    assert.equal(panel.tagName, 'DIV', '浮层不该是 <dialog>');
    assert.equal(panel.getAttribute('aria-modal'), 'false', '浮层不该是模态（aria-modal 要写 false）');
    /* 页面没被锁住（公共弹窗会把背景置 inert）。 */
    assert.equal(t.host.inert, undefined, '页面被锁住了（host 成了 inert）');
    assert.equal(t.w.document.querySelectorAll('[inert]').length, 0, '有元素被置 inert（页面被锁住了）');

    /* ② 浮层的顶部落在那颗漏斗按钮的**下方**，横向跟那一列对齐（不居中）。 */
    assert.ok(anchor, '面板没拿到锚点（漏斗按钮的位置）');
    const a = anchor as ColumnFilterAnchor;
    const top = parseFloat(panel.style.top), left = parseFloat(panel.style.left);
    assert.ok(top >= a.bottom - 1 && top <= a.bottom + 16, `浮层顶部(${top})没落在漏斗按钮下方(${a.bottom})附近`);
    assert.ok(Math.abs(left - a.left) <= 2, `浮层左边(${left})没跟那一列(${a.left})对齐`);
    assert.ok(Math.abs(left - t.w.innerWidth / 2) > 100, '浮层还是居中的（没贴在那一列边）');
    /* 浮层自己的位置也在那一列底下（不是散在页面中间）。 */
    assert.ok(left < a.left + 120, '浮层离那一列太远了');
    overlay.dispose();
  } finally { t.restore(); t.dom.window.close(); }
});

it('浮层里面该有的都有（排序/筛选器/值清单/应用/清除）', async () => {
  const t = mount();
  try {
    const { element } = openPanel(t);
    await tick();
    const labels = [...element.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    for (const label of ['升序', '降序', '应用筛选器', '清除筛选器']) assert.ok(labels.includes(label), `浮层里没有「${label}」`);
    assert.ok(element.querySelector('input[type="search"]'), '浮层里没有搜索框');
    assert.ok(element.querySelector('.excel-column-filter-all input[type="checkbox"]'), '浮层里没有「全选」');
    assert.ok(element.querySelector('.excel-column-filter-operator .excel-dropdown-trigger'), '浮层里没有筛选器条件行');
    const boxes = [...element.querySelectorAll('.excel-column-filter-value input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(boxes.length, 3, `值清单该有 3 项，实际 ${boxes.length} 项`);
    assert.deepEqual(boxes.map(b => b.dataset.value), ['甲', '乙', '丙']);
    /* 值清单里的**空白**单独归一档（显示成「(空白)」，存的是空字符串）。 */
    assert.equal(valueLabel(''), '(空白)');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 2. 点外面就关 ——————— */

it('点浮层外面 ⇒ 浮层关掉', async () => {
  const t = mount();
  try {
    const { element } = openPanel(t);
    await tick();
    assert.ok(element.isConnected, '浮层没开起来');
    t.w.document.body.dispatchEvent(new t.w.MouseEvent('pointerdown', { bubbles: true }));
    await tick();
    assert.equal(t.w.document.querySelectorAll('.excel-column-filter-pop').length, 0, '点了外面浮层没关');
  } finally { t.restore(); t.dom.window.close(); }
});

it('点浮层**里面** ⇒ 浮层不关', async () => {
  const t = mount();
  try {
    const { element } = openPanel(t);
    await tick();
    element.dispatchEvent(new t.w.MouseEvent('pointerdown', { bubbles: true }));
    await tick();
    assert.ok(element.isConnected, '点了浮层里面浮层反而关了');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 3. Esc 只关浮层，表格不动 ——————— */

it('Esc ⇒ 只关浮层，表格不动（不碰筛选/排序，也不关别的东西）', async () => {
  const t = mount();
  try {
    let touched = 0;
    const { element } = openPanel(t, panelOptions({
      applyFilter: async () => { touched++; },
      applySort: async () => { touched++; },
      clearFilter: async () => { touched++; },
    }));
    await tick();
    assert.ok(element.isConnected);
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    assert.equal(t.w.document.querySelectorAll('.excel-column-filter-pop').length, 0, 'Esc 没关掉浮层');
    assert.equal(touched, 0, 'Esc 动了表格（不该有筛选/排序/清除发生）');
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, 'Esc 之后冒出模态弹窗');
  } finally { t.restore(); t.dom.window.close(); }
});

it('浮层开着时按 Esc ⇒ 底下的筛选器下拉先收（不连带把浮层也关掉）', async () => {
  const t = mount();
  try {
    const { element } = openPanel(t);
    await tick();
    const trigger = element.querySelector('.excel-column-filter-operator .excel-dropdown-trigger') as HTMLButtonElement;
    trigger.click();
    await tick();
    assert.ok(t.w.document.querySelector('.excel-dropdown-menu:not([hidden])'), '筛选器下拉没展开');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    assert.equal(t.w.document.querySelectorAll('.excel-dropdown-menu:not([hidden])').length, 0, '下拉没收');
    assert.ok(element.isConnected, '下拉收的时候把浮层也关掉了');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 4. 筛选行为一条没变 ——————— */

it('勾两个值应用 ⇒ 这一列的条件是「值在这两个里」；清除 ⇒ 这一列没条件', async () => {
  const t = mount();
  try {
    const applied: any[] = []; let cleared = 0;
    const { element } = openPanel(t, panelOptions({
      applyFilter: async (filter: any) => { applied.push(filter); },
      clearFilter: async () => { cleared++; },
    }));
    await tick();
    const boxes = [...element.querySelectorAll('.excel-column-filter-value input[type="checkbox"]')] as HTMLInputElement[];
    boxes[0].checked = true; boxes[0].dispatchEvent(new t.w.Event('change', { bubbles: true }));
    boxes[2].checked = true; boxes[2].dispatchEvent(new t.w.Event('change', { bubbles: true }));
    const apply = [...element.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '应用筛选器') as HTMLButtonElement;
    apply.click();
    await tick();
    assert.equal(applied.length, 1, '点「应用筛选器」没有把条件交出去');
    assert.equal(applied[0].operator, 'in');
    assert.equal(applied[0].column, 'C1');
    assert.deepEqual(applied[0].value, ['甲', '丙']);
    assert.equal(t.w.document.querySelectorAll('.excel-column-filter-pop').length, 0, '应用完浮层没关');

    /* 清除：这一列的条件被去掉。 */
    const second = openColumnFilterPanel(panelOptions({
      column: { id: 'C1', label: '名称', readable: true },
      view: { filters: [{ column: 'C1', operator: 'in', value: ['甲', '丙'] }], freeze: { rows: 0, columns: 0 } },
      applyFilter: async (filter: any) => { applied.push(filter); },
      clearFilter: async () => { cleared++; },
    }));
    await tick();
    const clear = [...second.element.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '清除筛选器') as HTMLButtonElement;
    clear.click();
    await tick();
    assert.equal(cleared, 1, '点「清除筛选器」没有清除');
  } finally { t.restore(); t.dom.window.close(); }
});

it('排序两枚真能改顺序，再点一次取消', async () => {
  const t = mount();
  try {
    const sorts: any[] = [];
    const { element } = openPanel(t, panelOptions({ applySort: async (direction: any) => { sorts.push(direction); } }));
    await tick();
    const asc = [...element.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '升序') as HTMLButtonElement;
    asc.click();
    await tick();
    assert.deepEqual(sorts, ['asc'], '点「升序」没排');
    assert.equal(asc.getAttribute('aria-pressed'), 'true', '升序按钮没标成按下态');
    asc.click();
    await tick();
    assert.deepEqual(sorts, ['asc', null], '再点一次「升序」没有取消排序');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 5. 护栏：老四个 operator 一个没少 ——————— */

it('护栏：老四个 operator 一个没少，条件行的形状也没变', async () => {
  const t = mount();
  try {
    const applied: any[] = [];
    const { element } = openPanel(t, panelOptions({ applyFilter: async (filter: any) => { applied.push(filter); } }));
    await tick();
    /* 条件行用的下拉里，老四个都在（包含/等于/为空/不为空）。 */
    const trigger = element.querySelector('.excel-column-filter-operator .excel-dropdown-trigger') as HTMLButtonElement;
    assert.ok(trigger, '条件行没有匹配方式下拉');
    trigger.click();
    await tick();
    const items = [...t.w.document.querySelectorAll('.excel-dropdown-menu .excel-dropdown-item')].map(i => (i.textContent || '').trim());
    for (const label of ['包含', '等于', '为空', '不为空']) assert.ok(items.some(item => item.includes(label)), `条件行里没有「${label}」`);
    /* 老四个的条件形状没变：{column,operator,value}，value 是字符串。 */
    const input = element.querySelector('.excel-column-filter-criteria input') as HTMLInputElement;
    input.value = '原';
    input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    const apply = [...element.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '应用筛选器') as HTMLButtonElement;
    apply.click();
    await tick();
    assert.equal(applied[0].operator, 'contains');
    assert.equal(applied[0].value, '原');
    assert.equal(typeof applied[0].value, 'string');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 6. 不可读的列 ——————— */

it('不可读的列：不给开面板，值清单也拿不到', async () => {
  const t = mount();
  try {
    let loaded = 0;
    const opened = openColumnFilterPanel(panelOptions({
      column: { id: 'C1', label: '名称', readable: false },
      loadValues: async () => { loaded++; return { column: 'C1', values: ['甲'], has_blank: false, total: 1, truncated: false }; },
    }));
    await tick();
    assert.equal(opened, null, '不可读的列竟然开了面板');
    assert.equal(t.w.document.querySelectorAll('.excel-column-filter-pop').length, 0, '不可读的列弹了浮层');
    assert.equal(loaded, 0, '不可读的列去取了值清单');
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 7. 下方放不下就往上翻 ——————— */

it('下方放不下 ⇒ 浮层往上翻（像 Excel 那样在列头上方展开）', () => {
  const anchor = { left: 300, top: 700, right: 318, bottom: 718, width: 18, height: 18 };
  const viewport = { width: 1600, height: 800 };
  /* 面板 400px 高：下方只剩 800-718-12 = 70px，放不下；上方有 700px，够。 */
  const up = placeColumnFilterPanel(anchor, { width: 280, height: 400 }, viewport);
  assert.equal(up.up, true, '下方放不下却没往上翻');
  assert.ok(up.top + 400 <= anchor.top + 1, `翻上去的面板压住了列头（底 ${up.top + 400} > 顶 ${anchor.top}）`);
  /* 下方够放 ⇒ 就在下方，顶部贴着漏斗按钮的底。 */
  const down = placeColumnFilterPanel({ left: 300, top: 100, right: 318, bottom: 118, width: 18, height: 18 }, { width: 280, height: 400 }, viewport);
  assert.equal(down.up, false, '下方够放却翻上去了');
  assert.equal(down.top, 122, '浮层顶部没贴着漏斗按钮的底');
  /* 两边都放不下 ⇒ 内部滚动（限高），不能跑到视口外。 */
  const tight = placeColumnFilterPanel({ left: 300, top: 380, right: 318, bottom: 398, width: 18, height: 18 }, { width: 280, height: 900 }, { width: 1600, height: 800 });
  assert.ok(tight.maxHeight < 900, '两下都放不下时没有限高（内容会溢出屏幕）');
  assert.ok(tight.top >= 0 && tight.top + tight.maxHeight <= 800, '限高后仍跑出视口');
});

/* ——————— 8. 可访问性 ——————— */

it('触发按钮的 aria 随开合更新，浮层里的按钮有可读名字', async () => {
  const t = mount();
  try {
    let handle: any = null;
    const overlay = mountColumnFilterOverlay(t.host, {
      frame: () => FRAME,
      columns: () => [{ id: 'C1', label: 'C1' }],
      marked: () => new Set(['C1']),
      panel: (columnId, at) => (handle = openColumnFilterPanel(panelOptions({ column: { id: columnId, label: 'C1', readable: true }, anchor: at }))),
    });
    overlay.refresh();
    await tick();
    const button = t.host.querySelector('.excel-column-filter-button') as HTMLButtonElement;
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog', '漏斗按钮没标 aria-haspopup');
    assert.equal(button.getAttribute('aria-expanded'), 'false', '漏斗按钮初始该是收着的');
    button.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(button.getAttribute('aria-expanded'), 'true', '浮层开了，aria-expanded 没跟上');
    /* 浮层里的按钮都要有可读名字（文字或 aria-label）。 */
    const panel = t.w.document.querySelector('.excel-column-filter-pop') as HTMLElement;
    for (const b of [...panel.querySelectorAll('button')] as HTMLButtonElement[]) {
      const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
      assert.ok(name, '浮层里有个按钮没有可读名字');
    }
    /* 键盘：浮层开着时焦点落在浮层里（Tab 能走到面板里）。 */
    assert.ok(panel.contains(t.w.document.activeElement), '浮层开了但焦点没进去');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    assert.equal(button.getAttribute('aria-expanded'), 'false', '浮层关了，aria-expanded 没改回来');
    overlay.dispose();
  } finally { t.restore(); t.dom.window.close(); }
});

/* ——————— 9. 并进整份个人视图（纯函数，没变） ——————— */

it('并进整份个人视图：别的列的条件原样留着，同一列只留一条', () => {
  const view: PersonalView = {
    filters: [{ column: 'C1', operator: 'contains', value: 'x' }, { column: 'C2', operator: 'equals', value: 'y' }],
    freeze: { rows: 1, columns: 0 },
  };
  const merged = mergeColumnFilter(view, 'C1', { column: 'C1', operator: 'in', value: ['甲'] });
  assert.equal(merged.filters.length, 2, '别的列的条件被弄丢了');
  assert.deepEqual(merged.filters[0], { column: 'C1', operator: 'in', value: ['甲'] });
  assert.deepEqual(merged.filters[1], { column: 'C2', operator: 'equals', value: 'y' });
  assert.deepEqual(merged.freeze, { rows: 1, columns: 0 }, '冻结被弄丢了');
  const cleared = mergeColumnFilter(view, 'C1', null);
  assert.equal(cleared.filters.length, 1, '这一列的条件没被去掉');
  assert.equal(cleared.filters[0].column, 'C2');
});

/* ——————— 10. FIX-58（用户 2026-10-20 21:2x）：「值」区块下面那句提示删掉 ——————— */

/*
 用户原话：
   「勾中的值就是要留下的行。全选＝这一列不按值筛 把这个删除」
 ⇒ 删的是**「值」这一个区块下面那一句提示**。

 **测试通过 = 下面全部成立**：
   1. 浮层里**不再出现**「勾中的值就是要留下的行」；
   2. 浮层里**不再出现**「全选＝这一列不按值筛」；
   3. **「值」区块本身还在**（标题 ＋ 搜索框 ＋ 全选 ＋ 值清单）——
      只删那句话，**不许把区块删了**；
   4. **护栏**：排序／筛选器两段的提示**照旧**（用户只让删「值」这一段）。
 */
it('FIX-58「值」区块下面那句提示删掉了，区块本身和另外两段的提示照旧', async () => {
  const t = mount();
  try {
    const { element } = openPanel(t);
    await tick();
    const text = (element.textContent || '').replace(/\s+/g, ' ');
    assert.ok(!text.includes('勾中的值就是要留下的行'),
      `浮层里还留着「勾中的值就是要留下的行」：${text.slice(0, 200)}`);
    assert.ok(!text.includes('全选＝这一列不按值筛'),
      `浮层里还留着「全选＝这一列不按值筛」：${text.slice(0, 200)}`);

    /* 「值」区块还在，只是没了那句话。 */
    const blocks = [...element.querySelectorAll('.excel-column-filter-block')] as HTMLElement[];
    const valueBlock = blocks.find(b => (b.querySelector('h4')?.textContent || '').trim() === '值');
    assert.ok(valueBlock, '浮层里没有「值」区块');
    assert.ok(valueBlock.querySelector('input[type="search"]'), '「值」区块里的搜索框没了');
    assert.ok(valueBlock.querySelector('.excel-column-filter-all input[type="checkbox"]'), '「值」区块里的「全选」没了');
    const boxes = [...valueBlock.querySelectorAll('.excel-column-filter-value input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(boxes.length, 3, `「值」区块的值清单该有 3 项，实际 ${boxes.length} 项`);

    /* 护栏：另外两段的提示照旧（用户只让删「值」这一段）。 */
    assert.ok(text.includes('按这一列排'), '排序那段的提示被误删了');
    assert.ok(text.includes('一行就是'), '筛选器那段的提示被误删了');
  } finally { t.restore(); t.dom.window.close(); }
});
