/**
 * 邮件页 → 助手的「当前查看的内容」（2026-10-21）。
 *
 * 测试通过 = 什么成立：
 * - 正在读的那封信，助手上报的上下文里**带着它的正文**（有上限）；
 * - 正文之外还带**收件人/抄送/附件摘要**（用户屏幕上看得见的那部分）；
 * - 内容段给出**出处**（那封信的记录编号）—— 服务端要靠它按当前身份重读、核对；
 * - 超长正文**截断并标 truncated**；
 * - 写信用窗（正文可能还没保存）**不带内容**（省得报一份注定被服务端丢掉的东西）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');

/** 从源码里抠出一个函数（按大括号配平），单独跑 —— 不必把整个邮件页挂起来。 */
function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`${name} 的大括号没配平`);
}

const sandbox: any = { console };
const maxChars = source.match(/const MAIL_CONTEXT_MAX_CHARS\s*=\s*(\d+)/);
assert.ok(maxChars, '源码里要有内容段的长度上限');
runInNewContext(
  `const MAIL_CONTEXT_MAX_CHARS=${maxChars[1]};\n${extractFunction('mailPlainText')}\n${extractFunction('mailContextContent')}\n`
  + 'this.mailPlainText=mailPlainText;this.mailContextContent=mailContextContent;',
  sandbox,
);

const MAIL = {
  id: 'MAIL-1',
  subject: '关于CN3024518案件的审查意见答复',
  body: '<p>王老师：</p><p>本期年费核对如下，请查收。</p>',
  to: [{ name: '张总', addr: 'zhang@acme.example.com' }],
  cc: [{ name: '王工', addr: 'wang@partner.example.com' }],
  attachments: [{ name: '审查意见通知书.pdf', size: 2202009 }],
};

test('正在读的那封信 ⇒ 上下文里带着正文、收件人与附件摘要', () => {
  const content = sandbox.mailContextContent(MAIL);
  assert.ok(content, '要有内容段');
  assert.equal(content.kind, 'text');
  assert.match(content.text, /王老师：/, '正文要在');
  assert.match(content.text, /本期年费核对如下，请查收。/, '正文要在');
  assert.match(content.text, /收件人：zhang@acme\.example\.com/, '收件人要在');
  assert.match(content.text, /抄送：wang@partner\.example\.com/, '抄送要在');
  assert.match(content.text, /附件：审查意见通知书\.pdf/, '附件摘要要在');
  assert.equal(content.truncated, false);
});

test('内容段给出出处（那封信的记录编号），可核对条目是正文与收件人', () => {
  const content = sandbox.mailContextContent(MAIL);
  // 沙箱里的对象来自另一个 realm ⇒ 用 JSON 比（deepEqual 会因原型不同而误判）。
  assert.deepEqual(JSON.parse(JSON.stringify(content.refs)), [{ via: 'record', entity_type: 'mail.message', entity_id: 'MAIL-1' }]);
  assert.ok(content.items.some((item: string) => item.includes('王老师：')), '正文的可核对条目要在');
  assert.ok(content.items.some((item: string) => item.includes('zhang@acme.example.com')), '收件人的可核对条目要在');
});

test('超长正文截断并标 truncated', () => {
  const long = { ...MAIL, body: '<p>' + '内'.repeat(4000) + '</p>' };
  const content = sandbox.mailContextContent(long);
  assert.equal(content.truncated, true, '截断了要标出来');
  assert.ok(content.text.length <= 1500, `正文最多 1500 字符，实际 ${content.text.length}`);
});

test('没有信编号 ⇒ 不带内容段', () => {
  assert.equal(sandbox.mailContextContent({ id: '', subject: 'x', body: 'y' }), undefined);
});
