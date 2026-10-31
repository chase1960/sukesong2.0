import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
import { testActor, testContext } from '../helpers/actor.ts';
// AI 对话财务全覆盖（2026-08-19）：新增查询/写能力的单元测试。
// 查询类（cashflow.query / invoice.detail / receivable 账龄）直跑 registry 能力；
// 写类（invoice.reject / ledger.reverse / ledger.post 三列）走 resolveConfirmPayload + 真 handler 全链路。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessDate } from '../../src/capabilities/finance-domain.ts';

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ss-chatfin-'));
  process.env._SS_DATA_DIR = dir;
  const { localStore } = await import('../../src/core/store.ts');
  const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
  registerChatTools();
  const { registerAllActionHandlers } = await import('../../src/capabilities/actions.ts');
  registerAllActionHandlers();
  return localStore;
}

async function runCap(id: string, input: any) {
  const { getCapability } = await import('../../src/core/registry.ts');
  const { buildContext } = await import('../../src/core/context.ts');
  const { localStore } = await import('../../src/core/store.ts');
  return getCapability(id).run(input, testContext(buildContext(console.log))) as Promise<any>;
}

describe('cashflow.query 资金总览', () => {
  beforeEach(async () => { await freshStore(); });

  it('默认本月口径：收/支/净 + 在外未清，期间外不计', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const today = businessDate();
    const thisMonth = today.slice(0, 7);
    await localStore.insert('business', 'ledger', { summary: '卖货', counterparty: '甲', direction: '出项', total_amount: 1000, biz_date: thisMonth + '-05', posted_at: thisMonth + '-05T00:00:00Z' });
    await localStore.insert('business', 'ledger', { summary: '买料', counterparty: '乙', direction: '进项', total_amount: 300, biz_date: thisMonth + '-06', posted_at: thisMonth + '-06T00:00:00Z' });
    await localStore.insert('business', 'ledger', { summary: '上月收入', counterparty: '丙', direction: '出项', total_amount: 9999, biz_date: '2020-01-15', posted_at: '2020-01-15T00:00:00Z' });
    await localStore.insert('business', 'receivables', { customer_name: '甲', amount: 800, received: 300, status: '部分已收', due_date: '', created_at: thisMonth + '-01T00:00:00Z' });
    await localStore.insert('business', 'payables', { supplier: '乙', amount: 600, paid: 0, status: '未付', due_date: '', created_at: thisMonth + '-01T00:00:00Z' });

    await localStore.insert('business','cash_movements',{direction:'收款',amount_minor:20000,occurred_on:today});
    await localStore.insert('business','cash_movements',{direction:'付款',amount_minor:5000,occurred_on:today});
    const r = await runCap('cashflow.query', {});
    assert.equal(r.received, 200, '发票入账不冒充实际收款');
    assert.equal(r.paid, 50);
    assert.equal(r.net, 150);
    assert.equal(r.unreceived, 500);
    assert.equal(r.unpaid, 600);
    assert.equal(r.entry_count, 2);
    assert.equal(r.period.from, thisMonth + '-01');
    assert.equal(r.period.to, today);
  });

  it('指定期间生效', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('business', 'ledger', { summary: 'Q1收入', counterparty: '甲', direction: '出项', total_amount: 2000, biz_date: '2026-03-10', posted_at: '2026-03-10T00:00:00Z' });
    await localStore.insert('business','cash_movements',{direction:'收款',amount_minor:12300,occurred_on:'2026-03-01'});
    const r = await runCap('cashflow.query', { date_from: '2026-01-01', date_to: '2026-03-31' });
    assert.equal(r.received, 123);
    assert.equal(r.entry_count, 1);
  });
});

describe('invoice.detail 发票明细', () => {
  beforeEach(async () => {
    await freshStore();
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('business', 'invoices', {
      invoice_no: 'INV-D1', invoice_type: '增值税专用发票', invoice_direction: '进项',
      seller_name: '测试五金厂', buyer_name: '尚书公司', amount_ex_tax: 100, tax_amount: 13,
      total_amount: 113, issued_at: '2026-08-01', status: '已入库', confidence: 0.95,
      received_at: '2026-08-02T10:00:00Z',
    });
  });

  it('按发票号码精确查', async () => {
    const r = await runCap('invoice.detail', { invoice_no: 'INV-D1' });
    assert.equal(r.count, 1);
    assert.equal(r.invoices[0].tax_amount, 13);
    assert.equal(r.invoices[0].seller_name, '测试五金厂');
    assert.equal(r.invoices[0].direction, '进项');
  });

  it('按公司名模糊查（销方/购方）', async () => {
    const r = await runCap('invoice.detail', { keyword: '尚书' });
    assert.equal(r.count, 1);
    assert.equal(r.invoices[0].invoice_no, 'INV-D1');
    const miss = await runCap('invoice.detail', { keyword: '不存在的公司' });
    assert.equal(miss.count, 0);
  });
});

