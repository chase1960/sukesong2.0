/* PDF 阅读器 · 工具条定向判据（PKG-132 · 10.1 第 4 项「图四样式优化」）。
 *
 * **测试通过 =**（一句话）
 *   「PDF 阅读器的工具条是**一行**的紧凑公共控件：上一页｜页码（小框）｜下一页｜缩放｜
 *     查找（**默认收起**，展开后照样能查）｜独立打开（次要入口）；
 *     「第 X / Y 页 · 只读原件」那行重复整行没了；控件约 32px 高、页码框不是 64px 大框；
 *     正文（.file-pdf-viewport）吃满剩余高度；翻页/缩放/查找/独立打开一个都不少
 *     （「本页文字」那一块 2026-10-28 按用户要求从界面上去掉了 ⇒ T8 跟着改口径）。」
 *
 * **为什么自带 DOM 桩**：仓库没有 jsdom（`node_modules` 只有 react 等四个包），
 * `scripts/tests/mini-dom.mjs` 又**不支持 innerHTML 解析** ⇒ 这里手搓一个够 PDF 阅读器
 * 跑起来的最小桩（解析 + 选择器 + 事件），不引入新依赖。
 *
 * **CSS 判据断的是「算出来的生效值」** —— 用仓库自己的层叠解析器
 * （`scripts/lib/css-cascade.mjs` ＋ `helpers/css-effective.mjs`），
 * 不靠眼睛看；**审核中心那套 30px 覆盖**也算进去（那边更具体 ⇒ 那边赢，两边不打架）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver, px } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective, specificity } from './helpers/css-effective.mjs';
import { mountPdf } from '../file-pdf.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const resolver = createResolver(ROOT);
const effective = createEffective(resolver, 1440);

/* ———————————————————— 最小 DOM 桩（够 PDF 阅读器跑起来）———————————————————— */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function parseAttributes(text) {
  const out = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(text || ''))) {
    if (!match[1]) continue;
    out.push([match[1], match[2] ?? match[3] ?? match[4] ?? '']);
  }
  return out;
}

function camelToDash(key) {
  return String(key).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
}

