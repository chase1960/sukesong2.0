import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
// 发票入账事件化（P1 Task 4）：invoice.book 提案 → 人确认 → 记账投影更新，事件链完整无断裂
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('发票入账事件化', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-inv-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('入账产生事件链（propose→confirm），记账表有记录，verifyChain 无断裂', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const { verifyChain } = await import('../../src/core/events.ts');
    const store: any = localStore;
    const invId = await store.insert('business', 'invoices', { invoice_no: 'X1', status: '已入库', seller_name: '测试', total_amount: 100, invoice_direction: '进项' });

    // 低置信：走确认卡
    registerActionHandler('invoice.book', async (p) => {
      await store.update('business', 'invoices', invId, { status: '已入账', ledger_ref: String(p.ledger_ref ?? '') });
      await store.insert('business', 'ledger', { invoice_id: invId, amount: p.amount, note: '确认入账' });
    });
    const eid = await requestConfirmation(store, { capability: 'invoice.book', entity_type: 'invoice', entity_id: invId, payload: { amount: 100 }, initiator: 'agent' });
    await resolveConfirmation(store, eid, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });

    const inv = (await store.query('business', 'invoices', { id: invId }))[0];
    assert.equal(inv.status, '已入账');
    const led = await store.query('business', 'ledger');
    assert.equal(led.length, 1);
    assert.deepEqual(await verifyChain(store), []);
  });
});
