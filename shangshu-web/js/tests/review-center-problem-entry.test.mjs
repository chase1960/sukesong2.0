// 判据：审核中心底栏那两个入口（「信息有误／待核实」与「退回检查」）**合成一个**、**一页**。
//
// **测试通过 =**（一句话）
// 「一个声明**同时**给了这两种处理方式时，底栏**只摆一个**入口
//   （不是两个按钮，也不是各自开一页）；
//   点它开**一页**表单（**选是哪一种** ＋ 一句理由）；
//   选「内容有误」提交 ⇒ 走 difference 那条；选「要退回重新核对」提交 ⇒ 走 reject 那条
//   （**两个结果不一样** ⇒ 不许替他挑）；
//   **只给一种**的声明照旧摆那一个按钮（别的域一个字不变）。」
//
// ⚠️ **为什么这么定**（用户 2026-10-28 14:1x 原话）：
//   「退回检查和信息有误是什么情况？能不能合并成一页？」
//   ⇒ 这两个是**同一个意思的两条路**（人看着不对 ⇒ 写一句为什么），
//   旧项目**只有一条**这种入口 ⇒ 现在合成底栏**一个入口**、**一页表单**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, settle } from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click', target: node });

/** 一份**同时**给了两种处理方式的声明（两种结果不一样）。 */
function registerBoth(window, log) {
  return registerSampleDeclaration(window, {
    key: 'sample.problem',
    name: '示例：核完给结论（两种问题处理方式）',
    kind: 'official',
    leftSlot: { title: '', format: 'field-table' },
    savePolicy: { partial: true, unit: '一份凭据', group: 'card' },
    handling: {
      mode: 'conclude',
      entries: ['check', 'difference', 'reject'],
      difference: async (card, reason) => { log.differences.push(String(reason || '')); },
      reject: async (card, reason) => { log.rejects.push(String(reason || '')); },
      problem: {
        label: '有问题要说明',
        kinds: [
          { id: 'difference', label: '这份通知书有误', note: '落「待补充材料」' },
          { id: 'reject', label: '要退回重新核对', note: '整组退回' },
        ],
      },
    },
    execution: { saveAction: 'kernel.accept' },
    list: async () => [sampleCard({
      changes: [sampleChange('c1', { label: '官文信息核对', before: '审查中', after: '已受理' })],
    })],
  });
}

/** 打开那张卡（页内 → 弹窗）。 */
async function openCard(dom, window) {
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
}

test('① 底栏**只摆一个**入口（两个处理方式合成一个按钮，不各自开一页）', async () => {
  const dom = createDom();
  const log = { differences: [], rejects: [] };
  const { window } = loadShell(dom);
  registerBoth(window, log);
  await openCard(dom, window);

  const problem = dom.body.querySelectorAll('[data-review-problem]');
  assert.equal(problem.length, 1, '底栏的「有问题」入口不是一个：' + problem.length);
  assert.match(problem[0].textContent, /有问题要说明/, '那个按钮的文案不对：' + problem[0].textContent);
  assert.equal(dom.body.querySelectorAll('[data-review-difference]').length, 0,
    '「信息有误／待核实」还是单独一个按钮');
  assert.equal(dom.body.querySelectorAll('[data-review-reject]').length, 0,
    '「退回检查」还是单独一个按钮');
});

test('② 点它开**一页**表单：选是哪一种 ＋ 一句理由', async () => {
  const dom = createDom();
  const log = { differences: [], rejects: [] };
  const { window } = loadShell(dom);
  registerBoth(window, log);
  await openCard(dom, window);

  click(dom.body.querySelector('[data-review-problem]'));
  await settle();
  const form = dom.body.querySelector('[data-review-difference-form]');
  assert.ok(form, '点那个入口没开表单');
  assert.equal(form.getAttribute('data-review-handling-kind'), 'problem', '开的不是「有问题」那一页');
  const kinds = dom.body.querySelectorAll('[data-review-problem-kind]')
    .map(node => node.getAttribute('data-review-problem-kind'));
  assert.deepEqual(JSON.parse(JSON.stringify(kinds)), ['difference', 'reject'],
    '那一页里没有让人选是哪一种：' + JSON.stringify(kinds));
  assert.ok(dom.body.querySelector('[data-review-difference-reason]'), '那一页里没有理由那一句');
});

test('③ 选「这份通知书有误」⇒ 走 difference 那条（**不**走退回）', async () => {
  const dom = createDom();
  const log = { differences: [], rejects: [] };
  const { window } = loadShell(dom);
  registerBoth(window, log);
  await openCard(dom, window);

  click(dom.body.querySelector('[data-review-problem]'));
  await settle();
  const reason = dom.body.querySelector('[data-review-difference-reason]');
  reason.value = '受理日期和台账不一样';
  click(dom.body.querySelector('[data-review-difference-submit]'));
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(log.differences)), ['受理日期和台账不一样'],
    '选「有误」没有走 difference 那条：' + JSON.stringify(log.differences));
  assert.equal(log.rejects.length, 0, '选「有误」却走了退回那条');
});

test('④ 选「要退回重新核对」⇒ 走 reject 那条（**不**走差异那条）', async () => {
  const dom = createDom();
  const log = { differences: [], rejects: [] };
  const { window } = loadShell(dom);
  registerBoth(window, log);
  await openCard(dom, window);

  click(dom.body.querySelector('[data-review-problem]'));
  await settle();
  const radio = dom.body.querySelectorAll('[data-review-problem-kind]')
    .find(node => node.getAttribute('data-review-problem-kind') === 'reject');
  assert.ok(radio, '那一页里没有「要退回重新核对」那个选择');
  radio.dispatchEvent({ type: 'change', target: radio });
  await settle();
  const reason = dom.body.querySelector('[data-review-difference-reason]');
  reason.value = '还没看原件，先退回核对';
  click(dom.body.querySelector('[data-review-difference-submit]'));
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(log.rejects)), ['还没看原件，先退回核对'],
    '选「退回」没有走 reject 那条：' + JSON.stringify(log.rejects));
  assert.equal(log.differences.length, 0, '选「退回」却走了差异那条');
});

test('⑤ **只给一种**的声明照旧摆那一个按钮（别的域一个字不变）', async () => {
  const dom = createDom();
  const log = { differences: [], rejects: [] };
  const { window } = loadShell(dom);
  registerSampleDeclaration(window, {
    key: 'sample.difference-only',
    name: '示例：只有「信息有误」那种',
    kind: 'official',
    leftSlot: { title: '', format: 'field-table' },
    savePolicy: { partial: true, unit: '一份凭据', group: 'card' },
    handling: {
      mode: 'conclude',
      entries: ['check', 'difference'],
      difference: async (card, reason) => { log.differences.push(String(reason || '')); },
    },
    execution: { saveAction: 'kernel.accept' },
    list: async () => [sampleCard()],
  });
  await openCard(dom, window);

  assert.equal(dom.body.querySelectorAll('[data-review-difference]').length, 1,
    '只给一种的声明，那个按钮不见了');
  assert.equal(dom.body.querySelectorAll('[data-review-problem]').length, 0,
    '只给一种的声明不该出现「有问题」那个入口');
});
