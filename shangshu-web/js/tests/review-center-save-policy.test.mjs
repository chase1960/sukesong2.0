// 判据：审核中心的**两种保存方式**（内核契约 `review-center-v1.json` §save_policy）
//   · **不允许部分保存**（example 一份文件带动的修改）：可以逐项核对，但**最后整体提交**；
//     只采用了一部分时**不许提交**，底栏显示「已核对 N/M 项」；**后端也要校验整组**。
//   · **允许部分保存**（其它场景）：「确认所选 N 项」⇒ 只保存这几项，其余仍待审。
//   · 正式值**只经内核的确认 Action 写**（`api/platform/action-proposals/<id>/accept`）——
//     **不许另造一条写正式值的路**。
//   · **公共独立性**：一份**不依赖 example** 的示例声明仍能打开、核对、保存。
//
// **测试通过 =**（一句话）
// 「整组模式下：三项只采用两项 ⇒ 保存按钮**点不动**、底栏写着「已核对 2/3 项」；
//   全核过之后一次提交**带上全部三项**；后端回失败时**不报整体成功**（说「整组保存失败」）。
//   部分模式下：五项变化采用两项 ⇒ 只提交**那两个 unit**，其余三项**重开仍待审**。
//   两种模式下写正式值的请求**只有**内核那一个 `/accept`。
//   一份**跟 example 毫无关系**的示例声明，照样能打开、核对、保存。」
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, settle } from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click' });
const candidatesOf = dom => dom.body.querySelectorAll('[data-review-candidate]');

/** 打开弹窗，把前 n 项采用掉。 */
async function adoptFirst(dom, n) {
  for (let i = 0; i < n; i += 1) {
    click(candidatesOf(dom)[i]);
    await settle();
  }
}

function mount(dom) {
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  return host;
}

test('① 整组保存：只采用两项时**不许提交**，底栏写「已核对 2/3 项」', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, { savePolicy: { partial: false, unit: '一条变更', group: 'card' } });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();

  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 0/3 项');
  await adoptFirst(dom, 2);
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 2/3 项',
    '底栏没写真实核对进度');
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, true, '只采用了两项就许提交了 —— 不允许部分保存');
  assert.match(dom.body.querySelector('[data-review-save]').textContent, /整组/, '保存按钮没说明这是整组保存');
  assert.equal(calls.filter(call => /accept/.test(call.path)).length, 0, '还没全核就写了正式值');
});

test('② 整组保存：全核过之后一次提交**带上全部三项**', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, { savePolicy: { partial: false, unit: '一条变更', group: 'card' } });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 3);
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, false, '全核过了还是不许提交');
  click(save);
  await settle();

  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1, '整组保存只打了一次内核确认口');
  const body = JSON.parse(accepts[0].init.body);
  assert.equal(body.units.length, 3, '整组保存没有把三项一起带上');
  assert.deepEqual(body.units.slice().sort(), ['u-c1', 'u-c2', 'u-c3']);
  assert.match(dom.body.querySelector('[data-review-receipt]').textContent, /整组已保存/, '没如实说整组已保存');
});

test('③ 整组保存失败 ⇒ **不报整体成功**（一个字节都不许说成已保存）', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom, {
    reply: (path) => (/accept$/.test(path) ? { ok: false, status: 400, error: '整组没核完' } : { ok: true, list: [] }),
  });
  registerSampleDeclaration(window, { savePolicy: { partial: false, unit: '一条变更', group: 'card' } });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 3);
  click(dom.body.querySelector('[data-review-save]'));
  await settle();
  const receipt = dom.body.querySelector('[data-review-receipt]').textContent;
  assert.ok(!/已保存/.test(receipt), '失败了还说「已保存」：' + receipt);
  assert.match(receipt, /整组保存失败/, '没如实说是整组失败：' + receipt);
  assert.equal(calls.filter(call => /accept$/.test(call.path)).length, 1);
});

