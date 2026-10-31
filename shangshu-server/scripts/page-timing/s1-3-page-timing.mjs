/*
 S1-3 正式页面的真实链路耗时（0 附件 / 10MB 附件，冷 / 热分报）

 判据：测试通过 = 在**正式页面**上点发送，从点击到「已排队」提示 **≤1 秒**，
        按钮恢复 **≤1 秒**；0 附件与 10MB 附件分别报、冷/热分开、附件上传耗时另列。

 只走无界面 Chrome（CDP），不拉起任何本机图形应用。
 口令从 0600 账号文件读，**全程不打印**。
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';

function readPassword() {
  const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
  // 文件里是「密码：xxx」—— 只取值，不回显
  const m = raw.match(/密码[：:]\s*(\S+)/);
  if (!m) throw new Error('账号文件里没读到密码行');
  return m[1];
}

function row(code, what, ms, limit, note = '') {
  const ok = ms == null ? 'NOT_RUN' : (limit == null || ms <= limit ? 'PASS' : 'FAIL');
  const shown = ms == null ? '—' : `${ms.toFixed(0)} ms`;
  const lim = limit == null ? '' : `（判据 ≤${limit} ms）`;
  console.log(`S1-3|${code}|${what}|${shown}|${lim}|${ok}${note ? '|' + note : ''}`);
  return ok;
}

const {send, open, ws} = connect(await browserWsUrl());
await open;
const {sendS} = await openPage(send, ws, `${BASE}/`);
await new Promise(r => setTimeout(r, 2500));

// ---------- 登录（已在登录态就跳过）----------
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
} else {
  console.log('（已登录，跳过登录步骤）');
}

const afterLogin = await evalIn(sendS, `JSON.stringify({url: location.href, title: document.title,
  text: (document.body.innerText||'').slice(0,200)})`);
console.log('登录后：', afterLogin);
if (/登录/.test(JSON.parse(afterLogin).title)) {
  console.log('FAIL 登录没成功，停在这里');
  process.exit(1);
}

// ---------- 进邮箱页 ----------
await evalIn(sendS, `location.hash = '#/mail', 'nav'`);
await new Promise(r => setTimeout(r, 3000));
const pageState = await evalIn(sendS, `JSON.stringify({
  hasCompose: !!document.querySelector('#compose'),
  hasList: !!document.querySelector('#mail-rows'),
  text: (document.body.innerText||'').slice(0,200)})`);
console.log('邮箱页：', pageState);

/**
 * 跑一轮：写一封 → 点发送 → 核对 → 确认，全程用页面自己的 performance.now() 计时。
 * 返回 {t_confirm, t_queued, t_btn, toast, btnText}
 */
