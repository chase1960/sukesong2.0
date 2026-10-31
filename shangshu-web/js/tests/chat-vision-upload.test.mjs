// 判据：助手能**上传图片等附件**、并把附件**带进对话**（PKG-024-T01）。
//
// **测试通过 =**（一句话）
// 「① 助手输入栏的上传入口走的是**通用附件上传**（文件域的 `files.upload`），
//   **不是**发票识别那条路；
//   ② 上传完拿到**受管文件引用**（文件编号 ＋ 固定版本引用），**跟着这一条消息**发给服务端；
//   ③ 发给服务端的是**引用**，**不是文件内容**（大文件会把提示词撑爆）；
//   ④ 待发附件**看得见**（输入框上方的小标签）**也能撤**；
//   ⑤ 发票那条老路（`chatUploadInvoice`）**原样还在** —— 不许把别人的功能删了。」
//
// 为什么要有这条：用户 2026-10-22 12:53 原话「assistant agent 没有办法看图，
// 没办法上传图片等附件」——代码里看不出来，只能盯住**走的是哪条路**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chatUrl = new URL('../real-chat.js', import.meta.url);
const source = fs.readFileSync(chatUrl, 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `源码里找不到起始标记：${from}`);
  const end = to ? source.indexOf(to, start) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

test('① 上传入口走的是**通用附件上传**，不是发票识别那条路', () => {
  // 输入框的 file input 挂的是 chatAttachFile（通用附件），不是 chatUploadInvoice（发票）。
  const input = /<input[^>]*id="chat-inv-file"[^>]*>/.exec(source);
  assert.ok(input, '找不到附件选择框');
  assert.match(input[0], /onchange="chatAttachFile\(this\)"/, '附件选择框还没接到通用附件上传');
  assert.match(input[0], /accept="[^"]*image\//, 'accept 里要含图片（用户要能传图）');
  // 通用上传走**文件域的公共上传口**。
  const attach = slice('async function chatAttachFile(input)', '/* —— 对话单据上传');
  assert.match(attach, /files\.upload/, '通用附件上传要走文件域的 files.upload');
  assert.doesNotMatch(attach, /finance\/documents/, '通用附件上传不该打发票识别那条口');
});

test('② 上传完拿到**受管文件引用**，跟着这一条消息发给服务端', () => {
  const attach = slice('async function chatAttachFile(input)', '/* —— 对话单据上传');
  assert.match(attach, /files\.versions/, '要取固定版本的原件引用');
  assert.match(attach, /ref_doctype/, '引用里要带文件归属（ref_doctype/ref_name/file）');
  assert.match(attach, /frappe_file/, '引用要用固定版本的原件（frappe_file），不是文件名');
  // 发送时把引用带进请求体。
  const send = slice('function chatSendInput()', 'function chatSendChip(');
  assert.match(send, /chatPendingAttachments/, '发送时要带上待发附件');
  const run = slice('async function chatRunMessage(text, attachments)', 'chatAddUserMsg(text, turnLayer, attachments);');
  assert.match(run, /attachments/, '请求体里要带附件引用');
});

test('③ 发给服务端的是**引用**，不是文件内容', () => {
  const run = slice('async function chatRunMessage(text, attachments)', 'chatAddUserMsg(text, turnLayer, attachments);');
  assert.doesNotMatch(run, /content_base64/, '文件内容不许进对话请求体（大文件会撑爆）');
  assert.doesNotMatch(run, /base64/, '文件内容不许进对话请求体（大文件会撑爆）');
});

test('④ 待发附件**看得见**（小标签）**也能撤**', () => {
  assert.match(source, /id="chat-attach-list"/, '输入框上方要有待发附件的位置');
  const render = slice('function chatAttachRender()', 'function chatAttachRemove(');
  assert.match(render, /chat-attach-chip/, '待发附件要画成小标签');
  const remove = slice('function chatAttachRemove(index)', 'async function chatAttachFile(');
  assert.match(remove, /splice/, '附件要能撤掉');
});

test('⑤ 发票那条老路原样还在（不许把别人的功能删了）', () => {
  assert.match(source, /async function chatUploadInvoice\(input\)/, '发票识别那条老路被删了');
  assert.match(source, /\/api\/platform\/finance\/documents/, '发票识别那条老的调用没了');
});

test('⑥ 助手上传的图**落在文件中心**，而且用户**看得见它落在哪**', () => {
  const attach = slice('async function chatAttachFile(input)', '/* —— 对话单据上传');
  // 上传走文件域公共口 ⇒ 建的是**文件中心**里的受管文件（不是某个临时角落）。
  assert.match(attach, /files\.upload/, '要走文件域的公共上传口');
  assert.match(attach, /file:\s*uploaded\.file/, '待发附件要留住**文件中心的文件编号**（业务域/工具才能引用同一份，不重传）');
  assert.match(attach, /ref_name:\s*uploaded\.file/, '引用里的业务归属就是那个文件编号');
  // 用户看得见落点（小标签上要写出来）。
  const render = slice('function chatAttachRender()', 'function chatAttachRemove(');
  assert.match(render, /文件中心/, '附件小标签要写明落在文件中心');
  assert.match(render, /a\.file/, '小标签上要能拿到文件编号');
});
