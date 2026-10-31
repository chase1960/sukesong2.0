// 「修改审核」面板（表格那条逐项审核）的落定判据 —— 同一个缺陷的第二种外观。
//
// 用户 2026-10-21 实测截图：点「保存此项／保存全部待审项」之后，面板停在
// 「已保存 0 · 待审 1」，底下写「结果尚未核实。请用原编号重试，不要另建提案；已保存的结果不会重复执行。」
// ⇒ 回执没核实成功 ⇒ 计数没往前走。
//
// 根因钉在**请求体字段名**：逐项审核口读 `expected_review_revision`（邮件那条、表格域那条都是这个名），
// 本面板之前发的是 `review_revision` → 口里拿不到版本 → 回执读不出来。
//
// 通过 =
//   ① 保存成功（有回执）⇒ 计数立刻前进 ＋ 面板落定成「已确认」；
//   ② 请求体用 `expected_review_revision`（且**不带** `review_revision`）；
//   ③ 回执未知/失败 ⇒ 如实显示「结果尚未核实」＋ 给出「用原编号核实」可重试，**不显示已确认**、计数不前进。
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = readFileSync(new URL('../../../shangshu-web/js/proposal-review.js', import.meta.url), 'utf8');
const waitFor = async (predicate: () => boolean, timeoutMs = 3000, label = '条件') => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：' + label + ' 未在 ' + timeoutMs + 'ms 内满足');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const descriptor = (over: any = {}) => ({
  ok: true, id: 'p1', capability: 'files.edit_cells', status: 'proposed', created_via: 'ai-chat',
  review_revision: 'rev-1', target: {module: 'file-center', file: 'f1', name: '1.xlsx'},
  units: [{unit_id: 'u1', kind: 'cell', label: '1 · 第2行第1列', status: 'pending',
    value: {type: 'text', value: '候选值'}, current_value: {type: 'text', value: '这是占位，请改'}, editable: true}],
  remaining: 1, accepted_count: 0, ...over,
});

// 挂一张「修改审核」面板；accept 走 acceptReply（可模拟好回执／未知回执／已知失败），
// state 是「读回」时看到的当前状态（可中途改，模拟目标页那边先处理完了）。
function mount(acceptReply: (body: any) => any, state: any = descriptor()) {
  const dom = new JSDOM('<div id="host"></div>', {runScripts: 'outside-only', url: 'http://localhost/index.html#/dash'});
  const w = dom.window as any;
  const posts: any[] = [];
  w.eval(source);
  w.resolveConfirmation = async () => ({ok: true, status: 'rejected'});
  w.api = async (path: string, options: any) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push({path, body});
      return acceptReply(body);
    }
    return {ok: true, status: 200, json: async () => state};
  };
  const host = w.document.querySelector('#host');
  const card = w.mountProposalReview(host, {id: 'p1', capability: 'files.edit_cells'});
  const tag = () => card.querySelector('.cf-heading .cf-tag')?.textContent;
  const status = () => card.querySelector('[data-review-status]')?.textContent;
  const buttons = () => [...card.querySelectorAll('button')].map((b: any) => b.textContent);
  return {w, card, posts, tag, status, buttons, close: () => dom.window.close()};
}

it('保存成功（有回执）⇒ 计数立刻前进、面板落定成「已确认」：测试通过 = 状态点写「已确认」、卡片进终态、正文说「已保存 1 项」', async () => {
  const t = mount(() => ({
    ok: true, status: 200,
    json: async () => descriptor({
      status: 'confirmed', remaining: 0, accepted_count: 1, review_revision: 'rev-2',
      units: [{unit_id: 'u1', kind: 'cell', label: '1 · 第2行第1列', status: 'accepted',
        value: {type: 'text', value: '候选值'}, current_value: {type: 'text', value: '候选值'},
        adopted_value: '候选值', original_value: '这是占位，请改', editable: true}],
    }),
  }));
  try {
    await waitFor(() => t.buttons().includes('保存此项'), 3000, '面板读完候选');
    assert.equal(t.tag(), '已保存 0 · 待审 1');
    const one = t.card.querySelector('[data-accept-unit]') as any;
    one.click();
    await waitFor(() => /已保存 1 项/.test(t.status() || ''), 3000, '保存回执到了');
    assert.equal(t.tag(), '已确认', '全部处理完后状态点变成「已确认」');
    assert.equal(t.card.classList.contains('resolved'), true, '面板进终态');
    assert.equal(t.card.dataset.outcome, 'success');
    assert.ok(!t.buttons().includes('保存全部待审项'), '没有待审项了就不该再有「保存全部待审项」');
    assert.doesNotMatch(t.status() || '', /结果尚未核实/);
  } finally { t.close(); }
});

