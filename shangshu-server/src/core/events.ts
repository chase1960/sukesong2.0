// 追加式审计日志：不承诺从命令重放恢复业务。业务状态与成功审计由同一事务提交。
// hash-chain：每事件 sha256(prev_hash + capability + entity_type + entity_id + JSON(payload) + status + initiator + reviewer + executor + created_at)。
// SQLite 在写事务中读取链尾；旧非事务适配器仅保留单进程审计兼容。
// payload 以 JSON 字符串存 text 列（bitable 兼容），读写时序列化/反序列化。
import { createHash } from 'node:crypto';
import type { ExecutionEvent } from './types.ts';
import { DATA_DIR } from './config.ts';
import { atomic } from './storage/transaction.ts';

// —— 链尾缓存（R0 2026-08-14）——
// 问题：每次 append 都要全表拉取 events 取 prev_hash（bitable 单次 1.2~2.7s），登录的 audit 也被拖慢。
// 方案：进程内记住链尾 hash。单进程内所有 append 都走本模块（withChainLock 串行），缓存与真实链尾一致；
//       按 store 数据源分 key（local=数据目录 / bitable=app_token），新源首次 append 自动 hydrate
//       （全表读一次），否则会用旧 prev_hash 续链造成分叉。
//       注意：多进程部署时本缓存不成立（需直读 store）——与 withChainLock 的单进程假设一致。
const tailCache = new Map<string, { hash: string }>();
const storeCacheKey = (store: any): string =>
  store && typeof store.__cacheKey === 'string' ? store.__cacheKey : 'local:' + (process.env._SS_DATA_DIR || DATA_DIR);

// 演示数据重置（/api/demo/reset）替换 store 文件后调用：链尾缓存指向旧文件的尾 hash，
// 不清会让新事件拿旧尾续链造成分叉。
export function resetChainCache(): void {
  tailCache.clear();
}

let chainQueue: Promise<unknown> = Promise.resolve();
const withChainLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chainQueue.then(fn);
  chainQueue = run.catch(() => {});
  return run;
};

// created_at 单调递增（避免同毫秒并列破坏链序）
let lastTs = 0;
function nextTs(): string {
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return new Date(lastTs).toISOString();
}

export function serializePayload(p: Record<string, unknown> | undefined): string {
  return JSON.stringify(p ?? {});
}

export function parsePayload(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  try { return JSON.parse(String(s ?? '{}')); } catch { return {}; }
}

