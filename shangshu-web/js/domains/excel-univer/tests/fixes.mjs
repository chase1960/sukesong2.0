/**
 * Excel 首批验收问题修复（用户实测 9 条）的页面侧测试。
 *
 * 每条的「测试通过 = 什么成立」写在各自 test 函数顶上的注释里。
 * 连本机 Chrome 调试口跑真实页面，真实登录、真实接口、真实写入；不 mock、不用 localStorage。
 *
 * 用法：
 *   node tests/fixes.mjs                     # 全量
 *   node tests/fixes.mjs --only T1 T4        # 只跑指定项
 *   node tests/fixes.mjs --json-out out.json
 *
 * 口令只从仓外 ~/.excel-b1/ 读，绝不打印、绝不进仓库。
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = args.includes('--only')
  ? args.slice(args.indexOf('--only') + 1).filter((a) => !a.startsWith('--'))
  : null;
const JSON_OUT = arg('json-out', 'fixes.json');
const DEBUG_PORT = Number(arg('debug-port', '9333'));

const BASE = 'https://shangshu-rework-test.dev.lingeringtek.cn';
const FIXTURES = join(homedir(), '.excel-b1');
const M = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
const S = JSON.parse(readFileSync(join(FIXTURES, 'secrets.json'), 'utf8'));

const ROW_H = 24, HEADER_H = 20, COL_W = 88, ROW_HEAD_W = 46;
const CHECKS = [];
const NOTES = [];
const URLS = new Set();

function check(item, label, ok, detail = '') {
  CHECKS.push({ item, label, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? `　[${String(detail).slice(0, 140)}]` : ''));
  return !!ok;
}
function note(text) {
  NOTES.push(text);
  console.log('  · ' + text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (id) => !ONLY || ONLY.includes(id);

function trackUrls(page) {
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin === new URL(BASE).origin) URLS.add(req.method() + ' ' + u.pathname);
    } catch { /* data:/blob: 等忽略 */ }
  });
}

/** 换号必须清干净该域 cookie：BFF 会把浏览器全部 cookie 原样转给 Frappe。 */
async function login(page, user, pass) {
  await page.goto(BASE + '/login.html', { waitUntil: 'load', timeout: 180000 }).catch(() => {});
  for (const c of await page.cookies(BASE).catch(() => [])) await page.deleteCookie(c).catch(() => {});
  await page.goto(BASE + '/login.html', { waitUntil: 'load', timeout: 180000 }).catch(() => {});
  // 必须把提交按钮传给 requestSubmit(btn)：login.html 的 doLogin 读 e.submitter。
  const filled = await page.evaluate(async (u, p) => {
    const un = document.querySelector('#un');
    if (!un) return 'no-form';
    const pw = document.querySelector('#pw');
    if (!pw) return 'no-pw';
    un.value = u; pw.value = p;
    const form = document.querySelector('form');
    const btn = form?.querySelector('button[type="submit"]') || form?.querySelector('button');
    if (!form || !btn) return 'no-submit';
    form.requestSubmit(btn);
    return 'ok';
  }, user, pass).catch(() => 'err');
  if (filled === 'ok') {
    await page.waitForFunction(() => !location.pathname.includes('login.html'), { timeout: 180000 }).catch(() => {});
  }
  return filled;
}

async function openExcel(page) {
  trackUrls(page);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 }).catch(() => {});
  await page.waitForFunction(
    () => typeof window.shangshuResolvePlatformPage === 'function'
      && window.shangshuResolvePlatformPage('excel', 'staff') === 'excel',
    { timeout: 180000 },
  );
  await page.evaluate(() => { location.hash = '#/excel'; });
  await page.waitForFunction(() => !!document.querySelector('.excel-page'), { timeout: 120000 });
  await page.waitForFunction(() => /共\s*\d+\s*行/.test(document.querySelector('[data-scope]')?.textContent || ''), { timeout: 120000 });
  await page.waitForFunction(() => {
    const grid = document.querySelector('[data-grid]');
    return !!grid && [...grid.querySelectorAll('canvas')].some((c) => c.width > 0);
  }, { timeout: 120000 });
  await sleep(900);
}

