import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';
import {actionReceipt, installReplyForwardAction, quoteBlock} from '../helpers/mail-reply-forward.ts';

/*
 FIX-55 判据：转发/回复时，**引用块里的内联图要能显示**。

 用户 2026-10-20 19:5x 原话：
   「第一，邮件部分转发时，图片转发不了，显示引用的图找不到，这个我记得提过，
     我们需要直接把图片也存到文件中心，用文件中心的路径索引」

 ★ 2026-10-21 改口径：**人点回复/转发 = 调后端那两个动作**
   （`mail.reply` / `mail.forward`，父线 A 方案）。
   ⇒ 图的**入库**、路径索引、**不再存一次**，全部由**后端那一份实现**做
     （`shangshu_mail.quoting` / `shangshu_mail.external_assets`）：
       · 收信那趟已经把图存进文件中心（资源带 `source`）⇒ 转发**不再存一次**；
       · 正文里的外链图收信时抓回来 ⇒ 转发时那张图也已经是文件中心里的东西。
     那些判据在**邮件域**：`shangshu_mail/tests/test_mail_reply_forward.py`
     （`test_already_in_file_center_is_not_stored_again` …）与 `test_external_assets.py`。
     **前端这一层**只管：前端**不再自己**入库（不重复发那条入库请求），
     以及后端给的那份正文在编辑器里**显示得出那张图**、存回去仍是 `cid:`。

 测试通过 = 下面全部成立：
   ① 前端**不再自己**把图送进文件中心（入库只有后端那一份，前端不重复发）
   ② 引用块里那张图在编辑器里**显示得出**（不是破图）
   ③ 存回正文仍是 `cid:`（出站净化门只认 cid:，不许被路径索引顶掉）
   ④ 表格 / 合并格 / 格式照旧保留（护栏）
   ⑤ 原信详情里的图照旧能显示（护栏）
   ⑥ 引用块与新正文的边界照旧（护栏：data-mail-quote）

 跑法：cd shangshu-server && node --import tsx --test tests/website/mail-forward-inline-image.test.ts
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 340));

const CID = 'seal@shangshu.local';
const SIG_CID = 'sig@shangshu.local';
const MAIL_ID = 'm-src';
const FC_RECORD = 'FC-INLINE-1';
const FC_VERSION_FILE = 'F-FC-INLINE-1';

const MAILBOX = {
  id: 'mb-p', kind: 'personal', email: 'me@qq.com', email_address: 'me@qq.com',
  display_name: '我', enabled: true,
  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true},
  /* 默认签名带一张图 —— 签名是用户自己插的图，它**本来就在文件中心**（source 带着那条归属）。 */
  signature: {
    enabled: true,
    html: '<p>签名文字</p><img src="cid:' + SIG_CID + '" alt="签名章">',
    resources: [{content_id: SIG_CID, mime_type: 'image/png', name: 'sig.png', file: 'F-sig',
      source: {ref_doctype: 'Shangshu File Center File', ref_name: 'FC-SIG', file: 'F-sig'}}],
  },
};

/** 来信：带表格（合并格）＋ 一张内联图。 */
const seedMail = (over: any = {}) => ({
  name: MAIL_ID, status: 'Received', subject: '富信源（表格/内嵌图/附件）',
  body_format: 'HTML',
  body: '<p>客户您好,</p>'
    + '<table border="1" cellpadding="4" cellspacing="0" width="420" style="border-collapse:collapse;">'
    + '<thead><tr><th style="border:1px solid #d0d5dd;padding:6px;">项目</th>'
    + '<th style="border:1px solid #d0d5dd;padding:6px;">数量</th></tr></thead>'
    + '<tbody><tr><td colspan="2" style="border:1px solid #d0d5dd;padding:6px;">合计</td></tr>'
    + '<tr><td style="border:1px solid #d0d5dd;padding:6px;">甲</td>'
    + '<td style="border:1px solid #d0d5dd;padding:6px;">3</td></tr></tbody></table>'
    + '<p><img src="cid:' + CID + '" alt="签章" width="48" height="48"></p>',
  record_version: 1,
  from_address: 'billing@example.invalid', from_name: '',
  to: ['我 <me@qq.com>'], cc: [], attachments: [], attachment_bindings: {},
  /* 来信的内联图：**只在原信上**，没进文件中心（没有 source）—— 这就是病根。 */
  inline_resources: [{content_id: CID, mime_type: 'image/png', file: 'F-inline-1', name: '签章.png'}],
  owner: 'me@qq.com', modified: '2026-10-20 12:42:00', message_id: '<src-1@x>',
  date: '2026-10-20 12:42', reply_to_address: '', mailbox_id: 'mb-p',
  ...over,
});

