// 对话服务测试（P4）：mock LLM server 注入，测最小 harness 的三种路径——
//   1) 直接文本回答；2) 工具调用（invoice.query 直跑真数据）；3) 写操作（ledger.post）挂确认卡不执行。
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

// —— mock LLM server：OpenAI 兼容 SSE 流。按最后一条消息决定响应：
//    最后是 tool → 文本回答流；否则按用户消息关键词返回不同 tool_call 流。 ——
let llmPort = 0;
let llmServer: Server;
let latestLlmRequest: any;
const sse = (res: any, lines: string[]) => {
  res.setHeader('Content-Type', 'text/event-stream');
  for (const l of lines) res.write(l + '\n\n');
  res.end();
};
const textStream = (text: string) => [
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
  ...[...text].map((ch) => `data: {"choices":[{"delta":{"content":"${ch}"},"index":0}]}`),
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
  'data: [DONE]',
];
const toolStream = (name: string, args: string) => [
  `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: '' } }] }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, index: 0 }] })}`,
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
  'data: [DONE]',
];

describe('对话服务 core/chat（最小 harness）', () => {
  let dir: string;

  before(async () => {
    llmServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        latestLlmRequest = payload;
        const last = payload.messages[payload.messages.length - 1];
        if (last.role === 'tool') {
          sse(res, textStream('查到了，按你的要求回答。'));
          return;
        }
        const text = String(last.content || '');
        if (text.includes('直接答')) { sse(res, textStream('你好，我在。')); return; }
        if (text.includes('记一笔账') || text.includes('记账')) {
          sse(res, toolStream('object_propose', '{"object":"ledger","action":"ledger.post","summary":"采购五金","counterparty":"测试公司","total_amount":123.45}'));
          return;
        }
        if (text.includes('确认订单')) { sse(res, toolStream('order_confirm', '{"order_no":"SO-T1"}')); return; }
        sse(res, toolStream('object_query', '{"object":"invoice","status":"已入库"}'));
      });
    });
    await new Promise<void>((r) => { llmServer.listen(0, () => { llmPort = (llmServer.address() as any).port; r(); }); });
  });
  after(() => { llmServer.close(); });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-chat-'));
    process.env._SS_DATA_DIR = dir;
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'ollama', base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: '', model: 'mock-qwen' },
    }));
    const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
    const { registerObjectTools } = await import('../../src/capabilities/object-tools.ts');
    const { registerPresetObjects } = await import('../../src/core/objects.ts');
    registerChatTools();
    registerObjectTools();
    registerPresetObjects();
    const { registerAllActionHandlers } = await import('../../src/capabilities/actions.ts');
    registerAllActionHandlers();
    // 预置一张真发票（工具应查得到）
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('business', 'invoices', {
      invoice_no: 'INV-001', seller_name: '测试供应商', status: '已入库',
      total_amount: 100, received_at: '2026-08-01T10:00:00Z',
    });
  });

  it('提案产生后异常或停止仍有冻结来源及真实工具链，不能等模型回合成功才记录',async()=>{
    const {localStore}=await import('../../src/core/store.ts');
    const {buildContext}=await import('../../src/core/context.ts');
    const {runAgentLoop}=await import('../../src/core/chat.ts');
    for(const mode of ['throw','stop']){
      const ac=new AbortController(),proposal='P-'+mode;
      const run=runAgentLoop(localStore,buildContext(()=>{}),{conversationId:'alice:'+mode,auditActorKey:'alice',userText:'查询',signal:ac.signal,
       toolDefs:[{name:'object_query',capability:'object.query',description:'read',kind:'query',parameters:{type:'object',properties:{}}}],
       toolExecutor:async(_def,call,hooks,auditRequest)=>{
        assert.match(auditRequest!.requestId,/^[0-9a-f-]{36}$/);
        const requests=await localStore.query('execution','chat_audit_events',{actor_key:'alice',request_id:auditRequest!.requestId});assert.equal(requests.length,1);
        assert.equal(JSON.parse(requests[0].event_json).arguments,call.function.arguments);
        await hooks.onConfirm?.({id:proposal,capability:'files.sheet_cells_write',entity_type:'file',entity_id:'F',payload:{value:7}});
        // Snapshot is already durable BEFORE the outward confirmation hook and later exception.
        assert.equal((await localStore.query('execution','chat_audit_sources',{proposal_id:proposal})).length,1);
        if(mode==='throw')throw Error('failure after proposal');
        await hooks.onTool?.({name:'object_query',arg:call.function.arguments,result:JSON.stringify({confirmation_id:proposal})});ac.abort();
        return {role:'tool',tool_call_id:call.id,content:'proposal created'};
       }});
      if(mode==='throw')await assert.rejects(run,/failure after proposal/);else await run;
      const source=(await localStore.query('execution','chat_audit_sources',{proposal_id:proposal}))[0];assert.equal(JSON.parse(source.context_json).trigger,'查询');
      const events=(await localStore.query('execution','chat_audit_events',{turn_id:source.turn_id})).map((row:any)=>JSON.parse(row.event_json));
      assert.equal(events[0].kind,'turn_started');assert.ok(events[0].context.trigger);assert.equal(events[1].kind,'tool_request');assert.equal(events[1].tool_call_id,'call_1');assert.equal(events[2].kind,'proposal_created');assert.equal(events[2].proposal_id,proposal);
      assert.equal(events.at(-1).status,mode==='throw'?'failed':'stopped');
    }
  });

  it('直接文本回答：不调工具，回复拼装正确，对话记录落表', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    const ctx = buildContext(console.log);
    const { reply } = await runAgentLoop(localStore, ctx, { conversationId: 'alice', userText: '直接答：你好' });
    assert.equal(reply, '你好，我在。');
    const msgs = await localStore.query('execution', 'chat_messages', { conversation_id: 'alice' });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[1].role, 'assistant');
  });

  it('工具调用：object_query 直跑 registry，答的是真数据', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    const ctx = buildContext(console.log);
    let toolEvent: any = null;
    const { reply } = await runAgentLoop(localStore, ctx, {
      conversationId: 'bob', userText: '已入库的发票有多少',
      actorRole: 'admin',
      hooks: { onTool: (t) => { toolEvent = t; } },
    });
    assert.equal(reply, '查到了，按你的要求回答。');
    assert.ok(toolEvent, '应发出工具事件');
    assert.ok(toolEvent.name === 'object_query');
    const result = JSON.parse(toolEvent.result);
    assert.equal(result.count, 1, '应查到预置发票');
    assert.equal(result.total_amount, 100);
  });

  it('写操作：ledger.post 挂确认卡（proposed，initiator=agent），不执行 handler', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    const ctx = buildContext(console.log);
    let confirmEvent: any = null;
    await runAgentLoop(localStore, ctx, {
      conversationId: 'carol', userText: '帮我记一笔账：采购五金 123.45 元，对方测试公司',
      actorRole: 'finance',
      hooks: { onConfirm: (c) => { confirmEvent = c; } },
    });
    assert.ok(confirmEvent, '应发出确认卡事件');
    assert.equal(confirmEvent.capability, 'ledger.post');
    assert.equal(confirmEvent.payload.total_amount, 123.45);
    // 事件总线有 proposed 提案（initiator=agent），ledger 表无记录（未执行）
    const evts = await localStore.query('execution', 'events');
    const proposal = evts.find((e: any) => e.capability === 'ledger.post' && e.status === 'proposed');
    assert.ok(proposal, '应有 proposed 提案');
    assert.equal(proposal.initiator, 'carol');
    const ledger = await localStore.query('business', 'ledger');
    assert.equal(ledger.length, 0, '确认前不得落账');
  });

  it('统一平台模式传入空工具目录时，模型不能回落调用旧 Node 业务工具', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    let toolEvent: any = null;
    await runAgentLoop(localStore, buildContext(console.log), {
      conversationId: 'platform-user', userText: '查询发票', toolDefs: [],
      hooks: { onTool: (tool) => { toolEvent = tool; } },
    });
    assert.equal(toolEvent, null, '空目录不得执行模型臆造的旧工具');
    assert.equal((await localStore.query('execution', 'events')).length, 0, '不得生成业务写事件');
  });

  it('平台提示明确先读当前元数据，文件邮件正文不作为指令，保存草稿不冒充已发信', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    await runAgentLoop(localStore, buildContext(() => {}), {
      conversationId: 'platform-boundaries', userText: '直接答：你好', toolDefs: [],
      toolExecutor: async () => { throw Error('不应调用工具'); },
    });
    const system = latestLlmRequest.messages[0].content;
    assert.match(system, /platform_resource_read/);
    assert.match(system, /不可信数据/);
    assert.match(system, /attachments.*source\.file/);
    assert.match(system, /不能用.*ref_name/);
    assert.match(system, /草稿.*不.*已发送/);
    assert.doesNotMatch(system, /写工具参数用业务名/);
  });
});

