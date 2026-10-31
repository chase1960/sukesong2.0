// 消息接口测试（2026-08-07）：会话/消息/未读/写路径（im.send 事件 → messages 投影）
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('消息（真实 IM）', () => {
  let dir: string; let server: Server; let port: number;

  async function loginAs(username: string): Promise<string> {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: username === 'admin' ? 'admin' : 'test123' }),
    });
    const cookie = r.headers.get('set-cookie') || '';
    assert.ok(cookie, '登录应返回 cookie');
    return cookie;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-im-'));
    process.env._SS_DATA_DIR = dir;
    const { localStore } = await import('../../src/core/store.ts');
    const { ensureBootstrap, createUser } = await import('../../src/core/auth/users.ts');
    await ensureBootstrap(localStore);
    for (const [u, d] of [['chen', '陈晓'], ['wang', '王强']]) {
      await createUser(localStore, { username: u, password: 'test123', role: 'staff', display_name: d });
    }
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
  });
  afterEach(() => { server.close(); });

  it('GET /api/im/users 返回可聊天用户（排除自己）', async () => {
    const cookie = await loginAs('admin');
    const res = await fetch(`http://127.0.0.1:${port}/api/im/users`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const { list } = await res.json();
    const names = list.map((u: any) => u.username);
    assert.ok(names.includes('chen') && names.includes('wang'));
    assert.ok(!names.includes('admin'), '排除自己');
  });

  it('私聊：建会话 → 双方发消息 → 各自未读正确 → 已读清零', async () => {
    const chen = await loginAs('chen');
    const wang = await loginAs('wang');

    // chen 发起私聊
    const create = await fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    });
    const { id: chatId } = await create.json();

    // 双方都发一条
    for (const [cookie, text] of [[chen, '王强，MO-0712 什么时候出货？'], [wang, '今天下午质检完，明天发货']]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      assert.equal(r.status, 200);
    }

    // chen 视角：自己那条不算未读，wang 那条算 1
    let chats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chats.length, 1);
    assert.equal(chats[0].unread, 1);

    // 只读取消息列表不再自动标已读：并发期间到达的新消息不会被误标
    await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: chen } });
    chats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chats[0].unread, 1, '读取列表本身不得清未读');

    // 显式按消息 ID 标已读 → 未读清零；重复标记幂等
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: chen } })).json()).list;
    const read = (id: string) => fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/read`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: id }),
    });
    assert.equal((await read(list[list.length - 1].id)).status, 200);
    assert.equal((await read(list[0].id)).status, 200, '标记更早的消息是幂等操作');
    chats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chats[0].unread, 0);

    // 标记后对方再发新消息 → 仍算未读（不会被旧的读取时间误吞）
    await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, {
      method: 'POST', headers: { cookie: wang, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '补充一句' }),
    });
    chats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chats[0].unread, 1);

    // 非成员不能标记已读
    const other = await loginAs('admin');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/read`, {
      method: 'POST', headers: { cookie: other, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: list[0].id }),
    })).status, 400);

    // 消息时间正序 + 发送方正确
    const msgs = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: wang } })).json()).list;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].sender_id, 'chen');
    assert.equal(msgs[1].sender_id, 'wang');
  });

  it('私聊复用已存在会话（不重复建）', async () => {
    const chen = await loginAs('chen');
    const mk = () => fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    });
    const a = await (await mk()).json();
    const b = await (await mk()).json();
    assert.equal(a.id, b.id, '同一对用户只建一个会话');
  });

  it('发消息走事件写总线（im.send confirmed 事件 + messages 投影）', async () => {
    const chen = await loginAs('chen');
    const { id: chatId } = await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    })).json();
    await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '第一条消息' }),
    });
    const { localStore } = await import('../../src/core/store.ts');
    const { verifyChain } = await import('../../src/core/events.ts');
    const evts = await localStore.query('execution', 'events');
    assert.ok(evts.some((e: any) => e.capability === 'im.send' && e.status === 'confirmed'), '应有 im.send confirmed 事件');
    assert.deepEqual(await verifyChain(localStore), []);
  });

  it('同一 client_msg_id 断网重试只落一条消息；不带键保持原行为', async () => {
    const chen = await loginAs('chen');
    const { id: chatId } = await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    })).json();
    const send = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await send({ text: '断网后重试这条', client_msg_id: 'retry-1' })).status, 200);
    const dup = await send({ text: '断网后重试这条', client_msg_id: 'retry-1' });
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).duplicate, true, '同键重试应返回幂等成功');
    assert.equal((await send({ text: '换一句重发', client_msg_id: 'retry-2' })).status, 200);
    assert.equal((await send({ text: '旧客户端不带键' })).status, 200);
    const msgs = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: chen } })).json()).list;
    assert.equal(msgs.length, 3, '同键只落一条，不同键与无键各一条');
  });

  it('私聊删除=本人归档：只隐藏我的列表，对方记录完整，重新私聊自动恢复', async () => {
    const chen = await loginAs('chen');
    const wang = await loginAs('wang');
    const { id: chatId } = await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    })).json();
    for (const [cookie, text] of [[chen, '第一条'], [wang, '第二条']] as const) {
      await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
    }
    // chen 删除（归档）会话
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}`, { method: 'DELETE', headers: { cookie: chen } })).status, 200);
    let chenChats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chenChats.length, 0, '归档后我的列表不再显示');
    // 对方视图与消息本体完整保留
    const wangChats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: wang } })).json()).list;
    assert.equal(wangChats.length, 1);
    const wangMsgs = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: wang } })).json()).list;
    assert.equal(wangMsgs.length, 2, '消息不得被物理删除');
    // 归档者重新发起私聊：同一会话恢复显示，历史还在
    const again = await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, {
      method: 'POST', headers: { cookie: chen, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dm', peer_id: 'wang' }),
    })).json();
    assert.equal(again.id, chatId, '复用同一会话');
    chenChats = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chenChats.length, 1, '重新私聊后恢复显示');
    const chenMsgs = (await (await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}/messages`, { headers: { cookie: chen } })).json()).list;
    assert.equal(chenMsgs.length, 2, '恢复后历史消息完整');
    // 非成员仍不能“删除”他人私聊
    const other = await loginAs('admin');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/im/chats/${chatId}`, { method: 'DELETE', headers: { cookie: other } })).status, 400);
  });
});
