// 工具结果回灌闸：**工具结果进模型上下文之前**的一道有界处理（通用件，所有工具共用一处）。
//
// 为什么有这道闸（FIX-02 的真事故）：一次 Assistant 大请求 12,270,898 字节。
// 根因不是「表读不完」（`files.sheet_range_read` 一次最多 500 行，本来就能翻页），
// 而是**整页结果原样进模型上下文，没有长度上限** —— 一页 500 行 × 几十列就是几十万字符。
// 审计日志截到 800 字，所以日志上看不出来，模型那边已经吃满了。
//
// 这道闸只做一件事：**超上限 ⇒ 截断 + 明说**（共多少、这是第几页、接着读第几页、哪些被砍了）。
// 它**不改工具语义**：工具该返回什么仍返回什么，审计日志、动作记录、真正的取数路径一个字不变；
// 截断只发生在**回灌给模型之前**那一步。
//
// 阈值：按**字符数**封顶，默认 20000（可用环境变量 SHANGSHU_TOOL_RESULT_MAX_CHARS 调）。
// 为什么不按「模型上下文窗口」设：窗口大小是模型/供应商决定的常量，我们不知道，也不该硬编。
// 取 20000 的理由：① 审计日志已经按 800 字截过一次 —— 这个产品里已有「回灌量必须封顶」的既有做法；
// ② 20000 字符大约几千 token，一份工具结果占满它，后面几轮就几乎没有空间；
// ③ FIX-02 的真事故是 12 MB 级别 ⇒ 几十万字符级别的回灌必须挡住。
// 下限 1000：比这更小的上限会把正常结果也砍掉。

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20000;

/** 回灌上限（字符）。环境变量可调；调大＝更冒险。 */
export function toolResultMaxChars(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.SHANGSHU_TOOL_RESULT_MAX_CHARS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  return Math.max(1000, Math.floor(raw));
}

export interface ToolResultContext {
  /** 工具名（只用于说明，不参与判定）。 */
  toolName?: string;
  /** 本次调用的参数：对象或 JSON 字符串都行（用来认 page/page_length/row_ids）。 */
  args?: unknown;
}

export interface ToolResultBound {
  content: string;
  truncated: boolean;
}

/** 说明区预留的字符数（含被砍行 ID 列表）。 */
const NOTICE_RESERVE = 2200;
/** 说明里最多列多少个被砍掉的行 ID。 */
const MAX_ROW_IDS = 20;

const TOTAL_KEYS = ['total_rows', 'total_count', 'total_matches', 'matched', 'total_items', 'total', 'count'];
const PAGE_KEYS = ['page', 'page_index', 'page_number', 'current_page'];
const PAGE_LENGTH_KEYS = ['page_length', 'page_size', 'per_page', 'limit'];
const TOTAL_PAGES_KEYS = ['total_pages', 'total_page_count', 'page_total'];

interface Change {
  part: 'rows_tail' | 'text_tail';
  field: string;
  dropped: number;
  kept: number;
  rowIds?: string[];
}

interface Leaf {
  path: (string | number)[];
  kind: 'array' | 'string';
  size: number;
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try { const parsed = JSON.parse(args); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
  }
  if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return {};
}

function pickNumber(source: Record<string, unknown> | undefined, keys: string[]): { value: number | null; key: string | null } {
  if (!source) return { value: null, key: null };
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return { value, key };
    if (typeof value === 'string' && /^\d+$/.test(value)) return { value: Number(value), key };
  }
  return { value: null, key: null };
}

function getAt(root: any, path: (string | number)[]): any {
  let node = root;
  for (const step of path) node = node?.[step];
  return node;
}

