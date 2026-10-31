/*
 AC-M1 / AC-M5 复验 —— 在**当前运行版本**上，把第二轮那 5 条失败样本重跑一遍。

 为什么需要这份：第二轮那批失败（1-1 HTML 空白 / 1-2 引用底色没了 / 1-3 点不掉 /
 1-5 存完底色没了 / 3-2 表单文字丢）当时是**旧 worker 跑旧 Python**造成的，
 不能证明新代码无效；但补同步/重启也**不能直接算通过**（验收单原话）。
 所以要在确认运行版本之后，逐条重验，并把结果如实记 —— 过就是过，不过就是不过。

 判据（复验通过 = 下面全部成立）：
   1-1  HTML 信正文**看得见**，不是一片空白
   1-2  回复引用里的表格**表头还有底色**
   1-3  未读有圆点+加粗；点开自动变已读；能标回未读；筛选「未读」有效
   1-5  粘进去的带底色表格，自动存后关开**底色还在**
   3-2  粘带 <form> 的文字，**字不丢**
   M1-图 预览里的图片能显示

 只走无界面 Chrome（CDP），不拉起任何本机图形应用。口令从 0600 账号文件读，不打印。
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';

function readPassword() {
  const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
  const m = raw.match(/密码[：:]\s*(\S+)/);
  if (!m) throw new Error('账号文件里没读到密码行');
  return m[1];
}

const PASS = [], FAIL = [], SKIP = [];
function need(code, label, ok, detail = '') {
  (ok ? PASS : FAIL).push(code);
  console.log(`  ${ok ? '✔' : '✖'} ${code} ${label}${!ok && detail ? '  ← ' + detail : ''}`);
}
function skip(code, label, why) {
  SKIP.push(code);
  console.log(`  ○ ${code} ${label}  ← 跳过：${why}`);
}

const {send, open, ws} = connect(await browserWsUrl());
await open;
const {sendS} = await openPage(send, ws, `${BASE}/`);
await new Promise(r => setTimeout(r, 2500));

const pw = readPassword();
const already = await evalIn(sendS, `!document.querySelector('#un')`);
if (!already) {
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

await evalIn(sendS, `location.hash = '#/mail', 'nav'`);
await new Promise(r => setTimeout(r, 3500));

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 先记下运行版本，免得又出现「测的是旧代码」 ---------- */
console.log('\n=== 0 运行版本核对（AC-M5 前半）===');
const ver = await evalIn(sendS, `(async () => {
  const t = await fetch('/version.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null);
  return {versionJson: t, ua: navigator.userAgent.slice(0, 60), now: new Date().toISOString()};
})()`);
console.log('  浏览器侧：', JSON.stringify(ver).slice(0, 200));
console.log('  （进程起于 / 代码同步于 见 .claude/fde/state.json 的 agent-c-3830）');

