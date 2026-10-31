import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';
import {actionReceipt, installReplyForwardAction, quoteBlock} from '../helpers/mail-reply-forward.ts';

/*
 计划 §6 的 C2 —— 转发、引用和附件选择。

 ★ 2026-10-21 改口径：**人点回复/转发 = 调后端那两个动作**
   （`mail.reply` / `mail.forward`，父线 A 方案）。
   引用块、原信内联图的文件中心路径索引、默认签名 —— 全部由**后端那一份实现**
   （`shangshu_mail.quoting`）产出；前端不再自己拼正文字符串。

   ⇒ 这一层判据只管**前端这一段**：
     · 点了「转发/回复」调的是**哪个动作**、**传了什么**；
     · 打开的写信窗**是不是后端那封草稿**（不是前端自己拼的一封）；
     · 后端给的那份正文**在编辑器里没被剥坏**（表格/引用块/图都在）；
     · 附件**显式选择**、动作失败**明说失败**。
   引用块的**形状**归邮件域（`shangshu_mail/tests/test_mail_reply_forward.py`）；
   入库/不再存一次也归后端（同上 + `test_external_assets.py`）。

 测试通过 = 下面全部成立：

   A. 点「转发」⇒ 调 **mail.forward**；点「回复」⇒ 调 **mail.reply**
      （载荷带原信编号 `reply_to_mail`、主题带 `Re:`/`Fwd:`、收件人是后端认的地址串）
   B. 打开的写信窗**就是后端那封草稿**（已落库、有草稿编号；正文/主题是后端回执那份）
   C. 后端给的正文里的 **HTML 表格**在编辑器里保留（不是压成纯文本）
   D. 引用块在编辑器里**看得见**（分界文字 + 引用标记）
   E. 普通附件**显式选择**——不默认全带；可选区里**文件名看得见**
   F. 动作失败 ⇒ **明说失败**，不静默开出一封空草稿
   G. 转发建的是**独立草稿**，原信一字不动
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 340));

const CID = 'seal@shangshu.local';

function mount(rows: any[], opts: any = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  const actionCalls: {id: string; payload: any}[] = [];
  const fileFetches: string[] = [];
  const baseFetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected', email: 'me@qq.com', display_name: '我'}}})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(options.body ? JSON.parse(options.body) : {});
      const receipt = {name: 'fwd-1', record_version: saved.length, attachments: [], attachment_bindings: {}};
      return {ok: true, status: 200,
        json: async () => ({result: receipt}), text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === body?.payload?.mail) || rows[0] || {};
      return {ok: true, status: 200,
        json: async () => ({result: {mail: found}}), text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/api/platform/file-content')) {
      fileFetches.push(url);
      return {ok: true, status: 200,
        arrayBuffer: async () => new ArrayBuffer(8),
        json: async () => ({}), text: async () => ''};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  /* 把「调后端动作」这一段装进 fetch 夹具：命中的动作回**后端的产物**，
     记下这次调了什么（判据要断言「调了哪个动作、传了什么」）。
     默认回包 = 后端存出来的那封草稿：正文是**原信正文**进引用块（表格/图都在）。 */
  const row = rows[0] || {};
  const defaultReceipt = (actionId: string, payload: any) => actionReceipt({
    subject: payload.subject || undefined,
    to: payload.to || [],
    cc: payload.cc || [],
    body: quoteBlock({from: row.from_address, date: row.date, to: row.to,
      cc: row.cc, subject: row.subject, body: row.body}),
  });
  w.fetch = installReplyForwardAction(baseFetch, {
    onCall: (id, payload) => actionCalls.push({id, payload}),
    fail: opts.actionFails,
    receipt: opts.receipt ?? defaultReceipt,
  });
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saved, actionCalls, fileFetches, doc: () => w.document,
    dispose: () => { dispose(); dom.window.close(); }};
}

/** 打开那封信的详情，点指定的按钮，等写信窗开出来。 */
async function openAndClick(t: ReturnType<typeof mount>, subject: string, buttonId: string) {
  await tick(); await tick();
  const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes(subject)) as any;
  assert.ok(item, `列表里找不到「${subject}」`);
  item.click();
  for (let i = 0; i < 30; i++) { if (t.doc().querySelector(buttonId)) break; await tick(); await tick(); }
  const button = t.doc().querySelector(buttonId) as any;
  assert.ok(button, `详情里没有「${buttonId}」按钮`);
  button.click();
  for (let i = 0; i < 40; i++) { if (composeHtml(t) !== null) break; await tick(); await tick(); }
  await settle();
}

