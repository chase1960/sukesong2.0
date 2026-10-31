// 事件写总线 core/events 测试（P1 Task 2）
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('事件写总线 core/events', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-evt-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('append 两条事件，链式相连（第二条 prev_hash = 第一条 hash）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { appendEvent, listEventsByEntity, verifyChain } = await import('../../src/core/events.ts');
    const store: any = localStore;
    await appendEvent(store, { capability: 'invoice.ingest', entity_type: 'invoice', entity_id: 'inv1', payload: { status: '待审' }, initiator: 'trigger' });
    await appendEvent(store, { capability: 'invoice.approve', entity_type: 'invoice', entity_id: 'inv1', payload: { by: 'wang' }, initiator: 'user', status: 'confirmed' });
    const evts = await listEventsByEntity(store, 'invoice', 'inv1');
    assert.equal(evts.length, 2);
    assert.equal(evts[1].prev_hash, evts[0].hash);
    assert.notEqual(evts[0].hash, '');
    const breaks = await verifyChain(store);
    assert.deepEqual(breaks, []);
  });

  it('篡改 payload 后 verifyChain 报断裂', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { appendEvent, verifyChain } = await import('../../src/core/events.ts');
    const store: any = localStore;
    await appendEvent(store, { capability: 'a.b', entity_type: 't', entity_id: 'x', payload: { v: 1 }, initiator: 'user', status: 'confirmed' });
    await appendEvent(store, { capability: 'a.c', entity_type: 't', entity_id: 'x', payload: { v: 2 }, initiator: 'user', status: 'confirmed' });
    // 直接改第一条 payload（绕过 API，模拟手改 bitable）
    const rows = await store.query('execution', 'events');
    await assert.rejects(() => store.update('execution', 'events', rows[0].id, { payload: { v: 999 } }), /append-only/);
    // 校验导入/外部来源的损坏快照，不能为测试绕过存储保护。
    rows[0].payload = { v: 999 };
    const breaks = await verifyChain(store, rows);
    assert.ok(breaks.length >= 1, '篡改后应报断裂');
  });

  it('resolveEvent：proposed → confirmed 填 reviewer', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { appendEvent, resolveEvent } = await import('../../src/core/events.ts');
    const store: any = localStore;
    const id = await appendEvent(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1', payload: { amount: 100 }, initiator: 'agent' });
    const evt = await resolveEvent(store, id, 'confirmed', 'wangfang');
    assert.equal(evt.status, 'confirmed');
    assert.equal(evt.reviewer, 'wangfang');
  });
});
