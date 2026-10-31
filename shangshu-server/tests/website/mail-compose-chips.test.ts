import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast} from '../helpers/toast.ts';

/*
 邮件收件人改胶囊输入 —— 用户 2026-10-10 提出：
 「请把邮件部分的抄送和主送『；』操作搞得直观一点，可以用胶囊形式……
   就是用加号代表增加一个人……记得把这个升级成公共组件。」

 测试通过 = 下面全部成立：
 1. 写信窗口的「收件人」「抄送」用的是公共胶囊组件（不是纯文本输入框），
    初值收件人渲染成一枚一枚胶囊。
 2. 点某枚胶囊的 × 删掉那一个人，失焦自动存之后发出去的收件人列表确实少了一个。
 3. 点「+」加人后失焦自动存，读到的列表确实多一个。
 4. 原有语义不变：发出去的仍是「一组收件人字符串」，服务端解析/校验逻辑不受影响。
*/

const tick = () => new Promise(r => setTimeout(r, 20));

function mount(rows: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  w.currentRole = () => 'admin';
  const saved: any[] = [];
  const fileFetches: string[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('/services/mail.account.status/')) {
      /* 邮箱要**三样都齐**才叫「能发」：bound + enabled + connection_status='connected'
         （mail-center.js 的 canSend() 就看这三条）。少一样「发送」按钮就是禁用的，
         点它没反应 —— 我先前只给了 bound:true，测「没填收件人」时按钮根本点不动。 */
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我',
      }}})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(body?.payload || {});
      return {
        ok: true, status: 200,
        json: async () => ({result: {name: 'm-1', record_version: 1, attachments: [], attachment_bindings: {}}}),
        text: async () => '{}',
      };
    }
    if (url.includes('/datasets/')) {
      // 注意：request() 读的是 response.text() 再 JSON.parse —— text() 必须吐真数据，
      // 只写 json() 会让列表拿到空对象（测试自己造的坑，不是产品问题）。
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find(r => r.name === body?.payload?.mail) || rows[0] || {};
      const payload = {mail: found};
      return {ok: true, status: 200, json: async () => ({result: payload}), text: async () => JSON.stringify({result: payload})};
    }
    /* 旧的死接口：平台模式下 410 LEGACY_SURFACE_DISABLED。
       真实产品页实测过 —— 谁再调它，图就永远解析不出来（用户看到的「图片渲染不出来」）。 */
    if (url.includes('/api/platform/files/content')) {
      return {ok: false, status: 410, json: async () => ({ok: false, code: 'LEGACY_SURFACE_DISABLED'}), text: async () => '{}'};
    }
    /* 正确的受管字节出口：/api/platform/file-content?ref=<doctype>&ref_name=<记录名>&file=<文件>
       必须带记录归属，否则内核判不了权，返回 403「无权读取该记录的附件」。 */
    if (url.includes('/api/platform/file-content')) {
      fileFetches.push(url);
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      return {
        ok: true, status: 200,
        arrayBuffer: async () => png.buffer.slice(0),
        json: async () => ({}), text: async () => '',
      };
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {
    w, saved, fileFetches,
    dispose: () => { dispose(); dom.window.close(); },
    doc: () => w.document,
  };
}

async function openCompose(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  const compose = t.doc().querySelector('#compose') as any;
  assert.ok(compose, '找不到写邮件按钮');
  compose.click();
  await tick(); await tick();
}

/* 写信窗已经没有「存草稿」按钮（用户 2026-10-11：「存草稿不要用一个显性的按钮，只要失焦就保存」）。
   所以「点存草稿」换成**失焦**：正文/主题/收件人任一处离开即自动存（120ms 防抖）。
   只派发 blur、不派发 focusout —— focusout 会顺带触发「单字段失焦保存」，多发一个只含单字段的请求，
   测的就不是「整封信存了一次」。 */
async function triggerSave(t: ReturnType<typeof mount>) {
  const w = t.w;
  const ed = w.document.querySelector('.mail-body-editor') || w.document.querySelector('#c-body');
  if (ed) { ed.blur?.(); ed.dispatchEvent(new w.FocusEvent('blur', {bubbles: true})); }
  await new Promise(r => setTimeout(r, 320)); // 比 120ms 防抖长
}

