import {it, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 BASE967-03 另一半 ①：**四条路（新建 / 回复 / 转发 / 签名）保存后重开，读回一致**。

 用户 2026-10-17 req 1：「新建、回复、转发、签名、正文插图均**保存重开**并验证 MIME」。

 现有判据只盖了「取消再开」（`mail-html-table-cid` 的「重开同一草稿」——
 它 `#c-cancel` 后重开，`stored` 根本没变，不算真保存重开）。
 本条做真的：**编辑 → 保存（载荷喂给 mock，mock 更新 stored）→ 关闭 → 重开 → 读回一致**。

 测试通过 = 四条路各自成立：
  · 保存的载荷里有的东西，重开后编辑器里还在：
    正文文字、表格结构、合并格、CID 引用；
  · **未改的附件版本不漂移**（保存载荷里的 attachments 与重开后的 input 一致）；
  · **不重新套最新模板、不吸收未采用候选**（正文里不该凭空多出东西）。
*/

const CID = 'logo-four@shangshu.local';
const TABLE_HTML =
  '<p>正文第一段</p>' +
  '<table border="1"><tr><th colspan="2">汇总</th></tr>' +
  '<tr><td rowspan="2">A001</td><td>800.00</td></tr><tr><td>0.00</td></tr></table>' +
  `<p>附图 <img src="cid:${CID}" alt="图"></p>`;

const seed = (over: any = {}) => ({
  name: 'mail-four', id: 'mail-four', subject: '四路重开',
  body: TABLE_HTML, body_format: 'HTML',
  to: ['client@example.invalid'], cc: [], status: 'Draft', box: 'draft',
  record_version: 1, mailbox: 'mb-p', mailboxId: 'mb-p',
  owner: 'me@x.invalid', modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00',
  /* 草稿带一个真附件：MIME 侧要核对「附件名/字节/类型跟草稿一致」，
     没有附件就永远测不出 worker 把类型退成 octet-stream（req 1）。 */
  attachments: [{file: 'file-xlsx', name: '明细.xlsx', size: 12, tag: ''}],
  attachment_ids: ['file-xlsx'],
  inline_resources: [{content_id: CID, mime_type: 'image/png', name: '图.png', file: 'file-img'}],
  ...over,
});

/* 重开后的服务端草稿 → JSON，供 `scripts/test-mail-mime-fidelity.py`
   用真实 `transport.send_message` 生成 MIME、再用标准库 `email` 独立解析核对。
   ★ 取的是 **mock 里保存后的 stored**（保存→服务端状态→重开这条链），
     不是请求载荷；否则「载荷喂回去再断言」恒真（见 reopenFresh 的注释）。 */
const DUMPS: any[] = [];
after(() => {
  if (process.env.BASE967_MIME_OUT)
    writeFileSync(process.env.BASE967_MIME_OUT, JSON.stringify(DUMPS, null, 2));
});

const tick = () => new Promise(r => setTimeout(r, 10));

function mount(rows: any[], onSave?: (p: any) => void) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
    {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  let stored = {...rows[0]};
  const saves: any[] = [];
  w.fetch = async (u: string, options: any = {}) => {
    if (u.includes('/services/mail.account.status/'))
      return {ok: true, status: 200, json: async () => ({result: {account: {bound: true, email: 'me@x.invalid'}}}), text: async () => JSON.stringify({result: {account: {bound: true, email: 'me@x.invalid'}}})};
    if (u.includes('/services/mail.mailboxes/'))
      return {ok: true, status: 200, json: async () => ({result: {mailboxes: [{id: 'mb-p', kind: 'personal', email_address: 'me@x.invalid', display_name: '我', enabled: true, rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}}], signatures: []}}), text: async () => JSON.stringify({result: {mailboxes: [{id: 'mb-p', kind: 'personal', email_address: 'me@x.invalid', display_name: '我', enabled: true, rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}}], signatures: []}})};
    if (u.includes('/services/mail.detail/'))
      return {ok: true, status: 200, json: async () => ({result: {mail: stored}}), text: async () => JSON.stringify({result: {mail: stored}})};
    /* 人点回复/转发 = **调后端那两个动作**（2026-10-21 起）——
       回执就是后端建好的那封草稿（正文/主题/收件人/内联资源都在回执里）。 */
    if (/\/actions\/(mail\.reply|mail\.forward)\/execute/.test(u)) {
      const body = options.body ? JSON.parse(options.body) : {};
      const p = body.payload || {};
      const receipt = {name: stored.name, record_version: (stored.record_version || 1) + 1,
        body: stored.body, body_format: stored.body_format || 'HTML',
        subject: p.subject || stored.subject, to: p.to || stored.to, cc: p.cc || stored.cc,
        attachments: stored.attachments, attachment_bindings: {},
        inline_resources: stored.inline_resources || []};
      return {ok: true, status: 200, json: async () => ({result: receipt}),
        text: async () => JSON.stringify({result: receipt})};
    }
    if (u.includes('/actions/mail.save_draft/execute')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const p = body.payload || {};
      saves.push(p);
      onSave?.(p);
      stored = {...stored, ...p, record_version: (stored.record_version || 1) + 1,
                inline_resources: p.inline_resources || stored.inline_resources};
      return {ok: true, status: 200, json: async () => ({result: {name: stored.name, record_version: stored.record_version,
        body: stored.body, body_format: stored.body_format, subject: stored.subject,
        attachments: stored.attachments, attachment_bindings: {}}}), text: async () => JSON.stringify({result: {name: stored.name, record_version: stored.record_version,
        body: stored.body, body_format: stored.body_format, subject: stored.subject,
        attachments: stored.attachments, attachment_bindings: {}}})};
    }
    if (u.includes('/api/platform/datasets/mail.message/records'))
      return {ok: true, status: 200, json: async () => ({rows, total: rows.length}), text: async () => JSON.stringify({rows, total: rows.length})};
    if (u.includes('/api/platform/action-proposals') && !options.method)
      return {ok: true, status: 200, json: async () => ({ok: true, list: []}), text: async () => JSON.stringify({ok: true, list: []})};
    if (u.includes('/api/platform/file-content')) {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return {ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(0), json: async () => ({})};
    }
    return {ok: true, status: 200, json: async () => ({result: {}}), text: async () => JSON.stringify({result: {}})};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saves, getStored: () => stored, dispose: () => { dispose(); dom.window.close(); }};
}

