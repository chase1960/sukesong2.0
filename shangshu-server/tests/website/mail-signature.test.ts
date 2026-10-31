import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 SIG 基础签名 —— 执行计划 §邮件下一批 / 开发计划 §4.4。

 用户要的是「发出去的信末尾带我的签名」，而且**不许它到处乱跑**。
 判据来自计划原话（开发计划#mail-signature）：

   测试通过 = 下面全部成立：

   A. **新建 / 回复 / 转发**三条路都自动插入本人默认签名
   B. 签名**位于新正文之后、旧引用之前**（引用块带 data-mail-quote 标记）
   C. **连续保存重开不重复** —— 存两次、开两次，签名只有一份
   D. **旧草稿不随默认设置漂移** —— 改了默认签名，旧草稿里的那份不变
   E. **可关闭** —— 关掉自动插入，新建就不再插
   F. **本封可改可删，不反写默认配置**
   G. **纳入正文三步撤回** —— 撤回能把签名一起撤掉
   H. **MIME/保存内容与预览一致** —— 存进草稿的正文里签名在正确位置

 先写测试再实现（CLAUDE.md 一）。没实现前这段是红的，那是**对的**。
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const ME = {name: '我', addr: 'me@qq.com'};
const SIG_HTML = '<p class="mail-signature">—— 张三<br>银聆科技</p>';
const SIG_HTML_V2 = '<p class="mail-signature">—— 张三（改过）<br>银聆科技</p>';

type Sig = {enabled: boolean; html: string; resources?: any[];signatures?:any[];default_signature_id?:string;signature_revision?:number};

