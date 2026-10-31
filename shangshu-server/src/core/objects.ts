// 对象元数据（小微阶段 · 2026-08-20）：ObjectType / Field / Action 内存注册。
// 业务形状进元数据；object_query / object_propose / 数据对象页读同一份。
// 落库仍走 StateStore；旧 Node 设计背景见 docs/research/legacy-data-and-metadata.md
import { registerTable } from './store.ts';
import { registerActionContract, unregisterActionContract, getActionContract, validateSchema, type JsonSchema } from './action-contracts.ts';
import { currentActor } from './actor.ts';
import { randomUUID } from 'node:crypto';

export type ObjectFieldType = 'text' | 'number' | 'datetime' | 'select' | 'attachment';

export interface FieldSpec {
  id: string;
  label: string;
  type: ObjectFieldType;
  filterable?: boolean;
  options?: string[];
  required?: boolean;
  relation?: { object: string };
}

export interface ActionDef {
  id: string;
  name: string;
  confirm: boolean;
  roles?: string[];
  params?: Array<{ id: string; label: string; required?: boolean }>;
  /** 行上可点：仅当记录 status ∈ 列表时展示（空=不按行展示，走工具栏/对话） */
  whenStatus?: string[];
  revision?: number;
  inputSchema?: JsonSchema;
  /** 可配置动作只允许写扩展对象；预置财务 executor 由受控代码提供。 */
  operation?: 'create' | 'update';
  defaults?: Record<string, unknown>;
  transition?: { from: string[]; to: string };
  rowBinding?: Record<string, string>;
}

export interface ObjectType {
  id: string;
  name: string;
  description: string;
  layer: string;
  table: string;
  fields: FieldSpec[];
  actions: ActionDef[];
  sampleFields: string[];
  dateFilterField?: string;
  /** 小微默认启用；false=扩展包（本阶段不预置） */
  sme?: boolean;
  readRoles?: string[];
  /** 普通员工只能读取此字段等于自己账号的记录；管理员角色仍可看全表。 */
  rowOwnerField?: string;
  revision?: number;
}

const OBJECTS = new Map<string, ObjectType>();

export function clearObjectTypes(): void {
  for(const object of OBJECTS.values()) for(const action of object.actions) if(action.operation) unregisterActionContract(action.id);
  OBJECTS.clear();
}

export function registerObjectType(ot: ObjectType): void {
  if (!ot.id || !ot.layer || !ot.table) throw new Error('ObjectType 需 id / layer / table');
  if (OBJECTS.has(ot.id)) console.warn(`[objects] 对象已存在，覆盖: ${ot.id}`);
  if (ot.actions.some(a => a.operation) && ot.layer !== 'custom') throw new Error('配置动作只能写 custom 层，禁止覆盖系统领域硬约束');
  for(const action of OBJECTS.get(ot.id)?.actions || []) if(action.operation) unregisterActionContract(action.id);
  const frozen = structuredClone({ sme: true, readRoles: ['admin','finance','manager'], ...ot });
  OBJECTS.set(ot.id, frozen);
  registerTable(ot.layer, ot.table, { provision: ot.layer === 'custom', fields: Object.fromEntries(ot.fields.map(f => [f.id, f.type])) });
  for (const action of frozen.actions) {
    if (!action.operation) continue;
    const schema = action.inputSchema || (action.operation === 'update' ? {
      ...objectInputSchema(frozen), required: ['id','expected_version'],
      properties: {...objectInputSchema(frozen).properties, id:{type:'string',minLength:1},expected_version:{type:'integer',minimum:1}},
    } : objectInputSchema(frozen));
    registerActionContract({ id: action.id, revision: action.revision || frozen.revision || 1,
      roles: action.roles || ['admin'], confirmation: 'human', inputSchema: schema,
      resolve: async (_store, data) => ({ entity_type: frozen.id, entity_id: action.operation === 'create' ? `agent:${randomUUID()}` : String(data.id || ''), payload: data }),
      execute: async (input, ctx) => {
        const { id, expected_version, ...fields } = input;
        for (const field of frozen.fields.filter(f => f.relation && fields[f.id] != null)) {
          const target = getObjectType(field.relation!.object);
          if (!target || !(await ctx.store.query(target.layer, target.table, { id: fields[field.id] })).length) throw new Error(`关联记录不存在: ${field.id}`);
        }
        if (action.operation === 'create') {
          const record={...action.defaults,...fields};
          validateSchema(objectInputSchema(frozen),record);
          return ctx.store.insert(frozen.layer, frozen.table, { ...record, id: `obj:${ctx.executionId}` });
        }
        const [record] = await ctx.store.query(frozen.layer, frozen.table, { id: String(id || '') });
        if (!record) throw new Error('记录不存在');
        if (action.transition && !action.transition.from.includes(record.status)) throw new Error('当前状态不允许此动作');
        if (typeof expected_version !== 'number') throw new Error('更新必须携带 expected_version，防止确认期间记录已变化');
        const patch = { ...fields, ...(action.transition ? { status: action.transition.to } : {}) };
        const merged={...Object.fromEntries(frozen.fields.filter(f=>record[f.id]!==undefined).map(f=>[f.id,record[f.id]])),...patch};
        validateSchema(objectInputSchema(frozen),merged);
        if (!await ctx.store.compareAndSet?.(frozen.layer, frozen.table, record.id, expected_version, patch)) throw new Error('记录版本已变化，请重新提案');
        return record.id;
      },
    }, { replace: true });
  }
}

