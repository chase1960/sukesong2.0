import * as attributionModule from '../../../shangshu-web/js/resource-attribution.mjs';
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
  用户 2026-10-21 看试用站文件中心提的四条：
  ①「也可以将文件拖到这里上传」那块**常驻**提示区不要了 —— 改成**有文件拖进来才出现**的整页遮罩，
    松开即上传；
  ②「上传文件」弹窗里的「文件归属」不要点「选择」再弹**第二扇窗**，要像「新建表格」那样
    **把归属选项直接摊在弹窗里**；
  ③ 弹窗底部那句「同目录同名普通文件会新增版本…」**删掉**；
  ④ 这类叠窗弹窗**全站统一** —— 不要叠窗，直接摊出来。

  本文件把①–⑤钉成**可观察行为**（不钉实现写法）：
  · 页面文字 / 元素在不在；
  · 拖入 → 遮罩出现、松手 → 遮罩消失且上传流程启动；
  · 上传弹窗里有没有那两张选项卡、有没有多出第二扇窗。

  跑法：node --import tsx --test tests/website/file-center-drop-and-inline-attribution.test.ts
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const response = (value: unknown, status = 200) =>
  ({ok: status < 400, status, json: async () => value, text: async () => String(value)});

/** 部门数据集：给「获权部门」那档一个能选的东西。 */
const DEPARTMENTS = {rows: [{name: 'dep-a', title: '市场部', enabled: true}], total: 1};

function mount(fetch: (url: string, options?: any) => Promise<any>) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.attributionModule = attributionModule;
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.fetch = fetch;
  installToast(w); /* 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast */
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  for (const file of ['tool-workspace', 'file-detail', 'record-reference-picker', 'file-center']) {
    w.eval(browserModuleSource(w,read(`shangshu-web/js/${file}.js`)
      .replace("await import('./resource-attribution.mjs')", 'window.attributionModule')));
  }
  const controller = new w.AbortController();
  w.mountFileCenter(w.document.querySelector('#host'), {signal: controller.signal});
  return {w, dom, controller};
}

/** 默认后台：真模式（会话可读、目录可读、列表为空）。 */
const backend = async (url: string) => {
  if (url === '/api/session') return response({user: {username: 'worker'}});
  if (url.includes('platform.department')) return response(DEPARTMENTS);
  if (url.includes('files.directories')) return response({directories: [], can_manage: false});
  if (url.includes('/datasets/')) return response({rows: [], total: 0});
  return response({});
};

