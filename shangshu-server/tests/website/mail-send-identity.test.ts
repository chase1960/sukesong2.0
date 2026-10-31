import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast,lastToast} from '../helpers/toast.ts';

/*
 PKG-006-T05「**真实发件身份选择**」的界面那一半。

 计划 PKG-006-T05 判据原文：「……**编辑页选哪个获权身份就用哪个**。」

 后端那一半已经交付并测过（`test-mail-t05-send-identity.py` 5/5）：
 `mail.save_draft` 认 `mailbox`，草稿住在那个箱里，发信 From 就是那个箱；
 只读授权的箱建草稿被拒。**但界面上发件人下拉只有一项** ——
 `accountChrome()` 把 `#c-from` 覆盖成当前箱一个 `<option>`，
 人根本没得选「用哪个身份发」。

 先写测试再实现（CLAUDE.md 一）。没实现前这段是红的，那是**对的**。

   测试通过 = 下面全部成立：

   I1. 写信窗的发件身份下拉列出**我能代发的所有邮箱**
       （自己的个人箱 + 有代发权的部门箱）
   I2. **没代发权的箱不出现在下拉里**（能读不等于能发）
   I3. **选哪个用哪个** —— 选了部门箱保存，草稿保存请求里带上那个邮箱编号
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const PERSONAL = {id: 'box-personal', kind: 'personal', department: '', email: 'me@qq.com',
                  display_name: '我', enabled: true, connection_status: 'connected',
                  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT_SEND = {id: 'box-dept', kind: 'department', department: '交付部',
                   email: 'dept@lingeringtek.cn', display_name: '交付部公共邮箱',
                   enabled: true, connection_status: 'connected',
                   rights: {read: true, edit_draft: true, send: true, manage: false, signature: false}};
const DEPT_READ_ONLY = {id: 'box-dept-ro', kind: 'department', department: '客服部',
                        email: 'cs@lingeringtek.cn', display_name: '客服部公共邮箱',
                        enabled: true, connection_status: 'connected',
                        rights: {read: true, edit_draft: false, send: false, manage: false, signature: false}};

function mount(opts: {mailboxes: any[]; rowsByBox?: Record<string, any[]>; accountConnected?: boolean;accountBound?:boolean}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saved: any[] = [];
  const sent: any[] = [];
  const recycled: any[] = [];
  const queried: any[] = [];
  const synced:any[]=[];
  const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                      text: async () => JSON.stringify(payload)});
  w.fetch = async (url: string, options: any = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    if (url.includes('/services/mail.mailboxes/')) {
      return respond({result: {mailboxes: opts.mailboxes}});
    }
    if (url.includes('/services/mail.account.status/')) {
      return respond({result: {account: {bound: opts.accountBound!==false, enabled: true, connection_status: opts.accountConnected===false?'disconnected':'connected',
        email: 'me@qq.com', display_name: '我', signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/datasets/')) {
      const filters=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}');
      queried.push(filters);
      const rows=opts.rowsByBox?.[filters.mailbox||'']||[];
      return respond({rows, total: rows.length, page: 1, page_length: 30});
    }
    if (url.includes('/services/mail.detail/')) {
      const mail=Object.values(opts.rowsByBox||{}).flat().find(row=>row.name===body.payload?.mail);
      return respond({result:{mail}});
    }
    /* 人点回复/转发 = **调后端那两个动作**（2026-10-21 起）——
       回执就是后端建好的那封草稿（住哪个箱由载荷里的 mailbox 决定）。 */
    if (/\/actions\/(mail\.reply|mail\.forward)\/execute/.test(url)) {
      const p=body.payload||{};
      const box=opts.mailboxes.find(item=>item.id===p.mailbox);
      return respond({result: {...p,name:'draft-1',status:'Draft',record_version:1,
        mailbox_id:p.mailbox||'',from_address:box?.email||'me@qq.com',
        to:p.to||[],cc:p.cc||[],body:p.body||'',body_format:'HTML',
        /* 后端把草稿挂到原信上 —— 回执里也带着（`reply_to_mail`）。 */
        reply_to_mail:p.reply_to_mail||'',
        attachments:[],attachment_bindings:{}}});
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(body);
      const p=body.payload,box=opts.mailboxes.find(box=>box.id===p.mailbox);
      return respond({result: {...p,name: p.mail||'draft-1',status:'Draft',record_version: saved.length+1,
        mailbox_id:p.mailbox,from_address:box?.email||'me@qq.com',attachments:[],attachment_bindings:{}}});
    }
    if(url.includes('/actions/mail.sync/execute')){synced.push(body.payload);return respond({result:{added:0,skipped:0,has_more:false}});}
    if (url.includes('/actions/mail.send/execute')) {
      sent.push(body);
      throw Error('本测试禁止真实发送');
    }
    if(url.includes('/actions/mail.recycle/execute')){recycled.push(body.payload);return respond({result:{name:body.payload.mail,status:'Trash',record_version:body.payload.expected_version+1}});}
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saved, sent, recycled, queried, synced, doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async () => { await tick(); await tick(); await tick(); await tick(); };

