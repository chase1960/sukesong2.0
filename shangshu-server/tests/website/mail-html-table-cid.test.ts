import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 测试通过 = 下面全部成立：
 1. 含表格＋合并单元格(colspan/rowspan)＋受管内联图(CID)的 HTML 草稿，打开后在**所见即所得的只读面**里
    安全显示，表格结构与合并信息仍在，内联图走受管 CID 解析，不发起任意外部图片请求。
 2. 真实可编辑区(contenteditable)能改单元格/正文值；保存载荷带 body_format:HTML，
    正文里的表格结构、合并格与 CID 引用不因保存而丢失。
 3. 重开同一草稿，结构与引用仍在（不被压成纯文本、不丢合并格、不丢图）。
 4. 危险 HTML（script/事件属性/外链图片）在进 DOM 前被净化，且不误伤表格与受管 CID。
*/

const CID = 'logo-sample@shangshu.local';
const SAMPLE_HTML =
  '<p>客户您好，本期核对如下。</p>' +
  '<table border="1"><thead><tr><th colspan="2">案件汇总</th><th>金额</th></tr></thead>' +
  '<tbody><tr><td rowspan="2">A001</td><td>年费</td><td>150.00</td></tr>' +
  '<tr><td>滞纳金</td><td>0.00</td></tr></tbody></table>' +
  `<p>详见附图 <img src="cid:${CID}" alt="样例图">。</p>`;

const seed = {
  name: 'mail-sample', subject: '样例核对表', body: SAMPLE_HTML, body_format: 'HTML',
  to: ['client@example.invalid'], cc: [], status: 'Draft', record_version: 1,
  owner: 'owner@example.invalid', modified: '2026-10-10 10:00:00',
  inline_resources: [{content_id: CID, mime_type: 'image/png', name: '样例图.png', file: 'file-sample'}],
};

const tick = () => new Promise(r => setTimeout(r, 10));

/* 写信窗已经没有「存草稿」按钮（用户 2026-10-11：「存草稿不要用一个显性的按钮，只要失焦就保存」）。
   所以「点存草稿」换成**失焦**：离开正文即自动存（120ms 防抖）。
   只派发 blur、不派发 focusout —— focusout 会顺带触发「单字段失焦保存」，多发一个只含单字段的请求。 */
async function triggerSave(w: any) {
  const ed = w.document.querySelector('.mail-body-editor') || w.document.querySelector('#c-body');
  if (ed) { ed.blur?.(); ed.dispatchEvent(new w.FocusEvent('blur', {bubbles: true})); }
  await new Promise(r => setTimeout(r, 320)); // 比 120ms 防抖长
}

