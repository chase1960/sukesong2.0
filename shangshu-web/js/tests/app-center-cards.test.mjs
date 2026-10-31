// 判据：**应用中心是卡片式**、**只列人用的应用**；**工作台「常用应用」也不列受管对象**。
//
// **测试通过 =**（一句话）
// 「点『应用』进去看到的是**卡片格**（不是一行一条的清单），每张卡片有**名字 ＋ 一句说明 ＋ 进入**；
//   受管对象（数据库：example 客户偏好／业务事实／官方状态／Host 设备凭据／指令…）**一条都不在**应用中心，
//   **一条都不在**工作台「常用应用」；
//   员工视角 23 条降到 4 条（管理员 24 → 5）；工作台「常用应用」从 6 条（其中 2 条是数据库）降到 4 条真应用；
//   工作台那一列的图标方块**固定 28px**、与**文字左边缘对齐**。」
//
// 为什么要有这条（用户 2026-10-22 12:0x～12:45 原话，逐条照办）：
// ·「应用中心最好搞成卡片式」            ⇒ 判据 ①：容器是**卡片格**，每张卡有名字＋说明＋入口。
// ·「应用中心不要那么多」                ⇒ 判据 ③：员工视角 23 → 4。
// ·「受管对象是数据库，不是应用」        ⇒ 判据 ②：数据库不再被当应用列出来（应用中心 + 工作台）。
// ·「工作台图标和下方的内容不是视觉对齐的」⇒ 判据 ⑥：图标方块有固定尺寸、且与文字左边缘对齐。
//
// ⚠️ **判定只有一处，不另造一套**：
//   应用中心与工作台**共用** `js/app-center-cards.js` 的 `shangshuRealAppEntries`，
//   用的标记与**侧栏认受管对象的是同一个**（`source==='managed'`）—— 两边口径不会分叉。
//   域声明（`js/domains/<域>/domain-entry.json` 的 `managedNav`）管的是**侧栏里露不露**：
//   声明过的三个（example 客户偏好／邮件模板／邮件规则表）是**规则型**的数据库
//   （用户 12:20 原话：「有些数据库……他是一种规则的显现」）⇒ **在侧栏照常能点到，
//   但不占应用的位置**（主控 2026-10-22 12:45 追加口径：「规则型/待定的那几个一律不列」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const webRoot = new URL('../', import.meta.url);            // shangshu-web/js/
/** 应用中心模块还没有时，按「空模块」跑 ⇒ 判据一条条红出来（而不是整份文件加载失败）。 */
function readIfExists(url) {
  try { return fs.readFileSync(url, 'utf8'); } catch (error) { return ''; }
}
const appCenterSource = readIfExists(new URL('app-center-cards.js', webRoot));
const shellSource = fs.readFileSync(new URL('real-applications.js', webRoot), 'utf8');
const dashboardSource = fs.readFileSync(new URL('real-dashboard.js', webRoot), 'utf8');
const appSource = fs.readFileSync(new URL('app.js', webRoot), 'utf8');
const deepseekCss = fs.readFileSync(new URL('../css/deepseek.css', webRoot), 'utf8');
const platformCss = fs.readFileSync(new URL('../css/platform.css', webRoot), 'utf8');
/* 全部样式表按 **index.html 里的加载顺序**拼起来 —— 层叠是「后加载的盖先加载的」，
   量基准线必须用这个顺序，才算得出浏览器里真正生效的值（index.html:80～95）。 */
const STYLESHEET_ORDER = [
  'workbench.css', 'app-extra.css', 'kanban-module.css', 'chat-module.css', 'sidebar.css',
  'mobile.css', 'flows-module.css', 'file-center.css', 'mail-center.css', 'file-reference-picker.css',
  'sheet-center.css', 'deepseek.css', 'platform.css', 'controls.css', 'admin-pages.css', 'collaboration.css',
];
const effectiveCss = STYLESHEET_ORDER
  .map(name => fs.readFileSync(new URL(`../css/${name}`, webRoot), 'utf8'))
  .join('\n');

