import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../../shangshu-web/index.html', import.meta.url), 'utf8');
function mount() {
  const source = html.match(/<script id="boot-readiness">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, '启动检查必须在外部 CSS 前内联，不能依赖另一个下载才能报错');
  const dom = new JSDOM(html, { url: 'http://localhost/index.html', runScripts: 'outside-only' });
  const document = dom.window.document;
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  let reloads = 0;
  const timers = new Map<number, () => void>();
  let serial = 0;
  runInNewContext(source, {
    document,
    window: { location: { reload: () => { reloads++; } } },
    setTimeout: (fn: () => void) => { timers.set(++serial, fn); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  function loaded(link: Element, rules: unknown[] = [{}]) {
    Object.defineProperty(link, 'sheet', { configurable: true, value: { cssRules: rules } });
    link.dispatchEvent(new dom.window.Event('load'));
  }
  return {
    document, links, loaded,
    ready: () => document.dispatchEvent(new dom.window.Event('DOMContentLoaded')),
    fail: (link: Element) => link.dispatchEvent(new dom.window.Event('error')),
    expire: () => { for (const fn of [...timers.values()]) fn(); timers.clear(); },
    reloads: () => reloads,
    close: () => dom.window.close(),
  };
}

it('首屏不强制下载两套大字体，启动反馈不依赖外部脚本或内嵌大图片', () => {
  assert.doesNotMatch(html, /<link[^>]+rel="preload"[^>]+as="font"/);
  assert.doesNotMatch(html, /data:image\/png;base64/);
  assert.ok(html.indexOf('<script id="boot-readiness">') < html.indexOf('<link rel="stylesheet"'));
});

it('DOMContentLoaded 或超时都不能撤下尚未就绪的样式遮罩，超时提供可操作重试', () => {
  const t = mount();
  try {
    t.ready();
    assert.ok(t.document.querySelector('#boot-veil'));
    t.expire();
    assert.ok(t.document.querySelector('#boot-veil'));
    assert.match(t.document.querySelector('#boot-message')!.textContent!, /样式.*加载/);
    const retry = t.document.querySelector<HTMLButtonElement>('#boot-retry')!;
    assert.equal(retry.hidden, false);
    retry.click();
    assert.equal(t.reloads(), 1);
  } finally { t.close(); }
});

it('所有关键样式实际解析且 DOM 就绪后才撤遮罩，不等待字体或图片下载', () => {
  const t = mount();
  try {
    for (const link of t.links) t.loaded(link);
    assert.ok(t.document.querySelector('#boot-veil'));
    t.ready();
    assert.equal(t.document.querySelector('#boot-veil'), null);
    t.expire();
    assert.equal(t.document.querySelector('#boot-veil'), null);
  } finally { t.close(); }
});

it('CSS 下载失败显式提示，不因其他样式成功或 DOM 就绪而露出裸页面', () => {
  const t = mount();
  try {
    for (const link of t.links.slice(1)) t.loaded(link);
    t.fail(t.links[0]);
    t.ready();
    assert.ok(t.document.querySelector('#boot-veil'));
    assert.match(t.document.querySelector('#boot-message')!.textContent!, /样式加载失败/);
    assert.equal(t.document.querySelector<HTMLButtonElement>('#boot-retry')!.hidden, false);
  } finally { t.close(); }
});

it('空样式或错误类型响应不能仅凭 load 事件视为成功，迟到的正常样式可恢复', () => {
  const t = mount();
  try {
    for (const link of t.links.slice(1)) t.loaded(link);
    t.loaded(t.links[0], []);
    t.ready();
    t.expire();
    assert.ok(t.document.querySelector('#boot-veil'));
    assert.equal(t.document.querySelector<HTMLButtonElement>('#boot-retry')!.hidden, false);
    t.loaded(t.links[0]);
    assert.equal(t.document.querySelector('#boot-veil'), null);
  } finally { t.close(); }
});

it('样式已加载但后续页面资源阻塞时也有中文超时反馈，非样式错误不误报', () => {
  const t = mount();
  try {
    for (const link of t.links) t.loaded(link);
    t.expire();
    assert.match(t.document.querySelector('#boot-message')!.textContent!, /页面资源加载较慢/);
    assert.equal(t.document.querySelector<HTMLButtonElement>('#boot-retry')!.hidden, false);
  } finally { t.close(); }
});