function chipHost(t: ReturnType<typeof mount>, label: string) {
  const fields = [...t.doc().querySelectorAll('.dlg-field, label')];
  for (const f of fields) {
    if ((f.textContent || '').includes(label)) {
      const chip = f.querySelector('.chip-input, [data-chip-items]');
      if (chip) return chip;
    }
  }
  return null;
}

/* 加一个人的完整动作 —— 走的是用户实测定的交互：
   「加号跟在已填写的胶囊右边，点击加号就在加号左边多一个胶囊（只能填一个，
     如果多的话就再点加号)」。所以是 点 + → 填一个 → 回车，不是往常驻输入框里打。 */
async function addPerson(t: ReturnType<typeof mount>, host: any, value: string) {
  const add = host.querySelector('[data-chip-add]') as any;
  assert.ok(add, '胶囊栏缺「+」按钮');
  add.click();
  await tick();
  const field = host.querySelector('input') as any;
  assert.ok(field, '点「+」没开出填写位');
  field.value = value;
  field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await tick();
}

it('写信窗口的收件人/抄送是胶囊组件，初值渲染成一枚一枚胶囊', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const to = chipHost(t, '收件人');
    assert.ok(to, '收件人栏不是胶囊组件（用户要的胶囊形式没上）');
    const cc = chipHost(t, '抄送');
    assert.ok(cc, '抄送栏不是胶囊组件');

    // 加人 → 变成胶囊（点 + 开填写位，填一个回车）
    await addPerson(t, to, '张三 <a@qq.com>');
    const chips = [...to.querySelectorAll('[data-chip]')];
    assert.equal(chips.length, 1, '回车后没出胶囊');
    assert.match(chips[0].textContent, /张三/, '胶囊上没显示收件人');
    assert.ok(chips[0].querySelector('[data-chip-remove]'), '胶囊缺删除按钮');
  } finally { t.dispose(); }
});

it('点 × 删人后存草稿，发出去的收件人确实少一个', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const to = chipHost(t, '收件人');
    for (const v of ['甲 <a@qq.com>', '乙 <b@qq.com>', '丙 <c@qq.com>']) {
      await addPerson(t, to, v);
    }
    assert.equal(to.querySelectorAll('[data-chip]').length, 3, '前置：应有 3 枚胶囊');

    // 删中间那个
    (to.querySelectorAll('[data-chip-remove]')[1] as any).click();
    await tick();
    assert.equal(to.querySelectorAll('[data-chip]').length, 2, '点 × 没删掉');

    // 存草稿（失焦自动存），看发出去的收件人
    const subject = t.doc().querySelector('#c-subject') as any;
    subject.value = '删除后保存';
    await triggerSave(t);

    assert.ok(t.saved.length, '没发出保存请求');
    const payload = t.saved[t.saved.length - 1];
    const toList: any[] = payload.to || [];
    assert.equal(toList.length, 2, `存草稿读到的收件人个数不对：${JSON.stringify(toList)}`);
    const flat = toList.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('；');
    assert.match(flat, /甲/, '删错人了，甲还在');
    assert.match(flat, /丙/, '删错人了，丙没了');
    assert.ok(!/乙/.test(flat), '被删的乙还在收件人列表里');
  } finally { t.dispose(); }
});

it('点「+」加人后存草稿，发出去的收件人确实多一个', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const to = chipHost(t, '收件人');

    await addPerson(t, to, '甲 <a@qq.com>');
    // 用户原话「如果多的话就再点加号」—— 第二个人再点一次 +
    await addPerson(t, to, '乙 <b@qq.com>');
    assert.equal(to.querySelectorAll('[data-chip]').length, 2, '点「+」没加人');

    const subject = t.doc().querySelector('#c-subject') as any;
    subject.value = '加人后保存';
    await triggerSave(t);

    const payload = t.saved[t.saved.length - 1];
    const toList: any[] = payload.to || [];
    assert.equal(toList.length, 2, `存草稿读到的收件人个数不对：${JSON.stringify(toList)}`);
  } finally { t.dispose(); }
});

/* 用户实测反馈（2026-10-11）：
   「为什么会有两个正文，我不需要有渲染页，我要编辑的时候所见及所得并且图片这块渲染不出来」
   测试通过 = 写信窗只有一个正文区（就是所见即所得的编辑器，没有单独渲染页），
   且受管内联图在编辑器里能显示（cid 解析成可显示的图，不外联）。 */