it('逐项审核口读的是 expected_review_revision：测试通过 = 请求体带 expected_review_revision，且**不带** review_revision', async () => {
  const t = mount(() => ({ok: true, status: 200, json: async () => descriptor({status: 'confirmed', remaining: 0, accepted_count: 1})}));
  try {
    await waitFor(() => t.buttons().includes('保存此项'), 3000, '面板读完候选');
    (t.card.querySelector('[data-accept-unit]') as any).click();
    await waitFor(() => t.posts.length === 1, 3000, '发了一次保存');
    await waitFor(() => /已保存|结果尚未核实|未保存/.test(t.status() || ''), 3000, '这一轮保存走完（别在窗口关闭后才继续渲染）');
    const body = t.posts[0].body;
    assert.equal(body.expected_review_revision, 'rev-1', '带 expected_review_revision');
    assert.equal('review_revision' in body, false, '不许再发 review_revision（口里读不到 → 回执读不出来）');
    assert.equal(body.op_id, String(body.op_id), '带稳定 op_id（同一 op_id 重试不重复写）');
    assert.ok(body.op_id && body.op_id.length > 5);
  } finally { t.close(); }
});

it('回执未知（5xx／回执不完整）⇒ 如实显示「结果尚未核实」＋ 给「用原编号核实」，不显示已确认、计数不前进', async () => {
  for (const reply of [
    {ok: false, status: 500, json: async () => ({ok: false, error: '平台请求失败'})},
    {ok: true, status: 200, json: async () => ({ok: true, id: 'other'})}, // 回执不完整
  ]) {
    const t = mount(() => reply);
    try {
      await waitFor(() => t.buttons().includes('保存此项'), 3000, '面板读完候选');
      (t.card.querySelector('[data-accept-unit]') as any).click();
      await waitFor(() => /结果尚未核实/.test(t.status() || ''), 3000, '如实显示未核实');
      assert.match(t.status() || '', /用原编号重试/);
      assert.ok(t.buttons().includes('用原编号核实'), '给出可重试的原编号入口');
      assert.equal(t.tag(), '已保存 0 · 待审 1', '没拿到回执就不许前进计数');
      assert.doesNotMatch(t.tag() || '', /已确认/, '没拿到回执不许显示已确认');
      assert.equal(t.card.classList.contains('resolved'), false);
    } finally { t.close(); }
  }
});

it('目标页把同一提案处理完了 → 面板重新读回：测试通过 = 状态点变「已确认」、计数前进，且「打开原件」不被禁用', async () => {
  const state = descriptor();
  const t = mount(() => ({ok: true, status: 200, json: async () => state}), state);
  try {
    await waitFor(() => t.buttons().includes('保存此项'), 3000, '面板读完候选');
    // 表格那条在目标页把最后一项也处理完了 → 派终态事件 → 面板自己重新读回。
    Object.assign(state, {
      status: 'confirmed', remaining: 0, accepted_count: 1, review_revision: 'rev-2',
      units: [{unit_id: 'u1', kind: 'cell', label: '1 · 第2行第1列', status: 'accepted',
        value: {type: 'text', value: '候选值'}, current_value: {type: 'text', value: '候选值'},
        adopted_value: '候选值', original_value: '这是占位，请改', editable: true}],
    });
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-resolved', {detail: {proposal_id: 'p1', status: 'confirmed', origin: 'excel'}}));
    await waitFor(() => t.tag() === '已确认', 3000, '面板按终态重新读回');
    assert.equal(t.card.classList.contains('resolved'), true);
    const open = [...t.card.querySelectorAll('button')].find((b: any) => b.textContent === '打开原件') as any;
    assert.ok(open, '「打开原件」还在');
    assert.equal(open.disabled, false, '「打开原件」不是重复提交，不许被禁掉');
  } finally { t.close(); }
});

it('已知失败（4xx 明确错误）⇒ 如实显示失败原因，且可以重新发起保存', async () => {
  const t = mount(() => ({ok: false, status: 417, json: async () => ({ok: false, error: '审核或正式记录已更新，请刷新候选后再确认；本次未保存'})}));
  try {
    await waitFor(() => t.buttons().includes('保存此项'), 3000, '面板读完候选');
    (t.card.querySelector('[data-accept-unit]') as any).click();
    await waitFor(() => /未保存/.test(t.status() || ''), 3000, '如实显示失败原因');
    assert.equal(t.tag(), '已保存 0 · 待审 1', '没保存成就不许前进计数');
    assert.equal(t.card.classList.contains('resolved'), false);
    const save = [...t.card.querySelectorAll('button')].find((b: any) => b.textContent === '保存此项') as any;
    assert.equal(save.disabled, false, '已知失败＝什么都没写 ⇒ 允许重新发起');
  } finally { t.close(); }
});
