import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountResourceAttribution} from '../../../shangshu-web/js/resource-attribution.mjs';
import {installToast} from '../helpers/toast.ts';
// ⚠️ 2026-10-30（PKG-133）：`file-center.js` 里读文件列表用的「一次读一个作用域」是
//   **动态 import 的 ESM**（`import('./lib/latest-read.mjs')`）—— JSDOM 的 eval 里 import 不了
//   ⇒ 读列表那条路直接炸 ⇒ 文件中心停在「交互样例」模式 ⇒ **上传对话框根本不弹**。
//   仓库里已有这个口子（tests/helpers/browser-module-fixtures.ts，别的文件中心判据都在用）。
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';

/*
  FIX-48（用户 2026-10-20 14:07，配图是 Excel「新建表格」对话框里的「文件归属：本人 ▼」）：
  「这个选择能不能变成弹窗……把弹窗作为公共组件，所有需要选择归属的都用它」。

  PKG-016（用户 2026-10-21，看试用站文件中心提的）：
  「这个分类弹窗问题，我记得还有一些部分有，统一一下吧，**不要用重叠弹窗，直接摊出来**」。

  ⇒ 公共组件**只剩摊开一种形态**：两张选项卡（本人／获权部门）直接摊在宿主里，
    **不弹第二扇窗**。原来的「点触发按钮 → 弹一扇『选择归属』」那个分支整个删掉了。

  测试通过 = 下面全部成立：
  1. 挂上公共组件就**直接摊开两张选项卡**（本人／获权部门），宿主里**没有原生 <select>**，
     **没有触发按钮**，也**不会自己弹窗**；
  2. 选「获权部门」后就地出现**部门选择**；**挑中即生效**（摊开式没有「确定」那一步）；
  3. 选「本人」后读出来的值是 personal（不带的部门字段）；
  4. **嵌套场景**（文件中心「上传文件」那种外层对话框）里，归属**不再叠第二扇窗**，
     Esc 也不会连带关掉外层那扇；
  5. **四处**（Excel 新建/上传、文件中心上传、清单页调整归属、邮箱设置）
     **用的是同一件公共组件**（同一个 resource-attribution.mjs）。
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/** JSDOM 30 没有 showModal/close —— 自己补上（补完才算原生 dialog 能开能关）。 */
function patchDialog(w: any) {
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
}

function boot(html = '<div id="host"></div>') {
  const dom = new JSDOM(html, {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  patchDialog(w);
  w.eval(read('shangshu-web/js/tool-workspace.js'));
  return {dom, w, host: w.document.querySelector('#host')};
}

function mountIn(t: ReturnType<typeof boot>, options: any = {}) {
  const ui = t.w.createToolWorkspace(t.host);
  const picker = mountResourceAttribution(t.host, {ui, ...options});
  return {ui, picker};
}

/** 最上层那扇公共弹窗（嵌套时外层也是 .os-dialog，取最后一个）。 */
const dialogOf = (w: any) => {
  const all = [...w.document.querySelectorAll('dialog.os-dialog')];
  return all[all.length - 1];
};
const tabByText = (root: any, text: string) =>
  [...root.querySelectorAll('[data-attribution-tab]')].find((b: any) => String(b.textContent || '').includes(text)) as any;

it('公共组件摊开就绪：两张选项卡，没有原生下拉，没有触发按钮，不弹窗', () => {
  const t = boot();
  try {
    const {picker} = mountIn(t);
    assert.equal(t.host.querySelectorAll('select').length, 0, '宿主一开始就带原生下拉');
    const tabs = [...t.host.querySelectorAll('[data-attribution-tab]')];
    assert.equal(tabs.length, 2, `选项卡该是两张（本人/获权部门），实际 ${tabs.length} 张`);
    assert.match(tabs[0].textContent || '', /本人/, '第一张选项卡不是「本人」');
    assert.match(tabs[1].textContent || '', /获权部门/, '第二张选项卡不是「获权部门」');
    assert.equal(t.host.querySelectorAll('[data-attribution-trigger]').length, 0,
      '还有触发按钮（那就是要再弹第二扇窗的入口）');
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, '挂上组件就自己弹了一扇窗');
    void picker;
  } finally { t.dom.window.close(); }
});

it('选「获权部门」后就地出现部门选择；挑中即生效（没有「确定」那一步）', () => {
  const t = boot();
  try {
    const {picker} = mountIn(t, {departments: [{value: 'dep-1', label: '市场部'}], departmentSource: 'provided'});
    tabByText(t.host, '获权部门').click();
    const option = t.host.querySelector('[data-attribution-dept-value="dep-1"]');
    assert.ok(option, '选「获权部门」后没出现部门可选');
    assert.match(option.textContent || '', /市场部/, '部门项没显示部门名');
    option.click();
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, '挑部门时又弹了一扇窗');
    assert.deepEqual(picker.read(), {ok: true, value: {level: 'department', department: 'dep-1'}});
  } finally { t.dom.window.close(); }
});