export function objectInputSchema(ot: ObjectType): JsonSchema {
  return { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(ot.fields.map(f => [f.id, { type: f.type === 'number' ? 'number' : 'string', ...(f.options ? { enum: f.options } : {}) }])),
    required: ot.fields.filter(f => f.required).map(f => f.id) };
}

export function getObjectType(id: string): ObjectType | undefined {
  const object = OBJECTS.get(id);
  return object && structuredClone(object);
}

export function listObjectTypes(): ObjectType[] {
  return [...OBJECTS.values()].map(object=>structuredClone(object));
}

export function resolveObjectAction(ot: ObjectType, action: string): ActionDef {
  const raw = String(action || '').trim();
  if (!raw) throw new Error('action 必填');
  const hit = ot.actions.find((a) =>
    a.id === raw
    || a.id === `${ot.id}.${raw}`
    || a.name === raw
    || a.id.endsWith(`.${raw}`),
  );
  if (!hit) {
    const ids = ot.actions.map((a) => a.id).join(', ');
    throw new Error(`对象 ${ot.id} 无动作「${raw}」。可选：${ids || '（无）'}`);
  }
  return hit;
}

export function listObjectSummaries() {
  const actor = currentActor();
  return listObjectTypes().filter(o => !actor || actor.role === 'admin' || (o.readRoles || ['admin','finance','manager']).includes(actor.role)).map((o) => ({
    id: o.id,
    name: o.name,
    description: o.description,
    layer: o.layer,
    table: o.table,
    sme: o.sme !== false,
    field_count: o.fields.length,
    sampleFields: o.sampleFields,
    fields: o.fields.map((f) => ({
      id: f.id, label: f.label, type: f.type, filterable: !!f.filterable, options: f.options, required:f.required, relation:f.relation,
    })),
    actions: o.actions.filter(a => {
      if (!actor || actor.role === 'admin') return true;
      try { return getActionContract(a.id).roles.includes(actor.role); } catch { return false; }
    }).map((a) => ({
      id: a.id,
      name: a.name,
      confirm: a.confirm,
      roles: a.roles || [],
      params: a.params || [],
      input_schema: a.inputSchema || (() => { try { return getActionContract(a.id).inputSchema; } catch { return { type: 'object' }; } })(),
      row_binding: a.rowBinding || (a.operation === 'update' ? {id:'id',expected_version:'_version'} : {}),
      when_status: a.whenStatus || [],
    })),
    row_owner_field: o.rowOwnerField || '',
  }));
}

