// 尚书共享类型（前后端共用；纯 HTML 前端只认 JSON 形状，不强依赖此文件）。
// 数据模型对齐 spec §7 business__invoices。

export type InvoiceStatus = '待审' | '已入库' | '已拒绝' | '已入账';

export interface Invoice {
  id: string;
  invoice_code: string;
  invoice_no: string;
  invoice_type: string;            // 普票/专票/电子普/电子专/其他
  invoice_direction: string;       // 进项（收到的采购/费用）/ 出项（开出的销售）
  seller_name: string;
  buyer_name: string;
  amount_ex_tax: number;
  tax_amount: number;
  total_amount: number;
  issued_at: string | null;        // YYYY-MM-DD
  check_code: string;
  status: InvoiceStatus;
  source: string;                  // email（以后可扩展）
  sender_email: string;
  email_subject: string;
  received_at: string;             // ISO
  file_token: string;              // FileStore token
  confidence: number;              // 0-1
  validation_warnings: Record<string, string>;
  reviewer: string | null;
  reviewed_at: string | null;
  review_note: string;
  ledger_record_id: string | null;     // 已入账后指向飞书【记账表】记录 id（硬关联；未入账为 null）
  created_at: string;
  updated_at: string;
}

export interface Trigger {
  id: string;
  name: string;
  description: string;
  schedule: string;                // cron
  skill: string;                   // 触发后执行的 skill id
  enabled: boolean;
  params: Record<string, any>;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface JobRun {
  id: string;
  trigger_id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'failed';
  collected: number;
  added: number;
  duplicate: number;
  failed: number;
  log: string[];
}

// —— 能力统一接口（开发约定 §9）——
export interface Capability<I = any, O = any> {
  id: string;
  name: string;
  impl: 'ai' | 'script' | 'external';
  effect?: 'read' | 'extract' | 'ingest' | 'propose' | 'orchestrate' | 'internal';
  revision?: number;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  roles?: string[];
  run: (input: I, ctx: Context) => Promise<O>;
}

// —— OCR 抽取结果 ——
export interface OcrExtractResult {
  fields: Record<string, any>;
  confidence: number;
  validation_warnings: Record<string, string>;
  raw_text: string;
  ocr_path?: string;
}

// —— OCR 服务接口 ——
export interface OcrService {
  start(): Promise<void>;
  extract(formData: FormData): Promise<OcrExtractResult>;
  stop(): void;
}

// —— 外部服务聚合（mail + ocr）——
export interface ExternalServices {
  mail: MailSource;
  ocr: OcrService;
}

// —— 执行上下文：能力只通过 ctx 拿到三缝 + 配置 + 日志，绝不直接碰具体实现 ——
export interface Context {
  actor?: import('./actor.ts').ActorContext;
  selectTool?: (input: { candidates: string[]; input: Record<string, unknown> }) => Promise<{ capability: string; reason: string }>;
  store: StateStore;
  file: FileStore;
  external: ExternalServices;
  config: RuntimeConfig;
  log: (msg: string) => void;
}

// —— 三缝接口（spec §5）——
// 查询选项（R0 2026-08-14）：给契约补 sort/limit——调用方不再被迫「全表拉取 + 内存排」。
// 实现方可在存储层下沉（bitable 走云端 sort + page_size）；不传时行为与旧版完全一致。
export interface QueryOpts {
  sort?: { key: string; dir: 'asc' | 'desc' };
  limit?: number;
  // 可选稳定窗口：按标量排序值+记录ID分页，旧查询默认排序不变。
  stable?: boolean;
  cursor?: { value: string; id: string; direction: 'before' | 'after' };
  conditions?: { key: string; op: 'contains' | 'includes' | 'gte' | 'lt'; value: string }[];
}

export interface StateStore {
  readonly guarantees?: { transactions: boolean; conditionalUpdate: boolean; stableIds: boolean; appendOnlyAudit?: boolean };
  query(layer: string, table: string, filter?: Partial<Record<string, any>>, opts?: QueryOpts): Promise<any[]>;
  insert(layer: string, table: string, record: any): Promise<string>;
  update(layer: string, table: string, id: string, patch: any): Promise<void>;
  // 物理删除。append-only 实体（账本/现金流水/事件链/元数据修订）由实现侧拒绝，保证铁律不被绕过。
  delete(layer: string, table: string, id: string): Promise<void>;
  transaction?<T>(fn: (store: StateStore) => Promise<T>): Promise<T>;
  inTransaction?(): boolean;
  compareAndSet?(layer: string, table: string, id: string, version: number, patch: any): Promise<boolean>;
}

export interface MailSource {
  listUnread(since?: string): Promise<IncomingMail[]>;
  fetchAttachment(mailId: string): Promise<Attachment>;
  markRead(mailId: string): Promise<void>;
  deleteMail(mailId: string): Promise<void>;
}

export interface IncomingMail {
  id: string;
  from: string;
  subject: string;
  received_at: string;
  attachment_id: string;
}

export interface Attachment {
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface FileStore {
  upload(name: string, bytes: Buffer, mime: string): Promise<{ token: string }>;
  read(token: string): Promise<{ bytes: Buffer; mime: string; name: string }>;
}

// —— 运行时配置（runtime_config.json，系统配置页读写）——
export interface LlmSource {
  id: string;
  name: string;
  desc?: string;
  provider: 'ollama' | 'dashscope' | 'deepseek' | 'openai';
  base_url: string;
  model: string;
  api_key: string;
}
export interface RuntimeConfig {
  enterprise?: {name:string};
  server: { port: number; admin_password: string };
  poll: { cron: string; mailbox: string };
  store: { provider: 'local' | 'sqlite' | 'bitable' };
  mail: { provider: 'folder' | 'agently'; folder: string; agently_mailbox: string; delete_after_read: boolean; collect_keywords: string[] };
  file: { provider: 'local' | 'drive'; local_dir: string; drive_folder_token: string };
  feishu: { app_id: string; app_secret: string; bitable_app_token: string; invoices_table_id: string; ledger_table_id: string };
  ocr: { endpoint_url: string; provider: 'mock' | 'dashscope' | 'vllm' | 'qwen-ocr'; api_key: string; base_url: string; model: string; confidence_auto_book: number; port?: number };  // R3：高置信自动入账阈值（0=关闭）；port：OCR 子进程端口（缺省 8001，双实例部署时演示实例配 8002 避撞）
  llm: { provider: 'ollama' | 'dashscope' | 'deepseek' | 'openai'; base_url: string; api_key: string; model: string };
  /** 模型来源：每条自带 base_url 与密钥，切换即整条套用；密钥只存服务器，接口只回脱敏值。 */
  llm_sources?: LlmSource[];
  website: { base_url: string; api_key: string; panel_path: string; panel_key: string };
  alerts: { overdue_days: number; min_stock: number };
  // 渐进吸收（2026-08-19）：历史习惯推荐阈值。可选——缺省 = 代码内默认（见 erp-ops.suggestLedgerHabit）。
  // ⚠ 调高 = 推荐更少更保守；调低 = 推荐更激进。改前先看 worklog 2026-08-19 维护注意。
  habit?: { min_count?: number };
  workspaces: WorkspaceDef[];
}

// —— 工作区（2026-08-10）：面向岗位的模块集合，modules 按工作流先后顺序排列 ——
export interface WorkspaceDef {
  id: string;
  name: string;
  desc: string;
  roles: string[];            // 适用角色（空=全员）
  modules: string[];          // 模块 id，按工作流顺序（发票审核→记账→应收应付…）
  preset?: boolean;           // 预置模板（true 时普通用户不可删，仅 admin 可改）
}

// —— 可插入 Dashboard（通用层演进，2026-07-23 官网接入 spec §3）——
export interface WidgetDescriptor {
  id: string;                       // 'yinling.funnel'
  title: string;                    // 结论式标题
  template: string;                 // 'stat' | 'funnel' | 'line' | 'donut' | 'bars'（可扩展）
  dataUrl: string;                  // 前端同源 fetch
  map?: Record<string, any>;        // 数据字段 → 模板字段映射
  size: 'sm' | 'md' | 'lg';
  order: number;
}

// —— 事件写总线（P1，2026-08-06）——
// 所有写操作的统一真相：append-only；status 承载确认卡状态机；hash-chain 防篡改。
export interface ExecutionEvent {
  id: string;
  capability: string;                    // domain.action
  entity_type: string;                   // invoice / ledger / order ...
  entity_id: string;
  payload: Record<string, unknown>;      // JSON 快照，schema_version 版本化
  schema_version: number;
  status: 'proposed' | 'confirmed' | 'rejected' | 'failed';  // 确认卡状态机（R2：failed=执行失败，提案不消耗可重试）
  initiator: 'user' | 'agent' | 'trigger' | string;  // 发起人（agent=AI，trigger=定时器）
  reviewer: string;                      // 确认人（confirmed 时填）
  executor: string;                      // 执行人（R2：confirmed=reviewer，rejected/failed=空=未执行）
  prev_hash: string;                     // hash-chain：上一条事件的 hash
  hash: string;                          // sha256(prev_hash + 不可变内容)
  created_at: string;
}