const scope = (page) => page.$eval('[data-scope]', (e) => e.textContent || '');
const saveState = (page) => page.$eval('[data-save-state]', (e) => ({ state: e.dataset.state, text: e.textContent })).catch(() => ({ state: '?', text: '' }));
async function waitSave(page, states, timeout = 30000) {
  const list = Array.isArray(states) ? states : [states];
  await page.waitForFunction((l) => l.includes(document.querySelector('[data-save-state]')?.dataset.state), { timeout }, list);
  return saveState(page);
}

/**
 * 定位到某一格。
 *
 * 不能用固定行高去算像素坐标：长文本折行生效后行高会变，24px 的假设会让
 * 「点第 1 行」实际点到别的行，然后把好的判成坏的。
 * 改用「点进网格左上角 → 方向键走过去」，跟行高无关。
 */
async function gotoCell(page, row, col) {
  const box = await page.$eval('[data-grid]', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  // 行头 46 之后再往里一点落在第 1 列；表头 20 之后再往里一点落在第 1 行。
  await page.mouse.click(box.x + ROW_HEAD_W + 20, box.y + HEADER_H + 8);
  await sleep(160);
  for (let i = 0; i < row; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < col; i++) await page.keyboard.press('ArrowRight');
  await sleep(160);
}

async function clickCell(page, row, col) {
  await gotoCell(page, row, col);
}

/** 在单元格里输入并回车提交（Univer 首键进入编辑态）。 */
async function typeCell(page, row, col, text) {
  await gotoCell(page, row, col);
  await page.keyboard.type(text, { delay: 12 });
  await sleep(140);
  await page.keyboard.press('Enter');
  await sleep(220);
}

/**
 * 从已捕获的写请求里取「实际改的那条记录号」。
 * 不猜行号——直接用页面真发出去的那笔请求里的 name，读回才对得上。
 */
function nameFromUpdates(bag) {
  for (let i = bag.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(bag[i].body || '{}')?.payload;
      if (p?.name) return { name: p.name, values: p.values || {} };
    } catch { /* 不是 JSON 就跳过 */ }
  }
  return null;
}

function trackUpdates(page, bag) {
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('platform.object.update/execute')) {
      bag.push({ at: Date.now(), body: req.postData() || '' });
    }
  });
}

async function readRow(page, name) {
  return page.evaluate(async (objId, n) => {
    const r = await fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records/${encodeURIComponent(n)}`, { credentials: 'include', cache: 'no-store' });
    const b = await r.json();
    return { status: r.status, record: b.record || b };
  }, M.object_id, name);
}

/** 只读诊断口：产品侧提供，用来断言「真的滚过去」「行高真的撑开」这类画布内的事。 */
const diag = (page) => page.evaluate(() => (window.excelPageDiag ? window.excelPageDiag() : null)).catch(() => null);

/**
 * 取第 rowIndex 行（0 起）的服务端记录号。
 * 行序固定 name 升序、页大小 100，所以第 N 行 = 第 floor(N/100)+1 页的第 N%100 条。
 * 读回必须对上「实际改的那一行」——对错了行会把好的判成坏的。
 */
async function rowNameAt(page, rowIndex) {
  const pageNo = Math.floor(rowIndex / 100) + 1;
  const offset = rowIndex % 100;
  return page.evaluate(async (objId, p, off) => {
    const r = await fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records?page=${p}&page_length=100&filters=${encodeURIComponent(JSON.stringify({ $sort: 'name', $direction: 'asc' }))}`, { credentials: 'include', cache: 'no-store' }).then((x) => x.json());
    return r.rows?.[off]?.name || null;
  }, M.object_id, pageNo, offset);
}