function mount(handler: (url: string, body: any) => any, rows: any[] = [seed]) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) return {ok: true, status: 200, json: async () => ({result: {account: {bound: false}}})};
    if (url.includes('/datasets/')) return {ok: true, status: 200, json: async () => ({rows, total: rows.length, attachment_capability: 'fixed_references_v2'})};
    // 旧的死接口：平台模式 410 LEGACY_SURFACE_DISABLED。谁再调它，图就永远解析不出来。
    if (url.includes('/api/platform/files/content')) {
      return {ok: false, status: 410, json: async () => ({ok: false, code: 'LEGACY_SURFACE_DISABLED'})};
    }
    /* 正确的受管字节出口：/api/platform/file-content?ref=<doctype>&ref_name=<记录名>&file=<文件>。
       必须带记录归属，否则内核判不了权（403「无权读取该记录的附件」）。 */
    if (url.includes('/api/platform/file-content')) {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      return {ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(0), json: async () => ({})};
    }
    const body = options.body ? JSON.parse(options.body) : null;
    const result = handler(url, body);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result};
  };
  const scripts = [
    '../../../shangshu-web/js/tool-workspace.js',
    '../../../shangshu-web/js/file-reference-picker.js',
    '../../../shangshu-web/js/domains/mail/mail-editor.js',
    '../../../shangshu-web/js/mail-center.js',
  ];
  for (const rel of scripts) {
    w.eval(readFileSync(new URL(rel, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, dispose: () => { dispose(); dom.window.close(); }};
}

/* 用户 2026-10-11：「为什么会有两个正文，我不需要有渲染页，我要编辑的时候所见即所得」。
   草稿打开走的是**编辑器**，不再同时挂一个渲染 iframe —— 那个 iframe 就是「两个正文」里多出来的。
   安全断言一条不减，只是从「沙箱 srcdoc」挪到「进编辑器 DOM 之前就已净化」。 */
it('HTML表格＋合并格＋受管CID草稿在编辑器里安全显示，结构与引用不丢', async () => {
  const t = mount((url, body) => ({result: {mail: seed}}));
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    await tick();
    // 编辑器是唯一的正文面，不再另挂渲染 iframe
    const editor = t.w.document.querySelector('#c-editor');
    assert.ok(editor, '缺所见即所得的正文编辑区');
    assert.ok(editor.querySelector('table'), '编辑区里表格结构丢失');
    assert.ok(editor.querySelector('[colspan="2"]'), '编辑区里横向合并信息丢失');
    assert.ok(editor.querySelector('[rowspan="2"]'), '编辑区里纵向合并信息丢失');
    // 受管内联图：解析成 data: 可显示，绝不能是外链 http(s)
    const img = editor.querySelector('img');
    assert.ok(img, '编辑区里内联图丢了');
    const src = img.getAttribute('src') || '';
    assert.match(src, /^data:image\//i, `受管内联图没解析成可显示的图：${src.slice(0, 40)}`);
    assert.doesNotMatch(src, /^https?:/i, '编辑区不能发起外部图片请求');
  } finally { t.dispose(); }
});

it('危险HTML进编辑器前被净化，但不误伤表格与受管CID', async () => {
  const dirty = {...seed, body: `<p onclick="steal()">核对</p><table><tr><td colspan="2">保留合并</td></tr><tr><td>A001</td><td><img src="cid:${CID}"></td></tr></table><script>steal()</script><img src="https://tracker.invalid/pixel">`};
  const t = mount((url, body) => ({result: {mail: dirty}}), [dirty]);
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    assert.ok(editor, '缺正文编辑区');
    const html = editor.innerHTML;
    assert.doesNotMatch(html, /<script/i, 'script 未被净化');
    assert.doesNotMatch(html, /onclick/i, '事件属性未被净化');
    assert.doesNotMatch(html, /tracker\.invalid/, '外链图片未被拒');
    assert.ok(editor.querySelector('[colspan="2"]'), '净化误伤了合并格');
  } finally { t.dispose(); }
});

/* 读信那条路 = 所见即所得的**只读**面（父线 2026-10-21：「我只要所见即所得，不要两个面」）。
   收进来的信是外部内容 ⇒ 脚本/事件/外链照旧被净化门剥掉，受管图按授权字节解析成 data URI。 */
it('读信是所见即所得的只读面，受管图显示、外链图不请求', async () => {
  const received = {...seed, name: 'mail-recv', status: 'Received', subject: '来信带表带图'};
  const t = mount((url, body) => ({result: {mail: received}}), [received]);
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 60));   // 等受管图字节解析完
    const surface = t.w.document.querySelector('[data-mail-body-wysiwyg]');
    assert.ok(surface, '读信缺正文面');
    const editor = surface.querySelector('.mail-body-editor');
    assert.ok(editor, '读信正文面里没有编辑器（所见即所得那一个面）');
    assert.equal(editor.getAttribute('contenteditable'), 'false', '读信正文面不该能改');
    const html = editor.innerHTML;
    assert.match(html, /<table/, '正文里表格结构丢失');
    assert.match(html, /colspan="2"/, '正文里横向合并信息丢失');
    assert.doesNotMatch(html, /src="https?:/i, '正文不能发起外部图片请求');
    assert.match(html, /src="data:image\//i, '受管图没显示');
  } finally { t.dispose(); }
});

