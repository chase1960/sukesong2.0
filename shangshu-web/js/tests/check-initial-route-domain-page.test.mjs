// 判据：**域登记的页**（受管对象入口进的那页，比如 example 邮件规则表）**首屏要算数** ——
// 网址直达／刷新**不许**被甩回工作台。
//
// **测试通过 =**（一句话）
// 「把地址栏敲成 `#/example-domain.mail-rules` 再刷新 ⇒ **还是落在『邮件规则』那一页**
//   （不是被甩回工作台）；而**本来就进不去的页仍然进不去**
//   （没登记的页 ／ 没渲染函数的页 ／ 角色进不去的页 ⇒ 首屏照旧回工作台，
//   **不许因为这次放开就多开了口子**）。」
//
// ⚠️ **这条判据是从一次真事故倒推出来的**（2026-10-24 夜班巡站抓到）：
//   在「example 邮件规则表」那一页上按刷新 ⇒ **页面被甩回工作台**
//   （地址从 `#/example-domain.mail-rules` 变成 `#/dash`）——
//   而**这一页在应用里点侧栏是进得去的**（域在 `example-domain-entry.js` 里
//   用 `go('example-domain.mail-rules')` 导航）⇒ 所以不是页坏了，**是「首屏怎么定」这一关判它进不去**。
//
// **根因**（`shangshu-web/js/app.js` 启动段）：
//   首屏判定 `modOk(m)` 要求**三件事同时成立**：
//     ① 页面注册表里有、且本角色进得去（`resolvePage`）；
//     ② 这一页有渲染函数（`RENDER[resolved]`）；
//     ③ **这一页在「侧栏条目表」里**（`allMods.find(...)`）且本角色看得到（`canSee`）。
//   ③ 对**域登记的页**不成立 —— 邮件规则表是**从受管对象入口进**的，
//   它**故意没有**单独的侧栏条目（域的 `managedNav` 只声明受管对象）⇒
//   ⇒ `modOk` 回 false ⇒ 首屏回工作台 ⇒ **刷新/直达都丢页**。
//
// **改之前**：在「邮件规则表」那页按刷新 ⇒ 回到工作台（地址变成 `#/dash`）。
// **改之后**：在同一页按刷新 ⇒ **还是那一页**；直接敲网址进去也一样。
// **怎么看**：浏览器打开 `http://127.0.0.1:3850/index.html#/example-domain.mail-rules`
//   ⇒ 标题是「邮件规则」；再按一次刷新 ⇒ **还是「邮件规则」**（不再跳回工作台）。
//
// ⚠️ **判据怎么跑的**：**不是**读源码找字符串 —— 把 `app.js` 启动段里
//   「首屏怎么定」那几行**原样切出来**，在 `node:vm` 里**真跑一遍**
//   （照 `managed-nav.test.mjs` 的老套路：切一段、在假上下文里跑、看它选了哪一页）。
//   假上下文只提供它真正用到的那几样：`GROUPS`／`CORE_ITEMS`／`canSee`／
//   `pageAvailable`／`resolvePage`／`RENDER`／`location`／`art`／`go`。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const appSource = fs.readFileSync(new URL('shangshu-web/js/app.js', ROOT), 'utf8');