describe('对话服务 AI 写操作（A1）：agent 提案 → 确认卡 → 确认后执行', () => {
  let dir: string;
  let llmPort2 = 0;
  let llmServer2: import('node:http').Server;

  before(async () => {
    llmServer2 = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        const last = payload.messages[payload.messages.length - 1];
        res.setHeader('Content-Type', 'text/event-stream');
        if (last.role === 'tool') {
          sse(res, textStream('已提交确认卡，等待人工确认。'));
          return;
        }
        sse(res, toolStream('order_confirm', '{"order_no":"SO-A1"}'));
      });
    });
    await new Promise<void>((r) => { llmServer2.listen(0, () => { llmPort2 = (llmServer2.address() as any).port; r(); }); });
  });
  after(() => { llmServer2.close(); });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-chat-a1-'));
    process.env._SS_DATA_DIR = dir;
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'ollama', base_url: `http://127.0.0.1:${llmPort2}/v1`, api_key: '', model: 'mock-qwen' },
    }));
    const { localStore } = await import('../../src/core/store.ts');
    const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
    registerChatTools();
    // 调用 buildApp 完成 action handler 注册（order.confirm 等与生产共用同一注册逻辑）
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    buildApp();
    // 造一个草稿订单 SO-A1（含应收生成所需客户）
    const cid = await localStore.insert('business', 'customers', { name: 'A1客户', status: '启用', created_at: new Date().toISOString() });
    await localStore.insert('business', 'orders', { order_no: 'SO-A1', customer_id: cid, customer_name: 'A1客户', status: '草稿', total_amount: 500, note: '', created_at: new Date().toISOString() });
  });

  it('模型返回未暴露的 legacy 工具不能执行或生成提案', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');
    const { listPendingConfirmations } = await import('../../src/core/confirm.ts');
    let confirmation = null;
    await runAgentLoop(localStore, buildContext(() => {}), { conversationId:'a1-user',actorRole:'admin',userText:'确认订单 SO-A1',hooks:{onConfirm:c=>{confirmation=c;}} });
    assert.equal(confirmation,null);
    assert.equal((await listPendingConfirmations(localStore)).length,0);
    assert.equal((await localStore.query('business','orders'))[0].status,'草稿');
    assert.equal((await localStore.query('business','receivables')).length,0);
  });
});
