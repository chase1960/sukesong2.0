// PKG-018-T03：**按需发现**授权动作（FastMCP Tool Search 的思想，不引入 FastMCP 服务）。
//
// 为什么（真问题）：工具一多，**全目录塞进常驻描述**就把模型上下文吃掉了；
// 而且目录一变，模型手里的旧编号就过期。⇒ 改成：常驻只留**少量导航能力**，
// 模型按「要做什么」搜出**少量候选**（默认 5，最多 10），再用**真实 action_id ＋ 原 schema**调用。
//
// 三条纪律：
// · **索引是派生物** —— 索引从**已注册的定义**派生，不建第二份权威目录；
// · **搜索不授权** —— 搜索只回「当前身份已被授权」的动作；调用时原执行器**再校验一次**；
// · **不许猜** —— 同名/多义目标返回候选让人选；零命中就说零命中，**不静默回退「全塞给模型」**。
import { createHash } from 'node:crypto';

export interface ActionCandidate {
  action_id: string;
  version: string;
  title: string;
  purpose: string;
  effect: 'read' | 'write';
  description: string;
  input_schema: unknown;
  required: string[];
}

export interface ActionIndexEntry extends ActionCandidate {
  aliases: string[];
  /** 归一化后的检索文本（标题＋用途＋说明＋别名＋编号）。 */
  haystack: string;
  /** 业务别名（**明确维护**：BM25 不会理解同义词）。 */
  alias_hits: string[];
}

/** 业务别名表（**人工维护**：同义词不是检索算法能猜出来的）。
 *  键＝查询里可能出现的说法，值＝动作编号的片段（与动作编号或别名匹配）。 */
export const ACTION_ALIASES: Record<string, string[]> = {
  查记录: ['query', 'read', 'records'],
  查数据: ['query', 'read', 'records'],
  查询记录: ['query', 'read', 'records'],
  读记录: ['query', 'read', 'records'],
  统计: ['aggregate', 'count', 'sum'],
  汇总: ['aggregate', 'count', 'sum'],
  计数: ['aggregate', 'count'],
  求和: ['aggregate', 'sum'],
  分组: ['aggregate', 'group'],
  写记录: ['update', 'write', 'create'],
  改记录: ['update', 'write'],
  新建: ['create'],
  邮件: ['mail'],
  草稿: ['draft', 'mail'],
  发信: ['send', 'mail'],
  附件: ['attachment', 'file'],
  文件: ['file'],
  表格: ['sheet', 'files', 'excel'],
  excel: ['sheet', 'files', 'excel'],
  单元格: ['sheet', 'cells'],
  案件: ['case', 'ip.'],
  通知: ['notice', 'ip.'],
  官文: ['notice', 'ip.'],
  身份: ['identity'],
  账号: ['identity', 'user'],
  部门: ['org', 'department'],
  组织: ['org'],
};

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.title ?? record.purpose ?? record.description ?? '');
  }
  return String(value);
}

function effectOf(action: Record<string, unknown>): 'read' | 'write' {
  const effect = String(action.effect ?? '');
  const confirmation = String(action.confirmation ?? action.confirmation_policy ?? '');
  if (confirmation === 'required') return 'write';
  return ['read', 'external/read', 'extract'].includes(effect) ? 'read' : 'write';
}

function requiredOf(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const required = (schema as Record<string, unknown>).required;
  return Array.isArray(required) ? required.map(item => String(item)) : [];
}

/** 中文按**相邻二字组**切（可解释、无词典），英文/数字按词切。 */
export function tokenize(text: string): string[] {
  const cleaned = String(text ?? '').toLowerCase();
  const tokens: string[] = [];
  for (const match of cleaned.match(/[a-z0-9_.]+/g) ?? []) tokens.push(match);
  const chinese = cleaned.replace(/[a-z0-9_.\s]+/g, '');
  for (let index = 0; index + 1 < chinese.length; index += 1) tokens.push(chinese.slice(index, index + 2));
  if (chinese.length === 1) tokens.push(chinese);
  return tokens;
}