function setAt(root: any, path: (string | number)[], value: unknown): void {
  if (!path.length) return;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

/** 找结果里最大的「可截断叶子」：数组（当成一列一列的行）或长字符串。数组不再往里钻。 */
function collectLeaves(root: unknown, path: (string | number)[], out: Leaf[], depth = 0): void {
  if (depth > 4) return;
  if (Array.isArray(root)) { out.push({ path, kind: 'array', size: JSON.stringify(root).length }); return; }
  if (root && typeof root === 'object') {
    for (const [key, value] of Object.entries(root as Record<string, unknown>)) collectLeaves(value, [...path, key], out, depth + 1);
    return;
  }
  if (typeof root === 'string') out.push({ path, kind: 'string', size: root.length });
}

/** 保留前 k 项时，序列化后不超过 budget 的最大 k。 */
function fitCount(items: unknown[], budget: number): number {
  if (budget <= 0) return 0;
  let lo = 0, hi = items.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(items.slice(0, mid)).length <= budget) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** 载荷大小（不含截断说明本身）——说明里报「保留了多少」用这个数。 */
function payloadSize(root: any): number {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return JSON.stringify(root).length;
  const clone: any = { ...root };
  delete clone._truncation;
  return JSON.stringify(clone).length;
}

function pickRowIds(items: unknown[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = record.row_id ?? record.id ?? record.rowId;
    if (id != null) ids.push(String(id));
    if (ids.length >= MAX_ROW_IDS) break;
  }
  return ids;
}

function buildNext(change: Change | null, page: number | null, pageLength: number | null, rowIds: string[]): string {
  const parts: string[] = [];
  if (change?.part === 'text_tail') {
    parts.push(`这次砍掉的是字段 ${change.field} 的尾部 ${change.dropped} 字（保留前 ${change.kept} 字）`);
    parts.push('这个字段没有分页 ⇒ 拿不到「第几页 / 总共几页」；接着读的办法：把这一次读取的范围改小（少读一封/少读一段），或改用能分段读取的口子');
  } else if (page != null) {
    parts.push(`第 ${page + 1} 页：page=${page + 1}（其它参数不变）`);
    if (pageLength != null && change) parts.push(`要把这一页剩下的 ${change.dropped} 行读完：把 page_length 改成 ${change.kept}，再依次用 page=${page + 1}、page=${page + 2}… 读（每段 ${change.kept} 行）`);
    else if (pageLength != null) parts.push('page_length 拿不到，沿用上一次的取值');
  } else if (pageLength != null) {
    parts.push(`接着读：page=2、page_length=${pageLength}（当前页按第 1 页算；总页数拿不到）`);
  } else {
    parts.push('这次调用没带 page/page_length/row_ids，结果里也没有分页信息 ⇒ 拿不到「第几页 / 总共几页」；接着读的办法：把这一次读取的范围改小（少读几行/少读一封），或改用带分页的读取口');
  }
  if (rowIds.length) parts.push(`被砍掉的行可以直接点读：row_ids=[${rowIds.join(',')}]（共 ${change?.dropped ?? rowIds.length} 个，这里只列前 ${rowIds.length} 个）`);
  return parts.join('；');
}

interface TruncationNotice {
  truncated: true;
  message: string;
  why: string;
  max_chars: number;
  original_chars: number;
  kept_chars: number;
  total_count: number | null;
  total_count_source: string | null;
  page_count: number | null;
  page: number | null;
  page_length: number | null;
  total_pages: number | null;
  dropped_count: number;
  dropped_part: string;
  field: string | null;
  dropped_row_ids: string[] | null;
  next: string;
  unknown: string[];
  counts_note: string;
}

function buildNotice(input: {
  limit: number; originalChars: number; keptChars: number;
  totalCount: number | null; totalCountSource: string | null;
  pageCount: number | null; page: number | null; pageLength: number | null; totalPages: number | null;
  change: Change | null;
}): TruncationNotice {
  const { limit, originalChars, keptChars, totalCount, totalCountSource, pageCount, page, pageLength, totalPages, change } = input;
  const droppedCount = change ? change.dropped : 0;
  const keptCount = change ? change.kept : 0;
  const rowIds = change?.rowIds ?? [];

  let droppedText = '这次没有砍掉任何条目';
  if (change?.part === 'rows_tail') droppedText = `后面还有 ${change.dropped} 行被砍掉了（保留的是前 ${change.kept} 行；没有任何一列被砍，砍的是列表尾部）`;
  else if (change?.part === 'text_tail') droppedText = `字段 ${change.field} 的尾部 ${change.dropped} 字被砍掉了（保留前 ${change.kept} 字；其它字段没被砍）`;

  const countsNote = totalCount != null && pageCount != null
    ? `total_count（取自结果的 ${totalCountSource} 字段）是工具自报的总数/匹配总数，page_count 是本页返回的条数 —— 两者不是一回事，别拿 page_count 当总数。`
    : totalCount != null
      ? `本次结果里没有分页列表 ⇒ 本页条数拿不到；total_count（取自结果的 ${totalCountSource} 字段）是工具自报的总数，也不是本页行数。`
      : pageCount != null
        ? `本次结果里没有可读的总数字段 ⇒ 匹配总数拿不到；page_count（${pageCount}）是本页返回的条数，也不是总数。`
        : '本次结果里既没有总数字段也没有分页列表 ⇒ 总数与本页条数都拿不到。';

  const unknown: string[] = [];
  if (totalCount == null) unknown.push('total_count');
  if (page == null) unknown.push('page');
  if (pageLength == null) unknown.push('page_length');
  if (totalPages == null) unknown.push('total_pages');

  const next = buildNext(change, page, pageLength, rowIds);
  const totalText = totalCount != null ? `共 ${totalCount} 条/行` : '共多少条拿不到';
  const pageText = page != null ? `这是第 ${page} 页` : '这是第几页拿不到';
  const pagesText = totalPages != null ? `总共 ${totalPages} 页` : '总共几页拿不到';
  const pageCountText = pageCount != null ? `这一页返回 ${pageCount} 条/行` : '这一页返回多少条拿不到';

  return {
    truncated: true,
    message: `结果太长（${originalChars} 字符，超过回灌上限 ${limit}），已截断后回灌：${totalText}，${pageCountText}，${pageText}，${pagesText}；${droppedText}；接着读：${next}。`,
    why: '只影响回灌给模型的这一份：工具本身的返回值、审计日志、动作记录一个字没变。',
    max_chars: limit,
    original_chars: originalChars,
    kept_chars: keptChars,
    total_count: totalCount,
    total_count_source: totalCountSource,
    page_count: pageCount,
    page,
    page_length: pageLength,
    total_pages: totalPages,
    dropped_count: droppedCount,
    dropped_part: change?.part ?? 'unknown',
    field: change?.field ?? null,
    dropped_row_ids: rowIds.length ? rowIds : null,
    next,
    unknown,
    counts_note: countsNote,
  };
}

/**
 * 工具结果回灌闸：超上限 ⇒ 截断 + 明说；没超 ⇒ 原样透传。
 * 返回的 content 就是**回灌给模型的那一份**（工具的返回值本身没被动过）。
 */
export function boundToolResult(raw: string, ctx: ToolResultContext = {}): ToolResultBound {
  const limit = toolResultMaxChars();
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (text.length <= limit) return { content: text, truncated: false };

  const args = normalizeArgs(ctx.args);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }

  // —— 纯文本结果：按字符从尾部截 ——
  if (parsed === undefined) {
    const keep = Math.max(0, limit - NOTICE_RESERVE);
    const notice = buildNotice({
      limit, originalChars: text.length, keptChars: keep,
      totalCount: null, totalCountSource: null, pageCount: null, page: null, pageLength: null, totalPages: null,
      change: { part: 'text_tail', field: '(纯文本结果)', dropped: text.length - keep, kept: keep },
    });
    return { content: `${text.slice(0, keep)}\n\n[工具结果已截断] ${String(notice.message)}`, truncated: true };
  }

  // —— JSON 结果 ——
  const rootIsArray = Array.isArray(parsed);
  const root: any = rootIsArray ? { items: parsed } : parsed;
  const resultFields: Record<string, unknown> = rootIsArray ? {} : (root && typeof root === 'object' ? root : {});

  const leaves: Leaf[] = [];
  collectLeaves(root, [], leaves);
  // —— **schema 不当普通长文本裁坏**（PKG-018-T04：工具 schema 按需读取与工具结果裁剪**分别处理**）。
  //    裁坏 schema 会让模型照着缺字段的 schema 去调用 ⇒ 比超长更糟。
  const schemaPaths = findSchemaPaths(root);
  leaves.sort((a, b) => b.size - a.size);

  const changes: Change[] = [];
  let size = JSON.stringify(root).length;
  for (const leaf of leaves) {
    if (size <= limit) break;
    const current = getAt(root, leaf.path);
    if (current == null) continue;
    if (schemaPaths.some(prefix => isUnder(prefix, leaf.path))) continue;   // schema 内的东西不裁
    const currentSize = leaf.kind === 'array' ? JSON.stringify(current).length : String(current).length;
    const budget = limit - (size - currentSize) - NOTICE_RESERVE;
    if (leaf.kind === 'array') {
      const items = current as unknown[];
      const keep = fitCount(items, budget);
      setAt(root, leaf.path, items.slice(0, keep));
      changes.push({ part: 'rows_tail', field: leaf.path.join('.') || '(顶层数组)', dropped: items.length - keep, kept: keep, rowIds: pickRowIds(items.slice(keep)) });
    } else {
      const str = String(current);
      const keep = Math.max(0, Math.min(str.length, budget));
      setAt(root, leaf.path, str.slice(0, keep));
      changes.push({ part: 'text_tail', field: leaf.path.join('.') || '(顶层字符串)', dropped: str.length - keep, kept: keep });
    }
    size = JSON.stringify(root).length;
  }

  const primary = changes[0] ?? null;
  const totalPick = pickNumber(resultFields, TOTAL_KEYS);
  const pagePick = pickNumber(resultFields, PAGE_KEYS);
  const lengthPick = pickNumber(resultFields, PAGE_LENGTH_KEYS);
  const pagesPick = pickNumber(resultFields, TOTAL_PAGES_KEYS);
  const argPage = pickNumber(args, PAGE_KEYS);
  const argLength = pickNumber(args, PAGE_LENGTH_KEYS);

  const totalCount = totalPick.value;
  const page = pagePick.value ?? argPage.value;
  const pageLength = lengthPick.value ?? argLength.value;
  const totalPages = pagesPick.value ?? (totalCount != null && pageLength ? Math.ceil(totalCount / pageLength) : null);
  const pageCount = primary?.part === 'rows_tail' ? primary.kept + primary.dropped : null;

  const notice = buildNotice({
    limit, originalChars: text.length, keptChars: Math.min(size, limit),
    totalCount, totalCountSource: totalPick.key, pageCount, page, pageLength, totalPages, change: primary,
  });

  if (root && typeof root === 'object' && !Array.isArray(root)) {
    root._truncation = notice;
    notice.kept_chars = payloadSize(root);
    let final = JSON.stringify(root);
    if (final.length > limit && Array.isArray(notice.dropped_row_ids)) {
      notice.dropped_row_ids = null;
      final = JSON.stringify(root);
    }
    // 说明本身还超限 ⇒ 再砍主列表尾部，直到装得下。
    let guard = 0;
    while (final.length > limit && primary?.part === 'rows_tail' && guard++ < 1000) {
      const items = getAt(root, primary.field.split('.')) as unknown[] | undefined;
      if (!Array.isArray(items) || items.length <= 1) break;
      setAt(root, primary.field.split('.'), items.slice(0, items.length - 1));
      primary.kept -= 1; primary.dropped += 1;
      notice.kept_chars = payloadSize(root);
      notice.dropped_count = primary.dropped;
      notice.message = buildNotice({
        limit, originalChars: text.length, keptChars: notice.kept_chars,
        totalCount, totalCountSource: totalPick.key, pageCount, page, pageLength, totalPages, change: primary,
      }).message;
      final = JSON.stringify(root);
    }
    if (final.length > limit) {
      // 装不下 ⇒ **不硬切 JSON**（切出来的 JSON 模型根本解析不了，比超长更糟）。
      // ① 先把**非受保护**的大块**整个丢掉**（不是切一半）；
      const droppable = leaves.filter(leaf => !schemaPaths.some(prefix => isUnder(prefix, leaf.path)));
      for (const leaf of droppable) {
        if (JSON.stringify(root).length <= limit) break;
        const current = getAt(root, leaf.path);
        if (current == null) continue;
        if (leaf.kind === 'array') setAt(root, leaf.path, []);
        else setAt(root, leaf.path, '');
      }
      final = JSON.stringify(root);
      if (final.length > limit) {
        // ② 只剩**受保护内容**（工具 schema）还超限 ⇒ schema **完整保留**，其余部分省略并明说。
        const kept: any = {};
        for (const [key, value] of Object.entries(root)) {
          if (schemaPaths.some(prefix => prefix[0] === key)) kept[key] = value;
        }
        kept._truncation = { ...notice, kept_chars: payloadSize(root), over_limit: true,
          message: `${String(notice.message)}（本次结果超出回灌上限：已**完整保留工具 schema**、其余部分省略）` };
        final = JSON.stringify(kept);
        if (final.length > limit * 4) {
          // ③ 连 schema 都大到离谱 ⇒ 给**合法 JSON** 的明确说明（不要坏 JSON）。
          final = JSON.stringify({ _truncation: { ...notice, over_limit: true,
            message: '工具 schema 过大，已省略；请用 platform_action_schema 按 action_id 重新读取该动作的 schema' } });
        }
      }
      return { content: final, truncated: true };
    }
    return { content: final, truncated: true };
  }

  // 顶层就是数组：装进 items，说明写在同层。
  const wrapped: any = { items: root.items, _truncation: { ...notice, root_shape: 'array', root_shape_note: '这次结果本来是一个顶层数组，现在放在 items 里。' } };
  let final = JSON.stringify(wrapped);
  if (final.length > limit) {
    const items = root.items as unknown[];
    let guard = 0;
    while (final.length > limit && items.length > 1 && guard++ < 1000) {
      items.pop();
      if (primary) { primary.kept = Math.max(0, primary.kept - 1); primary.dropped += 1; }
      wrapped._truncation = { ...wrapped._truncation, dropped_count: primary?.dropped ?? 0 };
      final = JSON.stringify(wrapped);
    }
  }
  if (final.length > limit) {
    // 同样**不硬切 JSON**（顶层数组也一样：要么装下，要么给合法 JSON 的说明）。
    final = JSON.stringify({ _truncation: { ...wrapped._truncation, over_limit: true,
      message: `${String(wrapped._truncation.message)}（结果超出回灌上限，已省略；请缩小范围或分页再取）` } });
  }
  return { content: final, truncated: true };
}

/** 给回灌消息用：只换 content，其它字段（tool_call_id 等）原样带过去。 */
export function boundToolMessage<T extends { content: string }>(message: T, ctx: ToolResultContext = {}): T {
  const bound = boundToolResult(message.content, ctx);
  return bound.truncated ? { ...message, content: bound.content } : message;
}

/** 结果里哪些路径是**工具 schema**（`input_schema` / `parameters`）⇒ 裁剪时必须完整保留。 */
function findSchemaPaths(root: unknown): string[][] {
  const paths: string[][] = [];
  const record = root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : null;
  if (!record) return paths;
  for (const key of ['input_schema', 'parameters']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) paths.push([key]);
  }
  return paths;
}

/** path 是否在 prefix 之下（含自身）。 */
function isUnder(prefix: (string | number)[], path: (string | number)[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => path[index] === segment);
}
