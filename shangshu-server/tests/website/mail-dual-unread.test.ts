import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 部门 / 个人双未读点 —— **界面那一半**。

 执行计划 #mail-next-batch「双未读标记」原话：
   「任一获授权部门成员读过即部门已读，**已读后对应点消失，
     不是换成另一种颜色**」
   「两个点须有**固定位置**和『部门未读/本人未读』**可访问说明**」

 后端已交付（test-mail-n5-dual-unread.py 25/25，提交 f0eac316）：
 读信按人记、部门已读另记、两套计数分开。
 **但界面上只有一个 `.mail-dot`** —— 两个点在页面上分不出来。

 先写测试再实现（CLAUDE.md 一）。没实现前这段是红的，那是**对的**。

   测试通过 = 下面全部成立：

   U1 一封「两人都没读」的共享来信，列表里有**两个点**
   U2 两个点各有**可访问说明**（title/aria-label 写明「本人未读」/「部门未读」）
   U3 个人箱的信**只有本人点**（没有部门点 —— 个人箱没这回事）
   U4 我读过 → **本人点消失**；部门点还在（别人还没读）
   U5 部门有人读过 → **部门点消失**，不是换个颜色留在那
   U6 两套未读数分开显示，**不相加**
*/

const tick = () => new Promise(r => setTimeout(r, 20));

type Row = Record<string, any>;

