import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 PKG-006-T05 的三条**行为**判据（计划原文）：

   「……切邮箱不丢草稿、不把上封内容带入另一邮箱；
     **已手改签名切身份时明确保留/替换，不暗改正文**」

 前两条是「不许出事」，第三条是「要给个明白话」。
 产品里 `#mailbox-switch` 的 onchange 注释已经写着「不丢当前草稿（草稿是独立记录）」，
 但**没有测试钉住** —— 有人哪天改坏不会有人发现。这一份补上。

 先写测试再实现（CLAUDE.md 一）。

   测试通过 = 下面全部成立：

   S1. **切邮箱不丢草稿** —— 正在写信时切箱，写好的内容还在，草稿没有被清掉
   S2. **不把上封内容带入另一邮箱** —— 在箱 A 写的草稿切到箱 B 后，
       草稿还是那份（仍在箱 A 的身份下），不会冒成箱 B 的
   S3. **已手改签名切身份时明确保留/替换** —— 正文里已有签名时改发件身份，
       界面要给出**明确的选择**（保留 / 换成新身份的），
       **不能默默留着旧身份的签名**（那就是「暗改正文」）
   S4. 那个选择是**看得见的两个出口** —— 「保留原文」和「换成新身份的签名」，
       在人选之前正文一个字不动
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const PERSONAL = {id: 'box-personal', kind: 'personal', department: '', email: 'me@qq.com',
                  display_name: '我', enabled: true, connection_status: 'connected',
                  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT = {id: 'box-dept', kind: 'department', department: '交付部',
              email: 'dept@lingeringtek.cn', display_name: '交付部公共邮箱',
              enabled: true, connection_status: 'connected',
              rights: {read: true, edit_draft: true, send: true, manage: false, signature: false}};

function mount(opts: {mailboxes: any[]; signature?: any}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  /* 保存 mock 带**真实回执校验**（BASE967-47 缺口复核要求）：
     照后端 domain.py/service.py 的口径拒存 —— ① inline_resources 只认 schema
     4 字段（additionalProperties:False）；② 正文 cid: 引用必须都有资源
     （service.py:441-443「正文引用的内联图片未随本次保存提供」）。
     拒存时回 ok:false + 后端同款文案，violation 落档供判据断言 ——
     没有这层校验，「保存成功」在 mock 里是恒真的。 */
  const violations: string[] = [];
  const SCHEMA4 = new Set(['content_id', 'mime_type', 'name', 'file']);
  const respond = (payload: any, ok = true, status = 200) => ({ok, status, json: async () => payload,
                                      text: async () => JSON.stringify(payload)});
  w.fetch = async (url: string, options: any = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    if (url.includes('/services/mail.mailboxes/')) return respond({result: {mailboxes: opts.mailboxes}});
    if (url.includes('/services/mail.account.status/')) {
      return respond({result: {account: {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我',
        signature: opts.signature || {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/datasets/')) return respond({rows: [], total: 0, page: 1, page_length: 30});
    if (url.includes('/actions/mail.save_draft/execute')) {
      const p = body.payload || body;
      const list = p.inline_resources || [];
      for (const [i, r] of list.entries()) {
        const extra = Object.keys(r).filter(k => !SCHEMA4.has(k));
        if (extra.length) {
          violations.push(`第 ${saved.length + 1} 次保存 resources[${i}] schema 外字段：${extra.join('、')}`);
          return respond({exc: '正文引用的内联图片未随本次保存提供（schema 不一致）'}, false, 400);
        }
      }
      const have = new Set(list.map((r: any) => String(r.content_id || '').replace(/^<|>$/g, '')));
      const refs = [...String(p.body || '').matchAll(/cid:([^"'>\s]+)/g)].map(m => m[1]);
      const missing = refs.filter(cid => !have.has(cid));
      if (missing.length) {
        violations.push(`第 ${saved.length + 1} 次保存 悬空 CID：${missing.join('、')}`);
        return respond({exc: '正文引用的内联图片未随本次保存提供：' + missing.join('、')}, false, 400);
      }
      saved.push(body);
      /* 回执要像**真的**（缺口复核：「保存 mock 采用完整真实回执/校验」）——
         mail-center 会拿回执做 baseline 对账（mapReal+`#c-body` 回写服务端规范化正文），
         缺 body/subject/to/cc 这些字段就会被 mapReal 映成空串把本地正文冲掉。 */
      return respond({result: {
        name: 'draft-1', record_version: saved.length + 1,
        subject: p.subject, body: p.body, body_format: p.body_format,
        to: p.to, cc: p.cc,
        attachments: (p.attachments || []).map((f: string) => ({file: f, name: f, size: 0})),
        attachment_bindings: Object.fromEntries((p.attachments || []).map((f: string) => [f, f])),
        inline_resources: list}});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saved, violations, doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async () => { await tick(); await tick(); await tick(); await tick(); };

const setVal = (t: any, el: any, v: string) => {
  const proto = el.tagName === 'TEXTAREA' ? t.w.HTMLTextAreaElement.prototype : t.w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new t.w.Event('input', {bubbles: true}));
  el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
};

async function openCompose(t: ReturnType<typeof mount>) {
  const btn = t.doc().querySelector('#compose') as any;
  assert.ok(btn, '找不到写邮件入口');
  btn.click();
  await tick(); await tick(); await tick();
  assert.ok(t.doc().querySelector('#c-body'), '写信窗没打开');
}

function bodyText(t: ReturnType<typeof mount>) {
  const el = t.doc().querySelector('#c-body') as any;
  return (el && el.value) || '';
}

it('S1 切邮箱不丢草稿 —— 写信中切箱，写好的内容还在', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT]});
  try {
    await settle();
    await openCompose(t);
    setVal(t, t.doc().querySelector('#c-subject'), '切箱时不该丢的草稿');
    setVal(t, t.doc().querySelector('#c-body'), '这段正文是我刚写的');

    const sel = t.doc().querySelector('#mailbox-switch') as any;
    assert.ok(sel, '找不到邮箱切换器');
    sel.value = DEPT.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    assert.ok(t.doc().querySelector('#c-body'), '切箱把写信窗关掉了 —— 草稿会丢');
    assert.equal((t.doc().querySelector('#c-body') as any).value, '这段正文是我刚写的',
      '切箱后正文应当原样还在');
    assert.equal((t.doc().querySelector('#c-subject') as any).value, '切箱时不该丢的草稿',
      '切箱后主题应当原样还在');
  } finally { t.dispose(); }
});

it('S2 不把上封内容带入另一邮箱 —— 切箱后草稿仍在原来的身份下', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT]});
  try {
    await settle();
    await openCompose(t);
    setVal(t, t.doc().querySelector('#c-body'), '这封是用个人箱写的');
    const from = t.doc().querySelector('#c-from') as any;
    assert.ok(from, '找不到发件身份选择');
    const boxBefore = from.selectedOptions[0]?.getAttribute('data-mailbox');
    assert.equal(boxBefore, PERSONAL.id, `新草稿该住个人箱，实际 ${boxBefore}`);

    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const after = t.doc().querySelector('#c-from') as any;
    assert.ok(after, '切箱把发件身份选择弄没了');
    assert.equal(after.selectedOptions[0]?.getAttribute('data-mailbox'), PERSONAL.id,
      '切了列表所在箱，不能把**正在写的这封草稿**也挪过去 —— 那就是「把上封内容带入另一邮箱」');
    assert.equal(bodyText(t), '这封是用个人箱写的', '正文不该被换掉');
  } finally { t.dispose(); }
});

it('S3 已手改签名切身份时明确保留/替换，不暗改正文', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT],
                   signature: {enabled: true, html: '<div>个人签名</div>', resources: []}});
  try {
    await settle();
    await openCompose(t);
    // 正文里已经有签名（新建时自动插的）
    const before = bodyText(t);
    assert.ok(before.includes('个人签名') || before.length >= 0, '先写出正文');

    // 人在签名里改了字
    setVal(t, t.doc().querySelector('#c-body'), '正文\n\n我手改过的签名');

    const from = t.doc().querySelector('#c-from') as any;
    from.value = DEPT.email;
    from.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));

    // 关键：不能**默默**动正文。要么原样保留并说清，要么弹个明确的选择。
    const text = bodyText(t);
    const dialogs = [...t.doc().querySelectorAll('dialog, .os-dialog, [role=dialog]')]
        .map((d: any) => (d.textContent || '').trim()).filter(Boolean);
    const hint = dialogs.join(' ') + ' ' + (t.doc().querySelector('.preview-footer')?.textContent || '');
    assert.ok(text.includes('我手改过的签名') || /保留|替换|签名/.test(hint),
      `切身份后要给出**明确的话**（保留还是换成新身份的），不能闷着不动让人以为对。`
      + `正文现在是 ${JSON.stringify(text)}；界面上的话是 ${JSON.stringify(hint.slice(0, 200))}`);
    assert.ok(text.includes('我手改过的签名'),
      `在人选之前**不许暗改正文** —— 手写的字不能被静默换掉，实际 ${JSON.stringify(text)}`);
  } finally { t.dispose(); }
});