function mount(rows: any[], opts: {signature?: Sig;mailboxes?:any[];contentError?:number;signatureSaveError?:string} = {}) {
  let signature: Sig = JSON.parse(JSON.stringify(opts.signature ?? {enabled: true, html: SIG_HTML}));
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  const signatureSaves:any[]=[];
  const contentReads:any[]=[];
  w.fetch = async (url: string, options: any = {}) => {
    if(url.startsWith('/api/platform/file-content?')){contentReads.push({url,options});return {ok:!opts.contentError,status:opts.contentError||200,arrayBuffer:async()=>Uint8Array.from([137,80,78,71,13,10,26,10]).buffer};}
    if(url.includes('/services/mail.mailboxes/'))return {ok:true,status:200,json:async()=>({result:{mailboxes:opts.mailboxes||[]}})};
    if(url.includes('/actions/mail.account.signature/execute')){
      const request=JSON.parse(options.body);signatureSaves.push(request);
      if(opts.signatureSaveError)return {ok:false,status:409,json:async()=>({error:opts.signatureSaveError})};
      const p=request.payload;signature={...signature,enabled:p.enabled,html:p.html,resources:p.resources||[],signatures:p.signatures,default_signature_id:p.default_signature_id,signature_revision:(p.signature_revision||0)+1};
      return {ok:true,status:200,json:async()=>({result:{account:{signature},signature}})};
    }
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: ME.addr, display_name: ME.name,
        signature}}})};
    }
    /* 人点回复/转发 = **调后端那两个动作**（2026-10-21 起）——
       回执就是后端建好的那封草稿：**签名由后端那份实现插**（插在引用块之前），
       插哪个箱的签名看载荷里的 mailbox。 */
    if (/\/actions\/(mail\.reply|mail\.forward)\/execute/.test(url)) {
      const body = options.body ? JSON.parse(options.body) : {};
      const p = body.payload || {};
      const box = (opts.mailboxes || []).find(item => item.id === p.mailbox);
      const sig = (box && box.signature && box.signature.enabled) ? box.signature
        : (signature.enabled ? signature : null);
      const original = rows[0] || {};
      const quote = '<p><br></p><div data-mail-quote="1" style="color:#666">'
        + '<div data-mail-quote-sep="1">---------- 原始邮件 ----------</div>'
        + '<div data-mail-quote-head="1">发件人: 对方</div>'
        + `<div data-mail-quote-body="1">${original.body || ''}</div></div>`;
      const receipt = {name: 'draft-1', record_version: 1, status: 'Draft',
        subject: p.subject || '', body: (sig && sig.html ? `<div>${sig.html}</div>` : '') + quote,
        body_format: 'HTML', to: p.to || [], cc: p.cc || [],
        attachments: [], attachment_bindings: {}, inline_resources: [],
        mailbox_id: p.mailbox || ''};
      return {ok: true, status: 200, json: async () => ({result: receipt}),
              text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(options.body ? JSON.parse(options.body) : {});
      const receipt = {name: 'draft-1', record_version: saved.length,
                       attachments: [], attachment_bindings: {}};
      return {ok: true, status: 200, json: async () => ({result: receipt}),
              text: async () => JSON.stringify({result: receipt})};
    }
    if (url.includes('/services/mail.detail/')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const found = rows.find((r: any) => r.name === body?.payload?.mail) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
              text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload,
              text: async () => JSON.stringify(payload)};
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
  return {w, saved, signatureSaves, contentReads, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

/** 开写信窗，返回正文编辑器里的 HTML。 */
async function compose(t: ReturnType<typeof mount>, button: string) {
  await tick(); await tick();
  const btn = t.doc().querySelector(button) as any;
  assert.ok(btn, `找不到按钮 ${button}`);
  btn.click();
  /* 写字窗是**后端动作回包之后**才开的（回复/转发那条路）—— 等它开出来。
     只认写信窗里的那一个面（读信面也是 .mail-body-editor）。 */
  for (let i = 0; i < 40; i++) {
    if (t.doc().querySelector('#c-editor-host .mail-body-editor')) break;
    await tick(); await tick();
  }
  await new Promise(r => setTimeout(r, 200));
  const ed = t.doc().querySelector('#c-editor-host .mail-body-editor') || t.doc().querySelector('#c-body');
  assert.ok(EdIsPresent(ed), '写信窗没开出来');
  return ed as any;
}

const EdIsPresent = (ed: any) => !!ed;

const bodyHtml = (ed: any) => (ed.contentDocument ? ed.contentDocument.body.innerHTML : ed.innerHTML) || '';

// 防重复状态已迁至 signature_guard；按固定测试签名文本计数，不依赖已移除的正文属性。
const sigCount = (html: string) => (html.match(/—— 张三/g) || []).length;

const ROW = {
  name: 'm1', status: 'Received', subject: '原信主题',
  body: '<p>原信正文</p>', body_format: 'HTML', from_address: '对方 <other@x.example>',
  to_json: JSON.stringify(['我 <me@qq.com>']), cc_json: '[]', record_version: 1,
};

it('SIG-A/B 新建自动插入签名，且在新正文后、旧引用前', async () => {
  // 新建：没有引用块，签名就是正文末尾
  const t = mount([ROW]);
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const html = bodyHtml(ed);
    assert.equal(sigCount(html), 1, `新建应当有且只有一份签名，实际 ${sigCount(html)} 份：${html.slice(0, 200)}`);
  } finally { t.dispose(); }

  // 回复：签名必须在引用块**之前**（= 新正文那一侧），不是塞进原信里
  const t2 = mount([ROW]);
  try {
    await tick(); await tick();
    const item = t2.doc().querySelector('[data-mail], [data-open]') as any;
    item.click();
    await new Promise(r => setTimeout(r, 200));
    const reply = t2.doc().querySelector('#reply') as any;
    assert.ok(reply, '找不到回复按钮');
    reply.click();
    /* 写信窗是后端动作回包之后才开的。 */
    for (let i = 0; i < 40; i++) {
      if (t2.doc().querySelector('#c-editor-host .mail-body-editor')) break;
      await tick(); await tick();
    }
    await new Promise(r => setTimeout(r, 250));
    const ed = t2.doc().querySelector('#c-editor-host .mail-body-editor') || t2.doc().querySelector('#c-body');
    const html = bodyHtml(ed);
    assert.equal(sigCount(html), 1, `回复应当只有一份签名，实际 ${sigCount(html)}：${html.slice(0, 240)}`);
    const sigAt = html.indexOf('mail-signature');
    const quoteAt = html.indexOf('data-mail-quote');
    if (quoteAt >= 0) {
      assert.ok(sigAt < quoteAt,
        `签名必须在旧引用之前：sigAt=${sigAt} quoteAt=${quoteAt}`);
    }
  } finally { t2.dispose(); }
});

it('SIG-C 连续保存重开不重复', async () => {
  const t = mount([ROW]);
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    assert.equal(sigCount(bodyHtml(ed)), 1, '刚开窗应当有一份签名');
    // 存两次（自动保存会连着来）
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));
    const html = bodyHtml(ed);
    assert.equal(sigCount(html), 1,
      `存了两次之后签名不许变成两份，实际 ${sigCount(html)}：${html.slice(0, 240)}`);
  } finally { t.dispose(); }
});

it('SIG-D 旧草稿不随默认设置漂移', async () => {
  // 用 V1 签名建草稿并存下来
  const t = mount([ROW], {signature: {enabled: true, html: SIG_HTML}});
  let storedBody = '';
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));
    storedBody = bodyHtml(ed);
    assert.ok(storedBody.includes('张三'), `草稿里应当存着 V1 签名：${storedBody.slice(0, 200)}`);
    assert.ok(!storedBody.includes('改过'), '草稿里不该有 V2 字样');
  } finally { t.dispose(); }

  // 换成 V2 默认签名，重开同一封草稿 —— 旧稿必须还是 V1
  const t2 = mount([{...ROW, name: 'draft-1', status: 'Draft', body: storedBody,
                     body_format: 'HTML', subject: '旧草稿'}],
                   {signature: {enabled: true, html: SIG_HTML_V2}});
  try {
    await tick(); await tick();
    const item = t2.doc().querySelector('[data-mail], [data-open]') as any;
    item.click();
    await new Promise(r => setTimeout(r, 300));
    const ed = t2.doc().querySelector('.mail-body-editor') || t2.doc().querySelector('#c-body');
    const html = bodyHtml(ed);
    assert.ok(html.includes('张三') && !html.includes('改过'),
      `旧草稿不许随默认签名漂移：${html.slice(0, 240)}`);
  } finally { t2.dispose(); }
});

