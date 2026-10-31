import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

/*
  纯文本正文的换行不许变成字面的 <br>（FIX-29）—— 2026-10-20 用户在**发送前核对**里看到：
  正文预览里印着 `张总：<br><br>第2次审查意见的答复思路如下……` ——
  那两个字面量就摆在界面上（用户原话：「为什么会有《br》」）。

  根因（查实）：**编辑器内部一律是 HTML** —— 纯文本的换行被落成 `<br>`
  （`mail-editor.js` 的 `mountEditor`：`纯文本转义后换行变 <br>`），
  但写信窗报给外头的格式仍按原信记着 `Text`。于是三处对不上：

    · **预览**：按 `Text` 走「原样转义显示」⇒ 把 `<br>` 当字面量印出来（用户看到的那处）
    · **出站**：保存/发送带出去的 body 是这段 HTML 标记，格式标签却是 `Text`
      ⇒ 收信人（真发出去时）看到的是字面的 `<br>`
    · **存库**：草稿正文就带着 `<br>` 标记。
      实测站点里那封「测试邮件1」：格式 `Text`、正文 `您好：<br><br>这是一封测试邮件…`
      （2026-10-19 18:39 存的）—— 打开它看到的也是字面 `<br>`。

  修法：**正文按它声明的格式出站、也按它声明的格式显示**。
  声明纯文本就不许把编辑器的 `<br>` 标记当正文带出去/显示出来（换行显示成换行）；
  声明 HTML 的照旧原样（表格、合并格、CID 图一个字节都不许动）。

  测试通过 = 下面全部成立：
  1. **读侧**：打开一封「Text 标签 + 正文带 `<br>` 标记」的旧草稿 → 正文按纯文本显示，
     **界面上不出现字面 `<br>`**（存量数据也要兜住，不许只修新数据）
  2. **写侧**：这封草稿在写信窗里存一次 → 发出去的 body 是**纯文本**（换行是 `\n`），
     格式标签仍是 `Text`（不许偷偷改成 HTML）
  3. **预览**：发送前核对的正文预览里**不出现字面 `<br>`**（用户现场看到的那一处）
  4. **护栏**：HTML 草稿（带表格）**一个字节没动** —— body 原样、`body_format` 仍是 `HTML`
*/

function mount(handler: (url: string, body: any) => any, examples = false) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  w.currentRole = () => 'admin';
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) return {ok: true, status: 200, json: async () => ({result: {account: {bound: true, enabled: true, connection_status: 'connected', email: 'me@qq.com', display_name: '我'}}})};
    if (url.includes('/services/mail.mailboxes/')) return {ok: true, status: 200, json: async () => ({result: {mailboxes: []}})};
    if (url.includes('/api/platform/action-proposals') && !options.method) return {ok: true, status: 200, json: async () => ({ok: true, list: []})};
    const result = await handler(url, options.body ? JSON.parse(options.body) : null);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result};
  };
  installToast(w);
  /* 正文编辑器必须一起加载 —— 「没有编辑器才退回 textarea」那条路走不到这个缺陷。 */
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {examples});
  return {w, doc: () => w.document, dispose: () => {dispose(); dom.window.close();}};
}

/* 站点里那封真实草稿的正文（Text 标签 + 标记） */
const MARKED_BODY = '您好：<br><br>这是一封测试邮件，用于验证邮件功能，无需回复。<br><br>祝工作顺利！';
const MARKED_PLAIN = '您好：\n\n这是一封测试邮件，用于验证邮件功能，无需回复。\n\n祝工作顺利！';

const baseMail = (over: any = {}) => ({
  name: 'mail-br', subject: '测试邮件1', body: MARKED_BODY, body_format: 'Text',
  to: ['客户 <client@example.invalid>'], cc: [], status: 'Draft', record_version: 1,
  owner: 'owner@example.invalid', modified: '2026-10-19 18:39:00', attachments: [], ...over,
});

it('读侧：旧草稿（Text 标签 + 正文带 <br> 标记）打开后按纯文本显示，不许印字面 <br>', async () => {
  const mail = baseMail({status: 'Received'});
  const t = mount(url => url.includes('/datasets/') ? {rows: [mail], total: 1} : {result: {mail}});
  try {
    await tick(); await tick();
    t.doc().querySelector('[data-open]')?.click();
    await tick(); await tick();
    const pre = t.doc().querySelector('.mail-body-text');
    assert.ok(pre, '打开后没有正文文本节点');
    const shown = pre.textContent || '';
    assert.ok(!shown.includes('<br') && !shown.includes('&lt;br'),
      `正文里印出了字面的 <br>：${JSON.stringify(shown.slice(0, 80))}`);
    assert.ok(shown.includes('您好：') && shown.includes('祝工作顺利！'),
      `正文内容丢了：${JSON.stringify(shown.slice(0, 80))}`);
    assert.ok(shown.includes('\n'),
      `换行没有显示成换行：${JSON.stringify(shown.slice(0, 80))}`);
  } finally { t.dispose(); }
});

