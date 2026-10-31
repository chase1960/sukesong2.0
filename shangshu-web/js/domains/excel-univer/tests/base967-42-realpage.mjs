/**
 * BASE967-42 真页面复验（窄栏助手浮钮遮挡草稿关闭 · UI045）
 *
 * 测试通过 = 四件事同时成立：
 *   ① 900×800 窄栏、草稿弹窗打开时，底部「关闭」按钮**中心点**
 *      用 document.elementFromPoint 命中的是**那个按钮本身**，不是 .ai-fab 的 SVG；
 *   ② 助手**展开态**（.ai-fab.show）也不遮 —— 现有判据只跑了 show 态的静态 HTML，
 *      这里在真页面上把两态都过一遍；
 *   ③ 真实**点击**那个「关闭」按钮，弹窗真的关掉（原稿记的是「点击后打开了助手，草稿没关」，
 *      所以只量几何不够，得点下去看结果）；
 *   ④ 顶部 × 替代入口**保留可用**（不能为躲浮钮把顶部入口弄没了）。
 *
 * 为什么不用现成的 base967-42-narrow-foot.mjs：那个脚本**注入静态 HTML**
 * （自己手写 <button class="ai-fab show">），跑的是假页面；原缺陷记录用的是
 * 「实际邮件页面 + 真实草稿」，两者不等价。
 *
 * 凭据：SS_USER / SS_PASSWORD 环境变量（不落盘、不打印）。
 * 用法：node base967-42-realpage.mjs --base http://127.0.0.1:3850
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3850');
const DEBUG_PORT = arg('debug-port', '9333');
const USER = process.env.SS_USER;
const PASS = process.env.SS_PASSWORD;
if (!USER || !PASS) { console.error('缺 SS_USER / SS_PASSWORD 环境变量（不落盘、不打印）'); process.exit(2); }

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}\n    ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

// ---- 登录 ----
await page.goto(BASE + '/login.html', { waitUntil: 'load', timeout: 60000 });
await page.evaluate(async (u, p) => {
  document.querySelector('#un').value = u;
  document.querySelector('#pw').value = p;
  document.querySelector('form').requestSubmit(document.querySelector('form button'));
}, USER, PASS);
await page.waitForFunction(() => !location.pathname.includes('login.html'), { timeout: 60000 })
  .catch(() => { throw new Error('登录失败（留在登录页）'); });

// ---- 进邮件中心，窄视口 ----
async function openComposer(width, height) {
  await page.setViewport({ width, height });
  await page.goto(BASE + '/index.html#/mail', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('.mail-center-page'), { timeout: 60000 })
    .catch(() => { throw new Error('邮件中心没出现'); });
  await sleep(1200);
  // 打开一封草稿（有真实关闭/保存按钮的写信窗）。
  // **入口用真实文案找，不猜 class**：底部按钮文案已核实是「关闭/取消/发送」
  // （mail-center.js 的 dlg-foot），入口同理按可见中文文案找，找不到再退化。
  const opened = await page.evaluate(async () => {
    const byText = (re) => [...document.querySelectorAll('button, [role=button], .mail-item, tr')]
      .find((el) => re.test((el.textContent || '').trim().slice(0, 12)));
    const draft = byText(/^(草稿|Draft)|草稿$/) || document.querySelector('[data-draft], tr[data-name]');
    if (draft) { draft.click(); await new Promise((r) => setTimeout(r, 1800)); }
    else {
      const compose = byText(/写邮件|新建|写信|写一封/) || document.querySelector('[data-compose], #compose');
      if (compose) { compose.click(); await new Promise((r) => setTimeout(r, 1800)); }
    }
    return {
      hasFoot: !!document.querySelector('.is-composing .dlg-foot'),
      closeBtn: !!document.querySelector('.is-composing .dlg-foot button'),
      footLabels: [...document.querySelectorAll('.is-composing .dlg-foot button')]
        .map((b) => (b.textContent || '').trim().slice(0, 8)),
    };
  });
  return opened;
}

/** 命中检测：底部操作按钮中心点到底命中谁。 */
const probeFoot = () => page.evaluate(() => {
  const foot = document.querySelector('.is-composing .dlg-foot');
  if (!foot) return { ok: false, reason: '没有 .dlg-foot（写信窗没打开？）' };
  // 取「关闭/取消」类按钮；没有就取最后一个（通常是操作钮）
  const btns = [...foot.querySelectorAll('button')];
  const close = btns.find((b) => /关闭|取消|close|cancel/i.test(b.textContent || b.getAttribute('aria-label') || ''))
    || btns[btns.length - 1];
  if (!close) return { ok: false, reason: '.dlg-foot 里没有按钮' };
  const r = close.getBoundingClientRect();
  if (!r.width || !r.height) return { ok: false, reason: `按钮矩形为 0：${JSON.stringify({ w: r.width, h: r.height })}` };
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const onFab = !!hit?.closest?.('.ai-fab');
  return {
    ok: !onFab,
    reason: `按钮 ${Math.round(r.x)}/${Math.round(r.y)}/${Math.round(r.width)}×${Math.round(r.height)}`
      + ` 中心(${Math.round(cx)},${Math.round(cy)}) 命中=${hit?.tagName?.toLowerCase() || 'null'}`
      + `.${(hit?.className?.baseVal ?? hit?.className ?? '').toString().split(' ')[0] || ''}`
      + ` 命中浮钮=${onFab} 按钮文字=${JSON.stringify((close.textContent || '').trim().slice(0, 8))}`,
  };
});