/** 在 host 上造一个带 dataTransfer 的拖拽事件。 */
function drag(w: any, host: any, type: string, files: any[] = []) {
  const event: any = new w.Event(type, {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'dataTransfer', {
    value: {types: files.length ? ['Files'] : [], files}, configurable: true,
  });
  host.dispatchEvent(event);
  return event;
}

const textOf = (node: any) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

/* ── ① 常驻的拖放提示区没了，遮罩只在拖入时出现 ───────────────────── */
it('① 文件中心页面上没有那句常驻的「也可以将文件拖到这里上传」提示区', async () => {
  const t = mount(backend);
  try {
    await settle();
    const page = textOf(t.w.document.querySelector('#host'));
    assert.doesNotMatch(page, /也可以将文件拖到这里上传/, '文件中心还挂着那句常驻的拖放提示');
    assert.equal(t.w.document.querySelector('.file-drop-note'), null,
      '文件中心还留着常驻的拖放提示区（.file-drop-note）—— 用户要求改成「拖进来才出现」');
    assert.doesNotMatch(read('shangshu-web/js/file-center.js'), /file-drop-note/,
      'file-center.js 里还留着常驻拖放提示区（源码层面也没清干净）');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

it('① 遮罩默认不占地方：拖文件进来才出现、提示「松开即上传」、拖走就消失', async () => {
  const t = mount(backend);
  try {
    await settle();
    const host = t.w.document.querySelector('#host');
    const overlay = t.w.document.querySelector('#drop-overlay');
    assert.ok(overlay, '文件中心没有整页拖入遮罩');
    assert.equal(overlay.hidden, true, '一进页面遮罩就是显形的 —— 它不该常驻占地方');

    drag(t.w, host, 'dragenter', [{name: '甲.txt'}]);
    assert.equal(overlay.hidden, false, '把文件拖进来了，遮罩没出现');
    const hint = textOf(overlay);
    assert.match(hint, /松开/, `遮罩上应当告诉用户「松开」就上传，实际写的是「${hint}」`);
    assert.match(hint, /上传/, `遮罩上应当写明是「上传」，实际写的是「${hint}」`);

    drag(t.w, host, 'dragleave');
    assert.equal(overlay.hidden, true, '把文件拖出窗口，遮罩没收起来');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

it('① 松开即上传：dragover 拦下默认行为，drop 收起遮罩并直接进上传流程', async () => {
  const t = mount(backend);
  try {
    await settle();
    const host = t.w.document.querySelector('#host');
    const overlay = t.w.document.querySelector('#drop-overlay');
    drag(t.w, host, 'dragenter', [{name: '甲.txt'}]);
    assert.equal(overlay.hidden, false, '拖进来没出现遮罩');

    /* dragover 不 preventDefault 的话浏览器不会派发 drop —— 「拖入即上传」就落空。 */
    assert.equal(drag(t.w, host, 'dragover', [{name: '甲.txt'}]).defaultPrevented, true,
      'dragover 没拦下默认行为 ⇒ 松手不会触发上传');

    const dropped = drag(t.w, host, 'drop', [new t.w.File(['内容'], '甲.txt', {type: 'text/plain'})]);
    assert.equal(dropped.defaultPrevented, true, 'drop 没拦下默认行为（浏览器会直接打开那个文件）');
    assert.equal(overlay.hidden, true, '松手上传后遮罩没收起来');
    await settle();
    const dialog = t.w.document.querySelector('dialog.file-operation-dialog');
    assert.ok(dialog, '松手之后没有进上传流程（上传弹窗没打开）');
    assert.match(textOf(dialog), /甲\.txt/, '上传弹窗里没列出拖进来的那个文件');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

/* ── ②③ 上传弹窗里归属直接摊开 + 版本说明删掉 ──────────────────── */
it('② 打开「上传文件」弹窗，归属选项就在弹窗里，不再弹第二扇窗', async () => {
  const t = mount(backend);
  try {
    await settle();
    const host = t.w.document.querySelector('#host');
    drag(t.w, host, 'dragenter', [{name: '甲.txt'}]);
    drag(t.w, host, 'drop', [new t.w.File(['内容'], '甲.txt', {type: 'text/plain'})]);
    await settle();

    const dialog: any = t.w.document.querySelector('dialog.file-operation-dialog');
    assert.ok(dialog, '上传弹窗没打开');
    assert.equal(dialog.querySelectorAll('dialog').length, 0, '归属不该再自己开一扇窗');
    assert.equal(t.w.document.querySelectorAll('dialog').length, 1,
      `页面上应当只有「上传文件」这一扇窗，实际 ${t.w.document.querySelectorAll('dialog').length} 扇 —— 归属又叠了一扇`);
    assert.equal(dialog.querySelector('[data-attribution-trigger]'), null,
      '上传弹窗里还有「选择」触发按钮（那就是要再弹第二扇窗的入口）');

    const tabs = [...dialog.querySelectorAll('[data-resource-attribution] [data-attribution-tab]')] as any[];
    assert.equal(tabs.length, 2, `归属选项应当直接摊在弹窗里、两张选项卡，实际 ${tabs.length} 张`);
    assert.match(tabs[0].textContent || '', /本人/, '第一张选项卡不是「本人」');
    assert.match(tabs[1].textContent || '', /获权部门/, '第二张选项卡不是「获权部门」');
    assert.equal(dialog.querySelectorAll('select[data-attribution-level],select[data-attribution-department]').length, 0,
      '归属里还有原生下拉');

    /* 摊开式要当场生效：点「获权部门」就地出部门清单，挑中就落值，不用再点「确定」。 */
    tabs[1].click();
    assert.equal(dialog.querySelectorAll('[data-resource-attribution] [data-attribution-dept-value="dep-a"]').length, 1,
      '点「获权部门」后弹窗里没有就地列出可选部门');
    (dialog.querySelector('[data-resource-attribution] [data-attribution-dept-value="dep-a"]') as any).click();
    assert.equal(dialog.querySelector('[data-attribution-level]').value, 'department', '点了选项卡归属没落值');
    assert.equal(dialog.querySelector('[data-attribution-department]').value, 'dep-a', '挑了部门归属没落值');
    assert.equal(t.w.document.querySelectorAll('dialog').length, 1, '挑部门时又叠出了一扇窗');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

it('③ 上传弹窗里没有那句「同目录同名普通文件会新增版本…」说明', async () => {
  const t = mount(backend);
  try {
    await settle();
    const host = t.w.document.querySelector('#host');
    drag(t.w, host, 'dragenter', [{name: '甲.txt'}]);
    drag(t.w, host, 'drop', [new t.w.File(['内容'], '甲.txt', {type: 'text/plain'})]);
    await settle();
    const dialog = t.w.document.querySelector('dialog.file-operation-dialog');
    assert.ok(dialog, '上传弹窗没打开');
    assert.doesNotMatch(textOf(dialog), /同目录同名普通文件会新增版本/, '上传弹窗里还留着那句版本说明');
    assert.doesNotMatch(textOf(dialog), /保留原版本|不覆盖旧表/, '上传弹窗里还留着版本说明的残句');
    assert.doesNotMatch(read('shangshu-web/js/file-center.js'), /新增版本，保留原版本/,
      'file-center.js 里那句版本说明还在（源码层面没删干净）');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

/* ── ④ 全站统一：不再有任何叠窗式归属选择 ───────────────────────── */
it('④ 公共归属组件只剩摊开一种形态：没有触发按钮、没有自己弹窗', async () => {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(read('shangshu-web/js/tool-workspace.js'));
  try {
    const host = w.document.querySelector('#host');
    const picker: any = attributionModule.mountResourceAttribution(host, {
      ui: w.createToolWorkspace(host), defaultLevel: 'personal', departmentSource: 'provided',
      departments: [{value: 'dep-a', label: '市场部'}],
    });
    assert.equal(host.querySelectorAll('[data-attribution-trigger]').length, 0,
      '公共组件里还有「点开再选」的触发按钮');
    assert.equal(picker.trigger, undefined, '公共组件对外还暴露 trigger（叠窗入口）');
    assert.equal(picker.open, undefined, '公共组件对外还暴露 open()（叠窗入口）');
    assert.equal(host.querySelectorAll('[data-attribution-tab]').length, 2,
      '公共组件默认就该摊开两张选项卡');
    assert.equal(w.document.querySelectorAll('dialog').length, 0,
      '挂上公共组件就自己弹了一扇窗');
  } finally { dom.window.close(); }

  const source = read('shangshu-web/js/resource-attribution.mjs');
  assert.doesNotMatch(source, /data-attribution-trigger/, '公共组件源码里还有触发按钮标记');
  assert.doesNotMatch(source, /attribution-picker-trigger/, '公共组件源码里还有触发按钮样式类');
  assert.doesNotMatch(source, /ui\s*\.\s*dialog\s*\(/, '公共组件还在自己 ui.dialog 弹窗');
  assert.doesNotMatch(source, /openPicker/, '公共组件还留着叠窗入口 openPicker');
});

it('④ 全仓再扫一遍：没有任何地方还在用叠窗方式打开归属选择', () => {
  const jsRoot = fileURLToPath(new URL('shangshu-web/js/', ROOT));
  /* tests/ 目录里出现的叠窗字样是**反向守卫**（判据钉「不许有」），不是产品代码，
     所以扫产品代码时跳过；域产物（excel-univer-entry.js）是编出来的，也跳过。 */
  const skip = (path: string) => /node_modules|\/vendor\/|\/tests\/|\.map$|excel-univer-entry\.js$/.test(path);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (skip(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|mjs|ts|mts|html)$/.test(entry.name)) files.push(path);
    }
  };
  walk(jsRoot);
  assert.ok(files.length > 50, `扫到的前端文件太少（${files.length}），扫法本身有问题`);

  const offenders: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    /* 「摊开」里的 data-attribution-tab 合法；这里只抓叠窗入口和叠窗样式类。 */
    if (/data-attribution-trigger|attribution-picker-trigger/.test(source)) {
      offenders.push(`${path.slice(jsRoot.length)}: 出现叠窗入口（data-attribution-trigger / attribution-picker-trigger）`);
    }
  }
  assert.deepEqual(offenders, [], '这些地方还在用叠窗方式打开归属选择：\n' + offenders.join('\n'));

  /* 四个真实调用点都要摊开；传 inline:false（退回叠窗）那种写法一律不许再留下。 */
  const callers: Record<string, RegExp> = {
    'shangshu-web/js/file-center.js': /mountResourceAttribution\([^;]*?\{[^;]*?\}\)/,
    'shangshu-web/js/resource-assignment.js': /mountResourceAttribution\([^;]*?\{[^;]*?\}\)/,
    'shangshu-web/js/domains/mail/mail-settings.js': /mountResourceAttribution\([^;]*?\{[^;]*?\}\)/,
    'shangshu-web/js/domains/excel-univer/src/directory.ts': /mountResourceAttribution\([\s\S]*?\}/,
  };
  for (const [file, pattern] of Object.entries(callers)) {
    const call = read(file).match(pattern)?.[0] || '';
    assert.doesNotMatch(call, /inline\s*:\s*false/, `${file} 显式把归属退回叠窗式了`);
    assert.ok(call.length > 0, `${file} 里没找到归属组件的挂载调用 —— 判据扫法本身坏了`);
  }

  /* 公共壳的样式里那个「点开选」的入口样式也一并清掉，不留半截壳。
     （域目录 css/domains/ 归域改动那一笔，另有判据钉。） */
  const cssRoot = fileURLToPath(new URL('shangshu-web/css/', ROOT));
  const cssOffenders: string[] = [];
  const walkCss = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (/node_modules|\/vendor\/|\/domains\//.test(path)) continue;
      if (entry.isDirectory()) walkCss(path);
      else if (entry.name.endsWith('.css') && /attribution-picker-trigger/.test(readFileSync(path, 'utf8'))) {
        cssOffenders.push(path.slice(cssRoot.length));
      }
    }
  };
  walkCss(cssRoot);
  assert.deepEqual(cssOffenders, [], '这些样式文件里还留着叠窗入口的样式：\n' + cssOffenders.join('\n'));
});