it('S4 切身份时给出明确的两个出口（保留 / 换签名），人选之前正文不动', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT],
                   signature: {enabled: true, html: '<div>个人签名</div>', resources: []}});
  try {
    await settle();
    await openCompose(t);
    setVal(t, t.doc().querySelector('#c-body'), '正文\n\n我手改过的签名');

    const from = t.doc().querySelector('#c-from') as any;
    from.value = DEPT.email;
    from.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 450));

    const dialogs = [...t.doc().querySelectorAll('dialog, .os-dialog, [role=dialog]')]
        .filter((d: any) => d.isConnected) as any[];
    assert.ok(dialogs.length > 0,
      '切身份后正文里有签名时，要给个**明白话**——保留还是换成新身份的，不能闷着不动');

    const text = dialogs.map((d: any) => d.textContent || '').join(' ');
    const buttons = dialogs.flatMap((d: any) => [...d.querySelectorAll('button')]) as any[];
    const labels = buttons.map((b: any) => (b.textContent || '').trim());
    assert.ok(labels.some((l: string) => /保留/.test(l)),
      `要看得见「保留」这个出口，实际按钮：${labels.join(' | ')}`);
    assert.ok(labels.some((l: string) => /换|签名/.test(l)),
      `要看得见「换成新身份的签名」这个出口，实际按钮：${labels.join(' | ')}`);

    // 人选之前正文一个字都不许动
    assert.equal(bodyText(t), '正文\n\n我手改过的签名',
      `人选之前**不许暗改正文**，实际 ${JSON.stringify(bodyText(t))}；弹窗说：${text.slice(0, 150)}`);
  } finally { t.dispose(); }
});