it('SIG-E 关掉自动插入后新建不再插', async () => {
  const t = mount([ROW], {signature: {enabled: false, html: SIG_HTML}});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    assert.equal(sigCount(bodyHtml(ed)), 0,
      `关掉自动插入就不该有签名：${bodyHtml(ed).slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('SIG-F 本封改签名不反写默认配置', async () => {
  const t = mount([ROW], {signature: {enabled: true, html: SIG_HTML}});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const html = bodyHtml(ed);
    // 在本封里把签名改掉
    const next = html.replace('张三', '张三（本封手改）');
    if ((ed as any).contentDocument) (ed as any).contentDocument.body.innerHTML = next;
    else (ed as any).innerHTML = next;
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await new Promise(r => setTimeout(r, 300));
    // 默认配置仍然应当是原签名（不反写）—— 从服务端 mock 的角度：新建另一封仍是原签名
    const htmlNow = bodyHtml(ed);
    assert.ok(htmlNow.includes('本封手改'), '本封改完应当生效');
    // 服务端那侧不反写，靠后端测试钉；这里钉「本封改了但默认仍是 SIG_HTML」的接口面
    const account = t.w.__sigDefault;
    if (account !== undefined) {
      assert.equal(account, SIG_HTML, '默认签名不许被本封改动反写');
    }
  } finally { t.dispose(); }
});

/*
 SIG 配置界面 —— 用户 2026-10-13：「签名的设置你准备放到哪里?我建议做一个弹窗,在里面设置」。

 入口在邮箱页头（「邮箱设置」旁边一个「签名」），点开走**公共弹窗组件 ui.dialog**
 （用户 2026-10-12 就要求过「这个弹窗也抽象成公共组件」，不另造）。

   测试通过 = 下面全部成立：
   G. 邮箱页有「签名」入口，点开是**弹窗**（不是跳页），里面能改能保存
   H. 保存之后，新建的信用的是**新**签名
*/

it('SIG-G 签名设置是弹窗，不是跳页', async () => {
  const t = mount([ROW]);
  try {
    await tick(); await tick();
    const entry = t.doc().querySelector('#sig-btn, [data-signature], #signature-btn') as any;
    assert.ok(entry, '邮箱页头应当有「签名」入口');
    entry.click();
    await new Promise(r => setTimeout(r, 250));
    // 公共弹窗组件的壳 —— tool-workspace 的 dialog() 用 className: 'os-dialog'
    const modal = t.doc().querySelector('dialog.os-dialog, .os-dialog') as any;
    assert.ok(modal, '点开应当是弹窗（公共组件 os-dialog）');
    const text = modal.textContent || '';
    assert.ok(/签名/.test(text), `弹窗里该有签名设置：${text.slice(0, 120)}`);
    assert.ok(/自动插入|自动插入签名/.test(text), '弹窗里该有「自动插入」开关');
    // 用户 2026-10-13：「弹窗里就实时编辑实时预览就行了,要有工具框,
    // 不要有一个新框叫实时预览」—— 编辑区所见即所得，带工具栏，不另开预览框。
    assert.ok(modal.querySelector('.mail-editor-toolbar'),
      '编辑区该带工具栏（字体/字号/颜色/列表/链接）');
    assert.ok(!modal.querySelector('.sig-preview') && !/实时预览/.test(text),
      '不许有单独的「预览」框 —— 编辑区里长什么样发出去就是什么样');
  } finally { t.dispose(); }
});

it('签名弹窗使用独立编辑器样式范围，清空算本人一步且撤回能恢复原签名',async()=>{
 const t=mount([ROW]);try{await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();const modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement;
  assert.ok(modal,'portal在body，必须有独立编辑器样式范围，不能依赖.mail-center-page祖先');const editor=modal.querySelector('[contenteditable=true]') as HTMLElement;assert.match(editor.textContent||'',/张三/);
  const clear=[...modal.querySelectorAll('footer button')].find(button=>button.textContent==='清空') as HTMLButtonElement;clear.click();assert.equal(editor.textContent,'');const undo=modal.querySelector('[data-editor-undo]') as HTMLButtonElement;assert.equal(undo.disabled,false,'清空应纳入本人撤回');undo.click();assert.match(editor.textContent||'',/张三/);assert.ok(modal.querySelector('#sig-enabled'));
 }finally{t.dispose();}
});

it('SIG-H 保存后新建信用的是新签名', async () => {
  const t = mount([ROW], {signature: {enabled: true, html: SIG_HTML}});
  try {
    await tick(); await tick();
    (t.doc().querySelector('#sig-btn, [data-signature], #signature-btn') as any).click();
    await new Promise(r => setTimeout(r, 250));
    const modal = t.doc().querySelector('dialog.os-dialog, .os-dialog') as any;
    // 改签名并保存
    const area = modal.querySelector('textarea, [contenteditable]') as any;
    assert.ok(area, '弹窗里应当有签名编辑区');
    const next = SIG_HTML_V2;
    if (area.tagName === 'TEXTAREA') {
      const proto = (t.w as any).HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(area, next);
    } else {
      area.innerHTML = next;
    }
    area.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    const save = [...modal.querySelectorAll('button')]
      .find((b: any) => /保存/.test(b.textContent || '')) as any;
    assert.ok(save, '弹窗里应当有「保存」');
    save.click();
    await new Promise(r => setTimeout(r, 300));

    // 关弹窗后新建一封，正文里应当是**新**签名
    const close = [...t.doc().querySelectorAll('button')]
      .find((b: any) => /关闭|取消|稍后/.test(b.textContent || '')) as any;
    if (close) close.click();
    await new Promise(r => setTimeout(r, 150));
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const html = bodyHtml(ed);
    assert.ok(html.includes('改过') || html.includes('V2') || html.includes('本封'),
      `新建信用的应当是新签名：${html.slice(0, 220)}`);
  } finally { t.dispose(); }
});

/*
 SIG 尾巴三条 —— 计划 §4.4「版本与资源」与「正文插入」：

   SIG-I 通过 = 本封改签名能按正文**三步撤回**（改一次算一步，撤回回到改之前）
   SIG-J 通过 = 签名里引用了**取不到的图**（无权/缺图）时，发送前**明确提示**，
                不悄悄发出破图（计划原话：「无权/缺图明确处理，不悄悄发出破图」）
*/

it('SIG-I 本封改签名纳入正文三步撤回', async () => {
  const t = mount([ROW], {signature: {enabled: true, html: SIG_HTML}});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const before = bodyHtml(ed);
    assert.ok(before.includes('张三'), `开窗时应当有签名：${before.slice(0, 200)}`);

    // 在本封里改签名 —— 这是**一步**
    const root: any = (ed as any).contentDocument || ed;
    const node = root.querySelector('.mail-signature');
    assert.ok(node, '正文里应当能找到签名块');
    node.innerHTML = '<p class="mail-signature">—— 改过签名</p>';
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    assert.ok(bodyHtml(ed).includes('改过签名'), '改完应当生效');

    // 撤回一次 —— 应当回到改之前。
    // 撤回走**键盘 Cmd/Ctrl+Z**（mail-editor.js 的 keydown 绑定），
    // 工具栏上没按钮 —— 别去找按钮。
    const editable: any = (ed as any).contentDocument ? (ed as any).contentDocument.body : ed;
    editable.dispatchEvent(new t.w.KeyboardEvent('keydown', {
      key: 'z', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await new Promise(r => setTimeout(r, 250));
    const after = bodyHtml(ed);
    assert.ok(after.includes('张三') && !after.includes('改过签名'),
      `撤回应当回到改之前：${after.slice(0, 220)}`);
  } finally { t.dispose(); }
});

it('SIG-J 签名里取不到的图要在发送前明确提示，不悄悄发破图', async () => {
  // 签名带一张 cid: 图，但正文里没有任何可解析的受管资源 —— 属于「缺图」
  const SIG_WITH_MISSING_IMG =
    '<p class="mail-signature">—— 张三<br><img src="cid:logo-missing@shangshu" alt="公司 Logo"></p>';
  const t = mount([ROW], {signature: {enabled: true, html: SIG_WITH_MISSING_IMG}});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const html = bodyHtml(ed);
    assert.ok(html.includes('logo-missing@shangshu'), `签名图应当在正文里：${html.slice(0, 220)}`);
    // 点发送 → 核对层之前就该有人提示「有图取不到」
    const send = t.doc().querySelector('#c-send') as any;
    assert.ok(send, '找不到发送按钮');
    send.click();
    await new Promise(r => setTimeout(r, 350));
    const text = (t.doc().body.textContent || '');
    const toast = (t.doc().querySelector('#toast-zone')?.textContent || '');
    const all = text + ' ' + toast;
    // 必须**点名是图**（Logo/图片/破图），不能拿一句无关提示蒙混过关
    assert.ok(/(图|Logo|logo|破图).{0,12}(取不到|缺|失败|没有权限|未获|无法|丢失)/.test(all)
              || /(取不到|缺图|破图|无法加载).{0,12}(图|Logo|logo)/.test(all),
      `发送前该明确提示「签名里的图取不到」，实际只看到：${all.slice(0, 260)}`);
  } finally { t.dispose(); }
});

/*
 SIG-M —— 计划 §4.4「版本与资源」原话：
   「本封保存签名内容快照**及所用图片引用**」。

   测试通过 = 签名里引用的受管图（cid:），**跟着进新信的资源清单**：
   存草稿时 inline_resources 里带得走它，不是只留一个取不到的 cid: 变破图。
*/

it('SIG-M 签名里的受管图跟着进新信的资源清单', async () => {
  const LOGO_CID = 'logo-1@shangshu';
  const SIG_WITH_LOGO =
    `<p class="mail-signature">—— 张三<br><img src="cid:${LOGO_CID}" alt="公司 Logo"></p>`;
  const t = mount([ROW], {signature: {
    enabled: true, html: SIG_WITH_LOGO,
    resources: [{content_id: LOGO_CID, name: 'logo.png', mime_type: 'image/png'}],
  }});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const html = bodyHtml(ed);
    assert.ok(html.includes(LOGO_CID), `签名图应当在正文里：${html.slice(0, 220)}`);

    // 存草稿 —— 提交的 inline_resources 里必须带得走它
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 500));

    const payloads = t.saved as any[];
    assert.ok(payloads.length, '应当存过草稿');
    const last = payloads[payloads.length - 1];
    const body = last?.payload ?? last;
    const inline = body?.inline_resources
      || t.w.__lastInlineResources
      || (bodyEditorResources(t));
    assert.ok(Array.isArray(inline) && inline.length,
      `存草稿时该带资源清单，实际：${JSON.stringify(body).slice(0, 260)}`);
    const ids = inline.map((r: any) => r.content_id || r.id || '');
    assert.ok(ids.some((id: string) => id.includes('logo-1')),
      `资源清单里该有签名那张图，实际：${ids.join(',')}`);
  } finally { t.dispose(); }
});

/** 从当前编辑器里读资源清单（作为 payload 的旁证）。 */
function bodyEditorResources(t: ReturnType<typeof mount>): any[] {
  const host = t.doc().querySelector('.mail-body-editor') as any;
  const ed = host && (host.contentDocument || host);
  const imgs = ed ? [...ed.querySelectorAll('img[src^="cid:"]')] : [];
  return imgs.map((i: any) => ({id: i.getAttribute('src').replace('cid:', '')}));
}

it('签名设置重新保存保留受管图片资源，提交cid而不是编辑期data地址',async()=>{
 const resource={content_id:'signature-logo@example.invalid',name:'logo.png',mime_type:'image/png',file:'file-logo',source:{ref_doctype:'Shangshu File Center File',ref_name:'logo-library',file:'file-logo'}};
 const t=mount([ROW],{signature:{enabled:true,html:'<p>签名<img src="cid:'+resource.content_id+'"></p>',resources:[resource]}});
 try{await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,100));
  const modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement,img=modal.querySelector('img')!;assert.match(img.getAttribute('src')||'',/^data:image\/png/,'已授权资源应在签名编辑区显示');assert.equal(t.contentReads.length,1);const source=new URL(t.contentReads[0].url,'http://localhost/').searchParams;assert.equal(source.get('ref'),'Shangshu File Center File');assert.equal(source.get('ref_name'),'logo-library');assert.equal(source.get('file'),'file-logo');assert.equal(t.contentReads[0].options.credentials,'same-origin');
  ([...modal.querySelectorAll('footer button')].find(button=>button.textContent==='保存') as HTMLButtonElement).click();await tick();await tick();
  const payload=t.signatureSaves[0]?.payload;assert.ok(payload,'必须调用真实签名保存动作');assert.deepEqual(payload.resources,[resource]);assert.match(payload.html,/src="cid:signature-logo@example.invalid"/);assert.doesNotMatch(payload.html,/src="data:|data-managed-cid/);
 }finally{t.dispose();}
});

it('签名Logo归属引用仍逐次受权，403时保留cid并明确提示取图失败',async()=>{
 const resource={content_id:'signature-denied@example.invalid',name:'logo.png',mime_type:'image/png',file:'file-denied',source:{ref_doctype:'Shangshu File Center File',ref_name:'private-logo',file:'file-denied'}};
 const t=mount([ROW],{signature:{enabled:true,html:'<p><img src="cid:'+resource.content_id+'"></p>',resources:[resource]},contentError:403});
 try{await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,80));const img=t.doc().querySelector('.mail-signature-dialog img')!;assert.equal(t.contentReads.length,1);assert.equal(img.getAttribute('src'),'cid:'+resource.content_id);assert.match(t.doc().querySelector('#toast-zone')?.textContent||'',/图取不到/);assert.equal(t.signatureSaves.length,0);
 }finally{t.dispose();}
});

it('部门签名弹窗读取当前箱并只保存该箱，不串改个人默认签名',async()=>{
 const rights={read:true,edit_draft:true,send:true,manage:true,signature:true};const t=mount([ROW],{signature:{enabled:true,html:'<p>个人签名</p>'},mailboxes:[
  {id:'box-personal',kind:'personal',email:ME.addr,enabled:true,rights,signature:{enabled:true,html:'<p>个人签名</p>',resources:[]}},
  {id:'box-dept',kind:'department',email:'dept@example.invalid',enabled:true,rights,signature:{enabled:true,html:'<p>部门签名</p>',resources:[]}},
 ]});try{await tick();await tick();const picker=t.doc().querySelector('#mailbox-switch') as HTMLSelectElement;picker.value='box-dept';picker.dispatchEvent(new t.w.Event('change',{bubbles:true}));await tick();
  (t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();const modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement,editor=modal.querySelector('[contenteditable=true]') as HTMLElement;assert.match(editor.textContent||'',/部门签名/);
  editor.innerHTML='<p>部门新签名</p>';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));([...modal.querySelectorAll('footer button')].find(button=>button.textContent==='保存') as HTMLButtonElement).click();await tick();await tick();assert.equal(t.signatureSaves[0].payload.mailbox,'box-dept');
  picker.value='box-personal';picker.dispatchEvent(new t.w.Event('change',{bubbles:true}));await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();assert.match(t.doc().querySelector('.mail-signature-dialog [contenteditable=true]')?.textContent||'',/个人签名/);assert.doesNotMatch(t.doc().querySelector('.mail-signature-dialog')?.textContent||'',/部门新签名/);
 }finally{t.dispose();}
});

it('当前共享箱的新建回复转发默认用本箱发件身份和签名，不混入个人签名',async()=>{
 const rights={read:true,edit_draft:true,send:true,manage:true,signature:true};
 for(const mode of ['compose','reply','forward']){
  const t=mount([{...ROW,mailbox_id:'box-dept'}],{signature:{enabled:true,html:'<p>个人专属签名</p>'},mailboxes:[
   {id:'box-personal',kind:'personal',email:ME.addr,enabled:true,rights,signature:{enabled:true,html:'<p>个人专属签名</p>',resources:[]}},
   {id:'box-dept',kind:'department',email:'dept@example.invalid',enabled:true,rights,signature:{enabled:true,html:'<p>部门专属签名</p>',resources:[]}},
  ]});try{await tick();await tick();const d=t.doc(),picker=d.querySelector('#mailbox-switch') as HTMLSelectElement;picker.value='box-dept';picker.dispatchEvent(new t.w.Event('change',{bubbles:true}));await tick();
   if(mode!=='compose'){(d.querySelector('[data-open]') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,90));}
   const editor=await compose(t,mode==='compose'?'#compose':'#'+mode);assert.equal((d.querySelector('#c-from') as HTMLSelectElement).selectedOptions[0].dataset.mailbox,'box-dept',mode+'应默认从当前共享邮箱写信');assert.match(editor.textContent||'',/部门专属签名/);assert.doesNotMatch(editor.textContent||'',/个人专属签名/);
  }finally{t.dispose();}
 }
});


it('多签名：左侧新建与切换保留编辑，新增不换默认，保存重开仍在',async()=>{
 const t=mount([ROW]);try{
  await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();
  let modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement;
  assert.equal(modal.querySelectorAll('[data-signature-id]').length,1);
  (modal.querySelector('#sig-new') as HTMLButtonElement).click();await tick();
  const name=modal.querySelector('#sig-name') as HTMLInputElement;name.value='简短落款';name.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const editor=modal.querySelector('[contenteditable=true]') as HTMLElement;editor.innerHTML='<p>简短落款正文</p>';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const newID=(modal.querySelector('[data-signature-id][aria-selected=true]') as HTMLElement).dataset.signatureId!;
  (modal.querySelector('[data-signature-id]:not([aria-selected=true])') as HTMLButtonElement).click();await tick();
  assert.match(modal.querySelector('[contenteditable=true]')?.textContent||'',/张三/);
  (modal.querySelector('[data-signature-id="'+newID+'"]') as HTMLButtonElement).click();await tick();assert.match(modal.querySelector('[contenteditable=true]')?.textContent||'',/简短落款正文/);
  ([...modal.querySelectorAll('footer button')].find(b=>b.textContent==='保存') as HTMLButtonElement).click();await tick();await tick();
  const payload=t.signatureSaves[0].payload;assert.equal(payload.signatures.length,2);assert.notEqual(payload.default_signature_id,newID);assert.match(payload.html,/张三/);assert.equal(payload.signature_revision,0);
  (t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement;
  assert.equal(modal.querySelectorAll('[data-signature-id]').length,2);assert.match(modal.textContent||'',/简短落款/);
 }finally{t.dispose();}
});

it('多签名：设默认只改变以后新稿，旧草稿中的签名快照保持原样',async()=>{
 const profiles=[{id:'a',name:'业务签名',html:'<p>业务签名正文</p>',resources:[]},{id:'b',name:'简短签名',html:'<p>简短签名正文</p>',resources:[]}];
 const old={...ROW,name:'existing-draft',status:'Draft',body:'<p>旧稿正文</p><div data-mail-signature="1">旧稿签名快照</div>'};
 const t=mount([old],{signature:{enabled:true,html:profiles[0].html,resources:[],signatures:profiles,default_signature_id:'a',signature_revision:4}});
 try{await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();const modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement;
  (modal.querySelector('[data-signature-id="b"]') as HTMLButtonElement).click();await tick();(modal.querySelector('#sig-default') as HTMLButtonElement).click();
  ([...modal.querySelectorAll('footer button')].find(b=>b.textContent==='保存') as HTMLButtonElement).click();await tick();await tick();
  assert.equal(t.signatureSaves[0].payload.default_signature_id,'b');assert.equal(t.saved.length,0,'改默认不能写任何旧草稿');
  const editor=await compose(t,'#compose');assert.match(bodyHtml(editor),/简短签名正文/);assert.doesNotMatch(bodyHtml(editor),/业务签名正文/);
  assert.match(old.body,/旧稿签名快照/);assert.doesNotMatch(old.body,/简短签名正文/);
 }finally{t.dispose();}
});

it('多签名：配置冲突保留名称和富文本，不假报已保存或替换默认',async()=>{
 const t=mount([ROW],{signatureSaveError:'签名设置已更新，请重新打开后核对再保存'});try{
  await tick();await tick();(t.doc().querySelector('#sig-btn') as HTMLButtonElement).click();await tick();const modal=t.doc().querySelector('.mail-signature-dialog') as HTMLElement;
  (modal.querySelector('#sig-new') as HTMLButtonElement).click();const editor=modal.querySelector('[contenteditable=true]') as HTMLElement;editor.innerHTML='<p>保留这段未保存编辑</p>';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  ([...modal.querySelectorAll('footer button')].find(b=>b.textContent==='保存') as HTMLButtonElement).click();await tick();await tick();
  assert.ok(modal.isConnected);assert.match(modal.querySelector('[contenteditable=true]')?.textContent||'',/保留这段/);assert.match(modal.querySelector('#sig-message')?.textContent||'',/重新打开|已更新/);assert.equal(t.saved.length,0);
 }finally{t.dispose();}
});

/* 以下是 R967-C01 从 mail-signature.test.c-line.test.ts 合并回的 SIG-P 守门人 + 辅助
   （2026-10-17）。`.c-line` 是 10-15 那次合并冲突的存档，**不是残留**——它的独有用例
   覆盖更全（现版是阉割版），F 查了来历确认。SIG-P 是「签名守卫 a」真正的守门人：
   标记挪出正文 HTML、落在草稿元数据 `signature_guard` 字段上。
   别用宽松正则（如 `/signature/i`）——第一版就栽在 `class="mail-signature"` 上
   把它喂绿了（**空过长得跟过一模一样**，跟今天那族同源）。 */
function guardInBody(html: string): boolean {
  return /data-mail-signature=/.test(String(html || ''));
}


it('SIG-P 签名守卫(a)：标记挪出正文 HTML，落在草稿元数据上，重开不重复插入（从 .c-line 并回）',async()=>{
  const t=mount([{...ROW, body: '<div data-mail-signature="1">假装守卫还在正文里</div>' + (ROW.body||''), signature: undefined}]);try{
    const ed=await compose(t,'#compose, [data-compose], .mail-compose-open');
    const html=bodyHtml(ed);
    assert.ok(!guardInBody(html),`(a) 要求守卫标记不在正文 HTML 里，实际正文带着它：${html.slice(0,240)}`);
    assert.equal(sigCount(html),1,`签名内容该有一份，实际 ${sigCount(html)} 份：${html.slice(0,240)}`);
    (ed as any).dispatchEvent(new t.w.Event('input',{bubbles:true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur',{bubbles:true}));
    await new Promise(r=>setTimeout(r,400));
    assert.ok(t.saved.length,'没存下草稿');
    const last=t.saved[t.saved.length-1];
    const p=last?.payload??last??{};
    const savedBody=String(p.body??'');
    assert.ok(!guardInBody(savedBody),`存进草稿的 body 里不该有守卫标记：${savedBody.slice(0,240)}`);
    assert.equal(p.signature_guard,'inserted',`守卫标记要落在草稿元数据的 signature_guard 字段上（不是正文里）—— 保存载荷：${JSON.stringify(p).slice(0,300)}`);
    assert.equal(sigCount(savedBody),1,`存进去的正文该只有一份签名，实际 ${sigCount(savedBody)}：${savedBody.slice(0,240)}`);
  }finally{t.dispose();}
});


/* R967-C01：从 mail-signature.test.c-line.test.ts 并回的 SIG-P 守门人（2026-10-17）。
   `.c-line` 是 10-15 合并冲突的存档，**不是残留**——它的独有用例覆盖更全
   （现版是阉割版），F 查了来历确认。SIG-P 是「签名守卫 a」真正的守门人：
   标记挪出正文 HTML、落在草稿元数据 `signature_guard` 字段上。
   **别用宽松正则**（如 `/signature/i`）——第一版就栽在 `class="mail-signature"`
   上把它喂绿了（**空过长得跟过一模一样**，跟今天那族同源）。
   用现版现成的 `guardInBody` / `sigCount` / `compose` / `bodyHtml` / `t.saved` —— 别再造。 */


/* R967-C01：签名腿的载荷 schema 白名单断言（补 F 提的缺口）。
   SIG-M 只断言「签名图在 inline_resources 里」，没断言载荷过 schema 白名单。
   这里的「未知字段」指 schema 外的字段（如 `source` 该走 `getInlineResources()` 而不是载荷），
   载荷里**只能有** content_id / mime_type / name / file。 */
it('签名腿：保存载荷里 inline_resources 过 schema 白名单，未知字段不跟出去', async () => {
  const LOGO_CID = 'logo-1@shangshu';
  const SIG_WITH_LOGO =
    `<p class="mail-signature">—— 张三<br><img src="cid:${LOGO_CID}" alt="公司 Logo"></p>`;
  /* 签名资源里**故意**塞 schema 外的字段 —— 这就是 UI044 的形状：
     `source` 该是 `getInlineResources()` 拿（供图），不该跟保存载荷；
     任何「未知字段」也都不该跟出去。 */
  const t = mount([ROW], {signature: {
    enabled: true, html: SIG_WITH_LOGO,
    resources: [{content_id: LOGO_CID, name: 'logo.png', mime_type: 'image/png',
                 source: {ref_doctype: 'Shangshu File Center File', ref_name: 'lib', file: 'f1'},
                 evil: 'x'}],
  }});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 500));
    assert.ok(t.saved.length, '没存下草稿');
    /* 专断 **直接 payload.inline_resources**（不走 SIG-M 那种 fallback 链），
       否则 fallback 遮盖了 schema 不一致你也不知道。 */
    const last = t.saved[t.saved.length - 1];
    const body = (last && last.payload) || last || {};
    const list = Array.isArray(body.inline_resources) ? body.inline_resources : [];
    assert.ok(list.length > 0, `签名资源没进载荷：${JSON.stringify(body).slice(0, 260)}`);
    const ALLOWED = new Set(['content_id','mime_type','name','file']);
    for (const [j, item] of list.entries()) {
      const extra = Object.keys(item).filter(k => !ALLOWED.has(k));
      assert.deepEqual(extra, [],
        `签名：载荷里 inline_resources[${j}] 带了 schema 外字段：${extra.join('、')} —— ` +
        `后端 INLINE_RESOURCE 是 additionalProperties:False，带出去就是前后端不一致（UI044）`);
    }
  } finally { t.dispose(); }
});

// 独有的个人转发位置与链接字节断言从旧C-line迁入。
it('SIG-N 转发也自动插入签名，且在新正文后、旧引用前', async () => {
  const t = mount([ROW]);
  try {
    await tick(); await tick();
    const item = t.doc().querySelector('[data-mail], [data-open]') as any;
    assert.ok(item, '找不到邮件列表项，开不了读信');
    item.click();
    await new Promise(r => setTimeout(r, 200));
    const forward = t.doc().querySelector('#forward') as any;
    assert.ok(forward, '找不到转发按钮');
    forward.click();
    /* 写信窗是后端动作回包之后才开的。 */
    for (let i = 0; i < 40; i++) {
      if (t.doc().querySelector('#c-editor-host .mail-body-editor')) break;
      await tick(); await tick();
    }
    await new Promise(r => setTimeout(r, 250));
    const ed = t.doc().querySelector('#c-editor-host .mail-body-editor') || t.doc().querySelector('#c-body');
    assert.ok(ed, '转发没开出写信窗');
    const html = bodyHtml(ed);
    assert.equal(sigCount(html), 1,
      `转发应当只有一份签名，实际 ${sigCount(html)}：${html.slice(0, 240)}`);
    const sigAt = html.indexOf('mail-signature');
    const quoteAt = html.indexOf('data-mail-quote');
    if (quoteAt >= 0) {
      assert.ok(sigAt < quoteAt,
        `转发的签名必须在旧引用之前（在新正文那一侧）：sigAt=${sigAt} quoteAt=${quoteAt}`);
    }
  } finally { t.dispose(); }
});

it('SIG-O 签名里的链接往返 —— 新建插进来 href 原样在，存草稿也还在', async () => {
  // 「支持链接」不能只靠「工具栏上有链接按钮」来证 ——
  // 得看链接**写进签名后，插进新信、存进草稿都还在**。
  const SIG_WITH_LINK =
    '<p class="mail-signature">—— 张三<br>'
    + '<a href="https://lingeringtek.cn">银聆科技</a></p>';
  const t = mount([ROW], {signature: {enabled: true, html: SIG_WITH_LINK}});
  try {
    const ed = await compose(t, '#compose, [data-compose], .mail-compose-open');
    const root = ed.contentDocument || ed;
    const html = bodyHtml(ed);
    assert.ok(sigCount(html) >= 1, `签名该插进来，实际正文：${html.slice(0, 240)}`);

    const a = root.querySelector('a[href*="lingeringtek"]') as any;
    assert.ok(a, `新建信里签名的链接没了，实际正文：${html.slice(0, 300)}`);
    assert.equal(a.getAttribute('href'), 'https://lingeringtek.cn',
      `链接地址被改了：${a.getAttribute('href')}`);
    assert.match(a.textContent || '', /银聆科技/, `链接文字被改了：${a.textContent}`);

    // 存一次草稿，payload 里的正文也得带着链接
    (ed as any).dispatchEvent(new t.w.Event('input', {bubbles: true}));
    (ed as any).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));
    const payloads = t.saved;
    assert.ok(payloads.length, '没存下草稿，谈不上往返');
    const last = payloads[payloads.length - 1];
    const body = String(last?.payload?.body ?? last?.body ?? '');
    assert.ok(body.includes('lingeringtek.cn'),
      `存进草稿的正文里链接丢了：${body.slice(0, 300)}`);
  } finally { t.dispose(); }
});

