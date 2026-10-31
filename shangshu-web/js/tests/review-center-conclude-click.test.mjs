// 判据：审核中心**结论类**（`handling.mode='conclude'`）那张卡上：
//   ① **不再摆「必核清单」那三个勾**，左栏**不再摆标题行**，不用勾任何东西就能提交；
//   ② **候选值在原位**：单击＝暂存（采用），双击＝**改写**（原位出输入框）；
//   ③ **待采用的候选值在呼吸**（算出来的生效值，不是 grep 样式表）；
//   ④ **正文上点一下不落结论** —— 结论只走底栏那个「核对无误」按钮（明确保存才入库）；
//   ⑤ 「不过」有既有的一条路：信息有误／待核实 → 填差异说明 ⇒ 落「待补充材料」。
//
// **为什么这么定**（用户 2026-10-24 22:34 原话）：
//   「我们不是可以直接用单双击来确认吗？为什么还要多此一举的大勾，如果不过怎么办」
//   ＋ 23:2x 原话：「**不应该在原位『单击暂存，双击修改』吗？？？而且呼吸去哪里了？？？**
//   **你再仔细看看原项目的交互**」
//   ⇒ 照**旧项目**那一套（`ip-review-center.js` 的 `.cr-file-candidate`）：
//     **值在原位**（不另找入口）、**待采用时呼吸**（蓝色呼吸文字）、
//     **单击暂存／双击改写**、**明确保存才入库**。
//   ⇒ 「不过」不另造第二条路：**信息有误／待核实**（填差异说明）就是既有那条。
//
// ⚠️ **这一版订正了前一版的判据**（2026-10-24 23:3x）：前一版把「单击正文＝落通过、
//   双击正文＝不过」钉死了 —— **方向错了**（那是把结论手势挂在整块正文上，
//   而旧项目是**在原位**逐项暂存）。前一版的两条实现已撤回，这一版钉的是旧项目那一套。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { createResolver } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, settle } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const effective = createEffective(resolver, 1440);

const click = node => node.dispatchEvent({ type: 'click', target: node });
const dblclick = node => node.dispatchEvent({ type: 'dblclick', target: node });

/**
 * 一份**结论类**声明（核完给结论，不是改写正式值）。
 * 刻意**不依赖 example** —— 公共壳的通用能力。
 */
function registerConclude(window, log) {
  window.shangshuReviewCenter.registerSaveAction('sample.conclude', {
    id: 'sample.conclude',
    label: '示例结论口',
    groupAccept: false,
    partialAccept: true,
    save: async (payload, options) => {
      log.concluded.push({ card: options.card.id, changed: (options.changed || []).map(c => c.id) });
      return [{ id: options.card.id, ok: true }];
    },
  });
  return registerSampleDeclaration(window, {
    key: 'sample.conclude',
    name: '示例：核完给结论',
    kind: 'official',
    /* 左栏**不摆标题**（声明给空串）——「要核对的」那种小标题不该再出现。 */
    leftSlot: { title: '', format: 'field-table' },
    savePolicy: { partial: true, unit: '一份凭据', group: 'card' },
    handling: {
      mode: 'conclude',
      entries: ['check', 'difference'],
      difference: async (card, reason) => { log.differences.push(String(reason || '')); },
    },
    execution: { saveAction: 'sample.conclude' },
    list: async () => [sampleCard({
      changes: [sampleChange('c1', { label: '官文信息核对', before: '审查中', after: '已受理' })],
    })],
  });
}

function mount(dom) {
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  return host;
}

/** 打开那张卡，返回左栏正文。 */
async function openConcludeCard(dom, window) {
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  const left = dom.body.querySelector('[data-review-slot="left"]');
  assert.ok(left, '左栏没出来');
  return left;
}

test('① 结论类卡：不用勾任何东西就能提交，按钮写着「核对无误」，左栏不摆标题，也没有那三个勾', async () => {
  const dom = createDom();
  const log = { concluded: [], differences: [] };
  const { window } = loadShell(dom);
  registerConclude(window, log);
  const left = await openConcludeCard(dom, window);

  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, false, '结论类卡不许直接提交 —— 还得先勾那三个？（那三个勾就是要去掉的闸门）');
  assert.match(save.textContent, /核对无误/, '提交按钮没写清楚这是「核对无误」：' + save.textContent);
  assert.equal(left.querySelectorAll('.review-slot-title').length, 0,
    '左栏还摆着那行小标题（声明给了空标题也不画）');
  assert.equal(dom.body.querySelectorAll('[data-review-checks]').length, 0,
    '结论类卡上还摆着必核清单那三个勾');
});

