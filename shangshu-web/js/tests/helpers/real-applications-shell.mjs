// 判据公用件：把**公共壳那一侧的应用目录**（`shangshu-web/js/real-applications.js`）装进最小 DOM。
//
// **为什么抽出来**（仓库约定 §13「公共工具只留一份」）：两条判据要同一套装载办法 ——
//   同一份壳源码、同一个最小 DOM 桩、同一条切片方式（照 app.js 的原样，不另造一套）。
// 抄一份就是重搭一套测试工具。
//
// `options.api` 决定后端回什么；每一次调用都记在 `calls` 里（判据要断言**发了几次**）。
import fs from 'node:fs';
import vm from 'node:vm';

export const shellSource = fs.readFileSync(new URL('../../real-applications.js', import.meta.url), 'utf8');
export const appSource = fs.readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

/** 从 app.js 里切出一段（按起止标记）——照 app.js 的原样，不另造一套。 */
export function slice(source, from, to) {
  const start = source.indexOf(from);
  if (start < 0) throw new Error('源码里找不到起始标记：' + from);
  const end = to ? source.indexOf(to, start) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

/** 侧栏里那个应用清单的宿主（够画一次条目就行）。 */
export function makeHost() {
  return {
    id: 'side-application-list',
    dataset: {},
    isConnected: true,
    innerHTML: '',
    querySelectorAll: () => [],
    appendChild() {},
  };
}

/**
 * 装一份公共壳起来。
 * `options.api(path, init)` 决定后端回什么（回一个**像 fetch 响应**的东西：
 * `{ok, status, json()}`）；**每一次调用都记在 `calls` 里**。
 */
export function loadApplicationsShell(options = {}) {
  const calls = [];
  const host = options.host || makeHost();
  const section = { appendChild() {} };
  const entry = { closest: () => section };
  const context = {
    console,
    RENDER: {},
    curMod: null,
    sidebarFavorites: [],
    currentUserInfo: { role: 'staff', username: 'tester' },
    pageMeta: () => null,
    ICONS: new Proxy({}, { get: () => '' }),
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: {
      querySelector(selector) {
        if (selector === '#side .side-main [data-mod="applications"]') return entry;
        if (selector === '#side-application-list') return host;
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => ({ dataset: {}, innerHTML: '', querySelectorAll: () => [], appendChild() {} }),
    },
    location: { href: '', search: '' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    URL,
    crypto,
    /* 公共壳那个读口（`api`）——判据要数「发了几次」⇒ 每次都记一笔。 */
    api: async (path, init) => {
      calls.push({ path: String(path), init: init || {} });
      if (options.api) return options.api(String(path), init || {});
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    },
  };
  context.window = context;
  /* 公共壳那个「清单口」（`shangshuPlatformCatalog`）——
     侧栏那份应用清单现在走它 ⇒ 判据的假世界也得有（照 app.js 的原样，不另造一套）。
     这里照它的**在途共用、不缓存**那一条实现（应用清单的复用期是 0）。 */
  context.shangshuPlatformCatalog = {
    _inflight: new Map(),
    read(path) {
      const running = this._inflight.get(path);
      if (running) return running;
      const promise = (async () => {
        const response = await context.api(path);
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || '读不到清单');
        return data;
      })();
      this._inflight.set(path, promise);
      promise.then(() => this._inflight.delete(path), () => this._inflight.delete(path));
      return promise;
    },
    applications() { return this.read('/api/platform/applications?summary=1'); },
    objects() { return this.read('/api/platform/objects'); },
    actions() { return this.read('/api/platform/actions'); },
    invalidate() {},
    invalidateAll() {},
  };
  vm.createContext(context);
  // app.js 的两段原样（侧栏条目画法 ＋ 转义）——照原样用，不另造一套。
  vm.runInContext(slice(appSource, 'function esc(s)', 'function escapeHtml'), context);
  vm.runInContext(slice(appSource, 'function sidebarItemHtml', 'function renderBrand'), context);
  vm.runInContext(shellSource, context);
  return { context, host, calls };
}
