// 判据：**审核中心按最新口径收口的那九条**（PKG-099-T01）
//
// 这九条是《审核中心逐条对账表》里的「缺口清单 G1～G9」——
// 那张表核出来的结论是：**十六条「判据弱」全部是判据缺，不是实现缺**。
// 这一份判据把九条缺口逐条**钉住**；哪一条钉不住（红），就是**真缺口**，当场记下来。
//
// **测试通过 =**（一句话）
// 「关闭弹窗会先问要不要放弃；保存过程分得出失败／冲突／结果未明；采用一项不重拉原件；
//   左栏挪乱不改整组范围；必需凭据失败只挡它自己那一组、辅助凭据失败只提示；
//   换声明不串味；**一个声明的能力不可用只阻断它自己，别的审核照常开照常存**。」
//
// **为什么在这里写**：这九条全在**公共壳**的公共行为上（不含 example 域自己的那条）⇒
// 判据放**公共壳判据目录** `shangshu-web/js/tests/`。
// example 那条（没整组保存就不误触发后续）在域内 ⇒ 放域里的判据目录。
//
// ⚠️ **判据不许靠 grep 样式表／源码字符串**：一律把壳**真的装进最小 DOM 跑一遍**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import {
  loadShell, registerSampleDeclaration, sampleCard, sampleChange, settle, fileCenterVersions,
} from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click' });
const candidatesOf = dom => dom.body.querySelectorAll('[data-review-candidate]');

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

/** 一份带左右两栏、允许部分保存的声明（改起来最省事）。 */
function partialDeclaration(window, overrides = {}) {
  return registerSampleDeclaration(window, Object.assign({
    savePolicy: { partial: true, unit: '一条变更', group: 'card' },
  }, overrides || {}));
}

test('G1 关闭弹窗时，未保存的核对结果**有明确处理**（先问要不要放弃；不放弃就不关；放弃了才收）', async () => {
  const dom = createDom();
  const asked = [];
  let answer = false;
  const { window, calls } = loadShell(dom, {
    confirm: (text) => { asked.push(String(text)); return answer; },
  });
  registerSampleDeclaration(window, { savePolicy: { partial: false, unit: '一条变更', group: 'card' } });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 1);

  /* ① 关闭时**先问一句**（不许静默丢掉人工编辑）。 */
  answer = false;
  click(dom.body.querySelector('[data-review-split-close]'));
  await settle();
  assert.equal(asked.length, 1, '关闭未保存的内容时没问用户要不要放弃');
  assert.match(asked[0], /还没保存/, '那句问话没说要放弃什么：' + asked[0]);

  /* ② 答「不放弃」⇒ **弹窗不关**，核对进度还在。
     ⚠️ 弹窗那个元素**关掉后仍在页面里**（它是复用的那一扇）⇒ 看的是 `open` 属性，不是「在不在 DOM 里」。 */
  const dialog = dom.body.querySelector('[data-review-split]');
  assert.ok(dialog && dialog.hasAttribute('open'), '答了「不放弃」还是把弹窗关了');
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 1/3 项',
    '答了「不放弃」却把核对进度清了');

  /* ③ 答「放弃」⇒ 收起来，那一项回到待采用，**正式数据一个字没改**。 */
  answer = true;
  click(dom.body.querySelector('[data-review-split-close]'));
  await settle();
  assert.equal(asked.length, 2, '第二次关闭没再问一次');
  assert.ok(!dialog.hasAttribute('open'), '答了「放弃」还是没收起来');
  assert.equal(calls.filter(call => /accept/.test(call.path)).length, 0, '关闭弹窗竟然写了正式值');

  /* ④ 再打开 ⇒ 那一项回到「待采用」。 */
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 0/3 项',
    '放弃之后重新打开，那一项还留在「已采用」里');
});

