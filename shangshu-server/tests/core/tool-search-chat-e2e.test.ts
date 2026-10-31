// PKG-018-T05：A08／A10／A12 —— 撤权后旧编号失效、歧义不猜、整链答案有真回执。
//
// 判据（行为，不是源码字符串命中）：
// · A08 搜索到过、之后被撤权的动作，**旧编号**再拿来调必须被拒；**旧索引恢复不了权限**。
// · A10 同名/多义目标**返回候选**让人选（不替用户挑一个）；说不清的口径**零命中明说**，不编规则。
// · A12 真实聊天链：搜索 → 按编号调用公共统计 → 回答；**最终模型请求里**带着真回执的数字，
//   答案基于这份回执（不是模型自己数的）。
//
// ⚠️ 这里的「真回执」是 2026-10-21 在隔离栈 shangshu-pkg018 上**现场跑出来**的一份
// 公共统计回执（126 行受管记录、5 位负责人、金额合计 13450.5），不是手编的假数据。
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { runAgentLoop, type ChatToolDef, type ChatToolExecutor } from '../../src/core/chat.ts';
import { buildActionIndex, navigationToolSpecs, resolveAuthorizedAction, searchActions } from '../../src/core/tool-search.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** 现场抓取的一份真实公共统计回执（platform.object.aggregate 的真实输出形状）。 */
const REAL_AGGREGATE_RECEIPT = {
  receipt: {
    version: 1,
    query_id: 'e2bd07f0ee2e',
    target: {
      object_id: 'com.shangshu.app.61845056b8e84f15bbdfee786e590c01.object.cd250a7db20f8e2acaecc695bbba968b',
      name: '回执夹具',
      domain_id: 'com.shangshu.app.61845056b8e84f15bbdfee786e590c01',
    },
    counts: { matched_total: 126, returned_rows: 126, exact: true },
    completeness: { details_complete: true, detail_rows: 126, matched_rows: 126, aggregate_complete: true },
    criteria: { filters: {}, search: '', sort: '', direction: '', counting: 'row', page: null,
      page_length: null, group_by: 'owner_name', distinct_field: 'owner_name', sum_field: 'amount' },
    scope: { authorized: true, record_scope: 'active' },
    time: { queried_at: '2026-10-21 19:12:24.909041' },
    exceptions: [],
  },
  metrics: { count_rows: 126, count_distinct_owner_name: 5, sum_amount: '13450.5' },
  groups: [
    { group: '负责人0', metrics: { count_rows: 26, count_distinct_owner_name: 1, sum_amount: '2215.5' } },
    { group: '负责人1', metrics: { count_rows: 25, count_distinct_owner_name: 1, sum_amount: '2415.0' } },
    { group: '负责人2', metrics: { count_rows: 25, count_distinct_owner_name: 1, sum_amount: '2677.5' } },
    { group: '负责人3', metrics: { count_rows: 25, count_distinct_owner_name: 1, sum_amount: '2940.0' } },
    { group: '负责人4', metrics: { count_rows: 25, count_distinct_owner_name: 1, sum_amount: '2902.0' } },
  ],
};

/** 当前身份**已授权**的动作目录（真实形状：id/version/effect/input_schema）。 */
const catalog: any[] = [
  { id: 'platform.object.query', version: '1.1.0', title: '查询业务对象', purpose: '按条件查受管记录',
    effect: 'read', executable: true,
    input_schema: { type: 'object', additionalProperties: false, required: ['object_id'],
      properties: { object_id: { type: 'string' }, filters: { type: 'object' } } } },
  { id: 'platform.object.aggregate', version: '1.0.0', title: '统计业务对象',
    purpose: '行数／去重计数／求和，可按一个字段分组', effect: 'read', executable: true,
    input_schema: { type: 'object', additionalProperties: false, required: ['object_id'],
      properties: { object_id: { type: 'string' }, metrics: { type: 'array' } } } },
  { id: 'mail.save_draft', version: '1.5.0', title: '保存邮件草稿', purpose: '把邮件存成草稿',
    effect: 'write', confirmation_policy: 'required', executable: true,
    input_schema: { type: 'object', required: ['subject', 'body'],
      properties: { subject: { type: 'string' }, body: { type: 'string' } } } },
];

/** 桥接层同款：按**当前**已授权目录解析编号（搜索不授权，调用时现判）。 */
function currentCatalog(actions: any[]) {
  return new Map(buildActionIndex(actions).map(entry => [entry.action_id, entry]));
}

// ---------- A08：撤权后旧编号失效、旧索引恢复不了权限 ----------
it('A08 撤权后：搜不到、旧编号调不动，旧索引也恢复不了权限', () => {
  const before = buildActionIndex(catalog);
  const found = searchActions(before, '统计受管记录');
  assert.equal(found.candidates[0].action_id, 'platform.object.aggregate', '撤权前搜得到');
  // 撤权：当前目录里这个动作没了（目录是**当前身份**授权的投影）
  const revoked = catalog.filter(action => action.id !== 'platform.object.aggregate');
  const after = currentCatalog(revoked);
  const revokedHits = searchActions(buildActionIndex(revoked), '统计受管记录');
  assert.equal(revokedHits.candidates.some(candidate => candidate.action_id === 'platform.object.aggregate'),
    false, '撤权后不该再被搜出来');
  // ⚠️ 不要求「整条查询零命中」：词面相近的**别的**动作仍可能被模糊命中（可解释排序，不是缺陷）；
  //   A08 要钉的是「**被撤权的那个**不再出现，且旧编号调不动」。
  // 模型拿着**撤权前**的旧编号来调 ⇒ 必须被拒
  assert.throws(() => resolveAuthorizedAction(after, 'platform.object.aggregate'),
    /不在当前授权工具目录内/, '旧编号必须被拒');
  // 旧索引（撤权前那份）也不能用来恢复权限
  const stale = new Map(before.map(entry => [entry.action_id, entry]));
  assert.equal(stale.has('platform.object.aggregate'), true, '旧索引里确实还有它');
  assert.throws(() => resolveAuthorizedAction(after, 'platform.object.aggregate'),
    /不在当前授权工具目录内/, '旧索引不得恢复权限');
});