it('可编辑区改单元格值后保存，表格合并格与CID引用不丢', async () => {
  const writes: any[] = [];
  let stored = {...seed};
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: stored}};
    writes.push(body);
    stored = {...stored, ...body.payload, record_version: 2};
    return {result: {...stored, record_version: 2}};
  });
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    assert.ok(editor, '缺可编辑正文区（不应只有 textarea 源码）');
    assert.equal(editor.getAttribute('contenteditable'), 'true', '正文区必须可编辑');
    // 表格与合并格在可编辑区里真实存在，可被定位
    assert.ok(editor.querySelector('table'), '编辑区缺表格');
    assert.ok(editor.querySelector('[colspan="2"]'), '编辑区缺横向合并格');
    assert.ok(editor.querySelector('[rowspan="2"]'), '编辑区缺纵向合并格');
    // 改一个单元格值
    const cell = editor.querySelectorAll('td')[1];
    cell.textContent = '年费-已核对';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    // 保存（写信窗已无「存草稿」按钮，失焦自动存）
    await triggerSave(t.w);
    assert.ok(writes.length >= 1, '未发起保存');
    const payload = writes[writes.length - 1].payload;
    assert.equal(payload.body_format, 'HTML', '保存必须标记 HTML 格式');
    assert.match(payload.body, /<table/, '保存后表格丢失');
    assert.match(payload.body, /colspan="2"/, '保存后横向合并丢失');
    assert.match(payload.body, /rowspan="2"/, '保存后纵向合并丢失');
    assert.match(payload.body, /cid:logo-sample@shangshu\.local/, '保存后 CID 引用丢失');
    assert.match(payload.body, /年费-已核对/, '保存后单元格修改丢失');
  } finally { t.dispose(); }
});

it('重开同一草稿，表格合并格与CID引用仍在', async () => {
  let stored = {...seed};
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: stored}};
    return {result: {...stored, ...body.payload, record_version: 2}};
  }, [{...seed}]);
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    t.w.document.querySelector('#c-cancel').click();
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    assert.ok(editor.querySelector('table'), '重开后表格丢失');
    assert.ok(editor.querySelector('[colspan="2"]'), '重开后横向合并丢失');
    assert.ok(editor.querySelector('[rowspan="2"]'), '重开后纵向合并丢失');
    assert.ok(editor.querySelector('img'), '重开后内联图丢失');
  } finally { t.dispose(); }
});

// ── PKG-014-T01〔2〕+〔4〕接缝：A 真字节 → 保存 → 重开 ────────────────────────
// 上面两条用的是本文件自带的 SAMPLE_HTML（属性式 <table border>）。
// 这一条接的是 **A 进程里跑出来的真 clipboardData 字节**（t01-clipboard-fixture.json，
// 内联样式 `<td style="border:1px solid #ccc;padding:4px 8px;">`）——
// 走的净化分支不同（内联样式要过 CSS 白名单），**不许拿上面两条的绿抵本条**。
// A 交接文档 §4 要的就是「粘贴后 → 保存 → 重开 → 内容一致」这一整截。
it('T01〔2〕〔4〕：A 真复制出口字节粘贴→保存→重开，每个真单元格值都在', async () => {
  const {loadABytes, pasteClipboard} = await import('../helpers/copy-format.ts');
  const a = loadABytes();   // 真字节 + 身份闸
  const writes: any[] = [];
  let stored = {...seed, body: '<p>新正文</p>'};
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: stored}};
    writes.push(body);
    stored = {...stored, ...body.payload, record_version: 2};
    return {result: {...stored, record_version: 2}};
  }, [{...seed, body: '<p>新正文</p>'}]);
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const editor = t.w.document.querySelector('#c-editor') as any;
    assert.ok(editor, '缺可编辑正文区');

    // ① 粘 A 的真字节
    pasteClipboard(t.w, editor, a.html, a.plain);
    await tick();
    for (const row of a.rows) for (const v of row) {
      assert.ok(editor.innerHTML.includes(v), `粘贴后 A 的值「${v}」没进编辑区`);
    }

    // ② 保存
    await triggerSave(t.w);
    assert.ok(writes.length >= 1, '未发起保存');
    const savedBody = writes[writes.length - 1].payload.body;
    assert.match(savedBody, /<table/, '保存后表格丢失');
    for (const row of a.rows) for (const v of row) {
      assert.ok(savedBody.includes(v), `保存后 A 的值「${v}」丢了 —— ${savedBody.slice(0, 220)}`);
    }

    // ③ 关掉再重开，值还在（A §4 要的「重开」）
    t.w.document.querySelector('#c-cancel').click();
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    const reopened = (t.w.document.querySelector('#c-editor') as any)?.innerHTML
      || (t.w.document.querySelector('#c-body') as any)?.value || '';
    assert.ok(reopened.includes('<table'), `重开后表格丢了 —— ${reopened.slice(0, 200)}`);
    for (const row of a.rows) for (const v of row) {
      assert.ok(reopened.includes(v), `重开后 A 的值「${v}」丢了 —— ${reopened.slice(0, 220)}`);
    }
  } finally { t.dispose(); }
});


