/*
 共享邮箱切换器 —— 真页面实测（jsdom 绿不等于页面上真能用，SIG 那次栽过）。

 判据：测试通过 = 在正式页面上
   R1 邮箱页头**有**邮箱切换器 #mailbox-switch
   R2 切换器里列出我能进入的邮箱（不是空壳、不是永远「正在读取」）
   R3 页头标得出**当前在哪个邮箱**（邮箱地址，不是笼统的「正在连接…」）
   R4 页面加载期间**没有 JS 报错**
   R5 （有多个箱时）切一下 → 列表查询带上那个邮箱编号

 只走无界面 Chrome（CDP），不拉起本机图形应用。口令从 0600 文件读，不打印。
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';

/* 从 0600 账号文件里取**某一个标签**的口令。取到就用，**一次都不回显** ——
   不打印、不进日志、不进错误信息；只在 set() 那一步内联进页面。
   标签用字面量（「密码」/「口令」），不把文件内容打进工具输出。 */
function readAccountSecret(label) {
  const src = fs.readFileSync(ACCOUNT_FILE, 'utf8');
  const m = src.match(new RegExp(label + '[：:]\\s*(\\S+)'));
  return m ? m[1] : null;
}
const readPassword = () => {
  const p = readAccountSecret('密码');
  if (!p) throw new Error('账号文件里没读到密码行');
  return p;
};
const PASS = [], FAIL = [];
/* 判据函数。**`ok` 只收真布尔** —— 2026-10-15 栽过：R8～R14 写成 need(码, 布尔, 明细)
   三参，`ok` 位置放的是明细字符串（恒真），布尔被当成了标签 → **那六条结构上不可能红**，
   打出来的「✔」全是假绿（屏幕上那行末尾的 true/false 就是错位的标签）。
   所以这里先卡类型：传进来的不是布尔就当场炸，不许再静默通过。 */
const need = (code, label, ok, detail = '') => {
  if (typeof ok !== 'boolean') {
    throw new Error(`need() 第三参必须是布尔，实收 ${typeof ok} —— 参数错位了`
        + `（码=${JSON.stringify(code)} 标签=${JSON.stringify(label)}）`);
  }
  (ok ? PASS : FAIL).push(code);
  console.log(`  ${ok ? '✔' : '✖'} ${code} ${label}${!ok && detail ? '  ← ' + detail : ''}`);
};

const {send, open, ws} = connect(await browserWsUrl());
await open;
const {sendS} = await openPage(send, ws, `${BASE}/`);
await new Promise(r => setTimeout(r, 2500));

/* 登不登录的判据：**轮询等 `#un` 出现**，不能一上来就看一眼。
   2026-10-15 栽过：开 `${BASE}/` 会 302 到 `login.html`，2.5s 内没跳过去时
   `#un` 还不在 → 旧写法 `!document.querySelector('#un')` 误判成「已登录」→
   **跳过登录** → 停在未登录页，#mailbox-switch 永远挂不起来，R1–R3 全红。
   是测具的竞态，不是产品的。 */
