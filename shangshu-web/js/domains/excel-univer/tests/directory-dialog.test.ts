import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
// ⚠️ 域内判据要**从 shangshu-server 目录跑**（那里有 tsx）。
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {mountDirectory} from '../src/directory.ts';

/**
 * FIX-59（用户 2026-10-20 21:2x，附截图）：
 * > 「**如果你用浏览器点击新建，仍然会是这个样子**」
 *
 * 截图里 Excel 清单页点「新建」之后，「新建表格」那一块**摊在页面顶部**：
 * 表名输入框和「文件归属」挤在左上角、「取消/创建」在最右边，中间一大片空白。
 *
 * 主控已核实：**归属那部分是好的**（点「更改」会弹公共弹窗「选择文件归属」）⇒
 * 用户指的是**整个「新建表格」表单还是页面顶部一块**。
 *
 * 改法：改成**弹窗**（走公共 `ui.dialog`，与归属弹窗**同一个工作面** ——
 * 否则 Esc 会关错层，FIX-38 实踩过）。「上传表格」共用这块面板 ⇒ 一并改。
 *
 * 测试通过 = 下面全部成立：
 *  1. 点「新建」⇒ 出来的是**公共弹窗**（`dialog.os-dialog`），
 *     **不是**页面顶部一块（host 里那块面板 hidden / 不在页面里）；
 *  2. 弹窗里有：表名输入框、归属触发按钮、取消、创建；
 *  3. **Esc** ⇒ 弹窗关掉，回到列表（host 里**不留**那块表单）；
 *  4. 表名为空点「创建」⇒ 弹窗**不关**，并说「请输入表格名称」；
 *  5. 填了表名点「创建」⇒ 走 `create` 回调（表名 ＋ 归属都对）；
 *  6. **护栏**：归属触发点开的是**同一个工作面**里的公共弹窗 ——
 *     Esc **先关归属弹窗、再关新建弹窗**（不越级）；
 *  7. 上传表格：选完文件 ⇒ **也弹窗**（同一个弹窗形态）。
 */
