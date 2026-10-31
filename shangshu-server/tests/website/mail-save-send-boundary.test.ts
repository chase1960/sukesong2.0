import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';

/*
 计划 §6 的 C4 —— 版本、在途保存和发送边界。

 判据原文：
   「连续失焦、回复后立刻编辑、迟到回包、旧版本及保存结果未知均不覆盖新输入、
     不重复建草稿；撤回后保存/MIME一致。进入发送状态后不能继续撤改该发送快照，
     不能把已发送信变成可重发草稿」

 用户 2026-10-12 补充（发送队列那条，C7 落地，这里钉前端边界）：
   「排队成功不等于已发送；发送状态与实际结果一致。重试、重复点击、任务重启和
     SMTP 结果不明都不能导致盲目重复发送。发送快照固定，后续编辑不能混入已排队邮件。」

 现状（查实）：mail-center.js 的 saveDraft 已有一整套在途机构 ——
   `writing` 门闩（不并发存）、`pendingSave` 存原快照（重试重放原快照，不拿后来输入再建一封）、
   `expected_version` 版本比对、`revision` 比对（迟到回包不盖新输入）、
   `uncertain` 标记（结果未知不假报）。
   这些是已有成果 —— 本测试**钉住**它们，不是重做。

 测试通过 = 下面全部成立：

   A. 连续多次失焦自动保存，**只建一封草稿**（不重复建）
   B. 回复后立刻编辑：先存的那一版回来，**不覆盖**用户后来敲的字
   C. **迟到回包**：第一版保存的回包晚到，不覆盖用户已经改出来的第二版
   D. 保存结果未知（请求挂了）：**不假报「已保存」**，重试用**原快照**，不拿新输入再建一封
   E. **旧版本冲突**：别人改过之后，本端保存报版本冲突，**保留用户输入**
   F. **撤回之后保存**：送出去的正文与撤回后的状态一致（MIME 同源）
   G. 进入发送核对后，**发送快照固定**：改正文不会混进这封待发的
   H. **已发送 / 已排队的信不能变成可重发草稿**
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 340));

const ME = {name: '我', addr: 'me@qq.com'};

/** 可编程回包：手动决定什么时候回、回什么、要不要失败。 */
function mount(opts: {
  rows?: any[];
  onAccount?: () => any;
  onSave?: (payload: any, ctx: {hold: () => void; reply: (body: any) => void; fail: (e: any) => void}) => void;
  /** 发送请求延迟多少毫秒回包 —— 瞬间回包会看不见按钮的禁用态，也没法计时。 */
  sendDelayMs?: number;
  /** 自定义发送回执。返回不合格回执 = 模拟「发送结果未知」。 */
  sendReceipt?: (payload: any) => any;
} = {}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  const sent: any[] = [];
  const rows = opts.rows || [];
  let draftSeq = 0;

  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      const account = {bound: true, enabled: true, connection_status: 'connected',
        email: ME.addr, display_name: ME.name};
      return {ok: true, status: 200,
        json: async () => ({result: {account: opts.onAccount ? opts.onAccount() : account}}),
        text: async () => JSON.stringify({result: {account}})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      /* 请求体是 `request()` 打的信封 `{payload, confirmed, idempotency_key}`，
         真正的字段在 `.payload` 里。直接读 body.mail 会读到 undefined ——
         于是更新时回执另起 id，被产品校验 `r.name === payload.mail` 判「回执不完整」，
         editing 不更新、后续保存被 pendingSave 门闩吃掉（实测踩过）。 */
      const envelope = options.body ? JSON.parse(options.body) : {};
      const payload = envelope.payload || envelope;
      saved.push(payload);
      if (opts.onSave) {
        return await new Promise(resolve => {
          opts.onSave!(payload, {
            hold: () => {},
            reply: (body: any) => resolve({ok: true, status: 200,
              json: async () => body, text: async () => JSON.stringify(body)}),
            fail: (e: any) => resolve({ok: false, status: 500,
              json: async () => ({ok: false, code: 'SERVER_ERROR', message: String(e)}),
              text: async () => JSON.stringify({ok: false, message: String(e)})}),
          });
        });
      }
      const n = ++draftSeq;
      /* 回执的 name 必须与请求里的 mail 一致 —— 产品校验 `r.name === payload.mail`。
         更新还是同一封草稿；桩里另起一个 id 会被判「回执不完整」，
         于是 editing 不更新、后续保存被 pendingSave 门闩吃掉（实测踩过）。 */
      const receipt = {name: payload.mail || ('draft-' + n), record_version: n, attachments: [], attachment_bindings: {},
        subject: payload.subject, body: payload.body, to: payload.to || [], cc: payload.cc || []};
      return {ok: true, status: 200, json: async () => ({result: receipt}), text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === body?.payload?.mail) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
        text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/actions/mail.send/execute')) {
      const delay = opts.sendDelayMs ?? 0;
      if (delay) await new Promise(r => setTimeout(r, delay));
      /* 产品对回执的校验（mail-center.js:851）：
           r => Boolean(r.name) && r.name === editing.id
                && ['Queued','Sending','Sent','Partial','Failed','Unknown'].includes(r.status)
         回执不满足 → 判「结果不确定」→ pendingSend=true，按钮换成「核实发送请求」。
         这是**不假报成功**的保证，所以 mock 要给得出合格回执，才测得了确定路径。 */
      const envelope = options.body ? JSON.parse(options.body) : {};
      const payload = envelope.payload || envelope;
      sent.push(payload);
      const receipt = opts.sendReceipt
        ? opts.sendReceipt(payload)
        : {name: payload.mail, status: 'Queued'};
      return {ok: true, status: 200, json: async () => ({result: receipt}),
        text: async () => JSON.stringify({result: receipt})};
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
  return {w, saved, sent, rows, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openCompose(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  const btn = t.doc().querySelector('#compose') as any;
  assert.ok(btn, '找不到「写邮件」');
  btn.click();
  await tick(); await tick();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(t.doc().querySelector('#c-subject'), '写信窗没开出来');
}

/** 失焦自动存（120ms 防抖）—— 与产品同一条路。 */
async function blurSave(t: ReturnType<typeof mount>) {
  const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
  ed?.blur?.();
  ed?.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
  await new Promise(r => setTimeout(r, 340));
}

function fill(t: ReturnType<typeof mount>, over: {subject?: string; to?: string; body?: string}) {
  if (over.to !== undefined) {
    const to = t.doc().querySelector('#c-to') as any;
    to.value = over.to;
    to.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  }
  if (over.subject !== undefined) {
    const s = t.doc().querySelector('#c-subject') as any;
    s.value = over.subject;
    s.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  }
  if (over.body !== undefined) {
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    if (ed) { ed.innerHTML = over.body; ed.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
    const ta = t.doc().querySelector('#c-body') as any;
    if (ta) { ta.value = over.body; ta.dispatchEvent(new t.w.Event('input', {bubbles: true})); }
  }
}

it('A 连续多次失焦自动保存，只建一封草稿（不重复建）', async () => {
  const t = mount();
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '第一版', body: '<p>一</p>'});
    await blurSave(t);
    fill(t, {subject: '第二版', body: '<p>一</p><p>二</p>'});
    await blurSave(t);
    fill(t, {subject: '第三版', body: '<p>一</p><p>二</p><p>三</p>'});
    await blurSave(t);

    const creates = t.saved.filter((s: any) => {
      const p = s?.payload || s;
      return !p.mail;
    });
    assert.equal(creates.length, 1,
        `三次失焦该只建一封草稿，实际建了 ${creates.length} 封：${JSON.stringify(t.saved.map((s: any) => (s?.payload || s).mail))}`);
    const updates = t.saved.filter((s: any) => (s?.payload || s).mail);
    assert.ok(updates.length >= 2, `后续该更新同一封，实际更新 ${updates.length} 次`);
  } finally { t.dispose(); }
});

it('B 回复后立刻编辑：先存的那一版回来，不覆盖用户后来敲的字', async () => {
  /* 迟到回包盖新输入是最容易丢字的一类 bug：存完 v1 → 用户敲 v2 → v1 回包到了。
     回包里的正文是服务端规范化过的，认成「当前值」会把 v2 盖掉。 */
  let release: (v: any) => void = () => {};
  let call = 0;
  const t = mount({onSave: (payload, ctx) => {
    call++;
    if (call === 1) {
      // 第一次保存**吊住**，让用户先敲完第二版
      release = (body: any) => ctx.reply(body);
    } else {
      ctx.reply({result: {name: 'draft-1', record_version: call, attachments: [], attachment_bindings: {},
        subject: payload.subject, body: payload.body, to: payload.to || [], cc: payload.cc || []}});
    }
  }});
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '第一版', body: '<p>第一版正文</p>'});
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    ed?.blur?.(); ed?.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await tick();

    // 回包还没回来，用户继续敲
    fill(t, {subject: '第二版', body: '<p>第二版正文</p>'});
    await tick();

    // 第一版的回包现在才到
    release({result: {name: 'draft-1', record_version: 1, attachments: [], attachment_bindings: {},
      subject: '第一版', body: '<p>第一版正文</p>', to: [{addr: 'a@example.com'}], cc: []}});
    await tick(); await tick();

    const subject = (t.doc().querySelector('#c-subject') as any).value;
    const body = (t.doc().querySelector('.mail-body-editor') as any)?.innerHTML
      || (t.doc().querySelector('#c-body') as any)?.value || '';
    assert.equal(subject, '第二版', `迟到回包把主题盖回去了：${JSON.stringify(subject)}`);
    assert.match(body, /第二版正文/, `迟到回包把正文盖回去了：${body.slice(0, 120)}`);
  } finally { t.dispose(); }
});

