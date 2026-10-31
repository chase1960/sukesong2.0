// 判据：example 域的两个页面（**官文助手** / **邮件规则表**）**结构一样多**、**留白同一条线**。
//
// **测试通过 =**（一句话）
// 「点进『官文助手』和『邮件规则表』，两个页面是**同一套骨架**：都有域内上下文条（面包屑）、
//   都有标准页头（标题＋副标题＋操作区）、都有概览四格、都有主内容区、都有**标准空态**
//   （一句话＋一条出路）、都有计数行；
//   而且两个页面的左右留白**跟公共壳是同一个数**（26px，窄屏 16px）——
//   页头标题与概览四格的左边缘落在同一条竖线上，
//   跟工作台、应用中心那些页**看起来是同一个站**。」
//
// 为什么要有这条（用户 2026-10-22 16:49 原话）：
//   「官文助手和邮件规则表也都不一样，还会少元素。」
//   —— 实算出来的差：
//   · 邮件规则表**没有面包屑**（官文助手有）；
//   · 邮件规则表的页头**少一个类** `.platform-page-head` ⇒ 标题与按钮的对齐方式跟官文助手不同；
//   · 邮件规则表**没有计数行**（官文助手有）；
//   · 官文助手**没有标准空态**（只有表格里一行灰字；邮件规则表有 `.platform-empty`）；
//   · 两页的概览第四格都用了 `-wide` 这个类，而 **CSS 里从来没定义过** ⇒ 那一格被挤在 1/4 列里。
//
// ⚠️ **判据断的是「渲染出来的真实 DOM」与「算出来的像素数」**：
//   页面脚本在 `node:vm` 里真跑一遍（数据都读不到 ⇒ 落进空态那条路），
//   取出它**自己写进 DOM 的 HTML**，再解析成结构树来比 —— 不是断源码里的字符串。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { createResolver, sides, px } from '../../../scripts/lib/css-cascade.mjs';

const ROOT = new URL('../../../', import.meta.url);
const DOMAIN = new URL('js/domains/example-domain/', new URL('shangshu-web/', ROOT));
const resolver = createResolver(ROOT);

const WIDE = 1440;
const NARROW = 600;

/* ───────────────── 页面脚本跑起来，取它自己写的 DOM ───────────────── */

/** 一个够用的假元素：把 innerHTML 记下来，querySelector 返回可记录的对象。 */
function fakeElement() {
  const el = {
    tagName: 'DIV',
    _html: '',
    className: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild(child) { return child; }, remove() {}, closest: () => null,
    addEventListener() {},
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
  };
  return el;
}

