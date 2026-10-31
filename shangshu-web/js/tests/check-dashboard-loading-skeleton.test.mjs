// 判据：工作台（`#/dash`）三块 —— **顶部三块统计卡 / 常用应用 / 最近流程** —— 的**加载骨架**。
//
// **测试通过 =**（一句话）
// 「**数据还没到** ⇒ 这三块里**都有骨架占位**（形状照最终内容），并且**看不到任何假数字、假条目**；
//   **数据到了** ⇒ 骨架在**同一个容器里被换掉**（那个容器没被换新，骨架标记没了，剩下的是真实数据）；
//   **取数失败** ⇒ 三块里**既没有骨架、也不是空白** —— **写着原因** ＋ **有一个点了会真的重读的「重试」**。」
//
// **为什么要有这条**（用户 2026-10-28 上午在真页面上用浏览器批注「骨架」，圈了工作台这三块）：
//   改前：这三块取数期间显示的是「正在读取工作…／正在读取…」几个字
//          （`.platform-loading`：`min-height:180px` 的大空块）—— **骨架一处都没有**；
//          「正在读取…」**不是**骨架（骨架＝灰底占位块/条，像内容已经在那儿但还没填上）。
//   改后：取数期间显示**灰底占位块/条**（观感照表格工作面 excel-univer 那套：静态结构、不扫光），
//          数据回来**原位替换**（不整页重画、不跳版）；
//          读失败 ⇒ **原因 ＋ 重试**（产品既有的 `.platform-error` 那套写法），
//          **不停在骨架上装样子**，也**不留空白**。
//
// ⚠️ **判据断的是行为**（页面上有没有骨架标记、换没换掉、失败时有没有原因和重试）——
//   跑的是**真源码**（`shangshu-web/js/real-dashboard.js`）在**真 jsdom** 里，
//   不是断源码里有没有某个字符串。
// ⚠️ **不许拿假数字糊弄**：骨架里**一个数字都不许有**（灰块不许写「12」这种占位数字）—— 这条断的就是它。
// ⚠️ **不许拿假条目糊弄**：骨架里**不许有**真条目用的标记（`data-open-app` / `data-open-work` / `data-work-view`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
const require_ = createRequire(new URL('../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom');

const ROOT = new URL('../../../', import.meta.url);
const readSource = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const DASHBOARD_SOURCE = readSource('shangshu-web/js/real-dashboard.js');
const APP_SOURCE = readSource('shangshu-web/js/app.js');

/** 从 app.js 里切出一段（按起止标记）——照 app.js 的原样，不另造一套。 */
function slice(source, from, to) {
  const start = source.indexOf(from);
  if (start < 0) throw new Error('源码里找不到起始标记：' + from);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error('源码里找不到结束标记：' + to);
  return source.slice(start, end);
}

/* 公共壳那个读口 `api` ——**原样**从 app.js 切出来跑（断的是真页面真读口的行为）。 */
const REAL_API = slice(APP_SOURCE, 'async function api(path', 'const apiJSON =');

/** 让出一轮微任务（等页面把自己那份初始骨架画进 DOM）。 */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/** 一份「成功」的回包。 */
const ok = body => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });
/** 一份「失败」的回包（服务端给了原因）。 */
const fail = (message, status = 500) => ({ ok: false, status, json: async () => ({ ok: false, error: message }) });

/** 各条读口默认回什么（照工作台要的形状）。 */
function defaultResponse(path) {
  if (path.startsWith('/api/platform/applications?summary=1')) {
    return ok({ list: [{ id: 'APP-1', title: '邮件中心', source: 'domain', icon: 'mail', description: '收发邮件' }] });
  }
  if (path.includes('process-instances?view=pending')) {
    return ok({ list: [{ name: 'INST-P1', definition_title: '合同审批', current_node_title: '财务复核', modified: '2026-10-28 09:00:00' }] });
  }
  if (path.includes('process-instances?view=started')) {
    return ok({ list: [{ name: 'INST-S1', definition_title: '用印申请', current_node_title: '部门经理', modified: '2026-10-28 08:30:00' }] });
  }
  if (path.startsWith('/api/tasks')) {
    return ok({ list: [{ id: 'TASK-1', title: '整理台账', assignee_id: 'tester' }] });
  }
  if (path.startsWith('/api/platform/workbench')) return ok({ cards: [] });
  return ok({ list: [] });
}

/**
 * 装一份公共壳起来（真 jsdom ＋ 真 `api` ＋ 真工作台源码）。
 * · `reply(path)` —— 每条读口回什么（回 `{ok,status,json}`）。
 * · `defer(path)` —— 判据把某条读**扣住**（先不回来）⇒ 制造「数据还在路上」那一刻；
 *   `release()` 一放，扣住的那几条一起回来。
 */
