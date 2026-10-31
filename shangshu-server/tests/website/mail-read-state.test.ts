import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 已读 / 未读 —— **真实邮箱**里的读信状态。

 用户 2026-10-13 提出：「还有一个已读未读的问题」，并要求「进入到本批赶快修」。

 改之前（查实 mail-center.js）：已读/未读**只活在「交互样例」模式里**
   · 未读小圆点、`is-unread` 加粗、状态里的「已读/未读」全写死在 showExamples 分支
   · 「标为未读」按钮只在样例里渲染
   · 筛选下拉有「未读」选项，但 `visible()` 开头 `if(!showExamples)return mails;`
     —— **真实模式下筛选什么也不做**，是「看似可用但不落库」的假入口
     （执行计划明令禁止的那种）

 测试通过 = 下面全部成立：

   A. 真实模式列表里，未读的信**有未读标记**（样式类 + 小圆点提示）
   B. 筛选选「未读」时，**请求里真的带了未读筛选**（发给后端，不是前端假装筛）
   C. 打开一封未读的信 → **自动发一次「标为已读」**（用户不用手动点）
   D. 真实模式详情里**也有「标为未读」按钮**，不只是样例里有
   E. 已读的信列表里**不带**未读标记
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const seedReal = (over: any = {}) => ({
  name: 'm-unread', status: 'Received', subject: '一封没看过的来信',
  body_format: 'Text', body: '正文内容',
  record_version: 1, from_address: '对方 <other@x.example>', from_name: '',
  to: ['我 <me@qq.com>'], cc: [], attachments: [], attachment_bindings: {},
  inline_resources: [], owner: 'me@qq.com', modified: '2026-10-13 10:00:00',
  message_id: '<u1@x>', date: '2026-10-13 09:00', reply_to_address: '',
  read_at: '', unread: true,
  ...over,
});

function mount(rows: any[], over: any = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const seen: {url: string; body: any}[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    const body = options?.body ? JSON.parse(options.body) : (options?.payload || {});
    seen.push({url: String(url), body});
    if (url.includes('/services/mail.account.status/')) {
      const a = {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我'};
      return {ok: true, status: 200, json: async () => ({result: {account: a}}),
        text: async () => JSON.stringify({result: {account: a}})};
    }
    if (url.includes('/services/mail.detail/')) {
      const key = (body?.payload || body)?.mail;
      const found = rows.find((r: any) => r.name === key) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
        text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length, attachment_capability: 'fixed_references_v2',
        transport_capability: 'smtp_imap_v1'};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('mail.set_read')) {
      /* 服务端写完会把新版本号随回执带回来（service.py 的 projection(doc, True)
         里 record_version 已经 +1）。前端必须接住它，否则下一次写拿旧版本号，
         被版本校验当「别人改过」拒掉。 */
      const req = body?.payload || body || {};
      const row: any = rows.find((r: any) => r.name === (req.mail || req.payload?.mail)) || rows[0] || {};
      const next = {...row, record_version: (row.record_version || 1) + 1,
        read_at: req.read === false ? '' : '2026-10-13 10:05:00',
        unread: req.read === false};
      const out = {result: {...next}};
      return {ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out)};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {...over});
  return {w, doc: () => w.document, seen, dispose: () => { dispose(); dom.window.close(); }};
}

it('A 真实模式列表里未读的信有未读标记，已读的没有', async () => {
  const rows = [seedReal(), seedReal({name: 'm-read', subject: '一封看过的来信',
    unread: false, read_at: '2026-10-13 09:30:00'})];
  const t = mount(rows);
  try {
    await tick(); await tick(); await tick();
    const items = [...t.doc().querySelectorAll('.mail-item')];
    assert.equal(items.length, 2, `列表里该有 2 封，实际 ${items.length}`);
    const byText = (s: string) => items.find((el: any) => (el.textContent || '').includes(s)) as any;

    const unread = byText('一封没看过的来信');
    const read = byText('一封看过的来信');
    assert.ok(unread && read, '列表里没找到两封信');

    assert.match(unread.className || '', /is-unread/,
        `未读那封没有未读样式标记：className=${JSON.stringify(unread.className)}`);
    assert.ok(!/is-unread/.test(read.className || ''),
        `已读那封也带了未读标记：className=${JSON.stringify(read.className)}`);

    const dot = unread.querySelector('.mail-dot') as any;
    assert.ok(dot, '未读那封没有小圆点');
    assert.match((dot.getAttribute('title') || '') + (dot.getAttribute('aria-label') || ''), /未读/,
        `小圆点没标出「未读」：title=${JSON.stringify(dot.getAttribute('title'))}`);
  } finally { t.dispose(); }
});

