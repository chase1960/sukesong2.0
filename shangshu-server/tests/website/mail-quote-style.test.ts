import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';
import {actionReceipt, installReplyForwardAction, quoteBlock} from '../helpers/mail-reply-forward.ts';

/*
 回复/转发的**引用样式** —— 对齐真实邮件客户端。

 用户 2026-10-12 手点验收反馈（原文）：
   「没有re，并且我写的部分右边会有一个竖杠，我建议你去看看真正的邮件软件
     （比如 foxmail）回复的样式是啥样的，不要自己臆想;还有，回复全部是干啥的？」
   「图显示没有引用」
   「.att-title / .mail-link / .att-row 这个格式不对，特别丑」

 去 GitHub 拉了**真实客户端生成回复引用**的代码，不是臆想：
   · HappyCodingTogether/CompanyEmailSystem  Public/js/edit.js:40
       `$("#myEditor").html("<br/><br/><br/><br/><p>---------原始邮件---------</p>" + 原文)`
   · qazwse4541/miko-email  web/templates/compose.html:432-435
       `-------- 原始邮件 --------` + `发件人: / 发送时间: / 主题:`
   · naihaishy/FOE  Application/Home/View/Email/view.html:182
       `<br>×6` + `-----------原始邮件------------` + `<blockquote>发件人:…`
   · xingkoo/ibos  phone/view/mail/mail_edit.html
       `———————  原始邮件  ———————` + `发件人：/ 收件人：/ 时间：/ 主题：`（灰底抬头块）
   · yefch3/erp-go  services/mail/internal/app/quotedhistory.go
       —— **解析**各家客户端的引用开头，权威清单：
         `^-{2,}\s*(原始邮件|原邮件|以下为引用内容)\s*-{2,}`（QQ 邮箱 / Foxmail / 263）
         `^发件人[:：].{0,200}(发送时间|收件人)[:：]`（Outlook 抬头块）
         `<blockquote>` / `gmail_quote` / `moz-cite-prefix` / `divrplyfwdmsg` 等容器
       并且：**切分点在节点边界** —— 用户新写的是**兄弟**，引用是下面那半，绝不嵌套。

 四家一致的结论（我原来做反了）：
   ① 用户写的字在**上**，是**独立段落**，不进任何框
   ② 分界是**一行横杠文字**「-----原始邮件-----」，**不是竖线**
   ③ 抬头四项：发件人 / 发送时间 / 收件人 / 主题
   ④ **没有任何一家用竖线把用户写的字框进去**

 ★ 2026-10-21 改口径：**人点回复/转发 = 调后端那两个动作**
   （`mail.reply` / `mail.forward`，父线 A 方案）⇒ 引用块由**后端那一份实现**产出
   （`shangshu_mail.quoting`）。**形状**归邮件域判据
   （`shangshu_mail/tests/test_mail_reply_forward.py`）；
   这一层判据管**前端这一段**：动作调对了没、后端给的那份正文在**编辑器里**是不是
   照样「写字区在上、引用在下、抬头一项一行、地址按字面显示」。

 测试通过 = 下面全部成立：

   A. 用户写字区在**上**且是**独立段落**，引用在**下**（两者是兄弟，不是嵌套）
   B. 引用有**文字分隔**含「原始邮件」，且抬头是 **发件人 / 发送时间 / 收件人 / 主题** 四项
   C. 引用块的边框**不罩住**用户新写的字
   D. **回复也带内联图**（不是破图）
   E. 回复主题带 `Re:`，转发主题带 `Fwd:`（送进动作的载荷 + 打开的草稿）
   F. 「原信附件（可选）」整块落在**值区**（不是 68px 标签列），**文件名看得见**
   G. 「回复全部」按钮上有说明，讲清它是干什么的
   I. 引用抬头里的尖括号地址按字面显示，不被当成 HTML 标签吃掉
   J. 纯文本信的引用排版：分界线/发件人/发送时间/收件人/主题各占一行
   K. 先打字再看引用：正文升成 HTML 之后，引用的换行不能塌掉
   L. 交互样例页的引用块与后端那份**同形**（样例页没有后端可调）
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 340));

const CID = 'seal@shangshu.local';

const seed = (over: any = {}) => ({
  name: 'm-src', status: 'Received', subject: '受控来信 C5：年费账单与合并表格',
  body_format: 'HTML',
  body: '<p>客户您好,</p><table style="border-collapse:collapse"><tbody>'
      + '<tr><td colspan="2">案件汇总</td></tr><tr><td>A001</td><td>150.00</td></tr>'
      + '</tbody></table><p>年费已核对</p><p><img src="cid:' + CID + '" alt="签章"></p>',
  record_version: 1,
  from_address: 'billing@example.invalid', from_name: '',
  to: ['我 <me@qq.com>'], cc: [], attachments: [], attachment_bindings: {},
  inline_resources: [{content_id: CID, mime_type: 'image/png', file: 'F-img', name: '签章.png'}],
  owner: 'me@qq.com', modified: '2026-10-12 10:00:00', message_id: '<src-1@x>',
  date: '2026-10-11 15:18', reply_to_address: '',
  ...over,
});

function mount(rows: any[], over: any = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const actionCalls: {id: string; payload: any}[] = [];
  const baseFetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      const a = {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我'};
      return {ok: true, status: 200, json: async () => ({result: {account: a}}),
        text: async () => JSON.stringify({result: {account: a}})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === (body?.payload || body)?.mail) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
        text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/api/platform/file-content')) {
      // 给 1 字节假图，够 hydrate 成 data: URL
      return {ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8),
        json: async () => ({}), text: async () => ''};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  /* 后端动作的产物：正文 = 引用块（原信正文进引用块），随草稿带走那张受管内联图。 */
  const row = rows[0] || {};
  const backendReceipt = (actionId: string, payload: any) => actionReceipt({
    subject: payload.subject || undefined,
    to: payload.to || [],
    cc: payload.cc || [],
    body: quoteBlock({
      from: row.from_address, date: row.date, to: row.to, cc: row.cc, subject: row.subject,
      body: row.body_format === 'HTML' ? row.body : row.body,
      text: row.body_format !== 'HTML',
    }),
    inline_resources: row.inline_resources || [],
  });
  w.fetch = installReplyForwardAction(baseFetch, {
    onCall: (id, payload) => actionCalls.push({id, payload}),
    receipt: over.receipt ?? backendReceipt,
  });
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), over.options || {});
  return {w, actionCalls, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openAndClick(t: ReturnType<typeof mount>, subject: string, btnId: string) {
  await tick(); await tick();
  const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
    .find((el: any) => (el.textContent || '').includes(subject)) as any;
  assert.ok(item, `列表里找不到「${subject}」`);
  item.click();
  for (let i = 0; i < 30; i++) { if (t.doc().querySelector(btnId)) break; await tick(); await tick(); }
  const btn = t.doc().querySelector(btnId) as any;
  assert.ok(btn, `详情里没有「${btnId}」按钮`);
  btn.click();
  for (let i = 0; i < 40; i++) {
    if (t.doc().querySelector('#c-editor-host .mail-body-editor')) break;
    await tick(); await tick();
  }
  await settle();
}

/** **写信窗**的正文编辑器（读信面也是 .mail-body-editor，别混）。 */
const editorEl = (t: ReturnType<typeof mount>) =>
  t.doc().querySelector('#c-editor-host .mail-body-editor') as any;

it('A 用户写字区在上、是独立段落；引用在下（兄弟，不是嵌套）', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '受控来信', '#reply');
    const ed = editorEl(t);
    assert.ok(ed, '没开正文编辑器');
    const kids = [...ed.children];
    const quoteIdx = kids.findIndex((c: any) => c.hasAttribute && c.hasAttribute('data-mail-quote'));
    assert.ok(quoteIdx >= 0, '正文里没有引用块');
    // 引用块**之前**得有用户写字的地方
    assert.ok(quoteIdx > 0,
        `引用块是正文的第一个元素 —— 用户没有落笔的地方，字会掉进引用里：`
        + `顶层子节点=${kids.map((c: any) => c.tagName).join(',')}`);
    // 引用块**之前**的元素里不该有原信内容
    const above = kids.slice(0, quoteIdx).map((c: any) => c.textContent || '').join('');
    assert.ok(!/案件汇总|年费已核对/.test(above),
        `引用上方混进了原信内容：${above.slice(0, 80)}`);
  } finally { t.dispose(); }
});

