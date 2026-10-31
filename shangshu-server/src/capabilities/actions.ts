import {createTask,updateTask,claimPost} from './task-domain.ts';
import {registerBusinessTransfer} from './business-transfer.ts';
// 业务写操作 handler 注册（R4 2026-08-14）：从 server.ts 拆出——能力=注册项，handler 按域归位。
// 人工确认 → 事务领域 handler → 状态、执行记录、审计同时提交。触发器不能代替人确认。
// 说明：表规格仍在 core/store.ts（registerTable 集中注册，避免拆散自动建表/加列逻辑）。
import { registerActionHandler as registerLegacyHandler } from '../core/confirm.ts';
import { validateInvoicePatch } from './invoice-contract.ts';
import {registerPayment,reversePayment,reverseLedger,minor,validDate} from './finance-domain.ts';
import { actionOptions } from './action-policy.ts';
import { accountInvoiceToLedger } from '../core/ledger.ts';
import { applyInventory, shipOrder, resolveConfirmPayload } from './legacy-erp.ts';
import { validateReply, messageFingerprint } from '../core/im.ts';
import {normalizeMessageExtras,validateMessageExtras} from '../core/im-workplace.ts';

export function registerAllActionHandlers(): void {
  registerBusinessTransfer();
  const registerActionHandler: typeof registerLegacyHandler = (id, handler) => registerLegacyHandler(id, handler, {
    ...actionOptions(id), resolve: (store,input) => ['cash.record','cash.reverse','invoice.unbook'].includes(id) ? Promise.resolve({entity_type:id.split('.')[0],entity_id:String(input.invoice_id || input.movement_id || 'manual:cash'),payload:input}) : resolveConfirmPayload(store,id,input),
    snapshot: id.startsWith('invoice.') ? async (store,input) => {
      const [record] = await store.query('business','invoices',{id:input.invoice_id});
      return record ? {id:record.id,version:record._version} : null;
    } : undefined,
  });
  // —— 事件写总线（P1）：invoice.book 记账投影更新（发票 → 已入账 + 记账表 append）。
  // 仅经人工确认执行；不支持置信度自动记账或命令重放。
  // R1（2026-08-14）：入账按方向联动财务台账——出项发票（开给客户）→ 生成应收挂客户；
  //   进项发票（从供应商收）→ 生成应付（供应商=销方）。演示故事「收票→入账→应收」在此接通。
  const num = (v: any): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };
  registerActionHandler('invoice.book', async (payload, ctx) => {
    const { invoice_id } = payload as { invoice_id: string };
    const s = ctx.store;
    const rows = await s.query('business', 'invoices', { id: invoice_id });
    if (!rows.length) throw new Error(`发票不存在: ${invoice_id}`);
    const inv = rows[0] as any;
    // 同一张发票可能挂着多张待确认卡（AI 反复提案 / 页面重试）。记账表 append-only，
    // 迟到的那张确认卡若照常执行会再写一条记账 → 账上凭空多一笔。状态即闸门，在 handler 层拦。
    if (inv.status === '已入账') throw new Error(`该发票已入账（${inv.invoice_no || invoice_id}），不可重复入账`);
    if (inv.status !== '已入库') throw new Error('仅已入库发票可入账');
    if (inv.invoice_direction === '出项' && !String(payload.customer_id || inv.customer_id || '')) throw new Error('出项发票入账需先挂客户');
    if (!Number.isFinite(Number(inv.total_amount)) || Number(inv.total_amount) <= 0) throw new Error('发票金额必须为有限正数');
    if (!['进项','出项'].includes(inv.invoice_direction)) throw new Error('发票方向必须为进项或出项');
    const r = await accountInvoiceToLedger(s, inv);
    if (!r.posted) throw new Error(`入账失败：${r.reason || '未知'}`);
    if (inv.invoice_direction === '出项') {
      // 出项 = 开给客户的销项发票 → 应收台账（挂客户；客户在审核页选定）
      const customer_id = String(payload.customer_id || inv.customer_id || '');
      if (!customer_id) throw new Error('出项发票入账需先挂客户（审核页选择客户后入账）');
      // 客户名查主档（不信任前端传值，与 order.create 同规则）
      const custs = await s.query('business', 'customers', { id: customer_id });
      if (!custs.length) throw new Error('所选客户不存在');
      const customer_name = String(custs[0].name);
      const exist = (await s.query('business', 'receivables', { invoice_id })).filter(row=>row.status!=='已撤销');
      if (!exist.length) {
        await s.insert('business', 'receivables', {
          invoice_id, customer_id, customer_name,
          amount: num(inv.total_amount), received: 0, status: '未收',
          due_date: '', created_at: new Date().toISOString(),
        });
      }
    } else {
      // 进项 = 从供应商收的进项发票 → 应付台账（供应商=销方；可在审核页改）
      const supplier = String(payload.supplier || inv.supplier || inv.seller_name || '');
      const exist = (await s.query('business', 'payables', { invoice_id })).filter(row=>row.status!=='已撤销');
      if (supplier && !exist.length) {
        await s.insert('business', 'payables', {
          invoice_id, supplier,
          amount: num(inv.total_amount), paid: 0, status: '未付',
          due_date: '', created_at: new Date().toISOString(),
        });
      }
    }
    await s.update('business', 'invoices', invoice_id, { status: '已入账', ledger_record_id: r.ledger_record_id });
  });
  // ledger.post：人工记一笔 → 记账表投影更新（append-only；方向 select 进项/出项）
  registerActionHandler('ledger.post', async (payload, ctx) => {
    const s = ctx.store;
    const { counterparty, total_amount, biz_date, summary, direction, category, account_subject, project_id } = payload as Record<string, any>;
    return s.insert('business', 'ledger', {
      source_key: `action:${ctx.executionId}`, execution_id: ctx.executionId,
      summary: summary || '',
      posted_at: new Date().toISOString(),
      biz_date: biz_date || '',
      direction: direction || '进项',
      counterparty: counterparty || '',
      total_amount: Number(total_amount) || 0,
      category: String(category || ''),
      account_subject: String(account_subject || ''),
      project_id: String(project_id || ''),
      maker: '尚书',
      note: '人工记一笔（事件写总线）',
    });
  });
  // invoice.approve（2026-08-19）：对话内审核入库——待审 → 已入库（人点确认卡才生效，防线不省）。
  registerActionHandler('invoice.approve', async (payload, ctx) => {
    const s = ctx.store;
    const invoice_id = String(payload.invoice_id || '');
    const rows = await s.query('business', 'invoices', { id: invoice_id });
    if (!rows.length) throw new Error(`发票不存在: ${invoice_id}`);
    const inv = rows[0] as any;
    if (inv.status !== '待审') throw new Error(`仅「待审」发票可入库，当前为「${inv.status}」`);
    const fields = validateInvoicePatch((payload.fields || {}) as Record<string, unknown>);
    await s.update('business', 'invoices', invoice_id, { ...fields, status: '已入库', reviewed_at: new Date().toISOString() });
  });
  registerActionHandler('invoice.edit', async (payload, ctx) => {
    const id = String(payload.invoice_id);
    const [inv] = await ctx.store.query('business','invoices',{id});
    if (!inv || !['待审','已入库'].includes(inv.status)) throw new Error('仅待审/已入库发票可修正；已入账记录必须红冲');
    await ctx.store.update('business','invoices',id,validateInvoicePatch(payload.fields as Record<string,unknown>));
  });
  // invoice.reject（2026-08-19）：拒票闭环——待审/已入库 → 已拒绝（已入账的票在解析层就拦住，走 ledger.reverse）。
  registerActionHandler('invoice.reject', async (payload, ctx) => {
    const s = ctx.store;
    const invoice_id = String(payload.invoice_id || '');
    const rows = await s.query('business', 'invoices', { id: invoice_id });
    if (!rows.length) throw new Error(`发票不存在: ${invoice_id}`);
    const inv = rows[0] as any;
    if (inv.status === '已拒绝') throw new Error('该发票已是「已拒绝」状态');
    if (inv.status === '已入账') throw new Error('已入账发票不可拒（append-only，需 ledger.reverse 红冲）');
    await s.update('business', 'invoices', invoice_id, {
      status: '已拒绝', reviewed_at: new Date().toISOString(),
      review_note: String(payload.reason || inv.review_note || ''),
    });
  });
  // ledger.reverse（2026-08-19）：红冲——追加一条负金额冲销记录，原记录不动（append-only）。
  registerActionHandler('ledger.reverse', reverseLedger);
  registerActionHandler('invoice.unbook', async (payload,ctx)=>{
    const [invoice]=await ctx.store.query('business','invoices',{id:String(payload.invoice_id)});
    if(!invoice || invoice.status!=='已入账' || !invoice.ledger_record_id) throw new Error('仅已入账发票可撤回入账');
    return reverseLedger({ledger_id:invoice.ledger_record_id,reason:payload.reason},ctx);
  });
  registerActionHandler('cash.reverse',reversePayment);
  registerActionHandler('cash.record',async(payload,ctx)=>{
    const amount=minor(payload.amount);
    if(amount<=0 || !['收款','付款'].includes(String(payload.direction))) throw new Error('收付款金额或方向无效');
    return ctx.store.insert('business','cash_movements',{id:ctx.executionId,execution_id:ctx.executionId,entity_type:'cash',entity_id:ctx.executionId,direction:payload.direction,amount_minor:amount,occurred_on:validDate(payload.occurred_on),counterparty:payload.counterparty,account:payload.account || '',note:payload.note || '',actor:ctx.actor.id,created_at:new Date().toISOString()});
  });
  // im.send：消息 → im.messages 投影（写路径与发票/记账一致：事件先落库）；client_msg_id 供路由层幂等重试判重
  registerActionHandler('im.send', async (payload, ctx) => {
    const { chat_id, sender_id, text, client_msg_id, reply_to } = payload as Record<string, any>;
    const [chat]=await ctx.store.query('im','chats',{id:chat_id});
    if(sender_id!==ctx.actor.id || !chat || !JSON.parse(String(chat.member_ids||'[]')).includes(sender_id))throw new Error('不在该会话中，无法发言');
    await validateReply(ctx.store,chat_id,String(reply_to||''));
    const extras=normalizeMessageExtras(payload);await validateMessageExtras(ctx.store,chat_id,extras);
    if(String(text||'').length>20000||(!String(text||'').trim()&&!extras.files.length))throw new Error('消息须有正文或文件，正文最多20000字');
    const [last]=await ctx.store.query('im','messages',{chat_id},{sort:{key:'created_at',dir:'desc'},limit:1});
    await ctx.store.insert('im', 'messages', {
      chat_id, sender_id, text: String(text || ''), client_msg_id: String(client_msg_id || ''),
      reply_to: String(reply_to || ''),
      mentions:JSON.stringify(extras.mentions),file_refs:JSON.stringify(extras.files),forwarded:Number(payload.forwarded===true),forward_origin:String(payload.forward_origin||''),
      payload_hash: messageFingerprint(String(text||''),String(reply_to||''),extras),
      created_at: new Date(Math.max(Date.now(),Date.parse(String(last?.created_at||''))+1||0)).toISOString(),
    });
  });
  // —— 进销存主档（M1 2026-08-07）：客户/产品写操作统一走事件写总线（审计留痕、可追溯）。
  // 表单提交为「用户发起即确认」模式（proposed → 立即 confirmed），与 ledger.post 一致；AI 发起才挂确认卡。
  registerActionHandler('customer.create', async (payload, ctx) => {
    const { name, contact, phone, address } = payload as Record<string, any>;
    // R2：返回真实 id → 确认后补 linking 事件（责任链可沿实体查回）
    return ctx.store.insert('business', 'customers', {
      name: String(name || '').trim(), contact: String(contact || ''), phone: String(phone || ''),
      address: String(address || ''), status: '启用', created_at: new Date().toISOString(),
    });
  });
  registerActionHandler('customer.update', async (payload, ctx) => {
    const { id, ...fields } = payload as Record<string, any>;
    const patch: any = {};
    for (const k of ['name', 'contact', 'phone', 'address', 'status']) if (fields[k] !== undefined) patch[k] = fields[k];
    await ctx.store.update('business', 'customers', String(id), patch);
  });
  registerActionHandler('product.create', async (payload, ctx) => {
    const { sku, name, spec, unit, price, cost } = payload as Record<string, any>;
    return ctx.store.insert('business', 'products', {
      sku: String(sku || '').trim(), name: String(name || '').trim(), spec: String(spec || ''),
      unit: String(unit || ''), price: Number(price) || 0, cost: Number(cost) || 0,
      status: '启用', created_at: new Date().toISOString(),
    });
  });
  registerActionHandler('product.update', async (payload, ctx) => {
    const { id, ...fields } = payload as Record<string, any>;
    const patch: any = {};
    for (const k of ['sku', 'name', 'spec', 'unit', 'price', 'cost', 'status']) if (fields[k] !== undefined) patch[k] = fields[k];
    await ctx.store.update('business', 'products', String(id), patch);
  });
  // —— 项目主档（R1）：发票/应收挂项目用；写路径与客户/产品一致（用户即确认）——
  registerActionHandler('project.create', async (payload, ctx) => {
    const { name, customer_id, desc } = payload as Record<string, any>;
    if (!name || !String(name).trim()) throw new Error('项目创建需 name');
    return ctx.store.insert('business', 'projects', {
      name: String(name).trim(), customer_id: String(customer_id || ''), desc: String(desc || ''),
      status: '启用', created_at: new Date().toISOString(),
    });
  });
  // —— 任务（W11 2026-08-20）：任务广场真表——逾期预警/确认卡产出与手动任务落同一张表 ——
  registerActionHandler('task.create',createTask);
  registerActionHandler('task.update',updateTask);
  // —— 帖子广场（2026-08-20）：老板派活/AI 预警抛帖；post.claim = 认领（自己挂名） ——
  registerActionHandler('post.create', async (payload, ctx) => {
    const { content, author, author_role, source } = payload as Record<string, any>;
    if (!content || !String(content).trim()) throw new Error('帖子创建需 content');
    return ctx.store.insert('process', 'posts', {
      created_by:ctx.actor.id, content: String(content).trim(), author: String(author || 'AI'), author_role: String(author_role || 'agent'),
      source: String(source || '手动'), status: '待认领', assignee: '',
      created_at: new Date().toISOString(),
    });
  });
  registerActionHandler('post.claim',claimPost);
  // 表格中心行内编辑（2026-08-28）：改任务帖内容/认领人/状态；只改声明过的字段，状态走白名单
  registerActionHandler('post.update', async (payload, ctx) => {
    const { id, content, assignee, status } = payload as Record<string, any>;
    if (!id) throw new Error('帖子更新需 id');
    const [post] = await ctx.store.query('process', 'posts', { id: String(id) });
    if (!post) throw new Error(`帖子不存在: ${id}`);
    const patch: Record<string, any> = {};
    if (content != null && String(content).trim()) patch.content = String(content).trim();
    if (assignee != null) patch.assignee = String(assignee).trim();
    if (status != null) {
      if (!['待认领', '已认领', '已完成'].includes(String(status))) throw new Error(`非法状态: ${status}`);
      patch.status = String(status);
    }
    if (!Object.keys(patch).length) throw new Error('没有可更新的字段（content/assignee/status）');
    await ctx.store.update('process', 'posts', String(id), patch);
    return String(id);
  });
  // —— 订单（M2）：创建（含明细）→ 确认（生成应收）→ 完成/取消。金额服务端重算，防前端改数。——
  const orderTotal = (items: Array<Record<string, any>>): number =>
    Math.round((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) * 100) / 100;
  registerActionHandler('order.create', async (payload, ctx) => {
    const store = ctx.store;
    const { customer_id, items, note } = payload as Record<string, any>;
    if (!customer_id || !Array.isArray(items) || !items.length) throw new Error('订单需客户与至少一条明细');
    // R4：单价一律查产品主档（不信前端传值）——AI 路径（resolveConfirmPayload）早已如此，页面/API 路径补齐
    const priced: Array<Record<string, any>> = [];
    for (const it of items) {
      const prods = await store.query('business', 'products', { id: String(it.product_id || '') });
      const p = prods[0] as any;
      if (!p) throw new Error(`产品不存在: ${it.product_id}（明细须用主档产品）`);
      priced.push({ product_id: p.id, product_name: p.name, sku: p.sku, qty: Number(it.qty) || 0, price: num(p.price) });
    }
    if (!priced.every((it) => it.qty > 0)) throw new Error('明细数量需大于 0');
    const total = orderTotal(priced);
    // 客户名从主档查（不信任前端传值，保证应收台账/列表显示一致）
    const custs = await store.query('business', 'customers', { id: String(customer_id) });
    const customer_name = custs[0]?.name || '';
    const order_no = 'SO-' + Date.now().toString(36).toUpperCase();
    const orderId = await store.insert('business', 'orders', {
      order_no, customer_id: String(customer_id), customer_name,
      status: '草稿', total_amount: total, note: String(note || ''), created_at: new Date().toISOString(),
    });
    for (const it of priced) {
      await store.insert('business', 'order_items', {
        order_id: orderId, product_id: String(it.product_id || ''),
        product_name: String(it.product_name || ''), sku: String(it.sku || ''),
        qty: Number(it.qty) || 0, price: Number(it.price) || 0,
        amount: Math.round((Number(it.qty) || 0) * (Number(it.price) || 0) * 100) / 100,
      });
    }
    return orderId;   // R2：返回真实 id → linking 事件
  });
  // 订单确认：草稿→已确认，并生成应收台账（金额=订单总额，未收）——应收是演示故事第 6 环数据源。
  registerActionHandler('order.confirm', async (payload, ctx) => {
    const store = ctx.store;
    const orderId = String(payload.order_id);
    const orders = await store.query('business', 'orders', { id: orderId });
    if (!orders.length) throw new Error(`订单不存在: ${orderId}`);
    const order = orders[0] as any;
    if (order.status !== '草稿') {
      // R4：投影重放时「已确认」直接跳过（幂等）；实时路径保持严格报错
      throw new Error(`仅草稿订单可确认，当前 ${order.status}`);
    }
    await store.update('business', 'orders', orderId, { status: '已确认' });
    const exist = await store.query('business', 'receivables', { order_id: orderId });
    if (!exist.length) {
      await store.insert('business', 'receivables', {
        order_id: orderId, customer_id: String(order.customer_id || ''), customer_name: String(order.customer_name || ''),
        amount: Number(order.total_amount) || 0, received: 0, status: '未收',
        due_date: '', created_at: new Date().toISOString(),
      });
    }
  });
  registerActionHandler('order.complete', async (payload, ctx) => {
    const store = ctx.store;
    const orderId = String(payload.order_id);
    const orders = await store.query('business', 'orders', { id: orderId });
    if (!orders.length) throw new Error(`订单不存在: ${orderId}`);
    const order = orders[0] as any;
    if (order.status !== '已确认') throw new Error(`仅已确认订单可完成，当前 ${order.status}`);
    await store.update('business', 'orders', orderId, { status: '已完成' });
  });
  registerActionHandler('order.cancel', async (payload, ctx) => {
    const store = ctx.store;
    const orderId = String(payload.order_id);
    const orders = await store.query('business', 'orders', { id: orderId });
    if (!orders.length) throw new Error(`订单不存在: ${orderId}`);
    const order = orders[0] as any;
    if (order.status === '已完成') throw new Error('已完成订单不可取消');
    if (order.status === '已取消') throw new Error('订单已取消');
    await store.update('business', 'orders', orderId, { status: '已取消' });
  });
  // —— 采购（M3）：创建 → 确认 → 收货（入库联动 + 应付生成）→ 完成。金额服务端重算。——
  const purchaseTotal = (items: Array<Record<string, any>>): number =>
    Math.round((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) * 100) / 100;
  // 库存投影/发货编排在 core/erp-ops.ts（路由与 AI 工具共用）
  registerActionHandler('purchase.create', async (payload, ctx) => {
    const store = ctx.store;
    const { supplier, type, items, note, order_id } = payload as Record<string, any>;
    if (!supplier || !String(supplier).trim() || !Array.isArray(items) || !items.length) throw new Error('采购单需供应商与至少一条明细');
    // R4：单价查产品主档（采购按成本价 cost 计，与订单按售价 price 区分；不信前端传值）
    const priced: Array<Record<string, any>> = [];
    for (const it of items) {
      const prods = await store.query('business', 'products', { id: String(it.product_id || '') });
      const p = prods[0] as any;
      if (!p) throw new Error(`产品不存在: ${it.product_id}（明细须用主档产品）`);
      priced.push({ product_id: p.id, product_name: p.name, sku: p.sku, qty: Number(it.qty) || 0, price: num(p.cost) });
    }
    if (!priced.every((it) => it.qty > 0)) throw new Error('明细数量需大于 0');
    const total = purchaseTotal(priced);
    const purchase_no = 'PO-' + Date.now().toString(36).toUpperCase();
    const pid = await store.insert('business', 'purchases', {
      purchase_no, supplier: String(supplier).trim(), type: String(type || '常规'),
      order_id: String(order_id || ''), status: '草稿', total_amount: total,
      note: String(note || ''), created_at: new Date().toISOString(),
    });
    for (const it of priced) {
      await store.insert('business', 'purchase_items', {
        purchase_id: pid, product_id: String(it.product_id || ''),
        product_name: String(it.product_name || ''), sku: String(it.sku || ''),
        qty: Number(it.qty) || 0, price: Number(it.price) || 0,
        amount: Math.round((Number(it.qty) || 0) * (Number(it.price) || 0) * 100) / 100,
      });
    }
    return pid;   // R2：返回真实 id → linking 事件
  });
  registerActionHandler('purchase.confirm', async (payload, ctx) => {
    const store = ctx.store;
    const pid = String(payload.purchase_id);
    const rows = await store.query('business', 'purchases', { id: pid });
    if (!rows.length) throw new Error(`采购单不存在: ${pid}`);
    if (rows[0].status !== '草稿') throw new Error(`仅草稿采购单可确认，当前 ${rows[0].status}`);
    await store.update('business', 'purchases', pid, { status: '已确认' });
  });
  // 收货：逐项入库（库存 + 流水）→ 生成应付台账（未付）。核心联动点（M3 验证）。
  registerActionHandler('purchase.receive', async (payload, ctx) => {
    const store = ctx.store;
    const pid = String(payload.purchase_id);
    const rows = await store.query('business', 'purchases', { id: pid });
    if (!rows.length) throw new Error(`采购单不存在: ${pid}`);
    const p = rows[0] as any;
    if (p.status !== '已确认') throw new Error(`仅已确认采购单可收货，当前 ${p.status}`);
    const items = await store.query('business', 'purchase_items', { purchase_id: pid });
    for (const it of items) {
      const prods = await store.query('business', 'products', { id: String(it.product_id) });
      const prod = prods[0] || { id: it.product_id, name: it.product_name, sku: it.sku };
      await applyInventory(store, prod as any, Number(it.qty) || 0, '入库', '采购', pid);
    }
    await store.update('business', 'purchases', pid, { status: '已收货' });
    const exist = await store.query('business', 'payables', { purchase_id: pid });
    if (!exist.length) {
      await store.insert('business', 'payables', {
        purchase_id: pid, supplier: String(p.supplier || ''), amount: Number(p.total_amount) || 0,
        paid: 0, status: '未付', due_date: '', created_at: new Date().toISOString(),
      });
    }
  });
  registerActionHandler('purchase.complete', async (payload, ctx) => {
    const store = ctx.store;
    const pid = String(payload.purchase_id);
    const rows = await store.query('business', 'purchases', { id: pid });
    if (!rows.length) throw new Error(`采购单不存在: ${pid}`);
    if (rows[0].status !== '已收货') throw new Error(`仅已收货采购单可完成，当前 ${rows[0].status}`);
    await store.update('business', 'purchases', pid, { status: '已完成' });
  });
  // —— 库存出库（M4）：发货/领用走 inventory.move，库存不足阻止（事件链留痕失败）——
  registerActionHandler('inventory.move', async (payload, ctx) => {
    const store = ctx.store;
    const { product_id, qty, ref_type, ref_id } = payload as Record<string, any>;
    const n = Number(qty) || 0;
    if (!product_id || n <= 0) throw new Error('出库需产品与数量>0');
    const prods = await store.query('business', 'products', { id: String(product_id) });
    const prod = prods[0] as any;
    await applyInventory(store, prod || { id: product_id, name: '', sku: '' }, n, '出库', String(ref_type || '发货'), String(ref_id || ''));
  });
  // —— 发货出库（A1）：订单发货 = 确认卡授权一次 → shipOrder 编排（预校验→逐项出库→完成）。
  // 路由（人触发）与 AI 工具（agent 提案）共用同一 handler，执行逻辑在 core/erp-ops.ts。——
  registerActionHandler('order.ship', async (payload, ctx) => {
    await shipOrder(ctx.store, String(payload.order_id));
  });
  // —— 回款登记（M5）：客户付款 → 登记金额 → 应收 received/status 迁移（未收→部分→已收）——
  registerActionHandler('receivable.pay',(payload,ctx)=>registerPayment('receivable',payload,ctx));
  registerActionHandler('payable.pay',(payload,ctx)=>registerPayment('payable',payload,ctx));
}