/** 把域页面脚本跑进假窗口，返回它写进 host 的 HTML 与内容区的 HTML。 */
async function renderPage(file, mountName) {
  const source = fs.readFileSync(new URL(file, DOMAIN), 'utf8');
  const bodies = [];
  const host = fakeElement();
  host.querySelector = (selector) => {
    const el = fakeElement();
    if (String(selector).includes('body')) bodies.push(el);
    return el;
  };
  const context = {
    console: { warn() {}, log() {}, error() {} },
    RENDER: {},
    window: {
      shangshuRegisterPages: () => {}, shangshuRegisterNav: () => {},
      shangshuIpexample: {
        execute: async () => ({}), write: async () => ({}),
        managedCatalog: async () => [], managedRecordsById: async () => [],
      },
      createToolWorkspace: () => ({ notify() {}, dispose() {}, escape: value => value }),
    },
    document: { addEventListener: () => {} },
    location: { href: '' },
    fetch: async () => ({ ok: true, json: async () => ({ user_name: 'tester' }) }),
    URL,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.window[mountName](host, {});
  return { root: host.innerHTML, body: bodies.map(el => el.innerHTML).filter(Boolean).join('') };
}

/* ───────────────── 最小 HTML 结构解析 ───────────────── */

function parseTree(html) {
  const root = { tag: '#root', classes: [], children: [] };
  const stack = [root];
  const tagRe = /<(\/)?([a-zA-Z0-9-]+)((?:\s+[^>]*?)?)(\/)?>/g;
  let matched;
  while ((matched = tagRe.exec(html))) {
    const [, closing, tag, attrs, selfClose] = matched;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const classes = (attrs.match(/class="([^"]*)"/) || ['', ''])[1].split(/\s+/).filter(Boolean);
    const node = { tag, classes, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !/^(br|hr|img|input|meta|link)$/i.test(tag)) stack.push(node);
  }
  return root;
}

/** 一棵子树里，出现过的 class 集合。 */
function classesIn(node, into = new Set()) {
  for (const cls of node.classes) into.add(cls);
  for (const child of node.children) classesIn(child, into);
  return into;
}

/* ───────────────── 结构角色（两页必须一样多） ───────────────── */

/** 页面根的**直接子节点**上，每个结构角色对应的 class。 */
const ROLES = [
  ['面包屑', /(^|\s)example-page-crumb(\s|$)/],
  ['页头', /(^|\s)page-hd(\s|$)/],
  ['内容区', /(^|\s)example-(host|rules)-body(\s|$)/],
];

/** 内容区里的结构角色。 */
const BODY_ROLES = [
  ['概览四格', /(^|\s)example-(host|rules)-facts(\s|$)/],
  ['标准空态', /(^|\s)platform-empty(\s|$)/],
  ['计数行', /(^|\s)example-(host|rules)-foot(\s|$)/],
];

test('① 两个页面的**页面骨架**一样：面包屑 ＋ 标准页头 ＋ 内容区', async () => {
  const pages = {
    官文助手: await renderPage('example-domain-notice-assistant.js', 'mountexampleNoticeAssistant'),
    邮件规则表: await renderPage('example-domain-mail-rules.js', 'mountexampleMailRules'),
  };
  const inventory = {};
  for (const [name, page] of Object.entries(pages)) {
    const tree = parseTree(page.root);
    const rootNode = tree.children[0];
    assert.ok(rootNode, `${name}：页面根没画出来`);
    const childClasses = rootNode.children.map(child => child.classes.join(' '));
    inventory[name] = {};
    for (const [role, pattern] of ROLES) {
      inventory[name][role] = childClasses.filter(text => pattern.test(text));
    }
    /* 页头必须是**标准页头类**：两个页面都用 `.page-hd.platform-page-head`，
       否则标题与按钮的对齐方式不一样（`.page-hd` 居中 24px gap；`.platform-page-head` 顶对齐 16px gap）。 */
    const head = childClasses.filter(text => /(^|\s)page-hd(\s|$)/.test(text));
    assert.equal(head.length, 1, `${name}：页头不是一个`);
    assert.match(head[0], /(^|\s)platform-page-head(\s|$)/,
      `${name}：页头少了「.platform-page-head」⇒ 标题与按钮的对齐方式跟另一个页面不一样`);
  }
  for (const [role] of ROLES) {
    for (const name of Object.keys(inventory)) {
      assert.equal(inventory[name][role].length, 1,
        `${name}：「${role}」有 ${inventory[name][role].length} 个 —— 两个页面必须各有一个（结构一样多）`);
    }
  }
});

test('② 两个页面的**内容区**一样：概览四格 ＋ 标准空态 ＋ 计数行', async () => {
  const pages = {
    官文助手: await renderPage('example-domain-notice-assistant.js', 'mountexampleNoticeAssistant'),
    邮件规则表: await renderPage('example-domain-mail-rules.js', 'mountexampleMailRules'),
  };
  const inventory = {};
  for (const [name, page] of Object.entries(pages)) {
    const bodyTree = parseTree(page.body);
    const classes = classesIn(bodyTree);
    inventory[name] = {};
    for (const [role, pattern] of BODY_ROLES) {
      inventory[name][role] = [...classes].filter(cls => pattern.test(cls));
    }
  }
  for (const [role] of BODY_ROLES) {
    for (const name of Object.keys(inventory)) {
      assert.equal(inventory[name][role].length, 1,
        `${name}：内容区里「${role}」有 ${inventory[name][role].length} 个 —— 两个页面必须各有一个（结构一样多）`);
    }
  }
});

test('③ 概览第四格**占满整行**（`-wide` 这个类此前 CSS 里根本没定义 ⇒ 那格被挤在 1/4 列里）', async () => {
  const css = fs.readFileSync(new URL('css/domains/example-domain/example-domain.css', new URL('shangshu-web/', ROOT)), 'utf8');
  for (const selector of ['.example-host-fact-wide', '.example-rules-fact-wide']) {
    assert.ok(css.includes(selector), `${selector} 在 CSS 里没有定义 —— 第四格会被挤在 1/4 列里`);
  }
  const rule = /\.example-(host|rules)-fact-wide\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'wide 格的样式没写');
  assert.match(rule[2], /grid-column\s*:\s*1\s*\/\s*-1/, 'wide 格没有占满整行');
});

