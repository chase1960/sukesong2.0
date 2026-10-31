// 进销存公共编排（A1 2026-08-10）：路由与 AI 工具共用的写操作执行函数。
// 原则：一切写操作最终走事件（确认卡）→ handler 调本模块函数更新投影；AI 永不直接调本模块。
// resolveConfirmPayload：把 LLM 的自然语言参数（业务名）解析成事件 payload（查表解析 id），
// 解析失败返回明确错误 → harness 回传 LLM 重试，不产生垃圾提案。
import type { StateStore } from '../core/types.ts';

// —— 库存投影：入库 +qty / 出库 -qty（校验充足）；流水 append-only ——
export async function applyInventory(
  store: StateStore, product: Record<string, any>, qty: number,
  type: '入库' | '出库', refType: string, refId: string,
): Promise<void> {
  const rows = await store.query('business', 'inventory', { product_id: product.id });
  const cur = rows[0] as any;
  const curQty = cur ? Number(cur.qty) || 0 : 0;
  if (type === '出库' && curQty < qty) throw new Error(`库存不足：${product.name || product.id} 当前 ${curQty}，需 ${qty}`);
  const nextQty = Math.round((curQty + (type === '入库' ? qty : -qty)) * 100) / 100;
  if (cur) await store.update('business', 'inventory', cur.id, { qty: nextQty, updated_at: new Date().toISOString() });
  else await store.insert('business', 'inventory', { product_id: product.id, product_name: product.name || '', sku: product.sku || '', qty: nextQty, updated_at: new Date().toISOString() });
  await store.insert('business', 'inventory_movements', {
    product_id: product.id, product_name: product.name || '', sku: product.sku || '',
    type, qty, ref_type: refType, ref_id: refId, created_at: new Date().toISOString(),
  });
}

// 发货出库编排（order.ship handler / 路由共用）：校验订单 + 明细 + 预校验库存 → 逐项出库 → 完成。
// 预校验保证编排不中途失败（库存不足时一个库存都不动，避免半出库状态）。
export async function shipOrder(store: StateStore, orderId: string): Promise<{ shipped: number }> {
  const orders = await store.query('business', 'orders', { id: orderId });
  if (!orders.length) throw new Error(`订单不存在: ${orderId}`);
  const order = orders[0] as any;
  if (order.status !== '已确认') throw new Error(`仅已确认订单可发货，当前 ${order.status}`);
  const items = await store.query('business', 'order_items', { order_id: orderId });
  if (!items.length) throw new Error('订单无明细，不可发货（数据异常，请检查 order_items）');
  for (const it of items) {
    const invs = await store.query('business', 'inventory', { product_id: String(it.product_id) });
    const cur = invs[0] ? Number(invs[0].qty) || 0 : 0;
    if (cur < Number(it.qty)) throw new Error(`库存不足：${it.product_name || it.product_id} 当前 ${cur}，需 ${it.qty}`);
  }
  for (const it of items) {
    const prods = await store.query('business', 'products', { id: String(it.product_id) });
    const prod = prods[0] || { id: it.product_id, name: it.product_name, sku: it.sku };
    await applyInventory(store, prod as any, Number(it.qty) || 0, '出库', '发货', String(order.order_no || orderId));
  }
  await store.update('business', 'orders', orderId, { status: '已完成' });
  return { shipped: items.length };
}