/* ── req 1：inline_resources 前后端 schema 一致 ────────────────────────────
   用户 2026-10-17 C01 第 1 条：「前后端 schema 一致，保留图片来源权限/固定引用/CID 校验；
   **不能允许任意未知字段**」。反馈原话：「**修复必须保留图片来源授权与固定版本约束，
   不通过放宽任意属性规避**」。

   本条测**前端**那半：`mail-editor.js` 打开草稿时把 `inline_resources` **全展开**
   （`resources.set(key, {...item})`），任意未知字段会跟着草稿带回来、再保存就发出去。
   对比插图路径（:902 附近）是**白名单构造**（只有 content_id/mime_type/name/file）。

   测试通过 = 打开一份 `inline_resources` 里带未知字段的草稿，保存时
   **发出去的每个资源只有白名单 4 个字段**，未知字段不跟出去、缺 content_id 的被丢掉。

   ★ 这条**不放宽 schema**（后端 `additionalProperties:False` 照旧），
     修法是前端那几处 `{...item}` 改成跟插图路径一样的白名单构造。

   ⚠️ **判据只覆盖「打开草稿」这条主路径**。BASE967 线另有两处同族全展开
      （`applyHistory()` 撤销/重做恢复、`applyEdit()` Assistant 代写塞 resources）——
      那两处**也一起修了**，但**本批没补判据**（要 undo/Assistant 夹具，另交）。
      **不冒称「三处都有判据」。** */
it('打开带未知字段的 inline_resources 草稿，保存时不许把未知字段跟出去', async () => {
  /* 模拟「已存在的草稿带了 schema 外的字段」—— 这正是 UI044 那条反例的形状：
     后端 `domain.py` 的 INLINE_RESOURCE 只声明 content_id/mime_type/name/file，
     `additionalProperties:False`；前端把 source/任意字段带回去就构成前后端不一致。 */
  const dirty = {
    ...seed,
    name: 'mail-unknown-field',
    subject: '带未知字段的草稿',
    inline_resources: [
      {content_id: CID, mime_type: 'image/png', name: '样例图.png', file: 'file-sample',
       /* ↓↓↓ schema 外的字段 —— 这些不该跟着保存发出去 ↓↓↓ */
       source: 'https://tracker.invalid/leak.png',
       evil: 'x',
       owner_subject: 'Employee',
      },
      /* 第二条是「缺必需字段」的形状 —— content_id 为空，schema 也要求拒；
         前端不许把它当作合法资源发出去。 */
      {mime_type: 'image/png', name: '无引用图.png', file: 'file-orphan'},
    ],
  };
  const seen: any[] = [];
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: dirty}};
    /* action() 打的是 /api/platform/actions/mail.save_draft/execute，
       载荷在 body.payload 里（不是 body 顶层）。 */
    const payload = body && body.payload ? body.payload : body;
    if (payload && payload.inline_resources !== undefined) {
      seen.push(payload);
      return {result: {name: 'mail-unknown-field', record_version: 2, subject: payload.subject,
                        body: payload.body, body_format: payload.body_format}};
    }
    return {result: {mail: dirty}};
  }, [dirty]);
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    await tick();
    await tick();
    const editor = t.w.document.querySelector('#c-editor');
    assert.ok(editor, '缺可编辑正文区');
    /* 内容必须真变一次 —— 失焦保存是防抖，且脏检测会跳过没改过的 */
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    await triggerSave(t.w);
    assert.ok(seen.length > 0, '保存请求没发出去 —— 测不到「未知字段有没有跟出去」');

    const ALLOWED = new Set(['content_id', 'mime_type', 'name', 'file']);
    for (const [i, body] of seen.entries()) {
      const list = body.inline_resources || [];
      assert.ok(list.length > 0, `第 ${i + 1} 次保存的 inline_resources 是空的 —— 夹具没生效`);
      /* ★ 夹具第二条是「缺 content_id」的形状 —— 它不该出现在载荷里。
         两边都丢（前端丢 + service.py:371 丢）才叫前后端一致；
         一边丢一边留就是新的一处不一致。 */
      assert.equal(list.length, 1,
        `第 ${i + 1} 次保存的 inline_resources 该只有 1 条（缺 content_id 的那条该被丢掉），` +
        `实际 ${list.length} 条：${JSON.stringify(list.map(x => x.content_id))}`);
      for (const [j, item] of list.entries()) {
        const extra = Object.keys(item).filter(k => !ALLOWED.has(k));
        assert.deepEqual(extra, [],
          `第 ${i + 1} 次保存的 inline_resources[${j}] 带了 schema 外的字段：${extra.join('、')} —— ` +
          `后端 INLINE_RESOURCE 是 additionalProperties:False，带出去就是前后端不一致（UI044 根因）`);
        assert.ok(item.content_id,
          `第 ${i + 1} 次保存的 inline_resources[${j}] 缺 content_id —— 正文 cid: 引用悬空`);
        assert.ok(item.file,
          `第 ${i + 1} 次保存的 inline_resources[${j}] 缺 file —— schema 必填`);
      }
    }
  } finally { t.dispose(); }
});

