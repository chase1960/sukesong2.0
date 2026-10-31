import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
  FIX-56 —— 查看邮件**直接以富文本显示**，不给「选择文本形式」这个动作。

  用户 2026-10-20 19:5x 原话：
  > 「**第二，查看邮件的时候直接以富文本显示，不要「选择」是什么形式的文本**」

  改之前：HTML 信的详情里有一个**「纯文本」按钮**（`#toggle-plain-text`），
  点它就在「富文本 iframe」和「纯文本 <pre>」两套之间切 —— 用户要的是**直接就是富文本**，
  **没有这个选择**。

  ⚠️ **口径变更**：这撤掉了 BASE967-24（req 4）「纯文本阅读入口」那个入口
  （当时是给「宽表用纯文本看、复制不带格式」加的）。**按用户最新指示撤**，
  记在修复计划的证据表里，不当没发生过。

  测试通过 = 下面全部成立：
  1. 打开一封 **HTML** 邮件 ⇒ 详情里**没有**「纯文本」切换按钮；
  2. 打开一封 **HTML** 邮件 ⇒ **没有**那份备用的纯文本 `<pre id="mail-body-plain">`，
     正文就是**富文本**（`iframe.mail-body-preview`）；
  3. **护栏**：打开一封**纯文本**邮件 ⇒ 正文按纯文本显示（`pre.mail-body-text`）——
     纯文本信**本来就没有富文本形态**，那不是「选择」，不许被一起改掉。
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const ME = {name: '我', addr: 'me@qq.com'};

/** 夹具：真站路径（**不是** examples 模式 —— 那是另一条渲染路径，测不到这个）。 */
function mount(opts: {rows?: any[]} = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  const rows = opts.rows || [];

  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      const account = {bound: true, enabled: true, connection_status: 'connected',
        email: ME.addr, display_name: ME.name};
      return {ok: true, status: 200,
        json: async () => ({result: {account}}),
        text: async () => JSON.stringify({result: {account}})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === body?.payload?.mail) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
        text: async () => JSON.stringify({result: {mail: found}})};
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
  return {w, saved, rows, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

const HTML_ROW = {
  name: 'm-html', status: 'Received', subject: '带表格的信', body_format: 'HTML',
  body: '<table><tr><td>甲</td><td>12</td></tr></table>', record_version: 3,
  from_address: '李经理 <li@acme.example.com>', from_name: '李经理',
  to: ['我 <me@qq.com>'], cc: [], attachments: [], attachment_bindings: {},
  owner: 'me@qq.com', modified: '2026-10-12 10:00:00', date: '2026-10-12 09:30',
};
const TEXT_ROW = {
  name: 'm-text', status: 'Received', subject: '纯文本的信', body_format: 'Text',
  body: '张总：\n\n审查意见答复已于今日提交。', record_version: 2,
  from_address: '李经理 <li@acme.example.com>', from_name: '李经理',
  to: ['我 <me@qq.com>'], cc: [], attachments: [], attachment_bindings: {},
  owner: 'me@qq.com', modified: '2026-10-12 10:00:00', date: '2026-10-12 09:30',
};

/** 打开列表里主题含给定文字的那封信，等详情真的渲染出来。 */
async function openMail(t: ReturnType<typeof mount>, subject: string) {
  await tick(); await tick();
  const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes(subject)) as any;
  assert.ok(item, `列表里找不到「${subject}」那封`);
  item.click();
  for (let i = 0; i < 20; i++) {
    const text = (t.doc().querySelector('#detail') as any)?.textContent || '';
    if (text.includes(subject) && !text.includes('请在左侧选择')) break;
    await tick(); await tick();
  }
}

it('FIX-56 查看 HTML 邮件直接是富文本：没有「纯文本」切换按钮', async () => {
  const t = mount({rows: [HTML_ROW]});
  try {
    await openMail(t, '带表格的信');
    const d = t.doc();
    assert.equal(d.querySelector('#toggle-plain-text'), null,
      '详情里还有「纯文本」切换按钮 —— 用户要的是「直接以富文本显示，不要『选择』是什么形式的文本」');
    const buttons = [...d.querySelectorAll('#detail button')].map(b => (b.textContent || '').trim());
    assert.ok(!buttons.some(t2 => t2 === '纯文本'),
      `详情里还有写着「纯文本」的按钮：${JSON.stringify(buttons)}`);
  } finally { t.dispose(); }
});

it('FIX-56 HTML 邮件的正文就是富文本（没有那份备用的纯文本 <pre>）', async () => {
  const t = mount({rows: [HTML_ROW]});
  try {
    await openMail(t, '带表格的信');
    const d = t.doc();
    /* ★ 2026-10-21：HTML 信的正文面 = 所见即所得的**只读快照**（父线：「我只要所见即所得，
       不要两个面」「读信的时候是快照哦」）；原来这里是 `<iframe sandbox srcdoc>` 那个面。 */
    assert.ok(d.querySelector('#detail [data-mail-body-wysiwyg] .mail-body-editor'),
      'HTML 邮件的正文应当直接是富文本（所见即所得的只读面）');
    assert.equal(d.querySelector('#detail iframe.mail-body-preview'), null,
      '不该再挂第二个渲染窗（iframe）—— 用户要的是一个面');
    assert.equal(d.querySelector('#mail-body-plain'), null,
      '详情里还留着备用的纯文本 <pre id="mail-body-plain"> —— 那是「两种形式」并存，用户明确不要');
  } finally { t.dispose(); }
});

it('FIX-56 护栏：纯文本邮件仍按纯文本显示（它本来就没有富文本形态）', async () => {
  const t = mount({rows: [TEXT_ROW]});
  try {
    await openMail(t, '纯文本的信');
    const d = t.doc();
    assert.ok(d.querySelector('#detail pre.mail-body-text'),
      '纯文本邮件应当按纯文本显示（pre.mail-body-text）');
    assert.equal(d.querySelector('#detail iframe.mail-body-preview'), null,
      '纯文本邮件不该渲染富文本 iframe');
  } finally { t.dispose(); }
});