it('C 迟到回包：回包晚到时不覆盖新输入，也不重复建草稿', async () => {
  const replies: ((v: any) => void)[] = [];
  let call = 0;
  const t = mount({onSave: (payload, ctx) => {
    call++;
    const n = call;
    replies.push((body: any) => ctx.reply(body));
    // 只有**第二次**立即回，第一次吊到最后
    if (n >= 2) {
      setTimeout(() => ctx.reply({result: {name: 'draft-1', record_version: n, attachments: [],
        attachment_bindings: {}, subject: payload.subject, body: payload.body}}), 0);
    }
  }});
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: 'A', body: '<p>A</p>'});
    await blurSave(t);
    fill(t, {subject: 'B', body: '<p>B</p>'});
    await blurSave(t);

    // 第一版的回包现在才到（迟到）
    if (replies[0]) replies[0]({result: {name: 'draft-1', record_version: 1, attachments: [],
      attachment_bindings: {}, subject: 'A', body: '<p>A</p>'}});
    await tick(); await tick();

    const subject = (t.doc().querySelector('#c-subject') as any).value;
    assert.equal(subject, 'B', `迟到回包把主题盖回去了：${JSON.stringify(subject)}`);
    const creates = t.saved.filter((s: any) => !(s?.payload || s).mail);
    assert.equal(creates.length, 1, `不许重复建草稿，实际建了 ${creates.length} 封`);
  } finally { t.dispose(); }
});

