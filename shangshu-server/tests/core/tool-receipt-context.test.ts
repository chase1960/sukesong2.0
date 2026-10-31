// PKG-018-T01／T04：查询回执必须**进入模型实际收到的工具消息**。
//
// 判据的核心（计划原文）：「126条匹配记录只返回5条时，**实际发给模型的内容**仍明确
// 总量126、明细5条和明细未完整返回；查询失败绝不能变成『0条』。」
//
// 这里**捕获最终模型请求**（不是查 UI／日志）——只有请求里的东西，模型才真的见过。
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { runAgentLoop, type ChatToolDef, type ChatToolExecutor } from '../../src/core/chat.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const tools: ChatToolDef[] = [
  { name: 'query_records', kind: 'query', parameters: {}, description: '查询受管记录' },
];

/** 造一份公共查询的真实形状（core 的 query_records 回执结构）。 */
function coreResult(overrides: Record<string, unknown> = {}) {
  return {
    object_id: 'test.receipt.todo',
    object: { id: 'test.receipt.todo', name: '测试待办' },
    domain_id: 'com.shangshu.core',
    rows: [{ name: 'r1', description: '第一条' }, { name: 'r2' }, { name: 'r3' },
           { name: 'r4' }, { name: 'r5' }],
    total: 126,
    page: 1,
    page_length: 5,
    receipt: {
      version: 1,
      query_id: 'a1b2c3d4e5f6',
      target: { object_id: 'test.receipt.todo', name: '测试待办', domain_id: 'com.shangshu.core' },
      counts: { matched_total: 126, returned_rows: 5, exact: true },
      completeness: { details_complete: false, detail_rows: 5, matched_rows: 126, aggregate_complete: null },
      criteria: { filters: { status: 'Open' }, search: '', sort: 'description', direction: 'asc',
                   counting: 'row', page: 1, page_length: 5 },
      scope: { authorized: true, record_scope: 'active' },
      time: { queried_at: '2026-10-21 20:00:00' },
      exceptions: [],
    },
    ...overrides,
  };
}

/** 跑一轮对话：第一次模型要工具，第二次模型给答案；把**每次请求**都留下来。 */
async function capture(executor: ChatToolExecutor, finalText = '共 126 条，本次只拿到 5 条明细。') {
  const requests: any[] = [];
  let turn = 0;
  globalThis.fetch = (async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    const delta = turn++ === 0
      ? { tool_calls: [{ index: 0, id: 'call-0', function: { name: 'query_records', arguments: '{}' } }] }
      : { content: finalText };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const stored: any[] = [];
  const store = { query: async () => [], insert: async (_l: string, _t: string, v: any) => { stored.push(v); return v; } } as any;
  const ctx = { config: { llm: { provider: 'ollama', model: 'mock', base_url: 'http://127.0.0.1:19999/v1', api_key: '' } }, log: () => {} } as any;
  const result = await runAgentLoop(store, ctx, {
    conversationId: 'receipt-context-test', userText: '查一下待处理的有多少',
    toolDefs: tools, toolExecutor: executor,
  });
  return { requests, result };
}

it('126条只回5条时，模型实际收到的工具消息里写明总量126、返回5条、明细未完整', async () => {
  const { requests } = await capture(async (_def, call) => ({
    role: 'tool', tool_call_id: call.id, content: JSON.stringify(coreResult()),
  }));
  assert.ok(requests.length >= 2, '应该有一次带工具结果的模型请求');
  const second = requests[requests.length - 1];
  const toolMessage = (second.messages || []).find((m: any) => m.role === 'tool');
  assert.ok(toolMessage, '最终模型请求里必须有 role=tool 的消息');
  const content = String(toolMessage.content);
  assert.match(content, /"matched_total":126/, '模型必须看到匹配总数 126');
  assert.match(content, /"returned_rows":5/, '模型必须看到这次返回 5 条');
  assert.match(content, /"details_complete":false/, '模型必须看到明细没有完整返回');
  assert.match(content, /"exact":true/, '模型必须看到计数是精确的');
});

it('查询失败是错误，不是 0 条：工具报错时模型收到的是错误而不是空结果', async () => {
  const { requests } = await capture(async (_def, call) => ({
    role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '查询失败：字段类型不支持' }),
  }));
  const second = requests[requests.length - 1];
  const toolMessage = (second.messages || []).find((m: any) => m.role === 'tool');
  assert.ok(toolMessage, '最终模型请求里必须有 role=tool 的消息');
  const content = String(toolMessage.content);
  assert.match(content, /查询失败/, '失败原因要进模型');
  assert.doesNotMatch(content, /"total":0/, '失败不得变成 0 条');
});
