import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../workbench.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const workspace = { job: { name: 'J', title: '岗位', status: 'open', revision: 1, current_rubric_revision: 'S' }, collections: { applications: [{ name: 'A', candidate: 'C', primary_resume: 'R', outcome: 'active' }] } };
const context = { context_hash: 'hash', notice: '请核对来源', snapshot: { resume: 'R', rubric: 'S', file_reference: 'F', criteria: [{ id: 'c1', criterion: '交付', required: true }], rule_versions: [] } };
function setup(options = {}) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost', runScripts: 'outside-only' });
  const w = dom.window, calls = [], forms = [];
  w.structuredClone = structuredClone; w.RENDER = {};
  w.shangshuRegisterPages = () => {}; w.shangshuRegisterNav = () => {};
  w.openSchemaForm = form => { forms.push(form); return {}; };
  w.fetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (options.fetch) { const r = await options.fetch(path, init); if (r) return r; }
    if (path.includes('/objects/')) return response({ rows: options.empty ? [] : [{ name: 'J', title: '岗位', status: 'open' }], total: options.empty ? 0 : 1 });
    if (path === '/api/platform/actions') return response({ list: options.noActions ? [] : [
      { id: 'recruitment.review.create', title: '保存证据包', executable: true },
      { id: 'recruitment.task.save', title: '分派任务', executable: true, input_schema: { properties: { job: { type: 'string' }, title: { type: 'string' } }, required: ['job', 'title'] } },
    ] });
    if (path.includes('recruitment.workspace')) return response(workspace);
    if (path.includes('recruitment.evidence.context')) return response(context);
    if (path.includes('/execute')) return response({ result: { record: 'REVIEW-1' } });
    throw Error('Unexpected URL: ' + path);
  };
  w.eval(source);
  async function mount() {
    const h = w.document.createElement('div'), controller = new AbortController();
    w.document.querySelector('main').replaceChildren(h);
    await w.RENDER.recruitment({ host: h, signal: controller.signal });
    return { h, controller };
  }
  return { w, calls, forms, mount, close: () => w.close() };
}
test('formal empty state has no demo candidates or legacy recruitment requests', async () => {
  const t = setup({ empty: true });
  try {
    const { h } = await t.mount();
    assert.match(h.textContent, /正式数据为空/);
    assert.ok(t.calls.every(c => !c.path.startsWith('/api/recruitment')));
  } finally { t.close(); }
});
test('read-only role sees evidence records without write controls', async () => {
  const t = setup({ noActions: true });
  try {
    const { h } = await t.mount(); h.querySelector('[data-rec-tab="evidence"]').click();
    assert.match(h.textContent, /候选人/);
    assert.equal(h.querySelector('[data-rec-op="prepare"]'), null);
    assert.equal(h.querySelector('[data-rec-action]'), null);
  } finally { t.close(); }
});
test('confirmed task retries use identical action key and never cancel a submitted write', async () => {
  let attempts = 0;
  const t = setup({ fetch: (path) => { if (path.endsWith('/execute') && ++attempts === 1) throw Error('lost receipt'); } });
  try {
    const { h } = await t.mount(); h.querySelector('[data-rec-action="recruitment.task.save"]').click();
    const form = t.forms[0], payload = { job: 'J', title: '核对材料' };
    await assert.rejects(form.onSubmit(payload), /lost receipt/);
    await form.onSubmit(payload);
    const writes = t.calls.filter(c => c.path.endsWith('/execute'));
    assert.equal(JSON.parse(writes[0].init.body).idempotency_key, JSON.parse(writes[1].init.body).idempotency_key);
    assert.equal(writes[0].init.signal, undefined);
  } finally { t.close(); }
});
test('editing source while AI is in flight cannot overwrite the human evidence form', async () => {
  let resolve;
  const t = setup({ fetch: path => path.endsWith('evidence-assist') ? new Promise(r => { resolve = r; }) : undefined });
  try {
    const { h } = await t.mount(); h.querySelector('[data-rec-tab="evidence"]').click(); h.querySelector('[data-rec-op="prepare"]').click(); await tick();
    const d = t.w.document.querySelector('dialog'), src = d.querySelector('[name="source_text"]');
    src.value = '旧材料'; d.querySelector('[data-rec-op="assist"]').click(); await tick();
    src.value = '新材料'; src.dispatchEvent(new t.w.Event('input'));
    resolve(response({ context_hash: 'hash', model_version: 'M', matrix: [{ criterion_id: 'c1', status: 'supported', citations: [{ quote: '旧材料' }], question: '旧追问' }] }));
    await tick();
    assert.equal(d.querySelector('[name="quote"]').value, '');
    assert.equal(d.querySelector('[name="verified"]').checked, false);
  } finally { t.close(); }
});
test('evidence save binds matrix, original source, scope hash and explicit rule versions', async () => {
  const t = setup();
  try {
    const { h } = await t.mount(); h.querySelector('[data-rec-tab="evidence"]').click(); h.querySelector('[data-rec-op="prepare"]').click(); await tick();
    const d = t.w.document.querySelector('dialog'), form = d.querySelector('form');
    form.elements.source_text.value = '😀完成交付'; form.elements.verified.checked = true;
    d.querySelector('[name="status"]').value = 'supported'; d.querySelector('[name="quote"]').value = '完成交付';
    form.dispatchEvent(new t.w.Event('submit', { cancelable: true, bubbles: true })); await tick();
    const write = t.calls.find(c => c.path.endsWith('/recruitment.review.create/execute'));
    assert.ok(write); const payload = JSON.parse(write.init.body).payload;
    assert.equal(payload.context_hash, 'hash'); assert.equal(payload.source_text, '😀完成交付');
    assert.deepEqual(JSON.parse(payload.matrix)[0].citations, [{ start: 1, end: 5, quote: '完成交付' }]);
    assert.equal(payload.rule_versions, '[]'); assert.equal(payload.model_version, 'human');
  } finally { t.close(); }
});
test('late reads after leaving the page cannot render another page or keep evidence dialogs open', async () => {
  const t = setup();
  try {
    const { h, controller } = await t.mount(); h.querySelector('[data-rec-tab="evidence"]').click(); h.querySelector('[data-rec-op="prepare"]').click(); await tick();
    assert.ok(t.w.document.querySelector('dialog'));
    controller.abort();
    assert.equal(t.w.document.querySelector('dialog'), null);
    const next = t.w.document.createElement('div'); next.textContent = '另一页面'; h.replaceWith(next); await tick();
    assert.equal(next.textContent, '另一页面');
  } finally { t.close(); }
});