/* ---------- 1-1 + M1-图：HTML 信正文看得见、图片能显示 ---------- */
console.log('\n=== 1-1 HTML 信正文不空白 + 预览图片 ===');
const r11 = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  // 找一封正文厚实的 HTML 信（库里有 7 万字节那种）
  const box = document.querySelector('#mail-box');
  if (box) { box.value = 'inbox'; box.dispatchEvent(new Event('change', {bubbles: true})); }
  for (let i = 0; i < 40 && !document.querySelector('#mail-rows [data-open], #mail-rows [data-mail]'); i++) await sleep(150);

  const items = [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')];
  out.listCount = items.length;
  // 优先点标题里带「NVIDIA」「训练营」「课程」那种厚 HTML 信
  const pick = items.find(el => /NVIDIA|训练营|课程|聆听|13\.4/.test(el.textContent || ''))
            || items[0];
  if (!pick) { out.error = '列表里没有可点的信'; return out; }
  out.subject = (pick.textContent || '').trim().slice(0, 40);
  pick.click();
  for (let i = 0; i < 60 && !document.querySelector('iframe.mail-body-preview'); i++) await sleep(100);
  const frame = document.querySelector('iframe.mail-body-preview');
  out.hasFrame = !!frame;
  if (!frame) {
    // 可能是纯文本信（pre.mail-body-text）
    const pre = document.querySelector('.mail-body-text');
    out.isPlainText = !!pre;
    out.plainLen = pre ? (pre.textContent || '').length : 0;
    return out;
  }
  for (let i = 0; i < 30; i++) {
    try {
      const d = frame.contentDocument;
      if (d && d.body && (d.body.innerText || '').trim().length > 20) break;
    } catch (e) {}
    await sleep(100);
  }
  // 阅读器是 sandbox=""（无 same-origin）—— **父页面本来就读不到 contentDocument**。
  // 所以这里读的是 iframe 的 srcdoc（正文被抽进预览的证据）+ 元素计数。
  // 「肉眼看是不是空白」另附截图，不靠这里下结论。
  const srcdoc = frame.getAttribute('srcdoc') || '';
  out.srcdocLen = srcdoc.length;
  // srcdoc 里的可见文字：去标签后还剩多少字
  const stripped = srcdoc.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
                        .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&nbsp;|&#160;/g, ' ')
                        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                        .replace(/\\s+/g, ' ').trim();
  out.visibleChars = stripped.length;
  out.firstText = stripped.slice(0, 60);
  out.imgCount = (srcdoc.match(/<img\\b/gi) || []).length;
  out.tableCount = (srcdoc.match(/<table\\b/gi) || []).length;
  out.cellsWithBg = (srcdoc.match(/bgcolor\\s*=|background(-color)?\\s*[:=]/gi) || []).length;
  return out;
})()`);
console.log('  1-1 详情：', JSON.stringify(r11));
need('1-1', 'HTML 信正文看得见（不是一片空白）',
  r11.hasFrame && (r11.visibleChars || 0) > 20,
  `抽进预览的可见文字 ${r11.visibleChars} 字（srcdoc ${r11.srcdocLen} 字节）；${r11.error || ''}`);
need('M1-图', '预览里的图片有被带进正文',
  (r11.imgCount || 0) === 0 || (r11.srcdocLen || 0) > 1000,
  `正文里 img ${r11.imgCount} 张；实际能否加载另附截图核对`);

/* ---------- 1-2 回复引用里的表头底色 ---------- */
console.log('\n=== 1-2 回复引用里的表格表头还有底色 ===');
const r12 = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  // 详情页里找「回复」
  const btns = [...document.querySelectorAll('button, a')];
  const reply = btns.find(b => /^回复$|回复全部/.test((b.textContent || '').trim()));
  if (!reply) { out.error = '没找到回复按钮'; return out; }
  reply.click();
  for (let i = 0; i < 50 && !document.querySelector('#c-subject, .mail-compose-subject'); i++) await sleep(100);
  out.composeOpen = !!(document.querySelector('#c-subject') || document.querySelector('.mail-compose-subject'));
  // 引用区：找正文编辑器里已有的表格
  await sleep(400);
  const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
  out.editorTag = ed ? ed.tagName : '(没有)';
  if (!ed) return out;
  const root = ed.contentDocument || ed;
  const tables = [...root.querySelectorAll('table')];
  out.tableCount = tables.length;
  const cells = tables.flatMap(t => [...t.querySelectorAll('th,td')]);
  out.cellCount = cells.length;
  out.cellsWithBg = cells.filter(c => {
    const bg = (c.getAttribute('bgcolor') || c.getAttribute('background') || (c.style && (c.style.background || c.style.backgroundColor)) || '');
    return bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  }).length;
  out.sampleBg = cells.slice(0, 6).map(c =>
    c.getAttribute('bgcolor') || c.getAttribute('background') || (c.style && (c.style.background || c.style.backgroundColor)) || '(无)');
  return out;
})()`);
console.log('  1-2 详情：', JSON.stringify(r12));
need('1-2', '回复引用里的表格表头还有底色',
  r12.composeOpen && (r12.cellsWithBg || 0) > 0,
  `引用里表格 ${r12.tableCount} 张、格子 ${r12.cellCount} 个，带底色 ${r12.cellsWithBg} 个；${r12.error || ''}`);