/** 索引：**从已注册的定义派生**（不建第二份权威目录）。 */
export function buildActionIndex(actions: Record<string, unknown>[]): ActionIndexEntry[] {
  const entries: ActionIndexEntry[] = [];
  for (const action of actions ?? []) {
    if (!action || action.executable === false) continue;
    const actionId = String(action.id ?? '');
    if (!actionId) continue;
    const title = textOf(action.title);
    const purpose = textOf(action.purpose);
    const description = textOf(action.description);
    const aliasHits: string[] = [];
    for (const [alias, needles] of Object.entries(ACTION_ALIASES)) {
      if (needles.some(needle => actionId.includes(needle) || title.includes(needle))) aliasHits.push(alias);
    }
    const haystack = [actionId, title, purpose, description, aliasHits.join(' ')].join(' ').toLowerCase();
    entries.push({
      action_id: actionId,
      version: String(action.version ?? action.action_version ?? '1.0.0'),
      title,
      purpose,
      effect: effectOf(action),
      description,
      input_schema: action.input_schema ?? { type: 'object', properties: {} },
      required: requiredOf(action.input_schema),
      aliases: aliasHits,
      haystack,
      alias_hits: aliasHits,
    });
  }
  return entries;
}

export interface SearchOptions {
  limit?: number;
  maxLimit?: number;
}

export interface SearchResult {
  query: string;
  candidates: ActionCandidate[];
  /** 明确告诉调用方「没命中」——不是空数组让人猜。 */
  zero_hit: boolean;
  /** 有限的修正建议（不是把全目录倒出来）。 */
  suggestions: string[];
  truncated: boolean;
}

/** 搜动作：精确编号优先，其次标题/用途/别名命中，最后按词重合排序（可解释）。 */
export function searchActions(index: ActionIndexEntry[], query: string, options: SearchOptions = {}): SearchResult {
  const limit = Math.max(1, Math.min(options.maxLimit ?? MAX_SEARCH_LIMIT, options.limit ?? DEFAULT_SEARCH_LIMIT));
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) {
    return { query: String(query ?? ''), candidates: [], zero_hit: true,
             suggestions: ['请说明要做什么（例如：查记录、统计数量、改一条记录）'], truncated: false };
  }
  const scored: Array<{ entry: ActionIndexEntry; score: number }> = [];
  for (const entry of index) {
    let score = 0;
    if (entry.action_id.toLowerCase() === normalized) score = 1000;               // 精确编号
    else if (entry.action_id.toLowerCase().includes(normalized)) score = 400;    // 编号片段
    else if (entry.title.toLowerCase().includes(normalized)) score = 300;       // 标题全含
    else if (entry.purpose.toLowerCase().includes(normalized)) score = 250;     // 用途全含
    else if (entry.alias_hits.some(alias => alias.includes(normalized) || normalized.includes(alias))) score = 200;
    else {
      const tokens = tokenize(normalized);
      let hits = 0;
      for (const token of tokens) if (entry.haystack.includes(token)) hits += 1;
      if (tokens.length) score = (hits / tokens.length) * 100;                   // 词重合（可解释）
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((left, right) => (right.score - left.score) || left.entry.action_id.localeCompare(right.entry.action_id));
  const chosen = scored.slice(0, limit);
  const candidates: ActionCandidate[] = chosen.map(item => ({
    action_id: item.entry.action_id,
    version: item.entry.version,
    title: item.entry.title,
    purpose: item.entry.purpose,
    effect: item.entry.effect,
    description: item.entry.description,
    input_schema: item.entry.input_schema,
    required: item.entry.required,
  }));
  return {
    query: String(query ?? ''),
    candidates,
    zero_hit: candidates.length === 0,
    suggestions: candidates.length === 0
      ? ['换个说法再搜（例如：查记录／统计数量／改一条记录）', '也可以先看目录里有哪些分类', '动作编号可以直接整串搜']
      : [],
    truncated: scored.length > candidates.length,
  };
}

/** 一次聊天桥的派生目录；不跨请求或身份缓存，执行仍由公共 Action 复核当前权限。 */
export function createActionDiscovery(actions: Record<string, unknown>[]) {
  const index = buildActionIndex(actions);
  return {
    search: (query: string, options: SearchOptions = {}) => searchActions(index, query, options),
    catalog(page = 1, pageLength = MAX_SEARCH_LIMIT) {
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageLength)
          || pageLength < 1 || pageLength > MAX_SEARCH_LIMIT) throw Error('动作目录分页参数无效：page须为正整数，page_length为1至10');
      const start = (page - 1) * pageLength;
      return {
        actions: index.slice(start, start + pageLength).map(entry => ({
          id: entry.action_id, title: entry.title.slice(0, 120), version: entry.version,
          kind: entry.effect === 'read' ? 'query' : 'confirm',
        })),
        total: index.length, page, page_length: pageLength,
        has_more: start + pageLength < index.length,
        suggestion: '按要做什么调用platform_action_search；已知编号用platform_action_schema读取完整schema。目录可用page/page_length继续翻页。',
      };
    },
  };
}