function mount(opts: any = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
    {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const mail = opts.mail || seedMail();
  const calls: any[] = [];
  const reply = (payload: any, ok = true) => ({
    ok, status: ok ? 200 : 500,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  const baseFetch = async (url: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({url, body});
    if (url.includes('/services/mail.account.status/')) {
      const account = {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我'};
      return reply({result: {account}});
    }
    if (url.includes('/services/mail.mailboxes/')) return reply({result: {mailboxes: [MAILBOX]}});
    if (url.includes('/services/mail.detail/')) return reply({result: {mail}});
    if (url.includes('/actions/files.import_attachment/execute')) {
      if (opts.importFails) return reply({ok: false, error: '入库失败'}, false);
      return reply({result: {file: FC_RECORD, version: 1, created: 1, already_imported: false}});
    }
    if (url.includes('/services/files.versions/invoke')) {
      const file = body?.payload?.file;
      const versions = file === FC_RECORD
        ? [{version_no: 1, frappe_file: FC_VERSION_FILE,
            source: {ref_doctype: 'Shangshu File Center File', ref_name: FC_RECORD, file: FC_VERSION_FILE}}]
        : [];
      return reply({result: {file, versions}});
    }
    if (url.includes('/api/platform/file-content')) {
      return {ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8),
        json: async () => ({}), text: async () => ''};
    }
    if (url.includes('/datasets/')) return reply({rows: [mail], total: 1});
    return reply({result: {}});
  };
  /* 后端动作的产物：草稿正文里那张图是 **`cid:` 引用**（后端存草稿时已把路径索引
     还原成 cid:，出站净化门只认 cid:），并**随草稿带走**那条受管内联资源。 */
  const backendReceipt = (actionId: string, payload: any) => actionReceipt({
    subject: payload.subject || undefined,
    to: payload.to || [],
    cc: payload.cc || [],
    body: quoteBlock({
      from: mail.from_address, date: mail.date, to: mail.to, cc: mail.cc,
      subject: mail.subject,
      body: mail.body,
    }),
    inline_resources: [{content_id: CID, mime_type: 'image/png', file: 'F-inline-1', name: '签章.png'}],
  });
  w.fetch = installReplyForwardAction(baseFetch, {
    receipt: opts.receipt ?? backendReceipt,
  });
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, calls, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openMail(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes('富信源')) as any;
  assert.ok(item, '列表里找不到那封带内联图的信');
  item.click();
  for (let i = 0; i < 30; i++) { if (t.doc().querySelector('#forward')) break; await tick(); await tick(); }
  assert.ok(t.doc().querySelector('#forward'), '没有「转发」按钮');
}

/** 点转发，等写信窗开出来（动作要落库才能带引用块与图，是异步的）。 */
async function forward(t: ReturnType<typeof mount>) {
  await openMail(t);
  (t.doc().querySelector('#forward') as any).click();
  for (let i = 0; i < 60; i++) {
    if (t.doc().querySelector('#c-editor-host .mail-body-editor')) break;
    await tick(); await tick();
  }
  await settle();
}

const editor = (t: ReturnType<typeof mount>) =>
  t.doc().querySelector('#c-editor-host .mail-body-editor') as any;
const quoteOf = (t: ReturnType<typeof mount>) => editor(t)?.querySelector('[data-mail-quote]') as any;

it('① 前端不再自己把图送进文件中心 —— 入库只有后端那一份（不重复发那条请求）', async () => {
  /* 人点转发现在是**调后端动作**：图的入库、路径索引都在后端做（`shangshu_mail.quoting`）。
     前端再发一遍入库请求 = 同一份资源存两次（用户 2026-10-21：「转发的时候就不用再保存一次了」）。 */
  const t = mount();
  try {
    await forward(t);
    const imports = t.calls.filter((c: any) => c.url.includes('files.import_attachment'));
    assert.equal(imports.length, 0,
        `前端又自己发了一次入库请求（同一份资源不该存多份）：${imports.length} 次`);
    const verCalls = t.calls.filter((c: any) => c.url.includes('files.versions'));
    assert.equal(verCalls.length, 0, '前端还在自己查文件中心版本（路径索引是后端算的）');
  } finally { t.dispose(); }
});

it('② 引用块里那张图在编辑器里显示得出（不是破图）', async () => {
  const t = mount();
  try {
    await forward(t);
    const ed = editor(t);
    assert.ok(ed, '转发后没开写信窗');
    const quote = quoteOf(t);
    assert.ok(quote, '没有引用块');
    const img = quote.querySelector('img') as any;
    assert.ok(img, '引用块里没有那张图');
    const src = String(img.getAttribute('src') || '');
    assert.ok(!/^cid:/i.test(src),
        `图还停在 cid: 引用（没解析出字节 = 破图）：${src}`);
    assert.ok(/^data:image\//i.test(src) || /file-content/.test(src),
        `图没解析成可显示的：${src.slice(0, 60)}`);
  } finally { t.dispose(); }
});

it('③ 存回正文仍是 cid: 引用 —— 出站净化门只认 cid:，路径索引不许顶掉它', async () => {
  const t = mount();
  try {
    await forward(t);
    const ed = editor(t);
    assert.ok(ed, '转发后没开写信窗');
    ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    ed.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 500));
    const body = String((t.doc().querySelector('#c-body') as any)?.value || '');
    assert.ok(body.includes('src="cid:' + CID + '"'),
        `存回正文里没有 cid: 引用（收件人那边会破图）：${body.slice(0, 300)}`);
    assert.ok(!body.includes('/api/platform/file-content'),
        `存回正文里留了文件中心路径索引（出站净化门只认 cid:）：${body.slice(0, 300)}`);
  } finally { t.dispose(); }
});

it('④ 表格、合并格、格式照旧保留（护栏）', async () => {
  const t = mount();
  try {
    await forward(t);
    const quote = quoteOf(t);
    assert.ok(quote, '没有引用块');
    assert.ok(quote.querySelector('table'), '引用块里的表格没了');
    const merged = quote.querySelector('td[colspan="2"]');
    assert.ok(merged, '引用块里的合并格没了');
    assert.match(merged.textContent || '', /合计/, '合并格里的文字没了');
    assert.match(quote.innerHTML || '', /border-collapse/, '表格的格式没了');
  } finally { t.dispose(); }
});

it('⑤ 原信详情里的图照旧能显示（护栏）', async () => {
  const t = mount();
  try {
    await openMail(t);
    await settle(); await settle();
    const surface = t.doc().querySelector('[data-mail-body-wysiwyg] .mail-body-editor') as any;
    assert.ok(surface, '没有正文面');
    const html = String(surface.innerHTML || '');
    assert.match(html, /data:image\/png;base64,/,
        `原信详情里的图没解析出来：${html.slice(0, 300)}`);
  } finally { t.dispose(); }
});

it('⑥ 引用块与新正文的边界照旧（护栏：data-mail-quote）', async () => {
  const t = mount();
  try {
    await forward(t);
    const ed = editor(t);
    const quote = quoteOf(t);
    assert.equal(quote.getAttribute('data-mail-quote'), '1', '引用块标记没了');
    const kids = [...ed.children] as any[];
    const idx = kids.findIndex((c: any) => c.hasAttribute && c.hasAttribute('data-mail-quote'));
    assert.ok(idx > 0, '引用块成了正文的第一个元素（用户没有落笔的地方）');
    assert.ok(!quote.contains(kids[0]), '用户写字区被包进了引用块');
  } finally { t.dispose(); }
});
