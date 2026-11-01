// StateStore —— 开发约定 §10 / spec §5.2
// SQLite 是业务事务主库；local 为兼容别名。bitable 为旧数据/外部适配器，不具备事务保证。
import { existsSync } from 'node:fs';
import { openSqliteStore } from './storage/sqlite.ts';
import { join } from 'node:path';
import type { StateStore, RuntimeConfig } from './types.ts';
import { DATA_DIR, loadConfig } from './config.ts';
import { listRecords, createRecords, updateRecords, listTables, createTable, listFields, createField } from './feishu.ts';

// R4：按当前配置取运行时 store（与 server.ts 旧 getStore 同逻辑，供 handler 模块与路由共用）
export function getRuntimeStore(): StateStore {
  const cfg = loadConfig();
  return cfg.store.provider === 'bitable' ? createBitableStore(cfg.feishu) : localStore;
}

// local 是旧配置兼容别名，新的本地数据统一使用事务 SQLite。
// 发现旧 JSON 时拒绝隐式切库；迁移命令验证并保留所有记录 ID 后才创建主库。
function localDatabase() {
  const dir = process.env._SS_DATA_DIR || DATA_DIR;
  const path = join(dir, 'state.sqlite');
  if (!existsSync(path) && existsSync(join(dir, 'store.json'))) {
    throw new Error('检测到旧 store.json，请先运行 migrate:store 显式迁移；未修改原数据');
  }
  return openSqliteStore(path);
}
export const localStore: StateStore = {
  guarantees: { transactions: true, conditionalUpdate: true, stableIds: true, appendOnlyAudit: true },
  query: (...args) => localDatabase().query(...args),
  insert: (...args) => localDatabase().insert(...args),
  update: (...args) => localDatabase().update(...args),
  delete: (...args) => localDatabase().delete(...args),
  transaction: (fn) => localDatabase().transaction(fn),
  inTransaction: () => localDatabase().inTransaction(),
  compareAndSet: (...args) => localDatabase().compareAndSet(...args),
};

// —— bitable 实现：飞书多维表格（OpenAPI 直连，多表通用）——
// 能力代码只认 StateStore 接口 + 英文字段；列名映射、cell 值转换、表解析都在本层完成。
//
// 多表地基：
//   - registerTable(layer, table, spec) 注册表规格（字段类型 / 中文列名映射 / 是否自动建表）
//   - 既有两表（发票库/记账表）中文列名，走显式 cnMap；表 id 取 runtime_config
//   - 新表（cognition.users 等）英文列名，按 `层__实体` 命名，启动/首用时自动建表
// 日期：bitable datetime 字段写 epoch ms、读回转 ISO。select：写选项名、读回 [值] 取首项。

export type FieldType = 'text' | 'number' | 'datetime' | 'select' | 'attachment';
export interface TableSpec {
  /** 飞书表名（默认 `${layer}__${table}`）；既有两表用配置里的 table_id，不走名字 */
  name?: string;
  /** 找不到时自动建表（新表开；既有两表关，防误建） */
  provision?: boolean;
  /** 字段类型（读写转换依据）。未声明的字段按 text 透传 */
  fields?: Record<string, FieldType>;
  /** 中文字段 → 英文字段（仅既有中文表用） */
  cnMap?: Record<string, string>;
  /** select 字段的选项（自动建表时用） */
  options?: Record<string, string[]>;
}

const TABLE_SPECS = new Map<string, TableSpec>();
export function decodeBitableRecord(layer:string,table:string,record:{record_id:string;fields:Record<string,any>}):Record<string,any> {
  const spec=TABLE_SPECS.get(tkey(layer,table)) || {};
  const row:Record<string,any>={id:record.record_id};
  for(const [key,value] of Object.entries(record.fields)) {
    const field=spec.cnMap?.[key] || key;
    if(field==='id') { row._legacy_id=value; continue; }
    row[field]=cellRead(spec.fields?.[field] || 'text',field,value);
    if(['steps','input','result','template','actor','capability_revisions','fieldMappings'].includes(field) && typeof row[field]==='string' && row[field]) row[field]=JSON.parse(row[field]);
  }
  return row;
}
const tkey = (layer: string, table: string) => `${layer}.${table}`;

export function registerTable(layer: string, table: string, spec: TableSpec): void {
  const old = TABLE_SPECS.get(tkey(layer, table));
  TABLE_SPECS.set(tkey(layer, table), { ...old, ...spec, fields: { ...old?.fields, ...spec.fields } });
}