it('选「本人」后读出来的值是 personal（不带的部门字段）', () => {
  const t = boot();
  try {
    const {picker} = mountIn(t, {defaultLevel: 'personal'});
    tabByText(t.host, '本人').click();
    assert.deepEqual(picker.read(), {ok: true, value: {level: 'personal'}});
  } finally { t.dom.window.close(); }
});

it('嵌套场景（外层「上传文件」对话框）：归属不再叠第二扇窗，Esc 不关外层', () => {
  const t = boot();
  try {
    const ui = t.w.createToolWorkspace(t.host);
    const outer = ui.modal(
      '<form><header><h2>上传文件</h2></header><main><div data-resource-attribution></div></main></form>',
      {native: true, className: 'file-operation-dialog'});
    mountResourceAttribution(outer.querySelector('[data-resource-attribution]'), {ui});
    assert.equal(t.w.document.querySelectorAll('dialog').length, 1, '归属又叠了第二扇窗');
    assert.equal(outer.querySelectorAll('[data-attribution-tab]').length, 2, '外层对话框里没有摊开两张选项卡');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, 'Esc 之后那扇窗还没关');
    assert.equal(t.w.document.querySelectorAll('dialog').length, 0, 'Esc 把外层「上传文件」对话框也关了');
  } finally { t.dom.window.close(); }
});

it('四处选归属的地方用的是同一件公共组件 resource-attribution.mjs', () => {
  const places = {
    'Excel 清单页新建/上传': 'shangshu-web/js/domains/excel-univer/src/directory.ts',
    '文件中心上传文件': 'shangshu-web/js/file-center.js',
    'Excel 清单页调整归属': 'shangshu-web/js/resource-assignment.js',
    '邮箱设置归属': 'shangshu-web/js/domains/mail/mail-settings.js',
  };
  for (const [name, file] of Object.entries(places)) {
    const source = read(file);
    assert.match(source, /resource-attribution\.mjs/, `${name} 没走公共件 resource-attribution.mjs`);
    /* 注意：清单页那个 data-attribution-filter 是**筛选**，不是选归属，按约定不许动。 */
    assert.doesNotMatch(source, /<select[^>]*data-attribution-(?:level|department)\b/, `${name} 还留着原生归属下拉`);
    /* PKG-016：不再有「摊开／叠窗」两种形态的开关 —— 尤其不许 inline:false 退回叠窗。 */
    assert.doesNotMatch(source, /inline\s*:\s*false/, `${name} 还留着退回叠窗的开关`);
  }
});

it('文件中心「上传文件」对话框里归属直接摊开，不再弹第二扇窗', async () => {
  const component = (await import('../../../shangshu-web/js/resource-attribution.mjs')).mountResourceAttribution;
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost', runScripts: 'outside-only'});
  const w = dom.window as any;
  patchDialog(w);
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.__attributionComponent = {mountResourceAttribution: component};
  w.fetch = async (url: string) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/datasets/') ? {rows: [], total: 0} : {directories: [], can_manage: false}),
  });
  installToast(w);
  for (const file of ['tool-workspace', 'file-detail', 'record-reference-picker', 'file-center']) {
    /* JSDOM 里 dynamic import 走不了浏览器路径 —— 换成同一件组件的异步取值，
       保留生产时序（先 await 再读文件列表）。 */
    w.eval(browserModuleSource(w,read(`shangshu-web/js/${file}.js`).replace(
      "await import('./resource-attribution.mjs')",
      'await Promise.resolve().then(()=>window.__attributionComponent)')));
  }
  const controller = new w.AbortController();
  try {
    w.mountFileCenter(w.document.querySelector('#host'), {signal: controller.signal});
    await new Promise(r => setTimeout(r, 30));
    const picker = w.document.querySelector('#file-picker') as HTMLInputElement;
    const file = {name: '说明.txt', size: 10, type: 'text/plain'};
    const files: any = {0: file, length: 1, item: (i: number) => (i === 0 ? file : null)};
    files[Symbol.iterator] = function* () { for (let i = 0; i < files.length; i++) yield files[i]; };
    Object.defineProperty(picker, 'files', {value: files, configurable: true});
    Object.defineProperty(picker, 'value', {get: () => '', set: () => {}, configurable: true});
    picker.dispatchEvent(new w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 30));
    const outer = w.document.querySelector('dialog.file-operation-dialog');
    assert.ok(outer, '文件中心「上传文件」对话框没打开');
    assert.equal(outer.querySelectorAll('select[data-attribution-level],select[data-attribution-department]').length, 0,
      '上传对话框里还有原生归属下拉');
    assert.equal(outer.querySelectorAll('[data-attribution-trigger]').length, 0,
      '上传对话框里还有归属触发按钮（那就是要再弹第二扇窗的入口）');
    assert.equal(outer.querySelectorAll('[data-attribution-tab]').length, 2,
      '归属的两张选项卡没有直接摊在「上传文件」对话框里');
    assert.equal(w.document.querySelectorAll('dialog').length, 1, '归属又叠了第二扇窗');
  } finally { controller.abort(); dom.window.close(); }
});

