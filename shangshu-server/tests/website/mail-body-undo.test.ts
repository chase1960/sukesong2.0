import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 计划 §6 的 C3 —— 正文三步撤回接自动保存。

 用户 2026-10-12 亲自拍板（不再问）：
   「当前草稿正文最近三步，仅本次打开期间；自动保存不清栈，刷新/关闭清空；
     Assistant 操作不占本人步数；包含正文表格及内联图片引用，
     不影响主题、收抄件人和普通附件栏。」

 计划 §6 C3 判据原文：
   「在本次打开的草稿内撤最近三步正文编辑；粘表/插图/合并拆分分别整步恢复，
     主题/地址/普通附件栏不动；自动保存不清栈，刷新/关闭清栈，Assistant 不计。
     图引用与正文同次保存，不删共享原件」

 现状（查实）：mail-editor.js 已有 N2-C6 自建撤销栈，但对不上 C3：
   ① 栈深 **100**，不是「最近三步」
   ② 没有「谁做的」这回事 —— Assistant 改正文会占掉本人的一步
   ③ `sync()` 直接清栈（当作重载）—— 与「自动保存不清栈」不冲突
     （自动保存不走 sync），但「Assistant 改正文」需要一个**不清栈又不占步数**的入口

 测试通过 = 下面全部成立：

   A. 连续四次成功的正文修改，只能撤回**最近三次**；第四次撤不动
   B. 一次**区域粘贴**算一步；**插一张图**算一步；**合并单元格/拆分单元格**各算一步
      （不是逐格、不是逐字符）
   C. 撤回**只动正文**：主题、收件人、抄送、普通附件栏一律不动
   D. **自动保存不清栈**：失焦自动保存之后，撤回仍然能撤
   E. **本次打开期间**保留；**关闭重开**清栈，但已保存的正文照旧读得到
   F. **Assistant 操作不占本人步数**：Assistant 插进内容后，本人仍然能撤满三步
   G. **撤回自身不占本人步数**：撤回一步之后，还能再撤的步数不受影响
   H. 图引用与正文**同次保存**；撤回插图后正文和资源列表一起退，**不删共享原件**
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mount(initialBody = '<p>开头</p>') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  const uploads: any[] = [];
  const changes: string[] = [];
  /* 双轨撤回（B 35）：撤回回执与提示都在这里落账，判据直接读，不靠页面文案 */
  const receipts: any[] = [];
  const notices: string[] = [];
  const mounted = w.mailEditor.mountEditor(host, {
    value: initialBody,
    resources: [],
    onChange: (html: string) => { changes.push(html); },
    onNotice: (text: string) => { notices.push(text); },
    onUndoResult: (receipt: any) => { receipts.push(receipt); },
    uploadImage: async (file: any) => {
      uploads.push({name: file.name, size: file.size});
      return {content_id: 'cid-' + uploads.length + '@shangshu.local', mime_type: 'image/png', file: 'f' + uploads.length};
    },
  });
  return {
    w, editor: mounted.editor, api: mounted, uploads, changes, receipts, notices,
    dispose: () => dom.window.close(),
  };
}

/** 打一段字 = 走 input（真键盘同一条路）。**连续打字会合并成一步**（N2-C6 既定：
    打字不该逐键成步）。所以测「几步」时用 paste 做离散修改，不拿连续打字当步子。 */
function type(t: any, text: string) {
  t.editor.focus();
  t.editor.innerHTML = t.editor.innerHTML + `<p>${text}</p>`;
  t.editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
}

/** 一次粘贴一段文字 = **一步**（离散、无歧义，用来数步子）。 */
function pasteText(t: any, text: string) {
  const ev = new t.w.Event('paste', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'clipboardData', {
    value: {getData: (k: string) => (k === 'text/plain' ? text : ''), types: ['text/plain'], files: [], items: []},
  });
  t.editor.dispatchEvent(ev);
  return ev;
}

