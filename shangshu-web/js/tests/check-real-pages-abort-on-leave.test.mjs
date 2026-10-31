// 判据：**人切页以后，旧页那些还在飞的读请求要被取消掉**（审查报告 R06）。
//
// **测试通过 =**（一句话）
// 「在「工作台」「应用」「应用设计」任一页上，这一页发出的**读**请求，
//   `fetch` 收到的 `init.signal` **就是这一页那个 `page.signal` 对象**（同一个对象，
//   不是新建的、不是别的页的）；而这一页发出的**写**请求（`POST`）的 `init` 里
//   **没有 `signal` 键**（已发出的写必须保留核验与恢复语义，不能被切页盲目撤销）；
//   并且**人切走那一页**（`abort`）⇒ 在飞的读**当场被取消**、旧页**不再回来写页面**。」
//
// **改之前看到什么**：
//   人停在「工作台」，在「正在读取工作…」那一下点侧栏别的页
//   ⇒ 旧页那 5 个读请求**照旧跑到底**（浏览器网络面板里不是 cancelled，
//   而是老老实实跑完）⇒ 上游白占资源；而且旧结果回来时还会去改已经没人看的旧页面。
//   同样，「应用」页、「应用设计」页的读也一样掐不掉。
// **改之后看到什么**：
//   同一串操作 ⇒ 旧页那几条读请求在网络面板里显示 **cancelled**（上游当场收手），
//   旧页也不会被后来的结果改写；
//   而「新建应用」「发布应用」这些**写**照旧发完（切页不会把它们掐在半路）。
// **怎么看**：
//   浏览器打开 `http://127.0.0.1:3850/#/dash`，F12 打开网络面板，
//   在「正在读取工作…」那一下立刻点侧栏「应用」
//   ⇒ 旧页那几条 `fetch` 显示 cancelled；
//   再打开 `http://127.0.0.1:3850/#/app-design`（管理员），
//   点「新建应用」提交 ⇒ 那条 `POST /api/platform/application-definitions` 正常发出（不是 cancelled）。
//
// ⚠️ **判据怎么跑的**：**读真源码、在 `node:vm` 里真跑**（照同批
//   `check-real-objects-navigation-guard.test.mjs` 的老套路：jsdom ＋ 假上下文 ＋ 真的
//   `RENDER.applications`／`RENDER['app-design']`／`RENDER.dash`）。
//   公共壳那个读口 `api` 也是**从 app.js 原样切出来**跑的（不另造一套）
//   ⇒ 断的是 **fetch 真收到的 `init.signal`**，不是源码里有没有某个字符串。
//
// ⚠️ **判据不管什么**（说清楚边界）：
//   · 「侧栏那份应用清单」**故意不带页面信号**——它是**全站共用**的在途去重请求
//     （`app.js` 的 `renderChrome()` 也叫它，另有判据
//     `check-app-list-request-dedup.test.mjs` 钉着这个去重语义）
//     ⇒ 挂某一页的 signal 会在切页时把**侧栏**一起掐掉 ⇒ 是回归。
//     判据**不**断言它带 signal。
//   · 「启停应用」那条写（`/status`）在源码里那个按钮挂在一个**游离**的 fieldset 上
//     ⇒ 浏览器里点不到 ⇒ 这条写**没跑成**，见交付说明（其余两条写跑成了）。

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

const APPLICATIONS_SOURCE = readSource('shangshu-web/js/real-applications.js');
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

/* 公共壳那个读口 `api` ——**原样**从 app.js 切出来跑：
   它把 opts 机械透传给 fetch（`{credentials, headers, ...opts}`）⇒
   断言 fetch 收到的 `init.signal` 才是真的「这一页的取消信号送到了上游」。 */
const REAL_API = slice(APP_SOURCE, 'async function api(path', 'const apiJSON =');

/** 一个 AbortError（浏览器与 Node 的取消错误都长这样）。 */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/** 后端默认回什么（照这几页各自要的形状）。 */
function defaultResponse(path) {
  const ok = (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });
  if (path.startsWith('/api/platform/applications?include_disabled')) {
    return ok({ list: [] });
  }
  if (path.startsWith('/api/platform/application-definitions')) {
    return ok({ application: { id: 'app-1', title: '邮件中心', source: 'managed', enabled: true } });
  }
  if (path.startsWith('/api/platform/applications/')) {
    return ok({ application: { id: 'app-1', title: '邮件中心', enabled: true, datasets: [], processes: [] } });
  }
  if (path.startsWith('/api/platform/applications')) {
    return ok({ list: [] });
  }
  if (path.includes('process-instances')) return ok({ list: [] });
  if (path.startsWith('/api/tasks')) return ok({ list: [] });
  if (path.startsWith('/api/platform/workbench')) return ok({ cards: [] });
  return ok({ list: [] });
}

