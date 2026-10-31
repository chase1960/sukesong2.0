// R4（2026-08-14）：主动提醒扫描测试（A6 计划缺失的 alerts.test.ts）——逾期应收/库存预警命中 + 去重
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('主动提醒 scanAlerts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-alert-'));
    process.env._SS_DATA_DIR = dir;
  });

  const mkCfg = (overdueDays = 30, minStock = 0) => ({ alerts: { overdue_days: overdueDays, min_stock: minStock } }) as any;

  it('应收逾期命中（超期未收），未逾期不报', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { scanAlerts } = await import('../../src/core/alerts.ts');
    const store: any = localStore;
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const fresh = new Date().toISOString();
    await store.insert('business', 'receivables', { customer_name: '蓝海制造', amount: 1000, received: 0, status: '未收', created_at: old });
    await store.insert('business', 'receivables', { customer_name: '恒泰', amount: 500, received: 0, status: '未收', created_at: fresh });
    const { added } = await scanAlerts(store, mkCfg());
    assert.equal(added, 1, '只报超期一笔');
    const alerts = await store.query('execution', 'alerts');
    assert.equal(alerts[0].type, 'receivable_overdue');
    assert.match(alerts[0].title, /蓝海制造/);
    assert.equal(alerts[0].status, '待处理');
  });

  it('库存预警（低于预警线）命中', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { scanAlerts } = await import('../../src/core/alerts.ts');
    const store: any = localStore;
    await store.insert('business', 'inventory', { product_id: 'p1', product_name: '连接件', sku: 'SKU-1', qty: 3 });
    const { added } = await scanAlerts(store, mkCfg(30, 5));
    assert.equal(added, 1);
    const alerts = await store.query('execution', 'alerts');
    assert.equal(alerts[0].type, 'stock_low');
    assert.match(alerts[0].title, /连接件/);
  });

  it('去重：同引用待处理已存在则不重复生成', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { scanAlerts } = await import('../../src/core/alerts.ts');
    const store: any = localStore;
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    await store.insert('business', 'receivables', { customer_name: '蓝海制造', amount: 1000, received: 0, status: '未收', created_at: old });
    await scanAlerts(store, mkCfg());
    const second = await scanAlerts(store, mkCfg());
    assert.equal(second.added, 0, '待处理已存在，不重复刷屏');
    assert.equal((await store.query('execution', 'alerts')).length, 1);
  });
});