/** 从源码里切出一段（按起止标记），供 vm 单独 eval。 */
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `源码里找不到起始标记：${from}`);
  const end = to ? source.indexOf(to, start) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

/* 站上那份真实的应用目录（2026-10-22 现场实测 3850 同一个 Frappe 站）：
   员工（Desk User）视角 23 条 ＝ 4 个真应用 ＋ 19 个受管对象；管理员多一个「仓库管理」＝ 24 条。 */
const BUSINESS_STAFF = [
  { id: 'com.shangshu.files.center', title: '文件中心', icon: '夹', domain_name: '文件中心', home: 'file-center',
    datasets: [{ id: 'files.enterprise', name: '企业文件' }] },
  { id: 'com.shangshu.orders.management', title: '订单管理', icon: '单', domain_name: '订单', home: 'generated.overview',
    datasets: [{ id: 'orders.order', name: '订单' }] },
  { id: 'com.shangshu.finance.expense_management', title: '费用管理', icon: '费', domain_name: '财务', home: 'generated.overview',
    description: '从票据识别、费用报销到过账付款，在一个应用内完成。',
    datasets: [{ name: '发票' }, { name: '费用报销' }, { name: '应付' }, { name: '会计分录' }, { name: '收付款流水' }] },
  { id: 'com.shangshu.finance.funding', title: '外采拨款', icon: '款', domain_name: '财务', home: 'generated.overview',
    datasets: [{ name: '外采拨款' }, { name: '拨款流水' }] },
];
/** 仓库管理要「仓库管理员」角色 ⇒ 员工看不到，管理员看得到。 */
const BUSINESS_ADMIN = [
  { id: 'com.shangshu.warehouse.management', title: '仓库管理', icon: '库', domain_name: '仓库', home: 'generated.overview',
    datasets: [{ id: 'warehouse.stock', name: '现存库存' }, { id: 'warehouse.movement', name: '出入库流水' }] },
  ...BUSINESS_STAFF,
];
/** 受管对象（数据库）—— 一次二十来条，是「不要那么多」的主要来源。 */
const MANAGED = [
  'example 客户偏好', 'example 业务事实', 'example 官方状态', 'example 邮件模板', 'example 官文审核',
  'example 发信候选', 'example 发信结果', 'example 表绑定', 'Host 设备凭据', 'Host 指令',
  'Host 运行日志', 'Host 包台账', 'Host 导入批次', 'Host 导入件', 'Host 入站通知书',
  'Host 同步作业', 'example 邮件规则表', 'example 案件入库', '提示词跑分清单',
];
/** 域声明要在**侧栏**里露出来的（与 PKG-021 的 `managedNav` 一致）。 */
const DECLARED = ['example 客户偏好', 'example 邮件模板', 'example 邮件规则表'];
/** 受管对象在应用目录里的样子（`source='managed'`，各自有自己的一句说明）。 */
const MANAGED_APPS = MANAGED.map((title, index) => ({
  id: `com.shangshu.app.${String(index + 1).padStart(32, '0')}`,
  title, source: 'managed', enabled: true,
  description: `${title}（受管记录；保存即生效，不走配置发布链）`,
}));
const APPS_STAFF = [...BUSINESS_STAFF, ...MANAGED_APPS];      // 23 条
const APPS_ADMIN = [...BUSINESS_ADMIN, ...MANAGED_APPS];      // 24 条

/** 装一个域声明登记口（**与侧栏同一个**：登记过的标题全放在返回值里）。 */
function installDeclaration(context, titles = []) {
  const declared = new Set();
  const register = list => {
    (Array.isArray(list) ? list : []).forEach(title => {
      const name = String(title || '').trim();
      if (name) declared.add(name);
    });
    return { ok: true, titles: [...declared] };
  };
  context.window.shangshuRegisterManagedNav = register;
  register(titles);                       // 域的那份声明
  return register;
}