/** 打开写信窗。 */
async function openCompose(t: ReturnType<typeof mount>) {
  const btn = t.doc().querySelector('#compose') as any;
  assert.ok(btn, '找不到写邮件入口');
  assert.ok(!btn.disabled, `写邮件入口该是可用的，实际 disabled=${btn.disabled} title=${btn.title}`);
  btn.click();
  await tick(); await tick(); await tick();
  const sel = t.doc().querySelector('#c-from') as any;
  assert.ok(sel, '写信窗里该有发件身份选择');
  return sel;
}

it('I1 发件身份下拉列出我能代发的所有邮箱', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_SEND]});
  try {
    await settle();
    const sel = await openCompose(t);
    assert.equal(sel.disabled,false,'获授权身份不只列出，还必须可以用下拉选择');
    const labels = [...sel.querySelectorAll('option')].map((o: any) => (o.textContent || '').trim());
    assert.ok(labels.length >= 2,
      `发件身份该列出我能代发的**所有**邮箱，实际只有 ${labels.length} 个：${labels.join(' | ')}`);
    assert.ok(labels.some((l: string) => l.includes('me@qq.com')),
      `下拉里该有个人箱，实际：${labels.join(' | ')}`);
    assert.ok(labels.some((l: string) => l.includes('dept@lingeringtek.cn')),
      `下拉里该有有代发权的部门箱，实际：${labels.join(' | ')}`);
  } finally { t.dispose(); }
});

