import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 读信详情页正文整块空白（用户 2026-10-21 报；FIX-57 那一轮已报过一次）。

 现象（用户截图 + 父线在 3870 试用站复核）：
   · 打开「G3-SOURCE-G3SRC-20261020-01 富信源（表格/内嵌图/附件）」——
     抬头/发件人/收件人/抄送/时间/状态/附件行**都在**，
     **正文那一大块是一个空的边框框**；
   · **点「转发」→ 正文完整**（签名文字、表格、内嵌图、「原始邮件」块全在）。

 查实（不是猜）：
   · 库里正文完整、详情接口回包完整 —— 不是数据丢；
   · **两条渲染路不同**：
     读信 = `bodyView()` → `safeFragment()` → `previewSrcdoc()` →
            `<iframe sandbox="" srcdoc="…">`（**父文档之外的独立文档**）；
     转发/写信 = contenteditable 编辑器（**直接渲染在父文档里**）；
   · 父线在 **Chrome（headless 与有界面都试过）里这封信正文正常显示**，
     在**内置浏览器**里是空框 ⇒ 差别在「这个浏览器渲不渲染沙箱 srcdoc 文档」。

 父线 2026-10-21 定方向：「**我只要所见即所得，不要两个面**」
   ⇒ 读信正文改成**跟写信窗同一套编辑器（只读）** —— 一个面。
   沙箱 srcdoc 那个第二面去掉：它在渲染不出来的浏览器里只剩一个空框。

 这一条判据钉的是「**正文看得见 + 只有一个面 + 护栏没松**」：
   ① 读信详情区里**正文文字读得到**（不是只剩一个空边框框）——
      离线复现「这个浏览器没有 srcdoc 这条路」：把 `srcdoc` 这个能力从 window 上摘掉；
   ② **只有一个正文面**：读信窗里**不再挂第二个渲染窗**（`iframe.mail-body-preview` 不存在），
      所见即所得那一个面在；
   ③ 同一份正文在写信窗（编辑器）里也正常 —— 两条路同一个面、同一道净化门；
   ④ **护栏**：脚本/事件属性/外链图照旧被剥掉（净化门黑名单一根没松）。

 跑法：cd shangshu-server && node --import tsx --test tests/website/mail-body-blank-fallback.test.ts
*/

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

/** 用户那封 G3 原信的真实正文（表格 + 内嵌 cid: 图），从库里取的原文。 */
const G3_BODY = '<div>这是 G3 富信源，标记 G3SRC-20261020-01</div>'
  + '<table border="1" cellpadding="4" cellspacing="0" width="420">'
  + '<thead><tr><th>项目</th><th>数量</th><th>备注</th></tr></thead>'
  + '<tbody><tr><td>甲</td><td>3</td><td>G3-表格单元格-A1</td></tr>'
  + '<tr><td>乙</td><td>5</td><td>G3-表格单元格-B2</td></tr></tbody></table>'
  + '<p><img src="cid:g3stamp@shangshu.local" alt="G3内嵌图" width="48" height="48"></p>'
  + '<p>附件名 G3-ATTACH-G3SRC-20261020-01</p>';

const ROW = {
  name: 'j5qoeomcem', subject: 'G3-SOURCE-G3SRC-20261020-01 富信源（表格/内嵌图/附件）',
  status: 'Received', body_format: 'HTML', from_address: '银聆 G3 测试 <jiangzheny@lingeringtek.cn>',
  to: ['jiangzheny@lingeringtek.cn'], received_at: '2026-10-20 12:42:57',
  inline_resources: [{content_id: 'g3stamp@shangshu.local', mime_type: 'image/png', name: 'g3-stamp.png', file: '721ed72da5'}],
  attachments: [],
};

/**
 * 装一个邮件工作面。
 * `dropSrcdoc=true` ⇒ 把 `srcdoc` 这个能力从 window 上摘掉，
 * 模拟「这个浏览器没有沙箱 srcdoc 这条路」（父线在内置浏览器里遇到的）。
 */