// 发票库（既有，中文列名）
const INVOICE_CN: Record<string, string> = {
  '发票代码': 'invoice_code', '发票号码': 'invoice_no', '发票类型': 'invoice_type', '发票方向': 'invoice_direction',
  '开票方': 'seller_name', '购买方': 'buyer_name', '不含税额': 'amount_ex_tax', '税额': 'tax_amount', '价税合计': 'total_amount',
  '开票日期': 'issued_at', '校验码': 'check_code', '状态': 'status', '来源': 'source', '发件邮箱': 'sender_email',
  '邮件主题': 'email_subject', '收件时间': 'received_at', '置信度': 'confidence',
  '校验警告': 'validation_warnings', '审核人': 'reviewer', '审核时间': 'reviewed_at', '审核备注': 'review_note',
  '入账记录': 'ledger_record_id', '发票文件': 'file_token', '原始识别': 'raw_extract',
  // 恒等映射（R1 遗留修复 2026-08-19）：customer_id/project_id 是英文列名，
  // 缺这两条时 cnMap 反查不到 → 读被跳过、写被静默丢弃（bitable 上发票挂客户/项目会丢）。
  'customer_id': 'customer_id', 'project_id': 'project_id',
};
registerTable('business', 'invoices', {
  cnMap: INVOICE_CN,
  fields: {
    invoice_type: 'select', invoice_direction: 'select', status: 'select',
    amount_ex_tax: 'number', tax_amount: 'number', total_amount: 'number', confidence: 'number',
    issued_at: 'datetime', received_at: 'datetime', reviewed_at: 'datetime',
    file_token: 'attachment',
    // R1（2026-08-14）：发票挂客户/项目——入账按方向联动台账的数据源（出项→应收，进项→应付）
    customer_id: 'text', project_id: 'text',
  },
});
// 记账表（既有，中文列名；append-only 由 ledger.ts 直写，此处注册供查询）
registerTable('business', 'ledger', {
  cnMap: {
    '摘要': 'summary', '入账日期': 'posted_at', '业务日期': 'biz_date', '方向': 'direction',
    '对方单位': 'counterparty', '金额(不含税)': 'amount_ex_tax', '税额': 'tax_amount', '价税合计': 'total_amount',
    '发票号码': 'invoice_no', '发票代码': 'invoice_code', '会计科目': 'account_subject',
    '凭证号': 'voucher_no', '制单人': 'maker', '备注': 'note',
    // W3（2026-08-19）：收支类型/项目——对话记账三列；飞书侧由自动加列按中文名补齐
    '收支类型': 'category', '项目': 'project_id',
  },
  fields: {
    posted_at: 'datetime', biz_date: 'datetime', direction: 'select',
    amount_ex_tax: 'number', tax_amount: 'number', total_amount: 'number',
    category: 'select', account_subject: 'text', project_id: 'text',
  },
  options: { category: ['收入', '成本', '费用', '其他'] },
});
// 用户表（新，自动建表）。collaboration_group：协作分组（管理/开发/财务，空=不收窄），
// 只作用于任务兼容层的选人与可见范围，不参与对象/字段/流程权限。
registerTable('cognition', 'users', {
  provision: true,
  fields: { username: 'text', password_hash: 'text', role: 'select', display_name: 'text', status: 'select', collaboration_group: 'text', created_at: 'datetime' },
  options: { role: ['admin', 'finance', 'manager', 'staff'], status: ['启用', '停用'] },
});
// 元数据注册表（M3+）：object / doctype / flow JSON 持久化
registerTable('cognition', 'meta_registry', {
  provision: true,
  fields: {
    kind: 'select', key: 'text', payload: 'text', version: 'number', updated_at: 'datetime',
  },
  options: { kind: ['object', 'doctype', 'flow'] },
});
// 事务主库的内部状态：登记字段契约，但不在外部适配器中自动建表。
registerTable('cognition', 'meta_revisions', {
  provision: false,
  fields: { kind: 'text', key: 'text', version: 'number', payload: 'text', hash: 'text', created_at: 'text' },
});
registerTable('cognition', 'meta_drafts', {
  provision: false,
  fields: { kind: 'text', key: 'text', payload: 'text', base_version: 'number', status: 'text', author: 'text', created_at: 'text' },
});
registerTable('cognition', 'attachments', {
  provision: false,
  fields: { token: 'text', filename: 'text', mime: 'text', uploaded: 'text' },
});
registerTable('execution', 'action_executions', {
  provision: false,
  fields: {
    action_id: 'text', action_revision: 'number', entity_type: 'text', entity_id: 'text',
    payload: 'text', resource_snapshot: 'text', initiator: 'text', reviewer: 'text',
    status: 'text', attempt: 'number', result_id: 'text', error: 'text', created_at: 'text', finished_at: 'text',
  },
});
registerTable('execution', 'job_runs', {
  provision: false,
  fields: {
    trigger_id: 'text', started_at: 'text', finished_at: 'text', status: 'text',
    collected: 'number', added: 'number', duplicate: 'number', failed: 'number', log: 'text',
  },
});
registerTable('execution', 'import_previews', {
  provision: false,
  fields: { kind: 'text', rows: 'text', hash: 'text', actor: 'text', status: 'text', created_at: 'text', execution_id: 'text', applied_at: 'text' },
});
registerTable('business', 'cash_movements', {
  provision: false,
  fields: {
    execution_id: 'text', entity_type: 'text', entity_id: 'text', direction: 'text', counterparty: 'text',
    amount_minor: 'number', balance_before_minor: 'number', occurred_on: 'text', account: 'text',
    note: 'text', reversal_of: 'text', actor: 'text', created_at: 'text',
  },
});
// 操作审计（新，自动建表）
registerTable('execution', 'operation_logs', {
  provision: true,
  fields: { at: 'datetime', username: 'text', role: 'text', action: 'text', target: 'text', detail: 'text' },
});
// 事件写总线（新，自动建表；P1 2026-08-06）：所有写操作的统一真相。
// payload 用 text 列存 JSON 字符串（读写转换在 core/events.ts 完成）；hash-chain 防篡改。
registerTable('execution', 'events', {
  provision: true,
  fields: {
    capability: 'text', entity_type: 'text', entity_id: 'text',
    payload: 'text', schema_version: 'number',
    status: 'text', initiator: 'text', reviewer: 'text', executor: 'text',
    prev_hash: 'text', hash: 'text', created_at: 'text',
  },
});
// 办事流程运行轨迹（M3）：每步 attribution / warnings 可回放
// 图流程审批任务（2026-08-28）：approval 节点的待办卡（serial=逐 slot；any=每角色一张首个决定生效）
registerTable('execution', 'flow_approvals', {
  provision: true,
  fields: {
    run_id: 'text', flow_id: 'text', node_id: 'text', node_name: 'text',
    mode: 'text', role: 'text', slot: 'text',
    status: 'text', note: 'text', input_summary: 'text',
    created_at: 'text', decided_at: 'text', decided_by: 'text',
  },
});
registerTable('execution', 'flow_runs', {
  provision: true,
  fields: {
    flow_id: 'text', status: 'text', started_at: 'text', finished_at: 'text',
    initiator: 'text', input_summary: 'text', steps: 'text', result: 'text', error: 'text',
  },
});
// AI 对话记录（新，自动建表；P4 2026-08-07）：对话历史存 execution 层（任务书任务 6）。
// 单用户单会话：conversation_id = 用户名；role = user | assistant（工具中间过程不落表，只落最终问答）。
registerTable('execution', 'chat_audit_events', {provision: true, fields: {actor_key:'text',conversation_id:'text',turn_id:'text',request_id:'text',event_json:'text'}});
registerTable('execution', 'chat_audit_sources', {
  provision: true,
  fields: { actor_key: 'text', conversation_id: 'text', turn_id: 'text', proposal_id: 'text', context_json: 'text' },
});
registerTable('execution', 'chat_messages', {
  provision: true,
  fields: {
    conversation_id: 'text',
    turn_id: 'text',
    role: 'text',             // user | assistant
    content: 'text',
    reasoning: 'text',        // 思考过程（thinking 模型的 reasoning / reasoning_content），界面可折叠回看
    created_at: 'text',
  },
});
// 任务管理（W11，2026-08-20 实装）：任务广场真表——逾期预警/确认卡产出与手动任务都落到这里。
registerTable('process', 'tasks', {
  provision: true,
  fields: {
    title: 'text', project: 'text', assignee: 'text', assignee_id: 'text', created_by: 'text',
    status: 'text',            // 待办 | 进行中 | 待验收 | 已完成
    priority: 'text',          // 高 | 中 | 低
    source: 'text',            // 手动 | 逾期预警 | 确认卡
    start_date: 'text', end_date: 'text',
    pct: 'number', result: 'text', post_id: 'text', created_at: 'text',
  },
});
registerTable('process', 'notifications', {
  provision: false,
  fields: { recipient: 'text', task_id: 'text', message: 'text', title: 'text',
    entity_type: 'text', entity_id: 'text', action_url: 'text', dedupe_key: 'text',
    read_at: 'text', created_at: 'text' },
});
// 帖子广场（2026-08-20）：AI 与员工的公开动态——预警/确认卡产出抛到广场，人可认领、可回复进度。
registerTable('process', 'posts', {
  provision: true,
  fields: {
    content: 'text', author: 'text', author_role: 'text',
    source: 'text',            // 逾期预警 | 确认卡 | 手动
    status: 'text',            // 待认领 | 已认领 | 已完成
    assignee: 'text', created_at: 'text',
  },
});
registerTable('process', 'post_replies', {
  provision: true,
  fields: {
    post_id: 'text', author: 'text', content: 'text', created_at: 'text',
  },
});
// —— 进销存 + 财务闭环（2026-08-07，M1-M5）——
// 客户主档：订单/应收的关联起点；停用代替删除（append-only 精神）。
registerTable('business', 'customers', {
  provision: true,
  fields: {
    name: 'text', contact: 'text', phone: 'text', address: 'text',
    status: 'select', created_at: 'text',
  },
  options: { status: ['启用', '停用'] },
});
// 产品主档（SKU）：订单明细/库存/成本核算的基础；price=销售价，cost=成本（毛利用）。
registerTable('business', 'products', {
  provision: true,
  fields: {
    sku: 'text', name: 'text', spec: 'text', unit: 'text',
    price: 'number', cost: 'number', status: 'select', created_at: 'text',
  },
  options: { status: ['启用', '停用'] },
});
// 销售订单（M2）：状态机 草稿→已确认→已完成（可取消）；确认时生成应收台账（M5 读）。
// 金额由服务端按明细重算（防前端改数）；items 用 JSON 文本列存（bitable 兼容，明细行数少）。
registerTable('business', 'orders', {
  provision: true,
  fields: {
    order_no: 'text', customer_id: 'text', customer_name: 'text',
    status: 'select', total_amount: 'number', note: 'text', created_at: 'text',
  },
  options: { status: ['草稿', '已确认', '已完成', '已取消'] },
});
registerTable('business', 'order_items', {
  provision: true,
  fields: {
    order_id: 'text', product_id: 'text', product_name: 'text', sku: 'text',
    qty: 'number', price: 'number', amount: 'number',
  },
});
// 应收台账（M2 生成 / M5 深度使用）：订单确认 → 一条应收（未收）；回款登记更新 received/status。
// R1：发票出项入账也生成应收（invoice_id 溯源）。
registerTable('business', 'receivables', {
  provision: true,
  fields: {
    order_id: 'text', invoice_id: 'text', customer_id: 'text', customer_name: 'text',
    amount: 'number', received: 'number', status: 'select', due_date: 'text', created_at: 'text',
  },
  options: { status: ['未收', '部分已收', '已收'] },
});
// 采购单（M3）：状态机 草稿→已确认→已收货→已完成；收货时逐项入库（库存联动）并生成应付台账。
// type 保留 常规/外采/库存 三分类字段（YMF 需求 FR-10 简化版）。
registerTable('business', 'purchases', {
  provision: true,
  fields: {
    purchase_no: 'text', supplier: 'text', type: 'select', order_id: 'text',
    status: 'select', total_amount: 'number', note: 'text', created_at: 'text',
  },
  options: { type: ['常规', '外采', '库存'], status: ['草稿', '已确认', '已收货', '已完成'] },
});
registerTable('business', 'purchase_items', {
  provision: true,
  fields: {
    purchase_id: 'text', product_id: 'text', product_name: 'text', sku: 'text',
    qty: 'number', price: 'number', amount: 'number',
  },
});
// 应付台账（M3）：采购收货 → 一条应付（未付）；付款登记更新 paid/status。
// R1：发票进项入账也生成应付（invoice_id 溯源，供应商=销方）。
registerTable('business', 'payables', {
  provision: true,
  fields: {
    purchase_id: 'text', invoice_id: 'text', supplier: 'text',
    amount: 'number', paid: 'number', status: 'select', due_date: 'text', created_at: 'text',
  },
  options: { status: ['未付', '部分已付', '已付'] },
});
// 库存（M4）：当前量由出入库流水投影；inventory_movements append-only。
registerTable('business', 'inventory', {
  provision: true,
  fields: { product_id: 'text', product_name: 'text', sku: 'text', qty: 'number', updated_at: 'text' },
});
registerTable('business', 'inventory_movements', {
  provision: true,
  fields: {
    product_id: 'text', product_name: 'text', sku: 'text',
    type: 'select', qty: 'number', ref_type: 'text', ref_id: 'text', created_at: 'text',
  },
  options: { type: ['入库', '出库'] },
});
// 每日经营简报（A3 2026-08-10）：定时聚合经营数据生成；metrics 用 text 存 JSON。
registerTable('execution', 'briefs', {
  provision: true,
  fields: {
    brief_date: 'text', content: 'text', metrics: 'text', created_at: 'text',
  },
});
// 主动提醒（A4 2026-08-10）：逾期/库存预警等；status 待处理/已处理。
registerTable('execution', 'alerts', {
  provision: true,
  fields: {
    type: 'text', title: 'text', detail: 'text', ref_type: 'text', ref_id: 'text',
    status: 'select', created_at: 'text',
  },
  options: { status: ['待处理', '已处理'] },
});
// 用户工作区启用（2026-08-10）：user_id → 启用的工作区 id 列表（JSON 文本列）。
// 用独立表而非 users 加列：不动 bitable 已建 users 表结构。
registerTable('cognition', 'user_workspaces', {
  provision: true,
  fields: {
    user_id: 'text', workspace_ids: 'text',
    custom: 'text',          // 个人自定义工作区 JSON [{id,name,modules}]
    updated_at: 'text',
  },
});
// 数字员工最小运行时（阶段 2）：持久职责配置只引用已发布流程；运行轨迹复用 execution.flow_runs。
// 这里保存的是平台配置/责任归属，不是第二套业务任务或审计事实。
registerTable('cognition', 'worker_profiles', {
  provision: true,
  fields: {
    name: 'text', responsibility: 'text', flow_id: 'text', allowed_tools: 'text',
    owner: 'text', status: 'text', revision: 'number', created_at: 'datetime', updated_at: 'datetime',
  },
  options: { status: ['active', 'paused', 'retired'] },
});
registerTable('execution', 'worker_runs', {
  provision: true,
  fields: {
    profile_id: 'text', flow_run_id: 'text', status: 'text', input: 'text',
    owner: 'text', handoff_to: 'text', pause_reason: 'text', error: 'text',
    created_at: 'datetime', updated_at: 'datetime', completed_at: 'datetime',
  },
  options: { status: ['dispatching', 'running', 'waiting', 'paused', 'handed_off', 'completed', 'failed'] },
});
// 项目主档（R1 2026-08-14）：发票/应收挂项目用；name 必填，customer_id 可空。
registerTable('business', 'projects', {
  provision: true,
  fields: {
    name: 'text', customer_id: 'text', desc: 'text',
    status: 'select', created_at: 'text',
  },
  options: { status: ['启用', '停用'] },
});
// 消息（新，自动建表；2026-08-07）：真实 IM——会话 + 消息。// 写路径：im.send 事件（confirmed）→ handler 落 messages（与发票/记账同一机制）。
// member_ids / last_read / archived 用 text 存 JSON；未读按 last_read 游标计算。
registerTable('im', 'chats', {
  provision: true,
  fields: {
    type: 'text',            // dm | group
    name: 'text',            // 群名（dm 可空）
    member_ids: 'text',      // JSON [username]
    created_by: 'text',
    last_read: 'text',       // JSON { username: isoTime } 每人已读游标
    archived: 'text',        // JSON { username: isoTime } 私聊本人归档（只影响本人列表）
    created_at: 'text',
  },
});
registerTable('im', 'messages', {
  provision: true,
  fields: {
    chat_id: 'text',
    sender_id: 'text',
    text: 'text',
    client_msg_id: 'text',  // 客户端幂等键：同键重试不重复落消息
    reply_to: 'text',      // 同会话原消息ID，不复制原文
    payload_hash: 'text',  // 回执指纹，撤回后仍能判断同键重试
    mentions: 'text', file_refs: 'text', forwarded: 'number', forward_origin: 'text',
    created_at: 'text',
  },
});
registerTable('im', 'preferences', {
  provision: true,
  fields: { chat_id:'text', user_id:'text', pinned:'number', muted:'number' },
});
registerTable('im','favorites',{provision:true,fields:{user_id:'text',chat_id:'text',message_id:'text',created_at:'text'}});

