/* 「人点回复/转发」这条路的夹具：**后端动作的产物**长什么样。

   2026-10-21 起，人点转发/回复**调后端那两个动作**（mail.reply / mail.forward），
   引用块、内联图的文件中心路径索引、默认签名都由**后端那一份实现**产出
   （`shangshu_mail/quoting.py`）—— 前端不再自己拼正文字符串。

   ⇒ 形状在这里只做**一份**（测试与后端同一套口径）：
     <p><br></p>                                  ← 顶部留一个给人写字的独立段落
     <div data-mail-quote="1" style="color:#666"> ← 引用块（**兄弟**，不是嵌套）
       <div data-mail-quote-sep="1">---------- 原始邮件 ----------</div>
       <div data-mail-quote-head="1" …>发件人: …</div>
       <div data-mail-quote-body="1">…原信正文…</div>
     </div>
   引用块**形状**的判据归邮件域（`shangshu_mail/tests/test_mail_reply_forward.py`）；
   这里管的是**前端这一段**：调了哪个动作、传了什么、打开的是不是后端那封草稿。 */

export const QUOTE_SEPARATOR = '---------- 原始邮件 ----------';

/** 后端那份实现的转义口径（`shangshu_mail.quoting._escape_html`）—— 夹具照它来。 */
export function escapeHtml(value: any): string {
  return String(value ?? '').replace(/[&<>"]/g,
    (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c] as string));
}

/** 按后端同一套口径拼一份引用块（夹具用）。 */
export function quoteBlock(options: {
  from?: string; date?: string; to?: string[]; cc?: string[]; subject?: string; body?: string;
  text?: boolean;
} = {}): string {
  const head = [
    `发件人: ${escapeHtml(options.from ?? 'billing@example.invalid')}`,
    `发送时间: ${escapeHtml(options.date ?? '2026-10-20 12:42')}`,
    `收件人: ${escapeHtml((options.to ?? ['me@qq.com']).join('；'))}`,
    ...((options.cc && options.cc.length) ? [`抄送: ${escapeHtml(options.cc.join('；'))}`] : []),
    `主题: ${escapeHtml(options.subject ?? '富信源（表格/内嵌图/附件）')}`,
  ].join('<br>');
  /* 原信是**纯文本**时，引用正文包进 `white-space:pre-wrap` ——
     HTML 渲染会把 `\n` 折成空格（用户 2026-10-13 反馈的那条）。
     原信是 HTML 时正文原样带进来（表格/合并格/受管内联图都在）。 */
  const body = options.text
    ? `<div data-mail-quote-body="1" style="white-space:pre-wrap">${escapeHtml(options.body ?? '你好')}</div>`
    : `<div data-mail-quote-body="1">${options.body ?? '<p>这是 G3 富信源</p>'}</div>`;
  return '<p><br></p>'
    + '<div data-mail-quote="1" style="color:#666">'
    + `<div data-mail-quote-sep="1">${QUOTE_SEPARATOR}</div>`
    + '<div data-mail-quote-head="1" style="font-size:12px;margin:10px 0 12px;line-height:1.8">'
    + head + '</div>'
    + body
    + '</div>';
}

/** 后端动作的回包（前端拿到它就打开这封草稿）。 */
export function actionReceipt(options: {
  name?: string; subject?: string; body?: string; to?: string[]; cc?: string[];
  inline_resources?: any[]; body_format?: string; record_version?: number;
} = {}) {
  return {
    name: options.name ?? 'DRAFT-FROM-ACTION',
    record_version: options.record_version ?? 1,
    status: 'Draft',
    subject: options.subject ?? 'Fwd: 富信源（表格/内嵌图/附件）',
    body: options.body ?? quoteBlock(),
    body_format: options.body_format ?? 'HTML',
    to: options.to ?? [],
    cc: options.cc ?? [],
    attachments: [],
    inline_resources: options.inline_resources ?? [],
    mailbox_id: 'mb-p',
    owner: 'me@qq.com',
  };
}

/** 给 fetch 夹具装上「调后端动作」这一段：命中 mail.reply / mail.forward 就回**后端的产物**。
    `onCall` 可以记下这次调了什么（判据要断言「调了哪个动作、传了哪封原信」）。 */
export function installReplyForwardAction(fetchImpl: any, options: {
  receipt?: any; onCall?: (actionId: string, payload: any) => void; fail?: boolean;
} = {}) {
  const original = fetchImpl;
  return async (url: string, opts: any = {}) => {
    const match = String(url).match(/\/actions\/(mail\.reply|mail\.forward)\/execute/);
    if (match) {
      const actionId = match[1];
      let body: any = {};
      try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }
      /* 前端 `action()` 发的是 `{payload:{…}, confirmed, idempotency_key}` ——
         真正传给动作的是里面那层 `payload`。 */
      const payload: any = (body && typeof body === 'object' && body.payload && typeof body.payload === 'object')
        ? body.payload : body;
      options.onCall?.(actionId, payload);
      if (options.fail) {
        return {ok: false, status: 500, json: async () => ({error: '生成草稿失败'}),
          text: async () => JSON.stringify({error: '生成草稿失败'})};
      }
      /* 默认回包**照着这次载荷长**（主题/收件人就是后端收下的那份）——
         真实后端就是把载荷存成草稿再回执。 */
      const receipt = typeof options.receipt === 'function'
        ? options.receipt(actionId, payload)
        : (options.receipt ?? actionReceipt({
            subject: payload.subject || undefined,
            to: payload.to || [],
            cc: payload.cc || [],
          }));
      return {ok: true, status: 200, json: async () => ({result: receipt}),
        text: async () => JSON.stringify({result: receipt})};
    }
    return original(url, opts);
  };
}