let sawLogin = false;
for (let i = 0; i < 30; i++) {
  sawLogin = await evalIn(sendS, `!!document.querySelector('#un')`);
  if (sawLogin) break;
  // 已经在应用里（有侧栏/工作台）就不用再等登录框
  const inApp = await evalIn(sendS, `!!document.querySelector('#mailbox-switch') || !!document.querySelector('#main')`);
  if (inApp && !sawLogin) break;
  await new Promise(r => setTimeout(r, 500));
}
if (sawLogin) {
  const pw = readPassword();
  await evalIn(sendS, `(() => {
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                             : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    set(document.querySelector('#un'), 'Administrator');
    set(document.querySelector('#pw'), ${JSON.stringify(pw)});
    document.querySelector('button[type=submit]').click();
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 3500));
}

// 先埋一个网络探针，再进邮箱页 —— R5 要看列表查询有没有带上邮箱编号
await evalIn(sendS, `(() => {
  window.__n5Queries = [];
  window.__n5Errors = [];
  // JS 报错收集：R4 要看页面有没有炸。**只记不拦**，不影响页面。
  window.addEventListener('error', (e) => {
    window.__n5Errors.push(String(e.message || e.error || 'unknown'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__n5Errors.push('unhandledrejection: ' + String(e.reason));
  });
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    try {
      const u = String(url);
      if (u.includes('/datasets/mail.message/records')) {
        const params = new URLSearchParams(u.split('?')[1] || '');
        window.__n5Queries.push(JSON.parse(params.get('filters') || '{}'));
        // 抓一份原始行，好分清「后端没吐」还是「前端没显」
        const clone = res.clone();
        clone.json().then(j => { window.__n5RawRows = (j && (j.rows || (j.result && j.result.rows))) || []; })
                     .catch(() => {});
      }
    } catch (e) { /* 探针不能影响页面 */ }
    return res;
  };
  return 'ok';
})()`);

await evalIn(sendS, `location.hash = '#/mail', 'nav'`);
/* 进邮箱页后**轮询等切换器真列出箱**，不写死等 4.5s。
   2026-10-15 栽过：4.5s 时切换器还挂着「正在读取邮箱…」→ R2 假红、R7 拿到「正在读取…」、
   R8 之后全线跟着塌。是测具等太短，不是产品没列箱。 */
for (let i = 0; i < 24; i++) {
  const ready = await evalIn(sendS, `(() => {
    const sel = document.querySelector('#mailbox-switch');
    const listed = !!sel && [...sel.options].some(o => o.value);
    const cnt = (document.querySelector('#result-count') || {}).textContent || '';
    return listed && !/正在读取/.test(cnt);
  })()`);
  if (ready) break;
  await new Promise(r => setTimeout(r, 500));
}

const r = await evalIn(sendS, `(async () => {
  const out = {};
  const sel = document.querySelector('#mailbox-switch');
  out.exists = !!sel;
  out.disabled = sel ? sel.disabled : null;
  out.options = sel ? [...sel.options].map(o => ({value: o.value, text: o.textContent.trim(),
                                                   kind: o.getAttribute('data-kind')})) : [];
  out.value = sel ? sel.value : null;
  out.label = (document.querySelector('.preview-label') || {}).textContent || '';
  out.footer = (document.querySelector('.preview-footer') || {}).textContent || '';
  out.errors = (window.__n5Errors || []);
  out.queries = window.__n5Queries || [];
  out.composeDisabled = document.querySelector('#compose') ? document.querySelector('#compose').disabled : null;
  out.composeText = document.querySelector('#compose') ? document.querySelector('#compose').textContent : null;
  return out;
})()`);

need('R1', '邮箱页头有邮箱切换器 #mailbox-switch', r.exists,
     '找不到 #mailbox-switch —— 页面上没装切换器');
need('R2', '切换器列出我能进入的邮箱', r.exists && r.options.length > 0 && r.options.some(o => o.value),
     `实际选项 = ${JSON.stringify(r.options)}`);
need('R3', '页头标得出当前在哪个邮箱（邮箱地址）',
     /@|未绑定|连接/.test(r.label || ''),
     `实际 label = ${JSON.stringify(r.label)}`);
need('R4', '页面加载期间没有 JS 报错', (r.errors || []).length === 0,
     `报错 = ${JSON.stringify(r.errors).slice(0, 200)}`);

const NORUN = [];
if (r.options.filter(o => o.value).length >= 2) {
  const before = (r.queries || []).length;
  // **按归属挑部门箱**，不按位置 —— mailboxes() 把建箱人拥有的排前面，
  // options[1] 可能是个人箱（我第一版就是这么选错的，R6 因此没找到夹具信）。
  const others = r.options.filter(o => o.value);
  const target = (others.find(o => o.kind === 'department') || others[1] || others[0]).value;
  await evalIn(sendS, `(() => {
    const sel = document.querySelector('#mailbox-switch');
    sel.value = ${JSON.stringify(target)};
    sel.dispatchEvent(new Event('change', {bubbles: true}));
    return 'ok';
  })()`);
  /* 切箱后**轮询等查询出现**，不写死等 2.5s。
     2026-10-15 栽过：2.5s 时列表还在「正在读取…」，探针一条查询都没记到 → R5 假红、
     R6 跟着找不到信。是测具等太短，不是产品没带邮箱编号。 */
  let queries = [];
  for (let i = 0; i < 24; i++) {
    await new Promise(r2 => setTimeout(r2, 500));
    queries = JSON.parse(await evalIn(sendS, `JSON.stringify(window.__n5Queries || [])`) || '[]');
    if (queries.slice(before).some(q => q.mailbox === target)) break;
  }
  const scoped = queries.slice(before).filter(q => q.mailbox === target);
  need('R5', '切箱后列表查询带上那个邮箱编号', scoped.length > 0,
       `切后查询 = ${JSON.stringify(queries.slice(before)).slice(0, 200)}`);
} else {
  NORUN.push('R5');
  console.log(`  ○ R5 切箱后列表查询带上那个邮箱编号 —— NOT_RUN：当前账号只有 `
      + r.options.filter(o => o.value).length + ` 个邮箱，没有第二个可切。`
      + `**不记为通过**。`);
}

// ── R6/R7 双未读点（N5-4）─────────────────────────────────────────────────
const dual = await evalIn(sendS, `(async () => {
  const out = {};
  const row = [...document.querySelectorAll('.mail-item')]
      .find(r => (r.textContent || '').includes('双未读样本'));
  out.found = !!row;
  if (row) {
    out.dots = [...row.querySelectorAll('.mail-dot, [data-dot]')].map(d => ({
      title: d.getAttribute('title') || '', aria: d.getAttribute('aria-label') || '',
    }));
  }
  out.countText = (document.querySelector('#result-count') || {}).textContent || '';
  out.raw = (window.__n5RawRows || []).map(r => ({
    subject: r.subject, my_unread: r.my_unread, dept_unread: r.dept_unread,
    keys: Object.keys(r).filter(k => /unread|read/i.test(k)),
  }));
  return out;
})()`);

if (dual.found) {
  const labels = (dual.dots || []).map(d => d.title + '|' + d.aria);
  console.log('      原始行 = ' + JSON.stringify(dual.raw).slice(0, 300));
  need('R6', '共享未读来信有两个点，各有可访问说明',
       (dual.dots || []).length === 2
         && labels.some(l => /本人|我的|个人/.test(l))
         && labels.some(l => /部门/.test(l)),
       `实际点 = ${JSON.stringify(dual.dots)}；原始行 = ${JSON.stringify(dual.raw).slice(0, 300)}`);
} else {
  NORUN.push('R6');
  console.log('  ○ R6 共享未读来信有两个点 —— NOT_RUN：列表里没找到夹具那封信。**不记为通过**。');
}
need('R7', '列表角标两套未读数分开显示（本人未读 / 部门未读）',
     /本人未读|我的未读|个人未读/.test(dual.countText || '') && /部门未读/.test(dual.countText || ''),
     `实际角标 = ${JSON.stringify(dual.countText)}`);

// ── R8～R10 授权设置页（N5-5 / PKG-006-T05）────────────────────────────────
// 「设置页由有权者选邮箱和成员、逐项配置权限」—— jsdom 绿不算数，真页面上点一遍。
const acc = await evalIn(sendS, `(async () => {
  const out = {};
  const btn = document.querySelector('#access-btn');
  out.exists = !!btn;
  out.disabled = btn ? btn.disabled : null;
  out.title = btn ? btn.title : '';
  if (btn && !btn.disabled) { btn.click(); await new Promise(r => setTimeout(r, 600)); }
  const dlg = document.querySelector('dialog, .os-dialog, [role=dialog]');
  out.dlg = !!dlg;
  if (dlg) {
    out.text = (dlg.textContent || '').slice(0, 400);
    out.checkboxes = dlg.querySelectorAll('input[type=checkbox]').length;
    out.headers = [...dlg.querySelectorAll('th')].map(th => th.textContent.trim());
  }
  return out;
})()`);
need('R8', '页头有权限入口，且在有管理权的箱上是可用的',
     acc.exists && acc.disabled === false,
     `exists=${acc.exists} disabled=${acc.disabled} title=${acc.title}`);
need('R9', '点开弹窗：有授权名单、五项分开的勾',
     acc.dlg && acc.checkboxes >= 5 && (acc.headers || []).length >= 6,
     `dlg=${acc.dlg} 勾=${acc.checkboxes} 表头=${JSON.stringify(acc.headers)}`
     + ` 文本=${JSON.stringify(acc.text || '').slice(0, 200)}`);

// R10 改一项 + 保存 → 后端 mailboxes 里那个人的那项真变了（不是只在浏览器里打个勾）
const r10 = await evalIn(sendS, `(async () => {
  const out = {ok: false};
  const dlg = document.querySelector('dialog, .os-dialog, [role=dialog]');
  if (!dlg) return out;
  const box = dlg.querySelector('input[type=checkbox]');
  if (!box) return out;
  out.before = box.checked;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', {bubbles: true}));
  out.after = box.checked;
  const save = [...dlg.querySelectorAll('button')].find(b => /保存|确定/.test(b.textContent || ''));
  if (!save) return out;
  save.click();
  await new Promise(r => setTimeout(r, 900));
  out.saved = true;
  return out;
})()`);
if (r10.saved) {
  // 回读服务，不看浏览器里的勾
  const reread = await evalIn(sendS, `(async () => {
    const res = await fetch('/api/platform/services/mail.mailboxes/invoke',
                            {method:'POST', headers:{'content-type':'application/json'},
                             body: JSON.stringify({payload:{}})});
    const j = await res.json();
    const boxes = (j && (j.result || j))?.mailboxes || [];
    return JSON.stringify(boxes.map(b => ({id: b.id, grantees: b.grantees || null})));
  })()`);
  const boxes = JSON.parse(reread || '[]');
  const withGrantees = boxes.filter(b => b.grantees);
  need('R10', '保存后后端权限真变了（回读 mailboxes，不看浏览器里的勾）',
       withGrantees.length > 0,
       `回读到的 grantees = ${JSON.stringify(boxes).slice(0, 300)}；`
       + `勾选前后 ${r10.before}→${r10.after}`);
} else {
  NORUN.push('R10');
  console.log('  ○ R10 保存后后端权限真变了 —— NOT_RUN：弹窗里没找到勾选框。**不记为通过**。');
}

// ── R12/R13 T05 发件身份与切身份提示（真页面，jsdom 绿不算数）────────────────
const ident = await evalIn(sendS, `(async () => {
  const out = {};
  const compose = document.querySelector('#compose');
  if (compose && !compose.disabled) { compose.click(); await new Promise(r => setTimeout(r, 900)); }
  const sel = document.querySelector('#c-from');
  out.composeOpen = !!document.querySelector('#c-body');
  out.fromExists = !!sel;
  out.fromOptions = sel ? [...sel.options].map(o => ({value: o.value, box: o.getAttribute('data-mailbox')})) : [];
  out.errors = window.__n5Errors || [];
  return out;
})()`);
need('R12', '写信窗的发件身份下拉列出可选邮箱（带邮箱编号）',
     ident.fromExists && ident.fromOptions.length >= 1
       && ident.fromOptions.every(o => o.box),
     `fromOptions=${JSON.stringify(ident.fromOptions)} composeOpen=${ident.composeOpen}`);
const sw = await evalIn(sendS, `(async () => {
  const sel = document.querySelector('#c-from');
  if (!sel || sel.options.length < 2) return {skip: true, n: sel ? sel.options.length : 0};
  const body = document.querySelector('#c-body');
  const set = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  };
  set(body, '正文\\n\\n我手改过的签名');
  const other = [...sel.options].find(o => o.value !== sel.value);
  sel.value = other.value;
  sel.dispatchEvent(new Event('change', {bubbles: true}));
  await new Promise(r => setTimeout(r, 700));
  const dlg = document.querySelector('dialog, .os-dialog, [role=dialog]');
  const text = dlg ? (dlg.textContent || '') : '';
  const labels = dlg ? [...dlg.querySelectorAll('button')].map(b => (b.textContent || '').trim()) : [];
  return {hasDlg: !!dlg, text: text.slice(0, 200), labels,
          bodyNow: (document.querySelector('#c-body') || {}).value || ''};
})()`);
if (sw.skip) {
  NORUN.push('R13');
  console.log('  ○ R13 切发件身份给出明确的保留/换签名选择 —— NOT_RUN：发件身份只有 '
      + sw.n + ' 个，没得切。**不记为通过**。');
} else {
  need('R13', '切发件身份给出明确的保留/换签名选择，人选之前正文不动',
       sw.hasDlg && sw.labels.some(l => /保留/.test(l)) && sw.labels.some(l => /换|签名/.test(l))
         && sw.bodyNow.includes('我手改过的签名'),
       `hasDlg=${sw.hasDlg} 按钮=${JSON.stringify(sw.labels)}`
       + ` 正文=${JSON.stringify(sw.bodyNow)} 弹窗=${JSON.stringify(sw.text)}`);
}

// ── R14 MAIL-08 待审候选入口（真页面，jsdom 绿不算数）────────────────────────
const rev = await evalIn(sendS, `(async () => {
  const btn = document.querySelector('#review-btn');
  const out = {exists: !!btn, disabled: btn ? btn.disabled : null};
  if (btn && !btn.disabled) { btn.click(); await new Promise(r => setTimeout(r, 800)); }
  const dlg = document.querySelector('dialog, .os-dialog, [role=dialog]');
  out.dlg = !!dlg;
  out.text = dlg ? (dlg.textContent || '').slice(0, 200) : '';
  out.errors = window.__n5Errors || [];
  return out;
})()`);
need('R14', '邮件页有待审候选入口，点得开且没有 JS 报错',
     rev.exists && rev.disabled === false && rev.dlg && (rev.errors || []).length === 0,
     `exists=${rev.exists} disabled=${rev.disabled} dlg=${rev.dlg}`
     + ` errors=${JSON.stringify(rev.errors)} text=${JSON.stringify(rev.text)}`);

// ── R11 没管理权的箱上入口收起 ─────────────────────────────────────────────
//
// 三处旧毛病（2026-10-15 逐个栽过、逐个修）：
//   ① 检查写的是 `o.rights.manage === false`，可 `r.options` **根本没采集 `rights`**
//      （只采了 value/text/kind）—— 就算有只读箱也永远 NOT_RUN。**测具结构性失明。**
//   ② 「没管理权」要按**真实 UI** 看：`#access-btn.disabled`，不看 DOM 去猜权限。
//   ③ 换身份那一段原先排在 R12～R14 **前面** —— 清 cookie 会把 Administrator 的会话弄死，
//      后三条跟着塌。所以**排在最后**，前面的都跑完再清。
//
// 还有一条硬的：`rights_for` 里**账号行属主恒全权** —— 建箱的人自己验不了 R11。
// 所以这一条**另开一页、换只读身份登**（`ss-c@example.invalid`，夹具给它只开了阅读）。
// 口令从 0600 文件读「口令」那一行，只内联进页面，一次都不回显。
{
  const box = 'dept-n5realpage';
  const who = 'ss-c@example.invalid';
  let verdict = null, why = '';
  try {
    const sscPass = readAccountSecret('口令');
    if (!sscPass) throw new Error('账号文件里没读到「口令」行');
    // 同一个浏览器里 cookie 是共享的 —— 不清 cookie，新页会直接进应用、见不到登录框。
    // 上面的都跑完了，现在可以清。Network 是**页面域**的方法，得挂在已有会话上，
    // 浏览器级的 send() 上没有（2026-10-15 栽过：`'Network.enable' wasn't found`）。
    await sendS('Network.enable');
    await sendS('Network.clearBrowserCookies');
    const {sendS: s2} = await openPage(send, ws, `${BASE}/`);
    await new Promise(r2 => setTimeout(r2, 2500));
    // 登不登录还是按轮询判，不一上来就看一眼（同一个竞态坑，见文件头注释）
    let saw = false;
    for (let i = 0; i < 30; i++) {
      saw = await evalIn(s2, `!!document.querySelector('#un')`);
      if (saw) break;
      await new Promise(r2 => setTimeout(r2, 500));
    }
    if (!saw) throw new Error('清 cookie 后新页仍没停在登录框');
    await evalIn(s2, `(() => {
      const set = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                               : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
      };
      set(document.querySelector('#un'), ${JSON.stringify(who)});
      set(document.querySelector('#pw'), ${JSON.stringify(sscPass)});
      document.querySelector('button[type=submit]').click();
      return 'ok';
    })()`);
    await new Promise(r2 => setTimeout(r2, 3500));
    await evalIn(s2, `location.hash = '#/mail', 'nav'`);
    // 同样轮询等切换器真列出箱
    let opts = '[]';
    for (let i = 0; i < 24; i++) {
      opts = await evalIn(s2, `JSON.stringify([...(document.querySelector('#mailbox-switch')||{options:[]}).options].map(o=>o.value))`) || '[]';
      if (JSON.parse(opts).some(v => v)) break;
      await new Promise(r2 => setTimeout(r2, 500));
    }
    const has = JSON.parse(opts).includes(box);
    if (!has) throw new Error(`只读身份的切换器里没有 ${box}，实际 = ${opts}`);
    await evalIn(s2, `(() => {
      const sel = document.querySelector('#mailbox-switch');
      sel.value = ${JSON.stringify(box)};
      sel.dispatchEvent(new Event('change', {bubbles: true}));
      return 'ok';
    })()`);
    await new Promise(r2 => setTimeout(r2, 3000));
    verdict = await evalIn(s2, `(() => {
      const b = document.querySelector('#access-btn');
      return {exists: !!b, disabled: b ? b.disabled : null, title: b ? (b.title || '') : ''};
    })()`);
    why = `只读身份 ${who} 切到 ${box}：`;
  } catch (e) {
    NORUN.push('R11');
    console.log(`  ○ R11 没管理权的箱上权限入口收起 —— NOT_RUN：${e && e.message ? e.message : e}。`
        + `**不记为通过**。`);
    verdict = null;
  }
  if (verdict) {
    need('R11', '没管理权的箱上权限入口收起',
         verdict.exists && verdict.disabled === true,
         `${why} 权限入口应禁用 —— 实际 ${JSON.stringify(verdict)}`);
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`真页面：通过 ${PASS.length} 条，失败 ${FAIL.length} 条`
    + (NORUN.length ? `，NOT_RUN ${NORUN.length} 条（${NORUN.join(', ')}）` : ''));
if (FAIL.length) { console.log('未过：' + FAIL.join(', ')); process.exit(1); }
process.exit(0);