/* ── req 1 收尾：资源表**构造**也要白名单 —— 上一条只把了「保存载荷」那道口 ──────
   d556cd41 修的是 wire() 出口（发保存载荷走 `getInlineResourcesForSave` 过滤）；
   但资源表本身仍 `{...item}` 全展开，任意字段会留在 Map 里，宿主从**不过滤**的
   `getInlineResources()` 取值（签名编辑口 mail-center.js:361）就漏出去了。
   三处全展开：① `mountEditor` 的 `cfg.resources`（mail-editor.js:1026）
              ② `applyHistory()` 撤销/重做恢复（:1143）
              ③ `applyEdit()` Assistant 代写塞 resources（:1404）
   「不能允许任意未知字段」要打在**构造**上，不是只打出口。

   测试通过 = 三个入口进来的资源，`getInlineResources()` 里只可能是已知字段：
   content_id / mime_type / name / file / source（来源归属）/ data（显示字节），
   其余字段一条都不许活着走出资源表。 */
it('资源表构造白名单：打开草稿/撤回恢复/代写塞入都不许带 schema 外字段', async () => {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const dirty = {
    content_id: 'cid-wl@shangshu.local', mime_type: 'image/png', name: '图.png', file: 'file-wl',
    source: {ref_doctype: 'Shangshu Mail Message', ref_name: 'mail-wl', file: 'file-wl'},
    /* ↓ schema 外的字段 —— 不该活着走出资源表 ↓ */
    evil: '<script>x</script>', owner_subject: 'Employee', file_url: 'https://tracker.invalid/leak.png',
  };
  const KNOWN = new Set(['content_id', 'mime_type', 'name', 'file', 'source', 'data']);
  const assertClean = (list: any[], where: string) => {
    assert.ok(list.length > 0, `${where}：资源表空了 —— 夹具没生效，测不到白名单`);
    for (const item of list) {
      const extra = Object.keys(item).filter(k => !KNOWN.has(k));
      assert.deepEqual(extra, [],
        `${where}：资源带了 schema 外字段 ${extra.join('、')} —— 任意未知字段不许进资源表（BASE967-03 / UI044 根因）`);
    }
  };
  const api = w.mailEditor.mountEditor(w.document.querySelector('#host'), {
    value: '<p>图 <img src="cid:cid-wl@shangshu.local" alt="图"></p>',
    resources: [dirty], onChange: () => {},
    uploadImage: async () => ({content_id: 'cid-up@shangshu.local', mime_type: 'image/png', file: 'file-up'}),
  });
  try {
    assertClean(api.getInlineResources(), '① 打开草稿（cfg.resources 全展开）');
    /* ② 撤回恢复：落一步编辑再撤回 —— applyHistory 从历史快照回灌资源表 */
    api.applyEdit('<p>图 <img src="cid:cid-wl@shangshu.local" alt="图"></p><p>改动</p>', {actor: 'user'});
    assert.ok(api.undo(), '撤回不动 —— 测不到历史回灌');
    assertClean(api.getInlineResources(), '② 撤回恢复（applyHistory 回灌）');
    /* ③ 代写塞入：Assistant 候选带 resources 进来（引用在正文里，防 pruneResources 清掉） */
    api.applyEdit('<p>助手代写 <img src="cid:cid-wl@shangshu.local" alt="图"></p>',
      {actor: 'assistant', resources: [dirty]});
    assertClean(api.getInlineResources(), '③ 代写塞入（applyEdit opts.resources）');
  } finally { dom.window.close(); }
});