it('只读共享箱回复用本人获权身份核对发送，浏览范围和共享权限保持不变',async()=>{
  const row={name:'shared-received',mailbox_id:DEPT_READ_ONLY.id,status:'Received',record_version:1,
    from_address:'customer@example.com',to:[DEPT_READ_ONLY.email],cc:[],subject:'来信',body:'请答复',
    body_format:'Text',is_read:1,is_read_by_me:1,is_read_by_department:1,attachments:[]};
  const t=mount({mailboxes:[PERSONAL,DEPT_READ_ONLY],rowsByBox:{[DEPT_READ_ONLY.id]:[row]}});
  try{
    await settle();const sw=t.doc().querySelector('#mailbox-switch') as any;
    sw.value=DEPT_READ_ONLY.id;sw.dispatchEvent(new t.w.Event('change',{bubbles:true}));await settle();
    (t.doc().querySelector('[data-open]') as any).click();await settle();
    (t.doc().querySelector('#reply') as any).click();
    /* 写信窗是后端动作回包之后才开的。 */
    for(let i=0;i<40;i++){if(t.doc().querySelector('#c-from'))break;await tick();await tick();}
    await settle();
    const from=t.doc().querySelector('#c-from') as any,send=t.doc().querySelector('#c-send') as any;
    assert.equal(from.value,PERSONAL.email,'从只读共享箱回复应使用有权的个人身份');
    assert.equal(sw.value,DEPT_READ_ONLY.id,'阅读中的共享箱不应被偷偷切换');
    assert.equal(send.disabled,false,'本人身份有权且已连接，不应沿用共享箱的代发禁用');
    /* 改一下主题 ⇒ 有未保存修改 ⇒ 点发送前会先存一版（存的是**后端建的那封草稿**）。 */
    const subject=t.doc().querySelector('#c-subject') as any;
    subject.value='答复：年费已核对';subject.dispatchEvent(new t.w.Event('input',{bubbles:true}));
    const queriesBeforeSave=t.queried.length;
    send.click();await settle();
    assert.ok(t.doc().querySelector('#send-ok'),'只进入发送前核对，不能自动发送');
    assert.equal(t.saved.at(-1)?.payload.mailbox,PERSONAL.id);
    assert.equal(t.saved.at(-1)?.payload.reply_to_mail,row.name);
    assert.equal(t.doc().querySelectorAll('[data-open]').length,1,'个人草稿不能被本地插入共享箱列表');
    assert.equal(t.doc().querySelector('[data-open="draft-1"]'),null);
    assert.match(t.doc().querySelector('#result-count')?.textContent||'',/^1 封/,'共享箱总数不得因个人草稿增加');
    assert.equal(t.queried.length,queriesBeforeSave,'跨箱草稿保存不应为保持列表正确而额外全页重读');
    (t.doc().querySelector('#dlg-close2') as any).click();
    const trash=t.doc().querySelector('#trash-draft') as any;
    assert.equal(trash.disabled,false,'保存后的个人草稿按个人箱manage允许回收');
    trash.click();trash.click();await settle();
    assert.deepEqual(t.recycled,[{mail:'draft-1',expected_version:2}]);
    assert.ok(t.queried.slice(-2).every(query=>query.mailbox===DEPT_READ_ONLY.id),'保存/回收重读不应扩大浏览范围');
    assert.equal(t.sent.length,0);assert.equal(DEPT_READ_ONLY.rights.send,false);
  }finally{t.dispose();}
});

it('同箱新草稿不进入收件范围，保存不增加列表请求',async()=>{
  const row={name:'personal-received',mailbox_id:PERSONAL.id,status:'Received',record_version:1,from_address:'customer@example.com',
    to:[PERSONAL.email],cc:[],subject:'来信',body:'请答复',is_read:1,my_unread:false,dept_unread:false,attachments:[]};
  const t=mount({mailboxes:[PERSONAL],rowsByBox:{[PERSONAL.id]:[row]}});
  try{
    await settle();const scope=t.doc().querySelector('#mail-box') as any;scope.value='inbox';scope.dispatchEvent(new t.w.Event('change',{bubbles:true}));await settle();
    (t.doc().querySelector('[data-open]') as any).click();await settle();(t.doc().querySelector('#reply') as any).click();
    for(let i=0;i<40;i++){if(t.doc().querySelector('#c-save'))break;await tick();await tick();}
    await settle();
    const before=t.queried.length;(t.doc().querySelector('#c-save') as any).click();await settle();
    assert.equal(t.saved.length,1);assert.equal(t.doc().querySelector('[data-open="draft-1"]'),null);assert.equal(t.doc().querySelectorAll('[data-open]').length,1);assert.equal(t.queried.length,before);
  }finally{t.dispose();}
});

it('切到个人发件身份尚未保存时，不能借个人manage删除无管理权的部门草稿',async()=>{
  const row={name:'dept-draft',mailbox_id:DEPT_SEND.id,status:'Draft',record_version:7,from_address:DEPT_SEND.email,
    to:['customer@example.com'],cc:[],subject:'部门草稿',body:'待处理',attachments:[]};
  const t=mount({mailboxes:[PERSONAL,DEPT_SEND],rowsByBox:{[DEPT_SEND.id]:[row]}});
  try{
    await settle();const sw=t.doc().querySelector('#mailbox-switch') as any;sw.value=DEPT_SEND.id;sw.dispatchEvent(new t.w.Event('change',{bubbles:true}));await settle();
    (t.doc().querySelector('[data-open]') as any).click();await settle();
    const from=t.doc().querySelector('#c-from') as any,trash=t.doc().querySelector('#trash-draft') as any;
    from.value=PERSONAL.email;from.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(trash.disabled,true,'删除必须按已保存草稿归属，而不是待选的发件身份');
    await trash.onclick();assert.equal(t.recycled.length,0);assert.match(lastToast(t.w)?.textContent||'',/没有.*管理权限/);
  }finally{t.dispose();}
});

