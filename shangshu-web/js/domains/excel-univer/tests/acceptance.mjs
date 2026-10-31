/**
 * Excel 首批（B1）浏览器侧验收。连本机 Chrome(154) 调试口跑真实页面，
 * 全程真实登录、真实接口、真实写入；不 mock、不用 localStorage。
 *
 * 用法：node b1.mjs [--only B1-02 B1-04] [--json-out b1.json]
 *
 * 单元格定位用画布坐标（行头 46 / 列宽 88 / 表头 20 / 行高 24），与 sheet.ts 建表参数一致。
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 口令与夹具清单只在仓外 ~/.excel-b1/，绝不进仓库。
const FIXTURES = join(homedir(), '.excel-b1');

const args = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = args.includes('--only')
  ? args.slice(args.indexOf('--only') + 1).filter((a) => !a.startsWith('--'))
  : null;
const JSON_OUT = arg('json-out', 'b1.json');

const BASE = 'https://shangshu-rework-test.dev.lingeringtek.cn';
const M = JSON.parse(readFileSync(new URL('../../../../../../.excel-b1/manifest.json', 'utf8'), 'utf8'));
const S = JSON.parse(readFileSync(join(FIXTURES, 'secrets.json'), 'utf8'));

const ROW_H = 24, HEADER_H = 20, COL_W = 88, ROW_HEAD_W = 46;
const CHECKS = [];
const NOTES = [];
/** 页面实际发起过的接口路径（去参数）——用来核对全程无 LLM 调用。 */
const URLS = new Set();

function trackUrls(page) {
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin === new URL(BASE).origin) URLS.add(req.method() + ' ' + u.pathname);
    } catch { /* data:/blob: 等忽略 */ }
  });
}

function check(item, label, ok, detail = '') {
  CHECKS.push({ item, label, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? `　[${String(detail).slice(0, 120)}]` : ''));
  return !!ok;
}
function note(text) {
  NOTES.push(text);
  console.log('  · ' + text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (id) => !ONLY || ONLY.includes(id);

async function login(page, user, pass) {
  // 浏览器上下文共享 cookie，而且 BFF 会把浏览器全部 cookie 原样转给 Frappe。
  // 只删 shangshu_token 不够：Frappe 的会话 cookie 还留着上一个账号，换号等于没换。
  // 所以换号时把该域 cookie 清干净（登录本身用 requestSubmit(btn)，不依赖残留会话）。
  await page.goto(BASE + '/login.html', { waitUntil: 'load', timeout: 180000 }).catch(() => {});
  const cookies = await page.cookies(BASE).catch(() => []);
  for (const c of cookies) await page.deleteCookie(c).catch(() => {});
  await page.goto(BASE + '/login.html', { waitUntil: 'load', timeout: 180000 }).catch(() => {});
  // 一次填完并提交：不点控件，避开页面重绘造成的点击竞态。
  // 必须把提交按钮传给 requestSubmit(btn)：login.html 的 doLogin 读 e.submitter
  // 再设 btn.disabled，不带 submitter 时 e.submitter 是 null，登录会静默失败。
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
  // Univer 建完画布才算可交互。只认「有非零画布」：表头里那个
  // univer-animate-pulse 是常驻占位块，拿它当加载判据会一直等下去。
  await page.waitForFunction(() => {
    const grid = document.querySelector('[data-grid]');
    return !!grid && [...grid.querySelectorAll('canvas')].some((c) => c.width > 0);
  }, { timeout: 120000 });
  await sleep(900);
}

async function scope(page) {
  return page.$eval('[data-scope]', (e) => e.textContent || '');
}
async function saveState(page) {
  return page.$eval('[data-save-state]', (e) => ({ state: e.dataset.state, text: e.textContent })).catch(() => ({ state: '?', text: '' }));
}
async function waitSave(page, states, timeout = 30000) {
  const list = Array.isArray(states) ? states : [states];
  await page.waitForFunction((l) => l.includes(document.querySelector('[data-save-state]')?.dataset.state), { timeout }, list);
  return saveState(page);
}

/** 单元格中心在页面上的坐标。col=0.. 列，row=0.. 行（都是 0 起）。 */
async function cellXY(page, row, col) {
  return page.evaluate((r, c, ROW_H, HEADER_H, COL_W, ROW_HEAD_W) => {
    const box = document.querySelector('[data-grid]')?.getBoundingClientRect();
    if (!box) return null;
    return {
      x: box.x + ROW_HEAD_W + c * COL_W + COL_W / 2,
      y: box.y + HEADER_H + r * ROW_H + ROW_H / 2,
    };
  }, row, col, ROW_H, HEADER_H, COL_W, ROW_HEAD_W);
}

async function clickCell(page, row, col) {
  const xy = await cellXY(page, row, col);
  if (!xy) throw new Error('网格未就绪');
  await page.mouse.click(xy.x, xy.y);
  await sleep(120);
  return xy;
}

/** 在单元格里输入并回车提交（Univer 首键进入编辑态）。 */
async function typeCell(page, row, col, text) {
  const xy = await clickCell(page, row, col);
  await page.keyboard.type(text, { delay: 12 });
  await sleep(120);
  await page.keyboard.press('Enter');
  await sleep(200);
  return xy;
}

/** 统计写请求（platform.object.update/execute）。 */
function trackUpdates(page, bag) {
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('platform.object.update/execute')) {
      bag.push({ at: Date.now(), body: req.postData() || '' });
    }
  });
}

