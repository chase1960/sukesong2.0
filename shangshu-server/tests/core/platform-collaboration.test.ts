import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAuth, requireRole } from '../../src/core/auth/guard.ts';
import { createSession, destroySession } from '../../src/core/auth/session.ts';
import { collaborationPeople } from '../../src/core/auth/people.ts';
import { createTask } from '../../src/capabilities/task-domain.ts';
import { requireActor } from '../../src/core/actor.ts';
import type { StateStore } from '../../src/core/types.ts';

test('平台协作：新员工无需 Node 用户表，降权/停用与上游故障立即生效', async () => {
  const oldFetch = globalThis.fetch;
  const oldMode = process.env.SHANGSHU_PLATFORM_MODE, oldUpstream = process.env.FRAPPE_UPSTREAM;
  process.env.SHANGSHU_PLATFORM_MODE = 'frappe'; process.env.FRAPPE_UPSTREAM = 'http://mock.invalid';
  let roles = ['System Manager'], status = 200, liveKey = 'identity-manager';
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    const message = String(input).endsWith('.people')
      ? [{ username: 'identity-new', identity_id: 'identity-new', display_name: '新员工' }]
      : { identity_id: 'identity-manager', user_name: 'manager@company.local', collaboration_key: liveKey, roles };
    return new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });
  };
  const rows: any[] = [];
  // 平台模式下 cognition 旧账号表必须不可读（fail closed）；notifications 去重查询是任务通知自身表，放行返回空
  const store = { query: async (layer: string, table: string) => { if (layer === 'process' && table === 'notifications') return []; throw new Error('禁止查询旧账号表'); }, insert: async (layer: string, table: string, data: any) => { rows.push({layer, table, ...data}); return 'TASK-1'; } } as unknown as StateStore;
  const session = createSession({ username: liveKey, display_name: '经理', role: 'admin' });
  const request = () => ({ headers: { cookie: `sid=valid; shangshu_token=${session.token}` } }) as any;
  let responseStatus = 0;
  const res = { status(code: number) { responseStatus = code; return this; }, json() { return this; } } as any;
  try {
    let operation: Promise<unknown> | undefined;
    await requireAuth(request(), res, () => {
      operation = (async () => {
        assert.equal((await collaborationPeople(store))[0].username, 'identity-new');
        await createTask({title:'新员工任务',assignee_id:'identity-new'}, {store, actor:requireActor()} as any);
      })();
    });
    await operation;
    assert.equal(rows[0].assignee_id, 'identity-new');
    assert.equal(calls, 2, '一次身份核验和一次目录读取，目录在请求内复用');
    roles = ['Desk User'];
    let allowed = false;
    await requireRole('manager')(request(), res, () => { allowed = true; });
    assert.equal(allowed, false); assert.equal(responseStatus, 403);
    assert.equal(session.role, 'staff');
    status = 503; responseStatus = 0;
    await requireAuth(request(), res, () => { throw new Error('上游失败不得放行'); });
    assert.equal(responseStatus, 503);
    status = 403;
    await requireAuth(request(), res, () => { throw new Error('停用不得放行'); });
    assert.equal(responseStatus, 401);
    status = 200;
    await requireAuth(request(), res, () => { throw new Error('失效 token 不得复活'); });
    assert.equal(responseStatus, 401);
    await assert.rejects(collaborationPeople(store), /禁止回退旧账号/);
  } finally {
    destroySession(session.token); globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.SHANGSHU_PLATFORM_MODE; else process.env.SHANGSHU_PLATFORM_MODE = oldMode;
    if (oldUpstream === undefined) delete process.env.FRAPPE_UPSTREAM; else process.env.FRAPPE_UPSTREAM = oldUpstream;
  }
});
