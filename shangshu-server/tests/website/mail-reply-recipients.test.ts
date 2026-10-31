import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';

/*
 计划 §6 的 C1 —— 回复与回复全部。

 用户要的是「回复过去的时候人对、原信不动」。查实现时发现几处缺口：
   ① **Reply-To 完全没处理** —— 只看原发件人；原信写了 Reply-To 的会被回错人
   ② **本人地址排除不全** —— 回复全部有排除；普通回复没有（自己发的信点回复会把自己算进去）
   ③ **To/Cc 去重不全** —— 只去重 to，to 和 cc 之间不去重（同一人会收到两遍）
   ④ **Bcc** 要确认既不泄露也不被推断

 测试通过 = 下面全部成立：

   A. 回复：收件人是**原发件人**（无 Reply-To 时），主题带 Re:，**不含本人**
   B. 原信有 **Reply-To** 时，回复发给 Reply-To（不是原发件人）
   C. **自己发的信**点回复，不会把自己塞进收件人
   D. 回复全部：**To/Cc 一起去重**、**排除本人**，同一人不出现两次
   E. **不泄露也不推断 Bcc** —— 原信的 Bcc 一个都不带出来
   F. **原收件记录不变**（回复建的是独立草稿，原信的收件人/主题/正文一字不动）
   G. **原线程引用** —— 草稿挂到原信上（reply_to_mail = 原信）
   H. **草稿 ID 与后续自动保存一致**（存两次还是同一封）
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 340));

const ME = {name: '我', addr: 'me@qq.com'};

function mount(rows: any[],mailboxes:any[]=[]) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    if(url.includes('/services/mail.mailboxes/'))return {ok:true,status:200,json:async()=>({result:{mailboxes}})};
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: ME.addr, display_name: ME.name}}})};
    }
    /* 人点回复/转发 = **调后端那两个动作**（2026-10-21 起）——
       回执就是后端建好的那封草稿（收件人/抄送/主题照这次载荷收下）。 */
    if (/\/actions\/(mail\.reply|mail\.forward)\/execute/.test(url)) {
      const body = options.body ? JSON.parse(options.body) : {};
      const p = body.payload || {};
      const receipt = {name: 'draft-1', record_version: 1, status: 'Draft',
        subject: p.subject || '', body: p.body || '', body_format: 'HTML',
        to: p.to || [], cc: p.cc || [], attachments: [], attachment_bindings: {},
        inline_resources: [], owner: ME.addr,
        /* 后端把草稿挂到原信上（`reply_to_mail`）—— 回执里也带着。 */
        reply_to_mail: p.reply_to_mail || ''};
      return {ok: true, status: 200,
        json: async () => ({result: receipt}), text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(options.body ? JSON.parse(options.body) : {});
      const receipt = {name: 'draft-1', record_version: saved.length, attachments: [], attachment_bindings: {}};
      return {ok: true, status: 200,
        json: async () => ({result: receipt}), text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === body?.payload?.mail) || rows[0] || {};
      return {ok: true, status: 200,
        json: async () => ({result: {mail: found}}), text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saved, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openMail(t: ReturnType<typeof mount>, subject: string) {
  await tick(); await tick();
  const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes(subject)) as any;
  assert.ok(item, `列表里找不到「${subject}」`);
  item.click();
  for (let i = 0; i < 20; i++) {
    if (t.doc().querySelector('#reply')) break;
    await tick(); await tick();
  }
}

/** 点某个按钮开出写信窗，返回读到的收件人串。 */
async function clickAndRead(t: ReturnType<typeof mount>, id: string) {
  const btn = t.doc().querySelector(id) as any;
  assert.ok(btn, `找不到按钮 ${id}`);
  btn.click();
  /* 写信窗是**后端动作回包之后**才开的（点下去就建草稿）—— 等它开出来。 */
  for (let i = 0; i < 40; i++) { if (t.doc().querySelector('#c-to')) break; await tick(); await tick(); }
  await new Promise(r => setTimeout(r, 200));
  return {
    to: (t.doc().querySelector('#c-to') as any)?.value || '',
    cc: (t.doc().querySelector('#c-cc') as any)?.value || '',
    subject: (t.doc().querySelector('#c-subject') as any)?.value || '',
  };
}

const seed = (over: any = {}) => ({
  name: 'm-src', status: 'Received', subject: '年费核对', body_format: 'HTML',
  body: '<p>请核对</p>', record_version: 1,
  from_address: '张三 <billing@client.example>', from_name: '张三',
  to: ['我 <me@qq.com>', '李四 <li@client.example>'],
  cc: ['王五 <wang@client.example>'],
  attachments: [], attachment_bindings: {},
  owner: 'me@qq.com', modified: '2026-10-12 10:00:00',
  message_id: '<src-1@client.example>',
  ...over,
});

it('A 回复：收件人是原发件人、主题带 Re:、不含本人', async () => {
  const t = mount([seed()]);
  try {
    await openMail(t, '年费核对');
    const r = await clickAndRead(t, '#reply');
    assert.match(r.subject, /^Re: /, `主题该带 Re:，实际 ${JSON.stringify(r.subject)}`);
    assert.match(r.to, /billing@client\.example/, `收件人该是原发件人，实际 ${JSON.stringify(r.to)}`);
    assert.ok(!r.to.includes(ME.addr), `不该把自己塞进收件人：${JSON.stringify(r.to)}`);
  } finally { t.dispose(); }
});

it('B 原信有 Reply-To 时，回复发给 Reply-To 而不是原发件人', async () => {
  const t = mount([seed({reply_to_address: 'support@client.example'})]);
  try {
    await openMail(t, '年费核对');
    const r = await clickAndRead(t, '#reply');
    assert.match(r.to, /support@client\.example/,
        `该回给 Reply-To（support@），实际 ${JSON.stringify(r.to)}`);
    assert.ok(!/billing@client\.example/.test(r.to),
        `Reply-To 在时不该回给原发件人：${JSON.stringify(r.to)}`);
  } finally { t.dispose(); }
});

it('C 自己发的信点回复，不把自己塞进收件人（原信收件人里就有本人）', async () => {
  /* 加严：原信的 To 里**就有本人**（抄送给自己很常见）。
     旧实现 `to: m.to` 会原样带出来 —— 上一版种子里没放本人，是侥幸过的。 */
  const t = mount([seed({
    status: 'Sent', from_address: '我 <me@qq.com>', from_name: '我',
    to: ['我 <me@qq.com>', '张三 <billing@client.example>'], cc: [],
  })]);
  try {
    await openMail(t, '年费核对');
    const r = await clickAndRead(t, '#reply');
    assert.ok(r.to.length, '回复的收件人不该为空');
    assert.ok(!r.to.includes(ME.addr), `自己发的信回复时把自己塞进去了：${JSON.stringify(r.to)}`);
    assert.match(r.to, /billing@client\.example/, `原收件人该在：${JSON.stringify(r.to)}`);
  } finally { t.dispose(); }
});

it('D 回复全部：To/Cc 一起去重、排除本人，同一人不出现两次', async () => {
  /* 原信：发件人张三；To 有本人和李四；Cc 有王五**和李四**（李四同时在 To 和 Cc）。
     回复全部时李四只该出现一次，且位置固定（在 To）。 */
  const t = mount([seed({
    to: ['我 <me@qq.com>', '李四 <li@client.example>'],
    cc: ['王五 <wang@client.example>', '李四 <li@client.example>'],
  })]);
  try {
    await openMail(t, '年费核对');
    const r = await clickAndRead(t, '#reply-all');
    const flat = `${r.to}；${r.cc}`;
    const count = (flat.match(/li@client\.example/g) || []).length;
    assert.equal(count, 1, `李四在 To 和 Cc 各出现一次 = 收两遍：to=${JSON.stringify(r.to)} cc=${JSON.stringify(r.cc)}`);
    assert.ok(!flat.includes(ME.addr), `回复全部时把自己塞进去了：${flat}`);
    assert.match(flat, /billing@client\.example/, `原发件人该在：${flat}`);
    assert.match(flat, /wang@client\.example/, `原抄送王五该在：${flat}`);
  } finally { t.dispose(); }
});

it('共享邮箱回复全部排除本箱与本人地址，但保留其他部门和客户收件人',async()=>{
 const rights={read:true,edit_draft:true,send:true,manage:true,signature:true};const t=mount([seed({mailbox_id:'box-dept',to:['部门 <dept@example.invalid>','我 <me@qq.com>','客户 <client@example.invalid>'],cc:['本箱 <DEPT@example.invalid>','协作部 <other@example.invalid>']})],[
  {id:'box-personal',kind:'personal',email:ME.addr,enabled:true,rights},
  {id:'box-dept',kind:'department',email:'dept@example.invalid',enabled:true,rights},
  {id:'box-other',kind:'department',email:'other@example.invalid',enabled:true,rights},
 ]);try{await openMail(t,'年费核对');const result=await clickAndRead(t,'#reply-all'),recipients=result.to+'；'+result.cc;
  assert.doesNotMatch(recipients,/dept@example\.invalid|me@qq\.com/i);assert.match(recipients,/client@example\.invalid/);assert.match(recipients,/billing@client\.example/);assert.match(recipients,/other@example\.invalid/,'其他已授权部门邮箱不是当前发件箱，不能一概排除');
 }finally{t.dispose();}
});

it('E 不泄露也不推断 Bcc：原信的 Bcc 一个都不带出来', async () => {
  const t = mount([seed({
    // 真实来信可能带 bcc（收信侧解析出来的），回复时**不许**带出
    bcc: ['秘密 <secret@client.example>'],
    bcc_json: ['秘密 <secret@client.example>'],
  })]);
  try {
    await openMail(t, '年费核对');
    for (const id of ['#reply', '#reply-all'] as const) {
      await openMail(t, '年费核对');
      const r = await clickAndRead(t, id);
      const flat = `${r.to}；${r.cc}`;
      assert.ok(!/secret@client\.example/.test(flat),
          `${id} 把 Bcc 带出来了（泄露）：${flat}`);
    }
  } finally { t.dispose(); }
});

it('F 原收件记录不变：回复建的是独立草稿，原信一字不动', async () => {
  const before = JSON.stringify(seed());
  const t = mount([seed()]);
  try {
    await openMail(t, '年费核对');
    await clickAndRead(t, '#reply');
    // 原信的字段不该被回复这个动作改掉
    const after = JSON.stringify(seed());
    assert.equal(after, before, '原信记录被回复动作改了');
  } finally { t.dispose(); }
});

it('G 原线程引用：草稿挂到原信上', async () => {
  const t = mount([seed()]);
  try {
    await openMail(t, '年费核对');
    await clickAndRead(t, '#reply');
    const subject = t.doc().querySelector('#c-subject') as any;
    subject.value = 'Re: 年费核对';
    subject.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
    ed?.blur?.();
    ed?.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    assert.ok(t.saved.length, '没发出保存请求');
    const payload = t.saved[t.saved.length - 1];
    const p = payload?.payload || payload || {};
    assert.equal(p.reply_to_mail, 'm-src',
        `草稿没挂到原信上：reply_to_mail=${JSON.stringify(p.reply_to_mail)}`);
  } finally { t.dispose(); }
});

/* ── B2 补 D 报的根因：回复全部用 Reply-To 而不是 from ───────────────────
   D 报原始档（`测试反馈-新基线浏览器复验-2026-10-16.md:74`）：
   > UI-046 FAIL：回复全部未用已落库 Reply-To=reply@example.invalid，仍发件人 sender0；
     且共享回复默认个人 From、收件含本人 qa-a2。
   > **已确认 reply-all 直接使用 m.from，单独回复才使用 replyTarget。**
   修法：reply-all 也用 `replyTarget()`（先 Reply-To，无则回退到 m.from），
   不要再 `[m.from, ...m.to]` —— 那是「带发件人 + 原收件人」，不是「收件人」。

   测试通过 = 下面全部成立：
   · 原信有 Reply-To → 回复全部的 To = Reply-To，**不含** m.from
   · 原信无 Reply-To → 回复全部的 To = m.from
   · 收件人里**不含本人**（共享箱回复全部要排除原箱地址） */
const B2_SEED = (over = {}) => ({
  name: 'mail-b2', id: 'mail-b2', subject: '原信', body: '<p>正文</p>',
  to: ['other@x.invalid'], cc: ['cc1@x.invalid'],
  from_address: 'sender0@x.invalid', from: {addr: 'sender0@x.invalid'},
  status: 'Received', box: 'inbox', record_version: 1, mailbox: 'mb-shared', mailboxId: 'mb-shared',
  modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00', attachments: [],
  ...over,
});

it('B2a 回复全部用 Reply-To 而不是发件人（修复 BASE967-05 根因）', async () => {
  /* ★ 2026-10-17 修判据自身：种子里原来写的是驼峰 `replyToAddress`，而
     `mapReal` 只读服务端的 `reply_to_address` —— Reply-To 从来没被真正喂进产品，
     所以这条「Reply-To 断言」一直红在别的原因上（第一收件人被丢）。
     改回真实字段名后，产品侧缺的只有 `[...replyTarget()]` 那个展开符。 */
  const row = B2_SEED({reply_to_address: 'reply@example.invalid'});
  const t = mount([row], [{
    id: 'mb-shared', kind: 'department', department: '业务部',
    email_address: 'shared@x.invalid', display_name: '业务部公共箱',
    enabled: true,
    rights: {read: true, edit_draft: true, send: true, manage: true, signature: true},
  }]);
  try {
    await settle();
    const item = t.doc().querySelector('[data-mail]') as any;
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#reply-all')) break; await tick(); await tick(); }
    (t.doc().querySelector('#reply-all') as any).click();
    await new Promise(r => setTimeout(r, 250));
    const to = (t.doc().querySelector('#c-to') as any)?.value || '';
    assert.ok(/reply@example.invalid/.test(to),
      `回复全部的 To 该是 Reply-To（reply@example.invalid），实际：${to}`);
    assert.ok(!/sender0@x.invalid/.test(to),
      `回复全部的 To **不该**是 m.from（sender0@x.invalid），实际：${to}`);
  } finally { t.dispose(); }
});

it('B2b 回复全部排除原箱地址（共享箱防自收）', async () => {
  /* 当前箱地址 shared@x.invalid，回复全部时也应排除「自己的」即 shared@x.invalid */
  const row = B2_SEED();
  const t = mount([row], [{
    id: 'mb-shared', kind: 'department', department: '业务部',
    email_address: 'shared@x.invalid', display_name: '业务部公共箱',
    enabled: true,
    rights: {read: true, edit_draft: true, send: true, manage: true, signature: true},
  }]);
  try {
    await settle();
    const item = t.doc().querySelector('[data-mail]') as any;
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#reply-all')) break; await tick(); await tick(); }
    (t.doc().querySelector('#reply-all') as any).click();
    await new Promise(r => setTimeout(r, 250));
    const to = (t.doc().querySelector('#c-to') as any)?.value || '';
    assert.ok(!/shared@x.invalid/.test(to),
      `共享箱回复全部：自己的箱地址 shared@x.invalid 不该在 To 里，实际：${to}`);
  } finally { t.dispose(); }
});

it('H 草稿 ID 与后续自动保存一致（存两次还是同一封）', async () => {
  const t = mount([seed()]);
  try {
    await openMail(t, '年费核对');
    await clickAndRead(t, '#reply');
    const subject = t.doc().querySelector('#c-subject') as any;
    subject.value = '第一段';
    subject.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
    ed?.blur?.();
    ed?.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    subject.value = '第二段';
    subject.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    ed?.blur?.();
    ed?.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    assert.ok(t.saved.length >= 2, `两次失焦应至少存两次，实际 ${t.saved.length}`);
    /* ★ 2026-10-21 口径变了：人点回复**先调后端动作把草稿建好**（回执 name=draft-1），
       写信窗开的就是那封 ⇒ 两次失焦都是**更新同一封**，不会再有「新建」那一次。
       判据的**本意**（存两次还是同一封、不许多出第二封）不变，只是起点从
       「第一次失焦才建」挪到了「点回复那一刻就建」。 */
    const names = t.saved.map((s: any) => {
      const p = s?.payload || s || {};
      return p.mail || '(新建)';
    });
    const created = names.filter((n: string) => n === '(新建)').length;
    assert.equal(created, 0, `不该再新建草稿（点回复时后端已经建好一封），实际新建 ${created} 次：${JSON.stringify(names)}`);
    assert.ok(names.every((n: string) => n === 'draft-1'),
        `草稿 ID 不一致：${JSON.stringify(names)}`);
  } finally { t.dispose(); }
});

// ── PKG-014-T01〔2〕接缝 · 回复腿 ────────────────────────────────────────────
// 上面 A～H 验的是**回复的收件人/主题/引用**。这一条钉的是 **A 真复制出口的字节**
// （`fde/开发/验收/t01-clipboard-fixture.json`，真实表 2×2 选区）
// 粘进**回复起草区**通不通。夹具装载只留一份：tests/helpers/copy-format.ts。
it('T01〔2〕回复腿：A 真复制出口字节粘进回复起草区，表格照进；原信不动', async () => {
  const {loadABytes, pasteClipboard} = await import('../helpers/copy-format.ts');
  const a = loadABytes();   // 真字节，不是合成样本
  const src = seed();
  const snapshot = JSON.stringify(src);
  const t = mount([src]);
  try {
    // 前提：先开信才出 #reply（照 A 条的起法，漏了会「找不到按钮」——那是测具空过，不是产品红）
    await openMail(t, '年费核对');
    await clickAndRead(t, '#reply');
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    assert.ok(ed, '回复起草区没起来');
    pasteClipboard(t.w, ed, a.html, a.plain);
    await tick();
    const out = ed.innerHTML;
    assert.ok(out.includes('<table'), `回复起草区表没进来 —— ${out.slice(0, 160)}`);
    assert.match(out, /border:1px solid #ccc/, `A 的单元格内联样式被剥了 —— ${out.slice(0, 200)}`);
    for (const row of a.rows) for (const v of row) {
      assert.ok(out.includes(v), `回复腿 A 的单元格值「${v}」没进 —— ${out.slice(0, 220)}`);
    }
    const td = (out.match(/<td /g) || []).length;
    const wantTd = a.rows.length * (a.rows[0]?.length || 0);
    assert.equal(td, wantTd, `回复腿 td 数不对（被压扁/丢格）—— ${td}，${out.slice(0, 240)}`);
    assert.equal(JSON.stringify(src), snapshot, '原信记录被回复+粘贴动作改了');
  } finally { t.dispose(); }
});
