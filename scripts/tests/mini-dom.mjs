/* 最小 DOM 桩（PKG-022-T01 判据用）。
 *
 * **为什么自己写**：这个仓库当前**没有装 jsdom**（`node_modules` 缺失，`npm i` 需要外网），
 * 而这两条判据要真的在 DOM 上跑：页面上有没有蓝色审核 → 右上角有没有「全部确认」。
 * 这里只实现判据用到的能力：标签/类名/属性选择器（含逗号并列）、祖先查找、子树遍历、增删插。
 * —— **不做布局、不做事件冒泡、不做样式计算**；判据只断言「结构」和「调用了哪个口」。
 *
 * 用法：
 *   const dom = createDom();
 *   dom.body.appendChild(h('div', {class:'main-scroll', 'data-page':'mail'}, [...]));
 *   const { window } = loadShell(dom, {...});   // 见 review-batch.test.mjs
 */
'use strict';

const DATASET_KEYS = {
  'data-review-source': 'reviewSource',
  'data-confirm-id': 'confirmId',
  'data-proposal-id': 'proposalId',
  'data-review-capability': 'reviewCapability',
  'data-page': 'page',
  'data-proposal': 'proposal',
  'data-mail-review-queue': 'mailReviewQueue',
  'data-mail-review-card': 'mailReviewCard',
  'data-review-batch-bar': 'reviewBatchBar',
  'data-review-batch-confirm': 'reviewBatchConfirm',
  'data-review-batch-note': 'reviewBatchNote',
};

function parsePart(part) {
  const text = String(part).trim();
  if (text.startsWith('#')) return { kind: 'id', name: text.slice(1) };
  if (text.startsWith('.')) return { kind: 'class', name: text.slice(1) };
  if (text.startsWith('[')) {
    const body = text.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return { kind: 'attr', name: body };
    const name = body.slice(0, eq);
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { kind: 'attrValue', name, value };
  }
  if (/^[a-z][a-z0-9-]*$/i.test(text)) return { kind: 'tag', name: text.toLowerCase() };
  throw Error('桩不支持的选择器：' + text);
}

function parseSelector(selector) {
  return String(selector).split(',').map(part => part.trim()).filter(Boolean).map(parsePart);
}

function createElement(doc, tagName) {
  const attributes = new Map();
  const children = [];
  const listeners = new Map();
  const dataset = {};
  for (const [attr, key] of Object.entries(DATASET_KEYS)) {
    Object.defineProperty(dataset, key, {
      get: () => attributes.get(attr),
      enumerable: true,
      configurable: true,
    });
  }
  let text = '';
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    attributes,
    dataset,
    childNodes: children,
    children,
    parentNode: null,
    className: '',
    style: {},
    get textContent() {
      if (text) return text;
      return children.map(child => child.textContent || '').join('');
    },
    set textContent(value) { text = value === undefined || value === null ? '' : String(value); },
    get classList() {
      return {
        contains: name => String(element.className || '').split(/\s+/).filter(Boolean).includes(name),
      };
    },
    get firstChild() { return children[0] || null; },
    get lastChild() { return children[children.length - 1] || null; },
    /* —— **几何（桩布局；默认全是 0 ＝ 没有布局）** —— */
    get offsetTop() { return geometryOf(element).top; },
    get offsetLeft() { return geometryOf(element).left; },
    get offsetWidth() { return geometryOf(element).width; },
    get offsetHeight() { return geometryOf(element).height; },
    get clientWidth() { return geometryOf(element).width; },
    get clientHeight() { return geometryOf(element).height; },
    getBoundingClientRect() {
      const box = geometryOf(element);
      return {
        top: box.top, left: box.left, width: box.width, height: box.height,
        right: box.left + box.width, bottom: box.top + box.height,
        x: box.left, y: box.top,
      };
    },
    get previousSibling() {
      if (!element.parentNode) return null;
      const index = element.parentNode.children.indexOf(element);
      return index > 0 ? element.parentNode.children[index - 1] : null;
    },
    get nextSibling() {
      if (!element.parentNode) return null;
      const index = element.parentNode.children.indexOf(element);
      const siblings = element.parentNode.children;
      return index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;
    },
    setAttribute(name, value) { attributes.set(String(name), value === undefined || value === null ? '' : String(value)); },
    getAttribute(name) { return attributes.has(String(name)) ? attributes.get(String(name)) : null; },
    hasAttribute(name) { return attributes.has(String(name)); },
    removeAttribute(name) { attributes.delete(String(name)); },
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      children.push(node);
      node.parentNode = element;
      return node;
    },
    insertBefore(node, reference) {
      if (node.parentNode) node.parentNode.removeChild(node);
      if (!reference) { children.push(node); node.parentNode = element; return node; }
      const index = children.indexOf(reference);
      if (index < 0) { children.push(node); node.parentNode = element; return node; }
      children.splice(index, 0, node);
      node.parentNode = element;
      return node;
    },
    removeChild(node) {
      const index = children.indexOf(node);
      if (index >= 0) children.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    remove() { if (element.parentNode) element.parentNode.removeChild(element); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event && event.type) || [];
      handlers.slice().forEach(handler => handler(event));
      return true;
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const parts = parseSelector(selector);
      const found = [];
      const walk = node => {
        (node.children || []).forEach(child => {
          if (typeof child.getAttribute !== 'function') { walk(child); return; }
          if (parts.some(part => matches(child, part))) found.push(child);
          walk(child);
        });
      };
      walk(element);
      return found;
    },
    closest(selector) {
      const parts = parseSelector(selector);
      let node = element;
      while (node) {
        if (parts.some(part => matches(node, part))) return node;
        node = node.parentNode;
      }
      return null;
    },
  };
  /* —— **几何桩要拿到它属于哪个文档**（`doc.__layout`）⇒ 挂上（**不列进属性枚举**）。 —— */
  Object.defineProperty(element, '__doc', { value: doc, enumerable: false, configurable: true });
  if (typeof tagName === 'string' && tagName.toLowerCase() === 'html') {
    element.tagName = 'HTML';
  }
  return element;
}

