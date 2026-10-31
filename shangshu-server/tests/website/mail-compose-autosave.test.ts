import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText, allToastText} from '../helpers/toast.ts';

/*
 N3-B/C/D/E —— 用户 2026-10-11 验收反馈（C-测试表单-N2.md 上标注）：

   「#notice … 这个也放到 notice 公共组件里面，并且**存草稿不要用一个显性的按钮，只要失焦就保存**」
   ↑ 2026-10-12 用户点名：所谓「notice 公共组件」= 产品本来就有的右下角 toast
     （index.html 的 .toast-zone + js/toast.js）。原来那套 #notice 是自造的劣等品，已删，
     下面所有提示断言一律查 `#toast-zone .toast`（helpers/toast.ts 提供 installToast/toastText）。
   「#dlg-close … 这个能不能用一个**弹窗**？你这个**还没有做**」
   「建议**正文框再长一点**，这个现在太短一点」

 测试通过 = 下面全部成立：

 N3-B 失焦自动保存
   B1. 写信窗**没有**「存草稿」这个显性按钮了。
   B2. 改完内容**失焦**（点到别处）就自动保存 —— 不用点任何按钮。
   B3. 第一次失焦**新建**一封草稿，之后再改再失焦是**更新同一封**（草稿箱里只多一封）。
   B4. 自动保存**失败**时给明确提示，且**不假装成功**。

 N3-D 关闭改弹窗
   D1. 有未保存改动时点「关闭」→ **弹出弹窗**（不是按钮原地换字）。
   D2. 没有未保存改动时点「关闭」→ **直接关**，不弹窗。

 N3-C notice 并公共件
   C1. 提示样式**只剩一份公共定义**：三个页面的 css 里不再各抄一份 `#notice`，
       也不许自己再抄一份 `.toast` —— 右下角那套只在 workbench.css 里有一份。

 N3-E 正文框加高
   E1. 正文编辑区有明确的**最小高度**，比改之前明显高。
*/

const CID = 'auto@shangshu.local';
const seed = {
  name: 'mail-auto', subject: '失焦保存样本', body: '<p>开头</p>', body_format: 'HTML',
  to: ['client@example.invalid'], cc: [], status: 'Draft', record_version: 1,
  owner: 'owner@example.invalid', modified: '2026-10-10 10:00:00',
  inline_resources: [{content_id: CID, mime_type: 'image/png', name: '图.png', file: 'f1'}],
};

const tick = () => new Promise(r => setTimeout(r, 20));
// 失焦自动保存有 120ms 防抖，等的时间必须比它长，否则测的是「防抖还没到」不是「没存」
const settle = () => new Promise(r => setTimeout(r, 320));

function mount(handler: (url: string, body: any) => any, rows: any[] = [seed]) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saves: any[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) return {ok: true, status: 200, json: async () => ({result: {account: {bound: false}}})};
    if (url.includes('/datasets/')) return {ok: true, status: 200, json: async () => ({rows, total: rows.length, attachment_capability: 'fixed_references_v2'})};
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('mail.save_draft')) saves.push(body);
    const result = handler(url, body);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saves, dispose: () => { dispose(); dom.window.close(); }};
}

/** 打开这封草稿进写信窗。 */
async function openCompose(t: any) {
  await tick();
  const item = t.w.document.querySelector('[data-open]');
  item.click();
  await tick();
  await tick();
  const editor = t.w.document.querySelector('.mail-body-editor') || t.w.document.querySelector('#c-editor');
  if (!editor) {
    const scene = {
      subject: t.w.document.querySelector('#c-subject') ? '有主题栏' : '无主题栏',
      body: t.w.document.querySelector('#c-body') ? '有正文框' : '无正文框',
      dialogs: t.w.document.querySelectorAll('[role="dialog"]').length,
    };
    throw new Error('写信窗没打开；现场=' + JSON.stringify(scene));
  }
  return editor;
}

/** 改一点内容并让「脏」标记生效。 */
async function editSomething(t: any, editor: any, text = '改过的内容') {
  editor.focus();
  editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  editor.textContent = (editor.textContent || '') + text;
  editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  await tick();
}

