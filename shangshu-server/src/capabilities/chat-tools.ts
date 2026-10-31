import {businessDate, cashSummary} from './finance-domain.ts';
// AI 对话查询能力（P4）：发票/记账查询 —— 只读工具，供对话 harness 调用。
// 与业务只读页面共用同一 StateStore 查询，保证「对话答的是真数据」。
import { registerCapability } from '../core/registry.ts';
import type { Capability } from '../core/types.ts';

export interface QueryFilter {
  status?: string;          // 发票状态
  counterparty?: string;    // 对方单位（模糊匹配）
  date_from?: string;       // YYYY-MM-DD（按 received_at / posted_at 过滤）
  date_to?: string;
}

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

// —— 资金总览（2026-08-19）：老板第一问「收了多少/付了多少/净进多少/多少钱在外面」。
// 口径：收/支仅汇总实际收付款追加流水（按 occurred_on，默认本月）；
// 在外 = 应收未收 + 应付未付（全量台账，不受期间限制）。——
const cashflowQuery: Capability<any, any> = {
  id: 'cashflow.query', revision:2, name: '查询资金总览', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) { return cashSummary(ctx.store,input); },
};

// —— 发票明细（2026-08-19）：按发票号码精确查 / 按公司名模糊查，返回完整字段。
// 对话审核场景（「这张发票税额多少」「某某公司的票明细」）数据源。——
const invoiceDetail: Capability<any, any> = {
  id: 'invoice.detail', name: '查询发票明细', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'invoices');
    const no = String(input.invoice_no || '').trim();
    const kw = String(input.keyword || '').trim();
    const list = rows.filter((r: any) => {
      if (no) return String(r.invoice_no || '') === no;
      if (kw) return String(r.seller_name || '').includes(kw) || String(r.buyer_name || '').includes(kw);
      return false;
    });
    return {
      count: list.length,
      invoices: list.slice(0, 10).map((r: any) => ({
        id: r.id, invoice_no: r.invoice_no, invoice_type: r.invoice_type,
        direction: r.invoice_direction, seller_name: r.seller_name, buyer_name: r.buyer_name,
        amount_ex_tax: num(r.amount_ex_tax), tax_amount: num(r.tax_amount), total_amount: num(r.total_amount),
        issued_at: r.issued_at, status: r.status, confidence: num(r.confidence), received_at: r.received_at,
      })),
    };
  },
};

// —— 项目查询（2026-08-19）：记账挂项目 / 按项目汇总前的名称确认 ——
const projectQuery: Capability<any, any> = {
  id: 'project.query', name: '查询项目', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'projects');
    const list = rows.filter((r: any) => {
      if (input.name && !String(r.name || '').includes(String(input.name))) return false;
      return true;
    });
    return {
      count: list.length,
      projects: list.slice(0, 20).map((p: any) => ({ name: p.name, customer_id: p.customer_id, status: p.status, desc: p.desc })),
    };
  },
};