// （原 runLark 子进程封装已移除——bitable 读写改为 feishu.ts 直连飞书 OpenAPI，不再依赖 lark-cli 二进制）
export const toMs = (v: any): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};

function cellWrite(type: FieldType, f: string, v: any): any {
  if (v === undefined || v === null || v === '') return null;
  if (type === 'datetime') return toMs(v);
  if (type === 'attachment') return null; // 附件列不经 StateStore 写（走 uploadMedia + updateRecords）
  if (type === 'number') { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null; }
  // text / select：对象一律 JSON 字符串（validation_warnings / raw_extract 等快照字段）
  if (typeof v === 'object') return JSON.stringify(v);
  // 发票号码/代码强制字符串：数电 20 位号码写进 number 列会丢精度，且读回 number 与 string 去重 === miss
  if (f === 'invoice_no' || f === 'invoice_code') return String(v);
  return v;
}
function cellRead(type: FieldType, f: string, v: any): any {
  if (Array.isArray(v)) v = v[0]; // select / attachment 读回 [值]
  if (v === undefined || v === null) v = '';
  if (type === 'attachment' && typeof v === 'object') v = v?.file_token ?? '';
  if (type === 'datetime' && v) {
    const n = typeof v === 'number' ? v : Date.parse(String(v).replace(' ', 'T'));
    return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 19) : String(v);
  }
  if ((f === 'validation_warnings') && v) { try { return JSON.parse(v); } catch { return {}; } }
  if ((f === 'invoice_no' || f === 'invoice_code') && v !== '') return String(v);
  return v;
}

