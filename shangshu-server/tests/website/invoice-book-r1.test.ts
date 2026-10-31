import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
// R1 主链测试（2026-08-14）：发票入账按方向联动台账——出项→应收挂客户，进项→应付（供应商=销方）。
// 演示故事「收票 → 入账 → 应收自动出现」的后端验证。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('R1 发票入账联动台账', () => {
  let dir: string; let server: Server; let port: number; let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-r1-'));
    process.env._SS_DATA_DIR = dir;
    const { localStore } = await import('../../src/core/store.ts');
    // 预置：客户「蓝海制造」+ 两张发票（出项/进项各一）
    const custId = await localStore.insert('business', 'customers', { name: '蓝海制造', contact: '', phone: '', address: '', status: '启用', created_at: new Date().toISOString() });
    const invOut = await localStore.insert('business', 'invoices', {
      invoice_no: 'OUT-001', invoice_direction: '出项', seller_name: '尚书科技', buyer_name: '蓝海制造',
      total_amount: 1250, status: '已入库', received_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    const invIn = await localStore.insert('business', 'invoices', {
      invoice_no: 'IN-001', invoice_direction: '进项', seller_name: '恒泰供应商', buyer_name: '尚书科技',
      total_amount: 800, status: '已入库', received_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    (globalThis as any).__R1_TEST__ = { custId, invOut, invIn };
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin","password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('出项发票入账 → 应收自动出现（挂客户，金额正确）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { invOut, custId } = (globalThis as any).__R1_TEST__;
    const res = await fetch(`http://127.0.0.1:${port}/api/invoices/${invOut}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '已入账', customer_id: custId }),
    });
    assert.equal(res.status, 200, await res.text());
    const recvs = await localStore.query('business', 'receivables');
    assert.equal(recvs.length, 1);
    assert.equal(recvs[0].invoice_id, invOut);
    assert.equal(recvs[0].customer_id, custId);
    assert.equal(recvs[0].customer_name, '蓝海制造');
    assert.equal(Number(recvs[0].amount), 1250);
    assert.equal(recvs[0].status, '未收');
    // 发票状态已翻转为已入账
    const inv = (await localStore.query('business', 'invoices', { id: invOut }))[0] as any;
    assert.equal(inv.status, '已入账');
  });

  it('出项发票无客户入账 → 明确报错，不生成应收', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { invOut } = (globalThis as any).__R1_TEST__;
    const res = await fetch(`http://127.0.0.1:${port}/api/invoices/${invOut}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已入账' }),
    });
    assert.equal(res.status, 500);
    const j = await res.json();
    assert.match(j.error, /挂客户/);
    assert.equal((await localStore.query('business', 'receivables')).length, 0);
  });

  it('进项发票入账 → 应付自动出现（供应商=销方）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { invIn } = (globalThis as any).__R1_TEST__;
    const res = await fetch(`http://127.0.0.1:${port}/api/invoices/${invIn}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已入账' }),
    });
    assert.equal(res.status, 200, await res.text());
    const pays = await localStore.query('business', 'payables');
    assert.equal(pays.length, 1);
    assert.equal(pays[0].invoice_id, invIn);
    assert.equal(pays[0].supplier, '恒泰供应商');
    assert.equal(Number(pays[0].amount), 800);
    assert.equal(pays[0].status, '未付');
  });

  it('同一发票堆两张 AI 确认卡：第二张确认失败，记账表不多一条', async () => {
    const { localStore } = await import('../../src/core/store.ts');

    const { invIn } = (globalThis as any).__R1_TEST__;
    const mkCard = () => requestConfirmation(localStore, {
      capability: 'invoice.book', entity_type: 'invoice', entity_id: invIn,
      payload: { invoice_id: invIn, amount: 800, invoice_no: 'IN-001', seller_name: '恒泰供应商', supplier: '恒泰供应商' },
      initiator: 'agent',
    });
    const card1 = await mkCard();
    const card2 = await mkCard();
    const resolve = (id: string) => fetch(`http://127.0.0.1:${port}/api/confirmations/${id}`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"decision":"confirmed"}',
    });
    assert.equal((await resolve(card1)).status, 200);
    const second = await resolve(card2);
    assert.equal(second.status, 500, '迟到的确认卡必须失败');
    assert.match((await second.json()).error, /确认对象已变化/);
    assert.equal((await localStore.query('business', 'ledger')).length, 1, '记账表只应有一条');
    assert.equal((await localStore.query('business', 'payables')).length, 1, '应付只应有一条');
  });

  it('同一发票重复入账被阻止（状态机 + 幂等锁）', async () => {
    const { invIn } = (globalThis as any).__R1_TEST__;
    const first = await fetch(`http://127.0.0.1:${port}/api/invoices/${invIn}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已入账' }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`http://127.0.0.1:${port}/api/invoices/${invIn}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已入账' }),
    });
    assert.equal(second.status, 409, '重复入账应被幂等锁拒绝');
  });
});