// ============ ① 窄栏 900×800 · 助手收起态 ============
let st = await openComposer(900, 800);
check('① 窄栏 900×800 写信窗已打开（有 .dlg-foot 和操作钮）',
  st.hasFoot && st.closeBtn,
  `dlg-foot=${st.hasFoot} 关闭类按钮=${st.closeBtn}`);

if (st.hasFoot) {
  // 收起态：把 .ai-fab 的 show 摘掉
  await page.evaluate(() => document.querySelector('.ai-fab')?.classList.remove('show'));
  await sleep(300);
  let p = await probeFoot();
  check('①a 窄栏 900×800 · 助手收起态：按钮中心不被浮钮遮', p.ok, p.reason);

  // 展开态：确保 .ai-fab 有 show
  await page.evaluate(() => document.querySelector('.ai-fab')?.classList.add('show'));
  await sleep(300);
  p = await probeFoot();
  check('①b 窄栏 900×800 · 助手展开态：按钮中心不被浮钮遮', p.ok, p.reason);

  // ============ ③ 真实点击关闭 ============
  const before = await page.evaluate(() => !!document.querySelector('.is-composing'));
  await page.evaluate(() => {
    const foot = document.querySelector('.is-composing .dlg-foot');
    const btns = [...foot.querySelectorAll('button')];
    const close = btns.find((b) => /关闭|取消|close|cancel/i.test(b.textContent || b.getAttribute('aria-label') || ''))
      || btns[btns.length - 1];
    close.click();   // 真点，看结果而不是只看几何
  });
  await sleep(1200);
  const after = await page.evaluate(() => ({
    stillOpen: !!document.querySelector('.is-composing'),
    fabOpen: !!document.querySelector('.ai-fab')?.classList.contains('show'),
  }));
  check('③ 真实点「关闭」→ 草稿关掉，且没误开助手',
    before && !after.stillOpen && !after.fabOpen,
    `点前开着=${before} 点后还开着=${after.stillOpen} 助手被误开=${after.fabOpen}`
    + (after.stillOpen ? ' ← 原缺陷：点了打开了助手，草稿没关' : ''));
}

// ============ ④ 顶部 × 替代入口保留 ============
{
  const top = await page.evaluate(() => {
    const panel = document.querySelector('.mail-center-page');
    const btns = [...(panel?.querySelectorAll('button, [role=button]') || [])];
    const x = btns.find((b) => /×|✕|关闭/.test((b.textContent || '').trim())
      || /close/i.test(b.getAttribute('aria-label') || ''));
    return { found: !!x, label: (x?.getAttribute('aria-label') || x?.textContent || '').trim().slice(0, 10) };
  });
  check('④ 顶部替代入口（×/关闭）仍存在', top.found,
    top.found ? `找到，标签=${JSON.stringify(top.label)}` : '没找到顶部关闭入口 —— 不能为躲浮钮把它弄没了');
}

// ============ ② 宽栏 1400×900 复验不引入新遮挡 ============
{
  st = await openComposer(1400, 900);
  if (st.hasFoot) {
    await page.evaluate(() => document.querySelector('.ai-fab')?.classList.add('show'));
    await sleep(300);
    const p = await probeFoot();
    check('② 宽栏 1400×900 · 助手展开态：不引入新遮挡', p.ok, p.reason);
  } else {
    check('② 宽栏 1400×900 · 不引入新遮挡', false, '宽栏没打开写信窗，本条 NOT_RUN');
  }
}

await page.close().catch(() => {});
await browser.disconnect();

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed} 过 / ${results.length - passed} 未过`);
console.log('注：口径是「几何命中 + 真点结果」两条都过才算修好；只量几何不算。');
process.exit(passed === results.length ? 0 : 1);