/** 目录指纹：动作定义变了 ⇒ 索引过期（缓存要失效）。 */
export function directoryFingerprint(actions: Record<string, unknown>[]): string {
  const parts = (actions ?? [])
    .filter(action => action && action.executable !== false)
    .map(action => `${String(action.id)}@${String(action.version ?? action.action_version ?? '')}`)
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** 按**已知编号**从**当前已授权目录**里取动作；取不到就**明确拒**（不许猜、不许回退）。
 *
 *  为什么单独抽出来：搜索**不授权** —— 模型可能拿着**撤权前**的旧编号来调。
 *  这里按**当前聊天桥**的已授权目录解析，公共执行器仍按调用时权限重新判定；索引不授予执行权。
 *  桥接层（platform.ts）与测试共用**同一份**判定，不各写一套。
 */
export function resolveAuthorizedAction<T>(catalog: Map<string, T>, actionId: unknown): T {
  const selected = typeof actionId === 'string' ? catalog.get(actionId) : undefined;
  if (!selected) {
    throw new Error('动作不在当前授权工具目录内；先用platform_action_search搜索，或以空参数对象{}调用platform_action_schema并省略action_id取得真实编号（不要传action_id:"{}"或空字符串），不能猜对象路径');
  }
  return selected;
}

/** 常驻的**少量导航能力**（大目录时替换逐动作工具）。
 *  ⚠️ 描述里**不许**出现动作目录：全目录只按需搜（`platform_action_search`）。 */
export interface NavigationToolSpec {
  name: string;
  kind: 'query' | 'confirm';
  surface: string;
  description: string;
  parameters: unknown;
}

export function navigationToolSpecs(callDescription: string, manifest = ''): NavigationToolSpec[] {
  const parameters = { type: 'object', additionalProperties: false, properties: { action_id: { type: 'string' }, payload: { type: 'object' } } };
  return [
    { name: 'platform_action_search', kind: 'query', surface: 'sme',
      description: '按「要做什么」搜索当前授权的动作目录（中文可直接写）。返回少量候选：默认 5 条、最多 10 条，每条含真实 action_id、版本、读写属性与完整 input_schema，可直接照着调 platform_action_call。**不要猜动作编号**；零命中会明确说明并给修正建议，不会把整个目录倒给你。'
        + (manifest ? `\n可搜到的能力（压缩清单，看不到全目录）：${manifest}` : ''),
      parameters: { type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', description: '要做什么／动作名／用途／编号（中文即可）' },
                      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT } } } },
    { name: 'platform_action_schema', kind: 'query', surface: 'sme',
      description: '按**已知 action_id** 读该动作的完整原 input_schema。**不知道编号时先用 platform_action_search 搜**；省略action_id仅返回最多10条目录摘要，可用page/page_length翻页；带action_id时不带分页参数。不要猜编号，也不要把字符串"{}"或空字符串当编号。',
      parameters: { type: 'object', additionalProperties: false, properties: { action_id: { type: 'string' },
        page: { type: 'integer', minimum: 1 }, page_length: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT } } } },
    { name: 'platform_action_call', kind: 'confirm', surface: 'sme', description: callDescription,
      parameters: { ...parameters, required: ['action_id', 'payload'] } },
  ];
}