it('写侧：纯文本草稿存一次，发出去的正文是纯文本（不许带 <br> 标记），格式标签仍是 Text', async () => {
  const mail = baseMail();
  const writes: any[] = [];
  const t = mount((url, body) => {
    if (url.includes('/datasets/')) return {rows: [mail], total: 1};
    if (url.includes('/services/')) return {result: {mail}};
    writes.push(body);
    return {result: {...mail, ...(body?.payload || {}), record_version: 2}};
  });
  try {
    await tick(); await tick();
    t.doc().querySelector('[data-open]')?.click();
    await tick(); await tick();
    const save = t.doc().querySelector('#c-save');
    assert.ok(save, '草稿写信窗里没有「存草稿」按钮');
    (save as any).click();
    await tick(); await tick(); await tick();
    assert.ok(writes.length >= 1, '没发起保存');
    const payload = writes[writes.length - 1].payload;
    assert.ok(!/<br/i.test(String(payload.body || '')),
      `发出去的正文里带着编辑器的 <br> 标记：${JSON.stringify(String(payload.body).slice(0, 80))}`);
    assert.equal(String(payload.body).includes('\n'), true,
      `发出去的正文没有换成纯文本换行：${JSON.stringify(String(payload.body).slice(0, 80))}`);
    assert.equal(payload.body_format, undefined,
      `纯文本草稿被偷偷改成了 HTML 格式：${payload.body_format}`);
    assert.equal(String(payload.body).trim(), MARKED_PLAIN.trim(),
      `发出去的正文内容不对：${JSON.stringify(String(payload.body).slice(0, 120))}`);
  } finally { t.dispose(); }
});

it('预览：发送前核对的正文预览里不出现字面 <br>（用户现场看到的那一处）', async () => {
  const t = mount(() => ({rows: [], total: 0}), true);
  try {
    await tick(); await tick();
    /* 样例里那封有收件人、有附件的草稿（模板要求 2 个附件 → 确认发送是禁用的） */
    const item = [...t.doc().querySelectorAll('[data-mail]')].find(el =>
      /草稿/.test(el.textContent || '') && /张总/.test(el.textContent || ''));
    assert.ok(item, '样例里那封草稿没找到');
    (item as any).click();
    await tick(); await tick();
    const send = t.doc().querySelector('#c-send');
    assert.ok(send, '写信窗里没有「发送」');
    (send as any).click();
    await tick(); await tick();
    const pre = t.doc().querySelector('.send-body-view .mail-body-text');
    assert.ok(pre, '发送前核对里没有正文预览');
    const shown = pre.textContent || '';
    assert.ok(!shown.includes('<br') && !shown.includes('&lt;br'),
      `发送前核对的正文里印出了字面的 <br>：${JSON.stringify(shown.slice(0, 80))}`);
    assert.ok(shown.includes('张总：'), `正文内容丢了：${JSON.stringify(shown.slice(0, 80))}`);
  } finally { t.dispose(); }
});

it('护栏：HTML 草稿（带表格）一个字节没动 —— body 原样、body_format 仍是 HTML', async () => {
  const html = '<table><tr><td>案件A001</td><td>150.00</td></tr></table>';
  const mail = baseMail({body: html, body_format: 'HTML'});
  const writes: any[] = [];
  const t = mount((url, body) => {
    if (url.includes('/datasets/')) return {rows: [mail], total: 1};
    if (url.includes('/services/')) return {result: {mail}};
    writes.push(body);
    return {result: {...mail, ...(body?.payload || {}), record_version: 2}};
  });
  try {
    await tick(); await tick();
    t.doc().querySelector('[data-open]')?.click();
    await tick(); await tick();
    (t.doc().querySelector('#c-save') as any)?.click();
    await tick(); await tick(); await tick();
    assert.ok(writes.length >= 1, '没发起保存');
    const payload = writes[writes.length - 1].payload;
    assert.equal(payload.body_format, 'HTML', 'HTML 草稿的格式标签被改了');
    /* 表格结构不许被压成纯文本（浏览器会规范化标记，所以按结构断言，不逐字节比） */
    assert.match(String(payload.body), /<table/i, 'HTML 草稿的表格结构被压平了');
    assert.match(String(payload.body), /案件A001/, 'HTML 草稿的单元格内容丢了');
    assert.ok(!/案件A001\s*150\.00\s*$/.test(String(payload.body).trim()) || /<table/i.test(String(payload.body)),
      'HTML 草稿的正文被当成纯文本处理了');
  } finally { t.dispose(); }
});
