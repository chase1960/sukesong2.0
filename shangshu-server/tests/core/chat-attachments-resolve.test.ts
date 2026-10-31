/**
 * 对话附件的**解析器**（PKG-024-T01）—— 决定「哪一份能进模型、哪一份只给引用、哪一份丢掉」。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「图片**超上限就不进模型**（丢的时候**说清为什么**）、
 *   正常大小的图片**带字节**进、
 *   非图片**只留引用**（而且**只核读权、不取字节**）、
 *   读不到的那一份**带原因**被丢掉、
 *   形状不对的引用**当场拒**（不猜编号）。」
 *
 * 为什么单独判这一层：它决定**「什么进模型、什么不进」** ——
 * 判错了就是「模型看到了它不该看到的」或「用户传了图，助手说没看见」。
 *
 * ⚠️ **上限不是拍脑袋的**：模型出口（nginx 反代）把**请求体**限在 **4MB**，
 * 而图片进请求体是 **base64**（胀 4/3）⇒ 图片本身上限必须比 4MB 小一截。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatAttachments, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_ATTACHMENTS } from '../../src/adapters/web/chat-attachments.ts';

const FILE_DOCTYPE = 'Shangshu File Center File';
const ref = (name: string) => ({ ref_doctype: FILE_DOCTYPE, ref_name: 'FILE-1', file: name });

describe('对话附件解析器：什么进模型、什么只给引用、什么丢掉', () => {
  it('图片超上限 ⇒ **不进模型**，并说清为什么', async () => {
    const big = Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1024, 7);
    const result = await resolveChatAttachments([{ name: '大图.png', ref: ref('大图.png') }], {
      readFile: async () => ({ name: '大图.png', bytes: big }),
    });
    assert.equal(result.attachments.length, 0, '超上限的图片不许进模型');
    assert.equal(result.dropped.length, 1, '要记成「丢了一份」');
    assert.match(result.dropped[0].reason, /MB/, '要明说因为太大');
    assert.match(result.dropped[0].reason, /没有带入/, '要明说没带进去');
  });

  it('上限本身比模型出口的 4MB 请求体小（base64 会胀 4/3）', () => {
    // 出口 nginx：client_max_body_size 4m。base64 后是 4/3 倍 ⇒ 原始图片必须更小。
    assert.ok(MAX_CHAT_IMAGE_BYTES <= 2 * 1024 * 1024,
      `图片上限 ${MAX_CHAT_IMAGE_BYTES} 太大：base64 后会超过模型出口 4MB 的请求体限制`);
  });

  it('正常大小的图片 ⇒ **带字节**进模型', async () => {
    const bytes = Buffer.from('png-bytes');
    const result = await resolveChatAttachments([{ name: '照片.png', ref: ref('照片.png') }], {
      readFile: async () => ({ name: '照片.png', bytes }),
    });
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].image_base64, bytes.toString('base64'), '图片要带字节');
    assert.equal(result.attachments[0].mime, 'image/png');
    assert.equal(result.attachments[0].reference, undefined, '图片不必再给引用（字节已经给了）');
    assert.equal(result.dropped.length, 0);
  });

  it('非图片 ⇒ **只核读权、不取字节**，正文只留引用', async () => {
    const calls: any[] = [];
    const result = await resolveChatAttachments([{ name: '合同.pdf', ref: ref('合同.pdf') }], {
      readFile: async (source, verifyOnly) => {
        calls.push({ source, verifyOnly });
        return { name: '合同.pdf', bytes: Buffer.alloc(0) };
      },
    });
    assert.equal(calls.length, 1, '非图片也要核一次读权（谁能读那个文件，谁才能从对话里看到它）');
    assert.equal(calls[0].verifyOnly, true, '只核读权，**不取字节**（大文件不进提示词）');
    assert.equal(result.attachments[0].image_base64, undefined, '非图片不许带字节');
    assert.match(result.attachments[0].reference!, /FILE-1/, '要留工具可读的引用');
    assert.equal(result.attachments[0].mime, 'application/pdf');
  });

  it('读不到 ⇒ **带原因**丢掉（不许装作有）', async () => {
    const result = await resolveChatAttachments([{ name: '看不到.png', ref: ref('看不到.png') }], {
      readFile: async () => { throw new Error('无权下载该记录的附件'); },
    });
    assert.equal(result.attachments.length, 0);
    assert.equal(result.dropped[0].name, '看不到.png');
    assert.match(result.dropped[0].reason, /无权下载/, '要带上真实原因');
  });

  it('引用形状不对 ⇒ 当场拒（不猜编号）', async () => {
    const result = await resolveChatAttachments([{ name: 'x.png', ref: { ref_doctype: FILE_DOCTYPE } }], {
      readFile: async () => { throw new Error('不该被调用'); },
    });
    assert.equal(result.attachments.length, 0);
    assert.match(result.dropped[0].reason, /附件引用无效/, '形状不对要说清楚');
  });

  it('一轮最多几个附件（多出来的明说没带进去）', async () => {
    const many = Array.from({ length: MAX_CHAT_ATTACHMENTS + 2 }, (_, i) => ({ name: `f${i}.png`, ref: ref(`f${i}.png`) }));
    const result = await resolveChatAttachments(many, { readFile: async () => ({ name: 'f.png', bytes: Buffer.from('x') }) });
    assert.equal(result.attachments.length, MAX_CHAT_ATTACHMENTS, '超出的不进');
    assert.ok(result.dropped.some(d => /最多/.test(d.reason)), '要明说超了几个没带进去');
  });
});
