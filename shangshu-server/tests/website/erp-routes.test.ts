import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
import { testActor, testContext } from '../helpers/actor.ts';
// 进销存路由测试（M1）：客户/产品主档 CRUD —— 写操作走事件总线（用户即确认）、事件链留痕、角色权限。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { businessDate } from '../../src/capabilities/finance-domain.ts';

describe('/api/customers /api/products（M1 主档）', () => {
  let dir: string; let server: Server; let port: number; let cookie = '';
  const loginAs = async (username: string, password: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return r.headers.get('set-cookie') || '';
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-erp-'));
    process.env._SS_DATA_DIR = dir;
    const { localStore, registerTable } = await import('../../src/core/store.ts');
    const { ensureBootstrap, createUser } = await import('../../src/core/auth/users.ts');
    const store: any = localStore;
    await ensureBootstrap(store);
    await createUser(store, { username: 'staff1', password: 'test123', role: 'staff', display_name: '员工一' }).catch(() => {});
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    cookie = await loginAs('admin', 'admin');
  });
  afterEach(() => { server.close(); });

  it('客户创建 → 列表可见 + 事件链留痕（customer.create confirmed）', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '恒泰贸易', contact: '孙立', phone: '13800000000', address: '南京' }),
    });
    assert.equal((await r.json()).ok, true);
    const { list } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '恒泰贸易');
    assert.equal(list[0].status, '启用');
    // 事件链留痕
    const { localStore } = await import('../../src/core/store.ts');
    const evts = await (localStore as any).query('execution', 'events');
    assert.ok(evts.some((e: any) => e.capability === 'customer.create' && e.status === 'confirmed'), '应有 customer.create confirmed 事件');
  });

  it('客户编辑/停用（PATCH）生效', async () => {
    await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '测试客户' }),
    });
    const { list } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    const id = list[0].id;
    await fetch(`http://127.0.0.1:${port}/api/customers/${id}`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '停用', contact: '李四' }),
    });
    const { list: list2 } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    assert.equal(list2[0].status, '停用');
    assert.equal(list2[0].contact, '李四');
  });

  it('客户名称必填（400）', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '  ' }),
    });
    assert.equal(r.status, 400);
  });

  it('产品创建（SKU/名称必填）→ 列表正确', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/products`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-001', name: '不锈钢连接件', spec: 'M8', unit: '个', price: 2.5, cost: 1.8 }),
    });
    assert.equal((await r.json()).ok, true);
    const bad = await fetch(`http://127.0.0.1:${port}/api/products`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '缺 SKU' }),
    });
    assert.equal(bad.status, 400);
    const { list } = await (await fetch(`http://127.0.0.1:${port}/api/products`, { headers: { cookie } })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].sku, 'SKU-001');
    assert.equal(Number(list[0].price), 2.5);
  });

  it('staff 角色写主档 → 403；未登录 → 401', async () => {
    const staffCookie = await loginAs('staff1', 'test123');
    const r = await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie: staffCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '越权' }),
    });
    assert.equal(r.status, 403);
    const anon = await fetch(`http://127.0.0.1:${port}/api/customers`);
    assert.equal(anon.status, 401);
  });

  it('订单（M2）：创建草稿 → 确认 → 应收台账自动出现（金额一致）', async () => {
    // 准备客户 + 产品
    await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '蓝海制造' }),
    });
    await fetch(`http://127.0.0.1:${port}/api/products`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-A', name: '铝型材', price: 10, cost: 6 }),
    });
    const { list: custs } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    const { list: prods } = await (await fetch(`http://127.0.0.1:${port}/api/products`, { headers: { cookie } })).json();
    const custId = custs[0].id, prodId = prods[0].id;

    // 创建订单（2 条明细，服务端重算金额 = 3×10 + 5×10 = 80）
    const r = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: custId, items: [
        { product_id: prodId, qty: 3, product_name: '铝型材', sku: 'SKU-A', price: 10 },
        { product_id: prodId, qty: 5, product_name: '铝型材', sku: 'SKU-A', price: 10 },
      ] }),
    });
    assert.equal((await r.json()).ok, true);
    const { list: orders } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, '草稿');
    assert.equal(Number(orders[0].total_amount), 80, '金额服务端重算');
    assert.equal(orders[0].customer_name, '蓝海制造', '客户名后端查主档');

    // 确认 → 应收出现
    const c = await fetch(`http://127.0.0.1:${port}/api/orders/${orders[0].id}/confirm`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal((await c.json()).ok, true);
    const { list: recvs } = await (await fetch(`http://127.0.0.1:${port}/api/receivables`, { headers: { cookie } })).json();
    assert.equal(recvs.length, 1);
    assert.equal(recvs[0].customer_name, '蓝海制造');
    assert.equal(Number(recvs[0].amount), 80);
    assert.equal(recvs[0].status, '未收');

    // 重复确认被阻止
    const c2 = await fetch(`http://127.0.0.1:${port}/api/orders/${orders[0].id}/confirm`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(c2.status, 400);

    // 完成 + 事件链完整（order.create/confirm/complete 均 confirmed）
    await fetch(`http://127.0.0.1:${port}/api/orders/${orders[0].id}/complete`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    const { localStore } = await import('../../src/core/store.ts');
    const evts = await (localStore as any).query('execution', 'events');
    for (const cap of ['order.create', 'order.confirm', 'order.complete']) {
      assert.ok(evts.some((e: any) => e.capability === cap && e.status === 'confirmed'), `应有 ${cap} confirmed 事件`);
    }
  });

  it('采购（M3）：创建 → 确认 → 收货（库存增加 + 应付生成）→ 完成', async () => {
    await fetch(`http://127.0.0.1:${port}/api/products`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-B', name: '碳钢棒料', price: 8, cost: 5 }),
    });
    const { list: prods } = await (await fetch(`http://127.0.0.1:${port}/api/products`, { headers: { cookie } })).json();
    const prodId = prods.find((p: any) => p.sku === 'SKU-B').id;

    const r = await fetch(`http://127.0.0.1:${port}/api/purchases`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier: '永鑫金属', type: '常规', items: [{ product_id: prodId, qty: 100, product_name: '碳钢棒料', sku: 'SKU-B', price: 5 }] }),
    });
    assert.equal((await r.json()).ok, true);
    const { list: purs } = await (await fetch(`http://127.0.0.1:${port}/api/purchases`, { headers: { cookie } })).json();
    const pid = purs[0].id;
    assert.equal(Number(purs[0].total_amount), 500);

    await fetch(`http://127.0.0.1:${port}/api/purchases/${pid}/confirm`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    await fetch(`http://127.0.0.1:${port}/api/purchases/${pid}/receive`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });

    // 库存 + 应付联动
    const inv = await (await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { cookie } })).json();
    assert.equal(inv.list.length, 1);
    assert.equal(Number(inv.list[0].qty), 100, '收货入库 100');
    assert.equal(inv.moves[0].type, '入库');
    const { list: pays } = await (await fetch(`http://127.0.0.1:${port}/api/payables`, { headers: { cookie } })).json();
    assert.equal(pays.length, 1);
    assert.equal(pays[0].supplier, '永鑫金属');
    assert.equal(Number(pays[0].amount), 500);
    assert.equal(pays[0].status, '未付');

    // 状态机：已收货 → 完成
    await fetch(`http://127.0.0.1:${port}/api/purchases/${pid}/complete`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const { list: purs2 } = await (await fetch(`http://127.0.0.1:${port}/api/purchases`, { headers: { cookie } })).json();
    assert.equal(purs2[0].status, '已完成');
  });

  it('库存（M4）：出库扣减；超量出库被阻止（库存不足）', async () => {
    // 直接造库存（走采购收货路径更真实，但这里用 store 直插简化验证出库校验）
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const pid = await store.insert('business', 'products', { sku: 'SKU-C', name: '铝板', price: 3, cost: 2, status: '启用', created_at: new Date().toISOString() });
    await store.insert('business', 'inventory', { product_id: pid, product_name: '铝板', sku: 'SKU-C', qty: 10, updated_at: new Date().toISOString() });

    // 出库 4 成功
    const ok = await fetch(`http://127.0.0.1:${port}/api/inventory/move`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: pid, qty: 4, ref_type: '发货', ref_id: 'SO-X' }),
    });
    assert.equal((await ok.json()).ok, true);
    const inv1 = await (await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { cookie } })).json();
    assert.equal(Number(inv1.list[0].qty), 6);

    // 出库 100 超量 → 400 + 库存不变
    const bad = await fetch(`http://127.0.0.1:${port}/api/inventory/move`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: pid, qty: 100, ref_type: '发货', ref_id: 'SO-Y' }),
    });
    assert.equal(bad.status, 400);
    const j = await bad.json();
    assert.match(j.error, /库存不足/);
    const inv2 = await (await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { cookie } })).json();
    assert.equal(Number(inv2.list[0].qty), 6, '超量出库不得改变库存');
    assert.equal(inv2.moves.length, 1, '失败操作不留流水');
  });

  it('财务闭环（M5）：回款登记 → 应收状态迁移（未收→部分→已收）；超额被阻止', async () => {
    // 订单确认生成应收（金额 80）
    await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '回款客户' }),
    });
    await fetch(`http://127.0.0.1:${port}/api/products`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'SKU-R', name: '配件', price: 40, cost: 20 }),
    });
    const { list: custs } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    const { list: prods } = await (await fetch(`http://127.0.0.1:${port}/api/products`, { headers: { cookie } })).json();
    await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: custs[0].id, items: [{ product_id: prods[0].id, qty: 2, product_name: '配件', sku: 'SKU-R', price: 40 }] }),
    });
    const { list: orders } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    await fetch(`http://127.0.0.1:${port}/api/orders/${orders[0].id}/confirm`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const { list: recvs } = await (await fetch(`http://127.0.0.1:${port}/api/receivables`, { headers: { cookie } })).json();
    const rid = recvs[0].id;

    // 部分回款 30 → 部分已收
    await fetch(`http://127.0.0.1:${port}/api/receivables/${rid}/pay`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 30 }),
    });
    let { list: recvs1 } = await (await fetch(`http://127.0.0.1:${port}/api/receivables`, { headers: { cookie } })).json();
    assert.equal(recvs1[0].status, '部分已收');
    assert.equal(Number(recvs1[0].received), 30);

    // 超额回款 → 400
    const over = await fetch(`http://127.0.0.1:${port}/api/receivables/${rid}/pay`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(over.status, 400);

    // 补齐 50 → 已收
    await fetch(`http://127.0.0.1:${port}/api/receivables/${rid}/pay`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 50 }),
    });
    let { list: recvs2 } = await (await fetch(`http://127.0.0.1:${port}/api/receivables`, { headers: { cookie } })).json();
    assert.equal(recvs2[0].status, '已收');
  });

  it('发货出库（M5 编排）：库存足 → 出库+完成；库存不足 → 整单阻止（不出库不完成）', async () => {
    // 造产品 + 库存 10 + 订单 5 件
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const pid = await store.insert('business', 'products', { sku: 'SKU-S', name: '发货物料', price: 6, cost: 3, status: '启用', created_at: new Date().toISOString() });
    await store.insert('business', 'inventory', { product_id: pid, product_name: '发货物料', sku: 'SKU-S', qty: 10, updated_at: new Date().toISOString() });
    await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '发货客户' }),
    });
    const { list: custs } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: custs[0].id, items: [{ product_id: pid, qty: 5, product_name: '发货物料', sku: 'SKU-S', price: 6 }] }),
    });
    const { list: orders } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    const oid = orders[0].id;
    await fetch(`http://127.0.0.1:${port}/api/orders/${oid}/confirm`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });

    // 发货成功：库存 10-5=5，订单已完成
    const ok = await fetch(`http://127.0.0.1:${port}/api/orders/${oid}/ship`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await ok.json()).ok, true);
    const inv1 = await (await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { cookie } })).json();
    assert.equal(Number(inv1.list[0].qty), 5);
    const { list: orders2 } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    assert.equal(orders2[0].status, '已完成');

    // 库存不足场景：另一订单 10 件（库存只剩 5）→ 400，订单保持已确认
    await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: custs[0].id, items: [{ product_id: pid, qty: 10, product_name: '发货物料', sku: 'SKU-S', price: 6 }] }),
    });
    const { list: orders3 } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    const oid2 = orders3[0].id;
    await fetch(`http://127.0.0.1:${port}/api/orders/${oid2}/confirm`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const bad = await fetch(`http://127.0.0.1:${port}/api/orders/${oid2}/ship`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
    const { list: orders4 } = await (await fetch(`http://127.0.0.1:${port}/api/orders`, { headers: { cookie } })).json();
    assert.equal(orders4[0].status, '已确认', '失败发货不得改变订单状态');
    const inv2 = await (await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { cookie } })).json();
    assert.equal(Number(inv2.list[0].qty), 5, '失败发货不得扣库存');
  });

  it('对话能力（M5）：receivable.query 返回应收汇总（真数据）', async () => {
    // 造一笔应收（直接插表，验证能力查询）
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    await store.insert('business', 'receivables', {
      order_id: 'o1', customer_id: 'c1', customer_name: '蓝海制造', amount: 100, received: 20, status: '部分已收', due_date: '', created_at: new Date().toISOString(),
    });
    await store.insert('business', 'receivables', {
      order_id: 'o2', customer_id: 'c2', customer_name: '恒泰贸易', amount: 50, received: 0, status: '未收', due_date: '', created_at: new Date().toISOString(),
    });
    const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
    registerChatTools();
    const { getCapability } = await import('../../src/core/registry.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const ctx = testContext(buildContext(console.log));
    const result = await getCapability('receivable.query').run({}, ctx);
    assert.equal(result.total_unreceived, 130, '未收总额 80+50');
    assert.equal(result.by_customer[0].customer_name, '蓝海制造', '按余额排序');
    assert.equal(result.by_customer[0].balance, 80);
  });

  it('看板（M6）：业务仪表盘返回订单/应收/应付/库存/毛利，且与明细一致', async () => {
    // 造：1 已确认订单（应收 100）+ 1 采购收货（应付 60，库存 +10）
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const cid = await store.insert('business', 'customers', { name: '看板客户', status: '启用', created_at: new Date().toISOString() });
    const pid = await store.insert('business', 'products', { sku: 'SKU-D', name: '看板产品', price: 10, cost: 4, status: '启用', created_at: new Date().toISOString() });
    const oid = await store.insert('business', 'orders', { order_no: 'SO-1', customer_id: cid, customer_name: '看板客户', status: '已完成', total_amount: 100, note: '', created_at: new Date().toISOString() });
    await store.insert('business', 'order_items', { order_id: oid, product_id: pid, product_name: '看板产品', sku: 'SKU-D', qty: 10, price: 10, amount: 100 });
    await store.insert('business', 'receivables', { order_id: oid, customer_id: cid, customer_name: '看板客户', amount: 100, received: 0, status: '未收', due_date: '', created_at: new Date().toISOString() });
    await store.insert('business', 'purchases', { purchase_no: 'PO-1', supplier: '看板供应商', type: '常规', order_id: '', status: '已完成', total_amount: 60, note: '', created_at: new Date().toISOString() });
    await store.insert('business', 'payables', { purchase_id: 'p-x', supplier: '看板供应商', amount: 60, paid: 0, status: '未付', due_date: '', created_at: new Date().toISOString() });
    await store.insert('business', 'inventory', { product_id: pid, product_name: '看板产品', sku: 'SKU-D', qty: 10, updated_at: new Date().toISOString() });

    const d = await (await fetch(`http://127.0.0.1:${port}/api/dashboard/business`, { headers: { cookie } })).json();
    assert.equal(d.order_count, 1);
    assert.equal(d.receivable_balance, 100, '应收未收 = 100');
    assert.equal(d.payable_balance, 60, '应付未付 = 60');
    assert.equal(d.inventory_sku, 1);
    assert.equal(d.gross_profit, 60, '毛利 = (10-4)×10 = 60');
  });
});