/** 一个够用的假 DOM：只支撑「把 HTML 写进某个落点」这一件事。 */
function stubHost() {
  return { innerHTML: '', onclick: null, querySelectorAll: () => [] };
}

/**
 * 把**应用中心的真实代码**（`real-applications.js` 里的 `showOverview`）跑起来，
 * 返回它画出来的卡片格 HTML —— 不是"另写一份渲染逻辑"来测。
 */
function renderAppCenter(declaredTitles, apps = APPS_STAFF) {
  const grid = stubHost();
  const detail = stubHost();
  const search = { value: '' };
  const context = {
    console,
    RENDER: {},
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ICONS: new Proxy({}, { get: () => '' }),
    currentUserInfo: { role: 'staff', username: 'tester' },
    apps,
    isAdmin: false,
    activation: 0,
    currentId: null,
    shell: { classList: { add() {} } },
    main: { querySelector: () => null, querySelectorAll: () => [] },
    go() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    // `window` 就是全局对象（浏览器里 window === globalThis）⇒ 这两个挂在 context 上。
    selectApplicationNavigation() {},
    refreshApplicationNavigation() {},
  };
  context.$ = (selector, root) => {
    // 卡片格：新代码挂在 [data-app-center-grid]，旧代码挂在 .application-overview-grid ——
    // 同一个落点（容器用哪个类，由「① 卡片格」那条判据单独把关）。
    if (selector === '[data-app-center-grid]' || selector === '.application-overview-grid') return grid;
    if (selector === '.application-detail') return detail;
    if (selector === '.application-search') return search;
    return stubHost();
  };
  context.$$ = () => [];
  context.window = context;
  vm.createContext(context);
  vm.runInContext(slice(appSource, 'function esc(s)', 'function escapeHtml'), context);
  vm.runInContext(appCenterSource, context);
  if (declaredTitles) installDeclaration(context, declaredTitles);
  // 现成的卡片画法（应用中心与设计页共用）：照原样跑，不另写一份。
  vm.runInContext(slice(shellSource, 'function appCard(app, design = false)', 'function bindApplicationCards'), context);
  // 跑应用中心那一段（`showOverview`），把它画的卡片格收回来。
  const body = slice(shellSource, 'const showOverview=()=>{', 'const activate = async id =>');
  vm.runInContext(`${body}\nshowOverview();`, context);
  return { grid, detail, context };
}

/** 画出来的卡片（按 data-application 取）。 */
function cardIds(grid) {
  return [...grid.innerHTML.matchAll(/data-application="([^"]*)"/g)].map(match => match[1]);
}

/**
 * 把**工作台的真实代码**（`real-dashboard.js` 里的 `RENDER.dash`）跑起来，
 * 返回它画的「常用应用」那一栏 HTML。
 */
async function renderWorkbench(apps = APPS_STAFF) {
  const appList = stubHost();
  const main = stubHost();
  const context = {
    console,
    RENDER: {},
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ICONS: new Proxy({}, { get: () => '' }),
    currentUserInfo: { role: 'staff', username: 'tester' },
    mainBox: () => main,
    go() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    api: async (path) => ({
      ok: true,
      json: async () => {
        if (String(path).startsWith('/api/platform/applications')) return { ok: true, list: apps };
        if (String(path).includes('process-instances')) return { ok: true, list: [] };
        if (String(path).startsWith('/api/tasks')) return { ok: true, list: [] };
        if (String(path).startsWith('/api/platform/workbench')) return { ok: true, cards: [] };
        return { ok: true, list: [] };
      },
    }),
  };
  context.$ = (selector, root) => (selector === '[data-app-list]' ? appList : stubHost());
  context.$$ = () => [];
  context.window = context;
  vm.createContext(context);
  vm.runInContext(slice(appSource, 'function esc(s)', 'function escapeHtml'), context);
  vm.runInContext(appCenterSource, context);
  vm.runInContext(dashboardSource, context);
  await context.RENDER.dash();
  return { appList, context };
}

