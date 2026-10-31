// 判据：**工具结果回灌闸**（FIX-02「12,270,898 字节的大请求」那一类真事故的通用件）。
//
// 测试通过 = 什么成立：
//   ① 工具结果超过回灌上限时，**进模型上下文的那一份**被截断，并在包里明说
//      「共多少、这是第几页、接着读第几页、哪些被砍了」；
//   ② 「匹配总数 ≠ 本页行数」这个口径没被搞错（两个数分别是什么，写在包里）；
//   ③ 没超上限的结果**原样透传**（一个字都不许改）；
//   ④ 审计/记录路径**一个字没变**（工具自己的返回、审计事件仍是全文）；
//   ⑤ **所有工具**都过这道闸（不只表格读：邮件长正文、纯文本回执同样被处理）。
//
// 口径提醒：**匹配总数 ≠ 本页行数**。本文件里 total_rows=12270（工具自报的总数）、
// rows.length=500（这一页返回的行数）——两个数必须分别出现在包里，谁也不许冒充谁。
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { runAgentLoop, type ChatToolDef, type ChatToolExecutor } from '../../src/core/chat.ts';
import { boundToolResult, DEFAULT_TOOL_RESULT_MAX_CHARS } from '../../src/core/tool-result-bounds.ts';
import { buildContext } from '../../src/core/context.ts';
import { localStore } from '../../src/core/store.ts';

const LIMIT = DEFAULT_TOOL_RESULT_MAX_CHARS;

const tools: ChatToolDef[] = [
  { name: 'read_record', kind: 'query', parameters: { type: 'object', properties: {} }, description: '读取记录' },
];

// 一页 500 行的表读结果 + 工具自报的总数 12270（这两个数不是一回事）。
function sheetResult() {
  return {
    table: 'TBL-1', sheet: 'Sheet1', headers: ['客户', '金额'],
    rows: Array.from({ length: 500 }, (_, i) => ({ row_id: 'r-' + i, row_index: i + 2, values: { 客户: '客户' + i, 金额: i * 100 } })),
    total_rows: 12270, search: null, writable: true,
  };
}

// 平台执行器的形状：审计拿全文，回灌拿同一份全文（截断只发生在回灌前那一层）。
function platformLikeExecutor(result: unknown, call: any): ChatToolExecutor {
  return async (_def, tool, hooks) => {
    const content = JSON.stringify(result);
    await hooks.onTool?.({ name: 'read_record', arg: tool.function.arguments, result: content.slice(0, 800), auditResult: content });
    return { role: 'tool', tool_call_id: tool.id, content };
  };
}

// 经典循环（chat.ts）：模型第一轮要工具，第二轮看结果回话。
async function runClassic(executor: ChatToolExecutor, args: unknown = { page: 1, page_length: 200 }) {
  const requests: any[] = [];
  const stored: any[] = [];
  const script = [
    { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_record', arguments: JSON.stringify(args) } }] },
    { content: '看完了。' },
  ];
  let count = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    const delta = script[Math.min(count++, script.length - 1)];
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const store = {
      guarantees: { appendOnlyAudit: true },
      query: async () => [],
      insert: async (_layer: string, _table: string, value: any) => { stored.push(value); return value; },
    } as any;
    const ctx = { config: { llm: { provider: 'ollama', model: 'mock', base_url: 'http://127.0.0.1:19999/v1', api_key: '' } }, log: () => {} } as any;
    await runAgentLoop(store, ctx, {
      conversationId: 'isolated-agent-test', userText: '读一下这张表', toolDefs: tools,
      toolExecutor: executor, auditActorKey: 'isolated-agent-test',
    });
  } finally { globalThis.fetch = original; }
  const toolMessage = requests[1]?.messages?.find((m: any) => m.role === 'tool');
  return { toolMessage, requests, stored };
}

// ① 超上限 ⇒ 截断 + 明说（共多少、第几页、接着读第几页、哪些被砍）。
it('表格读结果超上限 ⇒ 回灌的那一份被截断，并明说总数/页码/接着读第几页/砍了哪些', async () => {
  const { toolMessage } = await runClassic(platformLikeExecutor(sheetResult()));
  assert.ok(toolMessage, '模型第二轮必须收到工具结果');
  assert.ok(toolMessage.content.length <= LIMIT, `回灌内容必须封顶（实际 ${toolMessage.content.length} > ${LIMIT}）`);
  const parsed = JSON.parse(toolMessage.content);
  assert.ok(parsed.rows.length < 500, '超上限的行必须被砍掉');
  assert.equal(parsed._truncation.truncated, true);
  assert.equal(parsed._truncation.total_count, 12270, '包里必须说清工具自报的总数');
  assert.equal(parsed._truncation.page_count, 500, '包里必须说清这一页返回了多少行');
  assert.equal(parsed._truncation.page, 1, '包里必须说清这是第几页');
  assert.equal(parsed._truncation.total_pages, 62, '包里必须说清总共几页');
  assert.equal(parsed._truncation.dropped_count, 500 - parsed.rows.length, '必须说清砍掉了几行');
  assert.match(parsed._truncation.next, /page=2/, '必须说清接着读第几页');
  assert.match(parsed._truncation.message, /截断/);
});