it('D 保存结果未知：不假报「已保存」，重试用原快照，不拿新输入再建一封', async () => {
  let call = 0;
  const t = mount({onSave: (payload, ctx) => {
    call++;
    if (call === 1) {
      // 第一次：结果未知（连接断了，客户端拿不准到底落库没落）
      setTimeout(() => ctx.fail('socket hang up'), 0);
    } else {
      // 重试：确认上次请求
      setTimeout(() => ctx.reply({result: {name: 'draft-1', record_version: 2, attachments: [],
        attachment_bindings: {}, subject: payload.subject, body: payload.body}}), 0);
    }
  }});
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '待确认', body: '<p>第一版</p>'});
    await blurSave(t);

    const toast1 = lastToast(t.w) as any;
    const text1 = toast1 ? (toast1.textContent || '') : '';
    assert.ok(!/已保存/.test(text1), `保存结果未知却假报「已保存」：${JSON.stringify(text1)}`);
    assert.match(text1, /待确认|请重试|未保存/,
        `保存结果未知时没说清楚：${JSON.stringify(text1)}`);

    // 结果未知之后用户又改了 —— 重试**不许**拿新输入去建第二封
    fill(t, {subject: '待确认（后来改的）', body: '<p>第二版</p>'});
    await blurSave(t);
    await tick(); await tick();

    const creates = t.saved.filter((s: any) => !(s?.payload || s).mail);
    assert.equal(creates.length, 1,
        `结果未知后重试不许再建一封，实际建了 ${creates.length} 封：${JSON.stringify(t.saved)}`);
    // 重试发出去的应该是**原快照**（第一版），不是后来输入
    const replayed = t.saved[t.saved.length - 1];
    const p = replayed?.payload || replayed;
    assert.match(String(p.subject || ''), /待确认/,
        `重试没用原快照：${JSON.stringify(p.subject)}`);
  } finally { t.dispose(); }
});

