import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 2026-10-13 扫同类问题扫出来的三条尾巴（用户：「做完啊」）：

   6. 真实模式把**筛选框整个隐藏禁用**；「带附件」筛选没有任何服务端参数
      —— 又一个「看似可用但不落库」的假入口。
   8. 前端净化器删 `<form>` 时**连子树一起删**，里面的说明文字（退订句等）
      无提示消失。
   9. 收件人解析用尖括号计数器，一个地址缺 `>` 就让**后面所有地址**一起并进
      同一个 token，全报「无法识别」。

 测试通过 = 下面全部成立：

   A. 真实模式筛选框**看得见、能用**（不是隐藏禁用）
   B. 筛选「带附件」时请求里**真的带了**这个筛选，后端知道要筛
   C. `<form>` 只去掉标签，**里面的字还在**
   D. 一个地址缺 `>`，后面那个地址照样单独认出来，不被一起拖下水
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const seed = (over: any = {}) => ({
  name: 'm-1', status: 'Received', subject: '一封信',
  body_format: 'Text', body: '正文', record_version: 1,
  from_address: '对方 <other@x.example>', from_name: '',
  to: ['我 <me@qq.com>'], cc: [], attachments: [{file: 'F-1', name: '账单.pdf', size: 1024}],
  attachment_bindings: {}, inline_resources: [], owner: 'me@qq.com',
  modified: '2026-10-13 10:00:00', message_id: '<m1@x>', date: '2026-10-13 09:00',
  reply_to_address: '', read_at: '', unread: true,
  ...over,
});

function mount(rows: any[]) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const seen: string[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    seen.push(String(url));
    const body = options?.body ? JSON.parse(options.body) : {};
    if (url.includes('/services/mail.account.status/')) {
      const a = {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我'};
      return {ok: true, status: 200, json: async () => ({result: {account: a}}),
        text: async () => JSON.stringify({result: {account: a}})};
    }
    if (url.includes('/services/mail.detail/')) {
      const found = rows.find((r: any) => r.name === (body?.payload || body)?.mail) || rows[0] || {};
      return {ok: true, status: 200, json: async () => ({result: {mail: found}}),
        text: async () => JSON.stringify({result: {mail: found}})};
    }
    if (url.includes('/api/platform/file-content')) {
      return {ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8),
        json: async () => ({}), text: async () => ''};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length, attachment_capability: 'fixed_references_v2',
        transport_capability: 'smtp_imap_v1'};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    return {ok: true, status: 200, json: async () => ({result: {}}), text: async () => ''};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, doc: () => w.document, seen, dispose: () => { dispose(); dom.window.close(); }};
}

it('A 真实模式筛选框看得见、能用（不是隐藏禁用）', async () => {
  const t = mount([seed()]);
  try {
    await tick(); await tick(); await tick();
    const filter = t.doc().querySelector('#filter') as any;
    assert.ok(filter, '真实模式没有筛选框');
    assert.equal(filter.hidden, false, '筛选框被隐藏了');
    assert.equal(filter.disabled, false, '筛选框被禁用了');
  } finally { t.dispose(); }
});

it('B 筛选「带附件」时请求里真的带了这个筛选', async () => {
  const t = mount([seed()]);
  try {
    await tick(); await tick(); await tick();
    const filter = t.doc().querySelector('#filter') as any;
    const opt = [...filter.options].find((o: any) => o.value === 'attach');
    assert.ok(opt, '筛选框里没有「带附件」这一项');

    filter.value = 'attach';
    filter.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick(); await tick(); await tick();

    const listCalls = t.seen.filter((s: string) => s.includes('/datasets/'));
    assert.ok(listCalls.length, '筛选后没有发起列表请求');
    const decoded = decodeURIComponent(listCalls[listCalls.length - 1]);
    assert.match(decoded, /attach|attachment/,
        `筛选「带附件」后请求里没带附件筛选 —— 后端不知道要筛，会把全部信吐回来：${decoded.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('C <form> 只去掉标签，里面的字还在', () => {
  /* 用户视角：从网页复制内容粘进正文，里面有段「如需退订请点击…」写在 <form> 里。
     现在 <form> 连子树一起 remove()，那句话**无提示消失**。 */
  const dom = new JSDOM('<div id="x"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.fetch = async () => ({ok: true, status: 200, json: async () => ({}), text: async () => ''});
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const editor = w.mailEditor;
  assert.ok(editor, '没拿到 mailEditor');

  const src = '<p>正文在前</p><form action="https://x"><div>如需退订请点击这里</div></form><p>正文在后</p>';
  const out = editor.safeFragment(src);
  assert.match(out, /如需退订请点击这里/,
      `<form> 里的字被连同标签一起删了：${out}`);
  assert.ok(!/<form/i.test(out), `<form> 标签没去掉：${out}`);
  assert.match(out, /正文在前/, `form 之前的字也没了：${out}`);
  assert.match(out, /正文在后/, `form 之后的字也没了：${out}`);
  dom.window.close();
});

it('D 一个地址缺 >，后面那个地址照样单独认出来', () => {
  /* 用户视角：粘一串收件人 `a@b.com, 张三 <zhang@a.com, 李四 <li@b.com>`
     —— 第二个地址少写了 `>`。现在尖括号计数器从此卡住，后面整串并成一个 token，
     全报「有无法识别的地址」，只能手工拆。 */
  const src = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');
  // 把 EMAIL / cleanAddress / parseRecipients **一起**抽出来跑 ——
  // 只抽 parseRecipients 会因为作用域缺依赖而假红。
  const slice = /const EMAIL =[\s\S]*?function parseRecipients\([\s\S]*?\n  \}/.exec(src);
  assert.ok(slice, '找不到 EMAIL / cleanAddress / parseRecipients 这一段');

  const dom = new JSDOM('<div id="x"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  const parsed = w.eval(`(() => { ${slice![0]}; return JSON.stringify(parseRecipients('a@b.com, 张三 <zhang@a.com, 李四 <li@b.com>')); })()`);
  const result = JSON.parse(String(parsed));
  const addrs = result.list.map((x: any) => x.addr);
  assert.ok(addrs.includes('a@b.com'), `第一个地址没认出来：${JSON.stringify(result)}`);
  assert.ok(addrs.includes('li@b.com'),
      `第二个地址缺 > 就把**后面**那个也拖下水了，只能手工拆。实际：${JSON.stringify(result)}`);
  dom.window.close();
});
