import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, pageHost, settle, fileCenterVersions } from './helpers/review-center-shell.mjs';

const fire = (node, type, extra = {}) => node.dispatchEvent({ type, ...extra });

async function open(overrides = {}) {
  const dom = createDom();
  const shell = loadShell(dom, { readFileCenterVersions: fileCenterVersions, ...overrides.shell });
  let listCalls = 0;
  registerSampleDeclaration(shell.window, {
    list: async () => { listCalls++; return [sampleCard({
      evidence: [{ id: 'ev-1', name: '原件.pdf', type: 'pdf', required: true,
        available: true, reference: 'FILE-1', locator: { page: 1 } }],
      ...overrides.card,
    })]; },
    ...overrides.declaration,
  });
  if (overrides.beforeMount) overrides.beforeMount(shell.window);
  await shell.window.shangshuReviewCenter.mountPage(pageHost(dom), {});
  await settle();
  fire(dom.body.querySelector('[data-review-card-open]'), 'click');
  await settle();
  return { dom, ...shell, listCalls: () => listCalls };
}

function snapshot(dom) {
  const q = selector => dom.body.querySelector(selector);
  return { card: q('[data-review-card]'), left: q('[data-review-slot="left"]'),
    right: q('[data-review-slot="right"]'), frame: q('[data-review-original-frame]'),
    other: dom.body.querySelectorAll('[data-review-candidate]')[1] };
}

function sameWorkArea(dom, before) {
  const after = snapshot(dom);
  for (const key of ['card', 'left', 'right', 'frame', 'other']) {
    assert.ok(after[key] === before[key], `${key} should retain its existing DOM node`);
  }
}

test('adopting one candidate preserves its click target, other fields, card list and PDF without new reads', async () => {
  const { dom, calls, listCalls } = await open();
  const before = snapshot(dom), requests = calls.length, lists = listCalls();
  const candidate = dom.body.querySelector('[data-review-candidate]');
  fire(candidate, 'click', { detail: 1 });
  await settle();
  assert.ok(dom.body.querySelector('[data-review-candidate]') === candidate);
  assert.equal(candidate.getAttribute('data-proposal-state'), 'adopted');
  assert.match(dom.body.querySelector('[data-review-progress]').textContent, /1\/3/);
  sameWorkArea(dom, before);
  assert.equal(calls.length, requests);
  assert.equal(listCalls(), lists);
});

test('double click edits the retained candidate; change then blur commits once without rebuilding the preview', async () => {
  const { dom, window } = await open();
  const before = snapshot(dom), candidate = dom.body.querySelector('[data-review-candidate]');
  fire(candidate, 'click', { detail: 1 });
  fire(candidate, 'click', { detail: 2 });
  fire(candidate, 'dblclick', { detail: 2 });
  const editor = dom.body.querySelector('[data-review-edit]');
  assert.ok(editor);
  assert.match(dom.body.querySelector('[data-review-row-state]').textContent, /改写中.*待保存/);
  editor.value = '已核实的新值\n第二行';
  fire(editor, 'change');
  const committed = dom.body.querySelector('[data-review-candidate]');
  fire(editor, 'blur');
  assert.ok(dom.body.querySelector('[data-review-candidate]') === committed);
  assert.equal(committed.textContent, '已核实的新值\n第二行');
  assert.equal(committed.getAttribute('data-proposal-state'), 'edited');
  assert.equal(window.shangshuReviewCenter.state.edits.get('c1'), '已核实的新值\n第二行');
  sameWorkArea(dom, before);
});

test('reopening an edited value by a native click/click/dblclick sequence preserves that value', async () => {
  const { dom } = await open();
  let candidate = dom.body.querySelector('[data-review-candidate]');
  fire(candidate, 'dblclick', { detail: 2 });
  let editor = dom.body.querySelector('[data-review-edit]');
  editor.value = '保留人工改写';
  fire(editor, 'blur');
  candidate = dom.body.querySelector('[data-review-candidate]');
  fire(candidate, 'click', { detail: 1 });
  fire(candidate, 'click', { detail: 2 });
  fire(candidate, 'dblclick', { detail: 2 });
  editor = dom.body.querySelector('[data-review-edit]');
  assert.equal(editor.value, '保留人工改写');
});

test('required checks update only progress and save availability, retaining the checklist and preview', async () => {
  const { dom } = await open({ card: { checks: [{ key: 'source', label: '核对原件' }] } });
  for (const candidate of dom.body.querySelectorAll('[data-review-candidate]')) fire(candidate, 'click');
  const before = snapshot(dom), check = dom.body.querySelector('[data-review-check-key]');
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, true);
  check.checked = true;
  fire(check, 'change');
  assert.ok(dom.body.querySelector('[data-review-check-key]') === check);
  assert.ok(dom.body.querySelector('[data-review-save]') === save);
  assert.equal(save.disabled, false);
  assert.match(dom.body.querySelector('[data-review-progress]').textContent, /4\/4/);
  sameWorkArea(dom, before);
});

test('text-format candidates retain their source excerpt and ignore a detached editor from another card', async () => {
  const { dom, window } = await open({
    declaration: { leftSlot: { title: '修改内容', format: 'text' } },
    card: { changes: [sampleChange('c1', { candidate: true }), sampleChange('c2', { candidate: true })] },
  });
  const before = snapshot(dom), excerpt = before.left.querySelector('[data-review-original-text]');
  const candidate = before.left.querySelector('[data-review-candidate]');
  fire(candidate, 'dblclick');
  const oldEditor = before.left.querySelector('[data-review-edit]');
  oldEditor.value = '不应串入另一张卡';
  assert.ok(dom.body.querySelector('[data-review-slot="left"]').querySelector('[data-review-original-text]') === excerpt);
  const api = window.shangshuReviewCenter;
  api.state.cards['sample.notice'].push(sampleCard({ id: 'CARD-2' }));
  api.openCard('sample.notice', 'CARD-2');
  fire(oldEditor, 'blur');
  assert.equal(api.state.activeCardId, 'CARD-2');
  assert.equal(api.state.edits.has('c1'), false);
});

