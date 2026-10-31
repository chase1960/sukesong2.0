/**
 * 对话附件的**全链**判据（PKG-024-T01，2026-10-22 用户 12:53 报「助手不能看图、不能传附件」）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「用户在助手里附一张图 ⇒ **模型真的收到那张图的字节**（和原件一致）；
 *   那张图**读不到**（内核拒了）⇒ **一个字都不进模型**，且**明说哪一份没进来**；
 *   附一个**非图片**文件 ⇒ 模型只拿到**引用**，**拿不到文件内容**。」
 *
 * 这一条走的是**真链路**：浏览器那头的 `/api/chat` → 既有授权读口（`file_content`）→ 模型请求。
 * 上游是**假 Frappe**（`tests/helpers/frappe-upstream.ts` 那份公共工具），模型是**假 SSE LLM**
 * —— ⚠️ **不打真模型**。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { withFrappeUpstream } from '../helpers/frappe-upstream.ts';

/** 一张**真的** PNG（红底白方块）—— 用来证明「模型收到的是原件字节」。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8z8DAwMDAxMDAwMDAAAANAgH/kdl3S0AAAAASUVORK5CYII=',
  'base64',
);
const FILE_DOCTYPE = 'Shangshu File Center File';

describe('对话附件：上传的图真的进了模型（走既有授权读口）', () => {
  let llmServer: Server, llmPort = 0;
  const modelInputs: any[] = [];

  before(async () => {
    llmServer = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        modelInputs.push(JSON.parse(body));
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '看到了' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(r => { llmServer.listen(0, '127.0.0.1', () => { llmPort = (llmServer.address() as any).port; r(); }); });
  });
  after(() => llmServer.close());
  beforeEach(() => { modelInputs.length = 0; });

  /** 起全套（假上游 ＋ 平台 BFF），登录后发一轮带附件的话，把**真正发给模型的内容**取回来。 */
  async function askWithAttachments(attachments: any[]) {
    const dir = mkdtempSync(join(tmpdir(), 'ss-vision-upload-'));
    process.env._SS_DATA_DIR = dir;
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'dashscope', base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: '', model: 'mimo-v2.6-pro' },
    }));
    return withFrappeUpstream(async (base) => {
      const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'tester-pass' }),
      });
      assert.equal(login.status, 200, '登录要成功');
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '这张图里是什么？', conversation_id: 'c1', attachments }),
      });
      assert.equal(res.status, 200, '这一轮要能发出去');
      const reader = res.body!.getReader();
      while (!(await reader.read()).done) { /* 消费完整流，后端才跑完 */ }
      assert.ok(modelInputs.length, '这一轮应当真的调过模型');
      return modelInputs[modelInputs.length - 1];
    }, (method) => {
      // 身份桩：`.session` 给一个有效的平台员工身份（其余交给公共 helper 的兜底）。
      // ⚠️ 这里**必须自己回** `.session` —— 公共 helper 只在 `respond` 回 `undefined` 时才兜底，
      // 而默认的 echo 会回一个对象 ⇒ 兜底不生效、身份是空的。
      if (method.endsWith('.session')) {
        return { identity_id: 'emp-tester', user_name: 'tester', user_type: 'System User', collaboration_key: 'tester' };
      }
      if (method.endsWith('.actions')) return [];
      return undefined;
    }, (method, url, res) => {
      // `file_content` 回**原件字节**（不是 JSON）—— 对话附件走的就是这条既有读口。
      if (!method.endsWith('.file_content')) return false;
      const query = new URL(url, 'http://x').searchParams;
      const refName = query.get('ref_name') || '';
      if (refName === 'DENIED') {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: '无权下载该记录的附件' }));
        return true;
      }
      // 原件名走 `Content-Disposition` —— **RFC 5987 形态**（内核修好之后的样子）：
      // `filename*` 是纯 ASCII（HTTP 头只吃 ASCII）⇒ Node 的解析器放行；
      // 客户端按 UTF-8 还原（`attachmentFilename` 优先认 `filename*`）。
      const originalName = refName === 'FILE-2' ? '合同.pdf' : '照片.png';
      res.statusCode = 200;
      res.setHeader('content-type', originalName.endsWith('.pdf') ? 'application/pdf' : 'image/png');
      res.setHeader('content-disposition',
        `attachment; filename="${originalName.endsWith('.pdf') ? 'file.pdf' : 'file.png'}"; filename*=UTF-8''${encodeURIComponent(originalName)}`);
      res.end(PNG_BYTES);
      return true;
    });
  }

  it('附一张图 ⇒ 模型真的收到那张图的字节（data URI 与原件一致）', async () => {
    const request = await askWithAttachments([
      { name: '照片.png', ref: { ref_doctype: FILE_DOCTYPE, ref_name: 'FILE-1', file: 'FILE-1' } },
    ]);
    const user = request.messages.find((m: any) => m.role === 'user');
    assert.ok(Array.isArray(user.content), '带图片的用户消息必须是分段数组');
    const image = user.content.find((part: any) => part.type === 'image_url');
    assert.ok(image, '模型请求里必须有一个图片段');
    const expected = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    assert.equal(image.image_url.url, expected, '图片字节必须和原件一致（走的是既有授权读口）');
  });

  it('图**读不到** ⇒ 不进模型，且**明说哪一份没进来**', async () => {
    const request = await askWithAttachments([
      { name: '看不到的.png', ref: { ref_doctype: FILE_DOCTYPE, ref_name: 'DENIED', file: 'DENIED' } },
    ]);
    const user = request.messages.find((m: any) => m.role === 'user');
    const serialized = JSON.stringify(user.content);
    assert.doesNotMatch(serialized, /image_url/, '读不到的附件不许进模型');
    assert.doesNotMatch(serialized, /base64/, '读不到的附件不许有字节进模型');
    const system = String(request.messages[0].content);
    assert.match(system, /看不到的\.png/, '要明说是哪一份没进来');
    assert.match(system, /无权下载该记录的附件/, '要明说为什么（内核给的原因原样）');
    assert.match(system, /不要假装看过/, '要告诫模型不许假装看过');
  });

  it('附**非图片**文件 ⇒ 模型只拿到引用，拿不到文件内容', async () => {
    const request = await askWithAttachments([
      { name: '合同.pdf', ref: { ref_doctype: FILE_DOCTYPE, ref_name: 'FILE-2', file: 'FILE-2' } },
    ]);
    const user = request.messages.find((m: any) => m.role === 'user');
    assert.equal(typeof user.content, 'string', '没有图片时消息是纯文本');
    assert.match(user.content, /合同\.pdf/, '要告诉模型是哪一份附件');
    assert.match(user.content, /FILE-2/, '要给出工具可读的引用');
    assert.doesNotMatch(user.content, /base64/, '非图片附件不许把内容塞进提示词');
  });
});