test('G2 保存过程分得出**失败／冲突／结果未明**（不许一律说成「保存失败」，更不许说成「已保存」）', async () => {
  /**
   * 三种情形各跑一遍。
   * · **失败**（4xx）：明写失败，**并把后端给的那句话带出来**（光说「失败」等于没告诉用户为什么）。
   * · **冲突**（409）：明写「冲突」—— 冲突不是失败：冲突＝别人刚改过，要重新核对。
   * · **结果未明**（5xx／拿不到回执）：明写「结果未知」，**不许让用户再点一次**（可能已经写进去了）。
   */
  const cases = [
    { status: 400, error: '这一组必须整组一起提交', expect: /失败/, forbid: /冲突|结果未知/ },
    { status: 409, error: '这一行已被他人修改', expect: /冲突/, forbid: /已保存/ },
    { status: 503, error: '网关超时', expect: /结果未知/, forbid: /已保存/ },
  ];
  for (const item of cases) {
    const dom = createDom();
    const { window } = loadShell(dom, {
      reply: (path) => (/accept$/.test(path)
        ? { ok: false, status: item.status, error: item.error }
        : { ok: true, list: [] }),
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
    assert.ok(receipt.length > 0, `（${item.status}）底栏一句话都没有`);
    assert.match(receipt, item.expect,
      `（${item.status}）底栏没把这情形说清楚：「${item.error}」⇒ 现在写的是「${receipt}」`);
    assert.ok(!item.forbid.test(receipt),
      `（${item.status}）底栏把两件事混成一件：「${receipt}」`);
    assert.ok(!/已保存/.test(receipt), `（${item.status}）没保存成功却写了「已保存」：「${receipt}」`);
    assert.match(receipt, new RegExp(item.error),
      `（${item.status}）后端给的那句「${item.error}」没透出来：「${receipt}」`);
  }
});

test('G3 采用一项**不重拉全部原件**（原件取过就复用；底栏进度当场更新）', async () => {
  const dom = createDom();
  let reads = 0;
  const { window } = loadShell(dom, {
    readFileCenterVersions: async (file) => { reads += 1; return fileCenterVersions(file); },
  });
  registerSampleDeclaration(window, {
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    list: async () => [sampleCard({
      evidence: [
        { id: 'ev-1', name: '受理通知书.pdf', type: 'pdf', required: true, available: true, reference: 'FILE-1', locator: { page: 2, paragraph: 1 } },
      ],
    })],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  const before = reads;
  assert.ok(before > 0, '弹窗打开后原件一个字节都没取（那「取不到不许确认」怎么成立？）');

  await adoptFirst(dom, 1);
  assert.equal(reads, before, `采用一项就把原件全重新拉了一遍（读口被调用了 ${reads - before} 次）`);
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 1/3 项',
    '采用一项之后底栏进度没当场更新');
});

test('G5 左栏被挪乱（折叠／筛选／重排）**不改整组范围** —— 提交集合由卡上的数据说了算', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, {
    savePolicy: { partial: false, unit: '一条变更', group: card => card.changes.map(change => change.id) },
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 3);

  /* —— 把左栏那一栏的 DOM **整块搬走**（模拟折叠／筛选／重排把那些行挪掉了）。 */
  const left = dom.body.querySelector('[data-review-slot="left"]');
  assert.ok(left, '左栏不在');
  left.parentNode.removeChild(left);

  /* —— 提交集合**仍然**是整组那三项（不是屏幕上看得见的那些）。 */
  await window.shangshuReviewCenter.saveActiveCard();
  await settle();
  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1, '没提交出去');
  const body = JSON.parse(accepts[0].init.body);
  assert.equal(body.units.length, 3,
    '左栏被挪乱之后，整组范围被改小了（提交集合由屏幕反推了）');
  assert.deepEqual(body.units.slice().sort(), ['u-c1', 'u-c2', 'u-c3']);
});

test('G6 必需凭据失败**只挡它对应的那一组**；辅助凭据失败**只提示**，别的独立项照样能确认', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  /* 一张卡两个提案（两个内容组），各带一条变更。
     · 凭据一：**必需**（`ev-required`），对应 PR-1 那条变更，**打不开**；
     · 凭据二：**辅助**（`ev-aux`），对应 PR-2 那条变更，**也打不开**。 */
  registerSampleDeclaration(window, {
    savePolicy: { partial: true, unit: '一条变更', group: 'card' },
    evidenceBinding: { required: ['ev-required'], locator: 'page' },
    list: async () => [sampleCard({
      id: 'CARD-TWO-GROUPS',
      changes: [
        sampleChange('c1', { unit: { proposalId: 'PR-1', unitId: 'u-c1', reviewRevision: 'rev-1' } }),
        sampleChange('c2', { unit: { proposalId: 'PR-2', unitId: 'u-c2', reviewRevision: 'rev-1' } }),
      ],
      evidence: [
        { id: 'ev-required', name: '必看件.pdf', type: 'pdf', required: true, available: false, locator: { page: 1 }, changes: ['c1'] },
        { id: 'ev-aux', name: '辅助件.pdf', type: 'pdf', required: false, available: false, locator: { page: 2 }, changes: ['c2'] },
      ],
    })],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();

  /* 只采用 **PR-2 那一组**的那一条（辅助件坏了的那一组）。 */
  const candidates = candidatesOf(dom);
  assert.equal(candidates.length, 2, '左栏没摆出两条候选');
  click(candidates[1]);
  await settle();

  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, false,
    '**辅助**凭据坏了就把不相干的另一组也卡住了（辅助失败只该提示）');
  click(save);
  await settle();
  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1, '那一组没保存成');
  const body = JSON.parse(accepts[0].init.body);
  assert.deepEqual(body.units, ['u-c2'], '提交的不是所选的那一组');
});