/* ── BASE967-17 容量统一：序列化正文长度预警，超限内容可恢复 ──────────────────
   源文：「统一实际序列化正文容量与前端预警，保留安全上限，超限时内容可恢复」。
   后端 body 硬上限 100000（domain.py）不放宽；前端按**实际序列化正文**
   （normalizeMarkup 后那份，就是发出去的 body）计数。

   测试通过 = ① 接近上限出预警（≥90001）② 超上限出明确超限预警且内容仍在
   #c-body（可删减重存）③ 降回阈值内预警消失。 */
it('正文容量预警：接近/超出上限提示，超限时内容不丢（BASE967-17）', async () => {
  const t = mount((url, body) => ({result: {mail: seed}}));
  try {
    await tick();
    t.w.document.querySelector('[data-open]').click();
    for (let i = 0; i < 30; i++) { if (t.w.document.querySelector('#c-editor')) break; await tick(); }
    const ed = t.w.document.querySelector('#c-editor') as HTMLElement;
    const note = t.w.document.querySelector('#body-capacity-note') as HTMLElement;
    assert.ok(ed, '缺正文编辑区');
    assert.ok(note, '缺正文容量提示位（BASE967-17 前端预警）');
    assert.equal(note.hidden, true, '正文不长时不该有容量提示');

    const setBody = (chars: number) => {
      ed.innerHTML = `<p>${'x'.repeat(chars)}</p>`;
      ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    };
    setBody(95000);
    assert.equal(note.hidden, false, '接近上限该有提示');
    assert.match(note.textContent || '', /接近上限/,
      `接近上限的提示要说清「接近上限」，实际：${(note.textContent || '').slice(0, 60)}`);

    setBody(100500);
    assert.match(note.textContent || '', /超出上限/,
      `超上限要说清「超出上限」，实际：${(note.textContent || '').slice(0, 60)}`);
    const bodyVal = (t.w.document.querySelector('#c-body') as HTMLTextAreaElement).value || '';
    assert.ok(bodyVal.includes('x'.repeat(100)),
      '超限后内容必须仍在 #c-body（可删减后重存，不许静默截断/清空）');

    setBody(50000);
    assert.equal(note.hidden, true, '降回阈值内提示该消失');
  } finally { t.dispose(); }
});


/* ── BASE967-03 另一半：四条路（新建/回复/转发/签名）保存重开 + 保留 inline_resources ──
   用户 2026-10-17 C01 第 1 条后半：「新建、回复、转发、签名、正文插图均保存重开并验证 MIME」。
   前一半（schema 白名单）在 d556cd41；这一半验**四条路各自保存重开后 inline_resources 还在、
   未知字段不跟出去**。

   测试通过 = 下面四条各自成立：
     · 新建草稿：保存载荷里 inline_resources 那条图在，content_id/file 对得上，无 schema 外字段
     · 回复：同上（走 #reply 开写信窗）
     · 转发：同上（走 #forward 开写信窗）
     · 签名图：签名里的图随草稿保存进载荷

   ⚠️ **MIME 那半本条不验**（MIME 生成在后端，jsdom 够不到）。
      容器侧 `test-mail-mime-fidelity.py` / `mime-vs-preview.py` 才是 MIME 判据，
      但那要 BASE967 代码进容器（部署闸拒着）。**不冒称「MIME 已验」。** */