/** 一次粘贴一张表 = 一步。走真实 paste 事件（与 N2-C3 同一条路）。 */
function pasteTable(t: any) {
  const html = '<table><tbody><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></tbody></table>';
  const ev = new t.w.Event('paste', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'clipboardData', {
    value: {getData: (k: string) => (k === 'text/html' ? html : ''), types: ['text/html'], files: [], items: []},
  });
  t.editor.dispatchEvent(ev);
  return ev;
}

function pngFile(t: any, name = '签章.png') {
  const bin = t.w.atob(PNG_B64);
  const bytes = Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
  return new t.w.File([bytes], name, {type: 'image/png'});
}

function dropImage(t: any, file: any) {
  const dt = {types: ['Files'], files: [file], items: [{kind: 'file'}], getData: () => ''};
  const over = new t.w.Event('dragover', {bubbles: true, cancelable: true});
  Object.defineProperty(over, 'dataTransfer', {value: dt});
  t.editor.dispatchEvent(over);
  const ev = new t.w.Event('drop', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'dataTransfer', {value: dt});
  t.editor.dispatchEvent(ev);
  return ev;
}

it('A 连续四次成功的正文修改，只能撤回最近三次', async () => {
  const t = mount('<p>开头</p>');
  try {
    for (const s of ['一', '二', '三', '四']) { pasteText(t, s); await tick(); }
    assert.ok(t.editor.innerHTML.includes('四'), `四次粘贴没进正文：${t.editor.innerHTML.slice(0, 160)}`);

    // 三步能撤
    assert.ok(t.api.undo(), '第 1 次撤回失败（该能撤「四」）');
    assert.ok(!t.editor.innerHTML.includes('四'), `第 1 次撤回没撤掉「四」：${t.editor.innerHTML.slice(0, 120)}`);
    assert.ok(t.api.undo(), '第 2 次撤回失败（该能撤「三」）');
    assert.ok(t.api.undo(), '第 3 次撤回失败（该能撤「二」）');
    assert.ok(t.editor.innerHTML.includes('一'), `撤满三步后「一」该还在：${t.editor.innerHTML.slice(0, 120)}`);
    assert.ok(!t.editor.innerHTML.includes('二'), `撤满三步后「二」不该在：${t.editor.innerHTML.slice(0, 120)}`);

    // 第四步超出「最近三步」窗口，撤不动 —— 「一」是第四次修改**之前**的状态，不该被退回
    assert.equal(t.api.undo(), false, '第四次撤回不该成功（只保留最近三步）');
    assert.ok(t.editor.innerHTML.includes('一'), `超窗撤回把「一」也撤没了：${t.editor.innerHTML.slice(0, 120)}`);
  } finally { t.dispose(); }
});

it('B 一次区域粘贴算一步；插一张图算一步', async () => {
  const t = mount('<p>开头</p>');
  try {
    pasteTable(t);
    await tick();
    assert.ok(t.editor.querySelector('table'), '粘贴的表没进正文');
    const afterPaste = t.editor.innerHTML;

    dropImage(t, pngFile(t));
    await tick();
    await t.api.imagesReady();
    assert.ok(t.editor.querySelector('img'), '插的图没进正文');

    // 插图是第 2 步：撤一次回到「粘表之后」，表还在、图没了
    assert.ok(t.api.undo(), '插图应该是一步可撤的');
    assert.ok(t.editor.querySelector('table'), `撤插图不该把表也撤没了：${t.editor.innerHTML.slice(0, 120)}`);
    assert.equal(t.editor.querySelector('img'), null, '撤插图后图还在');

    // 粘表是第 1 步：再撤一次回到「粘表之前」
    assert.ok(t.api.undo(), '粘表应该是一步可撤的');
    assert.equal(t.editor.querySelector('table'), null, '撤粘表后表还在（一次粘贴该整步恢复）');
  } finally { t.dispose(); }
});