test('G8 换声明／换卡之后，**上一份的核对不许跟过去**（同名变更也不许串味）', async () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  /* 两份声明，**两张卡的变更 id 一样**（'c1'）—— 最容易串味的情形。 */
  registerSampleDeclaration(window, {
    key: 'sample.first',
    name: '示例：第一类',
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    list: async () => [sampleCard({ id: 'CARD-A', title: '甲的凭据', changes: [sampleChange('c1')] })],
  });
  registerSampleDeclaration(window, {
    key: 'sample.second',
    name: '示例：第二类',
    order: 2,
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    list: async () => [sampleCard({ id: 'CARD-B', title: '乙的凭据', changes: [sampleChange('c1')] })],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();

  /* 第一类里采用那一条。 */
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 1);
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 1/1 项');

  /* 切到第二类 ⇒ 打开它那张卡 ⇒ **进度必须从零开始**（同名变更也不许继承）。 */
  await window.shangshuReviewCenter.switchTab('sample.second');
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  assert.equal(dom.body.querySelector('[data-review-progress]').textContent, '已核对 0/1 项',
    '上一类里采用的那一条跟到了这一类（同名变更串味了）');
});

test('G9 一个声明的所属能力不可用 ⇒ **只阻断它自己**，别的审核照常开、照常存', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  /* 一份正常的声明（不依赖任何域）＋ 一份**能力不可用**的声明（取数就炸）。 */
  registerSampleDeclaration(window, {
    key: 'sample.good',
    name: '示例：正常那一类',
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
  });
  registerSampleDeclaration(window, {
    key: 'sample.broken',
    name: '示例：能力不可用那一类',
    order: 2,
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    list: async () => { throw new Error('所属能力不可用'); },
  });
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();

  /* ① 正常那一类的卡**照样出来**（不许被带崩的那一份拖掉）。 */
  const cards = dom.body.querySelectorAll('[data-review-card]');
  assert.ok(cards.length > 0, '一份声明能力不可用 ⇒ **整页**的卡都没了（不该拖垮其他审核）');
  assert.ok(!/读取失败/.test(dom.body.textContent),
    '整页退化成一句「读取失败」：' + dom.body.textContent.slice(0, 200));

  /* ② 正常那一类**照样能打开、能保存**。 */
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  await adoptFirst(dom, 3);
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, false, '别的审核被带崩之后保存按钮点不动了');
  click(save);
  await settle();
  assert.equal(calls.filter(call => /\/accept$/.test(call.path)).length, 1, '正常那一类没保存成');
});