/**
 * 找列号（0 起）。优先用诊断口；没有就按夹具列序推（跳过 hidden 列）。
 * 夹具列序是这批测试数据的定义，不是猜的。
 */
async function colIndex(page, id, labelRe) {
  const d = await diag(page);
  const fromDiag = (d?.columns || []).findIndex((c) => c.id === id || (labelRe && labelRe.test(c.label || '')));
  if (fromDiag >= 0) return fromDiag;
  const order = (M.columns || []).filter((c) => !c.hidden);
  const fromFixture = order.findIndex((c) => c.id === id || (labelRe && labelRe.test(c.label || '')));
  return fromFixture;
}

/** 在网格中心上方滚动 wheel 事件（Univer 是 canvas 虚拟滚动，只认 wheel，不认 DOM scroll）。 */
async function wheel(page, deltaY, times = 1) {
  const box = await page.$eval('[data-grid]', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel({ deltaY });
    await sleep(90);
  }
}

/** 从可见的查找条读计数文字。 */
const findBar = (page) => page.evaluate(() => ({
  input: document.querySelector('[data-search-input]')?.value ?? null,
  count: document.querySelector('[data-search-count]')?.textContent ?? null,
  hits: document.querySelector('[data-hits-state]')?.textContent ?? null,
  hasNext: !!document.querySelector('[data-search-next]'),
  hasPrev: !!document.querySelector('[data-search-prev]'),
}));

// ——————————————————————————————————————————————————————————
// T1 懒加载：测试通过 = 表滚到第 100 行以下会自动装下一页，
//   「已加载 N 行」涨上去；一路滚到底能看见第 1000 行。
// ——————————————————————————————————————————————————————————
async function T1(page) {
  const before = await scope(page);
  const n0 = Number((before.match(/已加载\s*(\d+)/) || [])[1] || 0);
  const total0 = Number((before.match(/共\s*(\d+)/) || [])[1] || 0);
  // 只记录起点，不当判据：前面的测试可能已经按需装过一些页。
  note(`懒加载起点：已加载 ${n0} / 共 ${total0}`);

  // 连续往下滚。滚轮事件走 CDP 很慢，次数要克制。
  await wheel(page, 8000, 4);
  await sleep(2000);
  const after = await scope(page);
  const n1 = Number((after.match(/已加载\s*(\d+)/) || [])[1] || 0);
  check('T1', '往下滚会自动装入更多行', n1 > n0, `已加载 ${n0} → ${n1}`);

  // 一路滚到底。
  await wheel(page, 60000, 10);
  await sleep(4000);
  const end = await scope(page);
  const n2 = Number((end.match(/已加载\s*(\d+)/) || [])[1] || 0);
  const total = Number((end.match(/共\s*(\d+)/) || [])[1] || 0);
  check('T1', '滚到底能装到全部 1000 行', n2 >= total && total === 1000, `已加载 ${n2} / 共 ${total}`);
}

