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
 * FIX-48（用户 2026-10-20：「这个选择能不能变成弹窗……把弹窗作为公共组件，
 * 所有需要选择归属的都用它」）：Excel 清单页「新建 / 上传表格」面板里的归属，
 * 走的必须是**公共弹窗**（ui.dialog 出来的 <dialog class="os-dialog">），
 * 不是自己拼的下拉。
 *
 * 测试通过 = 下面全部成立：
 *  1. 归属面板里**没有原生 <select>**，只有一个触发按钮；
 *  2. 点触发按钮弹出的是**公共弹窗**（dialog.os-dialog），里面是两张选项卡；
 *  3. 选「本人」确定后，面板上显示的是**选中的归属**；
 *  4. 弹窗跟页面共用**同一个工作面**（Esc 只关最上层那扇，不越级）。
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
  const directory = mountDirectory(host, {
    ui,
    load: async () => ({entries, total: entries.length, truncated: false}),
    open: () => {}, upload: () => {}, create: () => {},
  });
  return {dom, w, host, ui, directory};
}

/* FIX-59（用户 2026-10-20 22:4x：「把图二的那个选项直接和图一的弹窗合并，放在文件归属下面」）：
   Excel 这一处**改成摊开式** —— 两张选项卡直接摊在「文件归属」下面，**不再叠第二扇窗**。
   ⇒ 断言的实质从「有一个触发按钮」改成「**直接给两张选项卡、没有触发按钮**」；
      「没有原生下拉」那条**一个字没动**。 */
it('归属是摊开式：没有原生下拉，直接是两张选项卡（不再有触发按钮）', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    /* 那块表单搬进**公共弹窗**了 ⇒ 它挂在 document 上（弹窗在 body 里），不在 host 里。 */
    const panel = t.w.document.querySelector('[data-resource-attribution]')!;
    assert.equal(panel.querySelectorAll('select').length, 0, '归属面板里还有原生下拉');
    const tabs = [...panel.querySelectorAll('[data-attribution-tab]')].map(x => (x.textContent || '').trim());
    assert.deepEqual(tabs, ['本人', '获权部门'], `摊开式该直接给两张选项卡，实际：${tabs.join('、') || '一张都没有'}`);
    assert.equal(panel.querySelectorAll('[data-attribution-trigger]').length, 0,
      '摊开式不该再有触发按钮（它就是那第二扇窗的入口）');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

/* FIX-59：摊开式里点选项卡**当场切档**（没有「确定」那一步了）
   ⇒ 断言的实质：「两张选项卡」「默认那档选中」「点一下就切档」「值落到隐藏 input 上」一条没少。 */
it('摊开式：点选项卡当场切档，选中的归属落到隐藏 input 上', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const panel = t.w.document.querySelector('[data-resource-attribution]')!;
    const tabs = [...panel.querySelectorAll('[data-attribution-tab]')];
    assert.equal(tabs.length, 2, `选项卡该是两张，实际 ${tabs.length} 张`);
    assert.equal(tabs.find(b => (b.textContent || '').includes('本人'))!.getAttribute('aria-selected'), 'true',
      '默认那档没选中');
    tabs.find(b => (b.textContent || '').includes('获权部门'))!.dispatchEvent(new t.w.Event('click'));
    assert.equal(tabs.find(b => (b.textContent || '').includes('获权部门'))!.getAttribute('aria-selected'), 'true',
      '点了那档没切过去');
    assert.equal(panel.querySelector('[data-attribution-level]')!.value, 'department',
      '选中的归属没落到隐藏 input 上');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});

/* FIX-59：摊开式**没有第二扇窗** ⇒ Esc 只该关「新建表格」那一扇（也不是越级关掉什么）。 */
it('摊开式不弹第二扇窗：Esc 只关「新建表格」那一扇', async () => {
  const t = mount();
  try {
    await t.directory.ready;
    (t.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    assert.equal(t.w.document.querySelectorAll('dialog').length, 1, '摊开式不该多出第二扇窗');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, 'Esc 没关掉「新建表格」弹窗');
  } finally { t.directory.dispose(); t.dom.window.close(); }
});