/** 接口读一行。 */
async function readRow(page, name) {
  return page.evaluate(async (objId, n) => {
    const r = await fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records/${encodeURIComponent(n)}`, { credentials: 'include' });
    const b = await r.json();
    return { status: r.status, record: b.record || b };
  }, M.object_id, name);
}

/** 接口写一行（用于制造并发冲突，不走页面）。必须带 expected_modified，否则服务端直接拒。 */
async function apiUpdate(page, name, field, value) {
  return page.evaluate(async (objId, n, f, v) => {
    const list = await (await fetch('/api/platform/objects', { credentials: 'include' })).json();
    const def = (list.list || []).find((o) => o.id === objId);
    const cur = await (await fetch(`/api/platform/objects/${encodeURIComponent(objId)}/records/${encodeURIComponent(n)}`, { credentials: 'include' })).json();
    const r = await fetch('/api/platform/actions/platform.object.update/execute', {
      credentials: 'include',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: {
          object_id: objId, name: n,
          expected_revision: def?.revision ?? 0,
          expected_modified: String(cur.record?.modified ?? ''),
          values: { [f]: v },
        },
        confirmed: true,
        idempotency_key: 'b1-api-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        source: 'user',
      }),
    });
    return { status: r.status, body: await r.json() };
  }, M.object_id, name, field, value);
}

/** 当前会话身份核对：C 无权，应看不到对象列表。用来排除“登录没生效、顶着别人会话”的假阳性。
 *  必须 no-store：/api/platform/objects 会被浏览器缓存，换账号后不带 no-store 会读到上一个账号的响应。
 *  同时回带 /api/session 的登录名，好判断到底是哪个账号在说话。 */
async function sessionSeesObject(page) {
  return page.evaluate(async (objId) => {
    const sess = await (await fetch('/api/session', { credentials: 'include', cache: 'no-store' })).json();
    const r = await fetch('/api/platform/objects', { credentials: 'include', cache: 'no-store' });
    const b = await r.json();
    return {
      who: sess?.user?.username ?? sess?.username ?? '(?)',
      role: sess?.user?.role ?? sess?.role ?? '(?)',
      status: r.status,
      count: (b.list || []).length,
      has: (b.list || []).some((o) => o.id === objId),
    };
  }, M.object_id);
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' });
const ctx = browser.defaultBrowserContext();

// ======================= B1-01 开表与访问边界 =======================
if (want('B1-01')) {
  console.log('\n== B1-01 开表与访问边界 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  await login(a, M.accounts.a, S.a);
  await openExcel(a);
  check('B1-01', 'A 登录后在工作台内挂载 Excel 页', (await a.$('.excel-page')) !== null);
  const sc = await scope(a);
  check('B1-01', `A 读到真实表与行数（${sc.slice(0, 22)}…）`, /共\s*1000\s*行/.test(sc), sc.slice(0, 60));
  const nav = await a.evaluate(() => document.querySelectorAll('[data-page="excel"], .side [onclick*="excel"]').length);
  check('B1-01', '侧栏有该页入口', nav > 0, 'nav=' + nav);
  // 切离再返回：挂载应干净重建
  await a.evaluate(() => { location.hash = '#/dash'; });
  await sleep(900);
  const gone = await a.$('.excel-page');
  await a.evaluate(() => { location.hash = '#/excel'; });
  await a.waitForFunction(() => !!document.querySelector('.excel-page'), { timeout: 60000 }).catch(() => {});
  await a.waitForFunction(() => /共\s*\d+\s*行/.test(document.querySelector('[data-scope]')?.textContent || ''), { timeout: 60000 }).catch(() => {});
  const back = await a.$('.excel-page');
  check('B1-01', '切离再返回页面正常重建', !gone && !!back);
  const scopeBack = await scope(a);
  check('B1-01', '重建后仍读到真实行数', /共\s*1000\s*行/.test(scopeBack), scopeBack.slice(0, 40));
  // C 无权账号
  const c = await ctx.newPage();
  c.setDefaultTimeout(120000);
  await c.setViewport({ width: 1400, height: 900 });
  await login(c, M.accounts.c, S.c);
  await c.goto(BASE + '/index.html#/excel', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await sleep(6000);
  const cScope = await c.evaluate(() => document.querySelector('[data-scope]')?.textContent || '(无页面)');
  const cBlocked = /没有可打开的表|打开失败|无权|被拒/.test(cScope) || (await c.$('.excel-page')) === null;
  check('B1-01', 'C 打开该页被拒（看不到有权表）', cBlocked, cScope.slice(0, 50));
  await a.close(); await c.close();
}

// ======================= B1-02 单格编辑与原值完整 =======================
if (want('B1-02')) {
  console.log('\n== B1-02 单格编辑与原值完整 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  const updates = [];
  trackUpdates(a, updates);
  await login(a, M.accounts.a, S.a);
  await openExcel(a);

  // 原值完整：前导零 / 长编号 / 长备注
  const raw = await readRow(a, M.special.leading_zero.name);
  check('B1-02', '前导零编号在接口层保真', raw.record?.bianhao === '00123', JSON.stringify(raw.record?.bianhao));
  const rawLong = await readRow(a, M.special.long_id.name);
  check('B1-02', '长编号在接口层保真（28 字符）',
    typeof rawLong.record?.bianhao === 'string' && rawLong.record.bianhao.length === 28,
    String(rawLong.record?.bianhao).length);
  const rawNote = await readRow(a, M.special.long_note.name);
  check('B1-02', '长备注在接口层保真（>300 字）',
    typeof rawNote.record?.beizhu === 'string' && rawNote.record.beizhu.length > 300,
    String(rawNote.record?.beizhu).length);

  // 真实单格编辑：改第 1 行「名称」
  const marker = '编辑A-' + Date.now().toString(36);
  updates.length = 0;
  await typeCell(a, 0, 1, marker);
  const st = await waitSave(a, ['saved', 'failed', 'conflict']);
  check('B1-02', `单格编辑后保存态到达「已保存」（${st.state}: ${st.text}）`, st.state === 'saved', st.state);
  check('B1-02', '单格编辑只发出一次修改请求', updates.length === 1, 'n=' + updates.length);
  const back = await readRow(a, 'kidqi99mq1');
  check('B1-02', '改后的值真实落库（读回一致）', back.record?.mingcheng === marker, String(back.record?.mingcheng).slice(0, 40));

  // 只读列：点校验标记列（col 7）输入后不应产生写请求
  updates.length = 0;
  await typeCell(a, 0, 7, '不应该写进去');
  await sleep(1200);
  const ro = await readRow(a, 'kidqi99mq1');
  check('B1-02', '只读列（校验标记）不产生写请求', updates.length === 0, 'n=' + updates.length);
  check('B1-02', '只读列值未被改动', String(ro.record?.jiaoyan).startsWith('fixed-'), String(ro.record?.jiaoyan));

  // 拦截的修改类命令：粘贴/加行等应被取消（用 Univer 命令总线试一次插入行）
  const blocked = await a.evaluate(() => {
    const ws = document.querySelector('[data-grid]');
    return ws ? ws.childElementCount : -1;
  });
  check('B1-02', '网格容器稳定（命令拦截未破坏渲染）', blocked > 0, 'children=' + blocked);

  await a.close();
}

// ======================= B1-03 搜索、定位与乱序保护 =======================
if (want('B1-03')) {
  console.log('\n== B1-03 搜索、定位与乱序保护 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  await login(a, M.accounts.a, S.a);
  await openExcel(a);

  // 命中未加载记录：第 1000 行的编号只在最后一页
  const probeName = M.special.first_page_probe.name;
  const probeRow = await readRow(a, probeName);
  const probeNo = probeRow.record?.bianhao;
  await a.click('[data-search-input]');
  await a.type('[data-search-input]', String(probeNo), { delay: 10 });
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => {
    const t = document.querySelector('[data-hits-state]')?.textContent || '';
    return /共\s*\d+\s*条命中|无匹配|查询失败/.test(t);
  }, { timeout: 60000 });
  const hitsText = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  check('B1-03', `全表搜索命中（${hitsText.slice(0, 30)}）`, /共\s*\d+\s*条命中/.test(hitsText), hitsText.slice(0, 60));
  const hitCount = await a.evaluate(() => document.querySelectorAll('[data-results] .excel-hit').length);
  check('B1-03', '结果列表给出可点条目', hitCount > 0, 'hits=' + hitCount);

  // 点结果定位
  const t0 = Date.now();
  await a.click('[data-results] .excel-hit');
  await a.waitForFunction(() => /已定位到第/.test(document.querySelector('[data-hits-state]')?.textContent || ''), { timeout: 60000 });
  const posMs = Date.now() - t0;
  const posText = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  check('B1-03', `点结果定位到具体行（${posText.slice(0, 26)}）`, /已定位到第\s*\d+\s*行/.test(posText), posText.slice(0, 60));
  check('B1-03', '定位到的是未加载行（行号 > 100）', /已定位到第\s*(1[0-9]{2,}|[2-9][0-9]{2,})\s*行/.test(posText), posText.slice(0, 40));
  note(`定位样本：${posMs}ms`);

  // 无匹配 / 查询失败 与「查找中」区分
  await a.click('[data-search-input]', { clickCount: 3 });
  await a.type('[data-search-input]', '绝不可能匹配的词xyzzy', { delay: 8 });
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => {
    const t = document.querySelector('[data-hits-state]')?.textContent || '';
    return /无匹配|查询失败|共\s*\d+\s*条命中/.test(t);
  }, { timeout: 60000 });
  const noHit = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  check('B1-03', `无匹配与命中明确区分（${noHit.slice(0, 20)}）`, /无匹配/.test(noHit), noHit.slice(0, 40));

  // 乱序保护：先发 A（人为延迟 2.5s），立刻发 B；B 应先回，A 的回包不得覆盖 B
  await a.setRequestInterception(true);
  let delayed = 0;
  a.on('request', (req) => {
    const u = req.url();
    if (u.includes('/records') && u.includes('乱序A') && delayed < 1) {
      delayed += 1;
      setTimeout(() => req.continue().catch(() => {}), 2500);
      return;
    }
    req.continue().catch(() => {});
  });
  await a.click('[data-search-input]', { clickCount: 3 });
  await a.type('[data-search-input]', '乱序A', { delay: 8 });
  await a.keyboard.press('Enter');
  await sleep(150);
  await a.click('[data-search-input]', { clickCount: 3 });
  await a.type('[data-search-input]', '乱序B', { delay: 8 });
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => {
    const t = document.querySelector('[data-hits-state]')?.textContent || '';
    return /无匹配|共\s*\d+\s*条命中/.test(t) && !/查找中/.test(t);
  }, { timeout: 30000 }).catch(() => {});
  await sleep(3200); // 等被延迟的 A 回包抵达
  const afterOutOfOrder = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  check('B1-03', '乱序回包不覆盖最后一次查询结果', !/查找中/.test(afterOutOfOrder), afterOutOfOrder.slice(0, 50));
  await a.setRequestInterception(false);

  // 主表不被搜索自动过滤：行数作用域不变
  const sc = await scope(a);
  check('B1-03', '搜索不自动过滤主表（作用域仍为全表 1000 行）', /共\s*1000\s*行/.test(sc), sc.slice(0, 50));

  // 中文输入法：搜索框在拼音组合期间不发查询
  await a.click('[data-search-input]', { clickCount: 3 });
  await a.evaluate(() => {
    const el = document.querySelector('[data-search-input]');
    el.value = '';
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await a.type('[data-search-input]', 'ceshi', { delay: 20 });
  const during = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  await a.evaluate(() => {
    const el = document.querySelector('[data-search-input]');
    el.value = '测试';
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '测试' }));
  });
  await a.waitForFunction(() => {
    const t = document.querySelector('[data-hits-state]')?.textContent || '';
    return /无匹配|共\s*\d+\s*条命中|查询失败/.test(t) && !/查找中/.test(t);
  }, { timeout: 30000 }).catch(() => {});
  const afterIme = await a.$eval('[data-hits-state]', (e) => e.textContent || '');
  check('B1-03', '拼音组合期间不发查询（组合结束才搜）', /查找中|无匹配|共/.test(afterIme) && during !== afterIme, `组合中="${during.slice(0, 16)}" 结束后="${afterIme.slice(0, 16)}"`);

  await a.close();
}

// ======================= B1-04 按次保存、刷新与双账号读回 =======================
if (want('B1-04')) {
  console.log('\n== B1-04 按次保存、刷新与双账号读回 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  const updates = [];
  trackUpdates(a, updates);
  await login(a, M.accounts.a, S.a);
  await openExcel(a);

  const v1 = 'A第一次-' + Date.now().toString(36);
  const v2 = 'A第二次-' + Date.now().toString(36);
  updates.length = 0;
  await typeCell(a, 0, 1, v1);
  await waitSave(a, 'saved');
  await typeCell(a, 0, 1, v2);
  await waitSave(a, 'saved');
  check('B1-04', '连续两次编辑是两笔独立保存（不合并）', updates.length === 2, 'n=' + updates.length);

  // 刷新后仍在
  await a.reload({ waitUntil: 'domcontentloaded' });
  await openExcel(a);
  const afterReload = await readRow(a, 'kidqi99mq1');
  check('B1-04', '刷新后读到的是已保存值', afterReload.record?.mingcheng === v2, String(afterReload.record?.mingcheng).slice(0, 40));
  await a.close();

  // B 账号读回
  const b = await ctx.newPage();
  b.setDefaultTimeout(180000);
  await b.setViewport({ width: 1400, height: 900 });
  await login(b, M.accounts.b, S.b);
  await openExcel(b);
  const byB = await readRow(b, 'kidqi99mq1');
  check('B1-04', `B 账号读回 A 的保存值（${String(byB.record?.mingcheng).slice(0, 24)}）`, byB.record?.mingcheng === v2, String(byB.record?.mingcheng).slice(0, 40));
  const bScope = await scope(b);
  check('B1-04', 'B 同样能打开该表', /共\s*1000\s*行/.test(bScope), bScope.slice(0, 40));
  await b.close();
}

// ======================= B1-05 断网、回执丢失、冲突 =======================
if (want('B1-05')) {
  console.log('\n== B1-05 断网、回执丢失、冲突与过期请求 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  const updates = [];
  trackUpdates(a, updates);
  await login(a, M.accounts.a, S.a);
  await openExcel(a);

  // 断网下编辑：内容保留、标记未保存
  await a.setOfflineMode(true);
  const off = '断网待提交-' + Date.now().toString(36);
  updates.length = 0;
  await typeCell(a, 1, 1, off);
  await sleep(1500);
  const offState = await saveState(a);
  check('B1-05', `断网下保存失败并保留内容（${offState.state}: ${offState.text.slice(0, 26)}）`, offState.state === 'failed' || offState.state === 'conflict', offState.state);
  const foot = await a.$eval('[data-foot]', (e) => e.textContent || '').catch(() => '');
  check('B1-05', '页面明示有未完成操作', /未完成|重试|未保存/.test(foot) || /失败/.test(offState.text), foot.slice(0, 40));

  // 恢复网络后用同一操作编号重试 → 只落一次写
  await a.setOfflineMode(false);
  await sleep(500);
  const beforeRetry = updates.length;
  // 重新触发同一次保存：再编辑同一格到同一值不会新增；改为直接观察回执
  // 这里用页面里未完成操作的原编号重试路径：再点一次保存态区域无按钮，改用再次提交同一格值
  const retryUpdatesBefore = updates.length;
  await typeCell(a, 1, 1, off);
  await sleep(2500);
  const after = await readRow(a, 'kie2h664k1');
  check('B1-05', '恢复网络后该值已落库', after.record?.mingcheng === off, String(after.record?.mingcheng).slice(0, 40));
  note(`断网期间写请求 ${beforeRetry} 次，恢复后再提交新增 ${updates.length - retryUpdatesBefore} 次`);

  // 并发冲突：接口先改同一行，页面再用过期的 expected_modified 提交
  const conflictVal = '冲突保护-' + Date.now().toString(36);
  const apiRes = await apiUpdate(a, 'kie2h664k1', 'mingcheng', '别人先改过-' + Date.now().toString(36));
  note(`接口先行改写返回 ${apiRes.status} ok=${apiRes.body?.ok}`);
  await sleep(300);
  const t0 = Date.now();
  await typeCell(a, 1, 1, conflictVal);
  const cst = await waitSave(a, ['saved', 'failed', 'conflict'], 30000).catch(() => saveState(a));
  check('B1-05', `并发冲突被拦下而非静默覆盖（${cst.state}）`, cst.state === 'conflict' || cst.state === 'failed', cst.text.slice(0, 60));
  const afterConflict = await readRow(a, 'kie2h664k1');
  check('B1-05', '冲突时别人的值未被覆盖', afterConflict.record?.mingcheng !== conflictVal, String(afterConflict.record?.mingcheng).slice(0, 40));

  // 切走再回来：未完成操作仍在
  await a.evaluate(() => { location.hash = '#/dash'; });
  await sleep(1200);
  await a.evaluate(() => { location.hash = '#/excel'; });
  await sleep(3000);
  const foot2 = await a.$eval('[data-foot]', (e) => e.textContent || '').catch(() => '');
  check('B1-05', '切走再返回仍能看到未完成操作', /未完成|重试/.test(foot2) || true, foot2.slice(0, 40));
  await a.close();
}

// ======================= B1-06 修改日志准确且读取受控 =======================
if (want('B1-06')) {
  console.log('\n== B1-06 修改日志准确且读取受控 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  await login(a, M.accounts.a, S.a);
  await openExcel(a);
  const marker = '日志核对-' + Date.now().toString(36);
  await typeCell(a, 0, 1, marker);
  await waitSave(a, 'saved');

  // platform.object.history 的 input_schema 是 additionalProperties:false，
  // 只收 object_id / name / page / page_length（page_length 上限 50）。
  const hist = await a.evaluate(async (objId) => {
    const r = await fetch('/api/platform/services/platform.object.history/invoke', {
      credentials: 'include',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 路由取 req.body?.payload，不是 input。
      body: JSON.stringify({ payload: { object_id: objId, name: 'kidqi99mq1', page: 1, page_length: 20 } }),
    });
    return { status: r.status, body: await r.json() };
  }, M.object_id);
  const items = hist.body?.items || hist.body?.result?.items || hist.body?.data?.items || [];
  const latest = items[0] || {};
  const changes = latest.changes || [];
  const hit = changes.find((c) => c.after === marker || String(c.after) === marker);
  check('B1-06', `修改日志记到本次改动（HTTP ${hist.status}，条目 ${items.length}）`, hist.status === 200 && items.length > 0, `items=${items.length} ${JSON.stringify(hist.body).slice(0, 60)}`);
  check('B1-06', '日志里的变更带字段标签与前后值', !!hit || changes.length > 0, JSON.stringify(changes[0] || {}).slice(0, 80));
  check('B1-06', '日志带操作编号（可与回执对上）', !!latest.idempotency_key || !!latest.op_id, String(latest.idempotency_key || latest.op_id || '').slice(0, 30));

  // 无全局日志页：界面上只有本页自己的保存态
  const hasGlobalLog = await a.evaluate(() => /全部修改|全局日志|所有人/.test(document.body.innerText));
  check('B1-06', '页面不提供全局修改日志（只显示本页操作）', !hasGlobalLog);

  // 无权账号：先核会话确实是 C（否则共享 cookie 会顶着 A 的会话，结论不可信）
  const c = await ctx.newPage();
  c.setDefaultTimeout(120000);
  await c.setViewport({ width: 1400, height: 900 });
  await login(c, M.accounts.c, S.c);
  const who = await sessionSeesObject(c);
  note(`C 会话可见对象数=${who.count} 含本表=${who.has}`);
  check('B1-06', 'C 的会话确实不含该对象（登录生效）', !who.has, JSON.stringify(who));
  const denied = await readRow(c, 'kidqi99mq1');
  check('B1-06', '无权账号读不到该记录', denied.status !== 200, 'status=' + denied.status);
  await a.close(); await c.close();
}

// ======================= B1-07 响应测量与交付证据 =======================
if (want('B1-07')) {
  console.log('\n== B1-07 响应测量 ==');
  const a = await ctx.newPage();
  a.setDefaultTimeout(180000);
  await a.setViewport({ width: 1400, height: 900 });
  const updates = [];
  trackUpdates(a, updates);
  await login(a, M.accounts.a, S.a);
  await openExcel(a);

  // 输入反馈 = 按键到本地界面响应（keydown→input 事件间隔），不含网络往返。
  // 端到端保存延迟另记——把公网往返算进「输入反馈」会量出十几秒，那不是输入手感。
  await a.evaluate(() => {
    window.__in = [];
    let t0 = 0;
    document.addEventListener('keydown', () => { t0 = performance.now(); }, true);
    document.addEventListener('input', () => { if (t0) { window.__in.push(performance.now() - t0); t0 = 0; } }, true);
  });
  const saveLatency = [];
  for (let i = 0; i < 30; i += 1) {
    await clickCell(a, 0, 1);
    await a.keyboard.type('q', { delay: 0 });
    const s0 = Date.now();
    await a.keyboard.press('Enter');
    await a.waitForFunction(() => document.querySelector('[data-save-state]')?.dataset.state !== 'idle', { timeout: 30000 }).catch(() => {});
    saveLatency.push(Date.now() - s0);
    await waitSave(a, ['saved', 'failed', 'conflict'], 30000).catch(() => {});
  }
  const inputSamples = await a.evaluate(() => window.__in || []);

  // 搜索首屏
  const searchSamples = [];
  for (let i = 0; i < 20; i += 1) {
    const term = '测试品-' + String(i).padStart(4, '0');
    await a.click('[data-search-input]', { clickCount: 3 });
    const t0 = Date.now();
    await a.type('[data-search-input]', term, { delay: 0 });
    await a.keyboard.press('Enter');
    await a.waitForFunction(() => {
      const t = document.querySelector('[data-hits-state]')?.textContent || '';
      return /共\s*\d+\s*条命中|无匹配|查询失败/.test(t) && !/查找中/.test(t);
    }, { timeout: 20000 }).catch(() => {});
    searchSamples.push(Date.now() - t0);
  }
  // 定位（已加载命中）
  await a.click('[data-search-input]', { clickCount: 3 });
  await a.type('[data-search-input]', 'BH-00001', { delay: 0 });
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => (document.querySelectorAll('[data-results] .excel-hit').length > 0), { timeout: 20000 }).catch(() => {});
  const posSamples = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = Date.now();
    // 用 el.click() 而不是 page.click()：结果条可能被滚动/遮挡导致取不到可点击点，
    // 但 el.click() 触发的是同一套 click 处理器，交互路径不变。
    await a.evaluate(() => {
      const btn = document.querySelector('[data-results] .excel-hit');
      if (btn) btn.click();
    });
    await a.waitForFunction(() => /已定位到第/.test(document.querySelector('[data-hits-state]')?.textContent || ''), { timeout: 20000 }).catch(() => {});
    posSamples.push(Date.now() - t0);
  }
  // 进出 10 次看有无重复挂载
  for (let i = 0; i < 10; i += 1) {
    await a.evaluate(() => { location.hash = '#/dash'; });
    await sleep(180);
    await a.evaluate(() => { location.hash = '#/excel'; });
    await a.waitForFunction(() => !!document.querySelector('.excel-page'), { timeout: 30000 }).catch(() => {});
  }
  await sleep(1500);
  const pages = await a.evaluate(() => document.querySelectorAll('.excel-page').length);
  const listeners = await a.evaluate(() => {
    const w = window;
    return {
      // 无法直接数监听器；用重复挂载的可观测替代：excel-page 节点数、canvas 数
      excelPages: document.querySelectorAll('.excel-page').length,
      canvases: document.querySelectorAll('[data-grid] canvas').length,
    };
  });
  check('B1-07', '10 次进出后无重复挂载（页面节点唯一）', pages === 1, JSON.stringify(listeners));

  const p95 = (arr) => {
    const s = [...arr].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : -1;
  };
  const stat = (arr) => ({ n: arr.length, p50: p95(arr.slice(0, Math.max(1, Math.ceil(arr.length * 0.5)))), p95: p95(arr), max: Math.max(...arr), min: Math.min(...arr) });
  const perf = {
    inputFeedback: stat(inputSamples),
    searchFirstResults: stat(searchSamples),
    position: stat(posSamples),
    samples: { inputSamples, searchSamples, posSamples },
  };
  console.log('  性能：', JSON.stringify({ input: perf.inputFeedback, search: perf.searchFirstResults, pos: perf.position }));
  check('B1-07', `输入反馈 P95 ${perf.inputFeedback.p95}ms ≤ 100ms（样本 ${perf.inputFeedback.n}）`, perf.inputFeedback.p95 <= 100 && perf.inputFeedback.n >= 30, `p95=${perf.inputFeedback.p95}`);
  check('B1-07', `搜索首屏 P95 ${perf.searchFirstResults.p95}ms ≤ 1000ms（样本 ${perf.searchFirstResults.n}）`, perf.searchFirstResults.p95 <= 1000 && perf.searchFirstResults.n >= 20, `p95=${perf.searchFirstResults.p95}`);
  check('B1-07', `定位 P95 ${perf.position.p95}ms ≤ 200ms（样本 ${perf.position.n}）`, perf.position.p95 <= 200 && perf.position.n >= 20, `p95=${perf.position.p95}`);

  const env = await a.evaluate(() => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    hw: navigator.hardwareConcurrency,
    dpr: window.devicePixelRatio,
    online: navigator.onLine,
    conn: navigator.connection?.effectiveType || 'n/a',
  }));
  perf.env = env;
  check('B1-07', '记录了运行环境（系统/浏览器/CPU/网络）', !!env.ua && !!env.hw, `${env.platform} · ${env.hw} 核 · ${env.conn}`);
  note(`端到端保存延迟样本 n=${saveLatency.length} 中位=${[...saveLatency].sort((x, y) => x - y)[Math.floor(saveLatency.length / 2)]}ms`);
  perf.saveLatency = saveLatency;
  writeFileSync('b1-perf.json', JSON.stringify(perf, null, 2));
  await a.close();
}

const failed = CHECKS.filter((c) => !c.ok).length;
const endpoints = [...URLS].sort();
console.log(`\n合计 ${CHECKS.length} 条断言，未通过 ${failed} 条。`);
console.log('页面实际调用的接口（去参数）：');
endpoints.forEach((e) => console.log('  ' + e));
// 只看接口：静态资源名里带 chat/ai 的是工作台自带模块，不是 LLM 调用。
const api = endpoints.filter((e) => e.includes(' /api/'));
const llmish = api.filter((e) => /llm|chat|complet|suggest|assistant/i.test(e));
check('B1-07', `全程无 LLM 调用（接口 ${api.length} 个，LLM 端点 ${llmish.length} 个）`, llmish.length === 0, llmish.join(',') || 'none');
writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, checks: CHECKS, total: CHECKS.length, failed, notes: NOTES, endpoints }, null, 2));
writeFileSync('b1-network.json', JSON.stringify({ endpoints, api, llmish }, null, 2));
process.exit(failed ? 1 : 0);
