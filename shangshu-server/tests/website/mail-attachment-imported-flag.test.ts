/* ── UI-053 附件 import 标记判据 ─────────────────────────────────────────────
   req 6：「**已引用文件不能显示「未入库」**」+「**只读 Draft 不能显示 Received**」。

   现在的 shared-mailbox S11（line 311）只验了「未入库附件**显示原因**」 ——
   **没盖这两条反例**：
   · 已引用但还没真入库的附件**不能在 UI 上显示「未入库」**（这是 `imported` 标记的产品逻辑），
     强制入库是另一回事（用户原话「已引用文件不能显示「未入库」」）
   · 只读 Draft 不能标 Received（UI-053 的「只读 Draft 不能显示 Received」）

   测试通过 = 两条都成立：
   · `imported: true` 的附件**不会出现**「未入库」字样；
   · `box: 'draft' + rights.edit_draft: false` 的信**不会**被 UI 标成 Received。 */
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

const tick = () => new Promise(r => setTimeout(r, 10));

function mount(opts: any) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
    {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const mail = opts.mail;
  w.fetch = async (u: string, o: any = {}) => {
    if (u.includes('/services/mail.account.status/'))
      return {ok: true, status: 200, json: async () => ({result: {account: {bound: true, email: 'me@x.invalid'}}})};
    if (u.includes('/services/mail.mailboxes/'))
      return {ok: true, status: 200, json: async () => ({result: {mailboxes: [opts.mailbox]}})};
    if (u.includes('/services/mail.detail/'))
      return {ok: true, status: 200, json: async () => ({result: {mail}})};
    if (u.includes('/api/platform/datasets/mail.message/records'))
      return {ok: true, status: 200, json: async () => ({rows: [mail], total: 1})};
    if (u.includes('/api/platform/action-proposals') && !o.method)
      return {ok: true, status: 200, json: async () => ({ok: true, list: []})};
    return {ok: true, status: 200, json: async () => ({result: {}})};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

it('已引用（imported:true）附件：UI 不显示「未入库」', async () => {
  const t = mount({
    mailbox: {id: 'mb-p', kind: 'personal', email_address: 'me@x.invalid', display_name: '我',
               enabled: true, rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}},
    mail: {
      name: 'm-imported', id: 'm-imported', subject: '已入库附件',
      body: '<p>正文</p>', body_format: 'HTML', to: ['a@x.invalid'], cc: [],
      from_address: 'o@x.invalid', status: 'Received', box: 'inbox',
      record_version: 1, mailbox: 'mb-p', mailboxId: 'mb-p',
      modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00',
      attachments: [{file: 'att-1', name: '已入库.txt', size: 12,
                     imported: true,   /** 已入库 —— **不能**显示「未入库」 */}],
    },
  });
  try {
    await tick(); await tick();
    const item = t.doc().querySelector('[data-mail]') as any;
    assert.ok(item, '列表里找不到该信');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('.att-block, [data-attachment]')) break; await tick(); await tick(); }
    const block = t.doc().querySelector('.att-block, [data-attachment]') as any;
    assert.ok(block, '详情缺附件块');
    assert.doesNotMatch(block.textContent || '',
      /未入库/,
      `已入库（imported:true）附件**不能**显示「未入库」，实际：${(block.textContent||'').slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('发信引用的文件不显示「未入库」—— 导入状态只对收信附件有意义（BASE967-45）', async () => {
  /* 用户实测 UI-066：发信时引用文件中心已有文件，详情却显示「未入库 / 自动入库尚未完成」。
     根因：附件行一律按 `a.imported` 分支，而**发出去的附件**是固定引用，
     服务端根本没有 `imported` 这个标记（那只有收信自动入库才写）。
     测试通过 = Sent 信的附件块显示「已引用」，不出现「未入库」。 */
  const t = mount({
    mailbox: {id: 'mb-p', kind: 'personal', email_address: 'me@x.invalid', display_name: '我',
               enabled: true, rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}},
    mail: {
      name: 'm-sent-ref', id: 'm-sent-ref', subject: '发信引用文件',
      body: '<p>正文</p>', body_format: 'HTML', to: ['a@x.invalid'], cc: [],
      from_address: '我 <me@x.invalid>', status: 'Sent', box: 'sent',
      record_version: 1, mailbox: 'mb-p', mailboxId: 'mb-p',
      modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00',
      attachments: [{file: 'att-ref', name: '引用.xlsx', size: 120}], /* 无 imported 字段 */
    },
  });
  try {
    await tick(); await tick();
    const item = t.doc().querySelector('[data-mail], [data-open]') as any;
    assert.ok(item, '列表里找不到该信');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('.att-block')) break; await tick(); await tick(); }
    const block = t.doc().querySelector('.att-block') as any;
    assert.ok(block, '详情缺附件块');
    const text = block.textContent || '';
    assert.doesNotMatch(text, /未入库/,
      `发信引用的文件**不能**显示「未入库」，实际：${text.slice(0, 200)}`);
    assert.match(text, /已引用/,
      `发信引用的文件该标「已引用文件中心」，实际：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('只读 Draft（edit_draft:false）不能标 Received', async () => {
  const t = mount({
    mailbox: {id: 'mb-p', kind: 'personal', email_address: 'me@x.invalid', display_name: '我',
               enabled: true, rights: {read: true, edit_draft: false, send: false, manage: false, signature: false}},
    mail: {
      name: 'm-readonly-draft', id: 'm-readonly-draft', subject: '只读草稿',
      body: '<p>正文</p>', body_format: 'HTML', to: ['a@x.invalid'], cc: [],
      from_address: 'me@x.invalid', status: 'Draft', box: 'draft',
      record_version: 1, mailbox: 'mb-p', mailboxId: 'mb-p',
      modified: '2026-10-17 10:00:00', date: '2026-10-17 10:00:00',
      attachments: [],
    },
  });
  try {
    await tick(); await tick();
    const item = t.doc().querySelector('[data-mail]') as any;
    assert.ok(item, '列表里找不到该信');
    /** 列表行**不应**标 Received 状态（带 `state-Draft` 或类似） */
    const text = item.textContent || '';
    /** 整篇里都不该出现「已收到 / Received」字样 */
    assert.doesNotMatch(text,
      /已收到|Received/,
      `只读 Draft（edit_draft:false）**不能**显示 Received，实际列表行：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});