/** **写信窗**的正文（HTML）—— 只认写信窗里的那一个面（读信面也是 .mail-body-editor）。 */
function composeHtml(t: ReturnType<typeof mount>) {
  const ed = t.doc().querySelector('#c-editor-host .mail-body-editor') as any;
  return ed ? (ed.innerHTML || '') : null;
}

/** 读写信窗的正文（HTML）。 */
function bodyHtml(t: ReturnType<typeof mount>) {
  const html = composeHtml(t);
  if (html !== null) return html;
  const ed = t.doc().querySelector('.mail-body-editor') as any;
  return ed ? (ed.innerHTML || '') : ((t.doc().querySelector('#c-body') as any)?.value || '');
}

const seed = (over: any = {}) => ({
  name: 'm-src', status: 'Received', subject: '年费账单', body_format: 'HTML',
  body: '<p>请查收</p><table style="border-collapse:collapse"><tbody>'
      + '<tr><td colspan="2">汇总</td></tr><tr><td>甲</td><td>007</td></tr>'
      + '</tbody></table><p><img src="cid:' + CID + '" alt="签章"></p>',
  record_version: 1,
  from_address: '张三 <billing@client.example>', from_name: '张三',
  to: ['我 <me@qq.com>'], cc: [],
  attachments: [{name: '账单.xlsx', file: 'F-1', size: 2048, tag: '账单'}],
  inline_resources: [{content_id: CID, mime_type: 'image/png', file: 'F-img', name: '签章.png'}],
  attachment_bindings: {},
  owner: 'me@qq.com', modified: '2026-10-12 10:00:00',
  message_id: '<src-1@client.example>', date: '2026-10-12 09:30',
  ...over,
});

it('A 点「转发」调的是 mail.forward、点「回复」调的是 mail.reply，载荷按后端的口径送', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '年费账单', '#forward');
    assert.equal(t.actionCalls.length, 1, `转发该调一次后端动作，实际调了 ${t.actionCalls.length} 次`);
    assert.equal(t.actionCalls[0].id, 'mail.forward', '转发调错了动作');
    const payload = t.actionCalls[0].payload;
    assert.equal(payload.reply_to_mail, 'm-src', '载荷里没带原信编号（后端不知道引用哪封）');
    assert.match(String(payload.subject || ''), /^Fwd: /,
        `转发主题没带 Fwd:：${JSON.stringify(payload.subject)}`);
    assert.ok(Array.isArray(payload.to), '收件人得是数组');
    for (const value of payload.to) {
      assert.equal(typeof value, 'string',
          `收件人得送地址串（后端只收字符串）：${JSON.stringify(value)}`);
    }
    assert.ok(!payload.body, '正文不该由前端拼（引用块是后端那份实现的产物）');

    /* 再点一次「回复」⇒ 另一个动作（同一封原信）。 */
    (t.doc().querySelector('#c-cancel') as any).click();
    await tick(); await tick();
    await openAndClick(t, '年费账单', '#reply');
    const replyCall = t.actionCalls[t.actionCalls.length - 1];
    assert.equal(replyCall.id, 'mail.reply', '回复调错了动作');
    assert.equal(replyCall.payload.reply_to_mail, 'm-src');
    assert.match(String(replyCall.payload.subject || ''), /^Re: /,
        `回复主题没带 Re:：${JSON.stringify(replyCall.payload.subject)}`);
  } finally { t.dispose(); }
});

it('B 打开的写信窗就是后端那封草稿（已落库、有草稿编号、正文是后端回执那份）', async () => {
  const receipt = actionReceipt({
    name: 'DRAFT-FROM-BACKEND', subject: 'Fwd: 年费账单（后端改过的主题）',
    body: quoteBlock({body: '<p>这是后端引用块里的原信正文</p>'})});
  const t = mount([seed()], {receipt});
  try {
    await openAndClick(t, '年费账单', '#forward');
    /* 主题 = 后端回执那份（不是前端自己拼的那个）。 */
    assert.equal((t.doc().querySelector('#c-subject') as any).value, 'Fwd: 年费账单（后端改过的主题）',
        '写信窗主题不是后端回执那份');
    /* 正文 = 后端回执那份。 */
    const html = bodyHtml(t);
    assert.match(html, /这是后端引用块里的原信正文/,
        `写信窗正文不是后端回执那份：${html.slice(0, 200)}`);
    /* 已落库的草稿 ⇒ 写信窗里有「删除草稿」（新开的一封没有）。 */
    const del = t.doc().querySelector('#trash-draft') as any;
    assert.ok(del, '没开出「删除草稿」—— 这不是后端建好的那封草稿');
    assert.ok(!del.hasAttribute('hidden'), '「删除草稿」被藏起来了 —— 这不是一封已落库的草稿');
  } finally { t.dispose(); }
});

