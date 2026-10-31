// A1 测试：AI 写操作参数解析（业务名→事件 payload）与发货编排（shipOrder）。
// 不依赖 LLM：直接测 erp-ops 的解析与执行函数。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('erp-ops：AI 写操作解析与编排（A1）', () => {
  let store: any;
  beforeEach(async () => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-ops-'));
    const { localStore } = await import('../../src/core/store.ts');
    store = localStore;
    const now = new Date().toISOString();
    await store.insert('business', 'customers', { name: '恒泰贸易', status: '启用', created_at: now });
    await store.insert('business', 'customers', { name: '蓝海制造', status: '启用', created_at: now });
    await store.insert('business', 'products', { sku: 'SKU-001', name: '连接件', price: 2.5, cost: 1.8, status: '启用', created_at: now });
    await store.insert('business', 'products', { sku: 'SKU-002', name: '铝型材', price: 10, cost: 6, status: '启用', created_at: now });
  });

  it('order_create：按客户名+SKU 解析 id，价格取产品主档（不信任 LLM）', async () => {
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const r = await resolveConfirmPayload(store, 'order.create', {
      customer_name: '蓝海制造',
      items: [{ product_sku: 'SKU-001', qty: 100 }, { product_sku: 'SKU-002', qty: 5 }],
    });
    assert.equal(r.payload.customer_id, (await store.query('business', 'customers', { name: '蓝海制造' }))[0].id);
    assert.equal(r.payload.items[0].price, 2.5, '价格取产品主档');
    assert.equal(r.payload.items[1].price, 10);
    assert.equal(r.payload.items[0].qty, 100);
  });

  it('order_create：客户不存在 / 产品 SKU 不存在 → 明确错误', async () => {
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    await assert.rejects(
      resolveConfirmPayload(store, 'order.create', { customer_name: '不存在客户', items: [{ product_sku: 'SKU-001', qty: 1 }] }),
      /客户不存在/,
    );
    await assert.rejects(
      resolveConfirmPayload(store, 'order.create', { customer_name: '恒泰贸易', items: [{ product_sku: 'NOPE', qty: 1 }] }),
      /产品不存在/,
    );
  });

  it('order_confirm：按 order_no 解析 order_id', async () => {
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const oid = await store.insert('business', 'orders', { order_no: 'SO-TEST01', customer_id: 'c1', customer_name: '恒泰贸易', status: '草稿', total_amount: 100, note: '', created_at: new Date().toISOString() });
    const r = await resolveConfirmPayload(store, 'order.confirm', { order_no: 'SO-TEST01' });
    assert.equal(r.payload.order_id, oid);
    await assert.rejects(resolveConfirmPayload(store, 'order.confirm', { order_no: 'SO-NOPE' }), /订单不存在/);
  });

  it('receivable_pay：按客户名选余额最大应收，金额不超余额', async () => {
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const now = new Date().toISOString();
    const cust = (await store.query('business', 'customers', { name: '恒泰贸易' }))[0];
    await store.insert('business', 'receivables', { order_id: 'o1', customer_id: cust.id, customer_name: '恒泰贸易', amount: 100, received: 80, status: '部分已收', due_date: '', created_at: now });
    await store.insert('business', 'receivables', { order_id: 'o2', customer_id: cust.id, customer_name: '恒泰贸易', amount: 300, received: 0, status: '未收', due_date: '', created_at: now });
    const r = await resolveConfirmPayload(store, 'receivable.pay', { customer_name: '恒泰贸易', amount: 150 });
    assert.equal(r.payload.amount, 150);
    // 选余额最大（300-0=300 > 100-80=20）那笔
    const recv = (await store.query('business', 'receivables', { id: r.payload.receivable_id }))[0];
    assert.equal(Number(recv.amount), 300);
    // 超出余额 → 错误
    await assert.rejects(
      resolveConfirmPayload(store, 'receivable.pay', { customer_name: '恒泰贸易', amount: 999 }),
      /超出/,
    );
    // 无未结清 → 错误
    await assert.rejects(
      resolveConfirmPayload(store, 'receivable.pay', { customer_name: '蓝海制造', amount: 10 }),
      /没有未结清的应收/,
    );
  });

  it('invoice_book：只放「已入库」发票，出项须先挂客户，payload 取库里的金额', async () => {
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const now = new Date().toISOString();
    const mk = (over: Record<string, any>) => store.insert('business', 'invoices', {
      invoice_code: '044', invoice_no: 'INV-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      invoice_type: '专票', invoice_direction: '进项', seller_name: '云腾五金', buyer_name: '尚书演示',
      total_amount: 1234.56, status: '已入库', created_at: now, updated_at: now, ...over,
    });

    const booked = await mk({ status: '已入库', invoice_no: 'INV-OK01' });
    const r = await resolveConfirmPayload(store, 'invoice.book', { invoice_id: booked });
    assert.equal(r.entity_type, 'invoice');
    assert.equal(r.entity_id, booked);
    assert.equal(r.payload.amount, 1234.56, '金额取库里的记录，不信 LLM 传值');
    assert.equal(r.payload.supplier, '云腾五金', '进项以销方为供应商 → 应付');

    // 按发票号解析（LLM 只知道业务号时）
    const byNo = await resolveConfirmPayload(store, 'invoice.book', { invoice_no: 'INV-OK01' });
    assert.equal(byNo.entity_id, booked);

    await assert.rejects(resolveConfirmPayload(store, 'invoice.book', {}), /invoice_id|invoice_no/);
    await assert.rejects(resolveConfirmPayload(store, 'invoice.book', { invoice_no: 'INV-NOPE' }), /发票不存在/);
    const pending = await mk({ status: '待审', invoice_no: 'INV-PEND1' });
    await assert.rejects(resolveConfirmPayload(store, 'invoice.book', { invoice_id: pending }), /仅「已入库」发票可入账/);
    const done = await mk({ status: '已入账', invoice_no: 'INV-DONE1' });
    await assert.rejects(resolveConfirmPayload(store, 'invoice.book', { invoice_id: done }), /已入账/);
    const outNoCust = await mk({ invoice_direction: '出项', invoice_no: 'INV-OUT01' });
    await assert.rejects(resolveConfirmPayload(store, 'invoice.book', { invoice_id: outNoCust }), /挂客户/);
  });

  it('shipOrder：库存足 → 出库+完成；库存不足 → 报错且库存/订单不变', async () => {
    const { shipOrder } = await import('../../src/core/erp-ops.ts');
    const now = new Date().toISOString();
    const p = (await store.query('business', 'products', { sku: 'SKU-001' }))[0];
    const oid = await store.insert('business', 'orders', { order_no: 'SO-SHIP01', customer_id: 'c1', customer_name: '恒泰贸易', status: '已确认', total_amount: 250, note: '', created_at: now });
    await store.insert('business', 'order_items', { order_id: oid, product_id: p.id, product_name: '连接件', sku: 'SKU-001', qty: 100, price: 2.5, amount: 250 });
    // 库存不足 → 抛错，订单保持已确认
    await assert.rejects(shipOrder(store, oid), /库存不足/);
    let orders = await store.query('business', 'orders', { id: oid });
    assert.equal(orders[0].status, '已确认', '失败发货不得改状态');
    // 补库存 → 发货成功
    await store.insert('business', 'inventory', { product_id: p.id, product_name: '连接件', sku: 'SKU-001', qty: 200, updated_at: now });
    const r = await shipOrder(store, oid);
    assert.equal(r.shipped, 1);
    orders = await store.query('business', 'orders', { id: oid });
    assert.equal(orders[0].status, '已完成');
    const inv = await store.query('business', 'inventory', { product_id: p.id });
    assert.equal(Number(inv[0].qty), 100, '200-100');
    const moves = await store.query('business', 'inventory_movements');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].type, '出库');
    assert.equal(moves[0].ref_type, '发货');
  });
});