describe('receivable.query 账龄', () => {
  beforeEach(async () => { await freshStore(); });

  it('未清余额按基准日归入账龄桶', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const dayAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    await localStore.insert('business', 'receivables', { customer_name: '新账客户', amount: 100, received: 0, status: '未收', due_date: '', created_at: dayAgo(5) });
    await localStore.insert('business', 'receivables', { customer_name: '逾期客户A', amount: 200, received: 0, status: '未收', due_date: dayAgo(20).slice(0, 10), created_at: dayAgo(50) });
    await localStore.insert('business', 'receivables', { customer_name: '逾期客户B', amount: 300, received: 0, status: '未收', due_date: dayAgo(100).slice(0, 10), created_at: dayAgo(120) });
    await localStore.insert('business', 'receivables', { customer_name: '已清客户', amount: 500, received: 500, status: '已收', due_date: '', created_at: dayAgo(200) });

    const r = await runCap('receivable.query', {});
    assert.equal(r.total_unreceived, 600, '已结清不计入未收');
    assert.equal(r.aging['未逾期'], 100);
    assert.equal(r.aging['逾期1-30天'], 200);
    assert.equal(r.aging['逾期90天以上'], 300);
    assert.equal(r.aging['逾期31-60天'], 0);
  });
});

describe('profit.query 毛利', () => {
  beforeEach(async () => { await freshStore(); });

  it('已确认/已完成订单计毛利，草稿/取消不计，期间外不计', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const today = businessDate();
    const pid = await localStore.insert('business', 'products', { sku: 'P1', name: '连接件', price: 100, cost: 60, status: '启用', created_at: '' });
    const cid = await localStore.insert('business', 'customers', { name: '甲', status: '启用', created_at: '' });
    const ok = await localStore.insert('business', 'orders', { order_no: 'SO-OK', customer_id: cid, customer_name: '甲', status: '已确认', total_amount: 1000, note: '', created_at: today + 'T00:00:00Z' });
    await localStore.insert('business', 'order_items', { order_id: ok, product_id: pid, product_name: '连接件', sku: 'P1', qty: 10, price: 100, amount: 1000 });
    const draft = await localStore.insert('business', 'orders', { order_no: 'SO-DRAFT', customer_id: cid, customer_name: '甲', status: '草稿', total_amount: 5000, note: '', created_at: today + 'T00:00:00Z' });
    await localStore.insert('business', 'order_items', { order_id: draft, product_id: pid, product_name: '连接件', sku: 'P1', qty: 50, price: 100, amount: 5000 });
    const old = await localStore.insert('business', 'orders', { order_no: 'SO-OLD', customer_id: cid, customer_name: '甲', status: '已完成', total_amount: 8000, note: '', created_at: '2020-01-01T00:00:00Z' });
    await localStore.insert('business', 'order_items', { order_id: old, product_id: pid, product_name: '连接件', sku: 'P1', qty: 80, price: 100, amount: 8000 });

    const r = await runCap('profit.query', {});
    assert.equal(r.order_count, 1, '只算本月已确认（草稿/旧单不计）');
    assert.equal(r.revenue, 1000);
    assert.equal(r.cost, 600);
    assert.equal(r.gross_profit, 400);
    assert.equal(r.margin_pct, 40);
    assert.equal(r.top_products[0].name, '连接件');
  });
});