function loadDash({ reply, defer, extra = {} } = {}) {
  const dom = new JSDOM('<div id="main"><div class="main-scroll"></div></div>', {
    url: 'http://localhost/index.html#/dash',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const calls = [];
  const deferred = [];
  const controller = new AbortController();
  const page = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    host: w.document.querySelector('#main .main-scroll'),
  };

  const fetchStub = (path, init = {}) => {
    const p = String(path);
    calls.push({ path: p, init: init || {} });
    const answer = () => (reply ? reply(p) : defaultResponse(p));
    if (defer && defer(p)) {
      return new Promise(resolve => { deferred.push(() => resolve(answer())); });
    }
    return Promise.resolve(answer());
  };

  const context = {
    console,
    RENDER: {},
    document: w.document,
    location: { href: 'http://localhost/index.html#/dash' },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    crypto,
    URL,
    URLSearchParams,
    AbortController,
    Event: w.Event,
    currentUserInfo: { role: 'staff', username: 'tester' },
    ICONS: new Proxy({}, { get: () => '' }),
    $: (selector, root = w.document) => root.querySelector(selector),
    $$: (selector, root = w.document) => [...root.querySelectorAll(selector)],
    esc: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    mainBox: () => w.document.querySelector('#main .main-scroll'),
    fetch: fetchStub,
    dispatchEvent: () => true,
    toast: () => {},
    go: () => {},
    window: null,
    ...extra,
  };
  context.window = context;
  /* 与应用中心同一个判定（工作台不许自己写死一份）—— 这里给一份最简单的真判定。 */
  context.window.shangshuRealAppEntries = apps => apps.filter(app => app.source !== 'managed');
  vm.createContext(context);
  vm.runInContext(REAL_API, context, { filename: 'app.js#api' });
  vm.runInContext(DASHBOARD_SOURCE, context, { filename: 'real-dashboard.js' });

  return {
    context,
    w,
    calls,
    page,
    controller,
    /** 放行扣住的那几条读。 */
    release: () => deferred.splice(0).forEach(fn => fn()),
  };
}

/** 工作台那三块的容器（判据只认这三个）。 */
function blocks(w) {
  const main = w.document.querySelector('#main .main-scroll');
  return {
    stats: main.querySelector('.workbench-status'),
    apps: main.querySelector('[data-app-list]'),
    recent: main.querySelector('[data-recent-list]'),
    main,
  };
}

/** 一个容器里的骨架标记（两种都认：属性 ＋ 类名）。 */
const skeletonOf = root => root.querySelectorAll('[data-skeleton], .platform-skeleton');

/* ───────────────── ① 数据到达之前：三块都有骨架，且没有假数字／假条目 ───────────────── */

test('① 数据还没到 ⇒ 三块都有骨架占位；骨架里一个数字、一条假条目都没有', async () => {
  const { context, w } = loadDash({ defer: () => true });
  const running = context.RENDER.dash({ signal: new AbortController().signal, isActive: () => true });
  await settle();

  const { stats, apps, recent } = blocks(w);
  assert.ok(stats, '工作台没有顶部统计卡那一排（`.workbench-status`）');
  assert.ok(apps, '工作台没有「常用应用」那个容器（`[data-app-list]`）');
  assert.ok(recent, '工作台没有「最近流程」那个容器（`[data-recent-list]`）');

  /* ① 顶部三块统计卡：三张卡各有一份骨架占位。 */
  const statMarks = stats.querySelectorAll('[data-skeleton="stat"]');
  assert.equal(statMarks.length, 3,
    '顶部三块统计卡在数据到达前只有 ' + statMarks.length + ' 份骨架占位（应当是 3 份：流程待办／我发起的流程／我的任务）');
  /* 骨架就是**真页面那张卡**（同一个按钮结构），只把字换成灰底块。 */
  for (const card of statMarks) {
    assert.ok(card.querySelector('.platform-skeleton-bar'), '统计卡的骨架里没有灰底块');
    assert.equal(card.textContent.trim(), '', '统计卡的骨架里有字 ⇒ 那是假标题');
  }

  /* ② 「常用应用」：骨架是一份一条的**行**（照最终那一条一条的清单），不是一个大空块。 */
  const appList = apps.querySelector('[data-skeleton="apps"]');
  assert.ok(appList, '「常用应用」在数据到达前没有骨架占位');
  /* 骨架就是**真页面那一条条**（同一个清单结构 ＋ 同一个按钮结构）。 */
  const appRows = appList.querySelectorAll('button');
  assert.ok(appRows.length >= 2,
    '「常用应用」的骨架只有 ' + appRows.length + ' 行（应当是一条一条的**行**，不是一个巨大的空盒子）');
  for (const row of appRows) {
    assert.equal(row.textContent.trim(), '', '「常用应用」的骨架行里有字 ⇒ 那是假条目');
  }

  /* ③ 「最近流程」：同上。 */
  const recentList = recent.querySelector('[data-skeleton="recent"]');
  assert.ok(recentList, '「最近流程」在数据到达前没有骨架占位');
  const recentRows = recentList.querySelectorAll('button');
  assert.ok(recentRows.length >= 2,
    '「最近流程」的骨架只有 ' + recentRows.length + ' 行（应当是一条一条的**行**）');
  for (const row of recentRows) {
    assert.equal(row.textContent.trim(), '', '「最近流程」的骨架行里有字 ⇒ 那是假条目');
  }

  /* 骨架**只表示「正在取数」** ⇒ 一个数字都不许有（不许写假数字占位）。 */
  for (const [name, root] of [['顶部统计卡', stats], ['常用应用', apps], ['最近流程', recent]]) {
    assert.doesNotMatch(root.textContent || '', /[0-9]/,
      '「' + name + '」的骨架里有数字 ⇒ 那是**假数字**（骨架只表示正在取数，不许假装有内容）');
    /* 也不许有真条目用的标记（假条目）。 */
    assert.equal(root.querySelectorAll('[data-open-app],[data-open-work],[data-work-view]').length, 0,
      '「' + name + '」的骨架里有真条目的标记 ⇒ 那是**假条目**');
  }

  void running;
});

/* ───────────────── ② 数据到达之后：骨架被原位替换 ───────────────── */

test('② 数据到了 ⇒ 同一个容器里骨架被换掉（容器没被换新），剩下的是真实数据', async () => {
  const { context, w, release } = loadDash({ defer: () => true });
  const running = context.RENDER.dash({ signal: new AbortController().signal, isActive: () => true });
  await settle();

  /* 先记住三个容器**本身**（数据到了以后必须是**同一个**容器 —— 原位替换，不是整页重画）。 */
  const before = blocks(w);
  assert.ok(before.stats.querySelector('[data-skeleton]'), '前置不成立：数据还没到，顶部统计卡却没有骨架');
  assert.ok(before.apps.querySelector('[data-skeleton]'), '前置不成立：数据还没到，「常用应用」却没有骨架');
  assert.ok(before.recent.querySelector('[data-skeleton]'), '前置不成立：数据还没到，「最近流程」却没有骨架');

  release();
  await running;

  const after = blocks(w);
  for (const name of ['stats', 'apps', 'recent']) {
    assert.equal(after[name], before[name],
      '「' + name + '」那块在数据到达以后**容器被换掉了** ⇒ 不是原位替换（会跳版）');
    assert.equal(skeletonOf(after[name]).length, 0,
      '「' + name + '」数据到了以后还有 ' + skeletonOf(after[name]).length + ' 处骨架没被换掉');
  }

  /* 顶部三块统计卡：换成真的卡（真的数字）。 */
  const cards = after.stats.querySelectorAll('button');
  assert.equal(cards.length, 3, '顶部三块统计卡不是三张');
  assert.match(cards[0].textContent, /流程待办/);
  assert.match(cards[0].querySelector('b').textContent, /1/, '「流程待办」那个数字不是真的那一条');
  assert.match(cards[1].querySelector('b').textContent, /1/, '「我发起的流程」那个数字不是真的那一条');
  assert.match(cards[2].querySelector('b').textContent, /1/, '「我的任务」那个数字不是真的那一条');

  /* 「常用应用」：换成真的那条一条。 */
  const appButton = after.apps.querySelector('[data-open-app]');
  assert.ok(appButton, '「常用应用」数据到了以后还没有真的条目');
  assert.match(appButton.textContent, /邮件中心/);

  /* 「最近流程」：换成真的那条一条。 */
  const recentButton = after.recent.querySelector('[data-open-work]');
  assert.ok(recentButton, '「最近流程」数据到了以后还没有真的条目');
  assert.match(recentButton.textContent, /合同审批|用印申请/);
});

/* ───────────────── ③ 取数失败：给原因 ＋ 重试入口（既不装样子，也不留空白）───────────────── */

test('③ 取数失败 ⇒ 三块里没有骨架、也不是空白：写着原因 ＋ 有一个点了会真的重读的「重试」', async () => {
  let appReads = 0;
  const { context, w, calls } = loadDash({
    reply: path => {
      if (path.startsWith('/api/platform/applications?summary=1')) {
        appReads += 1;
        /* 第一次读失败（服务端给了原因）；第二次（人点了重试）成功。 */
        return appReads === 1 ? fail('应用服务暂时不可用') : defaultResponse(path);
      }
      return fail('服务暂时不可用');
    },
  });
  await context.RENDER.dash({ signal: new AbortController().signal, isActive: () => true });

  const { main, stats, apps, recent } = blocks(w);

  /* 失败 ⇒ 三块里**不许还有骨架**（不许停在骨架上装样子）。 */
  for (const [name, root] of [['顶部统计卡', stats], ['常用应用', apps], ['最近流程', recent]]) {
    assert.equal(skeletonOf(root).length, 0,
      '「' + name + '」读失败了却还留着骨架 ⇒ 停在骨架上装样子');
  }

  /* 「常用应用」：原因 ＋ 重试入口。 */
  const appError = apps.querySelector('.platform-error');
  assert.ok(appError, '「常用应用」读失败后既没有骨架也没有说明 ⇒ 留空白了');
  assert.match(appError.textContent, /应用服务暂时不可用/, '「常用应用」没有写出失败的原因');
  const appRetry = appError.querySelector('button');
  assert.ok(appRetry, '「常用应用」失败后没有「重试」入口');

  /* 「最近流程」：原因 ＋ 重试入口。 */
  const recentError = recent.querySelector('.platform-error');
  assert.ok(recentError, '「最近流程」读失败后既没有骨架也没有说明 ⇒ 留空白了');
  assert.match(recentError.textContent, /服务暂时不可用/, '「最近流程」没有写出失败的原因');
  assert.ok(recentError.querySelector('button'), '「最近流程」失败后没有「重试」入口');

  /* 顶部三块统计卡：不许空白，也不许假装是 0（读不到就是读不到）。 */
  const cards = stats.querySelectorAll('button');
  assert.equal(cards.length, 3, '顶部三块统计卡读失败后不是三张');
  for (const card of cards) {
    const value = card.querySelector('b').textContent.trim();
    assert.notEqual(value, '', '顶部统计卡读失败后是空的 ⇒ 留空白了');
    assert.notEqual(value, '0', '顶部统计卡读失败后显示 0 ⇒ 那是假数字（读不到不等于没有）');
  }
  /* 原因 ＋ 重试入口在这一块也有（页面顶上的那条 `.platform-error`）。 */
  const banner = main.querySelector('.platform-error');
  assert.ok(banner, '读失败后整页没有一条说明 ⇒ 留空白了');
  assert.ok(banner.querySelector('button'), '读失败后没有「重试」入口');

  /* 点「重试」⇒ **真的重读那一块**，并且原位换成真实数据。 */
  const before = calls.length;
  appRetry.click();
  await settle();
  assert.ok(calls.length > before, '点了「重试」却没有再发读请求 ⇒ 这个重试是摆设');
  const appButton = apps.querySelector('[data-open-app]');
  assert.ok(appButton, '点了「重试」以后「常用应用」还是失败的样子 ⇒ 重试没有原位换回内容');
  assert.match(appButton.textContent, /邮件中心/, '点了「重试」以后拿到的不是真实数据');
  assert.equal(skeletonOf(apps).length, 0, '重试以后又冒出骨架来了');
});

/* ───────────────── ④ 应用清单走公共清单口（不自己再拉一遍） ───────────────── */

test('④ 工作台的应用清单走**公共清单口**（侧栏已经在拉了，别再拉一遍）', async () => {
  /* ⚠️ **2026-10-28 15:3x（站上实测）**：应用清单被读了**三遍**（每次 252KB，
     服务端排队 ⇒ 第三遍到 2.4 秒才回来）⇒ 侧栏那一遍还没回来，工作台又自己拉一遍。
     ⇒ 工作台这一份**走公共清单口**（`shangshuPlatformCatalog`）⇒ 跟侧栏共用同一遍。 */
  let catalogReads = 0;
  const { context, calls } = loadDash({
    extra: {
      shangshuPlatformCatalog: {
        applications: async () => {
          catalogReads += 1;
          return { ok: true, list: [{ id: 'app-1', title: '邮件中心', source: 'app' }] };
        },
      },
    },
  });
  await context.RENDER.dash({ signal: new AbortController().signal, isActive: () => true });
  await settle();

  assert.equal(catalogReads, 1, '工作台没有走公共清单口读应用清单（读了 ' + catalogReads + ' 次）');
  const direct = calls.filter(call => String(call.path).startsWith('/api/platform/applications'));
  assert.equal(direct.length, 0,
    '工作台自己又拉了一遍应用清单（' + direct.length + ' 次）⇒ 跟侧栏那一遍重复了');
});