/** 从 app.js 里切出「首屏怎么定」那一段（原样，不另造一套）。 */
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `app.js 里找不到起始标记：${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `app.js 里找不到结束标记：${to}`);
  return source.slice(start, end);
}

const BOOT = slice(appSource, 'const visible = GROUPS.flatMap', 'appBooted = true;');

/**
 * 跑一遍启动段的首屏判定，回它选中的页。
 * @param {object} o
 * @param {string} o.hash        地址栏里的 hash（如 '#/example-domain.mail-rules'）
 * @param {object} o.registry    页面注册表：id → { platform, status, roles?, alias? }
 * @param {object} o.render      RENDER：id → 渲染函数
 * @param {Array}  o.groups      侧栏条目表（GROUPS）
 * @param {string} o.role        当前角色
 */
function bootRoute({ hash, registry, render, groups, role = 'staff', platform = true }) {
  const chosen = [];
  const context = {
    GROUPS: groups,
    CORE_ITEMS: [],
    /* 侧栏条目那一道角色闸（照 app.js 里 canSee 的原样）。 */
    canSee: (m) => !m.roles || role === 'admin' || m.roles.includes(role),
    pageAvailable: (id) => {
      if (platform) {
        const requested = registry[id];
        if (!requested || !requested.platform || !['implemented', 'compatibility'].includes(requested.status)) return false;
      }
      const resolved = context.resolvePage(id);
      return !!(resolved && render[resolved]);
    },
    /* 平台模式那一道（照 app.js 里 isPlatformManaged 的原样）。 */
    isPlatformManaged: () => platform,
    /* 注册表那一道闸（照 app.js 里 resolvePage ＋ page-registry.js 里 shangshuResolvePlatformPage 的原样）。 */
    resolvePage: (id) => {
      if (!platform) return render[id] ? id : null;
      const requested = registry[id];
      if (!requested) return null;
      const targetId = requested.alias || id;
      const target = registry[targetId];
      if (!target || !target.platform || !['implemented', 'compatibility'].includes(target.status)) return null;
      if (target.roles?.length && role !== 'admin' && !target.roles.includes(role)) return null;
      return targetId;
    },
    RENDER: render,
    location: { hash, search: '' },
    art: undefined,
    go: (mod) => chosen.push(mod),
  };
  vm.createContext(context);
  vm.runInContext(BOOT, context);
  return chosen[0];
}

/* —— 假世界 —— */
const SIDEBAR = [{ sec: '工作', items: [
  { id: 'dash', name: '工作台', ico: 'home' },
  { id: 'im', name: '消息', ico: 'chat' },
]}];

/** 域登记的页：注册表里有、有渲染函数、**故意没有侧栏条目**（从受管对象入口进）。 */
const DOMAIN_PAGE = {
  registry: {
    dash: { id: 'dash', platform: true, status: 'implemented' },
    'example-domain.mail-rules': { id: 'example-domain.mail-rules', platform: true, status: 'implemented' },
  },
  render: {
    dash: () => {},
    'example-domain.mail-rules': () => {},
  },
};

/* ───────────────── ① 域登记的页：首屏要算数 ───────────────── */
test('① 域登记的页（受管对象入口进的那页，不在侧栏条目表里）⇒ 首屏落在它，不被甩回工作台', () => {
  const chosen = bootRoute({
    hash: '#/example-domain.mail-rules',
    registry: DOMAIN_PAGE.registry,
    render: DOMAIN_PAGE.render,
    groups: SIDEBAR,
  });
  assert.equal(chosen, 'example-domain.mail-rules',
    `首屏选了「${chosen}」而不是那一页 —— 域登记的页被当成了进不去。`
    + '（它在侧栏条目表里没有条目：从受管对象入口进的页就是这样。）');
});

/* ───────────────── ② 不许因为这次放开就多开了口子 ───────────────── */
test('② 本来就进不去的页仍然进不去（没登记 ／ 没渲染函数 ／ 角色进不去）⇒ 首屏照旧回工作台', () => {
  // ① 注册表里没有这个页
  assert.equal(bootRoute({
    hash: '#/example-domain.not-registered',
    registry: DOMAIN_PAGE.registry,
    render: DOMAIN_PAGE.render,
    groups: SIDEBAR,
  }), 'dash', '没登记的页被放进了 ⇒ 首屏不该落在它。');

  // ② 登记了，但**没有渲染函数**
  assert.equal(bootRoute({
    hash: '#/example-domain.mail-rules',
    registry: DOMAIN_PAGE.registry,
    render: { dash: () => {} },
    groups: SIDEBAR,
  }), 'dash', '没有渲染函数的页被放进了 ⇒ 首屏不该落在它。');

  // ③ 注册表里这一页限了角色，本角色进不去
  assert.equal(bootRoute({
    hash: '#/admin-only',
    registry: {
      ...DOMAIN_PAGE.registry,
      'admin-only': { id: 'admin-only', platform: true, status: 'implemented', roles: ['admin'] },
    },
    render: { ...DOMAIN_PAGE.render, 'admin-only': () => {} },
    groups: SIDEBAR,
    role: 'staff',
  }), 'dash', '角色进不去的页被放进了 ⇒ 首屏不该落在它。');
});

/* ───────────────── ③ 侧栏条目那一道角色闸不许被顺手拆掉 ───────────────── */
test('③ 侧栏条目那一道角色闸还在：条目限了角色而本角色不配 ⇒ 首屏回工作台', () => {
  const groups = [{ sec: '工作', items: [
    { id: 'dash', name: '工作台', ico: 'home' },
    { id: 'manager-only', name: '管理台', ico: 'grid', roles: ['manager'] },
  ] }];
  assert.equal(bootRoute({
    hash: '#/manager-only',
    registry: {
      dash: { id: 'dash', platform: true, status: 'implemented' },
      'manager-only': { id: 'manager-only', platform: true, status: 'implemented' },
    },
    render: { dash: () => {}, 'manager-only': () => {} },
    groups,
    role: 'staff',
  }), 'dash', '侧栏条目限了角色，首屏却落进去了 ⇒ 那道闸被拆了。');
});

/* ───────────────── ④ 兼容模式的老规矩一个字没动 ───────────────── */
test('④ 兼容模式（不是平台模式）下：没有侧栏条目的页仍然进不去（老规矩一个字没动）', () => {
  assert.equal(bootRoute({
    hash: '#/legacy-only',
    registry: {},
    render: { dash: () => {}, 'legacy-only': () => {} },
    groups: SIDEBAR,
    platform: false,
  }), 'dash', '兼容模式的老规矩被改了 —— 这次只放行**平台注册表里登记过的域页**，兼容模式一个字不动。');
});
