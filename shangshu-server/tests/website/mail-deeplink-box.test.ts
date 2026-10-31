import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';

/*
 BASE967-06（UI 总表相关）：**深链接打开另一邮箱的信 → 列表也要跟着切到那个邮箱**。

 现状（根因线索 `mail-center.js:839-840`）：`open(id)` 打开一封属于**另一个邮箱**的信时，
 只把 `currentBox` / 下拉 / 权限外观改掉，**没有重载列表** —— 于是详情是部门箱的信、
 列表还是个人箱的信，两边对不上。对比用户手动切箱那条（`:1840-1848`）是
 `currentBox = …; clearMailSelection(); page = 1; accountChrome(); refresh();` —— 少了后半截。

 测试通过 = 深链接 `?mail=<部门箱的信>` 打开后，
   · 详情打开的是那封信；
   · **列表确实按新邮箱重新查了一次**（查询参数里带 `mailbox=<部门箱>`），
     不是停在个人箱的列表上。
*/
const tick = () => new Promise(r => setTimeout(r, 10));

const PERSONAL = {id: 'mb-p', account_key: 'mb-p', kind: 'personal',
                  email_address: 'me@x.invalid', display_name: '我',
                  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT = {id: 'mb-d', account_key: 'mb-d', kind: 'department', department: '业务部',
              email_address: 'dept@x.invalid', display_name: '业务部',
              rights: {read: true, edit_draft: true, send: false, manage: false, signature: false}};

const DEPT_MAIL = {
  name: 'mail-in-dept', id: 'mail-in-dept', subject: '部门箱里的信',
  body: '<p>部门箱正文</p>', body_format: 'HTML', to: [], cc: [],
  from_address: '对方 <o@x.invalid>', status: 'Received', box: 'inbox',
  record_version: 1, mailbox: 'mb-d', mailboxId: 'mb-d',
  modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00',
  unread: false, attachments: [],
};

function mount(handler: (url: string, body: any) => any, url: string, detail?: {status: number; exc: string}) {
  const dom = new JSDOM('<div id="host"></div>', {url, runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const listQueries: string[] = [];
  w.fetch = async (u: string, options: any = {}) => {
    if (u.includes('/services/mail.account.status/'))
      return {ok: true, status: 200, json: async () => ({result: {account: {bound: true, email: 'me@x.invalid'}}})};
    if (u.includes('/services/mail.mailboxes/'))
      return {ok: true, status: 200, json: async () => ({result: {mailboxes: [PERSONAL, DEPT]}})};
    if (u.includes('/api/platform/datasets/mail.message/records')) {
      listQueries.push(String(u));
      return {ok: true, status: 200, json: async () => ({rows: [], total: 0, page: 1, page_length: 50})};
    }
    if (u.includes('/services/mail.detail/')) {
      /* detail 传了参数 = 后端拒了（无权链接场景）。形状要按**真实面**来：
         前端接的是 BFF，Frappe 的 exc/_server_messages 已被 platform.ts:115-124
         翻译成 `{ok:false, error}` 再吐回（sendError:269）——mock 直吐 exc 是错层。 */
      if (detail) return {ok: false, status: detail.status,
        json: async () => ({ok: false, error: detail.exc, code: 'PERMISSION_ERROR'})};
      return {ok: true, status: 200, json: async () => ({result: {mail: DEPT_MAIL}})};
    }
    if (u.includes('/api/platform/action-proposals') && !options.method)
      return {ok: true, status: 200, json: async () => ({ok: true, list: []})};
    const result = await handler(u, options.body ? JSON.parse(options.body) : null);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, listQueries, dispose: () => { dispose(); dom.window.close(); }};
}

it('深链接打开部门箱的信 → 列表也切到部门箱重新查，不留在个人箱', async () => {
  const t = mount(() => ({}), 'http://localhost/index.html?mail=mail-in-dept');
  try {
    /* 等深链接跑完：load() → navigateReviewTarget → open(id) → 切箱 → (应该) refresh() */
    for (let i = 0; i < 40; i++) {
      await tick();
      if (t.listQueries.some(u => /"mailbox"\s*:\s*"mb-d"/.test(decodeURIComponent(u)))) break;
    }
    const decoded = t.listQueries.map(u => decodeURIComponent(u));
    assert.ok(decoded.length >= 1, `一次列表查询都没有：${JSON.stringify(decoded)}`);
    assert.ok(
      decoded.some(u => /"mailbox"\s*:\s*"mb-d"/.test(u)),
      `列表没有按部门箱重新查 —— 深链接切箱后没重载列表（BASE967-06）。` +
      `实际查询：${JSON.stringify(decoded)}`);
  } finally { t.dispose(); }
});

/* ── BASE967-06 其余场景（源文：「回归覆盖个人→共享、共享→个人、直接链接刷新及无权
   链接；重载与切换乱序不能混箱」）—— 直接链接那条在上一用例，这里补三个。
   测试通过 = 各自成立，见每条注释。 */

it('手动切箱 个人→共享→个人：每次切换列表都按新箱重查', async () => {
  const t = mount(() => ({}), 'http://localhost/index.html#/mail');
  try {
    for (let i = 0; i < 20; i++) { await tick(); if (t.listQueries.length) break; }
    const sel = t.w.document.querySelector('#mailbox-switch') as any;
    assert.ok(sel, '找不到邮箱切换下拉');
    const beforeDept = t.listQueries.length;
    sel.value = 'mb-d'; sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    for (let i = 0; i < 30; i++) {
      await tick();
      if (t.listQueries.slice(beforeDept).some(u => /"mailbox"\s*:\s*"mb-d"/.test(decodeURIComponent(u)))) break;
    }
    const beforeBack = t.listQueries.length;
    sel.value = 'mb-p'; sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    for (let i = 0; i < 30; i++) {
      await tick();
      if (t.listQueries.slice(beforeBack).some(u => /"mailbox"\s*:\s*"mb-p"/.test(decodeURIComponent(u)))) break;
    }
    const dept = t.listQueries.slice(beforeDept, beforeBack).map(u => decodeURIComponent(u));
    const back = t.listQueries.slice(beforeBack).map(u => decodeURIComponent(u));
    assert.ok(dept.some(u => /"mailbox"\s*:\s*"mb-d"/.test(u)),
      `切到共享箱后没按共享箱重查：${JSON.stringify(dept)}`);
    assert.ok(back.some(u => /"mailbox"\s*:\s*"mb-p"/.test(u)),
      `切回个人箱后没按个人箱重查：${JSON.stringify(back)}`);
  } finally { t.dispose(); }
});

it('乱序返回不能混箱：先发的共享箱响应迟到，不得覆盖后发的个人箱列表', async () => {
  const t = mount(() => ({}), 'http://localhost/index.html#/mail');
  try {
    for (let i = 0; i < 20; i++) { await tick(); if (t.listQueries.length) break; }
    const inner = t.w.fetch;
    let listCall = 0;
    t.w.fetch = async (u: string, o: any = {}) => {
      if (u.includes('/api/platform/datasets/mail.message/records')) {
        const n = ++listCall;
        const isDept = /"mailbox"\s*:\s*"mb-d"/.test(decodeURIComponent(u));
        /* 第一发（共享箱）迟到 80ms，后发（个人箱）立即回 —— 让响应乱序回来 */
        if (n === 1) await new Promise(r => setTimeout(r, 80));
        return {ok: true, status: 200, json: async () => ({
          rows: [{name: isDept ? 'row-dept' : 'row-p', subject: isDept ? '部门行' : '个人行',
                  from_address: 'x@x.invalid', date: '2026-10-17 10:00:00', status: 'Received', box: 'inbox'}],
          total: 1, page: 1, page_length: 50})};
      }
      return inner(u, o);
    };
    const sel = t.w.document.querySelector('#mailbox-switch') as any;
    sel.value = 'mb-d'; sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();
    sel.value = 'mb-p'; sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 160));
    await tick(); await tick();
    const rows = t.w.document.querySelector('#mail-rows') as any;
    const text = rows ? rows.textContent : '';
    assert.ok(text.includes('个人行'),
      `后发的个人箱列表该在：实际 ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(!text.includes('部门行'),
      `迟到的共享箱响应不许覆盖列表（乱序混箱 = BASE967-06）：实际 ${JSON.stringify(text.slice(0, 120))}`);
  } finally { t.dispose(); }
});

it('无权链接：详情被后端拒时如实报错，不悄悄切到那个箱', async () => {
  const t = mount(() => ({}), 'http://localhost/index.html?mail=mail-in-dept',
    {status: 403, exc: '没有权限查看这封信'});
  try {
    for (let i = 0; i < 40; i++) {
      await tick();
      if (lastToast(t.w)) break;
    }
    const toast = lastToast(t.w);
    assert.ok(toast, '无权链接要吭声 —— 一声不吭就等于静默失败');
    assert.match(toast.textContent || '', /没有权限|无权|拒绝/,
      `报错要说清是权限问题，实际提示：${(toast.textContent || '').slice(0, 80)}`);
    const decoded = t.listQueries.map(u => decodeURIComponent(u));
    assert.ok(!decoded.some(u => /"mailbox"\s*:\s*"mb-d"/.test(u)),
      `详情被拒后不许悄悄切到那个箱加载列表：${JSON.stringify(decoded)}`);
  } finally { t.dispose(); }
});
