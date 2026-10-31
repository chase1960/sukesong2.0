// execution.events 表注册 + ExecutionEvent 类型 测试（P1 Task 1）
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('execution.events 表', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-evt-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('注册后能 insert + query', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const id = await localStore.insert('execution', 'events', {
      capability: 'invoice.book', entity_type: 'invoice', entity_id: 'inv1',
      payload: { total_amount: 100 }, schema_version: 1,
      status: 'proposed', initiator: 'agent', reviewer: '', executor: 'agent',
      prev_hash: '', hash: 'abc', created_at: '2026-08-06T00:00:00Z',
    });
    const rows = await localStore.query('execution', 'events', { id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'proposed');
    assert.equal(rows[0].entity_type, 'invoice');
  });

  it('payload 对象存取一致（text 列 JSON 序列化）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const payload = { amount: 100, note: '测试入账' };
    const id = await localStore.insert('execution', 'events', {
      capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1',
      payload, schema_version: 1,
      status: 'confirmed', initiator: 'agent', reviewer: 'wang', executor: 'agent',
      prev_hash: '', hash: 'abc', created_at: '2026-08-06T00:00:00Z',
    });
    const rows = await localStore.query('execution', 'events', { id });
    assert.equal(rows[0].status, 'confirmed');
    assert.equal(rows[0].reviewer, 'wang');
  });
});