function mount(entries: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  /* JSDOM 30 没有 showModal —— 自己补上，否则公共弹窗开不起来。 */
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.eval(readFileSync(new URL('../../../tool-workspace.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host') as HTMLElement;
  const ui = w.createToolWorkspace(host);
  const created: any[] = [];
  const uploaded: any[] = [];
  const directory = mountDirectory(host, {
    ui,
    load: async () => ({entries, total: entries.length, truncated: false}),
    open: () => {}, upload: (file, attribution) => { uploaded.push({file, attribution}); }, create: (name, attribution) => { created.push({name, attribution}); },
  });
  return {dom, w, host, ui, directory, created, uploaded};
}

/** 弹窗（公共弹窗）当前的这一扇。 */
const dialogOf = (w: any) => w.document.querySelector('dialog.os-dialog') as HTMLDialogElement | null;
const inDialog = (w: any, selector: string) => dialogOf(w)?.querySelector(selector) ?? null;

it('FIX-59 点「新建」⇒ 出来的是公共弹窗，不是页面顶部一块', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const dialog = dialogOf(t.w);
    assert.ok(dialog, '点「新建」没弹出公共弹窗（要 dialog.os-dialog）');
    assert.ok(dialog.hasAttribute('open'), '弹窗没打开');
    /* 页面里那块表单**不该再摊在页面上**。 */
    const inline = t.host.querySelector('[data-attribution-panel]') as HTMLElement | null;
    assert.ok(!inline || inline.hidden, '「新建表格」那块表单还摊在页面顶部（该进弹窗）');
    assert.ok(!t.host.querySelector('[data-attribution-name-input]'), '表名输入框还留在页面里');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 弹窗里有表名、归属、取消、创建', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const dialog = dialogOf(t.w);
    assert.ok(dialog, '没有弹窗');
    assert.ok(inDialog(t.w, '[data-attribution-name-input]'), '弹窗里没有表名输入框');
    /* FIX-59：归属是**摊开式** ⇒ 两张选项卡直接摊在「文件归属」下面（不再有触发按钮）。 */
    const attrTabs = [...(inDialog(t.w, '[data-resource-attribution]')?.querySelectorAll('[data-attribution-tab]') || [])]
      .map(x => (x.textContent || '').trim());
    assert.deepEqual(attrTabs, ['本人', '获权部门'], `弹窗里的归属选项不对：${attrTabs.join('、') || '一张都没有'}`);
    const labels = [...dialog.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    assert.ok(labels.includes('取消'), `弹窗里没有「取消」：${labels.join('、')}`);
    assert.ok(labels.includes('创建'), `弹窗里没有「创建」：${labels.join('、')}`);
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 Esc ⇒ 弹窗关掉，页面顶部不留那块表单', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    assert.ok(dialogOf(t.w), '没有弹窗');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 0, 'Esc 没关掉弹窗');
    const inline = t.host.querySelector('[data-attribution-panel]') as HTMLElement | null;
    assert.ok(!inline || inline.hidden, '弹窗关了，页面顶部却留了一块表单');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 表名为空点「创建」⇒ 弹窗不关，并说清要填表名', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const create = [...(dialogOf(t.w)?.querySelectorAll('button') || [])]
      .find(b => (b.textContent || '').trim() === '创建') as HTMLButtonElement;
    create.click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(dialogOf(t.w), '表名没填就把弹窗关了');
    const message = inDialog(t.w, '[data-attribution-error]')?.textContent || '';
    /* 产品的措辞是「请输入表格名称」⇒ 认「表名」或「表格名称」都算。 */
    assert.match(message, /表名|表格名称/, `没提示要填表名：${message}`);
    assert.equal(t.created.length, 0, '表名没填也建表了');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 填了表名点「创建」⇒ 走 create 回调（表名 ＋ 归属）', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const input = inDialog(t.w, '[data-attribution-name-input]') as HTMLInputElement;
    input.value = '我的新表';
    const create = [...(dialogOf(t.w)?.querySelectorAll('button') || [])]
      .find(b => (b.textContent || '').trim() === '创建') as HTMLButtonElement;
    create.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(t.created.length, 1, `没走 create 回调：${JSON.stringify(t.created)}`);
    assert.equal(t.created[0].name, '我的新表');
    assert.equal(t.created[0].attribution.level, 'personal');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 护栏：归属是摊开式 ⇒ 全程只有一扇窗（不叠第二扇）', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    assert.ok(dialogOf(t.w), '没有新建弹窗');
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 1, '摊开式不该多出第二扇窗');
    /* 点选项卡 ⇒ 仍是**一扇窗**（就地切档），不弹第二扇。 */
    const dept = [...(inDialog(t.w, '[data-resource-attribution]')?.querySelectorAll('[data-attribution-tab]') || [])]
      .find(x => (x.textContent || '').trim() === '获权部门') as HTMLElement;
    dept.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 1,
      '点归属选项又弹出一扇窗（摊开式不该叠第二扇）');
    assert.equal(inDialog(t.w, '[data-resource-attribution] [data-attribution-level]')?.value, 'department',
      '点完选项卡，归属值没落到隐藏 input 上');
    /* Esc ⇒ 只关「新建表格」那一扇。 */
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 0, 'Esc 没关掉新建弹窗');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

it('FIX-59 上传表格：选完文件 ⇒ 也弹窗（同一形态）', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    const input = t.host.querySelector('[data-upload-input]') as HTMLInputElement;
    /* 造一个文件塞进 input（浏览器里选文件后就是这个状态）。 */
    const file = new t.w.File(['xlsx'], '试用表.xlsx', {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    Object.defineProperty(input, 'files', {value: [file], configurable: true});
    input.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 30));
    const dialog = dialogOf(t.w);
    assert.ok(dialog, '选完文件没弹出上传弹窗');
    assert.ok(inDialog(t.w, '[data-attribution-file]'), '弹窗里没写出会上传哪个文件');
    const labels = [...dialog.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    /* 上传那一步的确认键，产品的措辞是「确认上传」。 */
    assert.ok(labels.includes('确认上传') || labels.includes('上传'), `弹窗里没有「确认上传」：${labels.join('、')}`);
  } finally { t.directory.dispose(); t.dom.window.close(); }
});
