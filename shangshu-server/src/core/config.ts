// 运行时配置：runtime_config.json 读写 + 默认值 + 密钥脱敏。
// 适配器在运行时读这份配置选 impl（local/bitable、folder/agently、local/drive、mock/real ocr）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import {randomUUID} from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录：server/data（跨平台）。Windows 下同样落在安装目录的 data\ 下。
// 测试可通过 _SS_DATA_DIR 覆盖，避免污染默认数据目录。
export const DATA_DIR = process.env._SS_DATA_DIR || join(__dirname, '..', '..', 'data');
export const CONFIG_PATH = join(DATA_DIR, 'runtime_config.json');

function configPath(): string {
  return join(process.env._SS_DATA_DIR || DATA_DIR, 'runtime_config.json');
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  enterprise:{name:''},
  server: { port: Number(process.env.PORT) || 3000, admin_password: 'admin' },
  // 默认每 10 分钟（生产合理值，且是前端大白话预设之一，不落「自定义」）。
  poll: { cron: '*/10 * * * *', mailbox: '' },
  store: { provider: 'local' },
  mail: { provider: 'folder', folder: join(DATA_DIR, 'inbox'), agently_mailbox: '', delete_after_read: false, collect_keywords: ['发票'] },
  file: { provider: 'local', local_dir: join(DATA_DIR, 'files'), drive_folder_token: '' },
  feishu: { app_id: '', app_secret: '', bitable_app_token: '', invoices_table_id: 'business__invoices', ledger_table_id: '' },
  ocr: {
    endpoint_url: 'http://127.0.0.1:8001',
    provider: 'mock',
    api_key: '',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-plus',
    // R3：高置信自动入账阈值（0=关闭自动入账；>=阈值 且 字段完整无警告 → 直通入账，否则待审人工）
    confidence_auto_book: 0.9,
  },
  // AI 对话（P4）：密钥由 SHANGSHU_LLM_API_KEY 或本地运行配置提供，不进入源码；
  // 无外网时演示域自动落到预录结果（recruitment 演示能力的兜底路径）。
  llm: {
    provider: 'openai',
    base_url: 'https://api.openai-next.com/v1',
    api_key: '',
    model: 'gpt-6-sol',
  },
  // 模型来源列表：页面里切换即整条套用；密钥只从运行配置/环境读取。
  llm_sources: [
    {
      id: 'gpt6sol-relay',
      name: 'GPT-6-Sol（中转）',
      desc: '黑客松演示：api.openai-next.com 中转；密钥通过 SHANGSHU_LLM_API_KEY 配置',
      provider: 'openai',
      base_url: 'https://api.openai-next.com/v1',
      model: 'gpt-6-sol',
      api_key: '',
    },
  ],
  website: { base_url: 'https://www.lingeringtek.cn', api_key: '', panel_path: 'panel-a7x9', panel_key: '' },
  // 主动提醒（A4）：应收逾期天数 / 库存预警线（0=不预警）
  alerts: { overdue_days: 30, min_stock: 0 },
  // 工作区预设模板（2026-08-10）：modules 按工作流先后顺序
  workspaces: [
    { id: 'finance', name: '财务工作区', desc: '收票 → 入账 → 收款/付款', roles: ['finance', 'admin'], modules: ['review', 'accounting', 'payables', 'expense'], preset: true },
    { id: 'cashier', name: '出纳工作区', desc: '记账 → 付款登记', roles: ['finance', 'admin'], modules: ['accounting', 'payables'], preset: true },
    { id: 'sales', name: '销售工作区', desc: '客户 → 订单 → 发货回款', roles: ['manager', 'staff', 'admin'], modules: ['customers', 'orders', 'delivery'], preset: true },
    { id: 'supply', name: '供应链工作区', desc: '采购 → 收货入库 → 库存', roles: ['manager', 'admin'], modules: ['purchase', 'inventory'], preset: true },
    { id: 'boss', name: '老板工作区', desc: '看板 → 对话 → 简报提醒', roles: ['admin'], modules: ['dash', 'chat', 'flows'], preset: true },
    { id: 'admin', name: '管理员工作区', desc: '用户 → 配置 → 定时任务 → 工作区', roles: ['admin'], modules: ['users', 'config', 'tasks', 'skill-sync', 'workspaces'], preset: true },
    { id: 'collab', name: '协作工作区', desc: '消息 → 对话 → 文档', roles: [], modules: ['im', 'chat', 'doc-gen'], preset: true },
  ],
};