it('运行时三处都是摊开式（Excel 面板 / 调整归属 / 邮箱设置）', async () => {
  /* 经典脚本（resource-assignment.js / mail-settings.js）在 JSDOM 里没法 dynamic
     import 浏览器路径 —— 按公共件留的口子，把同一件组件注入进去。 */
  const component = (await import('../../../shangshu-web/js/resource-attribution.mjs')).mountResourceAttribution;

  // —— Excel 清单页「新建」面板 ——
  const excel = boot();
  const oldWindow = (globalThis as any).window;
  try {
    const {mountDirectory} = await import('../../../shangshu-web/js/domains/excel-univer/src/directory.ts');
    (globalThis as any).window = excel.w;
    const oldFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ok: true, json: async () => ({rows: [], total: 0})}) as any;
    const ui = excel.w.createToolWorkspace(excel.host);
    const directory = mountDirectory(excel.host, {
      ui, load: async () => ({entries: [], total: 0, truncated: false}), open() {}, upload() {},
    });
    await directory.ready;
    (excel.host.querySelector('[data-new-table]') as HTMLButtonElement).click();
    const excelDialog = dialogOf(excel.w);
    assert.ok(excelDialog, 'Excel「新建表格」没弹出公共弹窗');
    const excelTabs = [...excelDialog.querySelectorAll('[data-resource-attribution] [data-attribution-tab]')];
    assert.equal(excelTabs.length, 2, 'Excel 面板的选项卡数量不对');
    assert.equal(excel.w.document.querySelectorAll('dialog.os-dialog').length, 1,
      'Excel 这处不该再弹第二扇窗');
    assert.equal(excelDialog.querySelectorAll('[data-resource-attribution] select').length, 0,
      'Excel 归属里不该有原生下拉');
    directory.dispose();
  } finally {
    (globalThis as any).window = oldWindow;
    excel.dom.window.close();
  }

  // —— 清单页「调整归属」弹窗 ——
  const assign = boot();
  try {
    assign.w.mountResourceAttribution = component;
    assign.w.fetch = async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/services/')
        ? {ok: true, people: [{user_name: 'a@x', display_name: '甲'}], groups: [{department_id: 'dep', department_name: '部门甲'}]}
        : {ok: true, result: {}}),
    });
    assign.w.eval(read('shangshu-web/js/resource-assignment.js'));
    await assign.w.openResourceAssignment({host: assign.host, resource: 'f1', title: '测试表', onSaved: async () => {}});
    await new Promise(r => setTimeout(r, 20));
    const dialog = dialogOf(assign.w);
    assert.ok(dialog, '调整归属弹窗没打开');
    assert.equal(dialog.querySelectorAll('[data-attribution-tab]').length, 2, '调整归属的选项卡数量不对');
    assert.equal(assign.w.document.querySelectorAll('dialog').length, 1, '调整归属又叠了第二扇窗');
  } finally { assign.dom.window.close(); }

  // —— 邮箱设置页 ——
  const mail = boot('<div id="host"></div>');
  try {
    mail.w.RENDER = {};
    mail.w.shangshuRegisterPages = () => ({ok: true});
    mail.w.shangshuRegisterNav = () => {};
    mail.w.mountResourceAttribution = component;
    mail.w.fetch = async () => ({ok: true, json: async () => ({result: {account: {bound: false}}})});
    mail.w.eval(read('shangshu-web/js/domains/mail/mail-settings.js'));
    await mail.w.mountMailSettings(mail.host);
    await new Promise(r => setTimeout(r, 20));
    const tabs = [...mail.w.document.querySelectorAll('[data-resource-attribution] [data-attribution-tab]')];
    assert.equal(tabs.length, 2, '邮箱设置的选项卡数量不对');
    /* 邮箱设置现在住在**一扇弹窗**里（`.os-dialog`，2026-10-21 用户点名改的）——
       「归属不叠第二扇窗」这条口径**不变**：弹窗数应当**恰好是 1**（邮箱设置自己那扇），
       归属的选项卡**就在那扇窗里面**（不是另开一扇）。 */
    const mailDialogs = mail.w.document.querySelectorAll('dialog');
    assert.equal(mailDialogs.length, 1, `邮箱设置的归属又叠了第二扇窗（当前弹窗数 ${mailDialogs.length}）`);
    assert.ok(mailDialogs[0].querySelector('[data-resource-attribution]'),
      '归属的选项卡不在邮箱设置那扇窗里 —— 那就变成另开一扇了');
    // 邮箱的「所属部门」是手填，不是从列表里挑
    tabByText(mail.w.document.querySelector('[data-resource-attribution]')!, '部门邮箱').click();
    const text = mail.w.document.querySelector('[data-attribution-text]');
    assert.ok(text, '邮箱的所属部门该是手填框');
    /* 摊开式没有「确定」那一步 ⇒ 手填的值当场落到隐藏 input 上。 */
    (text as HTMLInputElement).value = '市场部';
    (text as HTMLInputElement).dispatchEvent(new mail.w.Event('input', {bubbles: true}));
    assert.equal(mail.w.document.querySelector('#mail-account-department').value, '市场部',
      '手填的所属部门没落到隐藏 input 上（保存会带空部门）');
  } finally { mail.dom.window.close(); }
});
