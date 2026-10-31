import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText, allToastText} from '../helpers/toast.ts';

/*
 FIX-20 —— 存完草稿，列表里**立刻**要看得见这封草稿（第七批，2026-10-19）

 背景（在 3870 试用站用真页面量出来的，不是猜的）：
   试用账号**没绑邮箱** → 邮箱目录是空的。个人箱编号 = sha256(登录人)[:40]，
   **没有账号行**，所以不在目录里（服务端 service.py 的 before_insert 照样把它落上）。
   存完草稿后，前端靠「本地猜归属」决定要不要把这封草稿加进列表：拿回执里的
   mailbox_id 去比「当前箱编号」—— 没绑邮箱时当前箱编号是空串，比不上就早退，
   新草稿**不进列表**。用户看到的是「存了，但列表里没有，刷新一下才有」。

   修法：**归属交给服务端说** —— 存完静默重读当前这一页。服务端按同一个范围算
   （没指定箱 = 本人个人箱，service.py 的 query 就是这么写的），列表里显示的
   就和服务端认的完全一致，前端不再自己猜。

   测试通过 = 下面全部成立：

   L1. 存完草稿（**不刷新页面**），列表里立刻出现这封草稿
   L2. 列表范围**由服务端说了算**：当前看的是收件箱时，草稿不许混进收件箱
   L3. 存完有明确提示（右下角公共 toast：「草稿已保存」）
   L4. 列表与服务端一致：不多一条、不少一条（不产生本地/服务端分叉）
*/

/* 个人箱编号：40 位 sha256 前缀，**目录里没有**（没绑邮箱就是这样）。 */
const PERSONAL_ID = '9f2c8a1d4b6e0f37c5a9d2e8b1f4c6a8d0e2b4f6';

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = async () => { await tick(); await tick(); await tick(); };

/** 服务端的状态口径（照 service.py 的 query 抄一份 —— 判据里的服务端得是真的）。 */
const STATUS_SCOPE: Record<string, (r: any) => boolean> = {
  all: r => r.status !== 'Trash',
  draft: r => r.status === 'Draft',
  inbox: r => r.status === 'Received',
  sent: r => ['Sent', 'Partial'].includes(r.status),
  queued: r => ['Queued', 'Sending'].includes(r.status),
  failed: r => ['Failed', 'Unknown'].includes(r.status),
  trash: r => r.status === 'Trash',
};

