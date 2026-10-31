import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 邮箱权限的**设置那一半** —— 执行计划 PKG-006-T05 / N5-5、用户 2026-10-13 给 C 的表：

   「邮箱权限」分开控制阅读、编辑草稿、代发、邮箱配置及签名管理；
    能读不等于能发。用部门邮箱发信，仍记录实际操作员工

 计划原文（PKG-006-T05 的通过判据）：
   「**设置页由有权者选邮箱和成员、逐项配置权限**」

 后端那一半已经交付并测过（`test-mail-n5-shared-mailbox.py` 21/21，
 提交 5ec585dd）：`Shangshu Mail Access` 五项分开、`mail.mailbox.grant/revoke`、
 `rights_for` 逐项判。**但界面上没有任何地方能配权限** —— 只能走接口。
 这条补的是那一半。

 先写测试再实现（CLAUDE.md 一）。没实现前这段是红的，那是**对的**。

   测试通过 = 下面全部成立：

   A1. 有**管理权**才有「权限」入口；当前箱没管理权 → 入口不给用，并说明为什么
   A2. 弹窗列出当前箱的已授权成员，每人**五项分开勾**
       （不是「有权限/没权限」一个开关）
   A3. 改完保存 → 走 `mail.mailbox.grant`，邮箱 / 员工 / 五项都对得上
   A4. **五项互不连带** —— 只勾阅读，保存时代发/管理等都是关的
       （能读≠能发，不能由一项推出另一项）
   A5. 能**加新成员** —— 填用户名保存 → 走 `mail.mailbox.grant` 授权那个人
   A6. 一个人全部取消勾 → 走 `mail.mailbox.revoke`（收回），不是 grant 一个全 false
   A7. 没管理权的箱上，弹窗**不给开**（后端也拒，这里只管前端不提供入口）
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const RIGHTS = ['read', 'edit_draft', 'send', 'manage', 'signature'] as const;

const PERSONAL = {id: 'box-personal', kind: 'personal', department: '', email: 'me@qq.com',
                  display_name: '我', enabled: true, connection_status: 'connected',
                  rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT_ADMIN = {id: 'box-dept', kind: 'department', department: '交付部',
                    email: 'dept@lingeringtek.cn', display_name: '交付部公共邮箱',
                    enabled: true, connection_status: 'connected',
                    rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}};
const DEPT_READ_ONLY = {...DEPT_ADMIN, id: 'box-dept-ro',
                        rights: {read: true, edit_draft: false, send: false, manage: false, signature: false}};

/** 已授权成员：每人五项各是各的。 */
const GRANTEES = [
  {user: 'zhang@shangshu.local', read: true, edit_draft: true, send: true, manage: false, signature: true},
  {user: 'li@shangshu.local', read: true, edit_draft: false, send: false, manage: false, signature: false},
];

function mount(opts: {mailboxes: any[]; grantees?: any[]}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const granted: any[] = [];
  const revoked: any[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                        text: async () => JSON.stringify(payload)});
    if (url.includes('/services/mail.mailboxes/')) {
      return respond({result: {mailboxes: opts.mailboxes.map(m => (
        m.rights && m.rights.manage ? {...m, grantees: opts.grantees || []} : m))}});
    }
    if (url.includes('/services/mail.account.status/')) {
      const first = opts.mailboxes[0] || PERSONAL;
      return respond({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: first.email, display_name: first.display_name,
        signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/datasets/')) {
      return respond({rows: [], total: 0, page: 1, page_length: 30});
    }
    if (url.includes('/actions/mail.mailbox.grant/execute')) {
      granted.push(body.payload);
      return respond({result: body.payload});
    }
    if (url.includes('/actions/mail.mailbox.revoke/execute')) {
      revoked.push(body.payload);
      return respond({result: body.payload});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, granted, revoked,
          doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async () => { await tick(); await tick(); await tick(); };

/** 权限入口。 */
function accessBtn(t: ReturnType<typeof mount>) {
  return t.doc().querySelector('#access-btn, [data-access-btn]') as any;
}

/** 打开弹窗，返回弹窗元素（找不到就断言失败）。 */
async function openAccess(t: ReturnType<typeof mount>) {
  const btn = accessBtn(t);
  assert.ok(btn, '找不到权限入口（设置页由有权者逐项配置权限）');
  assert.ok(!btn.disabled, `权限入口应该是可用的，实际 disabled=${btn.disabled} title=${btn.title}`);
  btn.click();
  await tick(); await tick();
  const dlg = t.doc().querySelector('dialog, .os-dialog, [role=dialog], .modal, .dlg') as any;
  assert.ok(dlg, '点权限入口应当弹出设置弹窗');
  return dlg;
}

it('A1 有管理权才有权限入口；没管理权不给用并说明原因', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_READ_ONLY]});
  try {
    await settle();
    // 先在有管理权的个人箱上：入口该是可用的
    const btn = accessBtn(t);
    assert.ok(btn, '找不到权限入口');
    assert.ok(!btn.disabled, `有管理权时权限入口该可用，实际 disabled=${btn.disabled}`);

    // 切到只读授权的部门箱：入口该收起来
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    assert.ok(sel, '找不到邮箱切换器');
    sel.value = DEPT_READ_ONLY.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const after = accessBtn(t);
    assert.ok(after.disabled,
      `没管理权就不该给权限入口，实际 disabled=${after.disabled}`);
    assert.ok(/管理|权限/.test(after.title || ''),
      `禁用时要说清为什么，实际 title=${JSON.stringify(after.title)}`);
  } finally { t.dispose(); }
});

