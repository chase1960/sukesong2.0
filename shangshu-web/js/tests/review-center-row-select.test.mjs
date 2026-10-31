// 判据：公共审核中心壳 —— **域在一行里给一个选择**（`item.select`）。
//
// **测试通过 =**（一句话）
// 「域在那一行声明了 `select = {label, options, value, onChange}` ⇒ 壳在**那一行里**画出一个下拉、
//   下拉里的选项就是域给的那几个、当前值就是域给的那个；人改了下拉 ⇒ 壳把新值交给域的 `onChange`；
//   域没给 `select` ⇒ 壳**一个字都不画**（壳不替域发明控件）。」
//
// ⚠️ **这是内核路径**（壳是公共件）⇒ 改动标 **CORE-CANDIDATE**。
// ⚠️ **为什么壳要加这个**：域要在「附件组合」那一行里让人挑「合并／不合并」——
//   壳原来只认 `item.button`（一个按钮），画不出「选一档」⇒ 域挑了也带不走。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, pageHost, settle } from './helpers/review-center-shell.mjs';

const fire = (node, type, extra = {}) => node.dispatchEvent({ type, ...extra });

/** 装一份壳 ＋ 摆一张卡（卡上带一行域给的选择）。 */
async function open(change) {
  const dom = createDom();
  const shell = loadShell(dom, {});
  registerSampleDeclaration(shell.window, {
    list: async () => [sampleCard({ changes: [change] })],
  });
  await shell.window.shangshuReviewCenter.mountPage(pageHost(dom), {});
  await settle();
  fire(dom.body.querySelector('[data-review-card-open]'), 'click');
  await settle();
  return dom;
}

test('域给 `select` ⇒ 壳在那一行里画出一个下拉，选项和当前值都是域给的', async () => {
  const dom = await open(sampleChange('c1', {
    label: '附件组合',
    before: '',
    after: '同案还有 2 件可合并',
    adoptable: false,
    select: {
      label: '附件组合方式',
      options: [{ value: 'merged', label: '合并' }, { value: 'independent', label: '不合并' }],
      value: 'independent',
      onChange: () => {},
    },
  }));
  const row = dom.body.querySelector('[data-review-row]');
  assert.ok(row, '卡上没有那一行');
  const select = row.querySelector('[data-review-row-select]');
  assert.ok(select, '域给了 `select`，壳却没画出来（域挑了也带不走）');
  const options = select.querySelectorAll('option');
  assert.deepEqual(options.map(node => String(node.textContent || '').trim()), ['合并', '不合并'],
    '下拉里的选项不是域给的那几个：' + JSON.stringify(options.map(node => node.textContent)));
  assert.deepEqual(options.map(node => node.value), ['merged', 'independent'],
    '下拉里每档的值不是域给的 `value`');
  assert.equal(select.value, 'independent', '下拉没有停在域给的当前值上');
  assert.equal(select.getAttribute('aria-label'), '附件组合方式',
    '下拉没有可读的名字（读屏的人认不出这是什么）');
});

test('人改了下拉 ⇒ 壳把新值交给域的 `onChange`', async () => {
  const picked = [];
  const dom = await open(sampleChange('c1', {
    label: '附件组合',
    before: '',
    after: '同案还有 2 件可合并',
    adoptable: false,
    select: {
      label: '附件组合方式',
      options: ['合并', '不合并'],
      value: '不合并',
      onChange: value => { picked.push(value); },
    },
  }));
  const select = dom.body.querySelector('[data-review-row-select]');
  assert.ok(select, '没有那个下拉');
  select.value = '合并';
  fire(select, 'change');
  assert.deepEqual(picked, ['合并'],
    '人改了却没叫域（挑了带不走）：' + JSON.stringify(picked));
});

test('域没给 `select` ⇒ 壳一个字都不画（不替域发明控件）', async () => {
  const dom = await open(sampleChange('c1', { label: '当前状态' }));
  assert.equal(dom.body.querySelectorAll('[data-review-row-select]').length, 0,
    '域没给选择，壳却自己画了一个');
});