it('C 撤回只动正文：主题/收件人/抄送/普通附件栏一律不动', async () => {
  /* 正文撤回的**作用域**是编辑器内部。宿主的其他栏位压根不在这条链上 ——
     这条是把「不外溢」钉死：撤回之后那些栏位的值与撤回前一字不差。 */
  const dom = new JSDOM(
    '<div id="host"></div><input id="c-subject"><input id="c-to"><input id="c-cc"><div id="c-attachments"></div>',
    {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const subject = w.document.querySelector('#c-subject');
  const to = w.document.querySelector('#c-to');
  const cc = w.document.querySelector('#c-cc');
  const att = w.document.querySelector('#c-attachments');
  subject.value = '主题不动'; to.value = 'a@example.com'; cc.value = 'b@example.com';
  att.innerHTML = '<div class="att-row">附件不动</div>';
  const before = {
    subject: subject.value, to: to.value, cc: cc.value, att: att.innerHTML,
  };
  try {
    const api = w.mailEditor.mountEditor(w.document.querySelector('#host'), {
      value: '<p>开头</p>', resources: [], onChange: () => {},
    });
    type({editor: api.editor, w}, '要撤的');
    await tick();
    assert.ok(api.undo(), '撤回失败');
    assert.equal(subject.value, before.subject, '撤回动了主题');
    assert.equal(to.value, before.to, '撤回动了收件人');
    assert.equal(cc.value, before.cc, '撤回动了抄送');
    assert.equal(att.innerHTML, before.att, '撤回动了普通附件栏');
  } finally { dom.window.close(); }
});

it('D 自动保存不清栈：失焦自动保存之后，撤回仍然能撤', async () => {
  /* 自动保存会把正文送出去（onChange），但**不许**因此清空撤回序列。
     用户 2026-10-12：「自动保存不清栈」。 */
  const t = mount('<p>开头</p>');
  try {
    pasteText(t, '一'); await tick();
    pasteText(t, '二'); await tick();

    // 模拟自动保存：onChange 已经被调过多次（每次提交都会 commit）
    assert.ok(t.changes.length >= 2, `自动保存没发生，changes=${t.changes.length}`);

    assert.ok(t.api.undo(), '自动保存之后第 1 次撤回失败（自动保存清栈了？）');
    assert.ok(t.api.undo(), '自动保存之后第 2 次撤回失败（自动保存清栈了？）');
    assert.ok(t.editor.innerHTML.includes('开头'), `撤回后该回到开头：${t.editor.innerHTML.slice(0, 120)}`);
  } finally { t.dispose(); }
});

it('E 本次打开期间保留；关闭重开清栈，但已保存的正文照旧读得到', async () => {
  const t = mount('<p>开头</p>');
  try {
    type(t, '一');
    await tick();
    type(t, '二');
    await tick();
    const saved = t.api.getHtml();
    assert.ok(t.api.undo(), '本次打开期间该能撤');

    // 关闭编辑器（宿主销毁）→ 重开：撤回序列清空，但内容照旧
    t.api.destroy();
    const host2 = t.w.document.createElement('div');
    t.w.document.body.appendChild(host2);
    const reopened = t.w.mailEditor.mountEditor(host2, {value: saved, resources: [], onChange: () => {}});
    assert.ok(reopened.getHtml().includes('一'), `重开后已保存内容该读得到：${reopened.getHtml().slice(0, 120)}`);
    assert.equal(reopened.undo(), false, '重开后不该还留着上次的撤回序列');
  } finally { t.dispose(); }
});

it('F Assistant 操作不占本人步数：Assistant 插内容后，本人仍能撤满三步', async () => {
  /* 用户 2026-10-12：「Assistant 操作不占本人步数」。
     这里钉的是**预算**：Assistant 改了正文，本人的三步一步都不能少。 */
  const t = mount('<p>开头</p>');
  try {
    pasteText(t, '一'); await tick();
    // Assistant 写了一段（走非本人入口）
    t.api.applyEdit('<p>开头</p><p>一</p><p>助手代写</p>', {actor: 'assistant'});
    pasteText(t, '二'); await tick();
    pasteText(t, '三'); await tick();
    pasteText(t, '四'); await tick();

    // 本人的三步：四、三、二 —— 一步都不能被 Assistant 吃掉
    assert.ok(t.api.undo(), '第 1 步该能撤');
    assert.ok(!t.editor.innerHTML.includes('四'), '第 1 步该撤掉「四」');
    assert.ok(t.api.undo(), '第 2 步该能撤（Assistant 不该吃掉这一步）');
    assert.ok(t.api.undo(), '第 3 步该能撤（Assistant 不该吃掉这一步）');
    assert.ok(t.editor.innerHTML.includes('一'), `撤满三步后「一」该在：${t.editor.innerHTML.slice(0, 120)}`);
    assert.equal(t.api.undo(), false, '只有三步，第四次该撤不动');
  } finally { t.dispose(); }
});

it('G 撤回自身不占本人步数', async () => {
  /* 撤回不是一次「修改」，不该消耗预算。 */
  const t = mount('<p>开头</p>');
  try {
    pasteText(t, '一'); await tick();
    pasteText(t, '二'); await tick();
    pasteText(t, '三'); await tick();

    assert.ok(t.api.undo(), '第 1 次撤回失败');
    assert.ok(t.api.undo(), '第 2 次撤回失败');
    // 撤回了两步之后，重新改一次
    pasteText(t, '新'); await tick();
    assert.ok(t.api.undo(), '撤回之后新改的一步该能撤');
    assert.ok(t.api.undo(), '再撤一步（撤回本身不占步数）');
  } finally { t.dispose(); }
});

it('H 图引用与正文同次保存；撤回插图后正文和资源一起退，不删共享原件', async () => {
  const t = mount('<p>开头</p>');
  try {
    dropImage(t, pngFile(t));
    await tick();
    await t.api.imagesReady();
    assert.equal((t.api.getInlineResources() || []).length, 1, '插的图没进资源列表');

    assert.ok(t.api.undo(), '插图该可撤');
    assert.equal(t.editor.querySelector('img'), null, '撤回后正文里图还在');
    assert.equal((t.api.getInlineResources() || []).length, 0,
        '撤回后资源列表里图还在（引用没跟正文同次退）');

    // 「不删共享原件」：撤回只是不再引用，不许下删除文件的请求。
    // 宿主的 uploadImage 只在插入时调过 1 次 —— 撤回不该再调它，也不该调删除接口。
    assert.equal(t.uploads.length, 1, `撤回不该再动上传通道：${t.uploads.length}`);
  } finally { t.dispose(); }
});

it('I Assistant 代写的正文能被保存链读到（onChange 必须发）', async () => {
  /* **回归锁**（不是凑绿）：代码审出的缺口 —— applyEdit 只改 DOM 不发 onChange，
     而宿主保存链读的是隐藏 textarea `#c-body`，它只由 onChange 更新。
     结果：代写看着进正文了，点保存送出去的还是旧正文（静默丢字）。

     改之前：applyEdit 之后 changes 里没有这次代写，保存出去是旧正文
     改之后：applyEdit 之后 changes 收到这次代写，保存出去就是代写的正文
     怎么看：Assistant 代写一段 → 点保存 → 打开草稿看到的是代写的那段 */
  const t = mount('<p>开头</p>');
  try {
    const before = t.changes.length;
    t.api.applyEdit('<p>助手代写的正文</p>', {actor: 'assistant'});
    await tick();
    assert.ok(t.changes.length > before,
        `applyEdit 没发 onChange，代写的正文存不出去（changes=${before}→${t.changes.length}）`);
    assert.match(t.changes[t.changes.length - 1], /助手代写的正文/,
        `onChange 送出去的不是代写内容：${t.changes[t.changes.length - 1]}`);
    assert.match(t.api.getHtml(), /助手代写的正文/, 'getHtml 也没拿到代写内容');
  } finally { t.dispose(); }
});

it('J kept ＝ 合并后**归属为助手的段数**（从没动过的老内容不算「助手改动」）', async () => {
  /* 口径（C 2026-10-19 收紧，用户 2026-10-22 20:55 复核确认）：
     `undone` ＝ 本次撤掉的用户段数；
     `kept` ＝ **合并后归属为助手的段数** —— 不是「所有没被撤的段数」
     （那会把**根本没动过**的段落也报成「助手改动」）。

     用户给的例子：正文 3 段，其中 2 段是用户刚改的（能撤），第 3 段是老内容（从没动过）——
       编辑器原来算的：kept ＝ 3 − 2 − 0 ＝ 1 ⇒ 回执「部分撤回，撤 2 留 1」；
       产品口径要的：kept ＝ 0（没有助手段）⇒ 回执「已撤回」。
     ⇒ 这不是措辞之争：同一个字段在两处算出两个数，
       一个会把「没动过的段落」说成「助手改动」，另一个会把本该「已撤回」说成「部分撤回」。 */
  const t = mount('<p>甲</p><p>乙</p><p>老</p>');
  try {
    /* 本人这一步改两段的**内容**（不是加段）—— 第三段一个字没动过。 */
    t.editor.focus();
    t.editor.innerHTML = '<p>甲改</p><p>乙改</p><p>老</p>';
    t.editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    assert.ok(t.api.undo(), '撤回失败');
    const receipt = t.receipts[t.receipts.length - 1];
    assert.ok(receipt, '撤回回执没落账（onUndoResult 没被叫到）');
    assert.equal(receipt.undone, 2, `撤掉的段数不对：${JSON.stringify(receipt)}`);
    assert.equal(receipt.kept, 0,
      `kept 应该是 0 —— 那第三段是老内容，从没被谁改过，不算「助手改动」：${JSON.stringify(receipt)}`);
    assert.equal(receipt.undo_state, 'withdrawn',
      `本该是「已撤回」（withdrawn），实际「${receipt.undo_state}」：${JSON.stringify(receipt)}`);
  } finally { t.dispose(); }
});

it('正文三步撤回有可见SVG入口，新建与表格动作复用同一历史且按钮状态准确',()=>{
 const t=mount();try{
  const button=t.w.document.querySelector('[data-editor-undo]');assert.ok(button,'缺少可见撤回按钮');assert.ok(button.querySelector('svg'));assert.equal(button.disabled,true);
  for(const text of ['一步','二步','三步','四步'])pasteText(t,text);
  assert.equal(t.w.document.querySelector('[data-editor-undo-count]').textContent,'3/3');assert.equal(button.disabled,false);
  button.click();button.click();button.click();assert.equal(button.disabled,true);assert.match(t.editor.textContent,/一步/);assert.doesNotMatch(t.editor.textContent,/二步|三步|四步/);
 }finally{t.dispose();}
});

/* ── 双轨撤回（BASE967-35 窄设计，2026-10-19）：段级归属 ──────────────────
   口径：撤回**本人**那一步，且**只撤本人动过的段**；助手在别的段的成果留着；
        本人动过的那段若被助手改过（同段冲突）→ **拒覆盖**并说清。
        回执是**非二值**的（给 D 认「只撤我这段、助手那段留着」）。

   测试通过 = 下面两条各自成立：
     · 无关内容：本人那步撤掉，助手写的段原样留着，回执报撤/留段数
     · 同段冲突：撤回不成功、正文一个字不动、回执是拒覆盖形状且提示说清是助手的改动 */
it('双轨撤回·无关内容：撤本人那一步，助手别的段的成果留着', async () => {
  const t = mount('<p>第一段</p>');
  try {
    await tick();
    type(t, '我的改动'); await tick();          // 本人一步（<p>我的改动</p>）
    t.api.applyEdit('<p>第一段</p><p>我的改动</p><p>助手写的段</p>', {actor: 'assistant'});
    await tick();
    assert.ok(t.editor.innerHTML.includes('助手写的段'), '前置：助手段该在');

    assert.ok(t.api.undo(), '该能撤本人那一步');
    assert.ok(!t.editor.innerHTML.includes('我的改动'),
      `本人那一步该撤掉，实际：${t.editor.innerHTML.slice(0, 160)}`);
    assert.ok(t.editor.innerHTML.includes('助手写的段'),
      `助手别的段的成果该留着（双轨口径），实际：${t.editor.innerHTML.slice(0, 160)}`);

    const receipt = t.receipts.at(-1);
    assert.equal(receipt.ok, true, `回执该是 ok（产品语义）：${JSON.stringify(receipt)}`);
    assert.equal(receipt.undo_state, 'partial', `回执该是部分撤回：${JSON.stringify(receipt)}`);
    assert.equal(receipt.undone, 1, `回执该报撤掉的本人段数：${JSON.stringify(receipt)}`);
    /* ⚠️ **口径统一**（用户 2026-10-22 20:55 拍板）：`kept` ＝ **合并后归属为助手的段数**，
       **不是「所有留住的段数」** —— 「第一段」是初始内容（'init'），从没被谁改过，
       报成「助手改动」是错的（产品口径见 `chat-tool-card.test.ts` 的字段口径注释）。
       这里从 2 改成 1：合并后归属为助手的只有「助手写的段」那 1 段。 */
    assert.equal(receipt.kept, 1, `回执该报归属为助手的段数（只有「助手写的段」）：${JSON.stringify(receipt)}`);
  } finally { t.dispose(); }
});

it('双轨撤回·同段冲突：本人动过的那段被助手改过，拒覆盖并说清', async () => {
  const t = mount('<p>第一段</p>');
  try {
    await tick();
    type(t, '我的改动'); await tick();
    t.api.applyEdit('<p>第一段</p><p>助手改写的段</p>', {actor: 'assistant'});   // 助手整段重写
    await tick();
    const before = t.editor.innerHTML;

    assert.equal(t.api.undo(), false, '同段冲突时正文一个字都没撤（布尔口 false）');
    assert.equal(t.editor.innerHTML, before,
      `拒覆盖时正文一个字都不许动，实际：${t.editor.innerHTML.slice(0, 160)}`);
    const receipt = t.receipts.at(-1);
    assert.equal(receipt.undo_state, 'rejected_conflict',
      `回执该是未撤回（同段冲突）：${JSON.stringify(receipt)}`);
    assert.equal(receipt.ok, true,
      `rejected_conflict 是产品语义不是出错，回执 ok 该为 true：${JSON.stringify(receipt)}`);
    assert.equal(receipt.undone, 0, `拒覆盖时撤掉 0 处：${JSON.stringify(receipt)}`);
    assert.match(receipt.reason || '', /助手/,
      `拒覆盖要说清是助手的改动：${receipt.reason}`);
    assert.ok(t.notices.some(n => /助手/.test(n)),
      `拒覆盖要吭声（提示位），实际提示：${JSON.stringify(t.notices)}`);
  } finally { t.dispose(); }
});

it('双轨撤回·清空也算本人一步，撤回能恢复原内容', async () => {
  /* 签名弹窗「清空」走 applyEdit('')：新状态一段都不剩，
     只记 touched 会漏掉「删掉的段」——撤回要说「没有可撤回的本人修改」。 */
  const t = mount('<p>张三</p>');
  try {
    await tick();
    t.api.applyEdit('', {actor: 'user'}); await tick();
    assert.equal(t.editor.innerHTML.trim(), '', '前置：清空后正文该是空');
    assert.ok(t.api.undo(), '清空该算本人一步、能撤回');
    assert.match(t.editor.textContent || '', /张三/,
      `撤回该把清掉的原内容放回来，实际：${(t.editor.innerHTML || '').slice(0, 120)}`);
  } finally { t.dispose(); }
});
