// 判据：这七页的**页面加载态** —— 不只是「那几句话没了」，还要**真的有骨架**。
//
// **测试通过 =**（一句话）
// 「用户打开这七页中的任意一页，数据还在路上的时候：① **看得见的加载文字一个字都没有**
//   （只剩会呼吸的灰条）；② 那一块摆的是**骨架**（公共灰条 `.platform-skeleton-bar`
//   ＋ `data-skeleton` 标记）；③ 骨架里**没有假内容**（没有假标题／假项数／假数字）；
//   ④ 数据到了，骨架在**同一个容器**里被换掉（换成真内容，不跳版）。」
//
// **为什么要有这条**（契约 `frappe_apps/shangshu_core/shangshu_core/contracts/loading-state-v1.json`
//   · 用户 2026-10-28 指示「每一个页面的加载都不要用文字了，都用骨架代码的呼吸来代替」）：
//   `check-loading-state-contract.test.mjs` ④ 断的是**源码里那几句话没了** ——
//   只把文字删掉、不摆骨架，它照样是绿的 ⇒ **「没有字」不等于「有骨架」**。
//   ⇒ 这条补上另一半：**必须真的画出骨架**（而且是公共那一份会呼吸的灰条）。
//
// ⚠️ **呼吸只有一份实现**（公共样式那条 `@keyframes platform-skeleton-breathe`）——
//   各页**不许**自己另写一套呼吸（那就是两份实现了，节奏还不一样）。
// ⚠️ **不许有看得见的加载文字** —— 读屏的信号用 `aria-busy`（不写字）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require_ = createRequire(new URL('../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom');

const ROOT = new URL('../../../', import.meta.url);
const readSource = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/**
 * **这七页的加载态**（按文件点名 · 与契约点名的那几页一一对应）。
 * `phrases`＝那一页**不许再写**的加载文字；`shape`＝那一页骨架的形状名。
 */
const PAGES = [
  { file: 'shangshu-web/js/personal-settings.js', phrases: ['正在读取当前账号'], shape: 'account' },
  { file: 'shangshu-web/js/proposal-review.js', phrases: ['读取中', '正在读取原记录'], shape: 'review-' },
  { file: 'shangshu-web/js/real-chat.js', phrases: ['正在加载历史对话', '正在读取实际状态', '正在读取本次操作的真实内容', '正在读取当前状态'], shape: 'chat-' },
  { file: 'shangshu-web/js/real-im.js', phrases: ['正在读取消息', '正在读取原消息', '正在读取…'], shape: 'im-' },
  { file: 'shangshu-web/js/file-reference-picker.js', phrases: ['正在读取…'], shape: 'picker-' },
  { file: 'shangshu-web/js/file-pdf.mjs', phrases: ['正在加载PDF阅读器'], shape: 'pdf-page' },
  { file: 'shangshu-web/js/sheet-center.js', phrases: ['正在读取数据表'], shape: 'sheet-' },
];

/** 页面上「看得见的加载文字」（读屏那一层不算 —— 那一层视觉上是收起来的）。 */
const LOADING_WORDS = /正在[^\s，。、；]*?(读取|加载|取数|核对)/;

/* ───────────────── ① 源码：既没有加载文字，也真的画了骨架 ───────────────── */