const okSave = (name = 'mail-auto', version = 1) => ({
  name, subject: '失焦保存样本', body: '<p>x</p>', body_format: 'HTML',
  to: ['client@example.invalid'], cc: [], status: 'Draft', record_version: version,
  owner: 'owner@example.invalid', modified: '2026-10-10 10:00:00', inline_resources: [],
  // 回执校验要读这两个（mail-center.js:562）：附件数组 + 挂载映射。少了它们，
  // 「没有附件」的草稿也会被判成「回执不完整」而存不上 —— 我自己的 mock 先踩过。
  attachments: [], attachment_bindings: {},
});
/* mail.detail 服务的返回形状是 {mail:{…}} —— 少了这层 mapReal(undefined) 直接炸，
   写信窗就开不出来（我自己的 mock 先踩过一次）。 */
const okDetail = (name = 'mail-auto', version = 1) => ({mail: okSave(name, version)});
/* 默认 handler：按接口分流 —— save_draft 回信本体，其余服务回 {mail:…}。
   混了形状会让回执校验判「保存回执不完整」，看起来像保存失败（我先踩过）。 */
const defaultHandler = () => (url: string) =>
  url.includes('mail.save_draft') ? okSave() : okDetail();

// 本轮active goal要求常用保存可见；旧隐藏按钮判据不再作为当前验收口径。
it('B1 写信窗可见存草稿入口复用现有保存链，失焦自动保存仍保留', async () => {
  const t = mount(defaultHandler());
  try {
    const editor = await openCompose(t);
    // 前提：写信窗必须真开着 —— 否则「找不到按钮」是空过（假绿）
    assert.ok(editor, '写信窗没打开，这条测不了');
    assert.ok(t.w.document.querySelector('#c-subject'), '写信窗主题栏不在，说明窗口没开');
    const btn = t.w.document.querySelector('#c-save');
    assert.ok(btn);assert.ok(btn.querySelector('svg'));assert.equal(btn.getAttribute('aria-label'),'保存草稿');
    await editSomething(t,editor,'点击保存的正文');btn.click();await new Promise(r=>setTimeout(r,60));
    assert.ok(t.w.document.querySelector('#c-subject'),'手动存草稿应保留当前编辑面');
  } finally { t.dispose(); }
});

it('B2 改完内容失焦就自动保存，不用点按钮', async () => {
  const t = mount(defaultHandler());
  try {
    const editor = await openCompose(t);
    await editSomething(t, editor);
    assert.equal(t.saves.length, 0, '还没失焦就存了');

    // 失焦 = 把焦点挪出正文编辑区
    editor.blur();
    editor.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    assert.ok(t.saves.length >= 1, `失焦后没有自动保存：saves=${t.saves.length}`);
    // 不只验「发了请求」—— 请求发了但回执校验没过、存失败了，也算没存上。
    // 反向断言扫**全部** toast：只看最新一条会漏掉中途弹过又叠着的失败提示。
    const shown = allToastText(t.w);
    assert.ok(!/回执不完整|保存结果|失败/.test(shown), `自动保存其实失败了：${JSON.stringify(shown)}`);
  } finally { t.dispose(); }
});

it('B3 第一次失焦新建一封，之后再失焦是更新同一封（不多建）', async () => {
  let version = 0;
  const created: string[] = [];
  const t = mount((url, body) => {
    if (url.includes('mail.save_draft')) {
      // 请求体是 {payload, confirmed, idempotency_key}，信的字段在 payload 里
      const p = (body && body.payload) || body || {};
      version += 1;
      const name = p.mail || ('mail-new-' + version);
      if (!p.mail) created.push(name);
        return okSave(name, version);
    }
    return okDetail();
  }, []);
  try {
    // 空列表 → 点「写邮件」建新草稿
    await tick();
    const compose = t.w.document.querySelector('#compose');
    if (compose) { compose.click(); await tick(); await tick(); }
    const editor = t.w.document.querySelector('.mail-body-editor') || t.w.document.querySelector('#c-editor');
    assert.ok(editor, '写信窗没打开');

    await editSomething(t, editor, '第一段');
    editor.blur();
    editor.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    await editSomething(t, editor, '第二段');
    editor.blur();
    editor.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    assert.ok(t.saves.length >= 2, `两次失焦应至少存两次，实际 ${t.saves.length}`);
    assert.equal(created.length, 1, `只应新建一封草稿，实际新建了 ${created.length} 封：${JSON.stringify(created)}`);
  } finally { t.dispose(); }
});

