// Goal Done 验收向：对话 mock LLM → object_query 查真数据 → object_propose 挂确认卡 → 确认落库
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { registerInvoiceCapabilities } from '../../src/capabilities/invoice.ts';
import { registerObjectTools } from '../../src/capabilities/object-tools.ts';
import { registerAllActionHandlers } from '../../src/capabilities/actions.ts';
import { registerPresetObjects } from '../../src/core/objects.ts';
import { registerChatTools } from '../../src/capabilities/chat-tools.ts';
import { resolveConfirmation } from '../../src/core/confirm.ts';

let llmPort = 0;
let llmServer: Server;
let turn = 0;

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

describe('小微对话 E2E（Goal Done）', () => {
  before(async () => {
    llmServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        const last = payload.messages[payload.messages.length - 1];
        if (last.role === 'tool') {
          turn++;
          if (turn === 1) {
            sse(res, toolStream('object_propose', JSON.stringify({
              object: 'invoice', action: 'invoice.approve', invoice_id: 'inv-chat-1', invoice_no: 'CHAT-001',
            })));
            return;
          }
          sse(res, textStream('已提交确认卡，请在右侧确认。'));
          return;
        }
        sse(res, toolStream('object_query', JSON.stringify({ object: 'invoice', status: '待审' })));
      });
    });
    await new Promise<void>((r) => {
      llmServer.listen(0, () => { llmPort = (llmServer.address() as any).port; r(); });
    });
  });
  after(() => { llmServer.close(); });

  beforeEach(() => {
    turn = 0;
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-sme-chat-'));
    writeFileSync(join(process.env._SS_DATA_DIR, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'ollama', base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: '', model: 'mock' },
    }));
    registerInvoiceCapabilities();
    registerObjectTools();
    registerAllActionHandlers();
    registerPresetObjects();
    registerChatTools();
  });

  it('自然语言查待审 → 提案入库 → 确认 → 事件留痕', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { runAgentLoop } = await import('../../src/core/chat.ts');

    await localStore.insert('business', 'invoices', {
      id: 'inv-chat-1', invoice_no: 'CHAT-001', seller_name: '对话测试销方', status: '待审',
      total_amount: 200, invoice_direction: '进项', received_at: '2026-08-24T08:00:00Z',
    });

    const ctx = buildContext(() => {});
    let queryTool: any = null;
    let confirmEvent: any = null;

    await runAgentLoop(localStore, ctx, {
      conversationId: 'fang',
      actorRole: 'finance',
      userText: '有几张待审发票？帮我把 CHAT-001 审核入库',
      hooks: {
        onTool: (t) => { if (t.name === 'object_query') queryTool = t; },
        onConfirm: (c) => { confirmEvent = c; },
      },
    });

    assert.ok(queryTool, '应先 object_query');
    const q = JSON.parse(queryTool.result);
    assert.equal(q.count, 1);
    assert.ok(confirmEvent, '应挂确认卡');
    assert.equal(confirmEvent.capability, 'invoice.approve');

    await resolveConfirmation(localStore, confirmEvent.id, 'confirmed', { id: '王芳', role: 'admin', kind: 'human', channel: 'test' });

    const inv = (await localStore.query('business', 'invoices', { id: 'inv-chat-1' }))[0] as any;
    assert.equal(inv.status, '已入库');

    const events = await localStore.query('execution', 'events');
    assert.ok(events.some((e: any) => e.capability === 'invoice.approve' && e.status === 'confirmed'));
    assert.ok(events.some((e: any) => e.initiator === 'fang' && e.status === 'proposed'));
  });
});
