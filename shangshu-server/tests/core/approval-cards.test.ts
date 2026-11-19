// 审批卡（2026-11-19）：任何中断都要能被登记、推送、就地决策 —— 这里锁住最小的四条不变量。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeForTest as requestConfirmation, testActor } from '../helpers/actor.ts';
import { withActor } from '../../src/core/actor.ts';

describe('统一审批卡 core/approval-cards', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-apc-'));
    process.env._SS_DATA_DIR = dir;
    delete process.env.APPROVAL_WEBHOOK_URL;
  });

  it('pending 提案 → 生成卡片；重复同步不重复登记', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler } = await import('../../src/core/confirm.ts');
    const { syncApprovalCards, listApprovalCards } = await import('../../src/core/approval-cards.ts');
    const store: any = localStore;
    registerActionHandler('ledger.post', async () => {});
    await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1', payload: { amount: 100 }, initiator: 'agent' });
    const first = await syncApprovalCards(store);
    assert.equal(first.created, 1);
    const cards = await listApprovalCards(store);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].level, 'L2', '非 HR 的确认卡固定 L2');
    assert.equal(cards[0].push_status, 'unconfigured', '未配置 webhook 不假装已推送');
    const second = await syncApprovalCards(store);
    assert.equal(second.created, 0, 'dedupe_key 防重复');
  });

  it('从卡片同意 → 执行提案并回写卡状态；待确认列表清空', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, listPendingConfirmations } = await import('../../src/core/confirm.ts');
    const { syncApprovalCards, listApprovalCards, decideApprovalCard } = await import('../../src/core/approval-cards.ts');
    const store: any = localStore;
    let executed = 0;
    registerActionHandler('ledger.post', async () => { executed++; });
    await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l1', payload: {}, initiator: 'agent' });
    await syncApprovalCards(store);
    const [card] = await listApprovalCards(store);
    await withActor(testActor, () => decideApprovalCard(store, card.id, 'confirmed', 'admin'));
    assert.equal(executed, 1);
    assert.equal((await listPendingConfirmations(store)).length, 0);
    const [after] = await store.query('execution', 'approval_cards', { id: card.id });
    assert.equal(after.status, 'approved');
    assert.equal(after.decided_by, 'admin');
    await assert.rejects(() => withActor(testActor, () => decideApprovalCard(store, card.id, 'confirmed', 'admin')), /已处理/);
  });

  it('拒绝卡片 → 不执行，卡状态 rejected', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler } = await import('../../src/core/confirm.ts');
    const { syncApprovalCards, listApprovalCards, decideApprovalCard } = await import('../../src/core/approval-cards.ts');
    const store: any = localStore;
    let executed = 0;
    registerActionHandler('ledger.post', async () => { executed++; });
    await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l2', payload: {}, initiator: 'agent' });
    await syncApprovalCards(store);
    const [card] = await listApprovalCards(store);
    await withActor(testActor, () => decideApprovalCard(store, card.id, 'rejected', 'admin'));
    assert.equal(executed, 0);
    const [after] = await store.query('execution', 'approval_cards', { id: card.id });
    assert.equal(after.status, 'rejected');
  });

  it('提案被别处处理 → 同步关闭卡片，不留僵尸待办', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { registerActionHandler, resolveConfirmation } = await import('../../src/core/confirm.ts');
    const { syncApprovalCards, listApprovalCards } = await import('../../src/core/approval-cards.ts');
    const store: any = localStore;
    registerActionHandler('ledger.post', async () => {});
    const id = await requestConfirmation(store, { capability: 'ledger.post', entity_type: 'ledger', entity_id: 'l3', payload: {}, initiator: 'agent' });
    await syncApprovalCards(store);
    await withActor(testActor, () => resolveConfirmation(store, id, 'confirmed', 'admin'));
    const result = await syncApprovalCards(store);
    assert.equal(result.closed, 1);
    assert.equal((await listApprovalCards(store)).length, 0);
  });
});

