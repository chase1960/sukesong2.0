/**
 * **PKG-118-T01 · 审核中心弹窗那一侧**：单元状态是 `staged` 时，弹窗要显示成「**已暂存**」。
 *
 * **为什么要有这条**（用户 2026-10-25 原话）：
 * 「在单元格里单击等同于在审核中心暂存」⇒ 表格里暂存的那几项，**在审核中心里必须看得见**
 * —— 同一份状态，**不许存两份**（《处理契约》§8.1）。
 *
 * **测试通过 = 什么成立**：
 * 「一条 `state:'staged'` 的候选，在审核中心弹窗里那一行写着「**已暂存**」，
 *   候选上标着 `data-proposal-state="staged"`（**不是** `pending`、**不是** `adopted`）；
 *   同一张卡里没暂存的那一条照旧写着「待采用」；
 *   并且「已暂存」**不算「已核对完」**（底栏仍是「已核对 0/2 项」）——
 *   暂存 ≠ 采用 ≠ 落库（内核 §staged_tier）。」
 *
 * **跑法**：
 *   cd shangshu-server && node --import tsx --test ../shangshu-web/js/domains/excel-univer/tests/review-center-staged.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../../../scripts/tests/mini-dom.mjs';
import {loadShell,registerSampleDeclaration,sampleCard,sampleChange,settle} from '../../../tests/helpers/review-center-shell.mjs';

const click=node=>node.dispatchEvent({type:'click'});

function mount(dom){
  const host=dom.h('div',{class:'main-scroll','data-page':'review-center'});
  dom.body.appendChild(host);
  return host;
}

test('⑧ 审核中心弹窗把 staged 显示成「已暂存」，不混成「待采用」也不混成「已采用」',async()=>{
  const dom=createDom();
  const {window}=loadShell(dom);
  registerSampleDeclaration(window,{
    list:async()=>[sampleCard({changes:[
      sampleChange('c1',{state:'staged'}),   // 服务端已经暂存的那一项
      sampleChange('c2'),                    // 还没暂存的那一项
    ]})],
  });
  await window.shangshuReviewCenter.mountPage(mount(dom),{});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();

  const marks=dom.body.querySelectorAll('[data-review-row-state]');
  assert.equal(marks.length,2,'弹窗里没摆出两行候选');
  assert.equal(marks[0].textContent,'已暂存','暂存过的那一项没显示成「已暂存」');
  assert.equal(marks[1].textContent,'待采用','没暂存的那一项被带偏了');

  const candidates=dom.body.querySelectorAll('[data-review-candidate]');
  assert.equal(candidates[0].getAttribute('data-proposal-state'),'staged',
    '暂存过的候选没标成 staged（混成 pending/adopted 就是把暂存说成了采用）');
  assert.equal(candidates[1].getAttribute('data-proposal-state'),'pending',
    '没暂存的候选被标错了');

  /* 暂存**不算「已核对完」**（内核按字面口径）⇒ 底栏照旧是 0/2。 */
  const progress=dom.body.querySelector('[data-review-progress]');
  assert.equal(progress.textContent,'已核对 0/2 项',
    `暂存被算成「已核对」了：${progress.textContent}`);
});
