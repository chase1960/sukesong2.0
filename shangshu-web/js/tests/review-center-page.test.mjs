// 判据：审核中心的**凭据级卡片 ＋ 左右分栏大弹窗**
// （内核契约 `review-center-v1.json` §interaction／§slots；老项目实际文件审核页
//   `ip-review-center.js` 的卡片列表 ＋ `ip-m4-review-fields` / `ip-m4-review-content` 两栏观感）。
//
// **测试通过 =**（一句话）
// 「页上一条待审项是**一张卡**（一份凭据 ＝ 一组变更：三项变化只出**一张**卡，不是一张一张的变更卡）；
//   卡片上**不点开就知道要不要现在看**（凭据名、定位摘要、每一项的「当前值 → 候选值」、凭据是哪一份）；
//   点开是**左右分栏的大弹窗**：左栏＝要改成什么、右栏＝凭据，**两栏各按自己声明的格式**选公共渲染器
//   （左＝字段对比表、右＝正文预览；左右都能换成任意格式，公共渲染器只有一套）；
//   候选文字**呼吸**、**单击采用**、**再单击取消采用**、**双击改写**（改写后是普通文字＝待保存），
//   **提交前正式数据一个字节都不动**，变色**不冒充已保存**；
//   **无差异不展示**（相同的两项不进卡、全相同的卡不进队列），**未知/失败不能当成相同**；
//   **必需凭据打不开 ⇒ 那一组不许确认**。」
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, sampleChange, settle } from './helpers/review-center-shell.mjs';

/** 把壳装好、登记示例声明、挂上这一页。 */
async function openPage(dom, overrides = {}) {
  const { window, calls } = loadShell(dom);
  registerSampleDeclaration(window, overrides);
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  return { window, calls, host };
}

const cardsOf = dom => dom.body.querySelectorAll('[data-review-card]');
const candidatesOf = dom => dom.body.querySelectorAll('[data-review-candidate]');
const click = node => node.dispatchEvent({ type: 'click' });
const dblclick = node => node.dispatchEvent({ type: 'dblclick' });

test('① 凭据级卡片：一份凭据 ＝ 一张卡 ＝ 一组变更（不是一条变更一张卡）', async () => {
  const dom = createDom();
  await openPage(dom);
  const cards = cardsOf(dom);
  assert.equal(cards.length, 1, '三项变化出了一堆卡片 —— 卡片必须是**凭据级**的');
  const card = cards[0];
  assert.equal(card.getAttribute('data-review-card'), 'CARD-1');
  /* 卡上要能看见这一组有几项。 */
  assert.match(card.textContent, /共 3 项待核对/, '卡片上没写这一组有几项');
});

test('② 卡片照**原版那张卡**：抬头够判断要不要现在看，**字段对照不在卡上**（用户 2026-10-23 10:1x：「卡片信息太多了，去看看原版的那个卡片」）', async () => {
  const dom = createDom();
  await openPage(dom);
  const card = cardsOf(dom)[0];
  const text = card.textContent;
  /* **原版那张卡**（旧项目实际文件审核页 `.fr-file-card`）只有 5 样：
     图标 ＋ 标题／类型·大小／上传时间／关联案件／动作。
     我们照那一档：**凭据名 ＋ 有几项 ＋ 关联哪个案件 ＋ 动作入口**。 */
  assert.match(text, /受理通知书 FILE-1/, '卡片上没写是哪一份凭据');
  assert.match(text, /共 3 项待核对/, '卡片上没写这一组有几项');
  /* **绑定案件那一行**＝域给的**案件号**（不是从摘要里猜出来的）
     ⇒ 必须写成「绑定案件：CASE-001」（用户 2026-10-27 20:31：「绑定案件在哪里呢？」——
     标签要说人话，人一眼知道这一行是「绑在哪一个案件上」）。 */
  assert.match(text, /绑定案件：CASE-001/,
    '卡片上没写「绑定案件：CASE-001」⇒ 装配时把域给的案件号丢了');
  /* **字段对照表不在卡上了** —— 逐项核对是**弹窗左栏**的活（卡上摆着就「信息太多」）。 */
  assert.equal(card.querySelectorAll('.review-card-row').length, 0,
    '卡片上还摆着字段对照表 ⇒ 卡片信息太多（原版那张卡没有）');
  /* 凭据逐条名也不在卡上（原件在弹窗右栏）。 */
  assert.ok(!/凭据：/.test(text), '卡片上还摆着凭据逐条名 ⇒ 信息太多');
  /* 动作入口还在（点它才进弹窗）。 */
  assert.ok(card.querySelector('[data-review-card-open]'), '卡片上没有「打开核对」的入口');
});