test('PDF is visible immediately; missing location and empty excerpts do not compete with the original', async () => {
  const { dom } = await open({ card: { evidence: [{ id: 'ev-1', name: '原件.pdf', type: 'pdf',
    available: true, reference: 'FILE-1' }] } });
  const right = dom.body.querySelector('[data-review-slot="right"]');
  assert.equal(right.querySelector('[data-review-original-collapsed]'), null);
  assert.equal(right.querySelector('.review-pdf-locator'), null);
  assert.equal(right.querySelector('.review-pdf-excerpt'), null);
  assert.equal(right.querySelector('.review-pdf-name'), null);
  assert.equal(right.querySelector('[data-review-open-original]').hidden, true);
});

test('declared preparation success refreshes only declared sources, then opens the resulting candidate', async () => {
  let linked = 0, untouched = 0, targetLists = 0;
  const { dom, window, listCalls } = await open({
    beforeMount(window) {
      registerSampleDeclaration(window, { key: 'sample.target', list: async () => {
        targetLists++;
        return [sampleCard({ id: 'TARGET' })];
      } });
      registerSampleDeclaration(window, { key: 'sample.unrelated', list: async () => {
        untouched++;
        return [];
      } });
    },
    declaration: { handling: { actions: [{ id: 'select', label: '选择关联记录', run: async () => {
      linked++;
      return { refreshDeclarations: ['sample.target'], openCard: { declaration: 'sample.target', id: 'TARGET' } };
    } }] } },
  });
  const initialLists = listCalls(), targets = targetLists, others = untouched;
  fire(dom.body.querySelector('[data-review-handling-action]'), 'click');
  fire(dom.body.querySelector('[data-review-handling-action]'), 'click');
  await settle();
  assert.equal(linked, 1);
  assert.equal(listCalls(), initialLists + 1);
  assert.equal(targetLists, targets + 1);
  assert.equal(untouched, others);
  assert.equal(window.shangshuReviewCenter.state.activeCardId, 'TARGET');
  assert.equal(window.shangshuReviewCenter.state.tab, 'sample.target');
});

test('cancelled or failed preparation retains original and local candidates without list reads or final writes', async () => {
  let fail = false;
  const { dom, calls, listCalls } = await open({ declaration: {
    handling: { actions: [{ id: 'select', label: '选择关联记录', run: async () => {
      if (fail) throw Error('关联失败，请重试');
      return false;
    } }] },
  } });
  const initial = listCalls(), requests = calls.length, before = snapshot(dom);
  const button = dom.body.querySelector('[data-review-handling-action]');
  fire(button, 'click');
  await settle();
  assert.equal(button.disabled, false);
  sameWorkArea(dom, before);
  fail = true;
  fire(button, 'click');
  await settle();
  assert.equal(dom.body.querySelector('[data-review-handling-error]').textContent, '关联失败，请重试');
  assert.equal(dom.body.querySelector('[data-review-handling-error]').hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(listCalls(), initial);
  assert.equal(calls.length, requests);
  sameWorkArea(dom, before);
});

test('independent evidence lookups start together; failure still blocks the supported group', async () => {
  let release, started = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const { dom } = await open({
    shell: { readFileCenterVersions: async file => {
      started++;
      await barrier;
      if (file === 'FILE-2') throw Error('原件不可用');
      return fileCenterVersions(file);
    } },
    card: { evidence: [
      { id: 'ev-1', name: '第一份.pdf', type: 'pdf', reference: 'FILE-1', required: true },
      { id: 'ev-2', name: '第二份.pdf', type: 'pdf', reference: 'FILE-2', required: true },
    ] },
  });
  assert.equal(started, 2, 'the second independent evidence must not wait for the first');
  const before = snapshot(dom);
  release();
  await settle();
  sameWorkArea(dom, before);
  for (const candidate of dom.body.querySelectorAll('[data-review-candidate]')) fire(candidate, 'click');
  assert.equal(dom.body.querySelector('[data-review-save]').disabled, true);
});

test('saving a candidate does not reload unrelated review declarations', async () => {
  let unrelated = 0;
  const { dom, listCalls } = await open({ beforeMount(window) {
    registerSampleDeclaration(window, { key: 'sample.unrelated', list: async () => { unrelated++; return []; } });
  } });
  const before = unrelated, currentLists = listCalls();
  for (const candidate of dom.body.querySelectorAll('[data-review-candidate]')) fire(candidate, 'click');
  fire(dom.body.querySelector('[data-review-save]'), 'click');
  await settle();
  assert.equal(unrelated, before);
  assert.equal(listCalls(), currentLists + 1);
});

test('explicitly clearing a candidate sends the empty value for backend validation', async () => {
  const { dom, calls } = await open();
  fire(dom.body.querySelector('[data-review-candidate]'), 'dblclick');
  const editor = dom.body.querySelector('[data-review-edit]');
  editor.value = '';
  fire(editor, 'blur');
  const candidates = dom.body.querySelectorAll('[data-review-candidate]');
  fire(candidates[1], 'click');
  fire(candidates[2], 'click');
  fire(dom.body.querySelector('[data-review-save]'), 'click');
  await settle();
  const write = calls.find(call => /\/accept$/.test(call.path));
  assert.ok(write);
  assert.deepEqual(JSON.parse(write.init.body).edited_value['u-c1'], {type:'text', value:''});
});
