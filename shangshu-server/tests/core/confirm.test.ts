import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
// 确认卡事件化（P1 Task 3）：proposed → confirmed/rejected，handler 执行投影更新
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('确认卡事件化 core/confirm', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-cfm-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('requestConfirmation 生成 proposed 事件；resolve confirmed 执行 handler（投影更新）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation, listPendingConfirmations } = await import('../../src/core/confirm.ts');
    const store: any = localStore;
    let executed = 0;
    registerActionHandler('ledger.post', async (p) => { executed++; await store.insert('business', 'ledger', { amount: p.amount, note: 'confirm 后落库' }); });
    const id = await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1', payload: { amount: 100 }, initiator: 'agent' });
    assert.equal((await listPendingConfirmations(store)).length, 1);
    assert.equal(executed, 0, 'proposed 不应执行 handler');
    await resolveConfirmation(store, id, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    assert.equal(executed, 1, 'confirmed 后执行 handler');
    assert.equal((await listPendingConfirmations(store)).length, 0);
    const led = await store.query('business', 'ledger');
    assert.equal(led.length, 1);
    assert.equal(led[0].amount, 100);
  });

  it('rejected 不执行 handler，且留痕', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const store: any = localStore;
    let executed = 0;
    registerActionHandler('ledger.post', async () => { executed++; });
    const id = await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1', payload: {}, initiator: 'agent' });
    await resolveConfirmation(store, id, 'rejected', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    assert.equal(executed, 0);
    const evts = await store.query('execution', 'events');
    assert.equal(evts.length, 2, '提案 + 拒绝 两条事件');
    assert.equal(evts[1].status, 'rejected');
  });
});

describe('R2 确认卡诚信', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-r2-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('handler 失败 → 记 failed（不消耗提案），待确认列表保留、可重试成功', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation, listPendingConfirmations } = await import('../../src/core/confirm.ts');
    const store: any = localStore;
    let fail = true;
    registerActionHandler('order.ship', async () => {
      if (fail) throw new Error('库存不足：当前 0，需 5');
      await store.insert('business', 'orders', { status: '已完成' });
      return 'ord-1';
    });
    const id = await requestConfirmation(store, { capability: 'order.ship', entity_type: 'order', entity_id: 'ord-1', payload: {}, initiator: 'agent' });
    await assert.rejects(() => resolveConfirmation(store, id, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' }), /库存不足/);
    // 链上留真实结论：failed 事件（带 _error），且没有 _resolves 消耗提案
    const evts = await store.query('execution', 'events');
    const failed = evts.find((e: any) => e.status === 'failed');
    assert.ok(failed, '应有 failed 事件');
    const fp = JSON.parse(failed.payload);
    assert.equal(fp._error, '库存不足：当前 0，需 5');
    assert.equal(fp._resolves, undefined, 'failed 不消耗提案');
    // 提案仍在待确认列表 → 可重试
    assert.equal((await listPendingConfirmations(store)).length, 1);
    fail = false;
    await resolveConfirmation(store, id, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    assert.equal((await listPendingConfirmations(store)).length, 0, '重试成功后提案被消耗');
    const after = await store.query('execution', 'events');
    assert.ok(after.find((e: any) => e.status === 'confirmed' && !e.capability.endsWith('.link')), '重试成功有 confirmed 事件');
  });

  it('重复确认被拒绝（_resolves 查重）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const store: any = localStore;
    registerActionHandler('ledger.post', async () => { await store.insert('business', 'ledger', {}); });
    const id = await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l2', payload: {}, initiator: 'agent' });
    await resolveConfirmation(store, id, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    await assert.rejects(() => resolveConfirmation(store, id, 'confirmed', { id: 'someone', role: 'admin', kind: 'human', channel: 'test' }), /已处理/);
    await assert.rejects(() => resolveConfirmation(store, id, 'rejected', { id: 'someone', role: 'admin', kind: 'human', channel: 'test' }), /已处理/);
    const ledger = await store.query('business', 'ledger');
    assert.equal(ledger.length, 1, 'handler 只执行一次');
  });

  it('executor 语义：confirmed=reviewer，rejected=空（未执行）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const store: any = localStore;
    registerActionHandler('a.b', async () => {});
    const ok = await requestConfirmation(store, { capability: 'a.b', entity_type: 't', entity_id: 'x', payload: {}, initiator: 'agent' });
    await resolveConfirmation(store, ok, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    const no = await requestConfirmation(store, { capability: 'a.b', entity_type: 't', entity_id: 'y', payload: {}, initiator: 'agent' });
    await resolveConfirmation(store, no, 'rejected', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    const evts = await store.query('execution', 'events');
    const conf = evts.find((e: any) => e.status === 'confirmed');
    const rej = evts.find((e: any) => e.status === 'rejected');
    assert.equal(conf.executor, 'wangfang', 'confirmed 执行人=确认人');
    assert.equal(rej.executor, '', 'rejected 未执行');
  });

  it('创建类确认后补 linking 事件：责任链可沿实体真 id 查回', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const { listEventsByEntity } = await import('../../src/core/events.ts');
    const store: any = localStore;
    registerActionHandler('customer.create', async () => 'real-cust-42');
    const id = await requestConfirmation(store, { capability: 'customer.create', entity_type: 'customer', entity_id: 'agent:123', payload: { name: '蓝海' }, initiator: 'agent' });
    await resolveConfirmation(store, id, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });
    const chain = await listEventsByEntity(store, 'customer', 'real-cust-42');
    assert.equal(chain.length, 1, '沿实体真 id 能查到事件');
    assert.equal(chain[0].capability, 'customer.create.link');
    assert.equal((chain[0].payload as any)._links, id, 'link 事件指向提案');
  });
});