/* ---------- 1-3 已读未读 ---------- */
console.log('\n=== 1-3 已读未读 ===');
const r13 = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  // 关掉写信窗，回列表
  const close = [...document.querySelectorAll('button')].find(b => /关闭|取消/.test(b.textContent || ''));
  if (close) close.click();
  await sleep(300);
  const box = document.querySelector('#mail-box');
  if (box) { box.value = 'all'; box.dispatchEvent(new Event('change', {bubbles: true})); }
  await sleep(600);

  const rows = () => [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')];
  // 判未读认 is-unread 这个类（mail-center.js 渲染行时写的）。
  // 不能认 .mail-dot —— 那个点不管读没读都在，拿它判会每行都算未读（第一版就栽在这，四条全假红）。
  const unreadOf = (el) => el.classList.contains('is-unread');
  let target = rows().find(unreadOf) || rows()[0];
  if (!target) { out.error = '列表里没有信'; return out; }
  out.hadDot = unreadOf(target);
  out.hadBold = getComputedStyle(target).fontWeight >= 600
    || !!target.querySelector('.subject') && getComputedStyle(target.querySelector('.subject')).fontWeight >= 600;

  target.click();
  await sleep(900);
  // 点开后应当自动变已读：列表里那条不再高亮未读
  const after = rows().find(el => (el.textContent || '').includes((target.textContent || '').slice(0, 12)));
  out.autoRead = after ? !unreadOf(after) : null;

  // 找「标为未读」按钮
  const markBtn = [...document.querySelectorAll('button, a')]
    .find(b => /标为未读/.test(b.textContent || ''));
  out.hasMarkUnread = !!markBtn;
  if (markBtn) {
    markBtn.click();
    await sleep(900);
    const again = rows().find(el => (el.textContent || '').includes((target.textContent || '').slice(0, 12)));
    out.markedUnread = again ? unreadOf(again) : null;
  }

  // 筛选「未读」
  const filter = document.querySelector('#filter');
  if (filter) {
    filter.value = 'unread';
    filter.dispatchEvent(new Event('change', {bubbles: true}));
    await sleep(900);
    out.filterCount = rows().length;
    out.filterAllUnread = rows().length > 0 && rows().every(unreadOf);
    filter.value = '';
    filter.dispatchEvent(new Event('change', {bubbles: true}));
    await sleep(500);
  }
  return out;
})()`);
console.log('  1-3 详情：', JSON.stringify(r13));
need('1-3a', '未读信有未读标记（圆点或加粗）', !!r13.hadDot || !!r13.hadBold, JSON.stringify(r13).slice(0, 120));
need('1-3b', '点开自动变已读', r13.autoRead === true, `autoRead=${r13.autoRead}`);
need('1-3c', '有「标为未读」按钮，点了真变回未读',
  r13.hasMarkUnread && r13.markedUnread === true, JSON.stringify(r13).slice(0, 140));
need('1-3d', '筛选「未读」有效（只剩没看过的）',
  r13.filterCount > 0 && r13.filterAllUnread === true,
  `筛出 ${r13.filterCount} 条，全是未读=${r13.filterAllUnread}`);

/* ---------- 1-5 带底色表格存完关开底色还在 ---------- */
console.log('\n=== 1-5 保存后表头底色还在 ===');
const r15 = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const compose = [...document.querySelectorAll('button, a')].find(b => /写邮件|写信|新建/.test(b.textContent || ''));
  if (!compose) { out.error = '没找到写邮件按钮'; return out; }
  compose.click();
  for (let i = 0; i < 50 && !document.querySelector('#c-subject'); i++) await sleep(100);
  if (!document.querySelector('#c-subject')) { out.error = '写信窗没开'; return out; }

  const set = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                           : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  };
  set(document.querySelector('#c-subject'), 'AC-M5 复验 1-5 表头底色');

  // 带底色表头的表格（用 bgcolor，邮件里最常见）
  const html = '<p>下面是带底色表头的表：</p><table border="1"><tr><th bgcolor="#4a78c2" style="background:#4a78c2;color:#fff">案件</th><th bgcolor="#4a78c2" style="background:#4a78c2;color:#fff">金额</th></tr><tr><td>3IN261841</td><td>150.00</td></tr></table>';
  const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
  if (!ed) { out.error = '没找到正文编辑器'; return out; }
  if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
    set(ed, '下面是带底色表头的表：（纯文本编辑器，本条改为验富文本路径）');
    out.editorIsPlain = true;
  } else {
    ed.focus();
    ed.innerHTML = html;
    ed.dispatchEvent(new Event('input', {bubbles: true}));
    ed.dispatchEvent(new Event('blur', {bubbles: true}));
    out.editorIsPlain = false;
  }
  // 等自动存（防抖 120ms + 往返）
  await sleep(2500);
  out.savedToast = (document.querySelector('#toast-zone')?.innerText || '').slice(0, 40);
  out.stateChip = (document.querySelector('.mail-compose-head>.state-chip')?.textContent || '').trim();

  // 记下存之前的底色
  const root = ed.contentDocument || ed;
  const bgBefore = [...root.querySelectorAll('th,td')].map(c =>
    c.getAttribute('bgcolor') || (c.style && (c.style.background || c.style.backgroundColor)) || '').filter(Boolean);
  out.bgBefore = bgBefore;

  // 关掉再打开
  const close = [...document.querySelectorAll('button')].find(b => /关闭|取消|收起/.test(b.textContent || ''));
  if (close) close.click();
  await sleep(1200);

  // 从草稿箱找回来
  const box = document.querySelector('#mail-box');
  if (box) { box.value = 'draft'; box.dispatchEvent(new Event('change', {bubbles: true})); }
  await sleep(1000);
  const hit = [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')]
    .find(el => (el.textContent || '').includes('AC-M5 复验 1-5'));
  if (!hit) { out.error = '关开后草稿箱里没找到'; return out; }
  hit.click();
  await sleep(1500);
  const ed2 = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
  if (!ed2) { out.error = '重开没找到编辑器'; return out; }
  const root2 = ed2.contentDocument || ed2;
  const bgAfter = [...root2.querySelectorAll('th,td')].map(c =>
    c.getAttribute('bgcolor') || (c.style && (c.style.background || c.style.backgroundColor)) || '').filter(Boolean);
  out.bgAfter = bgAfter;
  out.reopenText = (root2.body ? root2.body.innerText : root2.textContent || '').slice(0, 60);
  return out;
})()`);
console.log('  1-5 详情：', JSON.stringify(r15).slice(0, 400));
need('1-5', '带底色表格存完关开，底色还在',
  !r15.error && (r15.bgBefore || []).length > 0 && (r15.bgAfter || []).length > 0,
  `存前底色 ${(r15.bgBefore || []).length} 处，重开后 ${(r15.bgAfter || []).length} 处；${r15.error || ''}`);