test('② **在原位**：单击候选值＝暂存（采用），双击＝改写（原位出输入框）', async () => {
  const dom = createDom();
  const log = { concluded: [], differences: [] };
  /* 同样给「真的会响」的 setTimeout（空桩下等不出一颗定时器 ⇒ 断言会假绿）。 */
  const { window } = loadShell(dom, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  });
  registerConclude(window, log);
  await openConcludeCard(dom, window);

  const candidate = dom.body.querySelector('[data-review-candidate]');
  assert.ok(candidate, '卡上没有候选值（值不在原位）');
  assert.equal(candidate.getAttribute('data-proposal-state'), 'pending',
    '候选值一开始就该是「待采用」');

  /* —— **单击＝暂存**（不是直接落结论）—— */
  click(candidate);
  await new Promise(resolve => setTimeout(resolve, 800));
  await settle();
  /* 暂存后壳会**重画**这一张卡 ⇒ 要**重新取**那个候选值（拿旧的那个元素量是不算的）。 */
  const staged = dom.body.querySelector('[data-review-candidate]');
  assert.equal(staged.getAttribute('data-proposal-state'), 'adopted',
    '单击候选值没有变成「已暂存」：' + staged.getAttribute('data-proposal-state'));
  assert.equal(log.concluded.length, 0, '单击一下就把结论落了 —— 暂存与落结论是两回事');

  /* —— **双击＝改写**（原位出输入框）—— */
  dblclick(dom.body.querySelector('[data-review-candidate]'));
  await settle();
  const editor = dom.body.querySelector('[data-review-edit]');
  assert.ok(editor, '双击候选值没有在原位出改写输入框');
  assert.equal(editor.value, '已受理', '改写框里没带上原值');
});

test('③ **待采用的候选值在呼吸**（算出来的生效值，不是 grep 样式表）', async () => {
  const hit = effective(['.review-value-cell .proposed-text'], 'animation');
  assert.ok(hit, '候选值那条样式根本没写 animation —— 没有呼吸');
  assert.match(hit.value, /breathe/, '待采用的候选值不呼吸（生效的 animation：' + hit.value + '）');

  /* —— **暂存之后就不再呼吸**（已采用的候选不该还在那儿闪）。 —— */
  const adopted = effective([
    '.review-value-cell .proposed-text',
    '.review-value-cell .proposed-text[data-proposal-state="adopted"]',
  ], 'animation');
  assert.ok(adopted, '暂存态那条样式根本没写 animation');
  assert.equal(adopted.value, 'none',
    '暂存之后还在呼吸（生效的 animation：' + adopted.value + '）');
});

test('④ **正文上点一下／双击都不落结论** —— 结论只走底栏那个「核对无误」按钮（明确保存才入库）', async () => {
  const dom = createDom();
  const log = { concluded: [], differences: [] };
  /* ⚠️ **必须给「真的会响」的 setTimeout**（判据公用件的默认那套是空桩）：
     被订正掉的那个旧实现是「单击正文 ⇒ 等 550ms 再落结论」——
     空桩下那个定时器**永远不响** ⇒ 判据会**假绿**（查不出这个错误方向，
     上一轮就是这么蒙混过去的）。这里给真的，并且**等过 550ms 那道坎**再断言。 */
  const { window } = loadShell(dom, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  });
  registerConclude(window, log);
  await openConcludeCard(dom, window);

  /* 点正文（不是候选值、不是按钮）⇒ **不许**落结论。 */
  click(dom.body.querySelector('[data-review-slot-body]'));
  await new Promise(resolve => setTimeout(resolve, 800));
  await settle();
  assert.equal(log.concluded.length, 0, '在正文上点一下就把结论落了');

  /* 双击正文 ⇒ 也不许落结论、更不许自己打开差异说明
     （差异说明是「信息有误／待核实」那个口的事，不是正文上的手势）。 */
  dblclick(dom.body.querySelector('[data-review-slot-body]'));
  await new Promise(resolve => setTimeout(resolve, 800));
  await settle();
  assert.equal(log.concluded.length, 0, '双击正文把结论落了');
  assert.equal(dom.body.querySelectorAll('[data-review-difference-reason]').length, 0,
    '双击正文自己打开了差异说明 —— 结论手势不许挂在整块正文上');

  /* 明确点那个「核对无误」⇒ 才落结论。 */
  click(dom.body.querySelector('[data-review-save]'));
  await settle();
  assert.equal(log.concluded.length, 1, '点「核对无误」没有落结论');
});

test('⑤ 「不过」＝既有那条路：信息有误／待核实 → 填差异说明 ⇒ 落「待补充材料」', async () => {
  const dom = createDom();
  const log = { concluded: [], differences: [] };
  const { window } = loadShell(dom);
  registerConclude(window, log);
  await openConcludeCard(dom, window);

  const difference = dom.body.querySelector('[data-review-difference]');
  assert.ok(difference, '没有「信息有误／待核实」那个入口');
  click(difference);
  await settle();
  const reason = dom.body.querySelector('[data-review-difference-reason]');
  assert.ok(reason, '没有差异说明输入框');
  reason.value = '官文写的受理日期和台账不一样';
  click(dom.body.querySelector('[data-review-difference-submit]'));
  await settle();

  assert.deepEqual(log.differences, ['官文写的受理日期和台账不一样'], '差异说明没落到域的处理方式上');
  assert.equal(log.concluded.length, 0, '记了差异却又落了「通过」');
  assert.match(dom.body.querySelector('[data-review-receipt]').textContent, /已记录差异/,
    '底栏没如实说已记录差异');
});