test('③ 点开是左右分栏的大弹窗：左＝要改的内容，右＝凭据，各按自己声明的格式', async () => {
  const dom = createDom();
  const { window } = await openPage(dom);
  const open = dom.body.querySelector('[data-review-card-open]');
  assert.ok(open, '卡片上没有「打开核对」的入口');
  click(open);
  await settle();
  const dialog = dom.body.querySelector('[data-review-split]');
  assert.ok(dialog, '点开没有出分栏弹窗');
  const slots = dom.body.querySelectorAll('[data-review-slot]');
  assert.equal(slots.length, 2, '弹窗不是左右两栏');
  const left = slots.find(slot => slot.getAttribute('data-review-slot') === 'left');
  const right = slots.find(slot => slot.getAttribute('data-review-slot') === 'right');
  assert.equal(left.getAttribute('data-review-format'), 'field-table', '左栏没用声明的格式');
  assert.equal(right.getAttribute('data-review-format'), 'pdf', '右栏没用声明的格式');
  assert.ok(left.querySelector('[data-review-row]'), '左栏没画出要改的内容');
  assert.ok(right.querySelector('[data-review-pdf]'), '右栏没画出凭据');
  /* ⚠️ 右栏**不再给「定位：第 N 页」那一行**（用户 2026-10-27 20:31 要求去掉）——
     右栏摆的是原件本体，定位由原件自己的阅读器承担。 */
  assert.doesNotMatch(right.textContent, /定位：/,
    '右栏还在印「定位：…」那一行（用户已要求去掉）');
  assert.doesNotMatch(right.textContent, /第 2 页/,
    '右栏还在印「第 2 页」那一行描述');
  assert.ok(right.querySelector('[data-review-open-original]'), '右栏没给「在文件中心打开原件」');
  assert.ok(window.shangshuReviewCenter);
});

test('④ 一套渲染器、两个槽位：左右都能变成任意格式（换个格式照样能开）', async () => {
  const dom = createDom();
  await openPage(dom, {
    leftSlot: { title: '要改的内容', format: 'text' },
    rightSlot: { title: '凭据', format: 'attachment-list' },
  });
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  const slots = dom.body.querySelectorAll('[data-review-slot]');
  const left = slots.find(slot => slot.getAttribute('data-review-slot') === 'left');
  const right = slots.find(slot => slot.getAttribute('data-review-slot') === 'right');
  assert.equal(left.getAttribute('data-review-format'), 'text', '左栏没换成声明的格式');
  assert.equal(right.getAttribute('data-review-format'), 'attachment-list', '右栏没换成声明的格式');
  assert.ok(right.querySelector('[data-review-attachment]'), '右栏没画出附件清单');
});

