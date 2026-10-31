import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentLoop, type ChatToolDef, type ChatToolExecutor } from '../../src/core/chat.ts';
import { appendChatAuditEvent, readChatAuditTrace, snapshotChatContext } from '../../src/core/chat-audit-context.ts';
import { SqliteStore } from '../../src/core/storage/sqlite.ts';

const nav: ChatToolDef = {
  name: 'platform_action_call', capability: 'platform.action.call', kind: 'query', description: '公共动作',
  parameters: { type: 'object', additionalProperties: false, required: ['read_ref', 'changes'],
    properties: { read_ref: { type: 'string' }, changes: { type: 'array' } } },
};
const actualAction = 'files.sheet_cells_write';

async function fixture(run: (store: SqliteStore) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'ss-harness-audit-'));
  const store = new SqliteStore(join(directory, 'state.sqlite'));
  try { await run(store); } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
}

for (const engine of ['classic', 'pi'] as const) {
  test(`${engine}: read_ref的真实动作与同一个服务器request_id进入请求审计及执行器`, () => fixture(async store => {
    const fetch = globalThis.fetch;
    const argumentsValue = { read_ref: 'read-in-this-bridge', changes: [{ row_id: 'r1', header: '审核', value: false }] };
    let calls = 0, executed = 0, executedRequest = '';
    const captured: any[] = [];
    globalThis.fetch = (async (_url: any, options: any) => {
      captured.push(JSON.parse(options.body));
      const delta = ++calls === 1 ? { tool_calls: [{ index: 0, id: 'one-call', type: 'function',
        function: { name: nav.name, arguments: JSON.stringify(argumentsValue) } }] } : { content: '收到。' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const execute: ChatToolExecutor = Object.assign(async (_def: ChatToolDef, call: any, _hooks: any, request: any) => {
      executed++; executedRequest = request?.requestId || '';
      assert.equal(JSON.parse(call.function.arguments).changes[0].value, false);
      return { role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' };
    }, { resolveAuditAction: (_def: ChatToolDef, call: any) => {
      const input = JSON.parse(call.function.arguments);
      return input.read_ref === 'read-in-this-bridge' ? actualAction : undefined;
    } });
    try {
      await runAgentLoop(store, { config: { llm: { provider: 'deepseek', model: 'mock', base_url: 'http://127.0.0.1:19999/v1', api_key: '' } }, log: () => {} } as any,
        { conversationId: 'alice:chat', auditActorKey: 'alice', userText: '填写这一格', engine, toolDefs: [nav], toolExecutor: execute });
      const rows = await store.query('execution', 'chat_audit_events');
      const events = rows.map(row => JSON.parse(String(row.event_json)));
      const request = events.find(event => event.kind === 'tool_request');
      const response = events.find(event => event.kind === 'tool_response');
      assert.equal(executed, 1);
      assert.equal(request.resolved_action_id, actualAction, '真实动作必须来自执行器私有read_ref，不是模型参数');
      assert.equal(request.action_id, nav.capability, '保留原工具能力身份');
      assert.deepEqual(JSON.parse(request.arguments), argumentsValue, '保留原模型请求');
      assert.ok(executedRequest, '执行器须收到服务器请求号');
      assert.equal(executedRequest, request.request_id, '不能在Pi执行时重新生成另一个幂等键');
      assert.equal(response.request_id, request.request_id);
      const restored: any = await readChatAuditTrace('alice', { request_id: request.request_id }, {
        store, authorize: async () => ({ collaboration_key: 'alice' }), proposal: async () => ({}),
        trace: async () => ({ status: 'linked', actor_user: 'alice', request_id: request.request_id, action_id: actualAction }),
      });
      assert.equal(restored.status, 'linked');
      assert.equal(restored.context.trigger, '填写这一格');
      const prompt = captured[0].messages[0].content;
      assert.match(prompt, /field_options/);
      assert.match(prompt, /read_ref/);
      assert.match(prompt, /可选值.*是否允许自定义.*是否能留空/);
    } finally { globalThis.fetch = fetch; }
  }));

  test(`${engine}: resolver故障不能执行动作或记录成功回执`, () => fixture(async store => {
    const fetch = globalThis.fetch;
    let calls = 0, executed = false;
    globalThis.fetch = (async () => {
      const delta = ++calls === 1 ? { tool_calls: [{ index: 0, id: 'bad-call', type: 'function',
        function: { name: nav.name, arguments: '{"read_ref":"bad","changes":[]}' } }] } : { content: '未执行。' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const execute: ChatToolExecutor = Object.assign(async () => {
      executed = true; return { role: 'tool' as const, tool_call_id: 'bad-call', content: '{"ok":true}' };
    }, { resolveAuditAction: () => { throw Error('trusted reference unavailable'); } });
    try {
      await assert.rejects(runAgentLoop(store, { config: { llm: { provider: 'deepseek', model: 'mock', base_url: 'http://127.0.0.1:19999/v1', api_key: '' } }, log: () => {} } as any,
        { conversationId: 'alice:chat', auditActorKey: 'alice', userText: '填值', engine, toolDefs: [nav], toolExecutor: execute }), /trusted reference unavailable/);
      assert.equal(executed, false);
      const events = (await store.query('execution', 'chat_audit_events')).map(row => JSON.parse(String(row.event_json)));
      assert.ok(!events.some(event => event.kind === 'tool_response'));
      assert.equal(events.find(event => event.kind === 'turn_finished').status, 'failed');
    } finally { globalThis.fetch = fetch; }
  }));
}

test('审计恢复仅信任持久resolved_action_id，原始参数内伪造字段不能覆盖真实动作', () => fixture(async store => {
  const deps = (requestId: string, actionId: string) => ({ store,
    authorize: async () => ({ collaboration_key: 'alice' }), proposal: async () => ({}),
    trace: async () => ({ status: 'linked', actor_user: 'alice', request_id: requestId, action_id: actionId }),
  });
  await appendChatAuditEvent(store, 'alice', 'alice:chat', 'turn', {
    kind: 'tool_request', request_id: 'resolved', action_id: nav.capability, resolved_action_id: actualAction,
    tool: nav.name, arguments: JSON.stringify({ read_ref: 'read-1', action_id: 'mail.send', resolved_action_id: 'file.delete' }),
    context: snapshotChatContext([], '原调用'),
  });
  assert.equal((await readChatAuditTrace('alice', { request_id: 'resolved' }, deps('resolved', actualAction))).status, 'linked');
  assert.equal((await readChatAuditTrace('alice', { request_id: 'resolved' }, deps('resolved', 'mail.send'))).status, 'not_linked');
  assert.equal((await readChatAuditTrace('alice', { request_id: 'resolved' }, deps('resolved', 'file.delete'))).status, 'not_linked');
  await appendChatAuditEvent(store, 'alice', 'alice:chat', 'turn', {
    kind: 'tool_request', request_id: 'forged', action_id: nav.capability, tool: nav.name,
    arguments: JSON.stringify({ read_ref: 'read-1', resolved_action_id: actualAction }), context: snapshotChatContext([], '伪造'),
  });
  assert.equal((await readChatAuditTrace('alice', { request_id: 'forged' }, deps('forged', actualAction))).status, 'not_linked');
}));

test('旧导航action_id以及专用动作仍按原审计绑定恢复', () => fixture(async store => {
  for (const [id, tool, action, args] of [
    ['nav', nav.name, nav.capability, { action_id: 'mail.draft', payload: { subject: '原业务参数' } }],
    ['direct', 'platform_mail_draft', 'mail.draft', { subject: '原业务参数' }],
  ] as const) {
    await appendChatAuditEvent(store, 'alice', 'alice:chat', 'turn', { kind: 'tool_request', request_id: id,
      action_id: action, tool, arguments: JSON.stringify(args), context: snapshotChatContext([], '原调用') });
    const deps = { store, authorize: async () => ({ collaboration_key: 'alice' }), proposal: async () => ({}),
      trace: async () => ({ status: 'linked', actor_user: 'alice', request_id: id, action_id: 'mail.draft' }) };
    assert.equal((await readChatAuditTrace('alice', { request_id: id }, deps)).status, 'linked');
    assert.equal((await readChatAuditTrace('alice', { request_id: id }, { ...deps,
      trace: async () => ({ status: 'linked', actor_user: 'alice', request_id: id, action_id: 'mail.send' }) })).status, 'not_linked');
  }
}));