// ——————————————————————————————————————————————————————————
// T2 查找条：测试通过 = 搜 00123 显示「第 1/2 个」；
//   点 ↓ 跳到下一个、点 ↑ 回上一个；当前命中格有可见高亮。
// ——————————————————————————————————————————————————————————
async function T2(page) {
  // 用 evaluate 驱动，不用 ElementHandle 点击：Univer 是 canvas，
  // Handle 点击容易和画布抢事件把 CDP 拖死。
  const hasInput = await page.evaluate(() => !!document.querySelector('[data-search-input]'));
  if (!hasInput) { check('T2', '有查找条输入框', false, '(没有 [data-search-input])'); return; }

  await page.evaluate(() => {
    const el = document.querySelector('[data-search-input]');
    el.focus();
    el.value = '';
  });
  // 用键盘打字（真实输入路径），回车触发。
  await page.keyboard.type('00123', { delay: 15 });
  await page.keyboard.press('Enter');
  await sleep(1800);

  const bar = await findBar(page);
  check('T2', '查找条有 ↑ / ↓ 两个按钮', bar.hasPrev && bar.hasNext, `prev=${bar.hasPrev} next=${bar.hasNext}`);
  check('T2', '搜 00123 有命中（不是「无匹配」）', !/无匹配/.test(bar.hits || '') && /命中|第/.test((bar.count || '') + (bar.hits || '')), `计数="${bar.count}" 状态="${bar.hits}"`);
  check('T2', '计数是「第 N/M 个」格式', /第\s*\d+\s*\/\s*\d+\s*个/.test(bar.count || ''), `计数="${bar.count}"`);

  const first = bar.count;
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('[data-search-next]');
    if (!b) return false;
    b.click();
    return true;
  });
  if (clicked) {
    await sleep(1200);
    const bar2 = await findBar(page);
    check('T2', '点 ↓ 跳到下一个命中（计数变了）', bar2.count !== first, `"${first}" → "${bar2.count}"`);
    const back = await page.evaluate(() => {
      const b = document.querySelector('[data-search-prev]');
      if (!b) return false;
      b.click();
      return true;
    });
    if (back) {
      await sleep(1200);
      const bar3 = await findBar(page);
      check('T2', '点 ↑ 回到上一个命中', bar3.count === first, `"${bar3.count}"`);
    } else {
      check('T2', '点 ↑ 回到上一个命中', false, '(没有 [data-search-prev])');
    }
  } else {
    check('T2', '点 ↓ 跳到下一个命中', false, '(没有 [data-search-next])');
    check('T2', '点 ↑ 回到上一个命中', false, '(没有 [data-search-prev])');
  }

  // 高亮：画布内，走只读诊断口。
  const d = await diag(page);
  check('T2', '当前命中格有可见高亮', !!d?.highlight, d ? `highlight=${JSON.stringify(d.highlight)}` : '(诊断口 excelPageDiag 不可用)');
}

