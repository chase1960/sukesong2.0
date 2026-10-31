/**
 * 助手「看图 / 带附件」（PKG-024-T01，2026-10-22 用户 12:53 报的能力缺口）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「用户发一句话并附一张图时，**真正发给模型的那条用户消息里有一个图片段**
 *   （`data:image/png;base64,…`），而**聊天历史里不存这段字节**；
 *   附**非图片**文件时只把**引用**交给模型（工具自己去读），提示词里**没有文件内容**；
 *   附件**读不到**时**明说为什么**，不许模型假装看过。」
 *
 * 为什么要有这条：用户原话「assistant agent 没有办法看图，没办法上传图片等附件」。
 * 这条判据只管**内核这一段**（消息怎么拼、字节落不落库）；
 * 「字节怎么读回来」在 `tests/website/chat-vision-upload.test.ts`（那一段走既有授权读口）。
 *
 * ⚠️ **不打真模型**：用受控的假 LLM（照 `pi-chat.test.ts` 那套 `createServer` 起 SSE 服务）。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from '../../src/core/chat.ts';
import { buildContext } from '../../src/core/context.ts';
import { localStore } from '../../src/core/store.ts';

describe('对话附件：图片进模型消息段 ＋ 字节不落库', () => {
  let server: Server, port: number;
  let requests: any[];

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '看到了' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
  });
  after(() => server.close());
  beforeEach(() => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-vision-'));
    writeFileSync(join(process.env._SS_DATA_DIR, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'dashscope', base_url: `http://127.0.0.1:${port}/v1`, api_key: '', model: 'mimo-v2.6-pro' },
    }));
    requests = [];
  });

  const run = (extra: any = {}) => runAgentLoop(localStore, buildContext(() => {}), {
    conversationId: 'alice', userText: '这张图里是什么颜色？', toolDefs: [], ...extra,
  } as any);

  it('图片附件 ⇒ 真正发给模型的用户消息里有一个图片段（base64 data URI）', async () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64');
    await run({ attachments: [{ name: '照片.png', mime: 'image/png', image_base64: base64 }] });
    assert.equal(requests.length, 1, '这一轮应当真的调过模型');
    const user = requests[0].messages.find((m: any) => m.role === 'user');
    assert.ok(Array.isArray(user.content), '带图片的用户消息必须是分段数组（不是纯文本）');
    const image = user.content.find((part: any) => part.type === 'image_url');
    assert.ok(image, '必须有一个图片段');
    assert.equal(image.image_url.url, `data:image/png;base64,${base64}`, '图片段必须是 base64 data URI');
    const text = user.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    assert.match(text, /这张图里是什么颜色？/, '用户原话要在那段文字里');
  });

  it('图片字节**不进聊天历史**（历史落库的是人话，不是 base64）', async () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64');
    await run({ attachments: [{ name: '照片.png', mime: 'image/png', image_base64: base64 }] });
    const rows = await localStore.query('execution', 'chat_messages');
    const user = rows.find((r: any) => r.role === 'user');
    assert.ok(user, '用户消息要落库');
    assert.equal(user.content, '这张图里是什么颜色？', '历史里存的是用户原话');
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(base64), 'base64 字节不许进历史库');
  });

  it('非图片附件 ⇒ 只给模型**引用**，提示词里没有文件内容', async () => {
    await run({
      attachments: [{
        name: '合同.pdf', mime: 'application/pdf',
        reference: '{"ref_doctype":"Shangshu File Center File","ref_name":"FILE-1","file":"FILE-1.pdf"}',
      }],
    });
    const user = requests[0].messages.find((m: any) => m.role === 'user');
    assert.equal(typeof user.content, 'string', '没有图片时消息还是纯文本（不空造数组）');
    assert.match(user.content, /合同\.pdf/, '要告诉模型是哪一份附件');
    assert.match(user.content, /FILE-1/, '要给出工具可读的引用');
  });

  it('非图片附件 ⇒ **点名能用的读法**（否则模型会去用要 OCR 服务的 attachment_text）', async () => {
    await run({
      attachments: [{
        name: '合同.pdf', mime: 'application/pdf',
        reference: '{"ref_doctype":"Shangshu File Center File","ref_name":"FILE-1","file":"FILE-1.pdf"}',
      }],
    });
    const user = requests[0].messages.find((m: any) => m.role === 'user');
    // 文件域的正文读口（抽 PDF 文字层／DOCX 段落）—— 真实可用的那一条。
    assert.match(user.content, /files\.document_text/, '要点名真正能读正文的那个服务');
    assert.match(user.content, /\{"file":"FILE-1"\}/, '要给出调用参数（模型不用猜）');
  });

  it('附件读不到 ⇒ **明说为什么**，不许模型假装看过', async () => {
    await run({ attachmentsDropped: '照片.png：原件读取失败' });
    const system = requests[0].messages[0].content;
    assert.match(system, /没有.*进入/, '系统提示词里要明说附件没进来');
    assert.match(system, /照片\.png/, '要说明是哪一份没进来');
    assert.match(system, /不要假装看过/, '要告诫模型不许假装看过');
  });
});