function matches(element, part) {
  if (part.kind === 'id') return element.getAttribute('id') === part.name;
  if (part.kind === 'class') return element.classList.contains(part.name);
  if (part.kind === 'tag') return String(element.tagName || '').toLowerCase() === part.name;
  if (part.kind === 'attr') return element.hasAttribute(part.name);
  return element.getAttribute(part.name) === part.value;
}

/**
 * **几何（桩布局）**：默认**全是 0**（＝「这一格没有布局」）。
 *
 * ⚠️ **为什么默认是 0 而不是真算**：这个桩**不做布局**（见文件头）⇒
 *   「量一屏放得下几张」那类判据**量不出来**（壳就退回默认条数）。
 *   要验「按屏算」那条，判据自己装一个布局：
 *   `dom.__layout = (element) => ({top, left, width, height})`（返回 null ＝ 这个元素没有盒子）。
 */
function geometryOf(element) {
  const doc = element.__doc;
  const layout = doc && typeof doc.__layout === 'function' ? doc.__layout : null;
  if (!layout) return { top: 0, left: 0, width: 0, height: 0 };
  const box = layout(element) || {};
  return {
    top: Number(box.top) || 0,
    left: Number(box.left) || 0,
    width: Number(box.width) || 0,
    height: Number(box.height) || 0,
  };
}

/** 建一个元素：`h('div', {class:'x', 'data-page':'mail'}, [子元素…])` */
function h(doc, tag, attrs, children) {
  const element = createElement(doc, tag);
  Object.entries(attrs || {}).forEach(([name, value]) => {
    if (name === 'class') element.className = String(value);
    else if (name === 'text') element.textContent = String(value);
    else element.setAttribute(name, value);
  });
  (children || []).forEach(child => element.appendChild(child));
  return element;
}

function createDom() {
  const doc = {
    readyState: 'complete',
    listeners: new Map(),
  };
  const html = createElement(doc, 'html');
  const body = createElement(doc, 'body');
  html.appendChild(body);
  doc.body = body;
  doc.documentElement = html;
  doc.createElement = tag => createElement(doc, tag);
  doc.createTextNode = value => ({ nodeType: 3, textContent: String(value), parentNode: null });
  doc.querySelector = selector => html.querySelector(selector);
  doc.querySelectorAll = selector => html.querySelectorAll(selector);
  doc.addEventListener = (type, handler) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(handler);
  };
  doc.dispatchEvent = event => {
    const handlers = doc.listeners.get(event && event.type) || [];
    handlers.slice().forEach(handler => handler(event));
    return true;
  };
  doc.h = (tag, attrs, children) => h(doc, tag, attrs, children);
  return doc;
}

export { createDom, createElement, h };