// 表 id 解析 + 自动建表（按 app 缓存表清单）
const tableListCache = new Map<string, { at: number; items: { table_id: string; name: string }[] }>();
// R1：字段补齐检查节流（每表每 60s 一次；避免每次 query 都 listFields）
const fieldsCheckCache = new Map<string, number>();

// —— bitable 记录级缓存（R0 2026-08-14）——
// 问题：每次 query = 一次飞书全表拉取（实测单次 1.2~2.7s），dashboard 一个请求 events 拉 4 次。
// 方案：模块级缓存（getStore() 每次 new 实例，挂实例上等于没缓存）按 app_token+tableId 存，TTL 5s；
//       同表并发 in-flight 去重（同一请求 4 次 events 合成 1 次飞书往返）；
//       insert/update 该表时**代际失效**（bump generation，连「已发出的旧拉取」一起作废）——
//       否则在途拉取落地会把刚写入的新数据覆盖成旧缓存（确认卡「刚点同意、刷新还是待确认」）。
const RECORD_CACHE_TTL = 5000;
// 低频变更表的更长 TTL（写操作会即时失效，TTL 只是兜底）——users 表 60s：
// 登录/会话校验频繁读 users，5s TTL 会导致每次登录都全表拉一次（bitable 1.3~2s）
const RECORD_CACHE_TTL_OVERRIDES: Record<string, number> = { 'cognition.users': 60_000 };
const recordCache = new Map<string, { gen: number; at: number; rows: any[] }>();
const recordInFlight = new Map<string, { gen: number; p: Promise<any[]> }>();
const recordGen = new Map<string, number>();

