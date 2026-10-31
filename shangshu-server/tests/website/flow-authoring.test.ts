// HTTP：元数据读写形状 + 新建流程 + 任务验收跑通
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('流程发布 HTTP 闭环', () => {
  let server: any; let port: number; let cookie: string;

  beforeEach(async () => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-flow-http-'));
    const { registerObjectTools } = await import('../../src/capabilities/object-tools.ts');
    const { registerMetadataTools } = await import('../../src/capabilities/metadata-tools.ts');
    registerObjectTools();
    registerMetadataTools();
    const { localStore } = await import('../../src/core/store.ts');
    const { bootstrapMetadata } = await import('../../src/core/meta-store.ts');
    await bootstrapMetadata(localStore);
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp({ ocr: {} as any, mail: {} as any });
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin","password":"admin"}',
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  });
  afterEach(() => { server?.close(); });

  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { cookie, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
    return { status: res.status, body: await res.json() };
  };

  it('GET metadata 返回 payload + version，画布可按此发布', async () => {
    const { status, body } = await json('/api/metadata/flow/flow.task-acceptance');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'flow');
    assert.ok(body.payload?.graph?.nodes?.length);
    assert.equal(typeof body.version, 'number');
    assert.ok(body.version >= 1);
    assert.equal(body.entry.payload.id, 'flow.task-acceptance');
    assert.equal(body.entry.version, body.version);
  });

  it('新建骨架 → 带 version 再发布 → 发起跑完', async () => {
    const created = await json('/api/workflows', { method: 'POST', body: JSON.stringify({ id: 'flow.http-loop', name: 'HTTP 自测' }) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.version, 1);
    const got = await json('/api/metadata/flow/flow.http-loop');
    const payload = { ...got.body.payload, name: 'HTTP 自测 v2' };
    const draft = await json('/api/metadata/drafts', { method: 'POST', body: JSON.stringify({ kind: 'flow', key: 'flow.http-loop', payload }) });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const pub = await json(`/api/metadata/drafts/${draft.body.id}/publish`, {
      method: 'POST', body: JSON.stringify({ expected_revision: got.body.version }),
    });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.revision, 2);
    const run = await json('/api/workflows/flow.http-loop/run', { method: 'POST', body: JSON.stringify({ input: { summary: '跑一下' } }) });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.run.status, 'completed');
  });

  it('任务验收 HTTP：发起等待审批，管理员代审后完成', async () => {
    const run = await json('/api/workflows/flow.task-acceptance/run', {
      method: 'POST', body: JSON.stringify({ input: { title: '盘点库存' } }),
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.run.status, 'waiting');
    const pending = await json('/api/workflows/approvals');
    assert.ok(pending.body.list?.length >= 1);
    const task = pending.body.list.find((t: any) => t.run_id === run.body.run.id);
    assert.ok(task);
    const decided = await json(`/api/workflows/approvals/${task.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.run.status, 'completed');
  });

  it('用错 expected_revision 发布已有流程返回冲突', async () => {
    const got = await json('/api/metadata/flow/flow.expense-approval');
    const draft = await json('/api/metadata/drafts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'flow', key: 'flow.expense-approval', payload: got.body.payload }),
    });
    const pub = await json(`/api/metadata/drafts/${draft.body.id}/publish`, {
      method: 'POST', body: JSON.stringify({ expected_revision: 0 }),
    });
    assert.equal(pub.status, 409);
  });
});