it('发送可用性随实际身份连接和权限变化，不借用浏览箱或本人连接',async()=>{
  const disconnected={...DEPT_SEND,connection_status:'disconnected'};
  const sendWithoutEdit={...DEPT_SEND,id:'send-no-edit',email:'send-only@example.com',rights:{...DEPT_SEND.rights,edit_draft:false}};
  const t=mount({mailboxes:[PERSONAL,disconnected,DEPT_READ_ONLY,sendWithoutEdit]});
  try{
    await settle();const sel=await openCompose(t),send=t.doc().querySelector('#c-send') as any;
    assert.equal(send.disabled,false);
    sel.value=disconnected.email;sel.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(send.disabled,true,'所选部门箱未连接，不能借用个人箱已连接状态');
    sel.value=PERSONAL.email;sel.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(send.disabled,false,'切回已连接的获权身份应恢复');
    sel.value=sendWithoutEdit.email;sel.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(send.disabled,true,'只有代发权、没有草稿编辑权时不能越过发送前保存');
    const forged=t.doc().createElement('option');forged.value=DEPT_READ_ONLY.email;forged.dataset.mailbox=DEPT_READ_ONLY.id;sel.append(forged);sel.value=forged.value;sel.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(send.disabled,true,'伪造只读身份选项不能借用个人箱权限');
    (t.doc().querySelector('#c-subject') as any).value='有主题';(t.doc().querySelector('#c-to') as any).value='customer@example.com';
    await send.onclick();assert.match(lastToast(t.w)?.textContent||'',/没有代发权限/);assert.equal(t.saved.length,0,'即使绕过disabled直接触发处理器，也不得先保存或发送');
    forged.dataset.mailbox='unknown-mailbox';sel.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.equal(send.disabled,true,'未知身份不能放行');
    assert.equal(t.sent.length,0);
  }finally{t.dispose();}
  const unbound=mount({mailboxes:[PERSONAL,DEPT_SEND],accountConnected:false});
  try{
    await settle();const sel=await openCompose(unbound);sel.value=DEPT_SEND.email;sel.dispatchEvent(new unbound.w.Event('change',{bubbles:true}));
    assert.equal((unbound.doc().querySelector('#c-send') as any).disabled,false,'获权部门箱已连接，不应被本人账号断线误禁用');
    assert.equal(unbound.sent.length,0);
  }finally{unbound.dispose();}
});

it('I2 没代发权的箱不出现在下拉里（能读不等于能发）', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_SEND, DEPT_READ_ONLY]});
  try {
    await settle();
    const sel = await openCompose(t);
    const text = sel.textContent || '';
    assert.ok(!text.includes('cs@lingeringtek.cn'),
      `只读授权的箱不该出现在发件身份下拉里（能读不等于能发），实际：${text}`);
    assert.ok(text.includes('dept@lingeringtek.cn'),
      `有代发权的箱该还在，不能一刀切收掉，实际：${text}`);
  } finally { t.dispose(); }
});