// —— 渐进吸收（2026-08-19，小功能）：按对方单位统计历史记账习惯，给人/AI 没填的字段做推荐。
// ⚠ 维护注意（改这里之前必读）：
//   1. 这是「推荐」不是「规则」——只填充调用方没给的字段，且必须在 UI 上小字标注来源；
//      绝不覆盖用户显式输入，绝不静默改变历史数据。
//   2. 阈值默认 3 次（runtime_config.habit.min_count 可覆盖）：宁可不推荐，不可乱推荐——
//      阈值类逻辑后期难维护，覆盖不到的新场景（新字段/新单据）不要往这里塞，只服务 ledger.post。
//   3. 只读 ledger 投影；红冲记录（负金额）也计入习惯——冲销不改变「这个单位常记什么科目」的事实。
export interface LedgerHabit {
  category: string; account_subject: string; direction: string; count: number;
}
export const HABIT_MIN_COUNT_DEFAULT = 3;
export async function suggestLedgerHabit(store: StateStore, counterparty: string, minCount = HABIT_MIN_COUNT_DEFAULT): Promise<LedgerHabit | null> {
  const name = String(counterparty || '').trim();
  if (!name) return null;
  const rows = await store.query('business', 'ledger', { counterparty: name });
  // 只统计「有内容」的习惯：category/科目 都为空的记录没有可学的
  const combos = new Map<string, { category: string; account_subject: string; direction: string; count: number }>();
  for (const r of rows as any[]) {
    const category = String(r.category || '');
    const account_subject = String(r.account_subject || '');
    if (!category && !account_subject) continue;
    const direction = r.direction === '出项' ? '出项' : '进项';
    const key = `${category}|${account_subject}|${direction}`;
    const cur = combos.get(key) || { category, account_subject, direction, count: 0 };
    cur.count++;
    combos.set(key, cur);
  }
  const top = [...combos.values()].sort((a, b) => b.count - a.count)[0];
  return top && top.count >= minCount ? top : null;
}

// —— AI 工具参数解析：业务名 → 事件 payload。抛错 = 参数无效（消息回传 LLM）。 ——
export interface ConfirmPayload {
  entity_type: string;
  entity_id: string;
  payload: Record<string, any>;
}

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