const recCacheKey = (fs: RuntimeConfig['feishu'], tableId: string) => `${fs.bitable_app_token}::${tableId}`;

function cachedListRecords(fs: RuntimeConfig['feishu'], tableId: string, ttlMs = RECORD_CACHE_TTL): Promise<any[]> {
  const k = recCacheKey(fs, tableId);
  const gen = recordGen.get(k) || 0;
  const hit = recordCache.get(k);
  if (hit && hit.gen === gen && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.rows);
  const flying = recordInFlight.get(k);
  if (flying && flying.gen === gen) return flying.p;
  const p = listRecords(fs, tableId)
    .then((rows) => { recordCache.set(k, { gen, at: Date.now(), rows }); return rows; })
    .finally(() => { recordInFlight.delete(k); });
  recordInFlight.set(k, { gen, p });
  return p;
}

function invalidateRecordCache(fs: RuntimeConfig['feishu'], tableId: string): void {
  const k = recCacheKey(fs, tableId);
  recordGen.set(k, (recordGen.get(k) || 0) + 1);   // 代际+1：在途旧拉取落地后也不会被当作新缓存
  recordCache.delete(k);
  recordInFlight.delete(k);
}

async function resolveTableId(fs: RuntimeConfig['feishu'], layer: string, table: string): Promise<string> {
  if (layer === 'business' && table === 'invoices') return fs.invoices_table_id;
  if (layer === 'business' && table === 'ledger') return fs.ledger_table_id;
  const spec = TABLE_SPECS.get(tkey(layer, table));
  const name = spec?.name || `${layer}__${table}`;
  const ck = fs.bitable_app_token;
  let cache = tableListCache.get(ck);
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = { at: Date.now(), items: await listTables(fs) };
    tableListCache.set(ck, cache);
  }
  const hit = cache.items.find((t) => t.name === name);
  if (hit) {
    // R1：既有表自动补缺列——spec 新增字段（如发票 customer_id）时，飞书表若没有该列则自动创建。
    // 与自动建表同权限路径；失败仅告警（本地 mock / 只读凭证时业务不受影响，仅该列写不进去）。
    const fk = `${fs.bitable_app_token}::${hit.table_id}`;
    const lastCheck = fieldsCheckCache.get(fk) || 0;
    if (spec?.fields && Date.now() - lastCheck > 60_000) {
      fieldsCheckCache.set(fk, Date.now());
      try {
        const existing = new Set((await listFields(fs, hit.table_id)).map((f) => f.field_name));
        const ftype: Record<FieldType, number> = { text: 1, number: 2, select: 3, datetime: 5, attachment: 17 };
        // 2026-08-19 修复：cnMap 表（发票/记账，中文列名）自动加列要用中文列名，
        // 否则会建出英文名列而读写仍按 cnMap 找中文列 → 列建错了地方。
        const en2cnLocal = spec.cnMap ? Object.fromEntries(Object.entries(spec.cnMap).map(([c, e]) => [e, c])) : null;
        for (const [fname, t] of Object.entries(spec.fields)) {
          const colName = en2cnLocal?.[fname] ?? fname;
          if (existing.has(colName)) continue;
          await createField(fs, hit.table_id, { field_name: colName, type: ftype[t], options: spec.options?.[fname] });
          existing.add(colName);
          console.log(`[store] 自动加列：${name}.${colName} → ${hit.table_id}`);
        }
      } catch (e) {
        console.warn(`[store] 自动加列失败（不影响读取）: ${name} -`, (e as Error).message);
      }
    }
    return hit.table_id;
  }
  if (!spec?.provision) throw new Error(`飞书表不存在且未允许自动建表：${name}（${layer}.${table}）`);
  const ftype: Record<FieldType, number> = { text: 1, number: 2, select: 3, datetime: 5, attachment: 17 };
  const fields = Object.entries(spec.fields || {}).map(([fname, t]) => ({
    field_name: fname, type: ftype[t], options: spec.options?.[fname],
  }));
  const id = await createTable(fs, name, fields);
  cache.items.push({ table_id: id, name });
  console.log(`[store] 自动建表：${name} → ${id}`);
  return id;
}

