// 判据：工作台以外的页面 —— **数据页 / 应用页 / 待办页 / 通知书助手 / 邮件规则表** ——
//       取数期间也画**灰底骨架**（不是那个「正在读取…」的大空块）。
//
// **测试通过 =**（一句话）
// 「这五页在**数据还没到**的时候，眼里都是**灰底占位块**（形状照最终那一块内容），
//   **看不到任何假数字、假条目**，也**看不到那个大空块**（`.platform-loading`）；
//   数据到了以后，骨架在**同一个容器里被换掉**，剩下的是真实内容。」
//
// **为什么要有这条**（用户 2026-10-28 上午批注「骨架」，随后追加：「其他的也加上这样的灰底？
//   我觉得是有必要的」—— 点名**表格**与**通知书助手**）：
//   改前：这些页面的取数期间画的是 `.platform-loading`
//          （`min-height:180px` 的大空块 ＋ 一行「正在读取…」字）—— **一处骨架都没有**。
//   改后：画**灰底占位块**（公共骨架类 `css/platform.css` 的 `.platform-skeleton*`，
//          观感照表格工作面 excel-univer 那套：静态结构、不扫光）；
//          形状照**最终那���内容**（表格照真列数、概览照真格子数）。
//
// ⚠️ **判据断的是行为**（页面上有没有骨架标记、换没换掉）——
//   跑的是**真源码**在**真 jsdom** 里，不是断源码里有没有某个字符串。
// ⚠️ **不许拿假数字糊弄**：骨架里**一个数字都不许有**（不许写「12」这种占位数字）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 审核中心那条判据**复用它自己的公共件**（判据公用件只留一份 —— 不另造一套）。
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, pageHost, settle as settleReview } from './helpers/review-center-shell.mjs';