async function openMail(t: ReturnType<typeof mount>, subject: string) {
  await tick(); await tick();
  const items = [...t.doc().querySelectorAll('[data-mail], [data-open]')];
  const target = items.find((el: any) => (el.textContent || '').includes(subject)) as any;
  assert.ok(target, `列表里找不到「${subject}」`);
  target.click();
  await tick(); await tick();
}

it('写信窗只有一个正文区（所见即所得），没有单独的渲染页', async () => {
  const t = mount([{name: 'm-1', status: 'Draft', subject: '带图草稿', body_format: 'HTML', record_version: 1,
    body: '<p>您好</p><table><tr><td colspan="2">汇总</td></tr></table><p><img src="cid:seal@x" alt="签章"></p>',
    to: [], cc: [], attachments: []}]);
  try {
    // 必须点开这封 HTML 草稿（点「写邮件」是新建纯文本，走不到那条路径）
    await openMail(t, '带图草稿');
    const labels = [...t.doc().querySelectorAll('.dlg-field > span')]
      .map((s: any) => (s.textContent || '').trim())
      .filter((x: string) => x === '正文');
    assert.equal(labels.length, 1, `正文区出现了 ${labels.length} 个，用户要的是所见即所得、不要单独渲染页`);
    // 编辑器在，预览 iframe 不在
    assert.ok(t.doc().querySelector('.mail-body-editor'), '缺少所见即所得的编辑器');
    assert.equal(t.doc().querySelector('iframe.mail-body-preview'), null, '写信窗里不该再挂一个渲染页');
  } finally { t.dispose(); }
});