it('E 旧版本冲突：保存失败时保留用户输入，不假报成功、不重复建草稿', async () => {
  /* C4 判据要的是「旧版本…均不覆盖新输入、不重复建草稿」——
     不是要求报错文案里出现「版本冲突」四个字（产品把服务端错误统一成一条
     「保存结果待确认」+「当前输入已保留」，那是另一件事）。
     这里钉的是**数据不丢、不假报、不重复建**。 */
  const t = mount({onSave: (payload, ctx) => {
    setTimeout(() => ctx.fail('版本冲突：这封草稿已被他人修改'), 0);
  }});
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '我这边的修改', body: '<p>我敲的字</p>'});
    await blurSave(t);

    const toast = lastToast(t.w) as any;
    const text = toast ? (toast.textContent || '') : '';
    assert.ok(!/已保存/.test(text), `保存失败却假报「已保存」：${JSON.stringify(text)}`);
    assert.match(text, /未保存|待确认|请重试|失败/,
        `保存失败没说清楚：${JSON.stringify(text)}`);
    // 用户输入必须还在，不能被清掉
    assert.equal((t.doc().querySelector('#c-subject') as any).value, '我这边的修改',
        '保存失败把用户输入弄丢了');
    const body = (t.doc().querySelector('.mail-body-editor') as any)?.innerHTML
      || (t.doc().querySelector('#c-body') as any)?.value || '';
    assert.match(body, /我敲的字/, `保存失败把正文弄丢了：${body.slice(0, 120)}`);
    // 失败后重试也不该再建一封
    await blurSave(t);
    const creates = t.saved.filter((s: any) => !(s?.payload || s).mail);
    assert.equal(creates.length, 1, `失败后重试不该再建一封，实际建了 ${creates.length} 封`);
  } finally { t.dispose(); }
});