it('B 引用有「原始邮件」文字分隔，抬头是发件人/发送时间/收件人/主题四项', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '受控来信', '#forward');
    const html = editorEl(t).innerHTML;
    // 分界是一行**文字**（真实客户端：-----原始邮件-----），不是竖线了事
    assert.match(html, /原始邮件/,
        `引用没有「原始邮件」这个文字分界（真实客户端都这么写）：${html.slice(0, 160)}`);
    // 抬头四项
    assert.match(html, /发件人/, `引用抬头缺「发件人」：${html.slice(0, 160)}`);
    assert.match(html, /发送时间|时间/, `引用抬头缺「发送时间」：${html.slice(0, 160)}`);
    assert.match(html, /收件人/, `引用抬头缺「收件人」：${html.slice(0, 160)}`);
    assert.match(html, /主题/, `引用抬头缺「主题」：${html.slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('C 引用块的边框不罩住用户新写的字', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '受控来信', '#reply');
    const ed = editorEl(t);
    const quote = ed.querySelector('[data-mail-quote]') as any;
    assert.ok(quote, '没有引用块');
    // 用户写字的地方必须在引用块**外面**
    const outside = [...ed.children].filter((c: any) => c !== quote);
    assert.ok(outside.length, '用户写字区和引用块是同一个元素（会被竖线框住）');
    assert.ok(outside.every((c: any) => !quote.contains(c)),
        '用户写字区被包进了引用块');
    // 引用块不得带竖线边框（真实客户端用横线文字分界，不用竖线）
    const style = (quote.getAttribute('style') || '') + (quote.className || '');
    assert.ok(!/border-left/i.test(style),
        `引用块还在用左边竖线（真实客户端没有一家这么做）：${style.slice(0, 120)}`);
  } finally { t.dispose(); }
});

it('D 回复也带内联图（不是破图）', async () => {
  /* 用户 2026-10-12：「图显示没有引用」。
     现在那张图由**后端动作**带进草稿（`mail.reply` 的回执里带着受管内联资源），
     前端要把它**显示得出**。 */
  const t = mount([seed()]);
  try {
    await openAndClick(t, '受控来信', '#reply');
    await settle();
    const ed = editorEl(t);
    const img = ed.querySelector('img');
    assert.ok(img, '回复引用里没有图');
    const src = String(img.getAttribute('src') || '');
    assert.ok(!/^cid:/i.test(src),
        `回复引用里的图还是 cid: 引用（发出去会破图）：${src.slice(0, 60)}`);
    assert.ok(/^data:image\//i.test(src) || /file-content/.test(src),
        `回复引用里的图没解析成可显示的：${src.slice(0, 60)}`);
  } finally { t.dispose(); }
});

it('E 回复主题带 Re:，转发主题带 Fwd:（送进动作的载荷 + 打开的草稿）', async () => {
  const t = mount([seed()]);
  try {
    await openAndClick(t, '受控来信', '#reply');
    assert.equal(t.actionCalls[t.actionCalls.length - 1].id, 'mail.reply', '回复调错了动作');
    assert.match(String(t.actionCalls[t.actionCalls.length - 1].payload.subject || ''), /^Re: /,
        '送进动作的主题没带 Re:');
    assert.match((t.doc().querySelector('#c-subject') as any).value, /^Re: /,
        `回复草稿主题没带 Re:，实际 ${JSON.stringify((t.doc().querySelector('#c-subject') as any).value)}`);
    (t.doc().querySelector('#c-cancel') as any).click();
    await tick(); await tick();
    await openAndClick(t, '受控来信', '#forward');
    assert.equal(t.actionCalls[t.actionCalls.length - 1].id, 'mail.forward', '转发调错了动作');
    assert.match(String(t.actionCalls[t.actionCalls.length - 1].payload.subject || ''), /^Fwd: /,
        '送进动作的主题没带 Fwd:');
    assert.match((t.doc().querySelector('#c-subject') as any).value, /^Fwd: /,
        `转发草稿主题没带 Fwd:，实际 ${JSON.stringify((t.doc().querySelector('#c-subject') as any).value)}`);
  } finally { t.dispose(); }
});

it('F 「原信附件（可选）」整块在值区，且文件名看得见', async () => {
  /* 用户 2026-10-12 贴图：「这个格式不对，特别丑」。
     病根（查实 mail-center.css）：写信窗 `.dlg-field` 是
       `display:grid; grid-template-columns:68px minmax(0,1fr)`
     `#c-att-optional` 是第 3 个孩子，自动排版落进 **68px 标签列**，
     于是标题竖排折七行、`.att-name`（flex:1 + ellipsis）被省略成只剩「1 KB 加入」。
     `.att-actions` 特意写了 `grid-column:2` 才没跑偏 —— `#c-att-optional` 漏了。 */
  const t = mount([seed({attachments: [{file: 'F-1', name: '年费对账单.bin', size: 1024}]})]);
  try {
    await openAndClick(t, '受控来信', '#forward');
    const zone = t.doc().querySelector('#c-att-optional') as any;
    assert.ok(zone, '没有「原信附件（可选）」这块');
    assert.match(zone.textContent, /原信附件/, `这块标题不对：${(zone.textContent || '').slice(0, 80)}`);
    // 文件名必须看得见（原来被省略号吃掉，只剩「1 KB 加入」）
    assert.match(zone.textContent, /年费对账单/,
        `可选附件里看不到文件名：${(zone.textContent || '').slice(0, 80)}`);
    // 整块必须落在值区：CSS 里要给它 grid-column:2
    const css = readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8');
    assert.ok(/#c-att-optional[^{]*\{[^}]*grid-column\s*:\s*2/.test(css.replace(/\s+/g, ' ')),
        'CSS 没把 #c-att-optional 放进值区（grid-column:2）—— 它会落进 68px 标签列');
  } finally { t.dispose(); }
});