export function summarizeProposal(
  ot: ObjectType,
  action: ActionDef,
  payload: Record<string, unknown>,
): { title: string; lines: string[] } {
  const no = String(payload.invoice_no || payload.summary || payload.name || payload.id || '');
  const party = String(
    payload.seller_name || payload.supplier || payload.customer_name || payload.counterparty || '',
  );
  const amount = payload.amount ?? payload.total_amount;
  const title = `${action.name}${no ? ` · ${no}` : ''}${party ? ` · ${party}` : ''}`;
  const lines: string[] = [`对象 ${ot.name}（${ot.id}）· 动作 ${action.id}`];
  if (amount != null && amount !== '') lines.push(`金额 ${amount}`);
  if (payload.direction) lines.push(`方向 ${payload.direction}`);
  if (payload.reason) lines.push(`原因 ${payload.reason}`);
  const labels=Object.fromEntries([...ot.fields,...(action.params || [])].map(f=>[f.id,f.label]));
  for(const [key,value] of Object.entries(payload)) {
    if(value==null || value==='' || ['amount','total_amount','direction','reason'].includes(key)) continue;
    lines.push(`${labels[key] || key}：${typeof value==='object' ? JSON.stringify(value) : String(value)}`);
  }
  lines.push(action.confirm ? '需人工确认后才会写入' : '将直接执行');
  return { title, lines };
}