function mount(opts: {mailboxes?: any[]; rows?: any[]; accountBound?: boolean} = {}) {
  const dom = new JSDOM('<div id="host"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  /** 服务端那一份（权威）。前端猜错时，它不会跟着前端一起错。 */
  const server = {rows: (opts.rows || []).map(r => ({...r}))};
  const queries: any[] = [];
  const saves: any[] = [];
  const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                       text: async () => JSON.stringify(payload)});
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      return respond({result: {account: {bound: opts.accountBound !== false, enabled: opts.accountBound !== false,
        connection_status: opts.accountBound === false ? 'unbound' : 'connected', email: '', display_name: '',
        signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/services/mail.mailboxes/')) return respond({result: {mailboxes: opts.mailboxes || []}});
    if (url.includes('/actions/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const payload = body.payload || {};
      if (url.includes('mail.save_draft')) {
        saves.push(payload);
        const row = {
          name: payload.mail || ('mail-new-' + saves.length),
          subject: payload.subject || '', body: payload.body || '', body_format: 'HTML',
          to: payload.to || [], cc: payload.cc || [], status: 'Draft', record_version: 1,
          owner: 'me@example.invalid', modified: '2026-10-19 12:00:00',
          /* 不带 mailbox = 落**本人箱**（服务端 before_insert 的老口径）。 */
          mailbox_id: payload.mailbox || PERSONAL_ID,
          from_address: '', received_at: '', sent_at: '', attachment_count: 0,
          my_unread: false, dept_unread: false, unread: false, rejected: [],
        };
        const at = server.rows.findIndex(r => r.name === row.name);
        if (at >= 0) server.rows[at] = row; else server.rows.push(row);
        return respond({result: {...row, attachments: [], attachment_bindings: {}}});
      }
      return respond({result: {record_version: 2}});
    }
    if (url.includes('/datasets/')) {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const filters = JSON.parse(params.get('filters') || '{}');
      queries.push(filters);
      const scope = filters.scope || 'all';
      /* 没指定箱 = 本人个人箱（service.py:546-549 就是这么写的）。 */
      const mailbox = filters.mailbox || PERSONAL_ID;
      const rows = server.rows.filter(r => (STATUS_SCOPE[scope] || STATUS_SCOPE.all)(r) && r.mailbox_id === mailbox);
      return respond({rows, total: rows.length, page: 1, page_length: 30,
                      attachment_capability: 'fixed_references_v2'});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, server, queries, saves, doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
}

/** 点「写邮件」开一封新草稿，填主题，回填写信窗。 */
async function compose(t: ReturnType<typeof mount>, subject: string) {
  await settle();
  const composeBtn = t.doc().querySelector('#compose') as HTMLButtonElement;
  assert.ok(composeBtn, '写邮件入口不在');
  composeBtn.click();
  await settle();
  const subjectInput = t.doc().querySelector('#c-subject') as HTMLInputElement;
  assert.ok(subjectInput, '写信窗没打开');
  subjectInput.value = subject;
  subjectInput.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  await tick();
  return subjectInput;
}

/** 列表里那一行的文字。 */
function rowsText(t: ReturnType<typeof mount>): string {
  return [...t.doc().querySelectorAll('#mail-rows .mail-item')].map(n => (n.textContent || '')).join(' | ');
}

it('L1 存完草稿（不刷新页面），列表里立刻出现这封草稿', async () => {
  const t = mount({mailboxes: []});   // 没绑邮箱：目录里没有本人箱编号
  try {
    await compose(t, '这封草稿要立刻看得见');
    (t.doc().querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();

    assert.ok(t.saves.length >= 1, `没发出保存请求：saves=${t.saves.length}`);
    const shown = rowsText(t);
    assert.match(shown, /这封草稿要立刻看得见/,
        `存完草稿列表里没有它 —— 用户得刷新才看得到（第七批实测的缺陷）：${shown}`);
  } finally { t.dispose(); }
});

it('L2 当前看的是收件箱时：草稿不进收件箱、存草稿不多打一次列表请求、提示说清草稿在哪', async () => {
  const t = mount({mailboxes: []});
  try {
    await settle();
    const box = t.doc().querySelector('#mail-box') as HTMLSelectElement;
    box.value = 'inbox';
    box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await settle();
    const queriesBefore = t.queries.length;

    await compose(t, '这封是草稿不是收件');
    (t.doc().querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();

    assert.ok(t.saves.length >= 1, '没发出保存请求');
    // 收件箱口径不变：草稿不是收件箱里的来信
    assert.ok(!/这封是草稿不是收件/.test(rowsText(t)),
        `草稿混进了收件箱：${rowsText(t)}`);
    // 既有契约：保存**不增加列表请求**（列表重读很贵，邮件多时更明显）
    assert.equal(t.queries.length, queriesBefore,
        `存草稿多打了一次列表请求：${queriesBefore} → ${t.queries.length}`);
    // 看不见的地方要说清楚在哪，用户才知道去哪儿找
    assert.match(allToastText(t.w), /草稿箱/,
        `提示没说草稿在哪：${JSON.stringify(allToastText(t.w))}`);
  } finally { t.dispose(); }
});

it('L3 存完有明确提示：右下角公共 toast 说「草稿已保存」', async () => {
  const t = mount({mailboxes: []});
  try {
    await compose(t, '存完要给个说法');
    (t.doc().querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();

    const shown = allToastText(t.w);
    assert.match(shown, /草稿已保存/, `存完没有明确提示：${JSON.stringify(shown)}`);
    // 提示走公共件（右下角 toast 容器），不许另造一套
    assert.ok(t.doc().querySelector('#toast-zone .toast'), '提示没走右下角公共 toast 容器');
  } finally { t.dispose(); }
});

it('L4 列表与服务端一致：不多一条、不少一条（不产生本地分叉）', async () => {
  const t = mount({mailboxes: []});
  try {
    await compose(t, '只应有一条');
    (t.doc().querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();

    const shown = [...t.doc().querySelectorAll('#mail-rows .mail-item')];
    assert.equal(shown.length, t.server.rows.length,
        `列表条数和服务端对不上：界面 ${shown.length} 条，服务端 ${t.server.rows.length} 条`);
    // 再存一次同一封（编辑保存）也不能多出一条
    (t.doc().querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();
    const after = [...t.doc().querySelectorAll('#mail-rows .mail-item')];
    assert.equal(after.length, t.server.rows.length,
        `再存一次后列表条数和服务端对不上：界面 ${after.length} 条，服务端 ${t.server.rows.length} 条`);
  } finally { t.dispose(); }
});