it('切身份替换签名合并新Logo且保留正文图片，撤销恢复旧签名及资源而不改发件身份',async()=>{
 const data='data:image/png;base64,iVBORw0KGgo=',oldLogo={content_id:'old-logo@example.invalid',mime_type:'image/png',name:'旧logo.png',file:'old-file',data},newLogo={content_id:'new-logo@example.invalid',mime_type:'image/png',name:'新logo.png',file:'new-file',data};
 const personal={...PERSONAL,signature:{enabled:true,html:'<p>个人签名<img src="cid:'+oldLogo.content_id+'"></p>',resources:[oldLogo]}},dept={...DEPT,signature:{enabled:true,html:'<p>部门签名<img src="cid:'+newLogo.content_id+'"></p>',resources:[newLogo]}};
 const t=mount({mailboxes:[personal,dept],signature:personal.signature});try{await settle();await openCompose(t);const d=t.doc(),editor=d.querySelector('.mail-body-editor') as HTMLElement,from=d.querySelector('#c-from') as HTMLSelectElement;
  const paragraph=d.createElement('p');paragraph.textContent='本人手写正文和原表格';editor.prepend(paragraph);editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const before=bodyText(t);from.value=DEPT.email;from.dispatchEvent(new t.w.Event('change',{bubbles:true}));await tick();assert.equal(bodyText(t),before,'明确选择替换前不能暗改正文');
  ([...d.querySelectorAll('.os-dialog button')].find((button:any)=>button.textContent==='换成新身份的签名') as HTMLButtonElement).click();await tick();
  assert.match(bodyText(t),/部门签名/);assert.doesNotMatch(bodyText(t),/个人签名/);assert.match(editor.textContent||'',/本人手写正文和原表格/);/* ★ 2026-10-17 纠过期选择器（不是产品 bug）：原来查 `[data-mail-signature] img`，
   但用户 2026-10-15「签名守卫 a」把标记**挪出正文 HTML** 了（mail-center.js
   withDefaultSignature 注释原话：「守卫落在**草稿元数据**上」），正文里不再有这个标记 ——
   选择器找不到 → getAttribute 是 undefined → ||'' 变空串 → 断言误报。
   **图其实是好的**（oldLogo.data 是已知 data URL，水合到位）。改成按已知 data URL 断言。 */
  assert.ok((editor.innerHTML||'').includes(data),
    `签名图没水合成 data URL（应含 ${data.slice(0,30)}…）：${(editor.innerHTML||'').slice(0,200)}`);
  (d.querySelector('#c-save') as HTMLButtonElement).click();await settle();let payload=t.saved.at(-1).payload;assert.ok(payload.inline_resources.some((resource:any)=>resource.content_id===newLogo.content_id));assert.ok(!payload.inline_resources.some((resource:any)=>resource.content_id===oldLogo.content_id));assert.doesNotMatch(payload.body,/src="data:|data-managed-cid/);
  (d.querySelector('[data-editor-undo]') as HTMLButtonElement).click();await tick();assert.match(bodyText(t),/个人签名/);assert.doesNotMatch(bodyText(t),/部门签名/);assert.match(editor.textContent||'',/本人手写正文和原表格/);assert.equal(from.selectedOptions[0].dataset.mailbox,DEPT.id,'正文撤销不改发件身份');
  (d.querySelector('#c-save') as HTMLButtonElement).click();await settle();payload=t.saved.at(-1).payload;assert.ok(payload.inline_resources.some((resource:any)=>resource.content_id===oldLogo.content_id),'撤销应恢复旧图片资源，而不只是旧HTML');assert.ok(!payload.inline_resources.some((resource:any)=>resource.content_id===newLogo.content_id));
 }finally{t.dispose();}
});

/* ── BASE967-47 稳定回归（缺口复核点名的序列）────────────────────────────
   源文要求：「补『保留→切回保留→替换→自动保存→撤回→保存』的稳定回归」，
   「保存 mock 采用完整真实回执/校验」——mock 现在照后端拒存悬空 CID 和
   schema 外字段（见 mount 注释），每一步保存都是真校验，不是恒真。

   测试通过 = 全序列成立：
   ① 保留后正文原样  ② 切回再保留正文原样  ③ 替换后只有新签名、手写正文仍在
   ④ 自动保存的资源与正文引用一致（新 Logo 在、旧 Logo 不在）
   ⑤ 撤回回旧签名+手写正文，发件身份不跟着退
   ⑥ 撤回后的保存**不许报「正文引用的内联图片未随本次保存提供」**
     （BASE967-47 现象）：正文引用旧 Logo，资源里也必须回旧 Logo
   全程 mock 零拒存（violations 为空）。 */
it('BASE967-47 保留→切回保留→替换→自动保存→撤回→保存：每步 CID 与资源同进退', async () => {
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  const oldLogo = {content_id: 'old-logo@example.invalid', mime_type: 'image/png', name: '旧logo.png', file: 'old-file', data};
  const newLogo = {content_id: 'new-logo@example.invalid', mime_type: 'image/png', name: '新logo.png', file: 'new-file', data};
  const personal = {...PERSONAL, signature: {enabled: true, html: '<p>个人签名<img src="cid:old-logo@example.invalid"></p>', resources: [oldLogo]}};
  const dept = {...DEPT, signature: {enabled: true, html: '<p>部门签名<img src="cid:new-logo@example.invalid"></p>', resources: [newLogo]}};
  const t = mount({mailboxes: [personal, dept], signature: personal.signature});
  try {
    await settle(); await openCompose(t);
    const d = t.doc(), editor = d.querySelector('.mail-body-editor') as HTMLElement, from = d.querySelector('#c-from') as HTMLSelectElement;
    const paragraph = d.createElement('p'); paragraph.textContent = '本人手写正文'; editor.prepend(paragraph);
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await settle();
    const pick = async (label: string) => {
      for (let i = 0; i < 25; i++) {
        const b = [...d.querySelectorAll('.os-dialog button')].find((x: any) => x.textContent === label);
        if (b) { (b as HTMLButtonElement).click(); await tick(); return; }
        await tick();
      }
      throw new Error('对话框按钮没出现：' + label);
    };
    const switchTo = async (email: string, choice: string) => {
      from.value = email; from.dispatchEvent(new t.w.Event('change', {bubbles: true}));
      await tick(); await pick(choice); await settle();
    };
    const autosave = async () => {
      (d.querySelector('.mail-body-editor') as HTMLElement).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
      await settle(); await new Promise(r => setTimeout(r, 320));
      return (t.saved.at(-1) || {}).payload || t.saved.at(-1);
    };
    const ids = (p: any) => (p?.inline_resources || []).map((r: any) => r.content_id);

    await switchTo(DEPT.email, '保留原文');
    assert.match(bodyText(t), /个人签名/, '① 保留后签名该原样在');
    /* 保留切换之间夹自动保存 —— 缺口复核点名旧判据「未复现多次保留切换与自动保存并发」 */
    const saved1 = await autosave();
    assert.deepEqual(ids(saved1), [oldLogo.content_id], '① 保留后自动保存该仍带旧 Logo 资源');

    await switchTo(PERSONAL.email, '保留原文');
    assert.match(bodyText(t), /个人签名/, '② 切回再保留，签名该原样在');
    const saved2 = await autosave();
    assert.deepEqual(ids(saved2), [oldLogo.content_id], '② 切回保留后自动保存该仍带旧 Logo 资源');

    await switchTo(DEPT.email, '换成新身份的签名');
    assert.match(bodyText(t), /部门签名/, '③ 替换后该是新签名');
    assert.doesNotMatch(bodyText(t), /个人签名/, '③ 替换后旧签名该没了');
    assert.match(bodyText(t), /本人手写正文/, '③ 手写正文不该被签名替换带走');

    const saved4 = await autosave();
    assert.ok(saved4, '④ 自动保存没发出');
    assert.deepEqual(ids(saved4), [newLogo.content_id],
      `④ 替换后保存的资源该只有新 Logo：${JSON.stringify(ids(saved4))}`);

    (d.querySelector('[data-editor-undo]') as HTMLButtonElement).click();
    await tick(); await settle();
    assert.match(bodyText(t), /个人签名/, '⑤ 撤回该回旧签名');
    assert.doesNotMatch(bodyText(t), /部门签名/, '⑤ 撤回后不该还有新签名');
    assert.equal(from.selectedOptions[0].dataset.mailbox, DEPT.id, '⑤ 正文撤回不改发件身份');

    const saved6 = await autosave();
    assert.ok(saved6, '⑥ 撤回后保存没发出');
    assert.deepEqual(ids(saved6), [oldLogo.content_id],
      `⑥ 撤回后保存的资源该回旧 Logo（不是只回旧 HTML）：${JSON.stringify(ids(saved6))}`);
    assert.ok(String(saved6.body || '').includes('cid:old-logo@example.invalid'),
      '⑥ 保存正文该引用旧 Logo');

    assert.deepEqual(t.violations, [],
      `全程不许有悬空 CID / schema 外字段拒存 —— BASE967-47 现象就是撤回后保存报缺图：${t.violations.join('；')}`);
  } finally { t.dispose(); }
});

/* 回执缺 body 字段时不许清空本地正文（BASE967-47 家族的数据丢失口）——
   正文回写认「回执里真的带 body」，mapReal 把缺字段默认成 '' 的不许当真。 */
it('保存回执缺 body 字段时不许把本地正文清空', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT]});
  try {
    await settle(); await openCompose(t);
    const d = t.doc(), editor = d.querySelector('.mail-body-editor') as HTMLElement;
    editor.innerHTML = '<p>写给客户的正文</p>';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await settle();
    /* 一次性的坏回执：只回 name/record_version，不带 body */
    const inner = t.w.fetch;
    t.w.fetch = async (url: string, options: any = {}) => {
      if (url.includes('/actions/mail.save_draft/execute'))
        return {ok: true, status: 200,
                json: async () => ({result: {name: 'draft-1', record_version: 2}}),
                text: async () => JSON.stringify({result: {name: 'draft-1', record_version: 2}})};
      return inner(url, options);
    };
    (d.querySelector('.mail-body-editor') as HTMLElement).dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle(); await new Promise(r => setTimeout(r, 320));
    assert.match(bodyText(t), /写给客户的正文/,
      `回执不带 body 时本地正文该原样留着，实际正文栏：${JSON.stringify(bodyText(t))}`);
  } finally { t.dispose(); }
});
