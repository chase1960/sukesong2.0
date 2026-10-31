import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 共享邮箱的**界面那一半** —— 执行计划 N5-1 / N5-5、用户 2026-10-13 给 C 的表：

   「共享邮箱」两个员工用各自账号进入同一个部门邮箱；
    能**切换**个人箱和获授权的部门箱，共用邮件，不为每个人复制一份
   「邮箱权限」分开控制阅读、编辑草稿、代发、邮箱配置及签名管理；
    **能读不等于能发**

 后端那一半已经交付（`test-mail-n5-shared-mailbox.py` 21/21，提交 5ec585dd）：
 邮箱有自己的稳定编号、授权表五项分开、邮件按邮箱归属。
 **但界面上没有切换入口，用户根本进不去部门箱** —— 这条补的是那一半。

 先写测试再实现（CLAUDE.md 一）。没实现前这段是红的，那是**对的**。

   测试通过 = 下面全部成立：

   S1. 页头能看出**当前在哪个邮箱**，并能列出我能进入的邮箱
       （自己的个人箱 + 获授权的部门箱）
   S2. 切到部门箱 → 列表查询**带上那个邮箱编号**，看到的是部门箱的信
   S3. 切回个人箱 → 查的是个人箱，不串箱
   S4. 当前箱上**没有代发权**时，发信用的入口不给用（能读≠能发的前端面）
   S5. 当前箱上**没有签名管理权**时，签名入口不给用（N5-2 五项分开）
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const PERSONAL = {id: 'box-personal', kind: 'personal', department: '', email: 'me@qq.com',
                  display_name: '我', enabled: true, connection_status: 'connected',
                  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT_READ_ONLY = {id: 'box-dept', kind: 'department', department: '交付部',
                        email: 'dept@lingeringtek.cn', display_name: '交付部公共邮箱',
                        enabled: true, connection_status: 'connected',
                        rights: {read: true, edit_draft: false, send: false, manage: false, signature: false}};
const DEPT_FULL = {...DEPT_READ_ONLY,
                   rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};

function mount(opts: {mailboxes: any[]; rowsByBox?: Record<string, any[]>;mailboxesFailure?:'403'|'malformed';accountBound?:boolean}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const queried: any[] = [];
  const actions: string[] = [];
  /* 动作载荷也要留：S12 要核对保存草稿时 `mailbox` 到底是哪个箱（迁没迁箱）。 */
  const payloads: any[] = [];
  const rowsByBox = opts.rowsByBox || {};
  w.fetch = async (url: string, options: any = {}) => {
    const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                        text: async () => JSON.stringify(payload)});
    if (url.includes('/services/mail.mailboxes/')) {
      if(opts.mailboxesFailure==='403')return {ok:false,status:403,json:async()=>({ok:false,error:'无权读取邮箱目录'})};
      if(opts.mailboxesFailure==='malformed')return respond({result:{}});
      return respond({result: {mailboxes: opts.mailboxes}});
    }
    if (url.includes('/services/mail.account.status/')) {
      const first = opts.mailboxes[0] || PERSONAL;
      return respond({result: {account: {
        bound: opts.accountBound!==false, enabled: opts.accountBound!==false, connection_status: opts.accountBound===false?'unbound':'connected',
        email: first.email, display_name: first.display_name,
        signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/services/mail.detail/')) {
      const name = JSON.parse(options.body || '{}').payload?.mail;
      const mail = Object.values(rowsByBox).flat().find((row: any) => row.name === name);
      return respond({result: {mail: mail || {}}});
    }
    if (url.includes('/actions/')) {
      actions.push(url);
      try { payloads.push({url, ...(options.body ? JSON.parse(options.body) : {})}); } catch { payloads.push({url}); }
      return respond({result: {record_version: 2}});
    }
    if (url.includes('/datasets/')) {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const filters = JSON.parse(params.get('filters') || '{}');
      queried.push(filters);
      const rows = rowsByBox[filters.mailbox || ''] || [];
      return respond({rows, total: rows.length, page: 1, page_length: 30});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, queried, actions, payloads, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async (t: ReturnType<typeof mount>) => {
  await tick(); await tick(); await tick();
};

/** 页头的邮箱切换器。 */
function switcher(t: ReturnType<typeof mount>) {
  const el = t.doc().querySelector('#mailbox-switch, [data-mailbox-switch]') as any;
  return el;
}

it('S1 页头能进个人箱和获授权的部门箱，且标得出当前在哪个箱', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_FULL]});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '页头应当有邮箱切换器（否则用户根本进不去部门箱）');
    const values = [...el.querySelectorAll('option')].map((o: any) => o.value);
    assert.ok(values.includes(PERSONAL.id), `切换器里该有个人箱：${values.join(',')}`);
    assert.ok(values.includes(DEPT_FULL.id), `切换器里该有获授权的部门箱：${values.join(',')}`);
    // 当前在哪个箱要看得见
    const label = t.doc().querySelector('.preview-label')?.textContent || '';
    assert.ok(/个人|@|邮箱/.test(label), `页头该标得出当前邮箱，实际：${label}`);
  } finally { t.dispose(); }
});

