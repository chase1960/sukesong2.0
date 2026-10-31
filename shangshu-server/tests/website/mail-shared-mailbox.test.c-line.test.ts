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

function mount(opts: {mailboxes: any[]; rowsByBox?: Record<string, any[]>}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const queried: any[] = [];
  // 请求里的「一页取几封」另存一份 —— **不动 queried 的形状**，
  // 现有断言都是拿它比 filters，多塞字段会把那些用例弄坏。
  const queriedPageLength: string[] = [];
  const rowsByBox = opts.rowsByBox || {};
  w.fetch = async (url: string, options: any = {}) => {
    const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                        text: async () => JSON.stringify(payload)});
    if (url.includes('/services/mail.mailboxes/')) {
      return respond({result: {mailboxes: opts.mailboxes}});
    }
    if (url.includes('/services/mail.account.status/')) {
      const first = opts.mailboxes[0] || PERSONAL;
      return respond({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: first.email, display_name: first.display_name,
        signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/datasets/')) {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const filters = JSON.parse(params.get('filters') || '{}');
      queried.push(filters);
      // 「一页取几封」按**请求里真发的值**回显 —— 回包若写死 30，
      // 就会把「请求其实是 30」这件事盖住（mock 掩盖真实请求，是假绿温床）。
      const asked = params.get('page_length') || '';
      queriedPageLength.push(asked);
      const rows = rowsByBox[filters.mailbox || ''] || [];
      return respond({rows, total: rows.length, page: 1, page_length: Number(asked) || 0});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, queried, queriedPageLength, doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
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

/**
 * S6 「一页取几封」对齐验收标准的**首屏 50 封**
 *
 * **测试通过 = 什么成立**：
 *   邮件列表发出去的查询里，`page_length` 是 **50**，不是 30 ——
 *   打开 `http://127.0.0.1:3830` → 邮箱，一屏能看到 50 封，和
 *   `fde/开发/计划/执行计划.md:775` 的实施门槛「首屏 50 封」一致。
 *
 * **为什么改这条**：用户 2026-10-15 原话「**邮件那一条按照标准改吧**」。
 *   标准写 50、产品发 30，两个对不上。拍板结果是**按标准改产品**，不是改门槛。
 *
 * **改之前**：请求 `page_length=30`，一屏 30 封
 * **改之后**：请求 `page_length=50`，一屏 50 封
 * **怎么看**：`http://127.0.0.1:3830` → 邮箱 → 数列表一屏几行；
 *   或 F12 抓 `/datasets/mail.message/records` 看 `page_length`
 *
 * ⚠️ 回包按**请求真发的值**回显（不写死 30）——
 *    回包写死会把「请求其实是 30」盖住，是 mock 掩盖真实请求的假绿温床。
 */
it('S6 列表一页取 50 封（对齐验收标准的「首屏 50」）', async () => {
  const t = mount({mailboxes: [PERSONAL, DEPT_READ_ONLY]});
  try {
    await settle(t);
    assert.ok(t.queriedPageLength.length > 0,
      '一次列表查询都没发出去 —— 判据无从谈起（不许空过）');
    for (const [i, asked] of t.queriedPageLength.entries()) {
      assert.strictEqual(asked, '50',
        `第 ${i + 1} 次列表查询的「一页取几封」应为 50（验收标准「首屏 50 封」），实际是 ${asked}`);
    }
  } finally { t.dispose(); }
});