export function computeEventHash(e: Omit<ExecutionEvent, 'hash' | 'id'>): string {
  const material = [
    e.prev_hash, e.capability, e.entity_type, e.entity_id,
    serializePayload(e.payload), e.status, e.initiator,
    e.reviewer ?? '', e.executor ?? '', e.created_at,
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
}

// 取最新一条事件（按 created_at 倒序取 1 条；单进程互斥下即链尾）。
// R0：链尾有缓存直接返回（appendEventCore 只读 prev.hash）；未 hydrate 时走契约 sort+limit
//     （bitable 云端只拉 1 条，不再全表拉取）。
async function latestEvent(store: any): Promise<ExecutionEvent | null> {
  const k = storeCacheKey(store);
  const tail = store.guarantees?.transactions ? undefined : tailCache.get(k);
  if (tail) return { hash: tail.hash } as ExecutionEvent;
  const rows = await store.query('execution', 'events', undefined, { sort: { key: 'created_at', dir: 'desc' }, limit: 1 });
  if (!rows.length) return null;
  tailCache.set(k, { hash: rows[0].hash });
  return rows[0] as ExecutionEvent;
}

export type AppendEventOpts = {
  capability: string; entity_type: string; entity_id: string;
  payload: Record<string, unknown>; initiator: string;
  status?: 'proposed' | 'confirmed' | 'rejected' | 'failed'; reviewer?: string;
  executor?: string;   // R2：覆盖执行人（confirmed=reviewer，rejected/failed='' 未执行）
};

export async function appendEvent(store: any, opts: AppendEventOpts): Promise<string> {
  return store.guarantees?.transactions
    ? atomic(store, tx => appendEventCore(tx, opts))
    : withChainLock(() => appendEventCore(store, opts));
}

// 无锁版核心（调用方必须已持有链锁；resolveEvent 复用，避免重入死锁）
async function appendEventCore(store: any, opts: AppendEventOpts): Promise<string> {
  const prev = await latestEvent(store);
  if (prev?.created_at) lastTs = Math.max(lastTs, Date.parse(prev.created_at));
  const base: Omit<ExecutionEvent, 'hash' | 'id'> = {
    capability: opts.capability,
    entity_type: opts.entity_type,
    entity_id: opts.entity_id,
    payload: opts.payload,
    schema_version: 1,
    status: opts.status ?? 'proposed',
    initiator: opts.initiator,
    reviewer: opts.reviewer ?? '',
    executor: opts.executor ?? opts.initiator,   // R2：默认仍=initiator，决策事件显式传 reviewer/''
    prev_hash: prev?.hash ?? '',
    created_at: nextTs(),
  };
  const hash = computeEventHash(base);
  const record: Record<string, unknown> = { ...base, hash, payload: serializePayload(base.payload) };
  const id = await store.insert('execution', 'events', record);
  tailCache.set(storeCacheKey(store), { hash });   // R0：append 后链尾即本事件
  return id;
}

// 确认/拒绝/失败：不改原事件，append 一条带 _decision/_reviewer 的新事件（链永不重写）。
// R2 语义修正：
//   - 防重复：append 前查是否已有 _resolves 指向本提案的决策事件——双击/并发/重启后重复确认都被拒绝；
//   - executor：confirmed=reviewer（人确认即执行人）；rejected/failed=''（未执行）；
//   - consume=false（执行失败）：不写 _resolves、改记 _failed——原提案保持待确认，可重试。
export async function resolveEvent(
  store: any, eventId: string, decision: 'confirmed' | 'rejected' | 'failed', reviewer: string,
  extraPayload: Record<string, unknown> = {}, consume = true,
): Promise<ExecutionEvent> {
  const run = async () => {
    const rows = await store.query('execution', 'events', { id: eventId });
    if (!rows.length) throw new Error(`事件不存在: ${eventId}`);
    const evt = rows[0] as ExecutionEvent;
    if (evt.status !== 'proposed') throw new Error(`事件非 proposed，不可重复确认: ${evt.id}`);
    // 防重复确认：已有任何事件以 _resolves 指向本提案 → 已处理过（覆盖重启后进程内状态丢失的场景）
    const all = await store.query('execution', 'events');
    const done = all.some((r: any) => {
      const p = parsePayload(r.payload);
      return typeof p._resolves === 'string' && p._resolves === eventId;
    });
    if (done) throw new Error(`该提案已处理，不可重复操作: ${eventId}`);
    const newId = await appendEventCore(store, {
      capability: evt.capability,
      entity_type: evt.entity_type,
      entity_id: evt.entity_id,
      payload: {
        ...parsePayload(evt.payload),
        _decision: decision, _reviewer: reviewer,
        ...(consume ? { _resolves: evt.id } : { _failed: true }),   // 失败不消耗提案
        ...extraPayload,
      },
      initiator: evt.initiator,
      status: decision,
      reviewer,
      executor: decision === 'confirmed' ? reviewer : '',   // R2：未执行的事件 executor 置空
    });
    const after = await store.query('execution', 'events', { id: newId });
    const rec = after[0] as any;
    return { ...rec, payload: parsePayload(rec.payload) } as ExecutionEvent;
  };
  return store.guarantees?.transactions ? atomic(store, run) : withChainLock(run);
}

// 沿 prev_hash 链遍历校验：每条的 prev_hash 对上一条的 hash、本事件 hash 与内容匹配。
// R0：rows 可传已拉取的事件行（dashboard 复用同一次查询，不再重复全表拉取）；缺省时自行查询。
export async function verifyChain(store: any, rows?: any[]): Promise<Array<{ id: string; error: string }>> {
  const all: any[] = rows ?? (await store.query('execution', 'events'));
  const byId = new Map(all.map((r: any) => [r.id, r]));
  const breaks: Array<{ id: string; error: string }> = [];
  const visited = new Set<string>();
  const heads = all.filter((r: any) => !r.prev_hash);
  const walk = (head: any) => {
    let cur = head;
    let prevHash = '';
    while (cur) {
      if (visited.has(cur.id)) { breaks.push({ id: cur.id, error: '链分叉/成环（重复访问）' }); break; }
      visited.add(cur.id);
      if (cur.prev_hash !== prevHash) {
        breaks.push({ id: cur.id, error: `prev_hash 与上一条不符（期望 ${prevHash.slice(0, 8)}…）` });
      }
      const { hash, id, payload, ...rest } = cur;
      const computed = computeEventHash({ ...rest, payload: parsePayload(payload), reviewer: rest.reviewer ?? '', executor: rest.executor ?? '' });
      if (computed !== hash) breaks.push({ id, error: 'hash 与内容不匹配（疑似篡改）' });
      prevHash = hash;
      cur = byId.get(id) && all.find((r: any) => r.prev_hash === hash) || null;
    }
  };
  heads.forEach(walk);
  for (const r of all) if (!visited.has(r.id)) breaks.push({ id: r.id, error: '孤儿事件（不在任何链上）' });
  return breaks;
}

export async function listEventsByEntity(store: any, entityType: string, entityId: string): Promise<ExecutionEvent[]> {
  const rows = await store.query('execution', 'events');
  return rows
    .filter((r: any) => r.entity_type === entityType && r.entity_id === entityId)
    .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((r: any) => ({ ...r, payload: parsePayload(r.payload) }));
}