it('I3 选哪个用哪个 —— 选了部门箱，保存草稿就带那个邮箱编号', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_SEND]});
  try {
    await settle();
    const sel = await openCompose(t);
    // 选部门箱
    sel.value = 'dept@lingeringtek.cn';
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();

    // 填点内容，让草稿不被「空草稿不保存」拦下
    const set = (el: any, v: string) => {
      Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? t.w.HTMLTextAreaElement.prototype : t.w.HTMLInputElement.prototype,
        'value')!.set!.call(el, v);
      el.dispatchEvent(new t.w.Event('input', {bubbles: true}));
      el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    };
    set(t.doc().querySelector('#c-subject'), '用部门身份写的一封');
    set(t.doc().querySelector('#c-body'), '正文');

    // Ctrl/⌘S 手存（产品已去掉「存草稿」按钮，手存是留下的入口）
    t.doc().querySelector('#detail')!.dispatchEvent(
      new t.w.KeyboardEvent('keydown', {key: 's', metaKey: true, bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 500));

    assert.ok(t.saved.length > 0, '应当真存一次草稿');
    const payload = t.saved[t.saved.length - 1].payload;
    assert.equal(payload.mailbox, DEPT_SEND.id,
      `选了部门箱，保存草稿就该带上那个邮箱编号，实际 mailbox=${JSON.stringify(payload.mailbox)}`);
    const trash=t.doc().querySelector('#trash-draft') as any;
    assert.equal(trash.disabled,true,'正式归属已是无manage的部门箱，不能借浏览中个人箱权限删除');
    await trash.onclick();assert.equal(t.recycled.length,0);
  } finally { t.dispose(); }
});

/* ── BASE967-18 后半（UI067 反例形状）：预览发件身份 ≠ 实际 From ─────────────
   源文原话：「预览From为个人箱、MIME为实际捕获地址……根因仍应追预览发件身份取值」。
   形状：草稿**住在共享箱**（mailbox_id=共享箱），打开它点发送 —— 核对里的
   「发件身份」必须是**草稿所住箱的地址**，不许是登录人个人邮箱。

   测试通过 = 共享箱草稿打开后写信窗发件身份=箱地址，发送核对「发件身份」也=箱地址，
   且不出现个人邮箱当发件人。 */
it('UI067 形状：共享箱草稿的发送核对发件身份是箱地址，不是个人账号', async () => {
  const row = {name: 'dept-draft', mailbox_id: DEPT_SEND.id, status: 'Draft', record_version: 1,
    from_address: '', to: ['customer@example.com'], cc: [], subject: '共享箱草稿', body: '正文',
    body_format: 'Text', attachments: []};
  const t = mount({mailboxes: [PERSONAL, DEPT_SEND], rowsByBox: {[DEPT_SEND.id]: [row]}});
  try {
    await settle();
    const sw = t.doc().querySelector('#mailbox-switch') as any;
    sw.value = DEPT_SEND.id; sw.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await settle();
    (t.doc().querySelector('[data-open]') as any).click();
    await settle();
    const from = t.doc().querySelector('#c-from') as any;
    assert.ok(from, '共享箱草稿（有编辑权）该直接开写信窗');
    assert.equal(from.value, DEPT_SEND.email,
      `草稿住在共享箱，写信窗发件身份该是箱地址 ${DEPT_SEND.email}，实际 ${from.value}（BASE967-18 预览From取值）`);
    (t.doc().querySelector('#c-send') as any).click();
    await settle();
    const ok = t.doc().querySelector('#send-ok') as any;
    assert.ok(ok, '点发送该进核对，不能直接发');
    const dlg = ok.closest('.os-dialog, .modal, dialog, body') as any;
    const fromLine = [...dlg.querySelectorAll('dt')].find((dt: any) => dt.textContent === '发件身份')?.nextElementSibling;
    assert.ok(fromLine, `核对里该有「发件身份」行，实际：${(dlg.textContent || '').slice(0, 120)}`);
    assert.match(fromLine.textContent || '', new RegExp(DEPT_SEND.email.replace(/[.@]/g, '\\$&')),
      `核对的发件身份该是草稿所住箱的地址 ${DEPT_SEND.email}，实际 ${fromLine.textContent}`);
    assert.ok(!(fromLine.textContent || '').includes('me@qq.com'),
      `核对的发件身份不许是登录人个人邮箱（UI067：预览From与实际From不一致），实际 ${fromLine.textContent}`);
  } finally { t.dispose(); }
});