it('B 筛选选「未读」时，请求里真的带了未读筛选（发给后端，不是前端假装筛）', async () => {
  const t = mount([seedReal()]);
  try {
    await tick(); await tick(); await tick();
    const filter = t.doc().querySelector('#filter') as any;
    assert.ok(filter, '没有筛选框');
    const opt = [...filter.options].find((o: any) => o.value === 'unread');
    assert.ok(opt, '筛选框里没有「未读」这一项');

    filter.value = 'unread';
    filter.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick(); await tick(); await tick();

    const listCalls = t.seen.filter((s: any) => s.url.includes('/datasets/'));
    assert.ok(listCalls.length, '筛选后没有发起列表请求');
    const last = listCalls[listCalls.length - 1];
    const decoded = decodeURIComponent(last.url);
    assert.match(decoded, /unread/,
        `筛选「未读」后请求里没带未读筛选 —— 后端根本不知道要筛：${decoded.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('C 打开一封未读的信，自动发一次「标为已读」', async () => {
  const t = mount([seedReal()]);
  try {
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('一封没看过的来信')) as any;
    assert.ok(item, '列表里找不到那封信');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#close-detail')) break; await tick(); await tick(); }
    await new Promise(r => setTimeout(r, 250));

    const markCalls = t.seen.filter((s: any) => s.url.includes('mail.set_read'));
    assert.ok(markCalls.length,
        '打开未读的信没有自动标已读 —— 用户还得自己找按钮点。\n'
        + `实际发出的请求：${t.seen.map((s: any) => s.url).join(' | ').slice(0, 300)}`);
    const sent = JSON.stringify(markCalls[markCalls.length - 1].body);
    assert.match(sent, /"read"\s*:\s*true/,
        `标已读请求里 read 不是 true：${sent.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('D 真实模式详情里也有「标为未读」按钮（不只是样例里有）', async () => {
  const t = mount([seedReal({unread: false, read_at: '2026-10-13 09:30:00'})]);
  try {
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('一封没看过的来信')) as any;
    assert.ok(item, '列表里找不到那封信');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#close-detail')) break; await tick(); await tick(); }

    const btn = t.doc().querySelector('#toggle-unread') as any;
    assert.ok(btn,
        '真实模式详情里没有「标为未读」按钮 —— 只在交互样例里有，真用的时候没有');
  } finally { t.dispose(); }
});

it('E 「标为未读」不是只写在样例分支里', () => {
  /* 静态钉子：原来 `showExamples?'<button id="toggle-unread">标为未读</button>'
     :'<button id="refresh-mail">刷新状态</button>'` —— 两个按钮**互斥**，
     真实模式永远没有「标为未读」。真实模式要两个都有。 */
  const src = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(!/showExamples\s*\?\s*'<button[^']*toggle-unread/.test(src),
      '「标为未读」按钮还写死在 showExamples 三元里 —— 真实模式拿不到');
  assert.ok(/id="toggle-unread"/.test(src) && /id="refresh-mail"/.test(src),
      '「标为未读」和「刷新状态」应该在真实模式里都出现');
});

it('F 自动标已读后版本号要跟上，再点「标为未读」才不会被版本校验拒掉', async () => {
  /* 真 bug（2026-10-13 用户实测「有圆点，但是点击不能变没掉」的第二层）：
     打开未读的信 → 自动标已读，服务端 record_version 从 1 变 2；
     前端只改了 m.unread，**没接住回执里的新版本号**。
     于是点「标为未读」时 expected_version 还是 1 —— 服务端判「有人改过」拒写，
     界面弹「标记失败」，圆点当然消不掉。

     测试通过 = 自动标已读之后再标未读，请求里带的是服务端发回的**新**版本号。 */
  const t = mount([seedReal()]);
  try {
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('一封没看过的来信')) as any;
    assert.ok(item, '列表里找不到那封信');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#close-detail')) break; await tick(); await tick(); }
    await new Promise(r => setTimeout(r, 250));

    const btn = t.doc().querySelector('#toggle-unread') as any;
    assert.ok(btn, '详情里没有「标为未读」按钮');
    btn.click();
    await new Promise(r => setTimeout(r, 250));

    const writes = t.seen.filter((s: any) => s.url.includes('mail.set_read'));
    assert.equal(writes.length, 2,
        `该有两次写（自动标已读 + 手动标未读），实际 ${writes.length} 次：`
        + writes.map((s: any) => JSON.stringify(s.body)).join(' | ').slice(0, 300));

    const first = JSON.stringify(writes[0].body);
    const second = JSON.stringify(writes[1].body);
    assert.match(first, /"expected_version"\s*:\s*1/,
        `第一次（自动标已读）该带版本 1：${first.slice(0, 200)}`);
    assert.match(second, /"expected_version"\s*:\s*2/,
        `第二次（标回未读）该带服务端发回的新版本 2，不是沿用 1 —— `
        + `拿旧版本号写会被服务端当「别人改过」拒掉：${second.slice(0, 200)}`);
  } finally { t.dispose(); }
});