export function loadConfig(): RuntimeConfig {
  const path = configPath();
  try {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
    if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('配置根节点必须是对象');
    if(raw.store?.provider && !['local','sqlite','bitable'].includes(raw.store.provider)) throw new Error('未知主存储 provider');
    // 浅合并默认值，保证新增字段不缺失
    const llm = { ...DEFAULT_CONFIG.llm, ...raw.llm };
    const llmSources = Array.isArray(raw.llm_sources) ? structuredClone(raw.llm_sources) : structuredClone(DEFAULT_CONFIG.llm_sources);
    const result: RuntimeConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      enterprise:{...DEFAULT_CONFIG.enterprise,...raw.enterprise},
      server: { ...DEFAULT_CONFIG.server, ...raw.server },
      poll: { ...DEFAULT_CONFIG.poll, ...raw.poll },
      store: { ...DEFAULT_CONFIG.store, ...raw.store },
      mail: { ...DEFAULT_CONFIG.mail, ...raw.mail },
      file: { ...DEFAULT_CONFIG.file, ...raw.file },
      feishu: { ...DEFAULT_CONFIG.feishu, ...raw.feishu },
      ocr: { ...DEFAULT_CONFIG.ocr, ...raw.ocr },
      llm,
      llm_sources: llmSources,
      website: { ...DEFAULT_CONFIG.website, ...raw.website },
      alerts: { ...DEFAULT_CONFIG.alerts, ...raw.alerts },
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : DEFAULT_CONFIG.workspaces,
    };
    const llmApiKey = process.env.SHANGSHU_LLM_API_KEY?.trim();
    const relay = DEFAULT_CONFIG.llm_sources?.[0];
    if (llmApiKey && relay) {
      if (llm.provider === relay.provider && llm.base_url === relay.base_url && llm.model === relay.model) {
        llm.api_key = llmApiKey;
      }
      for (const source of result.llm_sources || []) {
        if (source.id === relay.id) source.api_key = llmApiKey;
      }
    }
    return result;
  } catch (e) {
    throw new Error(`运行配置读取失败，拒绝回退到其他数据源: ${(e as Error).message}`);
  }
}

export function saveConfig(cfg: RuntimeConfig): void {
  const dataDir = process.env._SS_DATA_DIR || DATA_DIR;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path=configPath(),temp=path+'.tmp-'+randomUUID();
  const fd=openSync(temp,'wx',0o600);
  const persisted = structuredClone(cfg);
  const llmApiKey = process.env.SHANGSHU_LLM_API_KEY?.trim();
  const relay = DEFAULT_CONFIG.llm_sources?.[0];
  if (llmApiKey && relay) {
    if (persisted.llm.provider === relay.provider && persisted.llm.base_url === relay.base_url && persisted.llm.model === relay.model) {
      persisted.llm.api_key = '';
    }
    for (const source of persisted.llm_sources || []) {
      if (source.id === relay.id && source.api_key === llmApiKey) source.api_key = '';
    }
  }
  try {writeFileSync(fd,JSON.stringify(persisted,null,2),'utf8');fsyncSync(fd);}
  catch(error){rmSync(temp,{force:true});throw error;}
  finally {closeSync(fd);}
  try {renameSync(temp,path);}catch(error){rmSync(temp,{force:true});throw error;}
}

// 系统配置页展示用：密钥脱敏。短密钥整体打码（此前 5 字符密钥掩码后=完整明文）。
export function maskConfig(cfg: RuntimeConfig) {
  const m = (v: string) => (v ? (v.length < 12 ? '••••••••' : v.slice(0, 4) + '••••' + v.slice(-2)) : '');
  return {
    ...cfg,
    server: { ...cfg.server, admin_password: m(cfg.server.admin_password) },
    feishu: { ...cfg.feishu, app_secret: m(cfg.feishu.app_secret) },
    ocr: { ...cfg.ocr, api_key: m(cfg.ocr.api_key) },
    llm: { ...cfg.llm, api_key: m(cfg.llm.api_key) },
    llm_sources: (cfg.llm_sources || []).map(s => ({ ...s, api_key: m(s.api_key) })),
    website: { ...cfg.website, api_key: m(cfg.website.api_key), panel_key: m(cfg.website.panel_key) },
  };
}