async function oneShot(label, subject, body, withAttachment) {
  return await evalIn(sendS, `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {label: ${JSON.stringify(label)}, subject: ${JSON.stringify(subject)}};
    const q = (s) => document.querySelector(s);

    // 0) 清掉上一轮残留的提示 —— 不清的话轮询会**立刻撞上旧提示**，
    //    计出 2ms 这种假数（第一次实跑就踩了）。
    const zone = q('#toast-zone');
    if (zone) zone.innerHTML = '';

    // 1) 开写信窗（轮询等它真出来，不写死等待）
    q('#compose').click();
    for (let i = 0; i < 40 && !q('#c-subject'); i++) await sleep(50);
    if (!q('#c-subject')) { out.error = '写信窗没开出来'; return out; }

    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                             : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    set(q('#c-to'), 'jiangzheny@lingeringtek.cn');
    set(q('#c-subject'), ${JSON.stringify(subject)});
    const ed = q('.mail-body-editor') || q('#c-body');
    if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') set(ed, ${JSON.stringify(body)});
    else { ed.innerHTML = ${JSON.stringify(body)}; ed.dispatchEvent(new Event('input', {bubbles: true})); }

    // 2) 附件：从文件库挑 —— **挑选/上传耗时另列**，不算进发送那两条
    if (${withAttachment}) {
      const tUp = performance.now();
      const byText = (re) => [...document.querySelectorAll('button, a, .file-picker-link')]
        .find(b => re.test((b.textContent || '').trim()));
      const pick = q('#pick-lib') || byText(/文件库|选择文件|添加附件|从库/);
      if (!pick) {
        out.attachError = '没找到附件入口';
        out.attachButtons = [...document.querySelectorAll('button, a')]
          .map(b => (b.textContent || '').trim()).filter(t => t && t.length < 12).slice(0, 40);
      } else {
        pick.click();
        for (let i = 0; i < 30 && !q('.file-picker-link') && !q('.pick-file'); i++) await sleep(80);
        const radio = q('.pick-file input[type=radio]') || q('input[data-lib]')
                   || q('input[type=radio]');
        if (radio) { radio.click(); await sleep(120); }
        const ok = q('#pick-ok') || byText(/确定|加入|选好|使用/);
        if (ok) ok.click();
        for (let i = 0; i < 30; i++) {
          const rows = document.querySelectorAll('#c-attachments .att-row').length;
          if (rows > 0) break;
          await sleep(80);
        }
        out.t_upload = performance.now() - tUp;
        out.attached = document.querySelectorAll('#c-attachments .att-row').length;
      }
    }

    // 3) 失焦自动存一次
    if (ed.blur) ed.blur();
    ed.dispatchEvent(new FocusEvent('blur', {bubbles: true}));
    await sleep(600);

    // 4) 点「发送」→ 核对弹层
    const t0 = performance.now();
    q('#c-send').click();
    for (let i = 0; i < 40 && ![...document.querySelectorAll('.mail-overlay')].length; i++) await sleep(25);
    const dlg = [...document.querySelectorAll('.mail-overlay')].pop();
    if (!dlg) { out.error = '没弹出发送核对'; return out; }
    out.t_confirm = performance.now() - t0;

    // 5) 点「确认发送」→ 计到**新出现**的排队提示 + 按钮恢复
    const ok = dlg.querySelector('#send-ok') || [...dlg.querySelectorAll('button')]
      .find(b => /确认发送/.test(b.textContent || ''));
    if (!ok) { out.error = '核对弹层里没有确认按钮'; return out; }
    if (zone) zone.innerHTML = '';       // 再清一次，确保等的是**这一封**的提示
    const t1 = performance.now();
    ok.click();

    let toastText = '';
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const t = (q('#toast-zone')?.innerText || '');
      if (/已排队|排队|已提交|等待发送|服务商/.test(t)) {
        toastText = t.trim().slice(0, 80);
        out.t_queued = performance.now() - t1;
        break;
      }
      await sleep(8);
    }
    out.toast = toastText || '(没等到排队提示)';

    // 按钮恢复（从点击算起）
    const btnDeadline = performance.now() + 15000;
    while (performance.now() < btnDeadline) {
      const b = document.querySelector('#send-ok');
      if (!b || !b.disabled) { out.t_btn = performance.now() - t1; break; }
      await sleep(8);
    }
    out.btnText = (document.querySelector('#send-ok')?.textContent || '(窗口已关)').trim();
    return out;
  })()`);
}

const SUBJECT = (tag) => `S1-3 页面计时 ${tag} ${Date.now()}`;

/** 附件那步会挂住 CDP —— 包一层超时 + 捕获拒绝，不让它炸掉整轮。
 *  （第一版只 race 没 catch，败方的 CDP 超时变成 unhandled rejection，进程直接退。） */
async function oneShotSafe(label, subject, body, withAttachment, budgetMs = 40000) {
  const p = oneShot(label, subject, body, withAttachment).catch(err => ({
    label, error: String(err && err.message || err),
    t_queued: null, t_btn: null, t_confirm: null, t_upload: null,
  }));
  return await Promise.race([
    p,
    new Promise(r => setTimeout(() => r({label,
      error: `超过 ${budgetMs}ms 没跑完（测具超时，非产品判定）`,
      t_queued: null, t_btn: null, t_confirm: null, t_upload: null}), budgetMs)),
  ]);
}