function parseCompound(text) {
  const out = { tag: null, classes: [], id: null, attrs: [] };
  const re = /([a-z][a-z0-9-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/iy;
  let match;
  while ((match = re.exec(text))) {
    if (match[1]) out.tag = match[1].toLowerCase();
    else if (match[2]) out.classes.push(match[2]);
    else if (match[3]) out.id = match[3];
    else if (match[4]) out.attrs.push([match[4], match[5] ?? match[6] ?? match[7] ?? null]);
  }
  return out;
}

function matchesCompound(element, compound) {
  if (compound.tag && element.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && element.getAttribute('id') !== compound.id) return false;
  for (const cls of compound.classes) if (!element.classList.contains(cls)) return false;
  for (const [name, value] of compound.attrs) {
    if (!element.hasAttribute(name)) return false;
    if (value !== null && element.getAttribute(name) !== value) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  return String(selector).split(',').some(part => {
    const chain = part.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    if (!chain.length) return false;
    let node = element;
    let index = chain.length - 1;
    if (!matchesCompound(node, chain[index])) return false;
    index -= 1;
    while (index >= 0) {
      node = node.parentNode;
      if (!node || node.nodeType !== 1) return false;
      if (matchesCompound(node, chain[index])) index -= 1;
    }
    return index < 0;
  });
}

function createElement(doc, tagName) {
  const attributes = new Map();
  const children = [];
  let text = '';
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    attributes,
    children,
    parentNode: null,
    style: {},
    disabled: false,
    get className() { return attributes.get('class') || ''; },
    set className(value) { attributes.set('class', String(value)); },
    get classList() {
      return {
        contains: name => element.className.split(/\s+/).filter(Boolean).includes(name),
        add: name => { if (!element.classList.contains(name)) element.className = (element.className + ' ' + name).trim(); },
      };
    },
    get dataset() {
      return new Proxy({}, {
        get: (_, key) => attributes.get('data-' + camelToDash(key)),
        set: (_, key, value) => { attributes.set('data-' + camelToDash(key), String(value)); return true; },
      });
    },
    get textContent() {
      if (children.length) return children.map(child => child.textContent || '').join('');
      return text;
    },
    set textContent(value) {
      children.length = 0;
      text = value === undefined || value === null ? '' : String(value);
    },
    get innerHTML() { return element._html || ''; },
    set innerHTML(value) {
      element._html = String(value);
      children.length = 0;
      text = '';
      const root = parseHtml(String(value), doc);
      root.children.slice().forEach(child => { child.parentNode = element; children.push(child); });
    },
    get value() {
      if (element.tagName === 'SELECT') {
        if (element._value !== undefined) return element._value;
        const first = element.querySelector('option');
        return first ? first.getAttribute('value') || '' : '';
      }
      if (element._value !== undefined) return element._value;
      return attributes.get('value') || '';
    },
    set value(next) { element._value = next === undefined || next === null ? '' : String(next); },
    get open() { return attributes.has('open'); },
    set open(next) { if (next) attributes.set('open', ''); else attributes.delete('open'); },
    get href() { return attributes.get('href') || ''; },
    set href(next) { attributes.set('href', String(next)); },
    get type() { return attributes.get('type') || ''; },
    set type(next) { attributes.set('type', String(next)); },
    get max() { return Number(attributes.get('max') || 0); },
    set max(next) { attributes.set('max', String(next)); },
    getContext() { return {}; },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) { attributes.set(String(name), value === undefined || value === null ? '' : String(value)); },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    append(...nodes) {
      for (const node of nodes) {
        const kids = node && node.nodeType === 11 ? node.children.slice() : [node];
        for (const kid of kids) {
          if (kid.parentNode) kid.parentNode.removeChild(kid);
          kid.parentNode = element;
          children.push(kid);
        }
      }
    },
    prepend(node) {
      const kid = node && node.nodeType === 11 ? node.children[0] : node;
      if (!kid) return;
      if (kid.parentNode) kid.parentNode.removeChild(kid);
      kid.parentNode = element;
      children.unshift(kid);
    },
    replaceChildren(...nodes) {
      children.length = 0;
      element.append(...nodes);
    },
    removeChild(node) {
      const index = children.indexOf(node);
      if (index >= 0) children.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === element) return true;
        current = current.parentNode;
      }
      return false;
    },
    remove() { if (element.parentNode) element.parentNode.removeChild(element); },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const found = [];
      const walk = node => {
        for (const child of node.children || []) {
          if (child.nodeType !== 1) continue;
          if (matchesSelector(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
    dispatchEvent(event) {
      const handler = element['on' + String(event && event.type || '')];
      if (typeof handler === 'function') handler(event);
      return true;
    },
  };
  return element;
}

function parseHtml(html, doc) {
  const root = createElement(doc, '#root');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let last = 0;
  let match;
  const pushText = raw => {
    if (!raw) return;
    stack[stack.length - 1].children.push({ nodeType: 3, textContent: raw, parentNode: stack[stack.length - 1] });
  };
  while ((match = re.exec(html))) {
    pushText(html.slice(last, match.index));
    last = re.lastIndex;
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const tag = match[2].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName.toLowerCase() === tag) { stack.length = index; break; }
      }
      continue;
    }
    const tag = match[2].toLowerCase();
    const element = createElement(doc, tag);
    for (const [name, value] of parseAttributes(match[3])) element.setAttribute(name, value);
    stack[stack.length - 1].children.push(element);
    element.parentNode = stack[stack.length - 1];
    if (!VOID_TAGS.has(tag) && !match[4]) stack.push(element);
  }
  pushText(html.slice(last));
  return root;
}

function createDocument() {
  const doc = {
    readyState: 'complete',
    defaultView: { devicePixelRatio: 1 },
    createElement: tag => createElement(doc, tag),
    createDocumentFragment: () => {
      const fragment = createElement(doc, '#fragment');
      fragment.nodeType = 11;
      return fragment;
    },
  };
  return doc;
}

function createSurface(doc) {
  const surface = createElement(doc, 'div');
  surface.ownerDocument = doc;
  return surface;
}

/* ———————————————————— 假 PDF.js（同源阅读器，不另造解析器）———————————————————— */

function fakeLibrary(pages = 3) {
  const requested = [];
  const doc = {
    numPages: pages,
    getPage: async number => {
      requested.push(number);
      return {
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
        getTextContent: async () => ({ items: [{ str: '凭据正文 第' + number + '页 关键字', transform: [1, 0, 0, 1, 10, 20] }] }),
      };
    },
  };
  return {
    requested,
    library: {
      GlobalWorkerOptions: {},
      getDocument: () => ({ onPassword: null, promise: Promise.resolve(doc), destroy: async () => {} }),
    },
  };
}

const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

async function mount(options = {}) {
  const doc = createDocument();
  const surface = createSurface(doc);
  const fake = fakeLibrary(options.pages ?? 3);
  const release = mountPdf(surface, {
    url: options.url || '/files/sample.pdf',
    name: '凭据.pdf',
    current: () => true,
    loadLibrary: async () => (options.library ?? fake.library),
  });
  await settle();
  return { doc, surface, fake, release };
}