it('只有管理权无阅读权的箱不能成为默认范围，本人未绑定草稿仍能打开和刷新',async()=>{
 const manager={...DEPT_FULL,rights:{read:false,edit_draft:false,send:false,manage:true,signature:false}};
 const row={name:'own-legacy-draft',mailbox_id:'own-unbound-personal',owner:'Administrator',subject:'本人旧草稿',status:'Draft',record_version:1,to:[],cc:[],body:'正文',attachments:[]};
 const t=mount({mailboxes:[manager],rowsByBox:{'':[row]}});try{await settle(t);const d=t.doc(),picker=switcher(t);assert.equal(picker.value,'','默认应保持后端本人草稿范围');assert.equal(picker.disabled,false,'仅管理箱仍可显式选择去配置，不能抢默认范围');
  (d.querySelector('[data-open]') as HTMLButtonElement).click();await tick();await tick();assert.ok(d.querySelector('#c-subject'),'正式记录归本人自然箱，不应借部门箱编辑权限判成只读');
  (d.querySelector('#dlg-close') as HTMLButtonElement).click();(d.querySelector('#clear') as HTMLButtonElement).click();await settle(t);assert.ok(t.queried.every(filter=>filter.mailbox!==manager.id),'刷新不能悄悄按无read的管理箱筛选');assert.ok(d.querySelector('[data-open]'));
 }finally{t.dispose();}
});

it('已绑定个人账号但目录失败时不能标未绑定，持续提示共享目录不可用且重读可恢复',async()=>{
 for(const mailboxesFailure of ['403','malformed'] as const){const opts:{mailboxes:any[];mailboxesFailure?:'403'|'malformed'}={mailboxes:[PERSONAL,DEPT_FULL],mailboxesFailure};const t=mount(opts);
  try{await settle(t);const d=t.doc(),picker=switcher(t);assert.equal(picker.value,'');assert.equal(picker.options.length,1);assert.match(picker.selectedOptions[0].textContent||'',/本人邮箱/);assert.doesNotMatch(picker.selectedOptions[0].textContent||'',/未绑定/);assert.match(picker.selectedOptions[0].textContent||'',/me@qq\.com/);assert.match(d.querySelector('.preview-footer')?.textContent||'',/邮箱列表.*(?:失败|无法)|共享邮箱.*不可/);assert.equal(t.actions.length,0);assert.ok(![...picker.options].some((option:any)=>option.value===DEPT_FULL.id),'目录没读到不能凭账号状态伪造共享选项或权限');
   const retry=d.querySelector('[data-mailbox-retry]') as HTMLButtonElement;assert.ok(retry,'错误必须给可见重读入口');opts.mailboxesFailure=undefined;retry.click();await settle(t);assert.equal(picker.value,PERSONAL.id);assert.ok([...picker.options].some((option:any)=>option.value===DEPT_FULL.id));assert.equal(d.querySelector('[data-mailbox-retry]'),null);assert.equal(t.actions.length,0,'重试只重读，不补授权');
  }finally{t.dispose();}
 }
 const unbound=mount({mailboxes:[],accountBound:false});try{await settle(unbound);assert.match(switcher(unbound).selectedOptions[0].textContent||'',/未绑定/);}finally{unbound.dispose();}
});

