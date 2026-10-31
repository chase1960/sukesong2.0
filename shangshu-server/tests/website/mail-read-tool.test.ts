import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPlatformChatBridge, describeActionForModel } from '../../src/adapters/web/platform.ts';

// —— 邮件域 `mail.read` 投影成 agent 工具 ——
// 测试通过 = 什么成立：agent 的工具面里查得到 `mail.read`，它是**只读**工具
// （kind=query，不用人工确认卡），工具说明里写清「这是只读」与「传邮件记录编号」。
test('mail.read 投影成 agent 只读工具：测试通过 = 工具面里有它、kind=query、说明写明只读', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: [
      {
        id: 'mail.read', title: '读取一封邮件（正文/收件人/抄送/附件，只读）',
        effect: 'read', confirmation: 'none', executable: true,
        input_schema: {
          type: 'object', required: ['mail'],
          properties: { mail: { type: 'string', description: '邮件记录编号' } },
        },
      },
      {
        id: 'mail.save_draft', title: '保存邮件草稿', effect: 'write',
        confirmation: 'required', executable: true, input_schema: { type: 'object' },
      },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.FRAPPE_UPSTREAM;
  process.env.FRAPPE_UPSTREAM = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const bridge = await createPlatformChatBridge({ headers: { cookie: 'sid=test' } } as any);
    const def = bridge.toolDefs.find((item) => item.capability === 'mail.read');
    assert.ok(def, 'mail.read 不在 agent 工具面里 ⇒ agent 读不到信');
    assert.equal(def!.kind, 'query', '只读动作不该走人工确认卡');
    assert.match(def!.description, /只读/, '工具说明里要写清这是只读');
    assert.match(def!.description, /邮件记录编号/, '工具说明里要写清传什么编号');
    assert.doesNotMatch(def!.description, /confirmation_id/, '只读工具不该教模型等确认回执');
    // 写动作仍是「只生成确认提案」，别被只读说明带跑
    const write = bridge.toolDefs.find((item) => item.capability === 'mail.save_draft');
    assert.equal(write!.kind, 'confirm');
    assert.match(describeActionForModel({ id: 'mail.read', effect: 'read' }), /只读调用/);
  } finally {
    if (previous === undefined) delete process.env.FRAPPE_UPSTREAM;
    else process.env.FRAPPE_UPSTREAM = previous;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