/**
 * 装一份公共壳起来（真 jsdom ＋ 真 `api` ＋ 真页面源码）。
 *
 * · `calls`  —— **fetch 层**看到的每一次请求（`{path, init}`）；断信号看的就是 `init.signal`。
 * · `page`   —— 公共壳给这一页的那个对象（`signal` ＋ `isActive()`）。
 * · `held`   —— 被判据**扣住**不许立刻回的请求（用来制造「人切走了那一页」的时间窗）。
 */
function loadShell({ sources, role = 'staff', fetch, hold } = {}) {
  const dom = new JSDOM('<div id="main"><div class="main-scroll"></div></div>', {
    url: 'http://localhost/index.html#/dash',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const calls = [];
  const held = [];
  const store = new Map();
  let href = 'http://localhost/index.html#/dash';

  const location = {
    get href() { return href; },
    set href(value) { href = String(value); },
    get search() { return new URL(href).search; },
    get hash() { return new URL(href).hash; },
    origin: 'http://localhost',
  };

  const controller = new AbortController();
  const page = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    host: w.document.querySelector('#main .main-scroll'),
  };

  const fetchStub = (path, init = {}) => {
    const p = String(path);
    calls.push({ path: p, init: init || {} });
    const signal = init && init.signal;
    if (signal && signal.aborted) return Promise.reject(abortError());
    const body = hold && hold(p)
      ? null
      : (fetch ? fetch(p, init || {}) : defaultResponse(p));
    if (!signal) return Promise.resolve(body);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => { if (settled) return; settled = true; reject(abortError()); };
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (body === null) {
        held.push({ path: p, resolve: value => { if (settled) return; settled = true; resolve(value); } });
        return;
      }
      settled = true;
      resolve(body);
    });
  };

  const context = {
    console,
    RENDER: {},
    document: w.document,
    location,
    history: { replaceState(_state, _title, url) { href = String(url); } },
    sessionStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); },
    },
    crypto,
    URL,
    URLSearchParams,
    AbortController,
    Event: w.Event,
    currentUserInfo: { role, username: 'tester' },
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
    chatSetBusinessContext: () => {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(REAL_API, context, { filename: 'app.js#api' });
  (sources || []).forEach(source => {
    vm.runInContext(source.text, context, { filename: source.name });
  });

  return { context, w, calls, held, page, controller, store };
}

/** 等到某个条件成立（判据要控制「请求发出去没有」「人走了没有」的先后）。 */
async function waitFor(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

/* ───────────────── ① 工作台：这一页的读都带这一页的信号 ───────────────── */

test('① 工作台这一页的读请求，fetch 收到的 init.signal 就是 page.signal 那个对象', async () => {
  const { context, calls, page } = loadShell({ sources: [{ name: 'real-dashboard.js', text: DASHBOARD_SOURCE }] });
  await context.RENDER.dash(page);

  const reads = calls.filter(call => call.path.startsWith('/api/'));
  assert.equal(reads.length, 5, '工作台这一页发了 ' + reads.length + ' 个读请求（应当是 5 个）——判据的前置不成立');
  for (const call of reads) {
    assert.equal(call.init.signal, page.signal,
      '「' + call.path + '」这个读请求没有带上这一页的取消信号（`init.signal` 不是 `page.signal` 那个对象）'
      + '⇒ 人切页以后旧页的读照旧跑到底，掐不掉');
  }
});

/* ───────────────── ② 应用页：清单读 + 单个应用详情读都带信号 ───────────────── */

test('② 应用直达详情与应用总览各自的读请求都带当前 page.signal', async () => {
  const { context, calls, page, store } = loadShell({
    sources: [{ name: 'real-applications.js', text: APPLICATIONS_SOURCE }],
    fetch: path => {
      if (String(path).startsWith('/api/platform/applications/app-1')) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, application: { id: 'app-1', title: '邮件中心', enabled: true, datasets: [], processes: [] } }),
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, list: [{ id: 'app-1', title: '邮件中心', source: 'domain', icon: 'mail' }] }),
      };
    },
  });
  store.set('shangshu.application.open', 'app-1');
  await context.RENDER.applications(page);

  assert.deepEqual(calls.map(call => call.path), ['/api/platform/applications/app-1'],
    '已知应用ID时应直接读取详情，不能为检查信号额外读取全清单');
  await context.RENDER.applications(page);
  const reads = calls.filter(call => call.path.startsWith('/api/'));
  /* ⚠️ **契约变化（2026-10-28 性能批）**：应用清单改成走**摘要口**
   *   （`?summary=1`）—— 只取清单骨架，不带每个应用的数据集/流程资源
   *   ⇒ 清单那次读**本来就变轻了**，不必再拉全量资源再丢掉。
   *   断言要跟新口走（原来写死 `/api/platform/applications` ⇒ 必然红）。
   *   ⚠️ 这条红是**上游性能候选自己带出来的**（候选树同一条判据也是红的），
   *   不是合并时撞出来的。 */
  assert.ok(reads.some(call => call.path === '/api/platform/applications?summary=1'), '总览入口仍需读取清单（摘要口）');
  for (const call of reads) {
    assert.equal(call.init.signal, page.signal,
      '「' + call.path + '」这个读请求没有带上这一页的取消信号'
      + '⇒ 人切页以后旧页的读照旧跑到底，掐不掉');
  }
});

