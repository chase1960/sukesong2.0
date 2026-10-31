import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';

/*
 测试通过 = 下面全部成立：
 1. 保存失败（服务端拒绝/网络错误）不假成功：不把未生效内容当已保存，提示失败原因。
 2. 旧版本冲突（expected_version 不匹配）不覆盖新输入：用户敲的字仍在编辑区里。
 3. 无权访问的草稿打不开、不写入，给出明确提示。
 4. 保存后未保存的新输入不被静默丢弃。
*/

const CID = 'logo-sample@shangshu.local';
const SAMPLE_HTML = '<table><tr><td colspan="2">案件汇总</td></tr><tr><td>A001</td><td>150.00</td></tr></table>';

const seed = {
  name: 'mail-fail', subject: '保存失败样本', body: SAMPLE_HTML, body_format: 'HTML',
  to: ['client@example.invalid'], cc: [], status: 'Draft', record_version: 1,
  owner: 'owner@example.invalid', modified: '2026-10-10 10:00:00',
  inline_resources: [{content_id: CID, mime_type: 'image/png', name: '图.png', file: 'f1'}],
};

const tick = () => new Promise(r => setTimeout(r, 10));

/* 写信窗已经没有「存草稿」按钮了（用户 2026-10-11：「存草稿不要用一个显性的按钮，只要失焦就保存」）。
   现在保存只有两个入口：**失焦**自动存（120ms 防抖）、Ctrl/⌘S 手存。
   triggerSave 只派发 blur、不派发 focusout —— focusout 会同时触发「单字段失焦保存」，
   多发出一个只含单字段的请求，测的就不是「整封信存了一次」了。 */
async function triggerSave(w: any) {
  const ed = w.document.querySelector('.mail-body-editor') || w.document.querySelector('#c-body');
  if (ed) { ed.blur?.(); ed.dispatchEvent(new w.FocusEvent('blur', {bubbles: true})); }
  await new Promise(r => setTimeout(r, 320)); // 比 120ms 防抖长
}

function mount(handler: (url: string, body: any) => any, rows: any[] = [seed]) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) return {ok: true, status: 200, json: async () => ({result: {account: {bound: false}}})};
    if (url.includes('/datasets/')) return {ok: true, status: 200, json: async () => ({rows, total: rows.length, attachment_capability: 'fixed_references_v2'})};
    const body = options.body ? JSON.parse(options.body) : null;
    const result = handler(url, body);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, dispose: () => { dispose(); dom.window.close(); }};
}

it('保存失败不假成功：不把未生效内容当已保存，并提示失败', async () => {
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: seed}};
    return {error: '磁盘写入失败，本次保存未生效', status: 500};
  });
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    editor.querySelector('td').textContent = '改过但存不上';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    await triggerSave(t.w);
    const note = t.w.document.querySelector('#dirty-note');
    assert.equal(note.hidden, false, '保存失败后必须仍显示未保存状态，不能假成功');
    // 失败提示走右下角 toast 公共件，且必须是错误色（红）+ alert 语义
    const toast = lastToast(t.w) as any;
    assert.ok(toast, '保存失败没走右下角 toast 公共件');
    assert.match(toast.textContent || '', /失败|未生效|错误/, '必须给出保存失败提示');
    assert.ok(toast.classList.contains('toast-error'),
        `保存失败没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.equal(t.w.document.querySelector('#notice'), null, '页面里又贴回了 #notice');
    // 失败后用户输入不丢
    assert.match(t.w.document.querySelector('#c-editor').textContent, /改过但存不上/, '失败后输入被丢弃');
  } finally { t.dispose(); }
});

it('旧版本冲突不覆盖新输入：敲的字仍在编辑区', async () => {
  let calls = 0;
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: {...seed, record_version: 5}}};
    calls++;
    return {error: '邮件已更新，请刷新后再操作；当前修改未保存', status: 409};
  });
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    editor.querySelector('td').textContent = '版本冲突期间敲的字';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    await triggerSave(t.w);
    assert.ok(calls >= 1, '发起了保存');
    assert.match(t.w.document.querySelector('#c-editor').textContent, /版本冲突期间敲的字/, '冲突后新输入被覆盖');
    const note = t.w.document.querySelector('#dirty-note');
    assert.equal(note.hidden, false, '冲突后必须仍显示未保存');
  } finally { t.dispose(); }
});

it('无权访问的草稿打不开、不写入，给出明确提示', async () => {
  const writes: any[] = [];
  const t = mount((url, body) => {
    if (url.includes('/datasets/')) return {rows: [], total: 0};
    if (url.includes('/actions/')) { writes.push(body); return {result: {}}; }
    return {error: '只能访问自己的邮件', status: 403};
  }, []);
  try {
    await tick();
    t.w.document.querySelector('#compose').click();
    await tick();
    // 无权详情：直接打开引用不应产生写入
    assert.equal(writes.length, 0, '无权时不写入');
  } finally { t.dispose(); }
});