it('A2 弹窗列出已授权成员，每人五项分开勾', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_ADMIN], grantees: GRANTEES});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_ADMIN.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const dlg = await openAccess(t);
    const text = dlg.textContent || '';
    assert.ok(text.includes('zhang@shangshu.local'), `弹窗该列出已授权成员，实际：${text.slice(0, 200)}`);
    assert.ok(text.includes('li@shangshu.local'), `弹窗该列出全部已授权成员，实际：${text.slice(0, 200)}`);

    // 每人五项**分开**的勾，不是「有权限」一个开关
    const boxes = [...dlg.querySelectorAll('input[type=checkbox]')] as any[];
    assert.ok(boxes.length >= RIGHTS.length,
      `至少要有五项分开的勾（${RIGHTS.join('/')}），实际只有 ${boxes.length} 个勾选框`);

    // 五项的名字要出现在弹窗里，让人知道勾的是什么
    for (const key of RIGHTS) {
      const label = ({read: '阅读', edit_draft: '草稿', send: '代发',
                      manage: '配置', signature: '签名'} as any)[key];
      assert.ok(text.includes(label),
        `五项要分开写清楚，弹窗里该有「${label}」，实际：${text.slice(0, 300)}`);
    }
  } finally { t.dispose(); }
});

it('A3 改完保存 → 走 mail.mailbox.grant，邮箱/员工/五项对得上', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_ADMIN], grantees: [GRANTEES[1]]});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_ADMIN.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const dlg = await openAccess(t);
    // 给 li 加上「代发」—— 找到 li 那一行里代表 send 的勾
    const row = [...dlg.querySelectorAll('tr, .access-row, label')]
        .find((r: any) => (r.textContent || '').includes('li@shangshu.local')) as any;
    assert.ok(row, '弹窗里该有 li 那一行');
    const sendBox = [...row.querySelectorAll('input[type=checkbox]')][2] as any;
    assert.ok(sendBox, `li 那一行该有五项分开的勾，实际 ${row.querySelectorAll('input[type=checkbox]').length} 个`);
    assert.ok(!sendBox.checked, 'li 原本不该有代发权');
    sendBox.checked = true;
    sendBox.dispatchEvent(new t.w.Event('change', {bubbles: true}));

    const save = [...dlg.querySelectorAll('button')]
        .find((b: any) => /保存|确定/.test(b.textContent || '')) as any;
    assert.ok(save, '弹窗该有保存按钮');
    save.click();
    await new Promise(r => setTimeout(r, 400));

    assert.ok(t.granted.length > 0, `保存该调 mail.mailbox.grant，实际什么都没调`);
    const g = t.granted[t.granted.length - 1];
    assert.equal(g.mailbox, DEPT_ADMIN.id, `授权的邮箱不对：${g.mailbox}`);
    assert.equal(g.user, 'li@shangshu.local', `授权的员工不对：${g.user}`);
    assert.equal(g.rights.send, true, `勾了代发就该是 true，实际 ${g.rights.send}`);
  } finally { t.dispose(); }
});