test('① 应用中心是**卡片格**，不是一行一条的清单', () => {
  const { grid, detail } = renderAppCenter();
  // 容器用**现成的**卡片格类（`.application-grid`），不新造一套。
  assert.match(detail.innerHTML, /class="application-grid"/,
    '应用中心的容器不是现成的 `.application-grid` 卡片格');
  assert.match(detail.innerHTML, /data-app-center-grid/,
    '应用中心没有画卡片格的落点');
  // 卡片本身用**现成的**卡片类（`.application-card` 系列）。
  const cards = grid.innerHTML.match(/<button class="application-card/g) || [];
  assert.equal(cards.length, 4, '画出来的不是卡片（application-card）');
  assert.match(grid.innerHTML, /class="application-mark"/, '卡片没有图标位');
  assert.match(grid.innerHTML, /class="application-card-copy"/, '卡片没有文字区');
});

test('① 卡片格在 CSS 里真的是「多列卡片」，没有被压成一行一条', () => {
  // 现成的卡片格类：platform.css 里就是 grid（3 列，窄屏 2/1 列）。
  assert.match(platformCss, /\.application-grid\{display:grid;grid-template-columns:repeat\(3,/,
    '`.application-grid` 不是卡片格（display:grid）');
  // deepseek.css 不许再把应用中心压成一行一条的清单：
  // 凡是提到 application-overview-grid 的规则，都必须限定在**应用设计页**里。
  const offenders = deepseekCss.split('\n')
    .filter(line => line.includes('application-overview-grid'))
    .filter(line => !line.includes('.application-design-section .application-overview-grid'));
  assert.deepEqual(offenders, [],
    `还有规则把应用中心压成清单：\n${offenders.join('\n')}`);
  // 应用中心里的卡片格不吃外层留白（复用现成类时把它自己的 padding 收掉）。
  assert.match(deepseekCss, /\.application-shell \.application-grid\{padding:0\}/,
    '应用中心的卡片格没有收掉自带留白');
});

test('② 受管对象（数据库）不再被当成应用列出来（一条都不列）', () => {
  const { grid } = renderAppCenter();
  const painted = grid.innerHTML;
  for (const title of MANAGED) {
    assert.ok(!painted.includes(title), `应用中心不该出现「${title}」（数据库不是应用）`);
  }
  // 真应用不受这条规则影响。
  for (const app of BUSINESS_STAFF) {
    assert.ok(painted.includes(app.title), `业务应用「${app.title}」被误伤了`);
  }
});

test('② 域声明了也不列（规则型数据库不占应用的位置）', () => {
  // 域在自己的 domain-entry.json 里声明了三个（PKG-021 的 managedNav）⇒ 侧栏里照常能点到，
  // 但应用中心列的是**应用**，不是数据库 ⇒ 这三个也不列。
  const { grid } = renderAppCenter(DECLARED);
  for (const title of DECLARED) {
    assert.ok(!grid.innerHTML.includes(title),
      `应用中心不该列「${title}」（规则型数据库不是应用）`);
  }
});

test('② 判定只有一处：与**侧栏同一个标记**、同一个函数', () => {
  // 侧栏认受管对象用的标记（PKG-021 的地盘，本笔没动）。
  assert.match(shellSource, /app\.source==='managed'/,
    '侧栏不再用 `source===\'managed\'` 认受管对象了（两边口径会分叉）');
  // 应用中心与工作台用的也是同一个标记。
  assert.match(appCenterSource, /const MANAGED_SOURCE = 'managed'/,
    '应用中心没有把受管对象的标记写成别的');
  assert.match(appCenterSource, /app\.source !== MANAGED_SOURCE/,
    '应用中心没有用 `source` 认受管对象');
  // 而且是**同一个函数**（不是各写一份）。
  assert.match(appCenterSource, /window\.shangshuRealAppEntries = function/,
    '没有对外提供共用的那一个判定');
  assert.match(shellSource, /window\.shangshuRealAppEntries\s*\?\s*window\.shangshuRealAppEntries\(\s*apps\s*\)/,
    '应用中心没有走共用的那一个判定');
  assert.match(dashboardSource, /window\.shangshuRealAppEntries\s*\?\s*window\.shangshuRealAppEntries\(\s*rawApps\s*\)/,
    '工作台没有走共用的那一个判定');
  // 不许自己写死一份标题清单（那才是"另造一套判定"）—— 只看**代码**，注释里说明原因不算。
  const moduleCode = appCenterSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const title of MANAGED) {
    assert.ok(!moduleCode.includes(title), `应用中心把「${title}」写死了（不该硬编码）`);
  }
});

test('③ 条目数**明显减少**：员工视角 23 条 → 4 条（管理员 24 → 5）', () => {
  assert.equal(APPS_STAFF.length, 23, '样本不是站上那份 23 条的目录（员工视角）');
  assert.equal(APPS_ADMIN.length, 24, '样本不是站上那份 24 条的目录（管理员视角）');
  const staff = renderAppCenter(null, APPS_STAFF);
  assert.equal(cardIds(staff.grid).length, 4, '员工视角条目没降到 4 条');
  assert.ok(cardIds(staff.grid).length <= APPS_STAFF.length / 3, '条目没减少到三分之一以下');
  const admin = renderAppCenter(null, APPS_ADMIN);
  assert.equal(cardIds(admin.grid).length, 5, '管理员视角条目没降到 5 条');
});

test('④ 每张卡片有**名字 ＋ 一句说明 ＋ 入口**', () => {
  const { grid } = renderAppCenter();
  const cards = grid.innerHTML.split('<button class="application-card').slice(1);
  assert.equal(cards.length, 4, '卡片数不对');
  for (const card of cards) {
    const name = card.match(/<b>([^<]*)<\/b>/);
    const note = card.match(/<small>([^<]*)<\/small>/);
    assert.ok(name && name[1].trim(), '卡片没有名字');
    assert.ok(note && note[1].trim(), `卡片「${name && name[1]}」没有说明`);
    assert.match(card, /class="application-enter"/, `卡片「${name && name[1]}」没有进入入口`);
  }
  // 域没写说明时 ⇒ 用它自己登记的数据表名字（事实，不编业务话），不许空着。
  const orders = cards.find(card => card.includes('订单管理'));
  assert.match(orders, /<small>订单<\/small>/,
    '没写说明的应用没有落到数据表名字上');
});

test('⑤ 工作台「常用应用」里**一条受管对象都没有**', async () => {
  const { appList } = await renderWorkbench(APPS_STAFF);
  const painted = appList.innerHTML;
  assert.ok(painted.length, '工作台没有画出「常用应用」');
  for (const title of MANAGED) {
    assert.ok(!painted.includes(title), `工作台「常用应用」里还有受管对象「${title}」（数据库不是应用）`);
  }
  // 真应用一条不少。
  for (const app of BUSINESS_STAFF) {
    assert.ok(painted.includes(app.title), `工作台「常用应用」少了真应用「${app.title}」`);
  }
  assert.equal((painted.match(/data-open-app="/g) || []).length, 4,
    '「常用应用」条目数不对（员工视角应当正好 4 个真应用）');
});

/* —— ⑥ 工作台这一列的**对齐**（2026-10-22 12:45 截图报）——
   抓两件事：**图标方块没有固定尺寸** ＋ **左内边距不一致**。 */

/* —— CSS 量算工具：按**视口宽度**算出浏览器里真正生效的声明 ——
   媒体查询里的规则在某个宽度下才生效，所以量基准线必须带宽度，不能一股脑合并。 */

/** 把 CSS 解析成 [{selector, body, media}]（顶层规则的 media 为 null）。 */
function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  const readBlock = from => {
    let depth = 1;
    let j = from + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    return { body: clean.slice(from + 1, j - 1), end: j };
  };
  const parseBlock = (from, to, media) => {
    let i = from;
    while (i < to) {
      const open = clean.indexOf('{', i);
      if (open < 0 || open >= to) break;
      const prelude = clean.slice(i, open).trim();
      const { body, end } = readBlock(open);
      if (prelude.startsWith('@media')) parseBlock(open + 1, end - 1, prelude);
      else if (!prelude.startsWith('@')) rules.push({ selector: prelude, body, media });
      i = end;
    }
  };
  parseBlock(0, clean.length, null);
  return rules;
}

/** 这条媒体查询在给定宽度下**是否生效**。 */
function mediaApplies(media, width) {
  if (!media) return true;
  const text = media.replace(/^@media/, '');
  return text.split(/\band\b/).map(part => part.trim()).filter(Boolean).every(part => {
    const max = part.match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/);
    const min = part.match(/min-width\s*:\s*(\d+(?:\.\d+)?)px/);
    if (max) return width <= parseFloat(max[1]);
    if (min) return width >= parseFloat(min[1]);
    return true;
  });
}

/** 取「选择器正好是它」的那些规则在该宽度下生效的声明（**后写的盖先写的**，同 CSS 层叠）。 */
function cssRuleAt(css, selector, width = 1440) {
  const decls = {};
  let found = false;
  for (const rule of parseRules(css)) {
    const selectors = rule.selector.split(',').map(item => item.trim());
    if (!selectors.includes(selector)) continue;
    if (!mediaApplies(rule.media, width)) continue;
    found = true;
    rule.body.split(';').forEach(decl => {
      const at = decl.indexOf(':');
      if (at < 0) return;
      const prop = decl.slice(0, at).trim().toLowerCase();
      const value = decl.slice(at + 1).trim().replace(/\s+/g, ' ');
      if (!prop) return;
      decls[prop] = value;
      if (prop === 'flex') {                       // 展开 flex 简写
        const parts = value.split(/\s+/);
        if (parts[0] !== undefined) decls['flex-grow'] = parts[0];
        if (parts[1] !== undefined) decls['flex-shrink'] = parts[1];
        if (parts[2] !== undefined) decls['flex-basis'] = parts[2];
      }
    });
  }
  return found ? decls : null;
}

/** 宽屏（1440）下的那条规则。 */
function cssRule(css, selector) {
  return cssRuleAt(css, selector, 1440);
}

test('⑥ 工作台「常用应用」的图标方块**有固定尺寸**（不是被文字撑出来的）', () => {
  const mark = cssRule(effectiveCss, '.workbench-app-list .application-mark');
  assert.ok(mark, '工作台的应用列表没有给图标方块定尺寸的规则');
  assert.equal(mark.width, '28px', '图标方块没有固定宽度');
  assert.equal(mark.height, '28px', '图标方块没有固定高度');
  assert.equal(mark['flex-basis'], '28px', '图标方块没有被固定成 28px 宽（会被内容撑开）');
});

test('⑥ 图标与**两行文字垂直居中**（不是顶对齐）', () => {
  const row = cssRule(effectiveCss, '.workbench-app-list>button');
  assert.ok(row, '工作台的应用列表项没有对齐规则');
  // 参照系 `.application-list-item` 就是 `align-items:center` ＋ 28px 图标。
  assert.equal(row['align-items'], 'center', '图标没有与两行文字垂直居中（顶对齐会显得偏高、看着歪）');
  // 间距与参照系（`.application-list-item` 的 9px）一致。
  assert.equal(row.gap, '9px', '图标与文字的间距与参照系不一致');
});

/* —— ⑥ 上下两排的**左基准**（2026-10-22 13:11 截图再报）——
   「常用应用」的图标方块与**上方 KPI 排**的文字不是一条竖线。
   下面的数字**全部从 CSS 算出来**（每一项写清是哪几条规则相加），不是拍脑袋写的。 */

/** 读一条规则的某个「左」值（padding-left / margin-left；没写就是 0；简写要展开）。 */
function leftOf(selector, kind, width = 1440) {
  const rule = cssRuleAt(effectiveCss, selector, width) || {};
  const explicit = rule[`${kind}-left`];
  if (explicit !== undefined) return px(explicit);
  const shorthand = rule[kind];
  if (shorthand === undefined) return 0;
  const parts = shorthand.trim().split(/\s+/);
  if (parts.length === 1) return px(parts[0]);                    // 1 个值＝四边
  if (parts.length === 2) return px(parts[1]);                    // 2 个值＝上下／左右
  if (parts.length === 3) return px(parts[1]);                    // 3 个值＝上／左右／下
  return px(parts[3]);                                            // 4 个值＝上右下左
}

function px(value) {
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 工作台各区块的**左基准**（相对工作台页内容左边缘；`.main-scroll` 的 24px 另计，与对齐无关）。
 * 每一条都写清「哪几条 CSS 相加」（2026-10-22 PKG-029-T01：横向留白统一由 `.platform-page` 给，
 * 四排自己横向一律 0 —— 规范 §2.1.2 的 L1／L3）：
 *   · 顶部 KPI 排·卡内文字 ＝ 整页留白 ＋ `.workbench-status` 左内边距 ＋ `.workbench-status>button` 左内边距
 *   · 常用应用·图标方块  ＝ 整页留白 ＋ `.workbench-layout` 左边距 ＋ `.platform-section` 左内边距 ＋ 列表项左内边距
 *   · 最近流程·条目文字  ＝ 整页留白 ＋ `.workbench-layout` 左边距 ＋ `.platform-section` 左内边距 ＋ 列表项左内边距
 *   · 业务概览·KPI 卡片边 ＝ 整页留白 ＋ `.workbench-domain` 左边距 ＋ `.platform-section` 左内边距 ＋ `.platform-kpis` 左内边距
 *   · 协作·快捷卡片边     ＝ 整页留白 ＋ `.workbench-collaboration` 左边距 ＋ `.platform-section` 左内边距 ＋ `.platform-quick-actions` 左内边距
 */
function workbenchBaselines(width = 1440) {
  const gutter = leftOf('.platform-page', 'padding', width);   /* L1 整页留白 */
  const sectionPad = leftOf('.platform-section', 'padding', width);
  return {
    '顶部 KPI 排·卡内文字': gutter + leftOf('.workbench-status', 'padding', width) + leftOf('.workbench-status>button', 'padding', width),
    '常用应用·图标方块': gutter + leftOf('.workbench-layout', 'margin', width) + sectionPad + leftOf('.workbench-app-list>button', 'padding', width),
    '最近流程·条目文字': gutter + leftOf('.workbench-layout', 'margin', width) + sectionPad + leftOf('.workbench-recent-list>button', 'padding', width),
    '业务概览·KPI 卡片边': gutter + leftOf('.workbench-domain', 'margin', width) + sectionPad + leftOf('.workbench-domain .platform-kpis', 'padding', width),
    '协作·快捷卡片边': gutter + leftOf('.workbench-collaboration', 'margin', width) + sectionPad + leftOf('.platform-quick-actions', 'padding', width),
  };
}

test('⑥ 上下两排的左基准是**同一条线**（宽屏内容列 42px）', () => {
  const baselines = workbenchBaselines(1440);
  for (const [name, value] of Object.entries(baselines)) {
    assert.equal(value, 42, `「${name}」的左基准是 ${value}px，不是 42px（上下两排不在一条竖线上）`);
  }
  assert.equal(new Set(Object.values(baselines)).size, 1,
    '工作台各区块的左基准不是同一条线');
  // 基准线的来历要说得清（判据里写死，别让人猜）：
  //   42 ＝ 整页留白 26（`.platform-page`）＋ `.platform-section` 左内边距 16 ＋ 列表项左内边距 0
  assert.equal(leftOf('.platform-page', 'padding'), 26, '`.platform-page` 整页留白不是 26px');
  assert.equal(leftOf('.workbench-layout', 'margin'), 0, '`.workbench-layout` 左边距不是 0（留白只由整页那一层给）');
  assert.equal(leftOf('.platform-section', 'padding'), 16, '`.platform-section` 左内边距不是 16px');
  assert.equal(leftOf('.workbench-app-list>button', 'padding'), 0, '列表项左内边距不是 0');
  assert.equal(leftOf('.workbench-status', 'padding'), 0, '`.workbench-status` 左内边距不是 0（留白只由整页那一层给）');
  assert.equal(leftOf('.workbench-status>button', 'padding'), 16, '顶部 KPI 排的按钮左内边距不是 16px（卡内文字会差 1px）');
});

test('⑥ 窄屏（≤680px）下也是**同一条线**（32px）', () => {
  const baselines = workbenchBaselines(680);
  for (const [name, value] of Object.entries(baselines)) {
    assert.equal(value, 32, `窄屏下「${name}」的左基准是 ${value}px，不是 32px`);
  }
});

test('⑥ 工作台那一排的**左右留白**与参照系（文件中心）是同一个数', () => {
  // 参照系＝文件中心的内容区留白（`docs/standards/visual-consistency-rules.md` §2.1：
  // 页头条左右留白 26px）。工作台跟它**用同一个数** ——
  // 2026-10-22 PKG-029-T01 起，这个数由**整页那一层** `.platform-page` 给（规范 §2.1.2 的 L1），
  // 四排自己横向一律 0（用户原话：「这样的 div 是有 margin 的，把 margin 去掉就行」）。
  const reference = leftOf('.file-center-page .file-table-area', 'padding', 1440);
  assert.equal(reference, 26, '参照系（文件中心内容区）的左右留白不是 26px —— 参照系变了先改参照系');
  assert.equal(leftOf('.platform-page', 'padding', 1440), reference,
    '整页留白（`.platform-page`）与参照系不是同一个数');
  for (const selector of ['.workbench-status', '.workbench-layout', '.workbench-domain', '.workbench-collaboration']) {
    const kind = selector === '.workbench-status' ? 'padding' : 'margin';
    assert.equal(leftOf(selector, kind, 1440), 0,
      `「${selector}」自己还带着横向留白 —— 横向留白只能由整页那一层给`);
  }
  // 窄屏跟着参照系的窄屏数（文件中心 ≤700px 是 16px）。
  const referenceNarrow = leftOf('.file-center-page .file-table-area', 'padding', 680);
  assert.equal(referenceNarrow, 16, '参照系窄屏的左右留白不是 16px');
  assert.equal(leftOf('.platform-page', 'padding', 680), referenceNarrow,
    '窄屏下整页留白（`.platform-page`）与参照系窄屏不是同一个数');
  for (const selector of ['.workbench-status', '.workbench-layout', '.workbench-domain', '.workbench-collaboration']) {
    const kind = selector === '.workbench-status' ? 'padding' : 'margin';
    assert.equal(leftOf(selector, kind, 680), 0,
      `窄屏下「${selector}」自己还带着横向留白 —— 横向留白只能由整页那一层给`);
  }
});

test('⑥ 没有动那条全局规则（不许波及应用中心页）', () => {
  const global = cssRule(effectiveCss, '.application-shell .application-list-item .application-mark');
  assert.ok(global, '全局的 `.application-list-item .application-mark` 规则不见了');
  assert.equal(global.width, '28px');
  assert.equal(global.height, '28px');
  assert.equal(global['flex-basis'], '28px');
});