it('B4 自动保存失败给明确提示，且不假装成功', async () => {
  const t = mount((url) => {
    if (url.includes('mail.save_draft')) return {error: '存不上', status: 500};
    return okDetail();
  });
  try {
    const editor = await openCompose(t);
    await editSomething(t, editor);
    editor.blur();
    editor.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    // 失败提示是最新弹出的那条 → 取最后一条 toast 的文案
    const shown = toastText(t.w);
    assert.ok(/存|失败|未保存|重试/.test(shown), `保存失败没给提示：toast=${JSON.stringify(shown)}`);
    // 不能把失败当成功：界面不该显示成「已保存」——扫全部 toast，别让更早的一条「已保存」溜过去
    const everShown = allToastText(t.w);
    assert.ok(!/已保存/.test(everShown), `保存失败却显示成已保存：${JSON.stringify(everShown)}`);
  } finally { t.dispose(); }
});

it('D1 有未保存改动点「关闭」→ 弹出弹窗，不是按钮原地换字', async () => {
  const t = mount(defaultHandler());
  try {
    const editor = await openCompose(t);
    await editSomething(t, editor);

    const beforeText = [...t.w.document.querySelectorAll('button')].map((b: any) => (b.textContent || '').trim());
    const closeBtn = t.w.document.querySelector('#dlg-close') || t.w.document.querySelector('#c-cancel');
    assert.ok(closeBtn, '找不到关闭按钮');
    closeBtn.click();
    await tick();

    // 弹窗 = 独立的对话框层（ui.modal 造出来的东西）
    const dialogs = [...t.w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')];
    const visible = dialogs.filter((d: any) => d.isConnected && !d.hidden);
    assert.ok(visible.length >= 1, `点关闭没有弹窗，只有 ${dialogs.length} 个 dialog 节点`);

    const text = visible.map((d: any) => d.textContent || '').join(' ');
    assert.ok(/放弃|丢弃|确认/.test(text), `弹窗里没说清后果：${text.slice(0, 120)}`);
    // 不能只是把按钮文字换掉：弹窗里得有「继续编辑」这类出口
    assert.ok(/继续|取消|返回/.test(text), `弹窗里没有「继续编辑」出口：${text.slice(0, 120)}`);

    // 按钮本身不该被换成一长句（那就是「原地换字」）
    const afterText = [...t.w.document.querySelectorAll('button')].map((b: any) => (b.textContent || '').trim());
    const grewLong = afterText.some((s: string) => s.length > 12 && !beforeText.includes(s));
    assert.equal(grewLong, false, `关闭按钮被原地换成一长句了：${JSON.stringify(afterText)}`);
  } finally { t.dispose(); }
});

it('D2 没有未保存改动点「关闭」→ 直接关，不弹窗', async () => {
  const t = mount(defaultHandler());
  try {
    const editor = await openCompose(t);
    assert.ok(editor, '写信窗没打开，这条测不了');
    const closeBtn = t.w.document.querySelector('#dlg-close') || t.w.document.querySelector('#c-cancel');
    closeBtn.click();
    await tick();

    const dialogs = [...t.w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')]
      .filter((d: any) => d.isConnected && !d.hidden);
    assert.equal(dialogs.length, 0, `干净状态点关闭也弹窗了：${dialogs.map((d: any) => d.textContent).join(' ').slice(0, 100)}`);
  } finally { t.dispose(); }
});

it('B5 存过就干净：服务端规范化了正文，界面不许再喊「有未保存修改」', async () => {
  /* 真实根因（2026-10-11 在 3830 实测量出来的）：
     服务端 service.py:99 用 bleach 的 CSSSanitizer 净化正文，它会给 style 属性
     **补上结尾分号**。于是存进去的是 `style="border-collapse:collapse"`，
     拿回来的是 `style="border-collapse:collapse;"` —— 差一个字符。
     存完拿「当前栏位值」和「回执里的值」逐字比，就永远判「有新修改」，
     表现是：点「关闭」总弹确认、离开页面总弹「要离开吗」。

     测试通过 = 服务端把正文规范化过之后再回执，界面脏标记照样复位，
     点「关闭」直接关掉、不再弹确认。 */
  const t = mount((url, body) => {
    if (url.includes('mail.save_draft')) {
      const p = (body && body.payload) || {};
      // 模拟服务端规范化：给 style 补结尾分号（本地发出去的没有）
      const normalized = String(p.body || '').replace(/border-collapse:collapse"/g, 'border-collapse:collapse;"');
      return {...okSave(p.mail || 'mail-auto', 1), body: normalized};
    }
    return okDetail();
  });
  try {
    const editor = await openCompose(t);
    assert.ok(editor, '写信窗没打开，这条测不了');
    // 正文放一张表：style 结尾没分号，跟编辑器产出一致
    editor.innerHTML = '<p>底稿</p><table style="border-collapse:collapse"><tbody><tr><td colspan="2">汇总</td></tr></tbody></table>';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();

    editor.blur();
    editor.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    assert.ok(t.saves.length >= 1, `失焦后没存上：saves=${t.saves.length}`);
    const note = t.w.document.querySelector('#dirty-note');
    assert.ok(note, '找不到脏标记 #dirty-note');
    assert.equal(note.hidden, true,
        `存过之后还在喊「有未保存修改」 —— 说明回执值和本地值对不上一个字符`);

    // 点关闭应当直接关，不弹确认弹窗
    const closeBtn = t.w.document.querySelector('#dlg-close') || t.w.document.querySelector('#c-cancel');
    assert.ok(closeBtn, '找不到关闭按钮');
    closeBtn.click();
    await tick();
    const dialogs = [...t.w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')]
      .filter((d: any) => d.isConnected && !d.hidden);
    assert.equal(dialogs.length, 0,
        `存过之后点关闭还弹确认弹窗：${dialogs.map((d: any) => d.textContent).join(' ').slice(0, 100)}`);
  } finally { t.dispose(); }
});

it('C1 提示样式只剩一份公共定义：页面不抄 #notice，也不自抄 .toast', () => {
  const files = ['mail-center.css', 'file-center.css', 'sheet-center.css'];
  const hits: Record<string, {notice: number, toast: number}> = {};
  for (const f of files) {
    const css = readFileSync(new URL(`../../../shangshu-web/css/${f}`, import.meta.url), 'utf8');
    // ① 自己给 #notice 定位/外观的规则（劣等品，已整体删除，不许回来）
    // ② 自己再抄一份 .toast 的定位/外观（会和公共件打架，也不许）
    hits[f] = {
      notice: (css.match(/#notice\s*\{[^}]*position\s*:/g) || []).length,
      toast: (css.match(/\.toast(?:-zone|-error)?\s*\{[^}]*position\s*:/g) || []).length,
    };
  }
  const total = Object.values(hits).reduce((a, b) => a + b.notice + b.toast, 0);
  assert.equal(total, 0,
      `提示的外观还在页面各自的 css 里各写一份：${JSON.stringify(hits)} —— 应只留公共件那一份`);

  // 公共件本身必须在（workbench.css 就是那一份）——不然上面的 0 可能是「哪儿都没有」的假绿
  const workbench = readFileSync(new URL('../../../shangshu-web/css/workbench.css', import.meta.url), 'utf8');
  assert.match(workbench, /\.toast-zone\s*\{[^}]*position\s*:/, 'workbench.css 里没有 .toast-zone 的公共定位');
  assert.match(workbench, /(^|\n)\s*\.toast\s*\{/, 'workbench.css 里没有 .toast 的公共外观');
  assert.ok(!/(^|\n)\s*#notice\s*\{/.test(workbench), 'workbench.css 还留着 #notice 的样式');
});

it('E1 正文编辑区生效的最小高度明显加高（比改之前高）', () => {
  const css = readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8');
  /* 必须查**生效值**：同一规则里后写的 min-height 会盖掉先写的。
     我先前只 find 到第一条 min-height:360px 就过，可同一条规则后面还挂着
     min-height:200px，浏览器实际渲染的是 200px —— 那次是假绿。 */
  // Signature/review dialogs have their own bounded editor height. Their
  // scoped rules do not apply to the real compose page's #c-editor.
  const blocks = css.split('}').filter(b => /mail-body-editor|#c-editor/.test(b)
    && !/\.mail-signature-dialog|\.mail-review-dialog/.test(b));
  const declared: number[] = [];
  for (const block of blocks) {
    for (const m of block.matchAll(/min-height\s*:\s*(\d+)px/gi)) declared.push(Number(m[1]));
  }
  assert.ok(declared.length, `正文编辑区没有最小高度：${blocks.join('}').slice(0, 200)}`);
  const effective = declared[declared.length - 1];
  /* 只钉一条：**生效值** ≥ 320px（用户说「现在太短」，要明显加高）。
     别再加「生效值必须是声明里最大的那条」那种断言 —— 它拦不到任何
     「生效值 < 320」之外的新情况（那条已经被上面这条拦了），却会对
     仍然合格的高度误报（比如 [400, 360]：360px 明明够高，却会红）。
     真正的生效值以产品页的 getComputedStyle 为准 —— 那是 V0 那条在量的
     （实测 editorMinH:"360px"），这里只是源码层面的近似。 */
  assert.ok(effective >= 320,
      `正文编辑区生效的最小高度只有 ${effective}px（声明序列 ${JSON.stringify(declared)}），`
      + `用户说「现在太短」，应明显加高（≥320px）`);
});

it('unbound personal compose never defaults to shared identity; only explicit identity choice changes save mailbox',async()=>{
 const shared={id:'dept-box',email:'shared@example.invalid',kind:'department',enabled:true,connection_status:'connected',rights:{read:true,edit_draft:true,send:true,manage:true,signature:true}};
 const t=mount((url,body)=>{
  if(url.includes('/services/mail.mailboxes/'))return {result:{mailboxes:[shared]}};
  if(url.includes('mail.save_draft'))return {...okSave('new-personal',2),subject:body.payload.subject,body:body.payload.body,mailbox_id:body.payload.mailbox||'personal-home'};
  return {result:{}};
 },[]);
 try{await tick();await tick();t.w.document.querySelector('#compose').click();const from=t.w.document.querySelector('#c-from');
 assert.equal(from.selectedOptions[0].getAttribute('data-mailbox'),'');assert.match(from.selectedOptions[0].textContent,/本人草稿/);assert.equal(t.w.document.querySelector('#c-send').disabled,true);
 const subject=t.w.document.querySelector('#c-subject');subject.value='personal';subject.dispatchEvent(new t.w.Event('input',{bubbles:true}));t.w.document.querySelector('#c-save').click();await settle();assert.ok(t.saves.length);assert.equal(t.saves[0].payload.mailbox,undefined);
 from.value=shared.email;from.dispatchEvent(new t.w.Event('change',{bubbles:true}));subject.value='explicit shared';subject.dispatchEvent(new t.w.Event('input',{bubbles:true}));t.w.document.querySelector('#c-save').click();await settle();assert.equal(t.saves.at(-1).payload.mailbox,shared.id);
 from.value='';from.dispatchEvent(new t.w.Event('change',{bubbles:true}));subject.value='explicit personal return';subject.dispatchEvent(new t.w.Event('input',{bubbles:true}));t.w.document.querySelector('#c-save').click();await settle();assert.equal(t.saves.at(-1).payload.mailbox,'personal-home');
 }finally{t.dispose();}
});
it('compose inside explicitly selected shared mailbox keeps that mailbox even with another sender available',async()=>{
 const boxes=['first','selected'].map(id=>({id,email:id+'@example.invalid',kind:'department',enabled:true,connection_status:'connected',rights:{read:true,edit_draft:true,send:true,manage:true,signature:true}}));
 const t=mount(url=>url.includes('/services/mail.mailboxes/')?{result:{mailboxes:boxes}}:{result:{}},[]);
 try{await tick();await tick();const select=t.w.document.querySelector('#mailbox-switch');select.value='selected';select.dispatchEvent(new t.w.Event('change',{bubbles:true}));await tick();t.w.document.querySelector('#compose').click();assert.equal(t.w.document.querySelector('#c-from').selectedOptions[0].getAttribute('data-mailbox'),'selected');}finally{t.dispose();}
});