// —— 毛利查询（2026-08-19）：订单口径毛利——已确认/已完成订单的 销售收入-销售成本。
// 成本取产品主档 cost（与采购计价同源），收入取订单明细成交价（服务端重算过的，非前端传值）。
// 回答「这个月赚了多少钱」「毛利多少」「哪个客户/产品赚钱」。——
const profitQuery: Capability<any, any> = {
  id: 'profit.query', name: '查询毛利', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const today = businessDate();
    const from = input.date_from || today.slice(0, 7) + '-01';
    const to = input.date_to || today;
    const orders = (await ctx.store.query('business', 'orders') as any[])
      .filter((o) => o.status !== '已取消' && o.status !== '草稿')
      .filter((o) => { const d = String(o.created_at || '').slice(0, 10); return d >= from && d <= to; });
    const items = await ctx.store.query('business', 'order_items') as any[];
    const products = await ctx.store.query('business', 'products') as any[];
    const costOf = new Map(products.map((p) => [String(p.id), num(p.cost)]));
    const orderIds = new Set(orders.map((o) => String(o.id)));
    let revenue = 0, cost = 0;
    const byProduct = new Map<string, { name: string; revenue: number; profit: number }>();
    for (const it of items) {
      if (!orderIds.has(String(it.order_id))) continue;
      const rev = num(it.amount) || num(it.qty) * num(it.price);
      const c = num(it.qty) * (costOf.get(String(it.product_id)) ?? 0);
      revenue += rev; cost += c;
      const key = String(it.product_id);
      const cur = byProduct.get(key) || { name: String(it.product_name || key), revenue: 0, profit: 0 };
      cur.revenue += rev; cur.profit += rev - c;
      byProduct.set(key, cur);
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const profit = revenue - cost;
    return {
      period: { from, to },
      order_count: orders.length,
      revenue: r2(revenue), cost: r2(cost), gross_profit: r2(profit),
      margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      top_products: [...byProduct.values()].sort((a, b) => b.profit - a.profit).slice(0, 5)
        .map((p) => ({ name: p.name, revenue: r2(p.revenue), profit: r2(p.profit) })),
      note: '口径：已确认/已完成订单，成本按产品主档 cost；草稿/已取消不计',
    };
  },
};

// —— 待办审批（2026-08-19）：当前挂起的确认卡（谁都能问「我有什么要批的」）。
// 数据源与确认卡页一致（listPendingConfirmations：proposed 且未被 _resolves 决议）。——
const confirmationQuery: Capability<any, any> = {
  id: 'confirmation.query', name: '查询待办审批', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const { listPendingConfirmations } = await import('../core/confirm.ts');
    const pending = await listPendingConfirmations(ctx.store);
    return {
      pending_count: pending.length,
      items: pending.slice(0, 10).map((e: any) => ({
        id: e.id, capability: e.capability, entity_type: e.entity_type,
        initiator: e.initiator, created_at: e.created_at,
        summary: e.payload?.summary || e.payload?.invoice_no || e.payload?.order_no || e.payload?.name || e.payload?.customer_name || e.payload?.supplier || '',
        amount: num(e.payload?.total_amount ?? e.payload?.amount),
      })),
      note: pending.length ? '让对话执行对应写操作可重新提案；到确认卡页可逐条同意/拒绝' : '没有待审批的事项',
    };
  },
};

// —— 历史习惯推荐（2026-08-19，渐进吸收小功能）：按对方单位查历史记账习惯。
// 只读推荐，不改任何行为；阈值 runtime_config.habit.min_count（默认 3）。
// ⚠ 维护注意同 erp-ops.suggestLedgerHabit：推荐逻辑只服务 ledger.post，勿扩展到别的单据。
const habitSuggest: Capability<any, any> = {
  id: 'habit.suggest', name: '历史习惯推荐', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const { suggestLedgerHabit, HABIT_MIN_COUNT_DEFAULT } = await import('../core/erp-ops.ts');
    const minCount = Number((ctx as any).config?.habit?.min_count) || HABIT_MIN_COUNT_DEFAULT;
    const h = await suggestLedgerHabit(ctx.store, String(input.counterparty || ''), minCount);
    return h
      ? { found: true, category: h.category, account_subject: h.account_subject, direction: h.direction, count: h.count, min_count: minCount }
      : { found: false, min_count: minCount, note: `该单位历史记账不足 ${minCount} 次或无科目记录，暂无推荐` };
  },
};

// —— invoice.query：按状态/时间范围汇总发票（真数据）——
const invoiceQuery: Capability<QueryFilter, any> = {
  id: 'invoice.query', name: '查询发票', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'invoices');
    const list = rows.filter((r: any) => {
      if (input.status && r.status !== input.status) return false;
      if (input.date_from && String(r.received_at || '').slice(0, 10) < input.date_from) return false;
      if (input.date_to && String(r.received_at || '').slice(0, 10) > input.date_to) return false;
      return true;
    });
    const total = list.reduce((s: number, r: any) => s + num(r.total_amount), 0);
    const byStatus: Record<string, number> = {};
    for (const r of list) byStatus[r.status || '未知'] = (byStatus[r.status || '未知'] || 0) + 1;
    return {
      count: list.length,
      total_amount: Math.round(total * 100) / 100,
      by_status: byStatus,
      sample: list.slice(0, 10).map((r: any) => ({
        invoice_no: r.invoice_no, seller_name: r.seller_name,
        total_amount: num(r.total_amount), status: r.status, received_at: r.received_at,
      })),
    };
  },
};