const require_ = createRequire(new URL('../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom');

const ROOT = new URL('../../../', import.meta.url);
const readSource = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const OBJECTS_SOURCE = readSource('shangshu-web/js/real-objects.js');
const APPLICATIONS_SOURCE = readSource('shangshu-web/js/real-applications.js');
const UNIFIED_WORK_SOURCE = readSource('shangshu-web/js/unified-work.js');
const NOTICE_SOURCE = readSource('shangshu-web/js/domains/example-domain/example-domain-notice-assistant.js');
const SHEET_SOURCE = readSource('shangshu-web/js/sheet-center.js');
const RULES_SOURCE = readSource('shangshu-web/js/domains/example-domain/example-domain-mail-rules.js');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/** 骨架标记（属性 ＋ 类名都认）。 */
const skeletonOf = root => root.querySelectorAll('[data-skeleton], .platform-skeleton');

/**
 * 装一份公共壳起来（真 jsdom ＋ 真页面源码）。
 * **读口一律不回来** ⇒ 每一页都停在「数据还在路上」那一刻（正是要看骨架的那一刻）。
 */
function mount(sources, { extra = {}, render } = {}) {
  const dom = new JSDOM('<div id="main"><div class="main-scroll"></div></div>', {
    url: 'http://localhost/index.html#/objects',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const context = {
    console,
    RENDER: {},
    document: w.document,
    location: { href: 'http://localhost/index.html#/objects' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    currentUserInfo: { role: 'staff', username: 'tester' },
    ICONS: new Proxy({}, { get: () => '' }),
    $: (selector, root = w.document) => root.querySelector(selector),
    $$: (selector, root = w.document) => [...root.querySelectorAll(selector)],
    esc: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    mainBox: () => w.document.querySelector('#main .main-scroll'),
    /* 读口**一直不回来** ⇒ 这一页停在「正在取数」那一刻。 */
    fetch: async () => new Promise(() => {}),
    api: async () => new Promise(() => {}),
    apiJSON: async () => new Promise(() => {}),
    dispatchEvent: () => true,
    toast: () => {},
    go: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    URL,
    URLSearchParams,
    window: null,
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  sources.forEach(source => vm.runInContext(source.text, context, { filename: source.name }));
  if (render) render(context, w);
  return { context, w };
}

/** 一页里所有骨架块的内容（合起来当「这一页眼里的灰底」）。 */
function skeletonText(root) {
  return [...skeletonOf(root)].map(node => node.textContent || '').join(' ');
}

/* ───────────────── ④ 数据页（表格）：数据到达前画骨架 ───────────────── */

test('④ 数据页（表格那一块）：数据没到 ⇒ 画的是灰底骨架，不是那个大空块', async () => {
  const { context, w } = mount([{ name: 'real-objects.js', text: OBJECTS_SOURCE }]);
  const running = context.RENDER.objects({ signal: new AbortController().signal, isActive: () => true });
  await settle();

  const main = w.document.querySelector('#main .main-scroll');
  const marks = skeletonOf(main);
  assert.ok(marks.length > 0, '数据页在数据到达前一处骨架都没有 ⇒ 还是那个大空块');
  assert.equal(main.querySelectorAll('.platform-loading').length, 0,
    '数据页还在用那个「正在读取…」的大空块（`.platform-loading`）');
  /* 骨架里不许有假数字。 */
  assert.doesNotMatch(skeletonText(main), /[0-9]/, '数据页的骨架里有数字 ⇒ 那是假数字');
  /* 表格骨架要**照真表搭**：数据格是空的（只有细线）—— 真格里是字、长度未知，塞灰条就是假的；
     表头格带一条短灰条；行高＝真表那一档（`.dataset-table` 的 38px）。 */
  const table = main.querySelector('.platform-skeleton-table');
  assert.ok(table, '数据页的表格骨架不是「表格形状」');
  assert.equal(table.style.getPropertyValue('--sk-row-h'), '38px',
    '表格骨架的行高不是真表那一档（38px）⇒ 数据到了会跳版');
  const dataCells = [...table.querySelectorAll('.platform-skeleton-tr:not(.platform-skeleton-thead) .platform-skeleton-td')];
  assert.ok(dataCells.length > 0, '表格骨架里没有数据格');
  for (const cell of dataCells) {
    assert.equal(cell.querySelector('.platform-skeleton-bar'), null,
      '数据格里塞了灰条 ⇒ 那是假的（真格里是字，长度未知）');
  }
  for (const cell of table.querySelectorAll('.platform-skeleton-thead .platform-skeleton-td')) {
    assert.ok(cell.querySelector('.review-skeleton-bar, .platform-skeleton-bar'),
      '表头格里没有短灰条 ⇒ 表头不像真表');
  }
  void running;
});

/* ───────────────── ⑤ 应用页：数据到达前画骨架 ───────────────── */

test('⑤ 应用页：数据没到 ⇒ 画的是灰底骨架，不是那个大空块', async () => {
  const { context, w } = mount([{ name: 'real-applications.js', text: APPLICATIONS_SOURCE }]);
  const running = context.RENDER.applications({ signal: new AbortController().signal, isActive: () => true });
  await settle();

  const main = w.document.querySelector('#main .main-scroll');
  assert.ok(skeletonOf(main).length > 0, '应用页在数据到达前一处骨架都没有 ⇒ 还是那个大空块');
  assert.equal(main.querySelectorAll('.platform-loading').length, 0,
    '应用页还在用那个「正在读取…」的大空块（`.platform-loading`）');
  assert.doesNotMatch(skeletonText(main), /[0-9]/, '应用页的骨架里有数字 ⇒ 那是假数字');
  void running;
});

/* ───────────────── ⑥ 待办页：数据到达前画骨架（表格形状）───────────────── */

test('⑥ 待办页：数据没到 ⇒ 画的是灰底骨架（表格形状），不是那个大空块', async () => {
  const { context, w } = mount([
    { name: 'unified-work.js', text: UNIFIED_WORK_SOURCE },
  ]);
  const host = w.document.querySelector('#main .main-scroll');
  const running = context.RENDER.flowdesign({ host, signal: new AbortController().signal, isActive: () => true });
  await settle();

  const pane = host.querySelector('.unified-work-pane');
  assert.ok(pane, '待办页没有那一格内容区（`.unified-work-pane`）');
  assert.ok(skeletonOf(pane).length > 0, '待办页在数据到达前一处骨架都没有 ⇒ 还是那个大空块');
  assert.equal(pane.querySelectorAll('.platform-loading').length, 0,
    '待办页还在用那个「正在读取待办…」的大空块（`.platform-loading`）');
  /* 待办最终是一张**表** ⇒ 骨架照表格画，而且**就是那张真表**（`.dtable`）。 */
  const table = pane.querySelector('table.dtable');
  assert.ok(table, '待办页的骨架不是表格形状');
  /* 真列名留着（那一档的列名本来就是固定的，不是假的）。 */
  assert.match(table.textContent || '', /事项/);
  /* 数据行**空着**（只有细线）—— 真格里是字、长度未知 ⇒ 塞灰条就是假的。 */
  const dataRows = table.querySelectorAll('tr[data-skeleton-row]');
  assert.ok(dataRows.length > 0, '待办表的骨架里没有空数据行');
  for (const row of dataRows) {
    assert.equal(row.querySelector('.platform-skeleton-bar'), null,
      '待办表的数据格里塞了灰条 ⇒ 那是假的（真格里是字，长度未知）');
  }
  assert.doesNotMatch(skeletonText(pane), /[0-9]/, '待办页的骨架里有数字 ⇒ 那是假数字');
  void running;
});

/* ───────────────── ⑦ 通知书助手 / 邮件规则表：数据到达前画骨架 ───────────────── */

test('⑦ 通知书助手与邮件规则表：数据没到 ⇒ 画的是灰底骨架（概览 ＋ 表），不是那个大空块', async () => {
  const { context, w } = mount([
    { name: 'example-domain-notice-assistant.js', text: NOTICE_SOURCE },
    { name: 'example-domain-mail-rules.js', text: RULES_SOURCE },
  ], {
    extra: {
      createToolWorkspace: () => ({ notify() {}, dialog() {}, dispose() {} }),
      /* 域的公共读口：**一直不回来** ⇒ 这一页停在「正在取数」那一刻。 */
      shangshuIpexample: {
        managedCatalog: async () => new Promise(() => {}),
        execute: async () => new Promise(() => {}),
      },
      shangshuRegisterPages: () => {},
      shangshuRegisterNav: () => {},
    },
  });

  /* 两页各挂各的宿主（同一个宿主会被后挂的那一页整个换掉）。 */
  const assistantHost = w.document.createElement('div');
  const rulesHost = w.document.createElement('div');
  w.document.querySelector('#main .main-scroll').append(assistantHost, rulesHost);
  let mountError = null;
  context.mountexampleNoticeAssistant(assistantHost, { signal: new AbortController().signal }).catch(error => { mountError = error; });
  context.mountexampleMailRules(rulesHost, { signal: new AbortController().signal }).catch(error => { mountError = error; });
  await settle();
  assert.ok(!mountError, '通知书助手／邮件规则表挂载失败：' + (mountError && mountError.message));
  const host = assistantHost;

  const assistant = host.querySelector('.example-host-page');
  assert.ok(assistant, '通知书助手没有挂上');
  const assistantBody = assistant.querySelector('[data-host-body]');
  assert.ok(skeletonOf(assistantBody).length > 0, '通知书助手在数据到达前一处骨架都没有 ⇒ 还是那个大空块');
  assert.equal(assistantBody.querySelectorAll('.platform-loading').length, 0,
    '通知书助手还在用那个「正在读取 Host 状态…」的大空块（`.platform-loading`）');
  /* 概览一排四格 ＋ 一张来源包表 ⇒ 骨架是这两块。 */
  assert.ok(assistantBody.querySelector('.example-host-facts'), '通知书助手的骨架缺了那排概览');
  /* 来源包表：真表头留着（列名是真的），数据行**空着**（只有细线）。 */
  const packages = assistantBody.querySelector('.example-host-packages .obj-table');
  assert.ok(packages, '通知书助手的骨架缺了那张来源包表');
  const packageRows = packages.querySelectorAll('tr[data-skeleton-row]');
  assert.ok(packageRows.length > 0, '来源包表的骨架里没有空数据行');
  for (const row of packageRows) {
    assert.equal(row.querySelector('.platform-skeleton-bar'), null,
      '来源包表的数据行里塞了灰条 ⇒ 那是假的（真格里是字，长度未知）');
  }
  assert.doesNotMatch(skeletonText(assistantBody), /[0-9]/, '通知书助手的骨架里有数字 ⇒ 那是假数字');

  const rules = rulesHost.querySelector('.example-rules-page');
  assert.ok(rules, '邮件规则表没有挂上');
  const rulesBody = rules.querySelector('[data-rules-body]');
  assert.ok(skeletonOf(rulesBody).length > 0, '邮件规则表在数据到达前一处骨架都没有 ⇒ 还是那个大空块');
  assert.equal(rulesBody.querySelectorAll('.platform-loading').length, 0,
    '邮件规则表还在用那个「正在读取邮件规则…」的大空块（`.platform-loading`）');
  assert.doesNotMatch(skeletonText(rulesBody), /[0-9]/, '邮件规则表的骨架里有数字 ⇒ 那是假数字');
});

/* ───────────────── ⑧ 约定：全站不再有那个大空块 ───────────────── */

test('⑧ 全站 js 里不再有 `.platform-loading` 那个大空块（谁改回去，这条立刻红）', () => {
  const files = [
    'shangshu-web/js/real-dashboard.js',
    'shangshu-web/js/real-objects.js',
    'shangshu-web/js/real-applications.js',
    'shangshu-web/js/unified-work.js',
    'shangshu-web/js/domains/example-domain/example-domain-notice-assistant.js',
    'shangshu-web/js/domains/example-domain/example-domain-mail-rules.js',
  ];
  for (const file of files) {
    const source = readSource(file);
    assert.doesNotMatch(source, /class="platform-loading"/,
      `${file} 还在用那个「正在读取…」的大空块（platform-loading）⇒ 取数期间看不见灰底骨架`);
    assert.doesNotMatch(source, /platform-loading/,
      `${file} 里还有「platform-loading」这个写法`);
  }
});

/* ───────────────── ⑨ 审核中心：卡片区在取数时摆的是骨架卡 ───────────────── */

test('⑨ 审核中心：卡还没到 ⇒ 卡片区摆的是**卡形状的骨架**（不是空网格）；卡到了 ⇒ 骨架被换掉', async () => {
  const dom = createDom();
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const { window } = loadShell(dom);
  /* 这一档的清单**一直不回来** ⇒ 卡片区停在「正在取数」那一刻。 */
  registerSampleDeclaration(window, { list: async () => { await gate; return [sampleCard()]; } });
  const host = pageHost(dom);
  const mounting = window.shangshuReviewCenter.mountPage(host, {});
  await settleReview();

  const grid = dom.body.querySelector('[data-review-card-grid]');
  assert.ok(grid, '审核中心没有卡片区');
  const skeletons = grid.querySelectorAll('[data-skeleton="review-card"]');
  assert.ok(skeletons.length > 0,
    '审核中心的卡还没到，卡片区却一块骨架都没有 ⇒ 那一段是空网格（看不见「内容正在来」）');
  /* 骨架里不许有假标题、假项数；也不许冒充真卡。 */
  for (const skeleton of skeletons) {
    assert.equal(skeleton.textContent.trim(), '', '审核中心的骨架里有字 ⇒ 那是假标题');
    assert.equal(skeleton.querySelector('[data-review-card]'), null, '审核中心的骨架被当成真卡了');
  }
  /* 骨架卡要**照真卡搭**：真标题块（绿块那层）＋ 类型块 ＋ 「打开核对」那个按钮位。 */
  const card = skeletons[0];
  assert.ok(card.querySelector('.review-card-head'), '审核中心的骨架卡没有标题块 ⇒ 不像真卡');
  assert.ok(card.querySelector('.review-card-icon'), '审核中心的骨架卡没有类型块 ⇒ 不像真卡');
  assert.ok(card.querySelector('.review-skeleton-action'), '审核中心的骨架卡没有按钮位 ⇒ 不像真卡');
  /* 加载态＝**会呼吸的骨架**（契约 `loading-state-v1.json`）：看得见的字没了、灰条在；
     它在状态区，**不在**卡片区里（不占卡位）。 */
  const loading = dom.body.querySelector('[data-review-loading]');
  assert.ok(loading, '审核中心连加载标记都没有了 ⇒ 人不知道它在等');
  assert.ok(loading.querySelector('.platform-skeleton-bar, .review-skeleton-bar'),
    '审核中心的加载态不是骨架（没有灰条）⇒ 人看见的是一片空白');
  assert.ok(!loading.closest('[data-review-card-grid]'),
    '加载态又跑进卡片区里了（占卡位、把下面的卡挤歪）');

  release();
  await mounting;
  await settleReview();
  assert.equal(grid.querySelectorAll('[data-skeleton="review-card"]').length, 0,
    '数据到了，骨架还留着 ⇒ 没有原位替换');
  assert.ok(grid.querySelectorAll('[data-review-card]').length > 0, '数据到了却没有真卡');
});


/* ───────────────── ⑩ 表格中心：记录在路上 ⇒ 表里是**空骨架行** ───────────────── */

test('⑩ 表格中心：记录还在路上 ⇒ 数据行是**空骨架行**（不是一行「正在读取记录…」）', async () => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/index.html#/sheets', runScripts: 'outside-only' });
  const w = dom.window;
  const host = w.document.querySelector('#host');
  /* ⚠️ 用 **jsdom 自己的** AbortController —— 那一页把 signal 交给 window.addEventListener，
     jsdom 只认自己的 AbortSignal（Node 的那个会被它拒收）。 */
  const controller = new w.AbortController();
  const context = {
    console,
    RENDER: {},
    document: w.document,
    window: null,
    location: { href: 'http://localhost/index.html#/sheets' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    currentUserInfo: { role: 'staff', username: 'tester' },
    URL,
    URLSearchParams,
    $: (selector, root = w.document) => root.querySelector(selector),
    $$: (selector, root = w.document) => [...root.querySelectorAll(selector)],
    esc: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escape: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    /* 数据表清单**回来了**，记录那一条**一直不回来** ⇒ 停在「正在取数」那一刻。 */
    fetch: async (url) => {
      const path = String(url);
      if (path.startsWith('/api/platform/objects/')) return new Promise(() => {});
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          list: [{
            id: 'OBJ-1', title: '企业文件', source: 'managed', revision: 1,
            fields: [{ id: 'title', label: '名称', type: 'text' }, { id: 'status', label: '状态', type: 'choice', options: ['进行中'] }],
            operations: [], query: { sort_fields: [], search_max_length: 200 },
          }],
        }),
      };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    /* 工作区外壳（表格中心用的那套工具台）。
       ⚠️ 那一页的 `$`／`escape`／`notify` 是**从 ui 上解构**来的（`const {$, escape, notify} = ui;`），
       ⇒ 桩里必须给这三个，不然页内第一句 `$('#undo')` 就不是函数了。 */
    createToolWorkspace: (workspaceHost) => ({
      signal: controller.signal,
      disposed: false,
      $: (selector, root = workspaceHost) => root.querySelector(selector),
      escape: value => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      notify() {},
      dispose() {},
      modal: () => ({ firstElementChild: { classList: { add() {} } }, querySelector: () => null }),
      closeModal() {},
      toggleExamples() {},
      onDispose() {},
      guardLeave() {},
      guardModal() {},
    }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SHEET_SOURCE, context, { filename: 'sheet-center.js' });

  context.window.mountSheetCenter(host, { signal: controller.signal, objectId: 'OBJ-1' });
  await settle();

  const table = host.querySelector('#sheet-rows');
  assert.ok(table, '表格中心没有那张表（`#sheet-rows`）');
  const skeletonRows = table.querySelectorAll('tr[data-skeleton-row]');
  assert.ok(skeletonRows.length > 0,
    '表格中心的记录还没到，表里却只有一行字（不是空骨架行）⇒ 又回到「正在读取记录…」那一版');
  for (const row of skeletonRows) {
    assert.equal(row.querySelector('.platform-skeleton-bar'), null,
      '数据行里塞了灰条 ⇒ 那是假的（真格里是字，长度未知）');
    /* 列是记录回执里带的 ⇒ 加载时列数还不知道 ⇒ 骨架行是**一整行**（colspan），不是假列。 */
    const cells = row.querySelectorAll('td');
    assert.equal(cells.length, 1, '骨架行不是一整行（加载时列数还不知道，画成一格一格就是假结构）');
    assert.ok(Number(cells[0].getAttribute('colspan')) > 1, '骨架行没有跨列 ⇒ 挤成了一列');
  }
  assert.doesNotMatch(table.textContent || '', /正在读取/, '表格中心还在用「正在读取…」那一行字');
});


/* ───────────────── ⑪ 内核规则：加载骨架那条不许被悄悄删掉 ───────────────── */

test('⑪ 内核里有「加载骨架」这条规则（人读规范 ＋ 机器规则），且全站都守得住', () => {
  /* ① 机器规则在 `style-rules.json` 里（id 固定，删了这条红）。 */
  const rules = JSON.parse(readSource('shangshu-web/style-rules.json')).rules;
  const rule = rules.find(r => r.id === 'L-01');
  assert.ok(rule, '内核的机器规则里没有「加载骨架」这条（L-01）⇒ 规则被删了');
  assert.equal(rule.type, 'loadingSkeleton');
  assert.ok(rule.paths.some(p => p.includes('shangshu-web/js')),
    '加载骨架那条规则没有扫 `shangshu-web/js` ⇒ 业务域管不到');
  assert.ok(rule.bigEmptyBlock, '加载骨架那条规则没有盯那个大空块');

  /* ② 人读规范里有这一节（业务域同样适用）。 */
  const spec = readSource('docs/standards/visual-consistency-rules.md');
  assert.match(spec, /8\.1 加载骨架/, '视觉一致性规范里没有「加载骨架」这一节');
  assert.match(spec, /业务域同样适用/, '规范里没写清业务域同样适用');

  /* ③ 规则守得住：全站 js（**含业务域**）不许再有大空块；用了骨架词汇的文件必须有标记。 */
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = dir + '/' + entry.name;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(fileURLToPath(new URL('../../', import.meta.url)));
  assert.ok(files.length > 20, '没扫到 js 文件（路径不对？）');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = file.split('/shangshu-web/')[1] || file;
    assert.doesNotMatch(source, /class="platform-loading"/,
      `${rel} 还在用那个大空块（.platform-loading）⇒ 加载态看不见灰底骨架`);
    const usesSkeleton = /class="[^"]*\bskeleton[-_a-z0-9]*/i.test(source);
    if (usesSkeleton) {
      assert.ok(source.includes('data-skeleton'),
        `${rel} 用了骨架词汇，却没有一处 data-skeleton 标记 ⇒ 骨架查不到、盯不住`);
    }
  }
});