it('G 「回复全部」按钮上有说明，讲清它是干什么的', async () => {
  /* 用户 2026-10-12：「回复全部是干啥的？」「我建议你补一个样本，因为我实在不知道
     这个全部恢复是是干啥的」—— 按钮上没说清楚，人不知道点它会发生什么。 */
  const t = mount([seed({to: ['我 <me@qq.com>', '李四 <li@x.example>'], cc: ['王五 <wang@x.example>']})]);
  try {
    // **先读按钮再点** —— 点了「回复」写信窗就盖上详情面板，那时已经找不到按钮了
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('受控来信')) as any;
    assert.ok(item, '列表里找不到「受控来信」');
    item.click();
    for (let i = 0; i < 20; i++) { if (t.doc().querySelector('#reply-all')) break; await tick(); await tick(); }

    const btn = t.doc().querySelector('#reply-all') as any;
    assert.ok(btn, '没有「回复全部」按钮');
    const hint = (btn.getAttribute('title') || '') + (btn.getAttribute('aria-label') || '')
      + (btn.getAttribute('data-hint') || '');
    assert.match(hint, /所有人|都收到|原发件人|抄送|回复给全部/,
        `「回复全部」没说明它是干什么的：title=${JSON.stringify(btn.getAttribute('title'))}`);
    // 「回复」也该说明白，两个按钮的差别要看得出来
    const one = t.doc().querySelector('#reply') as any;
    const oneHint = one.getAttribute('title') || '';
    assert.ok(oneHint.length > 0, '「回复」按钮也没说明（两个按钮分不清差别）');
    assert.notEqual(oneHint, hint, '「回复」和「回复全部」的说明一模一样 —— 没讲清差别');
  } finally { t.dispose(); }
});

