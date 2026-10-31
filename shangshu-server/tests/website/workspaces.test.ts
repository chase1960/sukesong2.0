// 工作区测试（2026-08-10）：模板列表（角色可见）+ 用户启用/停用 + 个人自定义工作区 + 权限。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

describe('/api/workspaces 工作区', () => {
  let dir: string; let server: Server; let port: number;
  const loginAs = async (username: string, password: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return r.headers.get('set-cookie') || '';
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-ws-'));
    process.env._SS_DATA_DIR = dir;
    const { localStore } = await import('../../src/core/store.ts');
    const { ensureBootstrap, createUser } = await import('../../src/core/auth/users.ts');
    await ensureBootstrap(localStore as any);
    await createUser(localStore as any, { username: 'staff1', password: 'test123', role: 'staff', display_name: '员工一' }).catch(() => {});
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
  });
  afterEach(() => { server.close(); });

  it('GET /api/workspaces：admin 可见全部模板；staff 只见销售/协作（角色过滤）', async () => {
    const adminCookie = await loginAs('admin', 'admin');
    const staffCookie = await loginAs('staff1', 'test123');
    const a = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { cookie: adminCookie } })).json();
    assert.ok(a.templates.length >= 6, 'admin 应可见全部预设模板');
    assert.deepEqual(a.enabled, ['boss', 'admin', 'finance', 'sales', 'supply', 'collab'], 'admin 默认全启用');
    const s = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { cookie: staffCookie } })).json();
    const staffIds = s.templates.map((w: any) => w.id);
    assert.ok(staffIds.includes('sales') && staffIds.includes('collab'), 'staff 可见销售+协作');
    assert.ok(!staffIds.includes('admin'), 'staff 不可见管理员工作区');
    assert.deepEqual(s.enabled, ['sales', 'collab'], 'staff 默认启用');
  });

  it('PATCH /api/me/workspaces：用户启用/停用 + 个人自定义工作区', async () => {
    const cookie = await loginAs('admin', 'admin');
    // 只启用 boss + 一个自定义
    const custom = [{ id: 'my-1', name: '我的日报', modules: ['dash', 'chat', 'review'] }];
    const r = await fetch(`http://127.0.0.1:${port}/api/me/workspaces`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['boss'], custom }),
    });
    assert.equal((await r.json()).ok, true);
    const d = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { cookie } })).json();
    assert.deepEqual(d.enabled, ['boss']);
    assert.equal(d.custom.length, 1);
    assert.equal(d.custom[0].name, '我的日报');
    assert.deepEqual(d.custom[0].modules, ['dash', 'chat', 'review']);
  });

  it('PATCH 非法工作区 id → 400；未登录 → 401', async () => {
    const cookie = await loginAs('admin', 'admin');
    const bad = await fetch(`http://127.0.0.1:${port}/api/me/workspaces`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['nope'] }),
    });
    assert.equal(bad.status, 400);
    const anon = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    assert.equal(anon.status, 401);
  });

  it('PUT /api/workspaces：admin 可保存模板；staff 403', async () => {
    const adminCookie = await loginAs('admin', 'admin');
    const staffCookie = await loginAs('staff1', 'test123');
    const list = [{ id: 'my-team', name: '团队工作区', desc: '测试', roles: [], modules: ['chat', 'dash'], preset: false }];
    const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'PUT', headers: { cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaces: list }),
    });
    assert.equal((await r.json()).ok, true);
    const staff = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'PUT', headers: { cookie: staffCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaces: list }),
    });
    assert.equal(staff.status, 403);
  });
});