// ② 「匹配总数 ≠ 本页行数」的口径没被搞错。
it('匹配总数与本页行数分别写清，谁也不冒充谁', async () => {
  const { toolMessage } = await runClassic(platformLikeExecutor(sheetResult()));
  const parsed = JSON.parse(toolMessage.content);
  assert.notEqual(parsed._truncation.total_count, parsed._truncation.page_count);
  assert.equal(parsed._truncation.total_count, 12270);
  assert.equal(parsed._truncation.page_count, 500);
  assert.match(parsed._truncation.counts_note, /匹配总数/);
  assert.match(parsed._truncation.counts_note, /本页/);
});

// ③ 没超上限 ⇒ 原样透传（不许把正常结果也砍了）。
it('没超上限的结果原样透传，一个字都不许改', async () => {
  const small = { ok: true, rows: [{ row_id: 'r-1', values: { 客户: '甲' } }], total_rows: 1 };
  const { toolMessage } = await runClassic(platformLikeExecutor(small));
  assert.equal(toolMessage.content, JSON.stringify(small));
  assert.equal(JSON.parse(toolMessage.content)._truncation, undefined);
});

// ④ 审计/记录路径不受影响：审计事件里仍是全文。
it('审计事件里的工具结果仍是全文（截断只发生在回灌给模型之前）', async () => {
  const { stored } = await runClassic(platformLikeExecutor(sheetResult()));
  const events = stored.map(v => JSON.parse(String(v.event_json || '{}'))).filter(e => e.kind === 'tool_response' || e.kind === 'tool_result');
  assert.ok(events.length >= 1, '必须有工具结果审计事件');
  for (const event of events) {
    assert.ok(String(event.result).length > LIMIT, '审计里必须是全文，不能是截断后的');
    assert.match(String(event.result), /r-499/, '审计里必须还有最后一行的内容');
  }
});

// ⑤ 所有工具都过这道闸：邮件长正文（另一个域的读口）同样被处理，且不单开特例。
it('邮件长正文走同一道闸（不是只给表格读打补丁）', async () => {
  const mail = { mail: 'MAIL-1', subject: '很长的信', body: 'x'.repeat(100000) };
  const { toolMessage } = await runClassic(platformLikeExecutor(mail));
  assert.ok(toolMessage.content.length <= LIMIT);
  const parsed = JSON.parse(toolMessage.content);
  assert.ok(parsed.body.length < 100000, '超长的正文尾部必须被砍');
  assert.equal(parsed._truncation.dropped_part, 'text_tail');
  assert.equal(parsed._truncation.field, 'body');
  assert.match(parsed._truncation.next, /拿不到/, '没有分页参数时必须明说拿不到');
});

it('纯文本回执（不是 JSON）同样被封顶并说明白', async () => {
  const { toolMessage } = await runClassic(async (_def, tool) => ({ role: 'tool', tool_call_id: tool.id, content: 'a'.repeat(50000) }));
  assert.ok(toolMessage.content.length <= LIMIT);
  assert.match(toolMessage.content, /截断/);
});

// 单元层：闸本身的边界行为。
it('闸：顶层数组也能被有界处理并说明白', () => {
  const bound = boundToolResult(JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, note: 'x'.repeat(20) }))));
  assert.equal(bound.truncated, true);
  assert.ok(bound.content.length <= LIMIT);
  assert.match(bound.content, /截断/);
});

it('闸：没超上限时原样返回（同一字符串）', () => {
  const raw = JSON.stringify({ ok: true, n: 3 });
  const bound = boundToolResult(raw);
  assert.equal(bound.truncated, false);
  assert.equal(bound.content, raw);
});

// Pi 编排路径同样过这道闸（两个编排器都走同一个闸）。
it('Pi 编排路径同样过这道闸', async () => {
  const requests: any[] = [];
  let respond: (body: any) => any = () => ({ content: '好' });
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.setHeader('Content-Type', 'text/event-stream');
      const delta = respond(parsed);
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { (server.address() as any).port; resolve(); }));
  const port = (server.address() as any).port;
  process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-tool-bounds-'));
  writeFileSync(join(process.env._SS_DATA_DIR, 'runtime_config.json'), JSON.stringify({ llm: { provider: 'deepseek', base_url: `http://127.0.0.1:${port}/v1`, api_key: '', model: 'test' } }));
  respond = body => body.messages?.some((m: any) => m.role === 'tool')
    ? { content: '看完了。' }
    : { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_record', arguments: JSON.stringify({ page: 1, page_length: 200 }) } }] };
  try {
    await runAgentLoop(localStore, buildContext(() => {}), {
      conversationId: 'alice', userText: '读一下这张表', engine: 'pi',
      toolDefs: [{ name: 'read_record', kind: 'query', description: '读取记录', parameters: { type: 'object', properties: { page: { type: 'integer' }, page_length: { type: 'integer' } } } }],
      toolExecutor: platformLikeExecutor(sheetResult()),
    } as any);
    const toolMessage = requests[1]?.messages?.find((m: any) => m.role === 'tool');
    assert.ok(toolMessage, 'Pi 路径模型也必须收到工具结果');
    assert.ok(toolMessage.content.length <= LIMIT, `Pi 路径回灌内容必须封顶（实际 ${toolMessage.content.length}）`);
    assert.equal(JSON.parse(toolMessage.content)._truncation.total_count, 12270);
  } finally { server.close(); }
});