const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

// ---------- 冷跑 ----------
console.log('\n-- 冷跑（0 附件）--');
const cold0 = await oneShotSafe('冷/0附件', SUBJECT('冷0'), '冷跑无附件正文。', false);
console.log(JSON.stringify(cold0));
row('冷-0-点击到核对', '冷启动 · 无附件 · 点「发送」→ 核对弹层', cold0.t_confirm, 1000);
row('冷-0-排队提示', '冷启动 · 无附件 · 点「确认」→「已排队」提示', cold0.t_queued, 1000);
row('冷-0-按钮恢复', '冷启动 · 无附件 · 按钮恢复可用', cold0.t_btn, 1000);

// ---------- 热跑（三次取中位）----------
console.log('\n-- 热跑（三次取中位）--');
const hot = [];
for (let i = 1; i <= 3; i++) {
  const r = await oneShotSafe(`热${i}/0附件`, SUBJECT(`热${i}`), `热跑第 ${i} 封正文。`, false);
  console.log(JSON.stringify(r));
  if (r.t_queued != null) hot.push(r);
}
if (hot.length) {
  row('热-0-点击到核对', `热跑 · 无附件 · 点「发送」→ 核对（${hot.length} 次中位）`,
      med(hot.map(r => r.t_confirm).filter(x => x != null)), 1000);
  row('热-0-排队提示', `热跑 · 无附件 · 点「确认」→「已排队」（${hot.length} 次中位）`,
      med(hot.map(r => r.t_queued)), 1000);
  row('热-0-按钮恢复', '热跑 · 无附件 · 按钮恢复（中位）',
      med(hot.map(r => r.t_btn).filter(x => x != null)), 1000);
} else {
  row('热-0-排队提示', '热跑 · 无附件 · 点「确认」→「已排队」', null, 1000, '一轮都没跑成');
}

// ---------- 10MB 附件（默认跳过 —— 见下）----------
// 测具驱动不动文件选择器（Runtime.evaluate 会挂住），附件挂不上时这段**照样发信**，
// 发出去的是没附件的信、却按「10MB」记账 —— 名不副实，还会平白往用户信箱塞信。
// 10MB 那档改走「预置草稿」：seed-10mb-draft.py + s1-3-preset-attachment.mjs。
// 要真跑这段就 S1_WITH_10MB=1（明知上述代价）。
if (process.env.S1_WITH_10MB === '1') {
  console.log('\n-- 10MB 附件（附件上传耗时另列）--');
  const cold10 = await oneShotSafe('冷/10MB', SUBJECT('冷10'), '冷跑带附件正文。', true, 45000);
  console.log(JSON.stringify(cold10));
  row('冷-10-上传', '10MB 附件 · 挑选并挂上（**另列**，不算发送）', cold10.t_upload, null,
      '附件上传耗时单列' + (cold10.attachError ? '；' + cold10.attachError : ''));
  row('冷-10-排队提示', '10MB · 点「确认」→「已排队」提示', cold10.t_queued, 1000);
  row('冷-10-按钮恢复', '10MB · 按钮恢复可用', cold10.t_btn, 1000);
} else {
  console.log('\n-- 10MB 附件：本次跳过（测具驱动不动文件选择器）--');
  console.log('   改用预置草稿那一档：seed-10mb-draft.py + s1-3-preset-attachment.mjs');
  row('冷-10-排队提示', '10MB · 点「确认」→「已排队」提示', null, 1000,
      '改用预置草稿脚本报');
}

console.log('\n提醒：页面计时只覆盖「点下去到界面有反馈」这一段；');
console.log('      「服务商已接受」是另一档（见真网测速），两者别混。');
process.exit(0);
