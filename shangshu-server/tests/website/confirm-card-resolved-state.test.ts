// 确认卡「落定」判据（用户 2026-10-21 在 3850 实测报的缺陷）：
// 「我如果在页面上全部确认每一个地方，确认完后确认卡不能丝滑地变成已确认状态。」
//
// 复现口径：对话流里的「操作确认」卡（右上角状态点写着「待确认」，底部 上一个/下一个/全部确认）。
//   · 全部确认点下去 → 卡片必须变成「已确认」，状态点跟着变，���钮禁掉（不许重复提交）。
//   · 逐项在目标页确认完（remaining=0） → 卡片自己落定，**不用再点一次「全部确认」**。
//   · 回执失败/结果未知 → 卡片不许显示「已确认」（如实显示失败）。
//
// 通过 = 状态**真的**变了（状态点文案 + data-outcome + 按钮 disabled），不是换个好看的说法。
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8');
const waitFor = async (predicate: () => boolean, timeoutMs = 3000, label = '条件') => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：' + label + ' 未在 ' + timeoutMs + 'ms 内满足');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

type Options = {
  descriptor?: any;
  controller?: any;
  navigate?: any;
  setup?: (w: any) => void;
};

// 挂一张带逐项审核的确认卡（mail.save_draft 走页面内联审核 → 有 上一个/下一个/全部确认）。
function mount(options: Options = {}) {
  const dom = new JSDOM('<div id="body"></div>', {runScripts: 'outside-only', url: 'http://localhost/index.html#/dash'});
  const w = dom.window as any;
  const requests: any[] = [];
  w.esc = (x: any) => String(x ?? '').replace(/[&<>"']/g, (c: string) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c] as string));
  w.money = String;
  w.toast = () => {};
  w.chatScrollBottom = () => {};
  w.chatUpdateFab = () => {};
  w.chatConfirmFollowUp = async () => {};
  w.shangshuConfirmationPresenters = {};
  let descriptor = {
    id: 'p1', status: 'proposed', can_accept: true, can_reject: true, remaining: 2, accepted_count: 0,
    units: [
      {unit_id: 'subject', label: '主题', status: 'pending', value: '候选主题'},
      {unit_id: 'body', label: '正文', status: 'pending', value: '候选正文'},
    ],
    ...(options.descriptor || {}),
  };
  w.api = async (path: string, request: any) => {
    requests.push({path, request});
    if (String(path).includes('/units')) {
      const u = new URL(String(path), 'http://x');
      const off = Number(u.searchParams.get('offset') || 0);
      const lim = Number(u.searchParams.get('limit') || 20);
      const pending = (descriptor.units || []).filter((x: any) => String(x.status || 'pending').toLowerCase() === 'pending');
      return {ok: true, json: async () => ({ok: true, proposal: descriptor.id, total: pending.length, offset: off, limit: lim, items: pending.slice(off, off + lim)})};
    }
    return {ok: true, json: async () => descriptor};
  };
  w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'), source.indexOf('/* —— 确认之后')));
  w.shangshuInlineReviews = new w.Map();
  w.shangshuNavigateReview = options.navigate || (async () => true);
  if (options.controller) w.shangshuInlineReviews.set('p1', options.controller);
  const proposal = {id: 'p1', capability: 'mail.save_draft', created_via: 'ai-chat', payload: {subject: '候选主题', body: '候选正文'}, ...(options.setup ? {} : {})};
  options.setup?.(w);
  w.chatBindPendingReviews();
  w.chatAddConfirmCard(w.document.querySelector('#body'), proposal, {navigate: false});
  const card = () => w.document.querySelector('[data-confirm-id]') as any;
  const ok = () => card().querySelector('.cf-btn.ok') as any;
  const tag = () => card().querySelector('.cf-heading .cf-tag') as any;
  return {
    w, requests, card, ok, tag,
    setDescriptor: (next: any) => { descriptor = {...descriptor, ...next}; },
    close: () => dom.window.close(),
  };
}

it('点「全部确认」后卡片落定为「已确认」：测试通过 = 状态点写「已确认」、全文不再出现「待确认」、「全部确认」按钮被禁用', async () => {
  let calls = 0;
  const t = mount({controller: {id: 'p1', acceptRemaining: async () => { calls++; return {id: 'p1', status: 'confirmed', remaining: 0}; }}});
  try {
    await waitFor(() => !t.ok().disabled, 3000, '可用性核对完成、确认可点');
    assert.equal(t.ok().textContent, '全部确认');
    t.ok().click();
    await waitFor(() => /已确认/.test(t.card().textContent), 3000, '卡片落定为已确认');
    assert.equal(calls, 1, '页面控制器只被调用一次');
    assert.equal(t.card().classList.contains('resolved'), true, '卡片进入终态');
    assert.equal(t.tag().textContent, '已确认', '右上角状态点真的变成「已确认」');
    assert.equal(t.card().dataset.outcome, 'success', '终态记为成功（状态点走绿色）');
    assert.doesNotMatch(t.card().textContent, /待确认/, '卡上不许再留「待确认」');
    assert.equal(t.ok().disabled, true, '「全部确认」按钮被禁用，不许重复提交');
    assert.ok(Array.from(t.card().querySelectorAll('button:not([data-review-open])')).every((b: any) => b.disabled), '其余动作按钮一并禁用');
    assert.ok(t.requests.every(r => !r.request?.method || r.request.method === 'GET'), '全程只读核对，不多写');
  } finally { t.close(); }
});

it('逐项在目标页确认完（remaining=0）卡片自己落定：测试通过 = 不点「全部确认」也变成「已确认」、按钮禁用、没多写任何东西', async () => {
  let calls = 0;
  const t = mount({controller: {id: 'p1', acceptRemaining: async () => { calls++; return {id: 'p1', status: 'confirmed', remaining: 0}; }}});
  try {
    await waitFor(() => !t.ok().disabled, 3000, '可用性核对完成');
    // 目标页把最后一项也确认了 → 后端把提案落成 confirmed、remaining=0，
    // 页面照惯例派两个事件：先 review-progress（进度），再 review-resolved（终态）。
    t.setDescriptor({status: 'confirmed', remaining: 0, can_accept: false, can_reject: false});
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-progress', {detail: {proposal_id: 'p1', descriptor: {id: 'p1', status: 'confirmed', can_accept: false, can_reject: false, remaining: 0, accepted_count: 2}}}));
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-resolved', {detail: {proposal_id: 'p1', status: 'confirmed', origin: 'mail'}}));
    await waitFor(() => /已确认/.test(t.card().textContent), 3000, '逐项走完后卡片落定');
    assert.equal(calls, 0, '没有再调页面控制器（不用再点一次「全部确认」）');
    assert.equal(t.card().classList.contains('resolved'), true);
    assert.equal(t.tag().textContent, '已确认', '状态点真的变成「已确认」');
    assert.equal(t.card().dataset.outcome, 'success');
    assert.doesNotMatch(t.card().textContent, /待确认/, '卡上不许再留「待确认」');
    assert.equal(t.ok().disabled, true, '「全部确认」按钮被禁用');
    assert.ok(Array.from(t.card().querySelectorAll('button:not([data-review-open])')).every((b: any) => b.disabled), '上一个/下一个一并禁用');
    assert.ok(t.requests.every(r => !r.request?.method || r.request.method === 'GET'), '只读核对，不多写');
  } finally { t.close(); }
});

it('目标页只报了进度（还没落终态）时，卡片不许自称已确认：测试通过 = 状态点仍是「待确认」', async () => {
  const t = mount();
  try {
    await waitFor(() => !t.ok().disabled, 3000, '可用性核对完成');
    t.setDescriptor({status: 'proposed', remaining: 1, accepted_count: 1});
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-progress', {detail: {proposal_id: 'p1', descriptor: {id: 'p1', status: 'proposed', can_accept: true, can_reject: true, remaining: 1, accepted_count: 1}}}));
    await waitFor(() => /已保存 1 项/.test(t.card().textContent), 3000, '进度刷新');
    assert.equal(t.tag().textContent, '待确认', '还有待确认项时状态点不许变「已确认」');
    assert.equal(t.card().classList.contains('resolved'), false);
  } finally { t.close(); }
});

it('回执失败/结果未知时如实显示，不许乐观更新：测试通过 = 卡片不出现「已确认」、按钮可重试', async () => {
  for (const result of [null, {id: 'p1', status: 'unknown', remaining: 0}, {id: 'p1', status: 'proposed', remaining: 1}]) {
    const t = mount({controller: {id: 'p1', acceptRemaining: async () => result}});
    try {
      await waitFor(() => !t.ok().disabled, 3000, '可用性核对完成');
      t.ok().click();
      await waitFor(() => /保留|待核实/.test(t.card().textContent), 3000, '失败/未知后如实提示');
      assert.equal(t.card().classList.contains('resolved'), false, '失败不许落定为终态');
      assert.doesNotMatch(t.card().textContent, /已确认/, '失败时不许显示「已确认」');
      assert.equal(t.tag().textContent, '待确认', '状态点保持「待确认」');
      assert.equal(t.ok().disabled, false, '按钮恢复可点，允许重试');
    } finally { t.close(); }
  }
});