/** 小微预置包：发票 / 记账 / 应收 / 应付 / 收付款（代码种子；启动时写入 meta_registry） */
export function getPresetObjectTypes(): ObjectType[] {
  return [
    {id:'cash',name:'收付款流水',description:'实际收付款，与发票入账分开统计；登记错误用冲回',layer:'business',table:'cash_movements',dateFilterField:'occurred_on',readRoles:['admin','finance','manager'],sampleFields:['id','occurred_on','direction','counterparty','amount_minor','account','note','reversal_of'],
      fields:[{id:'occurred_on',label:'业务日期',type:'datetime',filterable:true},{id:'direction',label:'方向',type:'select',options:['收款','付款'],filterable:true},{id:'counterparty',label:'往来单位',type:'text',filterable:true},{id:'amount_minor',label:'金额（元）',type:'number'},{id:'account',label:'账户',type:'text'},{id:'note',label:'说明',type:'text'},{id:'reversal_of',label:'冲回原流水',type:'text'}],
      actions:[{id:'cash.record',name:'登记独立收付款',confirm:true,roles:['admin','finance']},{id:'cash.reverse',name:'冲回错误登记',confirm:true,roles:['admin','finance'],rowBinding:{movement_id:'id'}}]},
    {
      id: 'invoice',
      name: '发票',
      description: '进项/出项发票；审核入库与入账',
      layer: 'business',
      table: 'invoices',
      dateFilterField: 'received_at',
      sampleFields: [
        'id', 'invoice_no', 'invoice_type', 'invoice_direction',
        'seller_name', 'buyer_name', 'total_amount', 'status', 'received_at',
      ],
      fields: [
        { id: 'invoice_no', label: '发票号码', type: 'text', filterable: true },
        { id: 'invoice_code', label: '发票代码', type: 'text' },
        { id: 'check_code', label: '校验码', type: 'text' },
        { id: 'invoice_type', label: '发票类型', type: 'select', filterable: true },
        { id: 'invoice_direction', label: '发票方向', type: 'select', filterable: true, options: ['进项', '出项'] },
        { id: 'seller_name', label: '开票方', type: 'text', filterable: true },
        { id: 'buyer_name', label: '购买方', type: 'text', filterable: true },
        { id: 'amount_ex_tax', label: '不含税额', type: 'number' },
        { id: 'tax_amount', label: '税额', type: 'number' },
        { id: 'total_amount', label: '价税合计', type: 'number' },
        { id: 'issued_at', label: '开票日期', type: 'datetime' },
        { id: 'received_at', label: '收件时间', type: 'datetime', filterable: true },
        { id: 'status', label: '状态', type: 'select', filterable: true, options: ['待审', '已入库', '已拒绝', '已入账'] },
        { id: 'source', label: '来源', type: 'text' },
        { id: 'customer_id', label: '客户', type: 'text' },
        { id: 'project_id', label: '项目', type: 'text' },
      ],
      actions: [
        {id:'invoice.unbook',name:'撤回入账并重新核对',confirm:true,roles:['admin','finance'],whenStatus:['已入账'],rowBinding:{invoice_id:'id'},params:[{id:'reason',label:'撤回原因',required:true}]},
        {
          id: 'invoice.approve', rowBinding: {invoice_id:'id'}, name: '审核入库', confirm: true,
          roles: ['admin', 'finance'], whenStatus: ['待审'],
          params: [{ id: 'invoice_id', label: '发票 id' }, { id: 'invoice_no', label: '发票号码' }],
        },
        {
          id: 'invoice.reject', rowBinding: {invoice_id:'id'}, name: '拒票', confirm: true,
          roles: ['admin', 'finance'], whenStatus: ['待审', '已入库'],
          params: [{ id: 'invoice_id', label: '发票 id' }, { id: 'invoice_no', label: '发票号码' }, { id: 'reason', label: '原因' }],
        },
        {
          id: 'invoice.book', rowBinding: {invoice_id:'id'}, name: '入账', confirm: true,
          roles: ['admin', 'finance'], whenStatus: ['已入库'],
          params: [{ id: 'invoice_id', label: '发票 id' }, { id: 'invoice_no', label: '发票号码' }],
        },
      ],
    },
    {
      id: 'ledger',
      name: '记账',
      description: '记账流水 · append-only；错账红冲',
      layer: 'business',
      table: 'ledger',
      dateFilterField: 'posted_at',
      sampleFields: [
        'id', 'summary', 'counterparty', 'direction', 'total_amount',
        'category', 'biz_date', 'posted_at',
      ],
      fields: [
        { id: 'summary', label: '摘要', type: 'text', filterable: true },
        { id: 'counterparty', label: '对方单位', type: 'text', filterable: true },
        { id: 'direction', label: '方向', type: 'select', filterable: true, options: ['进项', '出项'] },
        { id: 'amount_ex_tax', label: '不含税额', type: 'number' },
        { id: 'tax_amount', label: '税额', type: 'number' },
        { id: 'total_amount', label: '价税合计', type: 'number' },
        { id: 'category', label: '收支类型', type: 'select', filterable: true, options: ['收入', '成本', '费用', '其他'] },
        { id: 'account_subject', label: '会计科目', type: 'text' },
        { id: 'biz_date', label: '业务日期', type: 'datetime' },
        { id: 'posted_at', label: '入账日期', type: 'datetime', filterable: true },
        { id: 'invoice_no', label: '发票号码', type: 'text', filterable: true },
        { id: 'project_id', label: '项目', type: 'text' },
      ],
      actions: [
        {
          id: 'ledger.post', name: '记一笔', confirm: true,
          roles: ['admin', 'finance'],
          params: [
            { id: 'summary', label: '摘要', required: true },
            { id: 'counterparty', label: '对方单位', required: true },
            { id: 'total_amount', label: '金额', required: true },
            { id: 'direction', label: '方向' },
            { id: 'category', label: '收支类型' },
          ],
        },
        {
          id: 'ledger.reverse', rowBinding: {ledger_id:'id'}, name: '红冲', confirm: true,
          roles: ['admin', 'finance'],
          params: [{ id: 'ledger_id', label: '记账 id', required: true }],
        },
      ],
    },
    {
      id: 'receivable',
      name: '应收',
      description: '应收台账；登记回款',
      layer: 'business',
      table: 'receivables',
      sampleFields: [
        'id', 'customer_name', 'amount', 'received', 'status', 'due_date', 'invoice_id',
      ],
      fields: [
        { id: 'customer_name', label: '客户', type: 'text', filterable: true },
        { id: 'customer_id', label: '客户 id', type: 'text' },
        { id: 'amount', label: '应收金额', type: 'number' },
        { id: 'received', label: '已收', type: 'number' },
        { id: 'status', label: '状态', type: 'select', filterable: true, options: ['未收', '部分已收', '已收'] },
        { id: 'due_date', label: '到期日', type: 'text' },
        { id: 'invoice_id', label: '发票', type: 'text' },
        { id: 'order_id', label: '订单', type: 'text' },
      ],
      actions: [
        {
          id: 'receivable.pay', rowBinding: {receivable_id:'id',customer_name:'customer_name'}, name: '登记回款', confirm: true,
          roles: ['admin', 'finance', 'manager'],
          whenStatus: ['未收', '部分已收'],
          params: [
            { id: 'customer_name', label: '客户名', required: true },
            { id: 'amount', label: '回款金额', required: true },
          ],
        },
      ],
    },
    {
      id: 'payable',
      name: '应付',
      description: '应付台账；登记付款',
      layer: 'business',
      table: 'payables',
      sampleFields: [
        'id', 'supplier', 'amount', 'paid', 'status', 'due_date', 'invoice_id',
      ],
      fields: [
        { id: 'supplier', label: '供应商', type: 'text', filterable: true },
        { id: 'amount', label: '应付金额', type: 'number' },
        { id: 'paid', label: '已付', type: 'number' },
        { id: 'status', label: '状态', type: 'select', filterable: true, options: ['未付', '部分已付', '已付'] },
        { id: 'due_date', label: '到期日', type: 'text' },
        { id: 'invoice_id', label: '发票', type: 'text' },
        { id: 'purchase_id', label: '采购单', type: 'text' },
      ],
      actions: [
        {
          id: 'payable.pay', rowBinding: {payable_id:'id',supplier:'supplier'}, name: '登记付款', confirm: true,
          roles: ['admin', 'finance', 'manager'],
          whenStatus: ['未付', '部分已付'],
          params: [
            { id: 'supplier', label: '供应商', required: true },
            { id: 'amount', label: '付款金额', required: true },
          ],
        },
      ],
    },
    {
      // 任务既是协作页，也是通用数据对象；员工的行级范围由 rowOwnerField 声明。
      id: 'task',
      name: '任务',
      description: '可派发、反馈、验收的协作任务；员工仅可读取和更新分配给自己的记录',
      layer: 'process',
      table: 'tasks',
      dateFilterField: 'created_at',
      readRoles: ['admin', 'finance', 'manager', 'staff'],
      rowOwnerField: 'assignee_id',
      sampleFields: ['id', 'title', 'status', 'assignee', 'priority', 'start_date', 'end_date', 'pct', 'result', 'source'],
      fields: [
        { id: 'title', label: '任务', type: 'text', filterable: true },
        { id: 'status', label: '状态', type: 'select', options: ['待办', '进行中', '待验收', '已完成'], filterable: true },
        { id: 'assignee', label: '负责人', type: 'text', filterable: true },
        { id: 'assignee_id', label: '负责人账号', type: 'text', filterable: true },
        { id: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'], filterable: true },
        { id: 'project', label: '项目', type: 'text', filterable: true },
        { id: 'start_date', label: '开始日期', type: 'datetime', filterable: true },
        { id: 'end_date', label: '截止日期', type: 'datetime', filterable: true },
        { id: 'pct', label: '进度', type: 'number' },
        { id: 'result', label: '完成结果', type: 'text' },
        { id: 'source', label: '来源', type: 'text', filterable: true },
        { id: 'created_at', label: '创建时间', type: 'datetime', filterable: true },
      ],
      actions: [
        { id: 'task.create', name: '派发任务', confirm: true, roles: ['admin', 'finance', 'manager'] },
        { id: 'task.update', name: '更新任务', confirm: true, roles: ['admin', 'finance', 'manager', 'staff'], rowBinding: { id: 'id', expected_version: '_version' } },
      ],
    },
    {
      // 帖子保留为兼容对象，但不再占用任务管理主导航。
      id: 'post',
      name: '任务帖子',
      description: '帖子广场的协作任务：发布、认领、进度；是"事"不是"账"，不进账本',
      layer: 'process',
      table: 'posts',
      dateFilterField: 'created_at',
      readRoles: ['admin', 'finance', 'manager', 'staff'],
      sampleFields: ['id', 'content', 'status', 'author', 'assignee', 'source', 'created_at'],
      fields: [
        { id: 'content', label: '任务内容', type: 'text' },
        { id: 'status', label: '状态', type: 'select', options: ['待认领', '已认领', '已完成'], filterable: true },
        { id: 'assignee', label: '认领人', type: 'text', filterable: true },
        { id: 'author', label: '发布人', type: 'text', filterable: true },
        { id: 'source', label: '来源', type: 'select', options: ['手动', '逾期预警', '确认卡'], filterable: true },
        { id: 'created_at', label: '发布时间', type: 'datetime', filterable: true },
      ],
      actions: [
        { id: 'post.create', name: '发布任务帖', confirm: true, roles: ['admin', 'manager', 'finance'] },
        // 表格中心行内编辑：改内容/认领人/状态（rowBinding 让行内编辑直接带 id）
        { id: 'post.update', name: '编辑任务帖', confirm: true, roles: ['admin', 'manager', 'finance'],
          rowBinding: { id: 'id' },
          params: [
            { id: 'content', label: '任务内容' },
            { id: 'assignee', label: '认领人' },
            { id: 'status', label: '状态' },
          ] },
      ],
    },
  ];
}

export function registerPresetObjects(): void {
  for (const ot of getPresetObjectTypes()) registerObjectType(ot);
}