describe('confirmation.query 待办审批', () => {
  beforeEach(async () => { await freshStore(); });

  it('列出挂起的确认卡，已决议的不算', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    await localStore.insert('business', 'customers', { name: '甲', status: '启用', created_at: '' });
    await localStore.insert('business', 'orders', { order_no: 'SO-P1', customer_id: 'x', customer_name: '甲', status: '草稿', total_amount: 100, note: '', created_at: '' });
    const eid = await requestConfirmation(localStore, { capability: 'order.confirm', entity_type: 'order', entity_id: 'x', payload: { order_no: 'SO-P1', total_amount: 100 }, initiator: 'agent' });

    let r = await runCap('confirmation.query', {});
    assert.equal(r.pending_count, 1);
    assert.equal(r.items[0].capability, 'order.confirm');

    await resolveConfirmation(localStore, eid, 'rejected', { id: 'tester', role: 'admin', kind: 'human', channel: 'test' });
    r = await runCap('confirmation.query', {});
    assert.equal(r.pending_count, 0, '拒绝后不再挂起');
  });
});

describe('invoice.approve 对话内审核入库', () => {
  beforeEach(async () => { await freshStore(); });

  it('待审 → 已入库（确认卡全链路）；非待审解析层拦截', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const id = await localStore.insert('business', 'invoices', { invoice_no: 'AP-1', seller_name: '甲', status: '待审', total_amount: 50 });

    const resolved = await resolveConfirmPayload(localStore, 'invoice.approve', { invoice_id: id });
    const eid = await requestConfirmation(localStore, { ...resolved, capability: 'invoice.approve', initiator: 'agent' });
    // 挂起期间状态不变
    assert.equal((await localStore.query('business', 'invoices', { id }))[0].status, '待审');
    await resolveConfirmation(localStore, eid, 'confirmed', { id: 'tester', role: 'admin', kind: 'human', channel: 'test' });
    const after = (await localStore.query('business', 'invoices', { id }))[0] as any;
    assert.equal(after.status, '已入库');
    assert.ok(after.reviewed_at, '留审核时间');

    await assert.rejects(() => resolveConfirmPayload(localStore, 'invoice.approve', { invoice_id: id }), /待审/);
  });
});

describe('渐进吸收：历史习惯推荐（habit.suggest / ledger.post 填补）', () => {
  beforeEach(async () => { await freshStore(); });

  async function seedHabit(counterparty: string, n: number, category = '收入', subject = '主营业务收入') {
    const { localStore } = await import('../../src/core/store.ts');
    for (let i = 0; i < n; i++) {
      await localStore.insert('business', 'ledger', {
        summary: `历史${i}`, counterparty, direction: '出项', total_amount: 100,
        category, account_subject: subject, biz_date: '2026-08-0' + (i + 1), posted_at: '2026-08-0' + (i + 1) + 'T00:00:00Z',
      });
    }
  }

  it('满 3 次才推荐；不足不推荐；无科目记录不学', async () => {
    const { suggestLedgerHabit } = await import('../../src/core/erp-ops.ts');
    const { localStore } = await import('../../src/core/store.ts');
    await seedHabit('常客甲', 3);
    await seedHabit('稀客乙', 2);
    await localStore.insert('business', 'ledger', { summary: '裸记录', counterparty: '丙', direction: '进项', total_amount: 1, category: '', account_subject: '', biz_date: '2026-08-01', posted_at: '2026-08-01T00:00:00Z' });

    const h = await suggestLedgerHabit(localStore, '常客甲');
    assert.ok(h);
    assert.equal(h.category, '收入');
    assert.equal(h.account_subject, '主营业务收入');
    assert.equal(h.count, 3);
    assert.equal(await suggestLedgerHabit(localStore, '稀客乙'), null, '2 次不足阈值');
    assert.equal(await suggestLedgerHabit(localStore, '丙'), null, '无科目记录没有可学的');
    assert.equal(await suggestLedgerHabit(localStore, ''), null);

    // capability 包装一致
    const r = await runCap('habit.suggest', { counterparty: '常客甲' });
    assert.equal(r.found, true);
    assert.equal(r.count, 3);
  });

  it('ledger.post 解析：没填的字段按习惯补 + 标注；显式给的绝不覆盖', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    await seedHabit('常客甲', 4);

    const auto = await resolveConfirmPayload(localStore, 'ledger.post', { summary: 'x', counterparty: '常客甲', total_amount: 10, direction: '出项' });
    assert.equal(auto.payload.category, '收入');
    assert.equal(auto.payload.account_subject, '主营业务收入');
    assert.equal(auto.payload.habit_suggested, true);
    assert.equal(auto.payload.habit_count, 4);

    const manual = await resolveConfirmPayload(localStore, 'ledger.post', { summary: 'x', counterparty: '常客甲', total_amount: 10, direction: '出项', category: '费用', account_subject: '管理费用' });
    assert.equal(manual.payload.category, '费用', '显式输入不被推荐覆盖');
    assert.equal(manual.payload.account_subject, '管理费用');
    assert.equal(manual.payload.habit_suggested, undefined, '全显式时不标注推荐');
  });
});