it('S2 切到部门箱 → 列表按那个邮箱查，看到的是部门箱的信', async () => {
  const deptRows = [{name: 'd1', subject: '部门来信', status: 'Received', record_version: 1,
                     to_json: '[]', cc_json: '[]', from_address: '对方 <o@x.example>',
                     received_at: '2026-10-13 10:00:00', mailbox_id: DEPT_FULL.id}];
  const t = mount({mailboxes: [PERSONAL, DEPT_FULL],
                   rowsByBox: {[DEPT_FULL.id]: deptRows, [PERSONAL.id]: []}});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '找不到邮箱切换器');
    Object.getOwnPropertyDescriptor(t.w.HTMLOptionElement.prototype, 'selected'); // 触发原型加载
    el.value = DEPT_FULL.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const asked = t.queried.filter((f: any) => f.mailbox === DEPT_FULL.id);
    assert.ok(asked.length > 0,
      `切到部门箱后列表查询必须带上部门箱编号，实际查询：${JSON.stringify(t.queried).slice(0, 200)}`);
    const text = t.doc().querySelector('.mail-list-pane')?.textContent || '';
    assert.ok(text.includes('部门来信'),
      `切到部门箱该看到部门箱的信，实际列表：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('S3 切回个人箱 → 查的是个人箱，不串箱', async () => {
  const personalRows = [{name: 'p1', subject: '张三的个人来信', status: 'Received', record_version: 1,
                         to_json: '[]', cc_json: '[]', from_address: '对方 <o@x.example>',
                         received_at: '2026-10-13 09:00:00', mailbox_id: PERSONAL.id}];
  const deptRows = [{name: 'd1', subject: '部门来信', status: 'Received', record_version: 1,
                     to_json: '[]', cc_json: '[]', from_address: '对方 <o@x.example>',
                     received_at: '2026-10-13 10:00:00', mailbox_id: DEPT_FULL.id}];
  const t = mount({mailboxes: [PERSONAL, DEPT_FULL],
                   rowsByBox: {[DEPT_FULL.id]: deptRows, [PERSONAL.id]: personalRows}});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '找不到邮箱切换器');
    el.value = DEPT_FULL.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));
    assert.ok((t.doc().querySelector('.mail-list-pane')?.textContent || '').includes('部门来信'),
      '先切到部门箱应当看到部门的信');

    el.value = PERSONAL.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));
    const text = t.doc().querySelector('.mail-list-pane')?.textContent || '';
    assert.ok(text.includes('张三的个人来信'),
      `切回个人箱该看到个人的信，实际：${text.slice(0, 200)}`);
    assert.ok(!text.includes('部门来信'),
      `切回个人箱不该串进部门箱的信，实际：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('S4 当前箱没有代发权时，发信入口不给用（能读不等于能发）', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_READ_ONLY]});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '找不到邮箱切换器');
    el.value = DEPT_READ_ONLY.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const compose = t.doc().querySelector('#compose') as any;
    assert.ok(compose, '找不到写邮件入口');
    assert.ok(compose.disabled,
      `只读授权的部门箱上不该给发信入口（能读不等于能发），实际 disabled=${compose.disabled}`);

    // 切回有代发权的个人箱 → 入口要回来，不能永久锁死
    el.value = PERSONAL.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));
    const back = t.doc().querySelector('#compose') as any;
    assert.ok(!back.disabled,
      `切回有代发权的个人箱后写邮件应当可用，实际 disabled=${back.disabled}`);
  } finally { t.dispose(); }
});

it('S5 当前箱没有签名管理权时，签名入口不给用', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_READ_ONLY]});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '找不到邮箱切换器');
    el.value = DEPT_READ_ONLY.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const sig = t.doc().querySelector('#sig-btn') as any;
    assert.ok(sig, '找不到签名入口');
    assert.ok(sig.disabled,
      `没签名管理权就不该给签名入口，实际 disabled=${sig.disabled}`);
  } finally { t.dispose(); }
});