/* ———————————————————— 工具条宽度估算（没有布局引擎 ⇒ 按控件宽之和估行数）———————————————————— */

const textWidth = (text, size) => [...String(text)].reduce(
  (sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56),
  0
);

/** 工具条里每个控件的宽度（CSS 生效值 ＋ 文本宽度估算）。 */
function toolbarItemWidths() {
  const fontSize = 12;
  const buttonWidth = textWidth('上一页', fontSize) + 20 + 2;
  const pageWidth = px(effective(['.file-pdf-toolbar .file-pdf-page input[type=number]'], 'width').value) ?? 48;
  const countWidth = textWidth('/ 12', fontSize);
  const zoomWidth = px(effective(['.file-pdf-toolbar select'], 'min-width').value) ?? 92;
  const summaryWidth = textWidth('查找文字', fontSize) + 20 + 2;
  const openWidth = textWidth('独立打开', fontSize) + 4;
  const gap = 6;
  const items = [buttonWidth, pageWidth, countWidth, buttonWidth, zoomWidth, summaryWidth, openWidth];
  const total = items.reduce((sum, width) => sum + width, 0) + gap * (items.length - 1);
  return { total, count: items.length };
}

/** 工具条在给定容器宽度下占几行（flex-wrap ⇒ 向上取整）。 */
const rowsIn = (total, container) => Math.max(1, Math.ceil(total / container));

/* ———————————————————— 判据 ———————————————————— */

test('T1 工具条常态一行（最宽也就两行）：翻页｜页码｜缩放同排，查找收进折叠入口', async () => {
  const { surface } = await mount();
  const toolbar = surface.querySelector('.file-pdf-toolbar');
  assert.ok(toolbar, '工具条不见了');
  /* 查找表单**不许**是工具条的同级行 —— 它收在折叠的 details 里。 */
  const form = surface.querySelector('.file-pdf-search');
  assert.ok(form.parentNode.classList.contains('file-pdf-searchbox'), '查找表单还在工具条外面占一整行');
  /* 独立打开不许是工具条里的第三个大按钮独占一行：它是次要入口（链接，不是表单按钮）。 */
  const open = surface.querySelector('[data-pdf-open]');
  assert.ok(open && open.tagName === 'A', '独立打开入口不见了');
  assert.equal(form.contains(open), false, '独立打开还塞在查找表单里');
  const { total } = toolbarItemWidths();
  assert.ok(rowsIn(total, 480) <= 1, `工具条在 480px 宽的栏里占了 ${rowsIn(total, 480)} 行（总宽约 ${Math.round(total)}px）`);
  assert.ok(rowsIn(total, 300) <= 2, `工具条在 300px 窄栏里占了 ${rowsIn(total, 300)} 行（总宽约 ${Math.round(total)}px）`);
});