export async function resolveConfirmPayload(store: StateStore, capability: string, input: Record<string, any>): Promise<ConfirmPayload> {
  const agentId = 'agent:' + Date.now();
  switch (capability) {
    case 'customer.create': {
      if (!input.name || !String(input.name).trim()) throw new Error('客户创建需 name（客户名称）');
      return { entity_type: 'customer', entity_id: agentId, payload: { ...input, name: String(input.name).trim() } };
    }
    case 'product.create': {
      if (!input.sku || !input.name) throw new Error('产品创建需 sku 与 name');
      return { entity_type: 'product', entity_id: agentId, payload: { sku: String(input.sku).trim(), name: String(input.name).trim(), spec: input.spec || '', unit: input.unit || '', price: num(input.price), cost: num(input.cost) } };
    }
    case 'order.create': {
      if (!input.customer_name || !Array.isArray(input.items) || !input.items.length) throw new Error('订单创建需 customer_name 与 items（[{product_sku, qty}]）');
      const custs = await store.query('business', 'customers', { name: String(input.customer_name) });
      if (!custs.length) throw new Error(`客户不存在：${input.customer_name}（先用 customer_create 建客户或改名称）`);
      const items: Array<Record<string, any>> = [];
      for (const it of input.items) {
        const sku = String(it.product_sku || '');
        const prods = await store.query('business', 'products', { sku });
        if (!prods.length) throw new Error(`产品不存在：${sku}（SKU 可从 product_query 查询）`);
        const p = prods[0] as any;
        items.push({ product_id: p.id, product_name: p.name, sku: p.sku, qty: Number(it.qty) || 0, price: num(p.price) });
      }
      if (!items.every((it) => it.qty > 0)) throw new Error('明细数量需大于 0');
      return { entity_type: 'order', entity_id: agentId, payload: { customer_id: custs[0].id, customer_name: custs[0].name, items, note: input.note || '' } };
    }
    case 'order.confirm':
    case 'order.ship':
    case 'order.cancel':
    case 'order.complete': {
      const orderNo = String(input.order_no || '');
      if (!orderNo) throw new Error('需 order_no（订单号，可从 order_query 查询）');
      const orders = await store.query('business', 'orders', { order_no: orderNo });
      if (!orders.length) throw new Error(`订单不存在：${orderNo}`);
      return { entity_type: 'order', entity_id: orders[0].id, payload: { order_id: orders[0].id, order_no: orderNo } };
    }
    case 'purchase.create': {
      if (!input.supplier || !Array.isArray(input.items) || !input.items.length) throw new Error('采购创建需 supplier 与 items（[{product_sku, qty}]）');
      const items: Array<Record<string, any>> = [];
      for (const it of input.items) {
        const sku = String(it.product_sku || '');
        const prods = await store.query('business', 'products', { sku });
        if (!prods.length) throw new Error(`产品不存在：${sku}`);
        const p = prods[0] as any;
        items.push({ product_id: p.id, product_name: p.name, sku: p.sku, qty: Number(it.qty) || 0, price: num(p.price) });
      }
      if (!items.every((it) => it.qty > 0)) throw new Error('明细数量需大于 0');
      return { entity_type: 'purchase', entity_id: agentId, payload: { supplier: String(input.supplier).trim(), type: String(input.type || '常规'), items, note: input.note || '', order_id: '' } };
    }
    case 'purchase.confirm':
    case 'purchase.receive':
    case 'purchase.complete': {
      const no = String(input.purchase_no || '');
      if (!no) throw new Error('需 purchase_no（采购单号，可从 purchase_query 查询）');
      const rows = await store.query('business', 'purchases', { purchase_no: no });
      if (!rows.length) throw new Error(`采购单不存在：${no}`);
      return { entity_type: 'purchase', entity_id: rows[0].id, payload: { purchase_id: rows[0].id, purchase_no: no } };
    }
    case 'receivable.pay': {
      const name = String(input.customer_name || '');
      const amount = num(input.amount);
      if ((!name && !input.receivable_id) || amount <= 0) throw new Error('回款需 receivable_id 或 customer_name 与 amount（金额>0）');
      const recvs = await store.query('business', 'receivables', input.receivable_id ? {id: input.receivable_id} : { customer_name: name });
      const open = recvs.filter((r: any) => (Number(r.amount) - Number(r.received)) > 0)
        .sort((a: any, b: any) => (Number(b.amount) - Number(b.received)) - (Number(a.amount) - Number(a.received)));
      if (!open.length) throw new Error(`${name} 没有未结清的应收（可先用 receivable_query 确认）`);
      const target = open[0] as any;
      const balance = Math.round((Number(target.amount) - Number(target.received)) * 100) / 100;
      if (amount > balance) throw new Error(`回款 ${amount} 超出 ${name} 应收余额 ${balance}`);
      return { entity_type: 'receivable', entity_id: target.id, payload: { receivable_id: target.id, amount } };
    }
    case 'payable.pay': {
      const name = String(input.supplier || '');
      const amount = num(input.amount);
      if ((!name && !input.payable_id) || amount <= 0) throw new Error('付款需 payable_id 或 supplier 与 amount（金额>0）');
      const pays = await store.query('business', 'payables', input.payable_id ? {id: input.payable_id} : { supplier: name });
      const open = pays.filter((r: any) => (Number(r.amount) - Number(r.paid)) > 0)
        .sort((a: any, b: any) => (Number(b.amount) - Number(b.paid)) - (Number(a.amount) - Number(a.paid)));
      if (!open.length) throw new Error(`${name} 没有未结清的应付`);
      const target = open[0] as any;
      const balance = Math.round((Number(target.amount) - Number(target.paid)) * 100) / 100;
      if (amount > balance) throw new Error(`付款 ${amount} 超出 ${name} 应付余额 ${balance}`);
      return { entity_type: 'payable', entity_id: target.id, payload: { payable_id: target.id, amount } };
    }
    case 'invoice.book': {
      // 发票入账（AI 入口）：校验规则与审核页入账完全一致——只认库里的发票、只放「已入库」、
      // 出项必须先挂客户。解析阶段就拦住，避免生成一张注定执行失败的确认卡。
      const id = String(input.invoice_id || '').trim();
      const no = String(input.invoice_no || '').trim();
      if (!id && !no) throw new Error('入账需 invoice_id（界面选中的发票）或 invoice_no（发票号码，可从 invoice_query 查）');
      const rows = id
        ? await store.query('business', 'invoices', { id })
        : await store.query('business', 'invoices', { invoice_no: no });
      if (!rows.length) throw new Error(`发票不存在：${no || id}`);
      if (rows.length > 1) throw new Error(`发票号 ${no} 匹配到 ${rows.length} 张，请让用户在审核页点开要入账的那张`);
      const inv = rows[0] as any;
      if (inv.status === '已入账') throw new Error(`该发票已入账（${inv.invoice_no || inv.id}），记账表 append-only，不可重复入账`);
      if (inv.status !== '已入库') throw new Error(`仅「已入库」发票可入账，当前为「${inv.status}」：请先在审核页核对入库，或确认字段无误后让我走 invoice_approve 提案入库`);
      const direction = inv.invoice_direction === '出项' ? '出项' : '进项';
      const customer_id = String(inv.customer_id || '');
      if (direction === '出项' && !customer_id) throw new Error('出项发票入账要先在审核页挂客户（应收要挂到具体客户，AI 不代选）');
      return {
        entity_type: 'invoice', entity_id: String(inv.id),
        payload: {
          invoice_id: String(inv.id), amount: num(inv.total_amount),
          invoice_no: String(inv.invoice_no || ''), seller_name: String(inv.seller_name || ''),
          direction, customer_id, project_id: String(inv.project_id || ''),
          supplier: direction === '进项' ? String(inv.supplier || inv.seller_name || '') : '',
        },
      };
    }
    case 'invoice.approve': {
      // 审核入库（AI 入口）：待审 → 已入库。防线保留——AI 只提案，确认卡由人点同意才生效。
      const id = String(input.invoice_id || '').trim();
      const no = String(input.invoice_no || '').trim();
      if (!id && !no) throw new Error('入库需 invoice_id（界面选中的发票）或 invoice_no（发票号码，可从 invoice_query/invoice_detail 查）');
      const rows = id
        ? await store.query('business', 'invoices', { id })
        : await store.query('business', 'invoices', { invoice_no: no });
      if (!rows.length) throw new Error(`发票不存在：${no || id}`);
      if (rows.length > 1) throw new Error(`发票号 ${no} 匹配到 ${rows.length} 张，请让用户在审核页点开要入库的那张`);
      const inv = rows[0] as any;
      if (inv.status !== '待审') throw new Error(`仅「待审」发票可入库，当前为「${inv.status}」（已入库的直接用 invoice_book 入账）`);
      return {
        entity_type: 'invoice', entity_id: String(inv.id),
        payload: { invoice_id: String(inv.id), invoice_no: String(inv.invoice_no || ''), seller_name: String(inv.seller_name || ''), amount: num(inv.total_amount) },
      };
    }
    case 'invoice.reject': {
      // 拒票（AI 入口）：只拒「待审/已入库」；已入账的票账已记，只能 ledger.reverse 红冲。
      const id = String(input.invoice_id || '').trim();
      const no = String(input.invoice_no || '').trim();
      if (!id && !no) throw new Error('拒票需 invoice_id（界面选中的发票）或 invoice_no（发票号码）');
      const rows = id
        ? await store.query('business', 'invoices', { id })
        : await store.query('business', 'invoices', { invoice_no: no });
      if (!rows.length) throw new Error(`发票不存在：${no || id}`);
      if (rows.length > 1) throw new Error(`发票号 ${no} 匹配到 ${rows.length} 张，请让用户在审核页点开要拒的那张`);
      const inv = rows[0] as any;
      if (inv.status === '已拒绝') throw new Error('该发票已是「已拒绝」状态');
      if (inv.status === '已入账') throw new Error('该发票已入账，不能拒——记账表 append-only，如需更正请用 ledger_reverse 红冲对应记账记录');
      return {
        entity_type: 'invoice', entity_id: String(inv.id),
        payload: { invoice_id: String(inv.id), invoice_no: String(inv.invoice_no || ''), reason: String(input.reason || '') },
      };
    }
    case 'ledger.reverse': {
      // 红冲（AI 入口）：append-only 铁律——记错不改不删，追加一条负金额冲销记录。
      const lid = String(input.ledger_id || '').trim();
      if (!lid) throw new Error('红冲需 ledger_id（ledger_query 返回样例里的 id）');
      const rows = await store.query('business', 'ledger', { id: lid });
      if (!rows.length) throw new Error(`记账记录不存在：${lid}（可从 ledger_query 样例获取 id）`);
      const rec = rows[0] as any;
      if (num(rec.total_amount) < 0) throw new Error('该记录本身是红冲记录，不能再红冲（要冲就去冲原记录）');
      return {
        entity_type: 'ledger', entity_id: lid,
        payload: {
          ledger_id: lid,
          summary: String(rec.summary || ''), counterparty: String(rec.counterparty || ''),
          total_amount: num(rec.total_amount), direction: rec.direction === '出项' ? '出项' : '进项',
        },
      };
    }
    case 'ledger.post': {
      const amount = num(input.total_amount);
      if (!input.summary || !input.counterparty || amount <= 0) throw new Error('记账需 summary、counterparty、total_amount（金额>0）');
      const category = String(input.category || '');
      if (category && !['收入', '成本', '费用', '其他'].includes(category)) throw new Error('category 只能是 收入/成本/费用/其他');
      // 项目按名解析（AI 不代造 id；项目不存在就让 LLM 回报，先建项目或不挂）
      let project_id = '';
      const projectName = String(input.project_name || '').trim();
      if (projectName) {
        const projs = await store.query('business', 'projects', { name: projectName });
        if (!projs.length) throw new Error(`项目不存在：${projectName}（可先用 project_query 确认，或先在项目页创建）`);
        project_id = String(projs[0].id);
      }
      // 渐进吸收：category/科目没填时按历史习惯推荐填补（显式给了的字段绝不动），
      // payload 标注 habit_suggested 供确认卡/页面小字提示「这是推荐值」。
      let category2 = category;
      let accountSubject2 = String(input.account_subject || '');
      let habit: LedgerHabit | null = null;
      if (!category2 || !accountSubject2) {
        const { loadConfig } = await import('../core/config.ts');
        const minCount = Number(loadConfig().habit?.min_count) || HABIT_MIN_COUNT_DEFAULT;
        habit = await suggestLedgerHabit(store, String(input.counterparty), minCount);
        if (habit) {
          if (!category2) category2 = habit.category;
          if (!accountSubject2) accountSubject2 = habit.account_subject;
        }
      }
      return {
        entity_type: 'ledger', entity_id: agentId,
        payload: {
          summary: String(input.summary), counterparty: String(input.counterparty), total_amount: amount,
          direction: input.direction === '出项' ? '出项' : '进项',
          biz_date: String(input.biz_date || new Date().toISOString().slice(0, 10)),
          category: category2, account_subject: accountSubject2, project_id,
          ...(habit ? { habit_suggested: true, habit_count: habit.count } : {}),
        },
      };
    }
    case 'post.create': {
      if (!input.content || !String(input.content).trim()) throw new Error('帖子创建需 content（帖子正文）');
      return { entity_type: 'post', entity_id: agentId, payload: { ...input, content: String(input.content).trim(), source: String(input.source || '手动'), author: String(input.author || 'AI'), author_role: String(input.author_role || 'agent') } };
    }
    case 'post.update': {
      if (!input.id) throw new Error('帖子更新需 id（帖子 id）');
      const [post] = await store.query('process', 'posts', { id: String(input.id) });
      if (!post) throw new Error(`帖子不存在: ${input.id}`);
      return { entity_type: 'post', entity_id: String(input.id), payload: { id: String(input.id), content: input.content, assignee: input.assignee, status: input.status } };
    }
    case 'post.claim': {
      if (!input.id) throw new Error('认领需 id（帖子 id）');
      return { entity_type: 'post', entity_id: String(input.id), payload: { id: String(input.id), assignee: String(input.assignee || '') } };
    }
    default:
      throw new Error(`未知写操作: ${capability}`);
  }
}