const received = (over: any = {}) => ({name: 'shared-message', subject: '共享来信', status: 'Received',
  record_version: 1, body: '只读正文', body_format: 'Text', to: ['me@qq.com'], cc: [],
  attachments: [], from_address: '客户 <client@example.invalid>', ...over});
const openOnlyRow = async (t: ReturnType<typeof mount>) => {
  await settle(t);
  // 与真实用户一样先选获权邮箱；首次并行加载尚未带 mailbox 的请求不作为夹具行。
  const box = switcher(t);
  box.value=[...box.options].find((option:any)=>option.value)?.value||'';
  box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
  await new Promise(r => setTimeout(r, 350));
  const row = t.doc().querySelector('[data-open]') as any;
  assert.ok(row, '选好测试邮箱后必须看到合成邮件，否则不能判断按钮权限');
  row.click();
  await settle(t);
};

it('S6 只读共享箱的回收按钮禁用，不能发出回收请求', async () => {
  const t = mount({mailboxes: [DEPT_READ_ONLY], rowsByBox: {[DEPT_READ_ONLY.id]: [received()]}});
  try {
    await openOnlyRow(t);
    const btn = t.doc().querySelector('#trash-mail') as any;
    assert.ok(btn?.disabled, '只读共享箱不能让人点击回收');
    assert.match(btn.title, /邮件管理权限/);
    btn.click(); btn.click(); await settle(t);
    assert.equal(t.actions.filter(url => url.includes('mail.recycle')).length, 0);
  } finally { t.dispose(); }
});

it('S7 只读共享箱的恢复按钮禁用，不能发出恢复请求', async () => {
  const t = mount({mailboxes: [DEPT_READ_ONLY], rowsByBox: {[DEPT_READ_ONLY.id]: [received({status: 'Trash', previous_status: 'Received'})]}});
  try {
    await openOnlyRow(t);
    const btn = t.doc().querySelector('#restore-mail') as any;
    assert.ok(btn?.disabled, '只读共享箱不能让人点击恢复');
    assert.match(btn.title, /邮件管理权限/);
    btn.click(); await settle(t);
    assert.equal(t.actions.filter(url => url.includes('mail.restore')).length, 0);
  } finally { t.dispose(); }
});

it('S8 共享草稿没有edit_draft时只读展示正文，不挂编辑器和保存事件', async () => {
  const t = mount({mailboxes: [DEPT_READ_ONLY], rowsByBox: {[DEPT_READ_ONLY.id]: [received({status: 'Draft'})]}});
  try {
    await openOnlyRow(t);
    assert.equal(t.doc().querySelector('#c-body'), null, '只读草稿不能直接进入编辑器');
    assert.equal(t.doc().querySelector('[contenteditable="true"]'), null);
    assert.match(t.doc().querySelector('#detail')?.textContent || '', /只读正文/);
    assert.match(t.doc().querySelector('#detail')?.textContent || '', /没有编辑草稿权限/);
    /* BASE967-53（req 6「只读 Draft 不能显示 Received」）：状态行必须说「草稿」。
       根因：阅读模板用 `deliveryText(m) || '已收到'`，没有 Draft 分支 ——
       一封没发出去的草稿在只读详情里被标成「已收到」。 */
    const labels = [...t.doc().querySelectorAll('#detail dt')];
    const statusLabel = labels.find(dt => (dt.textContent || '').trim() === '状态');
    const statusText = (statusLabel?.nextElementSibling?.textContent || '').trim();
    assert.equal(statusText, '草稿',
      `只读草稿的状态该是「草稿」，实际「${statusText}」`);
    assert.equal(t.actions.filter(url => url.includes('mail.save_draft')).length, 0);
  } finally { t.dispose(); }
});

it('S9 只有manage且无代发或草稿编辑权仍能回收和恢复共享邮件', async () => {
  const manager = {...DEPT_READ_ONLY, rights: {...DEPT_READ_ONLY.rights, manage: true}};
  for (const status of ['Received', 'Trash']) {
    const t = mount({mailboxes: [manager], rowsByBox: {[manager.id]: [received({status, previous_status: 'Received'})]}});
    try {
      await openOnlyRow(t);
      const btn = t.doc().querySelector(status === 'Trash' ? '#restore-mail' : '#trash-mail') as any;
      assert.equal(btn.disabled, false, '明确manage权不依赖send/edit_draft');
      btn.click(); if (status !== 'Trash') btn.click(); await settle(t);
      assert.equal(t.actions.filter(url => url.includes(status === 'Trash' ? 'mail.restore' : 'mail.recycle')).length, 1);
    } finally { t.dispose(); }
  }
});