it('C 后端给的正文里的 HTML 表格在编辑器里保留（不是压成纯文本）', async () => {
  const receipt = actionReceipt({body: quoteBlock({
    body: '<table style="border-collapse:collapse"><tbody>'
        + '<tr><td colspan="2">汇总</td></tr><tr><td>甲</td><td>007</td></tr>'
        + '</tbody></table>'})});
  const t = mount([seed()], {receipt});
  try {
    await openAndClick(t, '年费账单', '#forward');
    const html = bodyHtml(t);
    assert.match(html, /<table/i, `编辑器把表格压成纯文本了（没有 <table>）：${html.slice(0, 200)}`);
    assert.match(html, /colspan/i, `合并格丢了：${html.slice(0, 200)}`);
    assert.match(html, /汇总/, `表格内容丢了：${html.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('D 引用块在编辑器里看得见（分界文字 + 引用标记）', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '年费账单', '#forward');
    const html = bodyHtml(t);
    assert.match(html, /原始邮件/,
        `看不到「原始邮件」这个文字分界：${html.slice(0, 200)}`);
    assert.match(html, /-{2,}\s*原始邮件\s*-{2,}/,
        `分界不是「横杠 + 原始邮件」这种真实客户端的写法：${html.slice(0, 200)}`);
    assert.ok(t.doc().querySelector('[data-mail-quote]'),
        `编辑器里没有引用块：${html.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('E 普通附件显式选择，不默认全带（可选区在、文件名看得见）', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '年费账单', '#forward');
    const zone = t.doc().querySelector('#c-att-optional') as any;
    assert.ok(zone, '没有「原信附件（可选）」这块');
    assert.match(zone.textContent || '', /原信附件/,
        `这块标题不对：${(zone.textContent || '').slice(0, 80)}`);
    assert.match(zone.textContent || '', /账单/,
        `可选附件里看不到文件名：${(zone.textContent || '').slice(0, 80)}`);
  } finally { t.dispose(); }
});

it('F 动作失败 ⇒ 明说失败，不静默开出一封空草稿', async () => {
  const t = mount([seed()], {actionFails: true});
  try {
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('年费账单')) as any;
    assert.ok(item, '列表里找不到夹具信');
    item.click();
    for (let i = 0; i < 30; i++) { if (t.doc().querySelector('#forward')) break; await tick(); await tick(); }
    (t.doc().querySelector('#forward') as any).click();
    await settle();
    const toast = lastToast(t.w) as any;
    const shown = toast ? (toast.textContent || '') : '';
    assert.ok(shown.length > 0, '动作失败了却一声不吭（人以为转发出去了）');
    assert.ok(!t.doc().querySelector('#c-editor-host .mail-body-editor'),
        '动作失败了还开出一封空草稿 —— 人会以为转发成功了');
  } finally { t.dispose(); }
});

it('G 转发建的是独立草稿，原信一字不动', async () => {
  const src = seed();
  const snapshot = JSON.stringify(src);
  const t = mount([src]);
  try {
    await openAndClick(t, '年费账单', '#forward');
    assert.ok(t.doc().querySelector('#c-subject'), '转发没开出写信窗');
    assert.equal(JSON.stringify(src), snapshot, '原信记录被转发动作改了');
  } finally { t.dispose(); }
});

// ── PKG-014-T01〔2〕接缝 · 转发腿 ────────────────────────────────────────────
// B 条验的是**引用里的原表**不被剥。这一条钉的是 **A 真复制出口的字节**
// （`fde/开发/验收/t01-clipboard-fixture.json`，真实表 2×2 选区）
// 粘进**转发起草区**通不通。夹具装载只留一份：tests/helpers/copy-format.ts。
it('T01〔2〕转发腿：A 真复制出口字节粘进转发起草区，表格照进；引用里原表不被剥', async () => {
  const {loadABytes, pasteClipboard} = await import('../helpers/copy-format.ts');
  const a = loadABytes();   // 真字节，不是合成样本
  const t = mount([seed()]);
  try {
    await openAndClick(t, '年费账单', '#forward');
    const ed = t.doc().querySelector('#c-editor-host .mail-body-editor') as any;
    assert.ok(ed, '转发起草区没起来');
    pasteClipboard(t.w, ed, a.html, a.plain);
    await tick();
    const out = ed.innerHTML;
    assert.ok(out.includes('<table'), `转发起草区表没进来 —— ${out.slice(0, 160)}`);
    for (const row of a.rows) for (const v of row) {
      assert.ok(out.includes(v), `转发腿 A 的单元格值「${v}」没进 —— ${out.slice(0, 220)}`);
    }
    // 粘进去的新表（A 真 2×2 = 4 格）+ 引用里的原表，两者都在
    const wantTd = a.rows.length * (a.rows[0]?.length || 0);
    const tds = (out.match(/<td /g) || []).length;
    assert.ok(tds >= wantTd,
        `转发腿 td 数不对（粘的表被压扁/丢格）—— ${tds}，应≥${wantTd}，${out.slice(0, 240)}`);
    // 引用里的原表不被剥（B 条的边再钉一次：粘贴动作不该殃及引用）
    assert.match(out, /汇总/, `引用里的原表内容被剥了 —— ${out.slice(0, 220)}`);
  } finally { t.dispose(); }
});


/* ── BASE967-03 前后端 schema 一致 · 回复/转发腿 ─────────────────────────────
   用户 2026-10-17 C01 第 1 条：「inline_resources 前后端 schema 一致…
   **不能允许任意未知字段**」。白名单那半在 `mail-html-table-cid`（新建腿）；
   这条把**回复/转发腿**的载荷也钉上 —— 这个 mount 能开详情（`openAndClick`），
   所以放这里，不放 `mail-html-table-cid`（那个 mount 只渲染写信窗，开不出详情）。

   测试通过 = 转发/回复保存时，`inline_resources` 里每个资源**只有 schema 白名单
   4 个字段**（content_id / mime_type / name / file），未知字段不跟出去。

   ★ 后端 `domain.py` 的 INLINE_RESOURCE 是 `additionalProperties:False`；
     前端发得出 / 后端收不下就是 UI044 那条根因。 */
const SCHEMA_FIELDS = ['content_id', 'mime_type', 'name', 'file'];

for (const [tag, label, openHow] of [
  ['fwd',   '转发', 'forward'],
  ['reply', '回复', 'reply'],
] as const) {
  it(`${label}腿：保存载荷里 inline_resources 过 schema 白名单，未知字段不跟出去`, async () => {
    const src = seed();
    /* 夹具故意在 inline_resources 里塞 schema 外字段 —— 这正是 UI044 的形状
       （后端回执里带 `source`，前端不许原样往外送）。
       正文里**引用那张图**（`cid:`）—— 不引用的话编辑器会把它当没用的资源剔掉。 */
    const receipt = actionReceipt({
      inline_resources: [
        {content_id: CID, mime_type: 'image/png', file: 'F-img', name: '签章.png',
         source: {ref_doctype: 'Shangshu File Center File', ref_name: 'lib', file: 'F-img'},
         evil: 'x'},
      ],
      body: quoteBlock({body: `<p><img src="cid:${CID}" alt="签章"></p>`})});
    const t = mount([src], {receipt});
    try {
      await openAndClick(t, '年费账单', openHow === 'forward' ? '#forward' : '#reply');
      const ed = t.doc().querySelector('#c-editor-host .mail-body-editor') as any;
      assert.ok(ed, `${label}：缺写信正文区`);
      ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
      await tick();
      ed.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
      await new Promise(r => setTimeout(r, 500));
      assert.ok(t.saved.length, `${label}：没存过草稿`);
      const body = t.saved[t.saved.length - 1]?.payload ?? t.saved[t.saved.length - 1];
      const list = body?.inline_resources || [];
      assert.ok(list.length > 0, `${label}：载荷里 inline_resources 是空的 —— 夹具没生效`);
      for (const [j, item] of list.entries()) {
        const extra = Object.keys(item).filter(k => !SCHEMA_FIELDS.includes(k));
        assert.deepEqual(extra, [],
          `${label}：载荷里 inline_resources[${j}] 带了 schema 外字段：${extra.join('、')} —— `
          + `后端 INLINE_RESOURCE 是 additionalProperties:False，带出去就是前后端不一致（UI044）`);
      }
    } finally { t.dispose(); }
  });
}