it('受管内联图在编辑器里真的解析成可显示的图（不是空占位），且不外联', async () => {
  /* 上一版这条是**假绿**：cid: 没解析也照样过，于是用户看到「图片渲染不出来」。
     现在钉死：src 必须是 data:image/... —— 真的取回字节、真的能显示。 */
  const t = mount([{name: 'm-2', status: 'Draft', subject: '带图草稿2', body_format: 'HTML', record_version: 1,
    body: '<p>签章见下</p><p><img src="cid:seal@x" alt="签章"></p>',
    inline_resources: [{content_id: 'seal@x', mime_type: 'image/png', file: 'F-seal', name: '签章.png'}],
    to: [], cc: [], attachments: []}]);
  try {
    await openMail(t, '带图草稿2');
    await tick(); await tick();
    const img = t.doc().querySelector('.mail-body-editor img') as any;
    assert.ok(img, '编辑器里没找到内嵌图');
    const src = img.getAttribute('src') || '';
    assert.ok(/^data:image\//i.test(src), `内嵌图没解析成可显示的图，src=${src.slice(0, 40)}`);
    assert.ok(!/^https?:\/\//i.test(src), `内嵌图被放成外链了：${src.slice(0, 40)}`);
    // 受管身份必须留着，存回去仍是 cid: 引用，不能把 data: 写进正文
    assert.equal(img.getAttribute('data-managed-cid'), 'cid:seal@x', '受管 cid 标记丢了，存回去会变成内嵌 base64');
  } finally { t.dispose(); }
});

/* 用户 2026-10-11：「为什么会有两个正文，我不需要有渲染页，我要编辑的时候所见即所得
   并且图片这块渲染不出来」。
   这句话说的是**写信/编辑**窗里同时挂着渲染页和编辑器 —— 编辑要所见即所得，不要第二个正文。
   ★ 2026-10-21（父线定方向：「我只要所见即所得，不要两个面」「读信的时候是快照哦」）：
     **读信窗也照这个口径** —— 读信正文 = 跟写信窗同一套编辑器（**只读快照**：没有工具栏、
     不能改），**不再挂** `<iframe sandbox srcdoc>` 那个渲染页。
     为什么撤掉那个面：它在渲染不出来的浏览器里只剩一个空边框框 ——
     用户 2026-10-21 报「读信详情页正文整块空白」，而**点转发看得到**
     （转发走的就是编辑器面）。
   所以这里钉的是：两个窗各只有一个正文面，且两处受管图都真的显示。 */
it('读信、写信都是所见即所得，各只有一个正文面（读信那一个是只读快照）', async () => {
  const t = mount([{name: 'm-3', status: 'Received', subject: '来信带图', body_format: 'HTML', record_version: 1,
    body: '<p>您好</p><p><img src="cid:seal@x" alt="签章"></p>',
    inline_resources: [{content_id: 'seal@x', mime_type: 'image/png', file: 'F-seal', name: '签章.png'}],
    to: [], cc: [], from_address: 'a@b.com', attachments: []}]);
  try {
    await openMail(t, '来信带图');
    await tick(); await tick();
    // 读信：一个所见即所得的**只读快照**（没有第二个渲染页）
    const surface = t.doc().querySelector('[data-mail-body-wysiwyg]') as any;
    assert.ok(surface, '读信缺所见即所得的正文面');
    assert.equal(t.doc().querySelector('iframe.mail-body-preview'), null,
      '读信窗还挂着第二个渲染页（iframe）—— 用户要的是一个面');
    const surfaces = t.doc().querySelectorAll('.mail-body-editor, .mail-body-text, iframe.mail-body-preview');
    /* ★ 2026-10-17 判据口径修正（req 4 加了「纯文本」阅读入口）：
       原来数的是 **DOM 里有几个** 正文面。纯文本面是**隐藏的备选视图**，
       DOM 里多一个并不等于用户同时看到两个 —— 用户 2026-10-11 反对的是
       「渲染页和编辑器并排」，不是「不允许有切换用的第二种视图」。
       改成数**同一时刻看得见**的正文面，并补一条切换互斥检查（比原来更严）。 */
    const visibleFaces = () => [...surfaces].filter((el: any) => !el.hidden);
    assert.equal(visibleFaces().length, 1,
      `读信窗同一时刻只该看见一个正文面，实际 ${visibleFaces().length} 个`);
    /* ★ FIX-56（用户 2026-10-20 19:5x：「查看邮件的时候直接以富文本显示，
       不要『选择』是什么形式的文本」）：**那个「纯文本」切换入口撤了**
       （BASE967-24 req 4 加的）⇒ 读信窗**始终**是富文本面，
       **没有第二种形式可选**、**没有**备用的纯文本面。
       ⚠️ **口径变更**：下面原来那几条「该有纯文本入口 / 切过去 / 切回来」的断言
       **按新契约改了**（**不是删断言实质**）—— 实质从「切换后仍然只有一个可见面」
       变成「**压根没有切换、只有一个面**」；
       「同一时刻只有一个可见正文面」那条**一个字没动**。 */
    assert.equal(t.doc().querySelector('#toggle-plain-text'), null,
      '读信窗不该再有「纯文本」切换入口 —— 用户要的是「直接以富文本显示，不要『选择』是什么形式的文本」');
    assert.equal(t.doc().querySelector('#mail-body-plain'), null,
      '读信窗不该再留一份备用的纯文本面 —— 两套并存本身就是「选择」');
    const readEditor = surface.querySelector('.mail-body-editor') as any;
    assert.ok(readEditor, '读信正文面里没有编辑器');
    assert.equal(readEditor.hidden, false, '读信窗应当始终显示富文本面');
    /* 读信是**快照**：不能改、没有工具栏（父线 2026-10-21：「读信的时候是快照哦」）。 */
    assert.equal(readEditor.getAttribute('contenteditable'), 'false', '读信正文面不该能改');
    assert.equal(surface.querySelector('.mail-editor-toolbar'), null, '读信快照不该挂工具栏');
    // 读信的受管图要真的显示：按授权字节解析成 data:
    await tick(); await tick();
    await new Promise(r => setTimeout(r, 60));
    const readHtml = readEditor.innerHTML || '';
    assert.match(readHtml, /src="data:image\//i, `读信窗的受管图没显示，正文里没有 data:image —— ${readHtml.slice(0, 120)}`);
    assert.ok(!/src="https?:/i.test(readHtml), '读信窗放了外链图进来');

    // 写信：一个所见即所得编辑器，没有渲染页
    (t.doc().querySelector('#compose') as any).click();
    await tick(); await tick();
    assert.ok(t.doc().querySelector('.mail-body-editor'), '写信窗缺所见即所得的编辑器');
    assert.equal(t.doc().querySelector('.mail-compose-view iframe.mail-body-preview, #c-editor-host iframe'), null,
      '写信窗不该再挂一个渲染页');
  } finally { t.dispose(); }
});

/* 真实产品页实测（2026-10-11，N2-C1）：
   图停在 cid: 不动 —— 取字节打的是**平台模式已停用的旧接口** `/api/platform/files/content`
   （HTTP 410 LEGACY_SURFACE_DISABLED），映射表永远空，所以用户看到破图。
   而且就算换成活接口，还必须带**记录归属**（ref/ref_name），否则内核判不了权，
   回 403「无权读取该记录的附件」。

   测试通过 = 取受管内联图字节走 `/api/platform/file-content`，
   且请求里带 ref=Shangshu Mail Message、ref_name=这封信的 name —— 归属齐全，
   内核判得了权；并且**不再**碰那个 410 的旧接口。 */
it('受管内联图取字节走 file-content 且带记录归属，不再碰已停用的旧接口', async () => {
  const t = mount([{name: 'm-owner-7', status: 'Draft', subject: '归属核对', body_format: 'HTML', record_version: 1,
    body: '<p>见图</p><p><img src="cid:seal@x" alt="签章"></p>',
    inline_resources: [{content_id: 'seal@x', mime_type: 'image/png', file: 'F-seal', name: '签章.png'}],
    to: [], cc: [], attachments: []}]);
  try {
    await openMail(t, '归属核对');
    await tick(); await tick();

    assert.ok(t.fileFetches.length > 0, '一次都没去取受管图的字节，图不可能显示');
    for (const url of t.fileFetches) {
      assert.ok(url.includes('/api/platform/file-content'), `取字节打错接口了：${url.slice(0, 80)}`);
      assert.ok(!url.includes('/api/platform/files/content'), `还在碰已停用的旧接口：${url.slice(0, 80)}`);
      const u = new URL(url, 'http://localhost');
      assert.equal(u.searchParams.get('ref'), 'Shangshu Mail Message', `ref 不对，内核判不了权：${url.slice(0, 100)}`);
      assert.equal(u.searchParams.get('ref_name'), 'm-owner-7', `ref_name 不是这封信的 name：${url.slice(0, 100)}`);
      assert.equal(u.searchParams.get('file'), 'F-seal', `file 不对：${url.slice(0, 100)}`);
    }

    const img = t.doc().querySelector('.mail-body-editor img') as any;
    assert.match(img.getAttribute('src') || '', /^data:image\//i, '归属齐全了图却仍没解析出来');
  } finally { t.dispose(); }
});

/*
 2026-10-12 用户填 N3 验收表指出的两处 + 一句点名：

  「这个不是已经没有分号隔开了吗？」              —— 收件人报错还在叫人「多个用分号隔开」，
                                                    可现在是一枚胶囊一个人，压根没有分号这回事。
  「这个邮件胶囊的加号能不能跟着胶囊而不是右对齐？」 —— 加号该跟在胶囊后头，不该固定贴右。
  「收件人报错也放进公共提示组件里面去」          —— 不再让收件人栏自己一套红字。

 测试通过 = 下面全部成立：
  A. 收件人填认不出的地址时，提示里**不再提「分号」**这种旧输入框说法；
     也不许再拖「一次填一个人 / 点 + / 回车」那种说明书 —— 用户 2026-10-12 原话
     「就留一句"收件人……."不要有一次填一个人这种」。报错要走**错误色**（红）。
  B. 胶囊没挤满一行时，「+」**紧挨**最后一个胶囊（不贴右）；胶囊挤满时才落到右端。
  C. 「收件人认不出」和「压根没填收件人」两类报错，都走**右下角 toast 公共件**
     （#toast-zone .toast，且是 toast-error + role="alert"），
     收件人栏不再自己渲染一套 .dlg-error 红字。
*/

it('A 收件人报错只留一句话：不提分号、不拖说明书，且是红的 alert', async () => {
  const t = mount();
  try {
    await openCompose(t);
    const to = t.doc().querySelector('#c-to') as any;
    assert.ok(to, '找不到收件人栏');
    // 装一个认不出的地址（用户实测就是这个）
    to.value = '12@q';
    to.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await triggerSave(t);

    // 报错走右下角公共 toast；再拼上收件人栏自己的红字（不该有，但拼进来一起判文案）
    const toast = lastToast(t.w) as any;
    assert.ok(toast, '收件人报错没走右下角 toast 公共件');
    const texts = [
      toast.textContent || '',
      t.doc().querySelector('#e-to')?.textContent || '',
    ].join(' ');
    assert.ok(/12@q/.test(texts), `没报出认不出的地址：${JSON.stringify(texts)}`);
    assert.ok(!/分号/.test(texts),
        `还在叫人「分号隔开」—— 现在是一枚胶囊一个人，没有分号这回事：${JSON.stringify(texts)}`);
    // 用户改了口径：报错就是一句，不许再拖「怎么加下一个人」的说明书
    assert.ok(!/一次填一个人|点 \+|回车|加下一个人/.test(texts),
        `报错里还拖着说明书，用户说只要「收件人……」这一句：${JSON.stringify(texts)}`);
    // 报错要红（错误色）+ alert 语义，不能是绿色成功色
    assert.ok(toast.classList.contains('toast-error'),
        `收件人报错没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
  } finally { t.dispose(); }
});

it('B 「+」跟在胶囊后头，不是固定贴右', () => {
  const css = readFileSync(new URL('../../../shangshu-web/js/chip-input.js', import.meta.url), 'utf8');
  /* 为什么查源码：jsdom 不做布局，量不出真实位置（getBoundingClientRect 全是 0）。
     真实位置由产品页那条链上量（左端对齐 / 挤满时贴右）。这里钉的是**成因**：
     .chip-input-items 写 flex:1 会把胶囊区撑满整行，把「+」永久顶到最右。 */
  const itemsRule = /\.chip-input-items\{[^}]*\}/.exec(css);
  assert.ok(itemsRule, '找不到 .chip-input-items 的样式');
  assert.ok(!/flex\s*:\s*1\s*[;}]/.test(itemsRule[0]),
      `胶囊区被写成 flex:1 撑满整行，「+」会被顶到最右：${itemsRule[0]}`);
  assert.ok(/flex\s*:\s*0\s+1\s+auto/.test(itemsRule[0]),
      `胶囊区该按内容走、放不下才收（flex:0 1 auto），现在是：${itemsRule[0]}`);

  // DOM 顺序也得是「先胶囊区、后加号」，反过来加号会跑到前头
  const html = /root\.innerHTML\s*=\s*([\s\S]{0,400}?)\;/.exec(css);
  assert.ok(html, '找不到组件的 DOM 结构');
  const at = html[1].indexOf('data-chip-items');
  const plus = html[1].indexOf('data-chip-add');
  assert.ok(at >= 0 && plus > at, `「+」没排在胶囊区后面：${html[1].slice(0, 200)}`);
});

it('C 收件人报错走右下角 toast 公共件，收件人栏不再自己一套红字', async () => {
  const t = mount();
  try {
    await openCompose(t);
    const to = t.doc().querySelector('#c-to') as any;
    to.value = '12@q';
    to.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await triggerSave(t);

    const toast = lastToast(t.w) as any;
    assert.ok(toast, '右下角 toast 公共件不在');
    assert.ok(toast.classList.contains('toast-error'),
        `报错没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.ok(/12@q/.test(toast.textContent || ''),
        `公共提示里没说清是哪个地址认不出：${JSON.stringify(toast.textContent)}`);
    // 别让 #notice 这套劣等品复活
    assert.equal(t.doc().querySelector('#notice'), null, '页面里又贴回了 #notice');

    // 收件人栏不该再自己渲染一套红字
    for (const id of ['#e-to', '#e-cc']) {
      const el = t.doc().querySelector(id) as any;
      const shown = el && !el.hidden && (el.textContent || '').trim();
      assert.ok(!shown, `收件人栏还在自己渲染红字报错 ${id}：${JSON.stringify(shown)}`);
    }
  } finally { t.dispose(); }
});

it('C2 压根没填收件人时也走右下角 toast 公共件', async () => {
  const t = mount();
  try {
    await openCompose(t);
    const send = t.doc().querySelector('#c-send') as any;
    assert.ok(send, '找不到发送按钮');
    send.click();
    await tick(); await tick();

    const toast = lastToast(t.w) as any;
    assert.ok(toast, '没填收件人的报错没走右下角 toast 公共件');
    assert.ok(toast.classList.contains('toast-error'),
        `没填收件人的报错没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.ok(/收件人/.test(toast.textContent || ''),
        `公共提示没说清是没填收件人：${JSON.stringify(toast?.textContent)}`);
    assert.equal(t.doc().querySelector('#notice'), null, '页面里又贴回了 #notice');
    for (const id of ['#e-to', '#e-cc']) {
      const el = t.doc().querySelector(id) as any;
      const shown = el && !el.hidden && (el.textContent || '').trim();
      assert.ok(!shown, `收件人栏还在自己渲染红字报错 ${id}：${JSON.stringify(shown)}`);
    }
  } finally { t.dispose(); }
});