it('S10 edit_draft可编辑现有共享草稿，但无manage不能删除草稿', async () => {
  const editor = {...DEPT_READ_ONLY, rights: {...DEPT_READ_ONLY.rights, edit_draft: true}};
  const t = mount({mailboxes: [editor], rowsByBox: {[editor.id]: [received({status: 'Draft'})]}});
  try {
    await openOnlyRow(t);
    assert.ok(t.doc().querySelector('#c-body'), '明确edit_draft权应能编辑');
    const trash = t.doc().querySelector('#trash-draft') as any;
    assert.ok(trash?.disabled, '编辑草稿权不能推导删除整个共享草稿');
    trash.click(); trash.click(); await settle(t);
    assert.equal(t.actions.filter(url => url.includes('mail.recycle')).length, 0);
  } finally { t.dispose(); }
});

/* ── BL-21/22（用户 2026-10-17 req 2）：打开共享箱里的**已有草稿**，
      From 不能默认变个人；只改正文保存也不能把草稿悄悄搬去个人箱。
      「只有用户明确选择且获权才切换」—— 明确选择那条另有用例。 ───────────── */
it('S12 打开共享箱草稿：From 停在草稿所在箱，只改正文保存不迁箱', async () => {
  const editor = {...DEPT_READ_ONLY, rights: {...DEPT_READ_ONLY.rights, edit_draft: true}};
  const draft = received({status: 'Draft', subject: '共享草稿', body: '草稿正文', mailbox_id: editor.id});
  const t = mount({mailboxes: [PERSONAL, editor], rowsByBox: {[editor.id]: [draft]}});
  try {
    await settle(t);
    const box = switcher(t);
    box.value = editor.id;
    box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));
    const row = t.doc().querySelector('[data-open]') as any;
    assert.ok(row, '切到共享箱后应看到那封草稿');
    row.click();
    await settle(t);

    const from = t.doc().querySelector('#c-from') as HTMLSelectElement | null;
    assert.ok(from, '写信窗里该有发件身份下拉');
    const selected = from.selectedOptions[0];
    assert.equal(selected.getAttribute('data-mailbox'), editor.id,
      `打开共享草稿时 From 必须停在草稿所在箱，实际停在 ${selected.getAttribute('data-mailbox')}（${selected.textContent}）`);
    assert.match(selected.textContent || '', /无代发权|草稿所在邮箱/,
      '没有 send 权的草稿箱要在下拉里标出来，不能让人以为能用它发');
    assert.equal((t.doc().querySelector('#c-send') as any).disabled, true,
      '草稿所在箱没有 send 权时，不能借它发送');

    /* 只改正文 —— 不改 From、不碰附件 */
    const ed = t.doc().querySelector('#c-editor') as any;
    assert.ok(ed, '缺正文编辑区');
    ed.innerHTML = '<p>只改了正文</p>';
    ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    ed.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 500));

    const saves = t.payloads.filter(p => String(p.url).includes('mail.save_draft'));
    assert.ok(saves.length > 0, '保存请求没发出去');
    const payload = saves[saves.length - 1].payload || {};
    assert.equal(payload.mailbox, editor.id,
      `只改正文保存不该迁箱：保存载荷里的 mailbox 是 ${payload.mailbox}，应为 ${editor.id}`);
  } finally { t.dispose(); }
});

it('S11 未入库附件显示失败原因，不提供手动存入文件中心', async () => {
  const t = mount({mailboxes: [DEPT_READ_ONLY], rowsByBox: {[DEPT_READ_ONLY.id]: [received({
    attachments: [{file: 'source-attachment', name: '合成.txt', size: 12, imported: false, import_error: '附件校验失败'}]
  })]}});
  try {
    await openOnlyRow(t);
    assert.equal(t.doc().querySelector('[data-real-archive]'), null);
    assert.match(t.doc().querySelector('.att-block')?.textContent || '', /未入库/);
    assert.match(t.doc().querySelector('.att-block')?.textContent || '', /附件校验失败/);
    assert.equal(t.actions.filter(url => url.includes('files.import_attachment')).length, 0);
  } finally { t.dispose(); }
});

