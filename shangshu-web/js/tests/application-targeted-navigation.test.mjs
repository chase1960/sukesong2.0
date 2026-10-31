import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const applicationSource = fs.readFileSync(new URL('../real-applications.js', import.meta.url), 'utf8');
const objectSource = fs.readFileSync(new URL('../real-objects.js', import.meta.url), 'utf8');
const APP = 'com.shangshu.finance.expense_management';
const DETAIL = '/api/platform/applications/' + APP;
const ok = body => ({ ok: true, json: async () => ({ ok: true, ...body }) });

function mount(read, { open = APP, changeUser = false } = {}) {
  const dom = new JSDOM('<main id="main"></main>', {
    url: 'http://localhost:3850/index.html#/applications', runScripts: 'outside-only',
  });
  const w = dom.window;
  const calls = [];
  const transitions = [];
  w.RENDER = {};
  w.currentUserInfo = { role: 'staff', username: 'employee@example.invalid' };
  w.ICONS = new Proxy({}, { get: () => '' });
  w.esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  w.$ = (selector, root = w.document) => root.querySelector(selector);
  w.$$ = (selector, root = w.document) => [...root.querySelectorAll(selector)];
  w.mainBox = () => w.document.querySelector('#main');
  w.api = async (path, options) => {
    calls.push(String(path));
    return read(String(path), options);
  };
  w.shangshuOpenTable = id => { transitions.push(id); return { ok: true }; };
  w.go = route => {
    if (route !== 'objects') return;
    w.location.hash = '#/objects';
    if (changeUser) w.currentUserInfo = { ...w.currentUserInfo, username: 'another@example.invalid' };
    const render = w.RENDER.objects({ isActive: () => true });
    transitions.push(render);
    return render;
  };
  if (open) w.sessionStorage.setItem('shangshu.application.open', open);
  w.eval(applicationSource);
  w.eval(objectSource);
  return { w, calls, transitions, close: () => dom.window.close() };
}

test('已知应用ID直接读详情，目录失败不能阻断财务域打开', async () => {
  const h = mount(path => {
    if (path === DETAIL) return ok({ application: { id: APP, title: '费用管理', datasets: [], processes: [] } });
    throw new Error('全目录暂时不可用');
  });
  try {
    await h.w.RENDER.applications({ isActive: () => true });
    assert.deepEqual(h.calls, [DETAIL]);
    assert.equal(h.w.document.querySelector('h1')?.textContent, '费用管理');
  } finally { h.close(); }
});

test('目标应用失败保留详情错误，不回退扫描全部应用', async () => {
  const h = mount(path => {
    if (path === DETAIL) return { ok: false, json: async () => ({ ok: false, error: '该应用已停用' }) };
    return ok({ list: [] });
  });
  try {
    await h.w.RENDER.applications({ isActive: () => true });
    assert.deepEqual(h.calls, [DETAIL]);
    assert.match(h.w.mainBox().textContent, /该应用已停用/);
    assert.ok(h.w.document.querySelector('[data-retry-detail]'));
  } finally { h.close(); }
});

test('没有目标ID时仍通过清单展示应用总览', async () => {
  const h = mount(() => ok({ list: [{ id: APP, title: '费用管理', enabled: true }] }), { open: null });
  try {
    await h.w.RENDER.applications({ isActive: () => true });
    assert.deepEqual(h.calls, ['/api/platform/applications?summary=1']);
    assert.equal(h.w.document.querySelector('h1')?.textContent, '全部应用');
    assert.ok(h.w.document.querySelector('[data-application]'));
  } finally { h.close(); }
});

for (const changeUser of [false, true]) {
  test(changeUser ? '切换身份后不消费前一人的应用详情' : '应用转入数据页仅交接一次详情，后续打开重新取授权详情', async () => {
    const dataset = { id: 'finance.expense_claim', object_id: 'finance.expense_claim', name: '费用报销' };
    const h = mount(path => {
      if (path === DETAIL) return ok({ application: { id: APP, title: '费用管理', datasets: [dataset], processes: [] } });
      if (path.startsWith('/api/platform/datasets/finance.expense_claim/records?')) {
        return ok({ object: { source: 'managed' }, rows: [], total: 0 });
      }
      throw new Error('不应扫描目录或其它对象：' + path);
    }, { changeUser });
    try {
      await h.w.RENDER.applications({ isActive: () => true });
      await Promise.all(h.transitions.filter(value => value?.then));
      assert.equal(h.calls.filter(path => path === DETAIL).length, changeUser ? 2 : 1);
      assert.ok(h.transitions.includes('finance.expense_claim'));
      assert.equal(h.calls.filter(path=>path.includes('/records')).length,0,'已知对象源页不应预读目标数据');
      if (!changeUser) {
        await h.w.RENDER.objects({ isActive: () => true });
        assert.equal(h.calls.filter(path => path === DETAIL).length, 2, '一次性交接不得变为长期详情缓存');
      }
    } finally { h.close(); }
  });
}