export function createBitableStore(fs: RuntimeConfig['feishu']): StateStore {
  async function specOf(layer: string, table: string) {
    const spec = TABLE_SPECS.get(tkey(layer, table)) || {};
    const tableId = await resolveTableId(fs, layer, table);
    const en2cn = spec.cnMap ? Object.fromEntries(Object.entries(spec.cnMap).map(([c, e]) => [e, c])) : null;
    return { spec, tableId, en2cn };
  }
  // __cacheKey：events 链尾缓存等按数据源分 key（getStore() 每次 new 实例，不能挂实例状态）
  const store: StateStore & { __cacheKey: string } = {
    __cacheKey: 'bitable:' + fs.bitable_app_token,
    guarantees: { transactions: false, conditionalUpdate: false, stableIds: false },
    async query(layer, table, filter, opts) {
      const { spec, tableId } = await specOf(layer, table);
      // R0：无筛选且带 sort/limit 时走云端（只拉需要的行，如链尾 hydrate 取 1 条）；
      //     否则走全表缓存（同一请求 in-flight 去重）再内存 sort/limit。
      const cloud = !filter && !opts?.stable && !opts?.conditions && !opts?.cursor && (opts?.sort || opts?.limit) && !recordCache.has(recCacheKey(fs, tableId));
      const items = cloud
        ? await listRecords(fs, tableId, {
            sort: opts.sort ? [{ field_name: opts.sort.key, desc: opts.sort.dir === 'desc' }] : undefined,
            limit: opts.limit,
          })
        : await cachedListRecords(fs, tableId, RECORD_CACHE_TTL_OVERRIDES[`${layer}.${table}`] ?? RECORD_CACHE_TTL);
      let rows = items.map((it) => {
        const rec: any = { id: it.record_id };
        for (const [col, val] of Object.entries(it.fields)) {
          const en = spec.cnMap ? spec.cnMap[col] : col;  // 新表列名即英文字段名
          if (!en) continue;
          rec[en] = cellRead(spec.fields?.[en] || 'text', en, val);
        }
        return rec;
      });
      // 先筛选后窗口/限量；不能让前页不匹配行吞掉真实结果。
      if(filter)rows=rows.filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v));
      for(const c of opts?.conditions||[])rows=rows.filter(r=>c.op==='contains'?String(r[c.key]??'').toLowerCase().includes(c.value.toLowerCase()):c.op==='includes'?String(r[c.key]??'').includes(c.value):c.op==='gte'?String(r[c.key]??'')>=c.value:String(r[c.key]??'')<c.value);
      if(opts?.cursor){const c=opts.cursor,key=opts.sort?.key||'';rows=rows.filter(r=>{const v=String(r[key]??'');return c.direction==='before'?(v<c.value||v===c.value&&r.id<c.id):(v>c.value||v===c.value&&r.id>c.id);});}
      // 云端路径已按 opts 排序/限量；缓存路径补内存 sort/limit
      if (!cloud && opts?.sort) {
        const { key: sk, dir } = opts.sort;
        rows = [...rows].sort((a, b) => {
          const av = String(a[sk] ?? ''), bv = String(b[sk] ?? '');
          const cmp=(av<bv?-1:av>bv?1:0)||(opts.stable?(a.id<b.id?-1:a.id>b.id?1:0):0);return dir==='desc'?-cmp:cmp;
        });
      }
      if (!cloud && opts?.limit) rows = rows.slice(0, opts.limit);
      // 内存筛选（与 localStore 一致；当前表量小，无需云端 filter）
      if (filter) rows = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
      return rows;
    },
    async insert(layer, table, record) {
      if(layer==='execution'&&['chat_audit_sources','chat_audit_events'].includes(table))throw Error('bitable不具备不可变审计保证，请使用SQLite主存储');
      const { spec, tableId, en2cn } = await specOf(layer, table);
      // 只写有值的字段：空值整列省略，避免给 typed 字段传空报错
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(record)) {
        if (k === 'id' || k === 'file_token') continue;   // 附件 token 不写列（走归档流程）
        const type = spec.fields?.[k] || 'text';
        const col = en2cn ? en2cn[k] : k;
        if (!col) continue;
        const cv = cellWrite(type, k, v);
        if (cv !== null && cv !== undefined && cv !== '') fields[col] = cv;
      }
      const ids = await createRecords(fs, tableId, [fields]);
      invalidateRecordCache(fs, tableId);   // R0：本进程刚写入，旧缓存立即作废（代际失效）
      return ids[0] || 'unknown';
    },
    async update(layer, table, id, patch) {
      if(layer==='execution'&&['chat_audit_sources','chat_audit_events'].includes(table))throw Error('禁止修改审计历史');
      const { spec, tableId, en2cn } = await specOf(layer, table);
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'file_token') continue;
        const type = spec.fields?.[k] || 'text';
        const col = en2cn ? en2cn[k] : k;
        if (!col) continue;
        const cv = cellWrite(type, k, v);
        if (cv !== null && cv !== undefined) fields[col] = cv;
      }
      await updateRecords(fs, tableId, [{ record_id: id, fields }]);
      invalidateRecordCache(fs, tableId);   // R0：同上，写后失效
    },
    // bitable 已降级为旧数据/外部只读适配器：不提供删除（feishu.ts 也未封装删除 API）。
    async delete() {
      throw new Error('bitable 适配器不支持删除（主库已迁 SQLite）');
    },
  };
  return store;
}