// —— ledger.query：记账流水汇总（真数据）——
const ledgerQuery: Capability<QueryFilter, any> = {
  id: 'ledger.query', name: '查询记账', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'ledger');
    const list = rows.filter((r: any) => {
      const at = String(r.posted_at || r.created_at || '');
      if (input.date_from && at.slice(0, 10) < input.date_from) return false;
      if (input.date_to && at.slice(0, 10) > input.date_to) return false;
      if (input.counterparty && !String(r.counterparty || '').includes(input.counterparty)) return false;
      return true;
    });
    const total = list.reduce((s: number, r: any) => s + num(r.total_amount), 0);
    const byDirection: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const r of list) {
      const d = r.direction || '未知';
      byDirection[d] = Math.round(((byDirection[d] || 0) + num(r.total_amount)) * 100) / 100;
      const cat = String((r as any).category || '');
      if (cat) byCategory[cat] = Math.round(((byCategory[cat] || 0) + num(r.total_amount)) * 100) / 100;
    }
    return {
      count: list.length,
      total_amount: Math.round(total * 100) / 100,
      by_direction: byDirection,
      by_category: byCategory,
      sample: list.slice(0, 10).map((r: any) => ({
        id: r.id,
        summary: r.summary, counterparty: r.counterparty,
        total_amount: num(r.total_amount), direction: r.direction,
        category: r.category || '', account_subject: r.account_subject || '', project_id: r.project_id || '',
        biz_date: r.biz_date, posted_at: r.posted_at,
      })),
    };
  },
};

// —— 应收台账查询（M5）：应收余额 Top + 未收总额。对话「谁欠我们钱最多」数据源。——
// R1 后口径：台账 = 订单确认 + 出项发票入账 共同生成（来源可溯源），答的是这张真台账。
const receivableQuery: Capability<any, any> = {
  id: 'receivable.query', name: '查询应收', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const rows = await ctx.store.query('business', 'receivables');
    const byCustomer = new Map<string, { customer_name: string; amount: number; received: number }>();
    for (const r of rows as any[]) {
      const key = String(r.customer_id || '');
      const cur = byCustomer.get(key) || { customer_name: String(r.customer_name || ''), amount: 0, received: 0 };
      cur.amount = Math.round((cur.amount + num(r.amount)) * 100) / 100;
      cur.received = Math.round((cur.received + num(r.received)) * 100) / 100;
      byCustomer.set(key, cur);
    }
    const agg = [...byCustomer.values()].map((c) => ({
      customer_name: c.customer_name, receivable: c.amount, received: c.received,
      balance: Math.round((c.amount - c.received) * 100) / 100,
    })).sort((a, b) => b.balance - a.balance);
    const totalBalance = agg.reduce((s, c) => s + c.balance, 0);
    // 账龄桶（2026-08-19）：与 alerts 逾期口径一致——基准日 = due_date，缺省 = created_at + 账期
    // （runtime_config.alerts.overdue_days，默认 30 天）；按未清余额归入 未逾期/1-30/31-60/61-90/90+ 天。
    const overdueDays = Number((ctx as any).config?.alerts?.overdue_days) || 30;
    const aging: Record<string, number> = { '未逾期': 0, '逾期1-30天': 0, '逾期31-60天': 0, '逾期61-90天': 0, '逾期90天以上': 0 };
    const now = Date.now();
    for (const r of rows as any[]) {
      const balance = num(r.amount) - num(r.received);
      if (balance <= 0) continue;
      const due = r.due_date
        ? new Date(String(r.due_date).slice(0, 10) + 'T00:00:00').getTime()
        : new Date(String(r.created_at || '')).getTime() + overdueDays * 86400000;
      const days = Math.floor((now - due) / 86400000);
      const bucket = days <= 0 ? '未逾期' : days <= 30 ? '逾期1-30天' : days <= 60 ? '逾期31-60天' : days <= 90 ? '逾期61-90天' : '逾期90天以上';
      aging[bucket] = Math.round((aging[bucket] + balance) * 100) / 100;
    }
    return { total_unreceived: Math.round(totalBalance * 100) / 100, aging, by_customer: agg.slice(0, 10), receivable_count: rows.length };
  },
};