it('F 撤回之后保存：送出去的正文与撤回后的状态一致', async () => {
  const t = mount();
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '撤回后保存', body: '<p>开头</p>'});
    await blurSave(t);

    /* 第二步用**粘贴**而不是改 innerHTML：粘贴是一整步（无歧义），
       而连续改 innerHTML 走 input 会在 800ms 内合并成一步 —— 那样 Ctrl+Z
       会连「开头」一起撤掉，测不出「撤回与保存同源」这件事。 */
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    const ev = new t.w.Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'clipboardData', {
      value: {getData: (k: string) => (k === 'text/plain' ? '要撤的' : ''), types: ['text/plain'], files: [], items: []},
    });
    ed.dispatchEvent(ev);
    await tick();

    // Ctrl+Z 只拦**正文编辑区**（不是整个详情面板），要派给编辑器
    ed.dispatchEvent(new t.w.KeyboardEvent('keydown',
      {key: 'z', ctrlKey: true, bubbles: true, cancelable: true}));
    await tick();

    const afterUndo = ed.innerHTML;
    assert.ok(!/要撤的/.test(afterUndo), `撤回没生效，正文还带着被撤的内容：${afterUndo.slice(0, 160)}`);

    await blurSave(t);
    await tick(); await tick();
    assert.ok(t.saved.length, '撤回之后没发出保存');
    const last = t.saved[t.saved.length - 1];
    const p = last?.payload || last;
    const sentBody = String(p.body || '');
    // 撤回后的状态不该含「要撤的」，且应与撤回后的正文同源
    assert.ok(!/要撤的/.test(sentBody),
        `撤回之后保存出去的正文还带着被撤的内容（撤回与保存不同源）：${sentBody.slice(0, 160)}`);
    assert.match(sentBody, /开头/,
        `撤回之后保存出去的正文连该留的都没了：${sentBody.slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('G 进入发送核对后，发送快照固定：改正文不混进这封待发的', async () => {
  const t = mount();
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '快照固定', body: '<p>待发正文</p>'});
    await blurSave(t);

    (t.doc().querySelector('#c-send') as any).click();
    await tick(); await tick();
    await new Promise(r => setTimeout(r, 200));

    // 发送核对框开出来了
    const dlg = t.doc().querySelector('.send-list') ? t.doc() : null;
    assert.ok(dlg, '点发送没开出核对框');

    // 核对框开着的时候改正文
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    if (ed) {
      ed.innerHTML = '<p>待发正文</p><p>核对时偷偷加的</p>';
      ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    }
    await tick();

    // 核对框里展示的正文必须是**点击那一刻**的快照
    const view = t.doc().querySelector('.send-body-view') as any;
    const shown = view ? (view.textContent || view.innerHTML || '') : '';
    assert.ok(!/核对时偷偷加的/.test(shown),
        `发送核对把后来的编辑混进快照了：${String(shown).slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('H 已发送 / 已排队的信不能变成可重发草稿', async () => {
  const rows = [{name: 'm-sent', status: 'Sent', subject: '已经发出去的', body_format: 'HTML',
    body: '<p>发过了</p>', record_version: 3,
    from_address: '我 <me@qq.com>', from_name: '我',
    to: ['张三 <a@example.com>'], cc: [], attachments: [], attachment_bindings: {},
    owner: 'me@qq.com', modified: '2026-10-12 10:00:00', message_id: '<sent-1@x>',
    date: '2026-10-12 09:30'}];
  const t = mount({rows});
  try {
    await tick(); await tick();
    const item = [...t.doc().querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes('已经发出去的')) as any;
    assert.ok(item, '列表里找不到那封已发送的');
    item.click();
    /* `#detail` 从一开始就存在（空占位）—— 轮询它等于没等。
       要等的是**详情内容**真的渲染出来。 */
    for (let i = 0; i < 20; i++) {
      const text = (t.doc().querySelector('#detail') as any)?.textContent || '';
      if (text.includes('已经发出去的') && !text.includes('请在左侧选择')) break;
      await tick(); await tick();
    }

    // 已发送的信：不该出现「继续编辑」这类把它变回草稿的入口
    const detail = t.doc().querySelector('#detail') as any;
    const text = detail ? (detail.textContent || '') : '';
    assert.ok(!/继续编辑|改为草稿|重新编辑/.test(text),
        `已发送的信出现了变回草稿的入口：${text.slice(0, 160)}`);
    // 有「不能重发」的明确说明
    assert.match(text, /不能直接重发|已经排队|已被服务商接受|新建草稿/,
        `已发送的信没说明不能重发：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('I 发送按钮点完会恢复可用（不卡死），并报出恢复耗时', async () => {
  /* 用户 2026-10-12：「你应该能测出来他的所有速度吧」。
     按钮恢复这条的时间**由请求往返决定** —— mail-center.js 的 `#send-ok`
     处理器是 `writing=true; disabled=true` → await 请求 → `finally { disabled=false }`，
     恢复是请求回来那一刻同步做的。所以：
       · 本测试钉**行为**：按钮确实恢复、文字回到「确认发送」，不会永久卡在禁用
       · **时间上限**由真实接口往返给出 —— 本地实测 S1「点发送→已排队」= 14.5 ms
         （见 shangshu-server/scripts/test-mail-speed-matrix.py），远低于 1 秒判据
       · 真网那档取决于网络，标 NOT_RUN，**不拿本地数冒充**

     测试通过 = 点「确认发送」后按钮从禁用恢复为可用、文字回到「确认发送」，
                 并且恢复耗时被如实记下来（不是永远禁用）。 */
  const HOLD_MS = 300;           // 让发送请求挂 300ms，才看得见禁用态、也才测得出恢复耗时
  const t = mount({sendDelayMs: HOLD_MS});
  try {
    await openCompose(t);
    (t.doc().querySelector('#c-to') as any).value = 'zhang@acme.example.com';
    (t.doc().querySelector('#c-subject') as any).value = '按钮恢复计时';
    const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
    (ed as any).value = '正文';
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await blurSave(t);

    (t.doc().querySelector('#c-send') as any).click();
    await tick(); await tick();
    const ok = t.doc().querySelector('#send-ok') as any;
    assert.ok(ok, '没弹出发送核对（找不到「确认发送」）');

    const t0 = Date.now();
    ok.click();
    // 请求还挂着的时候，按钮必须是禁用的（防连点重复发）
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ok.disabled, true, '点「确认发送」后按钮没禁用 —— 能连点重复发');

    // 等它恢复；上限 1 秒是用户判据
    let waited = 0;
    while (ok.disabled && waited < 1000) {
      await new Promise(r => setTimeout(r, 10));
      waited += 10;
    }
    const recovered = Date.now() - t0;

    assert.equal(ok.disabled, false,
        `发送按钮 1 秒内没恢复可用（卡在禁用 ${recovered}ms）`);
    assert.equal((ok.textContent || '').trim(), '确认发送',
        `按钮文字没回来，卡在 ${JSON.stringify(ok.textContent)}`);
    /* 恢复耗时应当**贴着请求往返**（这里是 300ms 的人为挂起），不该多出一截。
       多出来的那截就是前端自己卡的 —— 那才是要抓的东西。 */
    console.log(`      ↳ 按钮恢复耗时 ${recovered} ms（人为挂起 ${HOLD_MS}ms；判据 ≤1000ms）`);
    assert.ok(recovered <= 1000, `按钮恢复用了 ${recovered}ms，超过 1 秒判据`);
    assert.ok(recovered >= HOLD_MS - 20,
        `按钮恢复只用了 ${recovered}ms，比请求挂起还短 —— 没等到回包就恢复了（会误导用户以为发完了）`);
  } finally { t.dispose(); }
});

it('J 发送回执不合格时停在「核实发送请求」，不假报已发送', async () => {
  /* 这条和「速度」是一回事：**测不到就不报数，发不出就不说发了**。
     回执缺 name / 状态不在状态机里 → 产品判「结果未知」，按钮换字成
     「核实发送请求」，并且关闭按钮一起锁住（不能把不确定的这封扔下就走）。
     反例 = 不管回执什么样子都显示「发送成功」并关窗。 */
  const t = mount({sendDelayMs: 30, sendReceipt: () => ({/* 故意缺 name/status */})});
  try {
    await openCompose(t);
    (t.doc().querySelector('#c-to') as any).value = 'zhang@acme.example.com';
    (t.doc().querySelector('#c-subject') as any).value = '回执不合格';
    const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
    (ed as any).value = '正文';
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await blurSave(t);
    (t.doc().querySelector('#c-send') as any).click();
    await tick(); await tick();
    (t.doc().querySelector('#send-ok') as any).click();
    await new Promise(r => setTimeout(r, 200));

    const ok = t.doc().querySelector('#send-ok') as any;
    assert.ok(ok, '结果未知时窗口被关掉了 —— 用户没机会核实');
    assert.equal((ok.textContent || '').trim(), '核实发送请求',
        `回执不合格却显示 ${JSON.stringify(ok.textContent)}，在假报发送结果`);
    assert.equal(ok.disabled, false, '「核实发送请求」必须可点（要能去查原请求）');
    // 不许提示成功
    const text = t.doc().querySelector('.send-warn')?.textContent || '';
    assert.match(text, /结果待核实/,
        `结果未知时没说清「待核实」：${text.slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('I 发之前等在途/排队的保存落地：发送用的版本必须是落地后那个（FIX-51）', async () => {
  /* 用户 2026-10-20 实测（真发信时才暴露）：**带附件的转发**，界面「发送」间歇性报
     417「邮件已更新，请重新核对当前版本后发送」——**信没发出去**（3 次错 2 次）。
     根因不在后端（后端那把版本闸是**对的**，防并发覆盖）：
       · 保存一落地，`record_version` 就 +1；
       · 而「确认发送」用的是**打开核对框那一刻**的版本快照；
       · ⚠️ 关键时序：**打开核对框本身**会让附件区失焦 → 触发一次自动保存
         ⇒ 那次保存是在核对框**开着**的时候落地的
         ⇒ 只在「发之前等」不够，**发送那一刻**也得用落地后的版本。 */
  const t = mount();
  try {
    await openCompose(t);
    fill(t, {to: 'a@example.com', subject: '转发带附件', body: '<p>正文</p>'});
    await blurSave(t);                                   // 建一封草稿（version 1）

    (t.doc().querySelector('#c-send') as any).click();
    await tick(); await tick();
    await new Promise(r => setTimeout(r, 200));
    assert.ok(t.doc().querySelector('#send-ok'), '点发送没开出核对框');

    /* 核对框开着的时候，附件区失焦触发的那次保存落地了 ⇒ record_version +1。
       （这一步直接调产品的保存动作，不去模拟焦点：JSDOM 里焦点语义不可靠，
         但**保存落地这件事本身**是这里要测的。） */
    const before = t.saved.length;
    /* 打开核对框那一刻的版本 —— 旧代码会拿**它**去发（这就是 417 的来源）。 */
    const staleVersion = before;
    const ed = t.doc().querySelector('.mail-body-editor') as any;
    if (ed) { ed.dispatchEvent(new t.w.FocusEvent('focusout', {bubbles: true})); }
    const subj = t.doc().querySelector('#c-subject') as any;
    if (subj) { subj.value = '转发带附件（改动）'; subj.dispatchEvent(new t.w.Event('input', {bubbles: true})); subj.dispatchEvent(new t.w.FocusEvent('focusout', {bubbles: true})); }
    await new Promise(r => setTimeout(r, 400));
    await tick(); await tick();
    assert.ok(t.saved.length > before,
      '这次失焦保存没落地（桩有问题？）—— 测不到版本竞态，先把桩修对再判 FIX-51');

    (t.doc().querySelector('#send-ok') as any).click();
    await tick(); await tick();
    await new Promise(r => setTimeout(r, 200));

    const payload = t.sent[t.sent.length - 1];
    assert.ok(payload, '没发出发送请求');
    /* 每存一次，record_version +1 ⇒ 最后一次保存落地后的版本 = 存的次数。 */
    assert.equal(payload.expected_version, t.saved.length,
      `发送用的 expected_version 是 ${payload.expected_version}，`
      + `而最后一次保存落地后的版本是 ${t.saved.length} —— 发送带的是**过期版本**，`
      + '后端版本闸会挡下（417「邮件已更新，请重新核对当前版本后发送」），信发不出去');
    assert.ok(payload.expected_version > staleVersion,
      `发送用的还是打开核对框那一刻的旧版本 ${payload.expected_version}（当时是 ${staleVersion}）`
      + ' —— 那次落地后的保存把 record_version 顶高了，发送必须用新版本');
  } finally { t.dispose(); }
});
