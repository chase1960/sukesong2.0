import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('auth 地基', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-auth-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('密码哈希：加盐、可验、错密码拒绝', async () => {
    const { hashPassword, verifyPassword } = await import('../../src/core/auth/users.ts');
    const h1 = hashPassword('secret');
    const h2 = hashPassword('secret');
    assert.notEqual(h1, h2);                    // 每次加盐不同
    assert.ok(h1.startsWith('scrypt:'));
    assert.ok(verifyPassword('secret', h1));
    assert.ok(!verifyPassword('wrong', h1));
    assert.ok(!verifyPassword('secret', 'garbage'));
  });

  it('用户 CRUD + bootstrap + 重名拒绝', async () => {
    const { createUser, findUser, ensureBootstrap, listUsers } = await import('../../src/core/auth/users.ts');
    const { localStore } = await import('../../src/core/store.ts');

    await ensureBootstrap(localStore);           // 空库 → 建 admin
    let users = await listUsers(localStore);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'admin');
    assert.equal(users[0].role, 'admin');

    await ensureBootstrap(localStore);           // 幂等：不再建
    users = await listUsers(localStore);
    assert.equal(users.length, 1);

    const admin = await findUser(localStore, 'admin');
    const { verifyPassword } = await import('../../src/core/auth/users.ts');
    assert.ok(verifyPassword('admin', admin!.password_hash));

    await createUser(localStore, { username: 'wangxin', password: 'pw123456', role: 'finance', display_name: '王馨' });
    const w = await findUser(localStore, 'wangxin');
    assert.equal(w!.role, 'finance');
    assert.ok(verifyPassword('pw123456', w!.password_hash));

    await assert.rejects(() => createUser(localStore, { username: 'wangxin', password: 'x', role: 'staff' }), /已存在/);
    await assert.rejects(() => createUser(localStore, { username: 'bad', password: 'x', role: 'root' as any }), /非法角色/);
  });

  it('session：签发/读取/销毁/过期', async () => {
    const { createSession, getSession, destroySession } = await import('../../src/core/auth/session.ts');
    const s = createSession({ username: 'admin', role: 'admin', display_name: '管理员' });
    assert.ok(getSession(s.token));
    assert.equal(getSession(s.token)!.role, 'admin');
    destroySession(s.token);
    assert.equal(getSession(s.token), null);
    assert.equal(getSession('nonexistent'), null);
    assert.equal(getSession(undefined), null);
  });

  it('requireRole：未登录 401 / 角色不符 403 / admin 放行 / 命中放行', async () => {
    const { requireRole, parseCookies } = await import('../../src/core/auth/guard.ts');
    const { createSession } = await import('../../src/core/auth/session.ts');
    const fin = createSession({ username: 'wangxin', role: 'finance', display_name: '王馨' });
    const {localStore}=await import('../../src/core/store.ts');
    for(const [username,role] of [['wangxin','finance'],['s','staff'],['a','admin']]) await localStore.insert('cognition','users',{username,role,status:'启用'});

    const run = (cookie: string | undefined, mw: any) => new Promise<{ status: number; next: boolean }>((resolve) => {
      const req: any = { headers: cookie ? { cookie } : {} };
      const res: any = { status(c: number) { this.code = c; return this; }, json() { resolve({ status: this.code, next: false }); } };
      mw(req, res, () => resolve({ status: 200, next: true }));
    });

    assert.ok(parseCookies('shangshu_token=abc; x=1').shangshu_token === 'abc');
    const guard = requireRole('finance');
    assert.deepEqual(await run(undefined, guard), { status: 401, next: false });
    const staff = createSession({ username: 's', role: 'staff', display_name: 's' });
    assert.deepEqual(await run(`shangshu_token=${staff.token}`, guard), { status: 403, next: false });
    assert.deepEqual(await run(`shangshu_token=${fin.token}`, guard), { status: 200, next: true });
    const adminS = createSession({ username: 'a', role: 'admin', display_name: 'a' });
    assert.deepEqual(await run(`shangshu_token=${adminS.token}`, guard), { status: 200, next: true });  // admin 放行一切
    const [live]=await localStore.query('cognition','users',{username:'wangxin'});
    await localStore.update('cognition','users',live.id,{role:'staff'});
    assert.deepEqual(await run(`shangshu_token=${fin.token}`, guard), {status:403,next:false},'旧 session 不能保留已撤回角色');
    await localStore.update('cognition','users',live.id,{status:'停用'});
    assert.deepEqual(await run(`shangshu_token=${fin.token}`, guard), {status:401,next:false});
  });

  it('审计写入事件流（P1：execution.events，替代 operation_logs 新增写入）', async () => {
    const { audit } = await import('../../src/core/auth/audit.ts');
    const { localStore } = await import('../../src/core/store.ts');
    const { createSession } = await import('../../src/core/auth/session.ts');
    const s = createSession({ username: 'wangxin', role: 'finance', display_name: '王馨' });
    await audit(localStore, s, 'invoice.review', 'rec123', '{"status":"已入库"}');
    const rows = await localStore.query('execution', 'events');
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).capability, 'invoice.review');
    assert.equal((rows[0] as any).initiator, 'wangxin');
    assert.equal((rows[0] as any).status, 'confirmed');
    const logs = await localStore.query('execution', 'operation_logs');
    assert.equal(logs.length, 0, 'operation_logs 不再新增写入');
  });
});

describe('R0：改密 + query 契约 sort/limit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-r0-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('updatePassword：哈希落库且能验证新密码；短密码拒绝', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { createUser, updatePassword, verifyPassword } = await import('../../src/core/auth/users.ts');
    const id = await createUser(localStore, { username: 'pwtest', password: 'old-pass-1', role: 'staff', display_name: '改密测试' });
    await assert.rejects(() => updatePassword(localStore, id, '123'), /至少 6 位/);
    await updatePassword(localStore, id, 'new-pass-9');
    const row = (await localStore.query('cognition', 'users', { id }))[0] as any;
    assert.ok(verifyPassword('new-pass-9', row.password_hash), '新密码可验证');
    assert.ok(!verifyPassword('old-pass-1', row.password_hash), '旧密码失效');
  });

  it('query 契约：sort desc + limit 生效（local 实现）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    for (const v of [3, 1, 2]) await localStore.insert('execution', 'events', { v, created_at: `2026-08-01T00:00:0${v}Z` });
    const sorted = await localStore.query('execution', 'events', undefined, { sort: { key: 'created_at', dir: 'desc' }, limit: 2 });
    assert.equal(sorted.length, 2);
    assert.equal(sorted[0].v, 3);
    assert.equal(sorted[1].v, 2);
    // 不传 opts 行为不变（全量返回）
    const all = await localStore.query('execution', 'events');
    assert.equal(all.length, 3);
  });
});