// —— 订单查询（M6）：订单汇总/进度 ——
const orderQuery: Capability<any, any> = {
  id: 'order.query', name: '查询订单', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'orders');
    const list = rows.filter((r: any) => {
      if (input.status && r.status !== input.status) return false;
      if (input.customer_name && !String(r.customer_name || '').includes(input.customer_name)) return false;
      return true;
    });
    const total = list.reduce((s: number, r: any) => s + num(r.total_amount), 0);
    const byStatus: Record<string, number> = {};
    for (const r of list) byStatus[r.status || '未知'] = (byStatus[r.status || '未知'] || 0) + 1;
    return {
      count: list.length, total_amount: Math.round(total * 100) / 100, by_status: byStatus,
      sample: list.slice(0, 10).map((r: any) => ({
        order_no: r.order_no, customer_name: r.customer_name, total_amount: num(r.total_amount), status: r.status, created_at: r.created_at,
      })),
    };
  },
};

// —— 库存查询（M6）：当前余量 ——
const inventoryQuery: Capability<any, any> = {
  id: 'inventory.query', name: '查询库存', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const rows = await ctx.store.query('business', 'inventory');
    return {
      sku_count: rows.length,
      stock: rows.map((r: any) => ({ sku: r.sku, product_name: r.product_name, qty: num(r.qty) })).slice(0, 20),
    };
  },
};

// —— 应付查询（M6）：应付未付总额 ——
const payableQuery: Capability<any, any> = {
  id: 'payable.query', name: '查询应付', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const rows = await ctx.store.query('business', 'payables');
    const bySupplier = new Map<string, { supplier: string; amount: number; paid: number }>();
    for (const r of rows as any[]) {
      const key = String(r.supplier || '');
      const cur = bySupplier.get(key) || { supplier: key, amount: 0, paid: 0 };
      cur.amount = Math.round((cur.amount + num(r.amount)) * 100) / 100;
      cur.paid = Math.round((cur.paid + num(r.paid)) * 100) / 100;
      bySupplier.set(key, cur);
    }
    const agg = [...bySupplier.values()].map((s) => ({
      supplier: s.supplier, payable: s.amount, paid: s.paid,
      balance: Math.round((s.amount - s.paid) * 100) / 100,
    })).sort((a, b) => b.balance - a.balance);
    return { total_unpaid: Math.round(agg.reduce((s, x) => s + x.balance, 0) * 100) / 100, by_supplier: agg.slice(0, 10) };
  },
};

// —— 事件链/责任链查询（A2）：按实体/能力查事件链（谁发起/谁确认/时间/hash）。
// 「这笔应收是谁发起的」「订单 SO-XX 的确认人是谁」的数据源。 ——
const eventAudit: Capability<any, any> = {
  id: 'event.audit', name: '查询责任链', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('execution', 'events');
    let list = rows;
    const entityType = String(input.entity_type || '');
    let entityId = String(input.entity_id || '');
    // 辅助：entity_type=receivable 且给 customer_name 时，自动解析应收记录 id
    if (entityType === 'receivable' && input.customer_name && !entityId) {
      const recvs = await ctx.store.query('business', 'receivables', { customer_name: String(input.customer_name) });
      const ids = recvs.map((r: any) => r.id);
      list = list.filter((e: any) => e.entity_type === 'receivable' && ids.includes(e.entity_id));
    } else {
      if (entityType) list = list.filter((e: any) => e.entity_type === entityType);
      if (entityId) list = list.filter((e: any) => e.entity_id === entityId);
    }
    if (input.capability) list = list.filter((e: any) => e.capability === input.capability);
    const sorted = [...list]
      .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((e: any) => ({
        capability: e.capability, status: e.status, initiator: e.initiator,
        reviewer: e.reviewer || '', created_at: e.created_at, hash: String(e.hash || '').slice(0, 8),
      }));
    return { count: sorted.length, chain: sorted.slice(0, 20) };
  },
};