test('T2 查找默认收起；展开后照样能触发查找（原来的 form submit 行为没坏）', async () => {
  const { surface, fake } = await mount();
  const details = surface.querySelector('.file-pdf-searchbox');
  const form = surface.querySelector('.file-pdf-search');
  const query = surface.querySelector('[data-pdf-query]');
  assert.ok(details && form && query, '查找能力丢了');
  assert.equal(details.open, false, '查找默认就是展开的（占一整行）');
  assert.equal(details.hasAttribute('open'), false, 'details 上带着 open 属性');
  assert.equal(query.disabled, false, 'PDF 打开后查找框还是禁用的');
  /* 展开 → 输入 → 提交（form 的 submit 路径） */
  details.open = true;
  query.value = '关键字';
  let prevented = false;
  form.dispatchEvent({ type: 'submit', preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true, '查找表单没有拦住默认提交');
  const results = surface.querySelector('[data-pdf-results]');
  assert.match(results.textContent, /找到 \d+ 个匹配页面/, '展开查找后没有跑出查找结果');
  const hit = results.querySelector('[data-pdf-hit]');
  assert.ok(hit, '查找结果里没有可点的页码入口');
  assert.equal(hit.getAttribute('data-pdf-hit'), '1');
  assert.ok(fake.requested.includes(1), '查找没有真的翻页去取文字');
});

test('T3 状态位有位置，但不再有「第 X / Y 页 · 只读原件」那行重复整行', async () => {
  const { surface } = await mount();
  const status = surface.querySelector('[data-pdf-status]');
  assert.ok(status, '状态位不见了（加载/错误消息没地方放）');
  assert.equal(status.textContent.trim(), '', '画完一页后状态位还挂着内容（该让位给正文）');
  assert.equal(surface.querySelector('.file-pdf-reader').textContent.includes('只读原件'), false,
    '还在重复「只读原件」那一行');
  assert.equal(surface.querySelector('.file-pdf-reader').textContent.includes('页 ·'), false,
    '还在重复「第 X / Y 页」那一行');
});

test('T4 加载与失败各有各的说法（不是空白，也不是重复整行）', async () => {
  const doc = createDocument();
  const surface = createSurface(doc);
  mountPdf(surface, { url: '/files/sample.pdf', name: '凭据.pdf', current: () => true, loadLibrary: async () => ({}) });
  /* ⚠️ **口径跟着契约走**（`frappe_apps/shangshu_core/shangshu_core/contracts/loading-state-v1.json`
   *   · 用户 2026-10-28 指示「每一个页面的加载都不要用文字了，都用骨架代码的呼吸来代替」）：
   *   加载期间**不许有看得见的加载文字** ⇒ 状态位留空，正文那一块摆一块**会呼吸的灰条**
   *   （`data-skeleton` 标记 ＋ `.platform-skeleton-bar` 灰条；骨架里一个字都没有）。 */
  assert.equal(surface.querySelector('[data-pdf-status]').textContent.trim(), '',
    '加载期间状态位还在写字（加载态不许用文字）');
  const skeleton = surface.querySelector('[data-skeleton="pdf-page"]');
  assert.ok(skeleton, '加载期间正文那一块没有骨架（只剩一片空白）');
  assert.ok(skeleton.querySelector('.platform-skeleton-bar'), '骨架里没有灰条 ⇒ 人看见的是一片空白');
  assert.equal(skeleton.textContent.trim(), '', '骨架里有字 ⇒ 那是假内容');
  await settle();
  /* 加载失败 ⇒ **说人话**（不是空白，也不停在骨架上装样子）。 */
  assert.match(surface.querySelector('[data-pdf-status]').textContent, /无法打开PDF/,
    '阅读器加载失败时状态位没有说清楚');
  assert.equal(surface.querySelector('[data-skeleton="pdf-page"]'), null,
    '加载失败了却还留着骨架 ⇒ 停在骨架上装样子');
  /* 打不开的 PDF 也要有话说，而不是空白。 */
  const second = await mount({ library: { GlobalWorkerOptions: {}, getDocument: () => ({ onPassword: null, promise: Promise.reject(new Error('boom')), destroy: async () => {} }) } });
  assert.match(second.surface.querySelector('[data-pdf-status]').textContent, /无法打开PDF/);
  assert.equal(second.surface.querySelector('[data-skeleton="pdf-page"]'), null,
    'PDF 打不开却还留着骨架 ⇒ 停在骨架上装样子');
});

test('T5 控件是紧凑的：约 32px 高、页码框不是 64px 大框（算出来的生效值）', () => {
  /* 页码框：宽度算出来必须是小框（≤56px），且不再是 64px。 */
  const pageWidth = effective(['.file-pdf-toolbar .file-pdf-page input[type=number]', '.file-pdf-toolbar input'], 'width');
  assert.equal(px(pageWidth.value), 48, `页码输入框宽 ${pageWidth.value} —— 不是紧凑小框`);
  assert.notEqual(px(pageWidth.value), 64, '页码输入框还是 64px 的大框');
  /* 控件高度 ≈32px（通用选择器上算，不带 !important）。 */
  assert.equal(px(effective(['.file-pdf-toolbar input'], 'height').value), 32, '工具条输入框不是 32px 高');
  assert.equal(px(effective(['.file-pdf-toolbar select'], 'height').value), 32, '缩放下拉不是 32px 高');
  assert.equal(px(effective(['.file-pdf-toolbar .btn'], 'height').value), 32, '工具条按钮不是 32px 高');
  assert.equal(px(effective(['.file-pdf-search input'], 'height').value), 32, '查找框不是 32px 高');
});

test('T6 审核中心右栏继承同一套紧凑样式，且那边的 30px 覆盖照旧赢（两边不打架）', () => {
  /* ⚠ 这里不能只看「算出来的生效值」：公用件的**粗略特异性**把 [属性] 算得比 .类 重，
     于是 deepseek 的 `.main input[type="number"]` 会盖过审核中心那条 —— 但浏览器里
     两者特异性**相同**（各 2 个类级），**后加载的文件赢**（review-center.css 最后加载）⇒ 30px。
     所以分两件事断：① 通用控件在别处仍是 32px；② 审核中心那条 30px 覆盖原样在，
     且我这边的规则**不带 !important**、特异性也不高于它 ⇒ 那边赢。 */
  assert.equal(px(effective(['.file-pdf-toolbar input'], 'height').value), 32, '工具条控件不是 32px 高');
  const theirRule = resolver.resolveIn(path.join(ROOT, 'shangshu-web/css/review-center.css'),
    '.review-original-pdfreader .file-pdf-toolbar input', 'height', 1440);
  assert.equal(px(theirRule.value), 30, '审核中心那条 30px 覆盖不见了');
  /* 我这边的 PDF 规则不许带 !important（不然就是两条 !important 互相打架）。 */
  const css = fs.readFileSync(path.join(ROOT, 'shangshu-web/css/file-center.css'), 'utf8');
  const pdfBlock = css.split('\n').filter(line => /file-pdf|\[data-pdf/.test(line)).join('\n');
  assert.equal(/!important/.test(pdfBlock), false, 'file-center.css 的 PDF 规则里带了 !important（会和审核中心的覆盖打架）');
  /* 特异性：我这条不高 theirs ⇒ 命中同一个元素时那边赢。 */
  assert.ok(specificity('.review-original-pdfreader .file-pdf-toolbar input') > specificity('.file-pdf-toolbar input'),
    '我的通用规则比审核中心的覆盖更具体（那边就不赢了）');
  /* 页码小框在审核中心里同样是 48px（那边没管宽度）。 */
  assert.equal(px(effective(['.file-pdf-toolbar .file-pdf-page input[type=number]'], 'width').value), 48);
});

test('T7 正文吃满剩余高度：工具条不再把原件挤成一小块', () => {
  const reader = effective(['.file-pdf-reader'], 'display');
  assert.equal(reader.value, 'flex', '阅读器外壳不是弹性列（正文吃不到剩余高度）');
  assert.equal(effective(['.file-pdf-reader'], 'flex-direction').value, 'column');
  const viewport = effective(['.file-pdf-viewport'], 'flex');
  assert.match(viewport.value, /^1 1 auto$/, `阅读区没有 flex:1（现在是 ${viewport.value}）`);
  assert.equal(effective(['.file-pdf-viewport'], 'height'), null, '阅读区还写死了高度（min(64vh,760px) 那一套）');
});

test('T8 阅读能力一个都不少：翻页、页码、缩放、查找、结果、独立打开（「本页文字」已按要求去掉）', async () => {
  const { surface, fake } = await mount();
  for (const selector of ['[data-pdf-prev]', '[data-pdf-next]', '[data-pdf-page]', '[data-pdf-zoom]',
    '[data-pdf-query]', '[data-pdf-results]', '[data-pdf-count]', '[data-pdf-status]', '.file-pdf-search',
    /* ⚠️ 「本页文字」（.file-pdf-text）2026-10-28 按用户要求从界面上去掉了 ⇒ 不再列在这儿。 */
    '.file-pdf-viewport', '[data-pdf-open]']) {
    assert.ok(surface.querySelector(selector), `阅读器少了 ${selector}`);
  }
  /* ⚠️ **契约变化（2026-10-28 09:38 · 用户原话：「第四去掉本页文字」）**：
     「本页文字」这一块**从界面上去掉**了 ⇒ 判据跟着改口径：
     **页面上不许再有这一块**（其余阅读能力一个都不少：翻页／页码／缩放／查找／结果／独立打开）。 */
  assert.equal(surface.querySelector('.file-pdf-text'), null, '「本页文字」这一块还在（用户要求去掉）');
  assert.equal(surface.querySelector('[data-pdf-open]').getAttribute('href'), '/files/sample.pdf',
    '独立打开没有指向原件');
  /* 翻页还翻得动。 */
  const page = surface.querySelector('[data-pdf-page]');
  assert.equal(page.value, '1');
  surface.querySelector('[data-pdf-next]').onclick();
  await settle();
  assert.equal(page.value, '2', '下一页翻不动');
  assert.ok(fake.requested.includes(2), '翻页没有真的去取第 2 页');
  /* 缩放还改得动（重新绘制，外框不变）。 */
  const zoom = surface.querySelector('[data-pdf-zoom]');
  const before = fake.requested.length;
  zoom.value = '150';
  zoom.onchange();
  await settle();
  assert.ok(fake.requested.length > before, '缩放没有触发重新绘制');
  /* 页码框仍能直接跳页。 */
  page.value = '3';
  page.onchange();
  await settle();
  assert.equal(page.value, '3', '页码框跳不动');
  assert.equal(surface.querySelector('[data-pdf-count]').textContent, '/ 3', '总页数没显示在工具条上');
});
