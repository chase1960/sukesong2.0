/**
 * 「当前上下文」内核能力（2026-10-21）。
 *
 * 测试通过 = 什么成立：
 * - 白名单外的字段**进不来**（内容段里多余的键也一样被丢掉）；
 * - 内容段有**硬上限**，超长截断并标 `truncated`；
 * - 每个会话只有**一份权威份**，后到的覆盖先到的（不打架）；
 * - 内容段进提示词前**按当前身份核读权**：出处读不到 ⇒ **整段丢弃**并说明原因；
 *   条目在读回来的内容里找不到 ⇒ 同样丢弃（不把读不到的东西带进提示词）；
 * - 提示词里内容**单独成段**，且**保留**「只是线索、业务事实要用工具重查」那句告诫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkContextContent, clearCurrentContext, contextContentPrompt, getCurrentContext,
  MAX_CONTEXT_CONTENT_CHARS, normalizeContextContent, setCurrentContext,
  type ChatUiContext,
} from '../../src/core/chat-context.ts';

test('白名单：内容段里白名单外的键进不来', () => {
  const content = normalizeContextContent({
    kind: 'text',
    text: '正文',
    secret: '不许带',
    refs: [{ via: 'record', entity_type: 'mail.message', entity_id: 'MAIL-1', password: 'x' }],
  })!;
  assert.equal(content.kind, 'text');
  assert.equal((content as any).secret, undefined, '白名单外的键不许留在内容段里');
  assert.equal((content.refs[0] as any).password, undefined, '白名单外的键不许留在出处里');
  assert.equal(content.refs.length, 1);
});

test('硬上限：超长正文截断并标 truncated', () => {
  const long = '内'.repeat(MAX_CONTEXT_CONTENT_CHARS + 500);
  const content = normalizeContextContent({ kind: 'text', text: long, refs: [] })!;
  assert.equal(content.text.length, MAX_CONTEXT_CONTENT_CHARS, '正文必须被截到硬上限');
  assert.equal(content.truncated, true, '截断了就要标出来');
  const short = normalizeContextContent({ kind: 'text', text: '短', refs: [] })!;
  assert.equal(short.truncated, false);
});

test('权威份：同一会话后到的覆盖先到的，且只有一份', () => {
  clearCurrentContext('u1', 'c1');
  setCurrentContext('u1', 'c1', { module: 'mail', entity_type: 'mail.message', entity_id: 'A', label: 'A 信' });
  setCurrentContext('u1', 'c1', { module: 'mail', entity_type: 'mail.message', entity_id: 'B', label: 'B 信' });
  const current = getCurrentContext('u1', 'c1')!;
  assert.equal(current.entity_id, 'B', '后到的覆盖先到的');
  assert.equal(current.label, 'B 信');
  // 另一个会话/另一个人各有一份，互不串。
  assert.equal(getCurrentContext('u1', 'c2'), undefined);
  assert.equal(getCurrentContext('u2', 'c1'), undefined);
});

test('核对：出处读不到 ⇒ 整段内容丢弃，并说明原因', async () => {
  const context: ChatUiContext = {
    module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-1', label: '信',
    content: { kind: 'text', text: '机密正文', truncated: false, items: ['机密正文'], refs: [{ via: 'record', entity_type: 'mail.message', entity_id: 'MAIL-1' }] },
  };
  const checked = await checkContextContent(context, async () => ({ ok: false, reason: '当前身份已无权读取' }));
  assert.equal(checked.context.content, undefined, '核不过的内容不许留在上下文里');
  assert.match(checked.dropped!.reason, /无权读取/, '要明说为什么丢');
});

test('核对：读回来的内容里没有这一条 ⇒ 丢弃（不许带读不到的东西）', async () => {
  const context: ChatUiContext = {
    module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-1', label: '信',
    content: { kind: 'text', text: '看不见的一行', truncated: false, items: ['看不见的一行'], refs: [{ via: 'record', entity_type: 'mail.message', entity_id: 'MAIL-1' }] },
  };
  const checked = await checkContextContent(context, async () => ({ ok: true, values: ['能看见的一行'] }));
  assert.equal(checked.context.content, undefined);
  assert.match(checked.dropped!.reason, /读不到/);
});

test('核对：出处没有可核对的引用 ⇒ 丢弃（不能确认身份还能读到它）', async () => {
  const context: ChatUiContext = {
    module: 'mail', label: '信',
    content: { kind: 'text', text: '正文', truncated: false, items: [], refs: [] },
  };
  const checked = await checkContextContent(context, async () => ({ ok: true, values: ['正文'] }));
  assert.equal(checked.context.content, undefined);
  assert.match(checked.dropped!.reason, /出处/);
});

test('核对：出处读得到、条目也对得上 ⇒ 内容保留', async () => {
  const context: ChatUiContext = {
    module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-1', label: '信',
    content: {
      kind: 'text', text: '王老师：本期年费核对如下', truncated: false,
      items: ['王老师：本期年费核对如下'],
      refs: [{ via: 'record', entity_type: 'mail.message', entity_id: 'MAIL-1' }],
    },
  };
  const checked = await checkContextContent(context, async () => ({ ok: true, values: ['<p>王老师：</p><p>本期年费核对如下</p>'] }));
  assert.ok(checked.context.content, '核对通过要保留内容');
  assert.equal(checked.dropped, undefined);
});

test('提示词：内容单独成段，且保留「只是线索、业务事实要用工具重查」的告诫', () => {
  const context: ChatUiContext = {
    module: 'mail', label: '信',
    content: { kind: 'text', text: '正文片段', truncated: true, items: [], refs: [] },
  };
  const segment = contextContentPrompt(context);
  assert.match(segment, /当前查看的内容/);
  assert.match(segment, /正文片段/);
  assert.match(segment, /已截断/, '截断了要在提示词里说');
  assert.match(segment, /只是\*\*线索\*\*/, '要保留「只是线索」那句');
  assert.match(segment, /必须用工具重查/, '要保留「业务事实必须用工具重查」那句');
  assert.equal(contextContentPrompt({ module: 'mail', label: '信' }), '', '没有内容时不产这一段');
});
