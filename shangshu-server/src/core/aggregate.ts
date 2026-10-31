// 经营数据聚合（A3 2026-08-10）：看板与每日简报共用同一聚合函数，保证数字一致。
import type { StateStore } from './types.ts';

export interface BusinessSummary {
  order_count: number;
  order_pending: number;
  order_confirmed: number;
  order_completed: number;
  receivable_balance: number;   // 应收未收总额
  payable_balance: number;      // 应付未付总额
  inventory_sku: number;        // 有货 SKU 数
  gross_profit: number;         // 已完成订单毛利
  events_total: number;
  chain_broken: number;
}

export async function aggregateBusiness(store: StateStore): Promise<BusinessSummary> {
  const [orders, orderItems, products, inventory, receivables, payables, events] = await Promise.all([
    store.query('business', 'orders'),
    store.query('business', 'order_items'),
    store.query('business', 'products'),
    store.query('business', 'inventory'),
    store.query('business', 'receivables'),
    store.query('business', 'payables'),
    store.query('execution', 'events'),
  ]);
  const num = (v: any): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };
  // 毛利（已完成订单）：Σ 明细 (售价-成本)×数量
  const productCost = new Map(products.map((p: any) => [p.id, num(p.cost)]));
  let grossProfit = 0;
  for (const o of orders) {
    if (o.status !== '已完成') continue;
    for (const it of orderItems) {
      if (it.order_id === o.id) grossProfit += (num(it.price) - (productCost.get(String(it.product_id)) || 0)) * num(it.qty);
    }
  }
  const recvBalance = receivables.reduce((s: number, r: any) => s + (num(r.amount) - num(r.received)), 0);
  const payBalance = payables.reduce((s: number, r: any) => s + (num(r.amount) - num(r.paid)), 0);
  return {
    order_count: orders.length,
    order_pending: orders.filter((o: any) => o.status === '草稿').length,
    order_confirmed: orders.filter((o: any) => o.status === '已确认').length,
    order_completed: orders.filter((o: any) => o.status === '已完成').length,
    receivable_balance: Math.round(recvBalance * 100) / 100,
    payable_balance: Math.round(payBalance * 100) / 100,
    inventory_sku: inventory.filter((i: any) => num(i.qty) > 0).length,
    gross_profit: Math.round(grossProfit * 100) / 100,
    events_total: events.length,
    chain_broken: 0,   // 由调用方（dashboard）另行 verifyChain 覆盖
  };
}