function mount(opts: {rows: Row[]; counts?: {mine: number; dept: number};liveRead?:boolean}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const rows=opts.rows.map(row=>({...row})),actions:any[]=[];let counts=opts.counts??{mine:0,dept:0};
  w.fetch = async (url: string,options:any={}) => {
    const respond = (p: any) => ({ok: true, status: 200, json: async () => p,
                                  text: async () => JSON.stringify(p)});
    if (url.includes('/services/mail.mailboxes/')) {
      return respond({result: {mailboxes: [{
        id: 'box-1', kind: 'department', department: '交付部', email: 'dept@qq.com',
        display_name: '交付部', enabled: true, connection_status: 'connected',
        rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}}]}});
    }
    if (url.includes('/services/mail.account.status/')) {
      return respond({result: {account: {bound: true, enabled: true, connection_status: 'connected',
        email: 'dept@qq.com', display_name: '交付部',
        signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/datasets/')) {
      return respond({rows: rows.map(row=>({...row})), total: rows.length, page: 1, page_length: 30,
                      unread_counts: {...counts}});
    }
    if(opts.liveRead&&url.includes('/services/mail.detail/'))return respond({result:{mail:{...rows[0],to:[],cc:[],attachments:[],body:'收到的正文'}}});
    if(opts.liveRead&&url.includes('/actions/mail.set_read/')){const payload=JSON.parse(options.body).payload;actions.push(payload);const row=rows[0];row.my_unread=!payload.read;row.unread=row.my_unread;if(payload.read)row.dept_unread=false;row.read_at=payload.read?'2026-10-15 10:00:00':'';counts={mine:row.my_unread?1:0,dept:row.dept_unread?1:0};return respond({result:{...row,to:[],cc:[],attachments:[],body:'收到的正文'}});}
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, actions, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async (t: ReturnType<typeof mount>) => { await tick(); await tick(); await tick(); };

/** 这一封信那一行里的所有「点」。 */
function dots(t: ReturnType<typeof mount>, subject: string) {
  const rows = [...t.doc().querySelectorAll('.mail-item')];
  const row = rows.find(r => (r.textContent || '').includes(subject)) as any;
  assert.ok(row, `列表里找不到「${subject}」`);
  return {row, dots: [...row.querySelectorAll('.mail-dot, [data-dot]')]};
}

const SHARED = {
  name: 'm1', subject: '部门来信样本', status: 'Received', record_version: 1,
  to_json: '[]', cc_json: '[]', from_address: '对方 <o@x.example>',
  received_at: '2026-10-13 10:00:00', read_at: '',
  my_unread: true, dept_unread: true, unread: true, mailbox_id: 'box-1',
};

it('U1/U2 共享来信有两个点，且各有可访问说明', async () => {
  const t = mount({rows: [SHARED], counts: {mine: 1, dept: 1}});
  try {
    await settle(t);
    const {dots: ds} = await dots(t, '部门来信样本');
    assert.equal(ds.length, 2, `两人都没读的共享来信该有**两个点**，实际 ${ds.length} 个`);
    const labels = ds.map((d: any) => (d.getAttribute('title') || '') + '|' + (d.getAttribute('aria-label') || ''));
    assert.ok(labels.some(l => /本人|我的|个人/.test(l)),
      `其中一个点该写明「本人未读」，实际：${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => /部门/.test(l)),
      `另一个点该写明「部门未读」，实际：${JSON.stringify(labels)}`);
  } finally { t.dispose(); }
});

it('U3 个人箱的信只有本人点（没有部门点）', async () => {
  const t = mount({rows: [{...SHARED, subject: '张三的个人来信', mailbox_id: 'box-personal',
                           my_unread: true, dept_unread: false}], counts: {mine: 1, dept: 0}});
  try {
    await settle(t);
    const {dots: ds} = await dots(t, '张三的个人来信');
    const labels = ds.map((d: any) => (d.getAttribute('title') || '') + '|' + (d.getAttribute('aria-label') || ''));
    assert.equal(ds.length, 1,
      `个人箱的信该只有**一个点**（本人未读），实际 ${ds.length} 个：${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => /部门/.test(l)) === false,
      `个人箱不该出现「部门未读」点：${JSON.stringify(labels)}`);
  } finally { t.dispose(); }
});

it('U4 我读过 → 本人点消失，部门点还在', async () => {
  const t = mount({rows: [{...SHARED, my_unread: false, dept_unread: true}], counts: {mine: 0, dept: 1}});
  try {
    await settle(t);
    const {dots: ds} = await dots(t, '部门来信样本');
    const labels = ds.map((d: any) => (d.getAttribute('title') || '') + '|' + (d.getAttribute('aria-label') || ''));
    assert.ok(!labels.some(l => /本人|我的|个人/.test(l)),
      `我读过了，本人点该**消失**（不是换个颜色），实际：${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => /部门/.test(l)),
      `别人还没读，部门点该**还在**，实际：${JSON.stringify(labels)}`);
  } finally { t.dispose(); }
});

it('U5 部门有人读过 → 部门点消失，不是换颜色留在那', async () => {
  const t = mount({rows: [{...SHARED, my_unread: false, dept_unread: false}], counts: {mine: 0, dept: 0}});
  try {
    await settle(t);
    const {row, dots: ds} = await dots(t, '部门来信样本');
    const labels = ds.map((d: any) => (d.getAttribute('title') || '') + '|' + (d.getAttribute('aria-label') || ''));
    assert.ok(!labels.some(l => /部门/.test(l)),
      `部门有人读过了，部门点该**消失**，实际：${JSON.stringify(labels)}`);
    // 也不许退化成「还留个点但换个颜色」—— 点的个数就该少一个
    assert.equal(ds.length, 0, `两个点都消了就该一个不剩，实际 ${ds.length} 个`);
    assert.ok(!row.classList.contains('is-unread'),
      '两个点都消了，这行不该再是未读样式（不许只换颜色）');
  } finally { t.dispose(); }
});

it('U6 两套未读数分开显示，不相加', async () => {
  const t = mount({rows: [SHARED], counts: {mine: 2, dept: 1}});
  try {
    await settle(t);
    const text = t.doc().querySelector('.mail-list-meta')?.textContent
              || t.doc().querySelector('.mail-list-pane')?.textContent || '';
    assert.ok(/本人|我的|个人/.test(text) && /部门/.test(text),
      `两套未读数该分别标出来，实际：${text.slice(0, 160)}`);
    // 不许出现一个孤零零的「未读 3」把两套加在一起
    assert.ok(!/未读\s*[：:]?\s*3\b/.test(text),
      `两套数不能相加（2+1≠3 封未读），实际：${text.slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('打开共享来信自动已读后两点和两计数同步消失，标未读只恢复本人点',async()=>{
 const t=mount({rows:[SHARED],counts:{mine:1,dept:1},liveRead:true});try{await settle(t);(t.doc().querySelector('[data-open]') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,160));
  assert.equal(t.actions.length,1);assert.equal(t.actions[0].read,true);assert.equal(dots(t,SHARED.subject).dots.length,0,'详情按钮更新不代表列表双点已经消除');const count=t.doc().querySelector('.mail-list-meta')?.textContent||'';assert.match(count,/本人未读\s*0/);assert.match(count,/部门未读\s*0/);
  (t.doc().querySelector('#toggle-unread') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,160));const ds=dots(t,SHARED.subject).dots;assert.equal(ds.length,1);assert.match(ds[0].getAttribute('title')||'',/本人/);const changed=t.doc().querySelector('.mail-list-meta')?.textContent||'';assert.match(changed,/本人未读\s*1/);assert.match(changed,/部门未读\s*0/);
 }finally{t.dispose();}
});