// ——————————————————————————————————————————————————————————
// T3 跳转：测试通过 = 点命中 / 按 ↓ 之后，被定位那一行真的出现在可视区内
//   （不是只改选区、屏幕没动）。
// ——————————————————————————————————————————————————————————
async function T3(page) {
  // 自己走一遍定位，不依赖上一条测试留下的状态。
  // 装行时会触发行高重算、把视口挤走，所以量之前要等稳定。
  // 必须真打字：直接赋 .value 不会触发 input，回车会被当成「跳下一个」。
  await page.evaluate(() => {
    const el = document.querySelector('[data-search-input]');
    el.focus(); el.select();
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('00123', { delay: 15 });
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.evaluate(() => document.querySelector('[data-search-next]')?.click());
  await sleep(800);
  await page.evaluate(() => document.querySelector('[data-search-prev]')?.click());
  await sleep(1500);

  const hitsText = await page.$eval('[data-hits-state]', (e) => e.textContent || '').catch(() => '');
  const rowText = /已定位到第\s*(\d+)\s*行/.exec(hitsText || '');
  if (!rowText) { check('T3', '给出了「已定位到第 N 行」', false, `状态="${hitsText}"`); return; }
  const target = Number(rowText[1]) - 1;   // 界面 1 起，内部 0 起
  check('T3', '给出了「已定位到第 N 行」', true, `第 ${target + 1} 行`);

  // 等行高懒算落定；必要时再读一次。
  let d = await diag(page);
  let [a, b] = d?.visibleRows ?? [-1, -1];
  if (!(target >= a && target <= b)) {
    await sleep(2500);
    d = await diag(page);
    [a, b] = d?.visibleRows ?? [-1, -1];
  }
  check('T3', '被定位那一行真的滚进了可视区', target >= a && target <= b, `可视 ${a + 1}–${b + 1} 行，目标 ${target + 1} 行`);
  check('T3', '高亮就落在那一格', d?.highlight?.rowIndex === target, `highlight=${JSON.stringify(d?.highlight)} 目标 ${target}`);
}

// ——————————————————————————————————————————————————————————
// T4 数值保存：测试通过 = 改「金额」格存 1234.56 → 保存成功、
//   读回是数值 1234.56，不再报「应为 number」；输非数字给明确提示且不发请求。
// ——————————————————————————————————————————————————————————
async function T4(page, ctx) {
  const d = await diag(page);
  const jine = await colIndex(page, 'jine', /金额/);
  if (jine < 0) { check('T4', '找到「金额」列', false, `cols=${JSON.stringify((d?.columns || M.columns || []).map((c) => c.label || c.id))}`); return; }
  check('T4', '找到「金额」列', true, `第 ${jine + 1} 列`);

  const updates = [];
  trackUpdates(page, updates);

  // 值每次都要不一样：跟上次相同的话，产品认为「没改」不发请求，那是对的。
  const amount = Number((Date.now() % 100000) + 0.56);
  await typeCell(page, 1, jine, String(amount));
  const sent = nameFromUpdates(updates);
  const rowName = sent?.name;
  if (!rowName) { check('T4', '取到被改那一行的记录号', false, `写请求 ${updates.length} 笔`); return; }
  const st = await waitSave(page, ['saved', 'failed', 'conflict'], 30000).catch(() => saveState(page));
  check('T4', '改「金额」格能保存成功（不再报「应为 number」）', st.state === 'saved', `存 ${amount}；状态=${st.state} 文案="${st.text}"`);

  const back = await readRow(page, rowName);
  const v = back.record?.jine;
  check('T4', '读回是数值（不是字符串、不是被拒）', Number(v) === amount, `记录 ${rowName} 存 ${amount}，读回=${JSON.stringify(v)} 类型=${typeof v}`);
  check('T4', '写请求里带的是数字不是字符串', typeof sent.values.jine === 'number', `提交值=${JSON.stringify(sent.values.jine)} 类型=${typeof sent.values.jine}`);

  // 非数字：应就地提示、不发请求。
  const before = updates.length;
  await typeCell(page, 2, jine, '不是数字');
  await sleep(1500);
  const st2 = await saveState(page);
  check('T4', '金额输非数字给明确提示', /数字|number|不合法|不正确/.test(st2.text || ''), `文案="${st2.text}"`);
  check('T4', '金额输非数字不发写请求', updates.length === before, `写请求 ${before} → ${updates.length}`);
}

// ——————————————————————————————————————————————————————————
// T5 重试：测试通过 = 断网改一格 → 失败并保留内容 → 界面上有可点的
//   「重试原操作」→ 恢复网络点重试 → 值落库且只落一次（幂等）。
// ——————————————————————————————————————————————————————————
async function T5(page, ctx) {
  const marker = '断网重试-' + Date.now().toString(36);
  const updates = [];
  trackUpdates(page, updates);

  await ctx.browser.setOfflineMode?.(true).catch(() => {});
  // puppeteer 的离线在部分版本是 page 级
  await page.setOfflineMode(true).catch(() => {});
  await sleep(300);

  await typeCell(page, 3, 1, marker);   // 第 4 行「名称」
  const sent = nameFromUpdates(updates);
  const rowName = sent?.name;
  const st = await waitSave(page, ['failed', 'conflict'], 25000).catch(() => saveState(page));
  check('T5', '断网保存会失败并明示', st.state === 'failed' || st.state === 'conflict', `状态=${st.state} 文案="${st.text}"`);

  const retryVisible = await page.evaluate(() => {
    const b = document.querySelector('[data-retry]');
    return !!b && !b.hidden && /重试/.test(b.textContent || '');
  });
  check('T5', '界面上有可点的「重试原操作」', retryVisible, '');

  // 内容还在（未被清掉）
  const cellStill = await page.evaluate(() => document.querySelector('[data-save-state]')?.textContent || '');
  note(`失败态文案：${cellStill}`);

  await page.setOfflineMode(false).catch(() => {});
  await ctx.browser.setOfflineMode?.(false).catch(() => {});
  await sleep(500);

  const clicked = await page.evaluate(() => {
    const b = document.querySelector('[data-retry]');
    if (!b || b.hidden) return false;
    b.click();
    return true;
  });
  check('T5', '能点下「重试原操作」', clicked, '');

  const st2 = await waitSave(page, ['saved', 'failed', 'conflict'], 30000).catch(() => saveState(page));
  check('T5', '重试后保存成功', st2.state === 'saved', `状态=${st2.state} 文案="${st2.text}"`);

  // 幂等：恢复后总共只落一次实际写。
  const writes = updates.length;
  check('T5', '值只落一次（幂等重试不重复写）', writes <= 2, `断网期 + 重试共 ${writes} 次写请求`);

  const back = await readRow(page, rowName);
  check('T5', '重试的值真实落库', String(back.record?.mingcheng || '') === marker, `记录 ${rowName} 读回=${JSON.stringify(back.record?.mingcheng)}`);
}

// ——————————————————————————————————————————————————————————
// T6 通知：测试通过 = 保存成功/失败时右下角弹出有色通知
//   （成功绿 #10B981、失败红 #DC4444），约 3 秒后自动消失。
// ——————————————————————————————————————————————————————————
async function T6(page) {
  const updates = [];
  trackUpdates(page, updates);
  await typeCell(page, 4, 1, '通知测试-' + Date.now().toString(36));
  await sleep(700);

  const toast = await page.evaluate(() => {
    const zone = document.querySelector('#toast-zone');
    const t = zone?.querySelector('.toast');
    if (!t) return null;
    const cs = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    return {
      text: t.textContent || '',
      isError: t.classList.contains('toast-error'),
      bg: cs.backgroundColor,
      color: cs.color,
      visible: r.width > 0 && r.height > 0,
      atBottomRight: r.right > window.innerWidth - 240 && r.bottom > window.innerHeight - 200,
    };
  });
  check('T6', '右下角弹出了通知', !!toast && toast.visible, toast ? JSON.stringify({ text: toast.text.slice(0, 40), bg: toast.bg }) : '(没有 .toast)');
  if (toast) {
    check('T6', '通知在页面右下角', toast.atBottomRight, `bg=${toast.bg}`);
    check('T6', '通知文字与底色有对比（不是白底白字）', toast.color !== toast.bg, `color=${toast.color} bg=${toast.bg}`);
    check('T6', '通知有底色（绿或红）', toast.bg !== 'rgba(0, 0, 0, 0)' && toast.bg !== 'transparent', `bg=${toast.bg}`);
  }

  // toast 自身约 3.2 秒后淡出、0.3 秒移除，等够 5 秒再看。
  await sleep(5200);
  // 只有真弹过才谈得上「自动消失」；没弹过时这条不能算过（否则是假阳性）。
  if (toast) {
    const gone = await page.evaluate(() => !document.querySelector('#toast-zone .toast'));
    check('T6', '通知会自动消失', gone, '');
  } else {
    check('T6', '通知会自动消失（前提：弹出过）', false, '(没弹出过，无法验证自动消失)');
  }
}

// ——————————————————————————————————————————————————————————
// T7 折行：测试通过 = 353 字带换行的备注在格子里折成多行、行高撑开；
//   Alt+Enter 能插入换行；回车仍是提交。
// ——————————————————————————————————————————————————————————
async function T7(page) {
  const d = await diag(page);
  const beizhu = await colIndex(page, 'beizhu', /备注/);
  const beizhuId = (d?.columns || M.columns || []).find((c) => c.id === 'beizhu' || /备注/.test(c.label || ''))?.id || 'beizhu';
  if (beizhu < 0) { check('T7', '找到「备注」列', false, `cols=${JSON.stringify((d?.columns || M.columns || []).map((c) => c.label || c.id))}`); return; }
  check('T7', '找到「备注」列', true, `第 ${beizhu + 1} 列`);

  const long = ('很长的备注内容需要折行显示。'.repeat(12) + '\n第二段也要换行。' + '第三段继续。'.repeat(10)).slice(0, 353);
  await typeCell(page, 5, beizhu, long.replace(/\n/g, ' '));   // 先存进去
  const st = await waitSave(page, ['saved', 'failed', 'conflict'], 30000).catch(() => saveState(page));
  check('T7', '长备注能保存', st.state === 'saved', `状态=${st.state}`);

  const d2 = await diag(page);
  const wrapOn = !!d2?.wrapColumns?.includes(beizhuId);
  check('T7', '备注列设了折行', wrapOn, `wrapColumns=${JSON.stringify(d2?.wrapColumns)}`);

  const rowH = d2?.rowHeights?.[5];
  const baseH = d2?.defaultRowHeight || 24;
  check('T7', '长备注把行高撑开了', typeof rowH === 'number' && rowH > baseH + 2, `行高=${rowH} 默认=${baseH}`);

  // Alt+Enter 插入换行，回车提交。
  const xy = await clickCell(page, 6, beizhu);
  await page.keyboard.type('甲', { delay: 15 });
  await page.keyboard.down('Alt');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Alt');
  await page.keyboard.type('乙', { delay: 15 });
  await page.keyboard.press('Enter');
  await sleep(1500);
  const st2 = await waitSave(page, ['saved', 'failed', 'conflict'], 20000).catch(() => saveState(page));
  const back = await page.evaluate(async (objId, idx, colId) => {
    const r = await fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records?page=${idx + 1}&page_length=1&filters=${encodeURIComponent(JSON.stringify({ $sort: 'name', $direction: 'asc' }))}`, { credentials: 'include', cache: 'no-store' }).then((x) => x.json());
    return r.rows?.[0]?.[colId] ?? null;
  }, M.object_id, 6, beizhuId);
  // Univer 的换行符是 \r，不是 \n——认错会把本来好的判成坏的。
  check('T7', 'Alt+Enter 插入的换行被保存下来', /[\r\n]/.test(String(back || '')), `读回=${JSON.stringify(back)}`);
  check('T7', '回车仍是提交（保存态到达）', st2.state === 'saved', `状态=${st2.state}`);
}

// ——————————————————————————————————————————————————————————
// T8 修改日志：测试通过 = 改一格之后，**服务端确实把这次改动存下来了**
//   —— 操作编号 / 改动人 / 中文列名 / 改前值 / 改后值 五样齐全；
//   并且界面上**不再显示**修改记录（日志存证即可，不做给人看的日志页）。
// ——————————————————————————————————————————————————————————
async function T8(page) {
  // 先改一格，制造一条真实改动。
  const marker = '日志存证-' + Date.now().toString(36);
  const rowName = await rowNameAt(page, 2);
  await typeCell(page, 2, 1, marker);
  const st = await waitSave(page, ['saved', 'failed', 'conflict'], 30000).catch(() => saveState(page));
  check('T8', '先存下一格改动', st.state === 'saved', `状态=${st.state}`);

  // 直接查服务端存下的修改记录（按行查：object_id + name 都必填）。
  const history = await page.evaluate(async (objId, n) => {
    const r = await fetch('/api/platform/services/platform.object.history/invoke', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ payload: { object_id: objId, name: n, page: 1, page_length: 50 } }),
    });
    return { status: r.status, body: await r.json() };
  }, M.object_id, rowName);
  const items = history.body?.items || history.body?.result?.items || [];

  check('T8', '服务端存下了这次改动', history.status === 200 && items.length > 0, `HTTP ${history.status}，条目 ${items.length}`);
  if (!items.length) return;

  const mine = items.find((it) => (it.changes || []).some((c) => String(c.after ?? '') === marker)) || items[0];
  const changes = mine.changes || [];
  check('T8', '日志带操作编号', !!mine.op_id, `op_id=${JSON.stringify(mine.op_id)}`);
  check('T8', '日志带改动人', !!mine.actor, `actor=${JSON.stringify(mine.actor)}`);
  check('T8', '日志带时间', !!mine.time, `time=${JSON.stringify(mine.time)}`);
  check('T8', '日志带中文列名（不是字段代码）', changes.some((c) => /[\u4e00-\u9fa5]/.test(String(c.label || ''))), JSON.stringify(changes.map((c) => c.label)));
  check('T8', '日志带改前改后值', changes.some((c) => 'before' in c && 'after' in c), JSON.stringify(changes.map((c) => ({ f: c.label, b: c.before, a: String(c.after ?? '').slice(0, 20) }))));

  // 反过来：界面上不该再出现修改记录入口。
  const ui = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button,a')].find((x) => /修改记录|变更历史|操作日志/.test(x.textContent || ''));
    return { btn: btn ? btn.textContent.trim() : null, panel: !!document.querySelector('[data-history],.excel-history') };
  });
  check('T8', '界面上不显示修改记录（只在后端存证）', !ui.btn && !ui.panel, `入口=${JSON.stringify(ui.btn)} 面板=${ui.panel}`);
}

// ——————————————————————————————————————————————————————————
// 主流程
// ——————————————————————————————————————————————————————————
async function main() {
  let browser;
  let page;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, protocolTimeout: 180000 });
  } catch (e) {
    console.error(`连不上本机 Chrome 调试口 ${DEBUG_PORT}：${e.message}`);
    process.exit(2);
  }
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

  console.log('\n== 登录 A 账号 ==');
  await login(page, M.accounts.a, S.a);
  await openExcel(page);
  check('T0', 'A 账号打开表', /共\s*\d+\s*行/.test(await scope(page)), await scope(page));

  const rowName = await page.evaluate((objId) => fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records?page=1&page_length=1&filters=${encodeURIComponent(JSON.stringify({ $sort: 'name', $direction: 'asc' }))}`, { credentials: 'include', cache: 'no-store' }).then((r) => r.json()).then((b) => b.rows?.[0]?.name || null), M.object_id);

  const run = async (id, title, fn) => {
    if (!want(id)) return;
    console.log(`\n== ${id} ${title} ==`);
    try {
      await fn();
    } catch (e) {
      // 一条崩了不影响其余：记成该项未通过，并把原因原样留下。
      check(id, `${id} 整条跑完（未抛错）`, false, e?.message || String(e));
    }
  };

  await run('T2', '查找条', () => T2(page));
  await run('T3', '跳转真的滚过去', () => T3(page));
  await run('T4', '数值列保存', () => T4(page, { rowName }));
  await run('T6', '通知', () => T6(page));
  await run('T7', '折行与多行编辑', () => T7(page));
  await run('T8', '修改记录', () => T8(page));
  await run('T5', '断网重试', () => T5(page, { browser, rowName }));
  await run('T1', '懒加载', () => T1(page));

  // 无论跑没跑完都要关页：标签页越积越多，Chrome 会越跑越慢。
  } finally {
    await page?.close().catch(() => {});
    await browser?.disconnect?.().catch(() => {});
    const pass = CHECKS.filter((c) => c.ok).length;
    const fail = CHECKS.filter((c) => !c.ok).length;
    console.log(`\n== 结果：${pass} 通过 / ${fail} 未通过（共 ${CHECKS.length}） ==`);
    writeFileSync(JSON_OUT, JSON.stringify({ pass, fail, checks: CHECKS, notes: NOTES, urls: [...URLS] }, null, 2));
    console.log(`明细已写入 ${JSON_OUT}`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