/* UI067 反例的另一半：草稿的家箱**不在身份目录里**（无权看目录/隔离箱）——
   预览 From 也不许默认退回登录人个人邮箱。worker 实际按草稿 mailbox_id 发，
   预览显示个人邮箱就是「预览与实际 From 不一致」，还可能把草稿顺手存去个人箱。
   测试通过 = 这种草稿打开后发件身份不是个人邮箱，且发送维持禁用（fail-closed）。 */
it('家箱不在身份目录的草稿：不默认个人身份，发送禁用', async () => {
  const row = {name: 'ghost-draft', mailbox_id: 'box-ghost', status: 'Draft', record_version: 1,
    from_address: '', to: ['customer@example.com'], cc: [], subject: '隔离箱草稿', body: '正文',
    body_format: 'Text', attachments: []};
  const t = mount({mailboxes: [PERSONAL], rowsByBox: {[PERSONAL.id]: [row]}});
  try {
    await settle();
    /* 初载与邮箱目录加载有先后 —— 换一下范围触发重查（同 158 用例的做法） */
    const scope = t.doc().querySelector('#mail-box') as any;
    scope.value = 'inbox'; scope.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await settle();
    for (let i = 0; i < 30; i++) {
      if (t.doc().querySelector('[data-open]')) break;
      await tick();
    }
    (t.doc().querySelector('[data-open]') as any).click();
    await settle();
    const from = t.doc().querySelector('#c-from') as any;
    assert.ok(from, '草稿该开写信窗');
    assert.notEqual(from.value, 'me@qq.com',
      `草稿家箱是 box-ghost，发件身份不许默认成个人邮箱（BASE967-18 预览From取值），实际 ${from.value}`);
    const send = t.doc().querySelector('#c-send') as any;
    assert.equal(send.disabled, true,
      `家箱不在身份目录、无获权身份时发送该禁用，实际 disabled=${send.disabled} title=${send.title}`);
  } finally { t.dispose(); }
});
it('未绑定本人从只读共享信回复仍是本人草稿，不自动借其他可发送共享身份',async()=>{
 const row={name:'readonly-received',mailbox_id:DEPT_READ_ONLY.id,status:'Received',record_version:1,from_address:'customer@example.invalid',to:[DEPT_READ_ONLY.email],cc:[],subject:'合成来信',body:'内容',body_format:'Text',attachments:[]};
 const t=mount({mailboxes:[DEPT_READ_ONLY,DEPT_SEND],accountConnected:false,accountBound:false,rowsByBox:{[DEPT_READ_ONLY.id]:[row]}});
 try{await settle();const sw=t.doc().querySelector('#mailbox-switch') as any;sw.value=DEPT_READ_ONLY.id;sw.dispatchEvent(new t.w.Event('change',{bubbles:true}));await settle();(t.doc().querySelector('[data-open]') as any).click();await settle();(t.doc().querySelector('#reply') as any).click();await settle();const from=t.doc().querySelector('#c-from') as any;assert.equal(from.selectedOptions[0].getAttribute('data-mailbox'),'');assert.equal((t.doc().querySelector('#c-send') as any).disabled,true);assert.equal(sw.value,DEPT_READ_ONLY.id);assert.equal(t.sent.length,0);}
 finally{t.dispose()}
});

it('未绑定本人可同步获权只读共享箱，发送和管理权不随同步扩大',async()=>{
 const t=mount({mailboxes:[DEPT_READ_ONLY],accountConnected:false,accountBound:false});
 try{await settle();const sw=t.doc().querySelector('#mailbox-switch') as any;sw.value=DEPT_READ_ONLY.id;sw.dispatchEvent(new t.w.Event('change',{bubbles:true}));await settle();const b=t.doc().querySelector('#mail-sync') as any;assert.equal(b.disabled,false);b.click();await settle();assert.deepEqual(t.synced,[{mailbox_id:DEPT_READ_ONLY.id}]);assert.equal((t.doc().querySelector('#compose') as any).disabled,true);assert.equal((t.doc().querySelector('#access-btn') as any).disabled,true);assert.equal(t.sent.length,0);}
 finally{t.dispose()}
});