/* ───────────────── ③ 应用设计页：清单读 + 应用定义读都带信号 ───────────────── */

test('③ 应用设计页这一页的读请求（清单 ＋ 应用定义），fetch 收到的 init.signal 就是 page.signal', async () => {
  const { context, calls, page, store } = loadShell({
    role: 'admin',
    sources: [{ name: 'real-applications.js', text: APPLICATIONS_SOURCE }],
    fetch: path => {
      if (String(path).startsWith('/api/platform/application-definitions')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true,
            application: {
              id: 'app-1', title: '邮件中心', source: 'managed', status: 'Enabled',
              draft_revision: 1, published_revision: null,
              draft: { title: '邮件中心', bindings: [], allowed_roles: ['staff'] },
              design_context: { resource_options: [], release: { issues: [], releases: [] } },
            },
          }),
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, list: [{ id: 'app-1', title: '邮件中心', source: 'managed', enabled: true }] }),
      };
    },
  });
  store.set('shangshu.application.open', 'app-1');
  await context.RENDER['app-design'](page);

  const reads = calls.filter(call => call.path.startsWith('/api/'));
  assert.ok(reads.length >= 2, '应用设计页没有发出读请求——判据的前置不成立');
  for (const call of reads) {
    assert.equal(call.init.signal, page.signal,
      '「' + call.path + '」这个读请求没有带上这一页的取消信号'
      + '⇒ 人切页以后旧页的读照旧跑到底，掐不掉');
  }
});

/* ───────────────── ④ 写请求：不许挂取消信号 ───────────────── */

test('④ 这一页发出的写请求（新建应用），fetch 收到的 init 里没有 signal 键', async () => {
  const { context, w, calls, page } = loadShell({
    role: 'admin',
    sources: [{ name: 'real-applications.js', text: APPLICATIONS_SOURCE }],
    fetch: path => {
      if (String(path).startsWith('/api/platform/application-definitions') && String(path).includes('/status')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (String(path).startsWith('/api/platform/application-definitions')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, application: { id: 'app-new' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    },
  });

  await context.RENDER['app-design'](page);

  /* 点「新建应用」⇒ 页面自己把表单画出来（这一段是页面真代码，不是判据替它画的）。 */
  const create = w.document.querySelector('#main .main-scroll .page-actions .btn-pri');
  assert.ok(create, '应用设计页没有「新建应用」那个按钮——判据的前置不成立');
  create.click();

  const form = w.document.querySelector('#main .main-scroll [data-create-application]');
  assert.ok(form, '点开「新建应用」之后没有出现新建表单——判据的前置不成立');
  form.elements.title.value = '测试应用';

  /* 提交表单 ⇒ 页面代码真的走到那条写（`POST /api/platform/application-definitions`）。 */
  await form.onsubmit({ preventDefault() {} });

  const write = calls.find(call => call.init && call.init.method === 'POST');
  assert.ok(write, '新建应用没有发出写请求——判据的前置不成立');
  assert.ok(!('signal' in write.init),
    '那条写请求（' + write.path + '）的 init 里挂了 signal'
    + '⇒ 已发出的写会被人切页这件事盲目中止 ⇒ 写没了核验与恢复语义');
});

/* ───────────────── ⑤ 人切走那一页：在飞的读当场被取消，旧页不再回来写页面 ───────────────── */

test('⑤ 人切走那一页 ⇒ 在飞的读当场被取消，旧页也不再被后来的结果改写', async () => {
  const { context, w, calls, page, controller } = loadShell({
    sources: [{ name: 'real-dashboard.js', text: DASHBOARD_SOURCE }],
    hold: path => String(path).startsWith('/api/platform/applications'),
  });

  const running = context.RENDER.dash(page);
  await waitFor(() => calls.length >= 1, '工作台一个读请求都没发出去——判据的前置不成立');
  const status = w.document.querySelector('#main .main-scroll .workbench-status');

  /* 人切走了 ⇒ 公共壳 abort 这一页的信号。 */
  controller.abort();
  await running;

  assert.ok(status.innerHTML.includes('正在读取工作'),
    '旧页被后来的结果改写了（工作台状态区已经不是「正在读取工作…」）'
    + '⇒ 旧页的读回来后还在写已经没人看的页面');
});