function mount(options: {dropSrcdoc?: boolean} = {}) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  w.fetch = async (url: string, opts: any = {}) => {
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected', email: 'me@example.invalid', display_name: '我',
      }}})};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows: [ROW], total: 1};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('/services/mail.detail/')) {
      const payload = {result: {mail: {...ROW, body: G3_BODY}}};
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
  /* 摘掉 srcdoc 能力 —— 放在装完脚本之后，免得影响脚本本身的加载。 */
  if (options.dropSrcdoc) delete w.HTMLIFrameElement.prototype.srcdoc;
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openFirst(t: ReturnType<typeof mount>) {
  await tick(); await tick(); await new Promise(r => setTimeout(r, 150));
  const item = t.doc().querySelector('[data-open]') as HTMLElement | null;
  assert.ok(item, '邮件列表里没有可点的信');
  item.click();
  await tick(); await tick(); await new Promise(r => setTimeout(r, 250));
}

/* ① 正文看得见（就算这个浏览器没有 srcdoc 这条路）。 */
it('读信正文看得见：测试通过 = 详情区里读得到正文文字，不是一个空边框框', async () => {
  const t = mount({dropSrcdoc: true});
  try {
    await openFirst(t);
    const detail = t.doc().querySelector('#detail');
    assert.ok(detail, '详情区没画出来');
    const text = (detail.textContent || '').replace(/\s+/g, ' ');
    assert.ok(text.includes('G3SRC-20261020-01'),
      `详情区读不到正文文字（用户看到的就是「正文整块空白」）：${text.slice(0, 200)}`);
    assert.ok(text.includes('G3-表格单元格-A1') || text.includes('数量'),
      `正文里连表格内容都没有：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

/* ② 只有一个正文面：所见即所得那一个；不再挂第二个渲染窗。 */
it('只有一个正文面：测试通过 = 读信窗里是所见即所得的编辑面，没有第二个渲染窗', async () => {
  const t = mount();
  try {
    await openFirst(t);
    const detail = t.doc().querySelector('#detail');
    assert.ok(detail, '详情区没画出来');
    /* 第二个面（沙箱渲染窗）不许再有 —— 父线 2026-10-21：「我只要所见即所得，不要两个面」。 */
    assert.equal(detail.querySelector('iframe.mail-body-preview'), null,
      '读信窗里还挂着第二个渲染窗（iframe）—— 用户要的是一个面');
    /* 所见即所得那一个面在。 */
    const surface = detail.querySelector('[data-mail-body-wysiwyg]');
    assert.ok(surface, '详情区没有所见即所得的正文面');
    const editor = surface.querySelector('.mail-body-editor');
    assert.ok(editor, '正文面里没有编辑器（所见即所得那一个面没挂上）');
    assert.equal(editor.getAttribute('contenteditable'), 'false',
      '读信正文面不该能改（读信是看，不是改）');
    assert.ok((editor.textContent || '').includes('G3SRC-20261020-01'), '正文面里没有正文');
  } finally { t.dispose(); }
});

/* ③ 同一份正文在写信窗里也正常 —— 两条路同一个面、同一道净化门。 */
it('写信窗里同一份正文也正常：测试通过 = 编辑器里能看到同一段正文', async () => {
  const t = mount({dropSrcdoc: true});
  try {
    await openFirst(t);
    const host = t.doc().createElement('div');
    t.doc().body.appendChild(host);
    const mounted = t.w.mailEditor.mountEditor(host, {value: G3_BODY, onChange: () => {}});
    const text = (mounted.editor.textContent || '').replace(/\s+/g, ' ');
    assert.ok(text.includes('G3SRC-20261020-01'),
      `编辑器路里正文也不对 —— 那就不是渲染路的问题：${text.slice(0, 200)}`);
    assert.ok(text.includes('G3-表格单元格-A1'), '编辑器路里表格内容没了');
    mounted.destroy();
  } finally { t.dispose(); }
});

/* ④ 护栏：脚本/事件属性/外链图照旧被剥掉（净化门黑名单一根没松）。 */
it('护栏没松：测试通过 = 读信正文里没有 script、没有事件属性、外链图被摘掉', async () => {
  const t = mount();
  try {
    await openFirst(t);
    const detail = t.doc().querySelector('#detail');
    const editor = detail?.querySelector('[data-mail-body-wysiwyg] .mail-body-editor');
    assert.ok(editor, '没有正文面');
    assert.equal(editor.querySelector('script'), null, 'script 进了正文');
    assert.equal(editor.querySelector('[onclick]'), null, '事件属性进了正文');
    assert.equal(editor.querySelector('img[src^="http"]'), null, '外链图进了正文');
    /* 受管内联图：cid: 引用留着（存回正文仍认 cid:），显示时按授权字节换成 data URI。 */
    const managed = editor.querySelector('img[data-managed-cid^="cid:"]');
    assert.ok(managed, '受管内联图（cid:）被剥掉了 —— 图要真的看得见');
    assert.match(managed.getAttribute('src') || '', /^(?:data:image\/|cid:)/,
      `受管内联图的图源不对：${managed.getAttribute('src')}`);
  } finally { t.dispose(); }
});