test('⑤ 呼吸 ＋ 单击采用 ＋ 再单击取消采用 ＋ 双击改写；提交前正式数据不变，变色不冒充成功', async () => {
  const dom = createDom();
  const { window, calls } = await openPage(dom);
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();

  const first = candidatesOf(dom)[0];
  assert.equal(first.getAttribute('data-proposal-state'), 'pending', '待采用的候选不该是已保存的样子');
  assert.match(first.className, /proposed-text/, '候选文字没有呼吸用的公共类名');

  /* 单击采用。 */
  click(first);
  await settle();
  const adopted = candidatesOf(dom)[0];
  assert.equal(adopted.getAttribute('data-proposal-state'), 'adopted', '单击没有采用');
  assert.notEqual(adopted.getAttribute('data-proposal-state'), 'saved', '本地采用就报「已保存」—— 变色冒充成功');

  /* 再单击 ⇒ 取消采用。 */
  click(candidatesOf(dom)[0]);
  await settle();
  assert.equal(candidatesOf(dom)[0].getAttribute('data-proposal-state'), 'pending', '再单击没取消采用');

  /* 双击 ⇒ 改写（变普通文字 ＝ 待保存）。 */
  dblclick(candidatesOf(dom)[0]);
  await settle();
  const editor = dom.body.querySelector('[data-review-edit]');
  assert.ok(editor, '双击没有进入改写');
  editor.value = '改过的值';
  editor.dispatchEvent({ type: 'change' });
  await settle();
  const edited = candidatesOf(dom)[0];
  assert.equal(edited.getAttribute('data-proposal-state'), 'edited', '改写后不是待保存的样子');
  assert.equal(edited.textContent, '改过的值', '改写后的值没换上');
  assert.equal(edited.getAttribute('data-proposal-state') !== 'saved', true, '改写冒充已保存');

  /* **提交前正式数据一个字节都不动**。 */
  assert.equal(calls.filter(call => /accept/.test(call.path)).length, 0, '还没点保存就写了正式值');
});

test('⑥ 无差异不展示：相同的两项不进卡；全相同的卡不进队列', async () => {
  const dom = createDom();
  const { window } = await openPage(dom, {
    list: async () => [
      sampleCard({
        id: 'CARD-MIX', title: '有差异的一份',
        changes: [
          sampleChange('same-1', { before: '一样', after: '一样' }),
          sampleChange('diff-1', { before: '旧', after: '新' }),
        ],
      }),
      sampleCard({
        id: 'CARD-SAME', title: '全相同的一份',
        changes: [sampleChange('same-2', { before: '甲', after: '甲' })],
      }),
    ],
  });
  await window.shangshuReviewCenter.refreshPage();
  await settle();
  const cards = cardsOf(dom);
  assert.equal(cards.length, 1, '全相同的那张卡也进队列了 —— 空卡不进队列');
  assert.equal(cards[0].getAttribute('data-review-card'), 'CARD-MIX');
  assert.match(cards[0].textContent, /共 1 项待核对/, '计数把相同的那项也算进去了');
  /* 相同的那一项**到处都不展示**（卡上不摆、弹窗左栏也不摆）—— 见证挪到弹窗左栏
     （卡上已经没有字段对照行了：用户 2026-10-23 批注「卡片信息太多了」）。 */
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  const left = dom.body.querySelector('[data-review-slot="left"]');
  assert.equal(left.querySelectorAll('.review-value-row').length, 1,
    '弹窗左栏把相同的那一项也摆出来了');
});

test('⑦ 未知不能当成相同：读不到的那一项照样要摆出来', async () => {
  const dom = createDom();
  await openPage(dom, {
    list: async () => [sampleCard({
      id: 'CARD-UNKNOWN',
      changes: [sampleChange('unknown-1', { before: undefined, after: '新' })],
    })],
  });
  const cards = cardsOf(dom);
  assert.equal(cards.length, 1, '读不到值的那一项被当成「相同」藏起来了');
  assert.match(cards[0].textContent, /共 1 项待核对/, '读不到的那一项没被算进待审');
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  const left = dom.body.querySelector('[data-review-slot="left"]');
  assert.equal(left.querySelectorAll('.review-value-row').length, 1,
    '读不到值的那一项在弹窗左栏被藏起来了（未知不能当成相同）');
});

test('⑧ 必需凭据打不开 ⇒ 那一组不许确认', async () => {
  const dom = createDom();
  const { window } = await openPage(dom, {
    list: async () => [sampleCard({
      id: 'CARD-BROKEN',
      evidence: [{ id: 'ev-1', name: '受理通知书.pdf', required: true, available: false, locator: { page: 2 } }],
    })],
  });
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  assert.equal(window.shangshuReviewCenter.canSave(
    window.shangshuReviewCenter.declarations().find(item => item.key === 'sample.notice'),
    window.shangshuReviewCenter.state.cards['sample.notice'][0],
  ), false, '必需凭据打不开却还能确认');
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, true, '必需凭据打不开，保存按钮却是可点的');
});
