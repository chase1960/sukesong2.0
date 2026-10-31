import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 FIX-57 —— 用户 2026-10-20 21:13 报：「**可是这个邮件打卡变成空白了**」
 （截图：已发送里的「Re: G3-SOURCE-G3SRC-20261020-01 富信源（表格/内嵌图/附件）」，
   抬头、发件人、收件人、时间、投递状态、状态**都在**，**正文那一块整块是空的**。）

 **主控查实的事实（如实记）**：
 · 库里那封信的正文**是完整的**（1166 字符、HTML、含「原始邮件」引用块与表格）⇒ **不是数据丢了**；
 · 详情接口（`mail.detail`）的回包里**正文与内联资源都在**；
 · 同标题的 **10 封**信，详情正文**全都完整**，**没有一封是空的**；
 · 活站**现版**与 **FIX-55 之前的旧版**各跑一次：**正文都渲染出来了**（内联图也真显示，
   是 data URI）⇒ **空白这一现象没能复现**，**也不是 FIX-55 引入的**。

 ⇒ 这一条判据钉的是「**不许再悄悄变成空白**」：
   1. 打开一封**有正文**的信 ⇒ 详情区**有**正文面，且**里面不是空的**
      （沙箱预览的 srcdoc 里能看到正文的文字）；
   2. **取详情失败** ⇒ 详情区**明说**「取不到」，**不是**留一片空白
      —— 这是查出来的**真缺口**：原来只弹一句 toast，详情区就那么空着，
      跟用户看到的现象**完全一致**；
   3. **这封信本身没有正文** ⇒ 详情区**明说**「没有正文」，不是留一片空白。

 跑法：cd shangshu-server && node --import tsx --test tests/website/mail-detail-body.test.ts
*/

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

const BODY_HTML = '<div>这是 G3 富信源，标记 G3SRC-20261020-01</div>'
  + '<table border="1"><tr><th>项目</th><th>数量</th></tr><tr><td>甲</td><td>3</td></tr></table>';

function mount(options: {rows?: any[]; detail?: (id: string) => any} = {}) {
  /* ⚠️ **列表行里本来就没有正文**（实测：列表回包的 body 是 null）——
     正文**全靠详情接口**给（后端 `projection(doc, body=True)` 才带 body）。
     ⇒ 这就是「详情没给正文 ⇒ 详情区一片空白」的机制。
     夹具照这个真实形状造：列表行不带 body，详情才给。 */
  const rows = options.rows ?? [{
    name: 'm-1', subject: 'Re: G3-SOURCE 富信源', status: 'Sent', body_format: 'HTML',
    from_address: 'a@example.invalid', to: ['b@example.invalid'], received_at: '2026-10-20 12:46:00',
    inline_resources: [{ content_id: 'cid1@x', mime_type: 'image/png', name: 'p.png', file: 'f1' }],
    attachments: [],
  }];
  const detailBody = options.detailBody ?? BODY_HTML;
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  const toasts: string[] = [];
  w.fetch = async (url: string, opts: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected', email: 'me@example.invalid', display_name: '我',
      }}})};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      const found = rows.find(r => r.name === body?.payload?.mail);
      const detail = options.detail ? options.detail(body?.payload?.mail)
        : (found ? { ...found, body: detailBody } : null);
      if (!detail) {
        return {ok: false, status: 500, json: async () => ({error: '取不到这封信'}), text: async () => JSON.stringify({error: '取不到这封信'})};
      }
      const payload = {result: {mail: detail}};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('/file-content')) {
      return {ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8)};
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
  return {w, doc: () => w.document, toasts, dispose: () => { dispose(); dom.window.close(); }};
}

/** 列表里点开一封信，等详情渲染出来。 */
async function openFirst(t: ReturnType<typeof mount>) {
  await tick(); await tick(); await new Promise(r => setTimeout(r, 150));
  const item = t.doc().querySelector('[data-open]') as HTMLElement | null;
  assert.ok(item, '邮件列表里没有可点的信');
  item.click();
  await tick(); await tick(); await new Promise(r => setTimeout(r, 250));
}

it('FIX-57 打开一封有正文的信 ⇒ 详情区有正文面，而且里面不是空的', async () => {
  const t = mount();
  try {
    await openFirst(t);
    /* ★ 2026-10-21：正文面 = 所见即所得的**只读快照**（父线：「我只要所见即所得，
       不要两个面」「读信的时候是快照哦」）；原来这里是 `<iframe sandbox srcdoc>` 那个面，
       在渲染不出来的浏览器里只剩一个空边框框 ⇒ 用户报「读信正文整块空白」。 */
    const surface = t.doc().querySelector('[data-mail-body-wysiwyg] .mail-body-editor') as HTMLElement | null;
    assert.ok(surface, '详情区没有正文面（既不是所见即所得的快照，也不是纯文本面）');
    const html = surface.innerHTML || '';
    assert.ok(html.includes('G3SRC-20261020-01'),
      `正文面里看不到正文（用户看到的「空白」）—— 正文面只有 ${html.length} 字符`);
    assert.ok(html.includes('G3-表格单元格') || html.includes('数量'),
      '正文面里连表格内容都没有');
    assert.equal(surface.getAttribute('contenteditable'), 'false', '读信正文面是快照，不该能改');
  } finally { t.dispose(); }
});

it('FIX-57 取详情失败 ⇒ 详情区明说「取不到」，不是留一片空白', async () => {
  const t = mount({detail: () => null});
  try {
    await openFirst(t);
    const detail = t.doc().querySelector('#detail');
    const text = (detail?.textContent || '').replace(/\s+/g, ' ');
    assert.ok(/取不到|读取失败|打不开/.test(text),
      `取详情失败了，详情区却什么都没说（用户看到的就是一片空白）：${text.slice(0, 200)}`);
    /* 正文面不该是一个空壳：要么说清取不到，要么根本不渲染正文面。 */
    const surface = t.doc().querySelector('[data-mail-body-wysiwyg] .mail-body-editor') as HTMLElement | null;
    if (surface) {
      const html = surface.innerHTML || '';
      assert.ok(html.trim().length > 40,
        `取详情失败却留下一个空的正文面（正文面只有 ${html.length} 字符）`);
    }
  } finally { t.dispose(); }
});

it('FIX-57 这封信本身没有正文 ⇒ 详情区明说「没有正文」，不是留一片空白', async () => {
  const t = mount({
    rows: [{
      name: 'm-2', subject: '没有正文的那封', status: 'Sent', body_format: 'HTML',
      from_address: 'a@example.invalid', to: ['b@example.invalid'], received_at: '2026-10-20 12:46:00',
      inline_resources: [], attachments: [],
    }],
    detailBody: '',
  });
  try {
    await openFirst(t);
    const detail = t.doc().querySelector('#detail');
    const text = (detail?.textContent || '').replace(/\s+/g, ' ');
    assert.ok(/没有正文|空正文|正文为空/.test(text),
      `没有正文的信，详情区什么都没说（就是一片空白）：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});