describe('invoice.reject / ledger.reverse / ledger.post 三列（确认卡全链路）', () => {
  beforeEach(async () => { await freshStore(); });

  async function proposeAndConfirm(capability: string, input: any) {
    const { localStore } = await import('../../src/core/store.ts');
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const resolved = await resolveConfirmPayload(localStore, capability, input);
    const eid = await requestConfirmation(localStore, { ...resolved, capability, initiator: 'agent' });
    await resolveConfirmation(localStore, eid, 'confirmed', { id: 'tester', role: 'admin', kind: 'human', channel: 'test' });
    return { eid, resolved };
  }

  it('invoice.reject：已入库 → 已拒绝；已入账解析层拦截', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const id1 = await localStore.insert('business', 'invoices', { invoice_no: 'RJ-1', seller_name: '甲', status: '已入库', total_amount: 10 });
    await proposeAndConfirm('invoice.reject', { invoice_id: id1 });
    const rows = await localStore.query('business', 'invoices', { id: id1 });
    assert.equal(rows[0].status, '已拒绝');

    const id2 = await localStore.insert('business', 'invoices', { invoice_no: 'RJ-2', seller_name: '乙', status: '已入账', total_amount: 20 });
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    await assert.rejects(() => resolveConfirmPayload(localStore, 'invoice.reject', { invoice_id: id2 }), /红冲/);
  });

  it('ledger.reverse：追加负金额冲销，原记录不动，重复红冲拦截', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const lid = await localStore.insert('business', 'ledger', { summary: '记错的账', counterparty: '甲', direction: '出项', total_amount: 500, biz_date: '2026-08-10', posted_at: '2026-08-10T00:00:00Z' });
    await proposeAndConfirm('ledger.reverse', { ledger_id: lid });
    const all = await localStore.query('business', 'ledger');
    assert.equal(all.length, 2, 'append-only：原记录保留 + 新增冲销');
    const orig = all.find((r: any) => r.id === lid) as any;
    const rev = all.find((r: any) => r.id !== lid) as any;
    assert.equal(Number(orig.total_amount), 500, '原记录不被修改');
    assert.equal(Number(rev.total_amount), -500);
    assert.match(String(rev.summary), /^红冲：/);
    assert.ok(String(rev.note).includes(lid));

    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');
    const resolved = await resolveConfirmPayload(localStore, 'ledger.reverse', { ledger_id: lid });
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const eid = await requestConfirmation(localStore, { ...resolved, capability: 'ledger.reverse', initiator: 'agent' });
    await assert.rejects(() => resolveConfirmation(localStore, eid, 'confirmed', { id: 'tester', role: 'admin', kind: 'human', channel: 'test' }), /已被红冲/);
  });

  it('ledger.post：category 校验 + project_name 解析 + 三列落账', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('business', 'projects', { name: '测试项目', customer_id: '', status: '启用', created_at: new Date().toISOString() });
    const { resolveConfirmPayload } = await import('../../src/core/erp-ops.ts');

    await assert.rejects(
      () => resolveConfirmPayload(localStore, 'ledger.post', { summary: 'x', counterparty: 'y', total_amount: 1, category: '工资' }),
      /category/,
    );
    await assert.rejects(
      () => resolveConfirmPayload(localStore, 'ledger.post', { summary: 'x', counterparty: 'y', total_amount: 1, project_name: '不存在项目' }),
      /项目不存在/,
    );

    await proposeAndConfirm('ledger.post', {
      summary: '项目收入', counterparty: '甲', total_amount: 8000, direction: '出项',
      category: '收入', account_subject: '主营业务收入', project_name: '测试项目',
    });
    const rows = await localStore.query('business', 'ledger');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, '收入');
    assert.equal(rows[0].account_subject, '主营业务收入');
    assert.ok(String(rows[0].project_id).length > 0, '项目名解析成 project_id');

    // by_category 汇总生效
    const q = await runCap('ledger.query', {});
    assert.equal(q.by_category['收入'], 8000);
  });
});