/* ───────────────── 留白：两个页面跟公共壳同一条线 ───────────────── */

test('④ 两个页面的页面容器**不再自带横向留白**（留白只由公共壳那一层 `.platform-page` 给）', () => {
  for (const selector of ['.example-host-page', '.example-rules-page']) {
    for (const viewport of [WIDE, NARROW]) {
      const own = resolver.leftEdge(
        [{ file: 'css/domains/example-domain/example-domain.css', selector }],
        { viewport },
      );
      assert.equal(own.edge, 0,
        `${selector}（${viewport === WIDE ? '宽屏' : '窄屏'}）自己还带着 ${own.edge}px 的横向留白 —— `
        + '横向留白只能由统一的那一层给');
    }
  }
});

test('⑤ 两个页面的页头文字与概览四格**落在同一条竖线**上（26px ／ 窄屏 16px）', () => {
  for (const [viewport, want] of [[WIDE, 26], [NARROW, 16]]) {
    const gutter = resolver.pageGutter({ viewport });
    assert.equal(gutter, want, `整页留白是 ${gutter}px —— 应为 ${want}px`);
    for (const page of ['.example-host-page', '.example-rules-page']) {
      const head = resolver.leftEdge([
        { file: 'css/platform.css', selector: '.platform-page' },
        { file: 'css/workbench.css', selector: '.page-hd' },
      ], { viewport });
      assert.equal(head.edge, want, `${page} 的页头文字左边缘是 ${head.edge}px —— 应为 ${want}px`);
      const facts = resolver.leftEdgeOuter([
        { file: 'css/platform.css', selector: '.platform-page' },
        { file: 'css/domains/example-domain/example-domain.css', selector: page },
        { file: 'css/domains/example-domain/example-domain.css', selector: page === '.example-host-page' ? '.example-host-body' : '.example-rules-body' },
      ], { viewport });
      const factsEdge = resolver.pageGutter({ viewport }) + facts.edge;
      assert.equal(factsEdge, want, `${page} 的概览四格外沿是 ${factsEdge}px —— 应为 ${want}px`);
    }
  }
});

test('⑥ 域内**块内 padding** 跟公共壳同一个数（16px）', () => {
  const css = fs.readFileSync(new URL('css/domains/example-domain/example-domain.css', new URL('shangshu-web/', ROOT)), 'utf8');
  for (const selector of ['.example-host-commands', '.example-rule']) {
    const matched = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css);
    assert.ok(matched, `${selector} 的样式没找到`);
    const padding = /padding\s*:\s*([^;]+)/.exec(matched[1]);
    assert.ok(padding, `${selector} 没有内边距`);
    const parts = padding[1].trim().split(/\s+/);
    const left = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : parts.length === 3 ? parts[1] : parts[3];
    assert.equal(px(left), 16, `${selector} 的左内边距是 ${left} —— 应为 16px（同公共壳）`);
  }
});