it('A4 五项互不连带 —— 只留下阅读，代发/管理等不会被顺手打开', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_ADMIN], grantees: [
    {user: 'xin@shangshu.local', read: true, edit_draft: true, send: true, manage: true, signature: true}]});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_ADMIN.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const dlg = await openAccess(t);
    // 真操作：把五项里除「阅读」之外的都去掉 —— 保存时代发/管理等必须是关的
    const row = [...dlg.querySelectorAll('tr, .access-row')]
        .find((r: any) => (r.textContent || '').includes('xin@shangshu.local')) as any;
    assert.ok(row, '弹窗里该有 xin 那一行');
    const boxes = [...row.querySelectorAll('input[type=checkbox]')] as any[];
    assert.equal(boxes.length, 5, `五项该是五个独立的勾，实际 ${boxes.length} 个`);
    // 第 0 项是「阅读」，保留；其余四项去掉
    for (const box of boxes.slice(1)) {
      if (box.checked) {
        box.checked = false;
        box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
      }
    }
    const save = [...dlg.querySelectorAll('button')]
        .find((b: any) => /保存|确定/.test(b.textContent || '')) as any;
    save.click();
    await new Promise(r => setTimeout(r, 400));

    assert.ok(t.granted.length > 0, '保存该调 mail.mailbox.grant');
    const g = t.granted[t.granted.length - 1];
    assert.equal(g.rights.read, true, '留下的「阅读」该是 true');
    for (const key of ['edit_draft', 'send', 'manage', 'signature'] as const) {
      assert.ok(!g.rights[key],
        `五项互不连带：去掉的「${key}」不能被顺手打开（能读≠能发），实际 ${g.rights[key]}`);
    }
  } finally { t.dispose(); }
});

it('A5 能加新成员 —— 填用户名保存后走 grant 授权那个人', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_ADMIN], grantees: []});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_ADMIN.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const dlg = await openAccess(t);
    const input = dlg.querySelector('input[type=text], input:not([type])') as any;
    assert.ok(input, '弹窗里该有加成员的输入框（人员接口还没到，先手动填）');
    const set = (el: any, v: string) => {
      Object.getOwnPropertyDescriptor(t.w.HTMLInputElement.prototype, 'value')!.set!.call(el, v);
      el.dispatchEvent(new t.w.Event('input', {bubbles: true}));
      el.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    };
    set(input, 'wang@shangshu.local');
    const add = [...dlg.querySelectorAll('button')]
        .find((b: any) => /加|添加|新增/.test(b.textContent || '')) as any;
    assert.ok(add, '弹窗该有「加成员」按钮');
    add.click();
    await tick();

    const save = [...dlg.querySelectorAll('button')]
        .find((b: any) => /保存|确定/.test(b.textContent || '')) as any;
    save.click();
    await new Promise(r => setTimeout(r, 400));

    assert.ok(t.granted.length > 0, '加了人就该调 mail.mailbox.grant');
    const g = t.granted[t.granted.length - 1];
    assert.equal(g.user, 'wang@shangshu.local', `新加的成员不对：${g.user}`);
  } finally { t.dispose(); }
});

it('A6 一个人全部取消勾 → 走 revoke 收回，不是 grant 一个全 false', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_ADMIN],
                   grantees: [{user: 'li@shangshu.local', read: true, edit_draft: true,
                               send: true, manage: false, signature: true}]});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_ADMIN.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const dlg = await openAccess(t);
    const row = [...dlg.querySelectorAll('tr, .access-row, label')]
        .find((r: any) => (r.textContent || '').includes('li@shangshu.local')) as any;
    assert.ok(row, '弹窗里该有 li 那一行');
    for (const box of [...row.querySelectorAll('input[type=checkbox]')] as any[]) {
      if (box.checked) {
        box.checked = false;
        box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
      }
    }
    const save = [...dlg.querySelectorAll('button')]
        .find((b: any) => /保存|确定/.test(b.textContent || '')) as any;
    save.click();
    await new Promise(r => setTimeout(r, 400));

    assert.ok(t.revoked.length > 0,
      `全取消勾该是收回权限（revoke），实际 grant=${t.granted.length} revoke=${t.revoked.length}`);
    assert.equal(t.revoked[t.revoked.length - 1].user, 'li@shangshu.local', '收回应指明是收回谁的');
  } finally { t.dispose(); }
});

it('A7 没管理权的箱上，弹窗不给开', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_READ_ONLY], grantees: GRANTEES});
  try {
    await settle();
    const sel = t.doc().querySelector('#mailbox-switch') as any;
    sel.value = DEPT_READ_ONLY.id;
    sel.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 350));

    const btn = accessBtn(t);
    assert.ok(btn, '找不到权限入口');
    // 即便有人硬点，也不该弹出可编辑的授权表
    try { btn.click(); } catch { /* disabled 的按钮点不动，也算符合 */ }
    await tick();
    const dlg = t.doc().querySelector('dialog, .os-dialog, [role=dialog], .modal, .dlg') as any;
    assert.ok(!dlg || !dlg.querySelector('input[type=checkbox]'),
      '没管理权时不该弹出可编辑的授权表');
  } finally { t.dispose(); }
});