// —— 每日简报查询（A3）：返回最近简报内容 ——
const briefQuery: Capability<any, any> = {
  id: 'brief.query', name: '查询每日简报', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const rows = await ctx.store.query('execution', 'briefs');
    const sorted = [...rows].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    const latest = sorted[0] as any;
    if (!latest) return { found: false, note: '还没有生成过简报（可运行「每日经营简报」触发器）' };
    return { found: true, brief_date: latest.brief_date, content: latest.content };
  },
};

// —— 产品档案查询（A5）：SKU/名称/价格/成本 ——
const productQuery: Capability<any, any> = {
  id: 'product.query', name: '查询产品', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'products');
    // 模糊匹配：query 命中 名称/SKU/规格 任一字段；多词（如「不锈钢连接件」）按全部词命中才算
    const q = String(input.name || input.keyword || '').trim();
    const words = q.split(/[ 　,，、]/).filter(Boolean);
    const skuQ = String(input.sku || '').trim();
    const list = rows.filter((r: any) => {
      if (skuQ && !String(r.sku || '').includes(skuQ)) return false;
      if (!q) return true;
      const hay = [r.name, r.spec, r.sku, r.unit].map(x => String(x || '')).join(' ');
      return words.every(w => hay.includes(w));
    });
    return {
      count: list.length,
      products: list.slice(0, 20).map((p: any) => ({ sku: p.sku, name: p.name, spec: p.spec, unit: p.unit, price: num(p.price), cost: num(p.cost), status: p.status })),
    };
  },
};

// —— 客户档案查询（A5）：客户列表/名称匹配 ——
const customerQuery: Capability<any, any> = {
  id: 'customer.query', name: '查询客户', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', 'customers');
    const list = rows.filter((r: any) => {
      if (input.name && !String(r.name || '').includes(String(input.name))) return false;
      return true;
    });
    return {
      count: list.length,
      customers: list.slice(0, 20).map((c: any) => ({ name: c.name, contact: c.contact, phone: c.phone, status: c.status })),
    };
  },
};

// —— 主动提醒查询（A4）：待处理提醒列表（应收逾期/库存预警） ——
const alertQuery: Capability<any, any> = {
  id: 'alert.query', name: '查询提醒', impl: 'script', effect: 'read', roles: ['admin','finance','manager'],
  async run(_input, ctx) {
    const rows = await ctx.store.query('execution', 'alerts');
    const open = rows.filter((r: any) => r.status === '待处理')
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    return {
      open_count: open.length,
      alerts: open.slice(0, 20).map((a: any) => ({ type: a.type, title: a.title, detail: a.detail, created_at: a.created_at })),
    };
  },
};

export function registerChatTools(): void {
  registerCapability(invoiceQuery);
  registerCapability(ledgerQuery);
  registerCapability(receivableQuery);
  registerCapability(orderQuery);
  registerCapability(inventoryQuery);
  registerCapability(payableQuery);
  registerCapability(eventAudit);
  registerCapability(briefQuery);
  registerCapability(alertQuery);
  registerCapability(productQuery);
  registerCapability(customerQuery);
  registerCapability(cashflowQuery);
  registerCapability(invoiceDetail);
  registerCapability(projectQuery);
  registerCapability(profitQuery);
  registerCapability(confirmationQuery);
  registerCapability(habitSuggest);
}