it('只读共享箱的多选回收入口和选择框禁用，不发任何回收请求',async()=>{
 const t=mount({mailboxes:[DEPT_READ_ONLY],rowsByBox:{[DEPT_READ_ONLY.id]:[received()]}});try{
  await settle(t);switcher(t).value=DEPT_READ_ONLY.id;switcher(t).dispatchEvent(new t.w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,350));const $=(s:string)=>t.doc().querySelector(s) as any;
  assert.equal($('#mail-batch-recycle').disabled,true);assert.equal($('#mail-select-all').disabled,true);assert.equal($('[data-mail-select]').disabled,true);
  $('#mail-batch-recycle').click();await tick();assert.equal(t.actions.filter(url=>url.includes('mail.recycle')).length,0);
 }finally{t.dispose();}
});


/* ── UI-059 / BASE967-18：**「能编辑草稿」和「能代发」是两件事** ───────────────
   用户 2026-10-17 req 2 原话：「**无 send 但有 edit_draft 可以写草稿，不能代发**」。

   S4 测的是「两样都没有」（DEPT_READ_ONLY 的 edit_draft/send 都是 false）→ 写邮件按钮禁用，对。
   **本条测 S4 没盖的那半**：`edit_draft: true` 但 `send: false` ——
   这时**必须能写草稿**（写邮件按钮可用），但**发送按钮必须禁用**。

   现状（根因 `mail-center.js:135`/`:773`）：`#compose` 被 `canSendFrom()` 控 ——
   没有 send 权**连草稿都写不了**，把「能编辑」误当「能发」的反面。 */
const DEPT_EDIT_ONLY = {id: 'box-edit-only', kind: 'department', department: '交付部',
                        email: 'dept@lingeringtek.cn', display_name: '交付部公共邮箱',
                        enabled: true, connection_status: 'connected',
                        rights: {read: true, edit_draft: true, send: false, manage: false, signature: false}};

it('S4b 有编辑草稿权但没代发权：能写草稿，不能发送', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_EDIT_ONLY]});
  try {
    await settle(t);
    const el = switcher(t);
    assert.ok(el, '找不到邮箱切换器');
    el.value = DEPT_EDIT_ONLY.id;
    el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const compose = t.doc().querySelector('#compose') as any;
    assert.ok(compose, '找不到写邮件入口');
    assert.equal(compose.disabled, false,
      `有 edit_draft 就该能写草稿（用户 2026-10-17：无 send 但有 edit_draft 可以写草稿，不能代发），` +
      `实际 disabled=${compose.disabled}`);

    compose.click();
    await new Promise(r => setTimeout(r, 250));
    /* ★ 期望改过一次（2026-10-17，我自己判据写错）：
       第一版断言 `#c-send.disabled === true` —— **错的**。
       `mail-center.js:140` 原话：「浏览范围仍由 currentBox 决定；回复可用**本人身份**发出，
       不能借用所浏览箱的权限」。所以「不能代发」= **不能用这个箱发**，
       不是「发不了信」—— 用户拿自己个人身份发是允许的。
       正确的断言是：**发件身份下拉里不该出现这个箱**（它没有 send 权）。 */
    const from = t.doc().querySelector('#c-from') as HTMLSelectElement | null;
    assert.ok(from, '写信窗里该有发件身份下拉');
    const values = [...from.querySelectorAll('option')].map((o: any) => o.value);
    assert.ok(!values.includes(DEPT_EDIT_ONLY.id),
      `没代发权的箱不该出现在发件身份里（不能借用所浏览箱的权限），实际选项：${values.join(',')}`);
    assert.ok(values.some(v => v),
      `至少该有一个可用的发件身份（用户自己的），实际选项：${values.join(',')}`);
  } finally { t.dispose(); }
});