describe('A2 事件链与责任链', () => {
  let dir: string; let server: Server; let port: number; let cookie = '';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-ev2-'));
    process.env._SS_DATA_DIR = dir;
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('GET /api/events 按实体查责任链（发起人/确认人/hash）', async () => {
    // 造：客户创建（user）+ 订单确认（agent 提案 → wangfang 确认）
    const c = await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '责任链客户' }),
    });
    const { list: custs } = await (await fetch(`http://127.0.0.1:${port}/api/customers`, { headers: { cookie } })).json();
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const eid = await requestConfirmation(store, {
      capability: 'ledger.post', entity_type: 'ledger', entity_id: 'led-1',
      payload: { summary: '测试', counterparty: 'X', total_amount: 10 }, initiator: 'agent',
    });
    await resolveConfirmation(store, eid, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });

    const ev = await (await fetch(`http://127.0.0.1:${port}/api/events?entity_type=ledger&entity_id=led-1`, { headers: { cookie } })).json();
    assert.equal(ev.list.length, 2);
    assert.equal(ev.list[0].status, 'proposed');
    assert.equal(ev.list[0].initiator, 'agent');
    assert.equal(ev.list[1].status, 'confirmed');
    assert.equal(ev.list[1].reviewer, 'wangfang');
    assert.match(ev.list[0].hash, /^[0-9a-f]{8}$/);
  });

  it('audit_query 能力：按客户名解析应收事件链', async () => {
    const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
    registerChatTools();
    const { getCapability } = await import('../../src/core/registry.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const now = new Date().toISOString();
    const cid = await store.insert('business', 'customers', { name: '链客', status: '启用', created_at: now });
    const rid = await store.insert('business', 'receivables', { order_id: 'o9', customer_id: cid, customer_name: '链客', amount: 100, received: 0, status: '未收', due_date: '', created_at: now });
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const eid = await requestConfirmation(store, {
      capability: 'receivable.pay', entity_type: 'receivable', entity_id: rid,
      payload: { receivable_id: rid, amount: 50 }, initiator: 'agent',
    });
    await resolveConfirmation(store, eid, 'confirmed', { id: 'wangfang', role: 'admin', kind: 'human', channel: 'test' });

    const ctx = testContext(buildContext(console.log));
    const r = await getCapability('event.audit').run({ entity_type: 'receivable', customer_name: '链客' }, ctx);
    assert.equal(r.count, 2);
    assert.equal(r.chain[0].initiator, 'agent');
    assert.equal(r.chain[1].reviewer, 'wangfang');
  });
});