test('④ 部分保存：五项变化采用两项 ⇒ 只保存那两项，其余三项重开仍待审', async () => {
  const dom = createDom();
  const accepted = new Set();
  const { window, calls } = loadShell(dom, {
    reply: (path, init) => {
      if (/\/accept$/.test(path)) {
        const body = JSON.parse(init.body);
        body.units.forEach(unit => accepted.add(unit));
        return { ok: true, status: 'proposed' };
      }
      return { ok: true, list: [] };
    },
  });
  const five = ['f1', 'f2', 'f3', 'f4', 'f5'].map(id => sampleChange(id));
  registerSampleDeclaration(window, {
    savePolicy: { partial: true, unit: '一条变更', group: 'card' },
    list: async () => [sampleCard({
      id: 'CARD-FIVE',
      changes: five.filter(change => !accepted.has(change.unit.unitId)),
    })],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  assert.equal(candidatesOf(dom).length, 5, '一开始不是五项');
  await adoptFirst(dom, 2);
  const save = dom.body.querySelector('[data-review-save]');
  assert.match(save.textContent, /确认所选 2 项/, '部分保存的按钮没写清楚要保存几项：' + save.textContent);
  click(save);
  await settle();

  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1);
  const body = JSON.parse(accepts[0].init.body);
  assert.equal(body.units.length, 2, '部分保存把没选中的也提交了');
  assert.deepEqual(body.units.slice().sort(), ['u-f1', 'u-f2']);

  /* **其余三项重开仍待审**。 */
  await window.shangshuReviewCenter.refreshPage();
  await settle();
  const cards = dom.body.querySelectorAll('[data-review-card]');
  assert.equal(cards.length, 1, '保存过两项之后这一张卡不见了');
  assert.match(cards[0].textContent, /共 3 项待核对/, '其余三项没留在待审里：' + cards[0].textContent);
});

test('⑤ 正式值只经内核的确认 Action 写（除它之外一个写请求都没有）', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, { savePolicy: { partial: true, unit: '一条变更', group: 'card' } });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 1);
  click(dom.body.querySelector('[data-review-save]'));
  await settle();
  const writes = calls.filter(call => String(call.init && call.init.method).toUpperCase() === 'POST');
  assert.equal(writes.length, 1, '写正式值的请求不止一个：' + JSON.stringify(writes.map(call => call.path)));
  assert.match(writes[0].path, /api\/platform\/action-proposals\/.+\/accept$/,
    '写的不是内核的确认 Action：' + writes[0].path);
});

test('⑥ 公共独立性：一份**不依赖 example** 的示例声明照样能打开、核对、保存', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  const result = registerSampleDeclaration(window, { savePolicy: { partial: true, unit: '一条变更', group: 'card' } });
  assert.equal(result.ok, true, '示例声明注册失败：' + JSON.stringify(result.errors));
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  assert.ok(dom.body.querySelector('[data-review-card]'), '示例声明的卡没出来');
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  assert.ok(dom.body.querySelector('[data-review-split]'), '示例声明点不开');
  await adoptFirst(dom, 1);
  click(dom.body.querySelector('[data-review-save]'));
  await settle();
  assert.equal(calls.filter(call => /\/accept$/.test(call.path)).length, 1, '示例声明没保存成');
});

test('⑦ 声明完整性：换一张卡（换案件）后旧核对**不跟着走**；提交集合由声明的整组范围说了算', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, {
    savePolicy: { partial: false, unit: '一条变更', group: (card) => card.changes.map(change => change.id) },
    list: async () => [
      sampleCard({ id: 'CARD-A', title: '案件甲的凭据', caseId: 'CASE-A' }),
      sampleCard({ id: 'CARD-B', title: '案件乙的凭据', caseId: 'CASE-B' }),
    ],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  const opens = dom.body.querySelectorAll('[data-review-card-open]');
  click(opens[0]);
  await settle();
  await adoptFirst(dom, 2);
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 2/3 项');

  /* 换到另一张卡（另一个案件）⇒ 旧核对的进度不许跟过来。 */
  await window.shangshuReviewCenter.closeCard();
  await settle();
  click(dom.body.querySelectorAll('[data-review-card-open]')[1]);
  await settle();
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 0/3 项',
    '旧案件的已选修改被带到了新案件');

  /* 提交集合＝声明的整组范围（三项），与看没看全无关。 */
  await adoptFirst(dom, 3);
  click(dom.body.querySelector('[data-review-save]'));
  await settle();
  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  const body = JSON.parse(accepts[accepts.length - 1].init.body);
  assert.equal(body.units.length, 3, '整组范围没按声明来');
});
