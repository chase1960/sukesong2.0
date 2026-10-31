/*
 S1-3 补档：**预置**带附件的草稿，量「点发送 → 已排队」。

 为什么不用文件选择器（s1-3 原脚本那档记 NOT_RUN 的原因）：
   测具驱动不动它，Runtime.evaluate 会挂住。而且执行计划 S1 本来就写着
   「真实存储中**预置**无附件/10MB 附件草稿」—— 不是要测具去点文件选择器。
   附件**上传**耗时另列，不混进发送那两条。

 判据：测试通过 = 在正式页面上点发送，从点击到「已排队」提示 **≤1 秒**，
        按钮恢复 **≤1 秒**。0 附件与 10MB 附件分别报、冷/热分开。

 只走无界面 Chrome（CDP），不拉起任何本机图形应用。口令从 0600 账号文件读，不打印。

 用法：
   1) 先在容器里预置草稿：python …/seed-10mb-draft.py
   2) node shangshu-server/scripts/page-timing/s1-3-preset-attachment.mjs
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';
const SUBJECT = process.env.S1_SUBJECT || 'S1-3 预置 10MB 附件草稿 v1';

function readPassword() {
  const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
  const m = raw.match(/密码[：:]\s*(\S+)/);
  if (!m) throw new Error('账号文件里没读到密码行');
  return m[1];
}

function row(code, what, ms, limit, note = '') {
  const ok = ms == null ? 'NOT_RUN' : (limit == null || ms <= limit ? 'PASS' : 'FAIL');
  const shown = ms == null ? '—' : `${ms.toFixed(0)} ms`;
  const lim = limit == null ? '' : `（判据 ≤${limit} ms）`;
  console.log(`S1-3A|${code}|${what}|${shown}|${lim}|${ok}${note ? '|' + note : ''}`);
  return ok;
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

/** 打开草稿箱里那封预置的信 → 点发送 → 确认，全程用页面自己的 performance.now() 计时。
 *  subject 传**完整主题**（含 #N）—— 每封各测各的，不用同一封反复发：
 *  发出去那封状态就变了（Draft→Queued→…），再找就找不着了。 */
async function sendPreset(label, subject) {
  return await evalIn(sendS, `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const out = {label: ${JSON.stringify(label)}, subject: ${JSON.stringify(subject)}};
    const zone = q('#toast-zone');
    if (zone) zone.innerHTML = '';

    // 1) 切到草稿箱
    const box = q('#mail-box');
    if (!box) { out.error = '没有邮箱范围下拉'; return out; }
    box.value = 'draft';
    box.dispatchEvent(new Event('change', {bubbles: true}));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(subject)}));
      if (hit) break;
      await sleep(150);
    }

    // 2) 打开那封
    const item = [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(subject)}));
    if (!item) { out.error = '草稿箱里没找到预置的那封（先跑 seed-10mb-draft.py）：' + ${JSON.stringify(subject)}; return out; }
    item.click();
    for (let i = 0; i < 40 && !q('#c-send'); i++) await sleep(50);
    if (!q('#c-send')) { out.error = '写信窗没开出来'; return out; }

    out.attRows = document.querySelectorAll('#c-attachments .att-row').length;
    out.attText = (q('#c-attachments')?.innerText || '').trim().slice(0, 80);

    // 3) 点「发送」→ 核对弹层
    const t0 = performance.now();
    q('#c-send').click();
    for (let i = 0; i < 60 && ![...document.querySelectorAll('.mail-overlay')].length; i++) await sleep(25);
    const dlg = [...document.querySelectorAll('.mail-overlay')].pop();
    if (!dlg) { out.error = '没弹出发送核对'; return out; }
    out.t_confirm = performance.now() - t0;

    // 4) 点「确认发送」→ 计到**新出现**的排队提示 + 按钮恢复
    const ok = dlg.querySelector('#send-ok') || [...dlg.querySelectorAll('button')]
      .find(b => /确认发送/.test(b.textContent || ''));
    if (!ok) { out.error = '核对弹层里没有确认按钮'; return out; }
    if (zone) zone.innerHTML = '';
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

async function safe(label, subject, budgetMs = 45000) {
  const p = sendPreset(label, subject).catch(err => ({
    label, error: String(err && err.message || err), t_queued: null, t_btn: null, t_confirm: null,
  }));
  return await Promise.race([
    p,
    new Promise(r => setTimeout(() => r({label, error: `超过 ${budgetMs}ms 没跑完（测具超时，非产品判定）`,
      t_queued: null, t_btn: null, t_confirm: null}), budgetMs)),
  ]);
}

const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

console.log(`\n== 预置草稿发送计时（前缀 ${SUBJECT}）==`);

// 冷跑用 #1，热跑用 #2/#3/#4 —— 每封各测各的
const cold = await safe('冷跑', `${SUBJECT} #1`);
console.log('  冷跑详情：', JSON.stringify(cold));
if (cold.error) console.log('  冷跑报错：', cold.error);
row('冷-附件-点击到核对', '冷启动 · 10MB 附件 · 点「发送」→ 核对弹层', cold.t_confirm, 1000);
row('冷-附件-排队提示', '冷启动 · 10MB 附件 · 点「确认」→「已排队」提示', cold.t_queued, 1000);
row('冷-附件-按钮恢复', '冷启动 · 10MB 附件 · 按钮恢复可用', cold.t_btn, 1000);

const hot = [];
for (let i = 2; i <= 4; i++) {
  const r = await safe(`热${i - 1}`, `${SUBJECT} #${i}`);
  console.log(`  热${i - 1}：`, JSON.stringify(r));
  if (r.t_queued != null) hot.push(r);
}
if (hot.length) {
  row('热-附件-点击到核对', `热跑 · 10MB 附件 · 点「发送」→ 核对（${hot.length} 次中位）`, med(hot.map(r => r.t_confirm)), 1000);
  row('热-附件-排队提示', `热跑 · 10MB 附件 · 点「确认」→「已排队」（${hot.length} 次中位）`, med(hot.map(r => r.t_queued)), 1000);
  row('热-附件-按钮恢复', '热跑 · 10MB 附件 · 按钮恢复（中位）', med(hot.map(r => r.t_btn)), 1000);
} else {
  row('热-附件-排队提示', '热跑 · 10MB 附件', null, 1000, '|没有一次跑成，热跑不报');
}

console.log('\n说明：附件**上传**耗时另列，不在这两条里（判据只管点发送→已排队）。');
console.log('      每封各测各的 —— 发出去那封状态就变，不能反复用同一封。');

/* CDP 连接会把事件循环挂着，node 不自己退 —— 显式退。
   不写这句的表现：跑完了但进程不结束，管道上的 tail 一直憋着不吐，
   看起来像「卡住」（第一版就栽在这，白等了 5 分钟）。 */
process.exit(0);