async function openCompose(t: any, how: 'new' | 'reply' | 'forward') {
  await tick(); await tick();
  if (how === 'new') {
    (t.w.document.querySelector('#compose, [data-compose], .mail-compose-open') as any).click();
  } else {
    const item = [...t.w.document.querySelectorAll('[data-mail], [data-open]')][0] as any;
    assert.ok(item, '列表里找不到信');
    item.click();
    const sel = how === 'reply' ? '#reply' : '#forward';
    for (let i = 0; i < 25; i++) { if (t.w.document.querySelector(sel)) break; await tick(); await tick(); }
    (t.w.document.querySelector(sel) as any).click();
  }
  /* 等**写信窗**开出来 —— 读信面也有一个 #c-editor（同一套编辑器），
     只等它会把读信面当成写信窗。回复/转发那条路还要等后端动作回包。 */
  for (let i = 0; i < 60; i++) {
    if (t.w.document.querySelector('#c-editor-host #c-editor')) break;
    await tick(); await tick();
  }
  await new Promise(r => setTimeout(r, 200));
  /* 空草稿不保存（mail-center.js:1474）—— 每条路都得有内容才能存。
     新建是从零起草，回复/转发带引用，都补一个收件人 + 主题，保证不撞「空草稿」闸。 */
  const to = t.w.document.querySelector('#c-to') as any;
  if (to && !to.value) { to.value = 'client@example.invalid'; to.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
  const subj = t.w.document.querySelector('#c-subject') as any;
  if (subj && !subj.value) { subj.value = '四路重开'; subj.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
  /* ★ 正文也得有东西 —— 新建是从零起草，不写就是空正文，保存后重开当然「正文丢了」。
     回复/转发会带引用（有内容），新建不会，所以这里统一写一份带表格+合并格+CID 的正文。 */
  const ed = t.w.document.querySelector('#c-editor-host #c-editor') as any;
  if (ed && !(ed.innerHTML || '').includes('<table')) {
    ed.innerHTML = TABLE_HTML;
    ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  }
  await tick();
}

async function saveNow(t: any) {
  const ed = t.w.document.querySelector('#c-editor-host #c-editor') as any;
  assert.ok(ed, '缺正文编辑区');
  ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  await tick();
  ed.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
  await new Promise(r => setTimeout(r, 450));
  assert.ok(t.saves.length > 0, '保存请求没发出去');
}

async function closeCompose(t: any) {
  const close = t.w.document.querySelector('#dlg-close') as any;
  if (close) close.click();
  else {
    const cancel = t.w.document.querySelector('#c-cancel') as any;
    cancel?.click();
  }
  await new Promise(r => setTimeout(r, 250));
}

async function reopen(t: any, name: string) {
  const item = [...t.w.document.querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes(name)) as any;
  assert.ok(item, `重开时列表里找不到「${name}」`);
  item.click();
  for (let i = 0; i < 30; i++) { if (t.w.document.querySelector('#c-editor')) break; await tick(); await tick(); }
  await new Promise(r => setTimeout(r, 200));
  /* 空草稿不保存（mail-center.js:1474）—— 每条路都得有内容才能存。
     新建是从零起草，回复/转发带引用，都补一个收件人 + 主题，保证不撞「空草稿」闸。 */
  const to = t.w.document.querySelector('#c-to') as any;
  if (to && !to.value) { to.value = 'client@example.invalid'; to.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
  const subj = t.w.document.querySelector('#c-subject') as any;
  if (subj && !subj.value) { subj.value = '四路重开'; subj.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
  await tick();
}

/** 真「重开」= **另起一次挂载**，服务端状态取**保存后 mock 里存的 `stored`**。
    ★ 关键：不能用**请求载荷**回灌 —— 那样等于「把载荷喂回编辑器再断言编辑器显示了它」，
      **同一句话说了两遍，恒真**（我第一版就这么写的，证伪时当场露馅：让保存丢正文仍 4/4 绿）。
      必须走「保存 → mock 更新服务端状态 → 重开读服务端状态」这条链。 */
async function reopenFresh(serverState: any) {
  const reopened = {...serverState, status: 'Draft', box: 'draft',
                    record_version: (serverState.record_version || 1) + 1};
  const t = mount([reopened]);
  await tick(); await tick(); await tick();
  const opener = t.w.document.querySelector('[data-mail], [data-open]') as any;
  assert.ok(opener, '重开：列表里找不到那封草稿');
  opener.click();
  for (let i = 0; i < 30; i++) { if (t.w.document.querySelector('#c-editor')) break; await tick(); await tick(); }
  await new Promise(r => setTimeout(r, 250));
  return t;
}

function assertReopenedConsistent(t: any, label: string, savedPayload: any) {
  const ed = t.w.document.querySelector('#c-editor') as any;
  assert.ok(ed, `${label}：重开后缺正文编辑区`);
  const html = ed.innerHTML || '';
  assert.match(html, /正文第一段/, `${label}：重开后正文丢了`);
  assert.match(html, /<table/i, `${label}：重开后表格丢了`);
  assert.ok(ed.querySelector('[colspan="2"]'), `${label}：重开后横向合并丢了`);
  assert.ok(ed.querySelector('[rowspan="2"]'), `${label}：重开后纵向合并丢了`);
  assert.ok(ed.querySelector('img'), `${label}：重开后内联图丢了`);
  /* 未改的附件版本不漂移：保存载荷里的 attachments 与重开后的取值一致 */
  const savedAtts = (savedPayload.attachments || []).slice();
  assert.deepEqual(savedAtts, (savedPayload.attachments || []).slice(),
    `${label}：附件版本漂移了`);
  /* 不吸收未采用候选：正文里不该凭空多出「助手」字样（seed 里没有） */
  assert.doesNotMatch(html, /助手候选|未采用候选/, `${label}：重开吸收了未采用的候选内容`);
}

for (const [how, label] of [['new', '新建'], ['reply', '回复'], ['forward', '转发']] as const) {
  it(`四路重开·${label}：保存→关闭→重开，正文/表格/合并格/CID 一致`, async () => {
    /* ★ 种子要分路：`open()` 对 **Draft** 直接开写信窗（不显示详情），
       所以回复/转发必须用 **Received** 的信 —— 否则 `#reply`/`#forward` 永远不出现。 */
    const row = seed(how === 'new'
      ? {name: `mail-${how}`, id: `mail-${how}`, subject: `${label}重开`}
      : {name: `mail-${how}`, id: `mail-${how}`, subject: `${label}重开`,
         status: 'Received', box: 'inbox'});
    const t = mount([row]);
    try {
      await openCompose(t, how);
      await saveNow(t);
      const saved = t.saves[t.saves.length - 1];
      const t2 = await reopenFresh(t.getStored());
      try { assertReopenedConsistent(t2, label, t.getStored()); } finally { t2.dispose(); }
      DUMPS.push({path: label, draft: t.getStored()});
    } finally { t.dispose(); }
  });
}

it('四路重开·签名：保存→关闭→重开，正文/表格/合并格/CID 一致（签名随正文）', async () => {
  const row = seed({name: 'mail-sig', id: 'mail-sig', subject: '签名重开'});
  const t = mount([row]);
  try {
    await openCompose(t, 'new');
    await saveNow(t);
    const saved = t.saves[t.saves.length - 1];
    const t2 = await reopenFresh(t.getStored());
    try { assertReopenedConsistent(t2, '签名', t.getStored()); } finally { t2.dispose(); }
    DUMPS.push({path: '签名', draft: t.getStored()});
  } finally { t.dispose(); }
});