describe('A3 每日经营简报', () => {
  let dir: string; let server: Server; let port: number; let cookie = '';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-brf-'));
    process.env._SS_DATA_DIR = dir;
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('生成简报：数字与看板一致（应收/应付/毛利/订单）', async () => {
    // 造业务数据（1 已完成订单毛利 60 + 应收 100 + 应付 60）
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const now = new Date().toISOString();
    const cid = await store.insert('business', 'customers', { name: '简报客户', status: '启用', created_at: now });
    const pid = await store.insert('business', 'products', { sku: 'SKU-B1', name: '简报产品', price: 10, cost: 4, status: '启用', created_at: now });
    const oid = await store.insert('business', 'orders', { order_no: 'SO-B1', customer_id: cid, customer_name: '简报客户', status: '已完成', total_amount: 100, note: '', created_at: now });
    await store.insert('business', 'order_items', { order_id: oid, product_id: pid, product_name: '简报产品', sku: 'SKU-B1', qty: 10, price: 10, amount: 100 });
    await store.insert('business', 'receivables', { order_id: oid, customer_id: cid, customer_name: '简报客户', amount: 100, received: 0, status: '未收', due_date: '', created_at: now });
    await store.insert('business', 'purchases', { purchase_no: 'PO-B1', supplier: '简报供应商', type: '常规', order_id: '', status: '已完成', total_amount: 60, note: '', created_at: now });
    await store.insert('business', 'payables', { purchase_id: 'p1', supplier: '简报供应商', amount: 60, paid: 0, status: '未付', due_date: '', created_at: now });
    await store.insert('business', 'inventory', { product_id: pid, product_name: '简报产品', sku: 'SKU-B1', qty: 10, updated_at: now });

    const r = await fetch(`http://127.0.0.1:${port}/api/briefs/generate`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.content, /订单：共 \*\*1\*\* 单/);
    assert.match(j.content, /应收：未收 \*\*¥100\*\*/);
    assert.match(j.content, /应付：未付 \*\*¥60\*\*/);
    assert.match(j.content, /毛利：\*\*¥60\*\*/);

    // 与看板数字一致
    const d = await (await fetch(`http://127.0.0.1:${port}/api/dashboard/business`, { headers: { cookie } })).json();
    assert.equal(d.order_count, 1);
    assert.equal(d.receivable_balance, 100);
    assert.equal(d.payable_balance, 60);
    assert.equal(d.gross_profit, 60);

    // GET /api/briefs 最近一条
    const b = await (await fetch(`http://127.0.0.1:${port}/api/briefs`, { headers: { cookie } })).json();
    assert.equal(b.list.length, 1);
    assert.equal(b.list[0].brief_date, businessDate());

    // brief_query 能力
    const { registerChatTools } = await import('../../src/capabilities/chat-tools.ts');
    registerChatTools();
    const { getCapability } = await import('../../src/core/registry.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const q = await getCapability('brief.query').run({}, testContext(buildContext(console.log)));
    assert.equal(q.found, true);
    assert.match(q.content, /经营简报/);
  });
});

describe('A4 主动提醒', () => {
  let dir: string; let server: Server; let port: number; let cookie = '';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-alt-'));
    process.env._SS_DATA_DIR = dir;
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('扫描生成提醒：应收逾期命中 + 未逾期不命中 + 去重', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();   // 40 天前
    const cid = await store.insert('business', 'customers', { name: '逾期客户', status: '启用', created_at: now });
    // 逾期应收（40 天前创建，未收）
    await store.insert('business', 'receivables', { order_id: 'r1', customer_id: cid, customer_name: '逾期客户', amount: 500, received: 0, status: '未收', due_date: '', created_at: old });
    // 近期应收（今天，未收）→ 不逾期
    await store.insert('business', 'receivables', { order_id: 'r2', customer_id: cid, customer_name: '逾期客户', amount: 100, received: 0, status: '未收', due_date: '', created_at: now });

    const r = await fetch(`http://127.0.0.1:${port}/api/alerts/scan`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal((await r.json()).added, 1, '只命中逾期那笔');
    const al = await (await fetch(`http://127.0.0.1:${port}/api/alerts`, { headers: { cookie } })).json();
    assert.equal(al.list.length, 1);
    assert.match(al.list[0].title, /应收逾期：逾期客户/);
    assert.match(al.list[0].title, /500/);

    // 去重：再扫一次不新增
    await fetch(`http://127.0.0.1:${port}/api/alerts/scan`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const al2 = await (await fetch(`http://127.0.0.1:${port}/api/alerts`, { headers: { cookie } })).json();
    assert.equal(al2.list.length, 1, '待处理同款不重复');

    // 标记已处理
    await fetch(`http://127.0.0.1:${port}/api/alerts/${al.list[0].id}`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const al3 = await (await fetch(`http://127.0.0.1:${port}/api/alerts`, { headers: { cookie } })).json();
    assert.equal(al3.list.length, 0, '已处理不在待处理列表');
  });

  it('库存预警：低于预警线命中（min_stock 配置）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const store: any = localStore;
    // 写配置 min_stock=20
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({ alerts: { overdue_days: 30, min_stock: 20 } }));
    const pid = await store.insert('business', 'products', { sku: 'SKU-LOW', name: '低库存品', price: 5, cost: 2, status: '启用', created_at: new Date().toISOString() });
    await store.insert('business', 'inventory', { product_id: pid, product_name: '低库存品', sku: 'SKU-LOW', qty: 5, updated_at: new Date().toISOString() });

    const r = await fetch(`http://127.0.0.1:${port}/api/alerts/scan`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal((await r.json()).added, 1);
    const al = await (await fetch(`http://127.0.0.1:${port}/api/alerts`, { headers: { cookie } })).json();
    assert.match(al.list[0].title, /库存预警：低库存品 仅剩 5/);
  });
});