it('I 引用抬头里的尖括号地址按字面显示，不被当成 HTML 标签吃掉', async () => {
  /* 用户 2026-10-12 手点验收：「正文里面没有」。渲染出来核对时抓到的真 bug：
       引用抬头渲染出 `收件人: 我 <me@qq.com></me@qq.com>`
     病根：`fmt(p)` 产出 `名字 <地址>`，直接拼进 HTML ——
       `<me@qq.com>` 被浏览器当成一个叫 `me@qq.com` 的标签，
       于是冒出一个多余的闭合标签，地址在页面上**看不见**（用户看到的就是「正文里面没有」）。
     修法：抬头每一项都过转义再拼（现在在**后端**那份实现里转义）。

     测试通过 = 引用抬头里带尖括号的地址按**字面文本**显示出来，
                 页面上出现 `me@qq.com`，并且不出现多余标签。 */
  const t = mount([seed({from_address: '张三 <billing@client.example>',
                         to: ['我 <me@qq.com>']})]);
  try {
    await openAndClick(t, '受控来信', '#reply');
    const head = editorEl(t).querySelector('[data-mail-quote-head]') as any;
    assert.ok(head, '没有引用抬头');
    // 抬头的**文本**里要有那个地址本身（字面）
    assert.match(head.textContent || '', /me@qq\.com/,
        `引用抬头里地址不见了（被当标签吃掉）：${JSON.stringify(head.textContent)}`);
    // 抬头底下不许冒出地址变成的**标签**
    const bogus = [...head.querySelectorAll('*')]
      .filter((el: any) => /me@qq\.com/i.test(el.tagName || ''));
    assert.equal(bogus.length, 0,
        `地址被当成了 HTML 标签：${bogus.map((e: any) => e.tagName).join(',')}`);
    // 原始 HTML 里也必须是转义后的（&lt;），不是裸尖括号
    const html = head.innerHTML;
    assert.ok(/&lt;/.test(html),
        `引用抬头没转义尖括号：${html.slice(0, 200)}`);
    assert.ok(!/<me@qq\.com>/i.test(html),
        `引用抬头里还是裸的 <me@qq.com>，会被浏览器当标签：${html.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('J 纯文本信的引用排版：分界线/发件人/发送时间/收件人/主题各占一行', async () => {
  /* 用户 2026-10-13 贴图反馈：「这个re是做了,但是能不能排版一下,
     包括横杠长度\\换行这些」。图上整段挤成一行。

     病根（查实）：正文里只要出现**任何像 HTML 标签的东西**，
     编辑器就走 HTML 分支、**不做 `\\n → <br>`**，
     于是纯文本引用的换行全丢。地址里的 `<1263099612@qq.com>` 就是嫌疑人。
     现在由**后端那份实现**包 `white-space:pre-wrap`（形状归邮件域判据钉），
     这一条钉的是**编辑器里显示成一项一行**。

     测试通过 = 纯文本信点「回复」，引用块**一行一项**：
       · 分界线独占一行，且是 `----- 原始邮件 -----`（QQ/Foxmail 那种横杠长度）
       · 发件人 / 发送时间 / 收件人 / 主题 **各占一行**（不是挤在一起）
       · 引用正文**另起一段**，与主题行分开
       · 用户写字区仍在引用块**上方**、是独立段落 */
  const t = mount([seed({
    body_format: 'Text',
    subject: '1 你好',
    body: '你好',
    from_address: '江振宇 <1263099612@qq.com>',
    date: '2026-10-13 06:16',
    to: ['测速 <jiangzheny@lingeringtek.cn>'],
  })]);
  try {
    await openAndClick(t, '1 你好', '#reply');
    const ed = editorEl(t);
    assert.ok(ed, '没开正文编辑器');
    const html = ed.innerHTML;

    // 分界线：独占一行 + 横杠长度与真实客户端一致
    assert.match(html, /-{2,}\s*原始邮件\s*-{2,}/,
        `没有「原始邮件」分界线：${html.slice(0, 200)}`);

    // 四个抬头字段必须**各自独立成行** —— 用 <br> 或块级元素隔开
    // 逐字段看它后面是不是立刻接下一个字段（那就是被压成一行）
    const text = ed.textContent || '';
    const fields = ['发件人:', '发送时间:', '收件人:', '主题:'];
    for (let i = 0; i < fields.length - 1; i++) {
      const a = fields[i], b = fields[i + 1];
      const ia = text.indexOf(a), ib = text.indexOf(b);
      assert.ok(ia >= 0 && ib > ia, `抬头缺字段或顺序不对：${a}→${b}｜${text.slice(0, 160)}`);
      // 两字段之间必须有换行（文本里出现 \n，或 HTML 里是 <br>/块级）
      const between = text.slice(ia + a.length, ib);
      const betweenHtml = htmlBetween(html, a, b);
      const hasBreak = between.includes('\n')
        || /<br\s*\/?>/i.test(betweenHtml)
        || /<\/(div|p|tr|li|h[1-6])>/i.test(betweenHtml);
      assert.ok(hasBreak,
          `「${a}」和「${b}」被压在同一行了（用户要的一项一行）：`
          + `之间是 ${JSON.stringify(between.slice(0, 60))}`);
    }

    // 引用正文要**另起一块**，不能黏在主题行上 —— 直接验结构，别在文本里找字
    // （主题本身就叫「1 你好」，在文本里找「你好」会先撞上主题，测了个寂寞）
    const head = ed.querySelector('[data-mail-quote-head]') as any;
    const body = ed.querySelector('[data-mail-quote-body]') as any;
    assert.ok(head, `没有引用抬头块：${html.slice(0, 160)}`);
    assert.ok(body, `没有引用正文块：${html.slice(0, 160)}`);
    assert.ok(head !== body, '引用抬头和引用正文是同一块 —— 主题和正文分不开');
    assert.ok(!head.contains(body) && !body.contains(head), '引用抬头和正文互相嵌套了');
    assert.match(body.textContent || '', /你好/,
        `引用正文块里没有原信内容：${(body.textContent || '').slice(0, 80)}`);

    // 用户写字区仍在上方
    const kids = [...ed.children];
    const quoteIdx = kids.findIndex((c: any) => c.hasAttribute && c.hasAttribute('data-mail-quote'));
    assert.ok(quoteIdx > 0, `引用块跑到正文最前面了：${kids.map((c: any) => c.tagName).join(',')}`);
  } finally { t.dispose(); }
});

it('K 先打字再看引用：正文升成 HTML 之后，引用的换行不能塌掉', async () => {
  /* 链条：原信是纯文本 → 引用走纯文本分支（带 `\n`）→ 用户一打字，
     编辑器产出 `<div>` → 整封升成 HTML → 引用里的 `\n` 在 HTML 渲染里被折成空格。

     测试通过 = 点「回复」后**先打字**（正文变 HTML），引用块仍然是**一项一行**：
       分界线独占一行、发件人/发送时间/收件人/主题各占一行、引用正文另起一段。 */
  const t = mount([seed({
    body_format: 'Text', subject: '1 你好', body: '你好',
    from_address: '江振宇 <1263099612@qq.com>', date: '2026-10-13 06:16',
    to: ['测速 <jiangzheny@lingeringtek.cn>'],
  })]);
  try {
    await openAndClick(t, '1 你好', '#reply');
    const ed = editorEl(t);
    assert.ok(ed, '没开正文编辑器');

    // **先打字** —— 这一步把正文从纯文本升成 HTML（用户实际就是这么用的）
    const before = ed.innerHTML;
    ed.innerHTML = '<div>你好</div>' + before;
    ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();

    const html = ed.innerHTML;
    const text = ed.textContent || '';

    // 正文确实升成 HTML 了（有标签）
    assert.ok(/<div/i.test(html), `正文没升成 HTML：${html.slice(0, 120)}`);

    // 升成 HTML 之后，换行必须还在 —— 用 <br> 或块级元素，不能只靠 \n
    for (const [a, b] of [['发件人:', '发送时间:'], ['发送时间:', '收件人:'],
                          ['收件人:', '主题:']]) {
      const ia = text.indexOf(a), ib = text.indexOf(b);
      assert.ok(ia >= 0 && ib > ia, `抬头缺字段：${a}→${b}`);
      const betweenHtml = htmlBetween(html, a, b, 0);
      const hasBreak = /<br\s*\/?>/i.test(betweenHtml) || /<\/(div|p)>/i.test(betweenHtml);
      assert.ok(hasBreak,
          `升成 HTML 后「${a}」和「${b}」塌到同一行了：`
          + `之间只有 ${JSON.stringify(betweenHtml.slice(0, 80))}`);
    }

    // 分界线独占一行
    const sepIdx = text.indexOf('原始邮件');
    assert.ok(sepIdx > 0, `没有分界线：${text.slice(0, 120)}`);
    const sepHtml = htmlBetween(html, '----------', '发件人:', 0);
    assert.ok(/<br\s*\/?>/i.test(sepHtml) || /<\/(div|p)>/i.test(sepHtml),
        `分界线和「发件人」塌到同一行了：${JSON.stringify(sepHtml.slice(0, 80))}`);
  } finally { t.dispose(); }
});

it('L 交互样例页的引用块与后端那份同形（样例页没有后端可调）', async () => {
  /* 「查看交互样例」这一页**不接后端**（样例信不在库里，动作调不通），
     所以那一页自己拼一段**演示用**引用块。
     形状必须与后端那份一致 —— 否则样例页演示的排版和产品里的不是一回事。 */
  const t = mount([seed()], {options: {examples: true}});
  try {
    /* 样例页用的是内置样例信（不是后端数据）—— 打开第一封。 */
    await openAndClick(t, '审查意见答复', '#reply');
    const ed = editorEl(t);
    assert.ok(ed, '样例页没开正文编辑器');
    const html = ed.innerHTML;
    assert.match(html, /data-mail-quote="1"/, `样例页的引用块标记不对：${html.slice(0, 200)}`);
    assert.match(html, /data-mail-quote-sep="1"/, `样例页缺分界标记：${html.slice(0, 200)}`);
    assert.match(html, /data-mail-quote-head="1"/, `样例页缺抬头标记：${html.slice(0, 200)}`);
    assert.match(html, /data-mail-quote-body="1"/, `样例页缺正文标记：${html.slice(0, 200)}`);
    assert.match(html, /-{2,}\s*原始邮件\s*-{2,}/, `样例页的分界写法不对：${html.slice(0, 200)}`);
    for (const label of ['发件人:', '发送时间:', '收件人:', '主题:']) {
      assert.match(html, new RegExp(label), `样例页抬头少了一项：${label}`);
    }
    /* 样例页**不调后端**（没有真文件中心/真草稿可建）。 */
    assert.equal(t.actionCalls.length, 0,
        '样例页去调后端动作了（样例信不在库里，调不通）');
  } finally { t.dispose(); }
});

/**
 * 取 HTML 里两个字面文本之间的那段标记。
 * `skip` = 第 b 出现几次才用（避免撞上主题里重名的字）。
 */
function htmlBetween(html: string, a: string, b: string, skip = 0): string {
  let ha = -1, from = 0;
  for (let i = 0; i <= skip; i++) {
    ha = html.indexOf(a, from);
    from = ha + a.length;
    if (ha < 0) return '';
  }
  let hb = -1, from2 = ha + a.length;
  for (let i = 0; i <= skip; i++) {
    hb = html.indexOf(b, from2);
    from2 = hb + b.length;
    if (hb < 0) return '';
  }
  return hb > ha ? html.slice(ha + a.length, hb) : '';
}

it('H 发送核对/预览弹层够宽（用户：「这个预览窗口做的宽一点」）', () => {
  /* 用户 2026-10-12 末尾唯一一条「不满意」：「有一个不满意的——这个预览窗口做的宽一点」。
     查实：`.mail-dialog` 是 560px —— 发送前核对里那块正文预览（带表格）被挤成一条缝。
     这条断言钉住宽度下限，改回窄的就红。 */
  const css = readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  // 只认**基准规则**里的像素/min 宽度；响应式那条 width:100% 不算
  const rules = [...css.matchAll(/\.mail-center-page \.mail-dialog\s*\{([^}]*)\}/g)]
    .map(m => /width\s*:\s*([^;}]+)/.exec(m[1])?.[1]?.trim())
    .filter((v): v is string => Boolean(v) && !/^(100%|auto)$/.test(v!));
  assert.ok(rules.length, 'CSS 里找不到 .mail-dialog 的基准宽度（只有响应式的 100%）');
  const val = rules[0];
  const px = /min\(\s*(\d+)/.exec(val) || /(\d+)px/.exec(val);
  assert.ok(px, `读不出宽度数值：${JSON.stringify(val)}`);
  const w = Number(px[1]);
  assert.ok(w >= 800, `预览弹层只有 ${w}px 宽（用户嫌窄），要求 ≥800px；实际 ${JSON.stringify(val)}`);
});