test('① 这七页：加载文字撤了，骨架（公共灰条 ＋ data-skeleton）摆上了', () => {
  for (const { file, phrases, shape } of PAGES) {
    const source = readSource(file);
    for (const phrase of phrases) {
      assert.ok(!source.includes(phrase),
        `${file} 里还写着「${phrase}」⇒ 加载态还在用文字（契约 loading-state-v1.json）`);
    }
    /* 骨架**真的画了**：公共灰条 ＋ 形状标记（缺一个就只是「把字删了」）。 */
    assert.ok(source.includes('platform-skeleton-bar'),
      `${file} 里没有用公共灰条「.platform-skeleton-bar」⇒ 加载态不是骨架（人看见的是一片空白）`);
    assert.ok(source.includes('data-skeleton'),
      `${file} 里没有「data-skeleton」形状标记 ⇒ 骨架没有认领自己的形状`);
    assert.ok(source.includes(shape),
      `${file} 里没有「${shape}」那个形状标记 ⇒ 骨架的形状名跟这一页对不上`);
    /* 骨架里**不许有假内容** —— 公共骨架零件是定宽的灰条，不带任何数字。 */
    const skeletonMarkup = source.match(/platform-skeleton-bar[^"']*/g) || [];
    assert.ok(skeletonMarkup.length > 0, `${file} 里一处骨架灰条都没有`);
    /* 呼吸**只有一份实现**（公共样式那一条）—— 各页不许自己另写。 */
    assert.doesNotMatch(source, /@keyframes[^{]*skeleton/i,
      `${file} 里自己又写了一套骨架呼吸 ⇒ 呼吸不止一份实现`);
  }
});

/* ───────────────── ② 个人设置：加载中 ⇒ 骨架；数据到了 ⇒ 原位换掉 ───────────────── */

/** 装一份壳起来（真 jsdom ＋ 真页面源码）。`fetch` 由判据控制：扣住 or 放回。 */
function mountPage(source, { fetchImpl, extra = {} } = {}) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/index.html#/personal-settings', runScripts: 'outside-only' });
  const w = dom.window;
  const controller = new w.AbortController();
  const context = {
    console,
    RENDER: {},
    document: w.document,
    location: { href: 'http://localhost/index.html#/personal-settings' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    currentUserInfo: { role: 'staff', username: 'tester' },
    URL,
    URLSearchParams,
    Event: w.Event,
    CustomEvent: w.CustomEvent,
    AbortController: w.AbortController,
    crypto,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    fetch: fetchImpl,
    api: async () => new Promise(() => {}),
    go: () => {},
    toast: () => {},
    window: null,
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'page' });
  const host = w.document.querySelector('#host');
  return { context, w, host };
}

test('② 个人设置：账号还没读到 ⇒ 看得见的字没了、灰条在呼吸；读回来 ⇒ 骨架原位换掉', async () => {
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const { context, host } = mountPage(readSource('shangshu-web/js/personal-settings.js'), {
    fetchImpl: async () => { await gate; return { ok: true, json: async () => ({ authed: true, user: { display_name: '管理员' }, platform: { user_name: 'Administrator' } }) }; },
    extra: {
      createToolWorkspace: () => ({ escape: v => String(v ?? ''), signal: new AbortController().signal, disposed: false, dispose() {} }),
      accountMenuModules: () => [],
    },
  });

  const mounting = context.mountPersonalSettings(host, {});
  await settle();

  /* 加载态：骨架在、字没有。 */
  const skeleton = host.querySelector('[data-skeleton="account"]');
  assert.ok(skeleton, '个人设置加载中连骨架都没有 ⇒ 人看见的是一片空白');
  assert.ok(skeleton.querySelector('.platform-skeleton-bar'), '个人设置的骨架里没有灰条');
  assert.ok(!LOADING_WORDS.test(host.textContent || ''), '个人设置加载中还有看得见的加载文字：' + (host.textContent || '').slice(0, 80));
  assert.equal(host.querySelectorAll('[aria-busy="true"]').length, 1, '个人设置的加载态没有标 aria-busy（读屏的人不知道它在等）');
  /* 骨架里**不许有假数字**。 */
  assert.doesNotMatch(skeleton.textContent || '', /[0-9]/, '个人设置的骨架里有数字 ⇒ 那是假数字');

  /* 数据到了 ⇒ 同一个容器里骨架被换掉（真内容在、骨架没了）。 */
  release();
  await mounting;
  await settle();
  assert.equal(host.querySelector('[data-skeleton="account"]'), null, '数据到了骨架还留着 ⇒ 没有原位替换');
  assert.match(host.textContent || '', /Administrator/, '数据到了却没有真内容');
  assert.equal(host.querySelectorAll('[aria-busy="true"]').length, 0, '数据到了还挂着 aria-busy');
});

/* ───────────────── ③ 聊天那张「修改审核」卡：回执没来 ⇒ 骨架 ───────────────── */

test('③ 修改审核卡：回执还没来 ⇒ 卡上是骨架（不是「读取中」那种字）；回执来了 ⇒ 换回真的状态与标题', async () => {
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const view = {
    id: 'PROP-1', target: { module: 'mail', name: '草稿 2026-10-28' }, units: [],
    accepted_count: 0, remaining: 0, status: 'confirmed', review_revision: 'rev-1',
  };
  const { context, host } = mountPage(readSource('shangshu-web/js/proposal-review.js'), {
    extra: {
      api: async () => { await gate; return { ok: true, status: 200, json: async () => ({ ok: true, ...view }) }; },
      resolveConfirmation: async () => ({ ok: true }),
    },
  });

  const card = context.mountProposalReview(host, { id: 'PROP-1' });
  await settle();

  /* 加载态：卡上有骨架灰条，没有加载文字。 */
  const skeletons = card.querySelectorAll('[data-skeleton]');
  assert.ok(skeletons.length > 0, '修改审核卡在回执没来时一处骨架都没有');
  assert.ok(card.querySelector('.platform-skeleton-bar'), '修改审核卡的骨架里没有灰条');
  assert.ok(!LOADING_WORDS.test(card.textContent || ''), '修改审核卡上还看得见加载文字：' + (card.textContent || '').slice(0, 80));
  assert.doesNotMatch(card.textContent || '', /[0-9]/, '修改审核卡的骨架里有数字 ⇒ 那是假数字');

  /* 回执到了 ⇒ 骨架被换掉：真的状态标签 ＋ 真的标题。 */
  release();
  await settle();
  assert.equal(card.querySelectorAll('[data-skeleton]').length, 0, '回执到了骨架还留着 ⇒ 没有原位替换');
  assert.match(card.textContent || '', /已确认/, '回执到了却没有真的状态标签');
  assert.match(card.textContent || '', /草稿 2026-10-28/, '回执到了却没有真的标题');
});