// ---------- A10：同名/多义返回候选；说不清的口径不编规则 ----------
it('A10 同名目标返回候选不替人挑；说不清的口径零命中明说，不编规则', () => {
  const twin = [...catalog, { id: 'platform.object.aggregate.v2', version: '1.0.0',
    title: '统计业务对象', purpose: '行数／去重计数／求和，可按一个字段分组',
    effect: 'read', executable: true, input_schema: { type: 'object' } }];
  const found = searchActions(buildActionIndex(twin), '统计业务对象');
  const ids = found.candidates.map(candidate => candidate.action_id);
  assert.ok(ids.includes('platform.object.aggregate'), '原动作在候选里');
  assert.ok(ids.includes('platform.object.aggregate.v2'), '同名动作也在候选里（不替人挑）');
  assert.ok(found.candidates.length >= 2);
  // 口径不明的说法：零命中**明说**，不编「完成率」这类不存在的规则
  const miss = searchActions(buildActionIndex(twin), '按什么算完成');
  assert.equal(miss.zero_hit, true, '说不清就不命中');
  assert.deepEqual(miss.candidates, []);
  assert.ok(miss.suggestions.length > 0 && miss.suggestions.length <= 3, '给有限修正建议');
  assert.doesNotMatch(JSON.stringify(miss), /完成率|完成度/, '不许编口径');
});

// ---------- A12：整链 —— 聊天→搜索→按编号调用公共统计→回答 ----------
it('A12 整链：搜索→调用公共统计→回答，最终请求里带着真回执的数字', async () => {
  const requests: any[] = [];
  let turn = 0;
  globalThis.fetch = (async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    const step = turn++;
    const delta = step === 0
      ? { tool_calls: [{ index: 0, id: 'call-0', function: { name: 'platform_action_search',
          arguments: JSON.stringify({ query: '统计受管记录' }) } }] }
      : step === 1
      ? { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'platform_action_call',
          arguments: JSON.stringify({ action_id: 'platform.object.aggregate',
            payload: { object_id: REAL_AGGREGATE_RECEIPT.receipt.target.object_id,
              metrics: [{ op: 'count_rows' }, { op: 'count_distinct', field: 'owner_name' },
                        { op: 'sum', field: 'amount' }] } }) } }] }
      : { content: '这份清单共 126 条记录，5 位负责人，金额合计 13450.5。' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  const authorized = currentCatalog(catalog);
  const executor: ChatToolExecutor = async (def, call) => {
    const payload = JSON.parse(call.function.arguments || '{}');
    try {
      if (def.name === 'platform_action_search') {
        const found = searchActions(buildActionIndex(catalog), String(payload.query ?? ''),
          { limit: payload.limit ? Number(payload.limit) : undefined });
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(found) };
      }
      if (def.name === 'platform_action_call') {
        const selected = resolveAuthorizedAction(authorized, payload.action_id);
        if (selected.action_id !== 'platform.object.aggregate') {
          throw Error(`本轮只放通统计动作，收到 ${selected.action_id}`);
        }
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(REAL_AGGREGATE_RECEIPT) };
      }
      throw Error('本轮不应调用其它工具');
    } catch (error) {
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: (error as Error).message }) };
    }
  };

  const toolDefs = navigationToolSpecs('按已读取schema提交action_id与payload对象') as unknown as ChatToolDef[];
  const store = { query: async () => [], insert: async (_l: string, _t: string, v: any) => v } as any;
  const ctx = { config: { llm: { provider: 'ollama', model: 'mock', base_url: 'http://127.0.0.1:19999/v1', api_key: '' } }, log: () => {} } as any;
  const result = await runAgentLoop(store, ctx, {
    conversationId: 'pkg018-a12-chain', userText: '这份清单有多少条、几位负责人、金额合计多少',
    toolDefs, toolExecutor: executor,
  });

  assert.ok(requests.length >= 3, '应有多轮请求（搜索→调用→回答）');
  const last = requests[requests.length - 1];
  const toolMessages = (last.messages || []).filter((m: any) => m.role === 'tool');
  assert.equal(toolMessages.length, 2, '最终请求里要同时有搜索结果与统计回执');
  assert.match(String(toolMessages[0].content), /platform\.object\.aggregate/, '模型先搜到了要用的动作');
  assert.match(String(toolMessages[1].content), /"matched_total":126/, '模型看到的是真回执的总量');
  assert.match(String(toolMessages[1].content), /"sum_amount":"13450\.5"/, '模型看到的是真回执的合计');
  assert.match(String(result.reply), /126/, '答案里的数字来自回执');
  assert.doesNotMatch(String(result.reply), /大约|大概|估计/, '不许用猜的口径回答');
});