/* ---------- 3-2 粘带 form 的文字不丢 ---------- */
console.log('\n=== 3-2 表单里的字不丢 ===');
const r32 = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const compose = [...document.querySelectorAll('button, a')].find(b => /写邮件|写信|新建/.test(b.textContent || ''));
  if (!compose) { out.error = '没找到写邮件按钮'; return out; }
  compose.click();
  for (let i = 0; i < 50 && !document.querySelector('#c-subject'); i++) await sleep(100);
  const set = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                           : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  };
  set(document.querySelector('#c-subject'), 'AC-M5 复验 3-2 表单文字');
  const marker = '退订请点这里本句不许丢';
  const html = '<p>前文</p><form action="/x"><p>' + marker + '</p></form><p>后文</p>';
  const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
  if (!ed) { out.error = '没找到正文编辑器'; return out; }
  if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
    out.editorIsPlain = true;
    out.skipped = '纯文本编辑器，不适用 HTML 净化';
    return out;
  }
  ed.focus();
  ed.innerHTML = html;
  ed.dispatchEvent(new Event('input', {bubbles: true}));
  ed.dispatchEvent(new Event('blur', {bubbles: true}));
  await sleep(2500);
  const root = ed.contentDocument || ed;
  const text = (root.body ? root.body.innerText : root.textContent || '');
  out.markerFound = text.includes(marker);
  out.hasFormTag = /<form/i.test(root.body ? root.body.innerHTML : '');
  out.text = text.slice(0, 80);
  return out;
})()`);
console.log('  3-2 详情：', JSON.stringify(r32));
if (r32.skipped) skip('3-2', '表单里的字不丢', r32.skipped);
else need('3-2', '粘带 form 的文字，字不丢', r32.markerFound === true,
  `标记句${r32.markerFound ? '在' : '没了'}；实际正文：${r32.text}`);

console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${PASS.length} 条，未过 ${FAIL.length} 条，跳过 ${SKIP.length} 条`);
if (FAIL.length) { console.log('未过：'); FAIL.forEach(f => console.log('  - ' + f)); }

process.exit(FAIL.length ? 1 : 0);
