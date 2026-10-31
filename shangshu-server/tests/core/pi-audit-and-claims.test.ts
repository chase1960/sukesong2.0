// Pi 路径与 classic 的**三处差距**（用户 2026-10-21 21:0x 点名）：
//   ① 工具调用的**对话审计**（`tool_request` / `tool_response`）——原先 Pi 路径一段都没有；
//   ② **空回答自动重试一次**（BASE967-28）——classic 有，Pi 直接回「未得到有效回答」；
//   ③ **声明-回执对账**——classic 用 `classifyUnfoundedClaims` ＋ `truthfulReply`
//      （把「没回执却说已提交」改成如实说法）；Pi 原来只有更窄的 `claimsConfirmation`
//      （只查确认类声明，**写入/邮件类声明不查**）。
//
// 判据都跑**真实 Pi 引擎**（`engine:'pi'`）＋ 受控 LLM 桩。
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop, type ChatToolDef } from '../../src/core/chat.ts';
import { buildContext } from '../../src/core/context.ts';
import { localStore } from '../../src/core/store.ts';

describe('Pi 路径补齐三处差距（审计 / 空回答重试 / 声明-回执对账）', () => {
  let server: Server, port: number, requests: any[];
  let respond: (body: any) => any;
  const read: ChatToolDef = { name: 'read_record', kind: 'query', description: '读当前授权记录',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } };
  const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

  before(async () => {
    server = createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
        const parsed = JSON.parse(body); requests.push(parsed);
        res.setHeader('Content-Type', 'text/event-stream');
        const delta = respond(parsed);
        res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
  });
  after(() => server.close());
  beforeEach(() => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-pi-gaps-'));
    writeFileSync(join(process.env._SS_DATA_DIR, 'runtime_config.json'),
      JSON.stringify({ llm: { provider: 'deepseek', base_url: `http://127.0.0.1:${port}/v1`, api_key: '', model: 'test' } }));
    requests = []; respond = () => ({ content: '你好' });
  });
  const run = (extra: any = {}) => runAgentLoop(localStore, buildContext(() => {}),
    { conversationId: 'alice', userText: '看一下当前记录', engine: 'pi', toolDefs: [read], ...extra } as any);

  it('① 工具调用有对话审计：tool_request 与 tool_response 两段都在', async () => {
    respond = body => body.messages.at(-1).role === 'tool' ? { content: '{"ok":true}' } : call('read_record', { id: 'row-1' });
    const events: any[] = [];
    await run({ toolExecutor: async (_d: any, t: any) => ({ role: 'tool', tool_call_id: t.id, content: '{"ok":true,"value":7}' }),
      hooks: { onAudit: (event: any) => { events.push(event); } } });
    const kinds = events.map(event => event.kind);
    assert.ok(kinds.includes('tool_request'), '必须有 tool_request：' + JSON.stringify(events));
    assert.ok(kinds.includes('tool_response'), '必须有 tool_response：' + JSON.stringify(events));
    const request = events.find(event => event.kind === 'tool_request');
    const response = events.find(event => event.kind === 'tool_response');
    assert.equal(request.tool, 'read_record');
    assert.equal(request.tool_call_id, 'call_1');
    assert.match(request.arguments, /row-1/);
    assert.ok(request.request_id, '两段要用同一个 request_id 串起来');
    assert.equal(response.request_id, request.request_id);
    assert.match(response.result, /value/, '回执要带工具结果');
  });

  it('② 空回答自动重试一次：给模型一句「上一条回复为空」，只重试一轮', async () => {
    respond = () => ({ content: '' });
    const result = await run();
    assert.equal(requests.length, 2, '空回答应当只重试一次（不是无限重试）');
    const second = requests[1].messages.map((m: any) => String(m.content ?? '')).join('\n');
    assert.match(second, /上一条回复为空/, '重试那一轮要把提示带给模型');
    assert.match(result.reply, /未得到有效回答/, '两次都空才如实说没得到回答');
  });

  it('③ 写入/邮件类声明也查回执：没回执不能说「已发送」', async () => {
    respond = () => ({ content: '已发送邮件给客户了。' });
    const result = await run();
    assert.doesNotMatch(result.reply, /^已发送邮件给客户/, '没回执的写入/邮件声明不能照抄模型的话');
    assert.match(result.reply, /未|尚未|没有/, '要改成如实说法：' + result.reply);
  });

  it('③ 补充：有真实回执时，模型的确认类声明不被改写', async () => {
    respond = body => body.messages.at(-1).role === 'tool' ? { content: '已生成待确认候选' }
      : call('propose_change', { id: 'row-1' });
    let confirms = 0;
    const result = await run({ toolDefs: [{ ...read, name: 'propose_change', kind: 'confirm' }],
      toolExecutor: async (_d: any, t: any, hooks: any) => {
        hooks.onConfirm({ id: 'proposal-1', capability: 'example.update', entity_type: 'example.row', entity_id: 'row-1', payload: {} });
        return { role: 'tool', tool_call_id: t.id, content: '{"ok":true,"confirmation_id":"proposal-1"}' };
      }, hooks: { onConfirm: () => { confirms += 1; } } });
    assert.equal(confirms, 1, '确认回执应真实产生');
    // 模型最后一句是「已生成待确认候选」，而这一轮**有**真实提案回执 ⇒ 不该被改写成「尚未执行」。
    assert.equal(result.reply, '已生成待确认候选', '有真实回执的确认类声明不该被改写：' + result.reply);
  });
});
