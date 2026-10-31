import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
// P2 业务仪表盘 + 记账接口测试：dashboard/business 聚合、ledger 读、记一笔走事件写总线
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('业务仪表盘 + 记账接口', () => {
  let dir: string; let server: Server; let port: number; let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-dash-'));
    process.env._SS_DATA_DIR = dir;
    const { localStore } = await import('../../src/core/store.ts');
    // 预置：1 张待审发票 + 1 条待确认卡（demo.book 提案）
    await localStore.insert('business', 'invoices', { invoice_no: 'X1', status: '待审', seller_name: '测试', total_amount: 100, invoice_direction: '进项' });

    const { registerActionHandler } = await import('../../src/core/confirm.ts');
    registerActionHandler('demo.book', async () => {});
    await requestConfirmation(localStore, { capability: 'demo.book', entity_type: 'demo', entity_id: 'd1', payload: { n: 1 }, initiator: 'agent' });
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('GET /api/dashboard/business 返回真数据聚合（待审/待确认卡/事件链）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/business`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.pending_invoices, 1);
    assert.equal(d.pending_cards, 1);
    assert.equal(d.booked, 0);
    assert.equal(d.ledger_count, 0);
    assert.equal(d.chain_broken, 0);
    assert.equal(typeof d.events_total, 'number');
    assert.ok(Array.isArray(d.recent_events));
  });

  it('GET /api/ledger 返回记账流水', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('business', 'ledger', { summary: '测试入账', counterparty: '测试公司', total_amount: 100, posted_at: '2026-08-06T00:00:00Z' });
    const res = await fetch(`http://127.0.0.1:${port}/api/ledger`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const { list } = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].counterparty, '测试公司');
  });

  it('POST /api/ledger 记一笔 → 记账表新增 + 事件链（propose→confirm）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { verifyChain } = await import('../../src/core/events.ts');
    const res = await fetch(`http://127.0.0.1:${port}/api/ledger`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: { counterparty: '银舟实业', total_amount: 5000, biz_date: '2026-08-06', summary: '咨询费', direction: '进项' } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const ledger = await localStore.query('business', 'ledger');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].counterparty, '银舟实业');
    assert.equal(ledger[0].total_amount, 5000);
    const evts = await localStore.query('execution', 'events');
    assert.equal(evts.filter((e: any) => e.capability === 'ledger.post').length, 2, '提案 + 确认 两条事件');
    assert.deepEqual(await verifyChain(localStore), []);
  });

  it('未登录 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/business`);
    assert.equal(res.status, 401);
  });
});