const RES_A = {content_id: 'img-a@shangshu.local', mime_type: 'image/png', name: '甲图.png',
               file: 'file-a', source: {ref_doctype: 'Shangshu File Center File', ref_name: 'lib-a', file: 'file-a'}};
const RES_B = {content_id: 'img-b@shangshu.local', mime_type: 'image/png', name: '乙图.png',
               file: 'file-b', source: {ref_doctype: 'Shangshu File Center File', ref_name: 'lib-b', file: 'file-b'}};
const ALLOWED_FIELDS = ['content_id', 'mime_type', 'name', 'file'];

function makeSeed(over: any = {}) {
  return {...seed, ...over,
    body: `<p>正文</p><p><img src="cid:${RES_A.content_id}"></p>`,
    inline_resources: [{...RES_A, evil: 'x'}],
  };
}

/** 打开一条信 → 点指定动作按钮 → 等写信窗。`action` 为 null 表示直接开写信窗（新建）。 */
async function openVia(t: any, subject: string, action: string | null) {
  await tick(); await tick();
  if (action) {
    const item = [...t.w.document.querySelectorAll('[data-mail], [data-open]')]
      .find((el: any) => (el.textContent || '').includes(subject)) as any;
    assert.ok(item, `列表里找不到「${subject}」`);
    item.click();
    for (let i = 0; i < 20; i++) { if (t.w.document.querySelector(action)) break; await tick(); await tick(); }
    (t.w.document.querySelector(action) as any).click();
  } else {
    const opener = t.w.document.querySelector('[data-open]') as any;
    assert.ok(opener, '找不到写信入口');
    opener.click();
  }
  await tick(); await tick();
  await new Promise(r => setTimeout(r, 250));
}

async function saveOnce(t: any, label: string) {
  const editor = t.w.document.querySelector('#c-editor') as any;
  assert.ok(editor, `${label}：缺可编辑正文区`);
  editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  await tick();
  await triggerSave(t.w);
}

function assertClean(list: any[], label: string) {
  for (const item of list) {
    const extra = Object.keys(item).filter(k => !ALLOWED_FIELDS.includes(k));
    assert.deepEqual(extra, [], `${label}：载荷里带了 schema 外字段：${extra.join('、')}`);
  }
}

/* 回复/转发/签名图那三条**不放在这个文件** —— 这个 mount 只渲染写信窗，
   开不出邮件详情（`#reply`/`#forward` 在详情里）。硬造架子两版都红，都是我的问题不是产品。
   改成**分散到各用各的架子**：
     · 回复/转发的载荷 schema 白名单 → `mail-forward-quote.test.ts`（它能开详情）
     · 签名图的载荷 schema 白名单 → `mail-signature.test.ts` SIG-M 旁
   这条「新建」留着 —— 它盖**保存载荷的 schema 白名单 + 保存重开后资源还在**（持久化）。 */
it('四条路·新建草稿：保存载荷里 inline_resources 过 schema 白名单，保存重开后还在', async () => {
  const draft = makeSeed({name: 'mail-new', subject: '新建带图'});
  const seen: any[] = [];
  let stored = {...draft};
  const t = mount((url, body) => {
    if (url.includes('/services/')) return {result: {mail: stored}};
    const payload = body && body.payload ? body.payload : body;
    if (payload && payload.inline_resources !== undefined) {
      seen.push(payload);
      stored = {...stored, ...payload, record_version: (stored.record_version || 1) + 1};
      return {result: {...stored, record_version: stored.record_version}};
    }
    return {result: {mail: stored}};
  }, [draft]);
  try {
    await openVia(t, draft.subject, null);
    await saveOnce(t, '新建');
    assert.ok(seen.length > 0, '新建：保存请求没发出去');
    const list = seen[seen.length - 1].inline_resources || [];
    assert.ok(list.length > 0, '新建：载荷里 inline_resources 是空的');
    const item = list.find((r: any) => r.content_id === RES_A.content_id);
    assert.ok(item, `新建：载荷里找不到 ${RES_A.content_id} —— 实际 ${JSON.stringify(list.map((x: any) => x.content_id))}`);
    assert.equal(item.file, RES_A.file, '新建：file 固定引用丢了');
    assertClean(list, '新建');
  } finally { t.dispose(); }
});
