/**
 * 对话上下文（**内核能力**）：「用户此刻正在看什么」的那**一份权威份**。
 *
 * 为什么是内核能力（2026-10-21 用户口径）：
 * 「agent 时刻知道我在读哪一页、看的是什么内容」是**平台级事实** ——
 * 所有行业线共用同一个助手、同一个会话，不该由某个域私造一套。
 * 所以这里的机制**域无关**：通用键（module / entity_type / entity_id / label /
 * selection / content…），域只负责**把自己的内容填进来**。
 *
 * 三件事在这里定：
 * ① **收**：白名单之外一律不收（域无关的通用键，见 `normalizeContextContent`）。
 * ② **限**：内容段有硬上限，超长截断并标 `truncated`。
 * ③ **核**：内容段进提示词之前，按**当前身份**把出处重读一遍 ——
 *    读不到 / 读到的值里没有它 ⇒ **丢弃内容**并说明原因。
 *
 * ⚠️ 边界一条不许松：
 * 上下文与内容**只是线索**，业务事实必须用工具重查（那句告诫在 `core/chat.ts` 的系统提示词里）。
 */

/** 内容段正文硬上限（字符）。 */
export const MAX_CONTEXT_CONTENT_CHARS = 2000;
/** 内容段可核对条目（items）条数上限。 */
export const MAX_CONTEXT_CONTENT_ITEMS = 100;
/** 单个可核对条目的长度上限（字符）。 */
export const MAX_CONTEXT_ITEM_CHARS = 200;
/** 内容出处（refs）条数上限。 */
export const MAX_CONTEXT_CONTENT_REFS = 8;
/** 单个出处的参数（payload）序列化长度上限（字符）—— 超了整个出处作废。 */
export const MAX_CONTEXT_REF_PAYLOAD_CHARS = 600;
/** 权威份在内存里留多久（毫秒）。会话不活跃就自然过期，不留垃圾。 */
export const CONTEXT_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * 内容出处（**通用键**，不按模块命名）。
 *
 * `via` 决定服务端**按哪条授权读口**重读它：
 * · `record`（默认）：按对象类型 + 记录编号读一条记录；
 * · `service`：调一个只读服务（如表格范围读取）；
 * · `action`：执行一个只读动作。
 *
 * 域**只填内容与出处**，不填任何权限判断 —— 读权一律由服务端这条读口自己判。
 */
export interface ChatUiContentRef {
  via?: 'record' | 'service' | 'action';
  entity_type?: string;
  entity_id?: string;
  service_id?: string;
  action_id?: string;
  payload?: Record<string, unknown>;
}

/** 内容段（通用）。`text` 是用户屏幕上已经看得到的那部分。 */
export interface ChatUiContent {
  /** 内容类型（通用说法，如 `text` / `cells`），域自己定义含义。 */
  kind: string;
  /** 正文（截断后）。 */
  text: string;
  /** 正文是否被截断过。 */
  truncated: boolean;
  /** 可核对条目：逐条要在授权读回的内容里找得到。 */
  items: string[];
  /** 出处：服务端按当前身份重读这些地方，核对上面的条目。 */
  refs: ChatUiContentRef[];
}

/** 界面上下文（通用键，与产品壳其余页面一致）。 */
export interface ChatUiContext {
  record_name?: string;
  module?: string;
  entity_type?: string;
  entity_id?: string;
  label?: string;
  view?: string;
  /** 表格页：当前工作表名。 */
  sheet?: string;
  /** 表格页：当前选区（'B2' / 'B2:D5'）。 */
  selection?: string;
  metadata_kind?: string;
  metadata_key?: string;
  metadata_revision?: number;
  selected_node_id?: string;
  editable_scope?: string;
  /** 当前查看的内容（**可选**；没有就只带指代线索）。 */
  content?: ChatUiContent;
  /** 这一份上下文是**什么时候**产生的（前端打的时间戳）—— 用来判「谁更新」。 */
  updated_at?: number;
}

/** 一段文本截断到上限，并标出截没截。 */
export function clipContextText(text: string): { text: string; truncated: boolean } {
  const value = String(text ?? '');
  if (value.length <= MAX_CONTEXT_CONTENT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_CONTEXT_CONTENT_CHARS), truncated: true };
}

function normalizeRef(raw: unknown): ChatUiContentRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const via = r.via === 'service' || r.via === 'action' ? r.via : 'record';
  const ref: ChatUiContentRef = { via };
  if (r.entity_type != null) ref.entity_type = String(r.entity_type).slice(0, 80);
  if (r.entity_id != null) ref.entity_id = String(r.entity_id).slice(0, 140);
  if (r.service_id != null) ref.service_id = String(r.service_id).slice(0, 140);
  if (r.action_id != null) ref.action_id = String(r.action_id).slice(0, 140);
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    // 参数太长 ⇒ 这个出处不可信，整个作废（不硬塞一个半截参数去读）。
    if (JSON.stringify(r.payload).length <= MAX_CONTEXT_REF_PAYLOAD_CHARS) ref.payload = r.payload as Record<string, unknown>;
  }
  if (!ref.entity_type && !ref.entity_id && !ref.service_id && !ref.action_id) return null;
  return ref;
}

/**
 * 白名单化一段内容（**域无关**）。
 *
 * 白名单外的键**不收**（不是透传，是丢掉）—— 与界面上下文那套一致。
 * 正文超长 ⇒ 截断并标 `truncated`；模型据此知道「这只是屏幕上那一部分」。
 */
export function normalizeContextContent(raw: unknown): ChatUiContent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const kind = String(r.kind || '').trim().slice(0, 40);
  if (!kind) return undefined;
  const clipped = clipContextText(typeof r.text === 'string' ? r.text : String(r.text ?? ''));
  const items = (Array.isArray(r.items) ? r.items : [])
    .map(value => String(value ?? '').slice(0, MAX_CONTEXT_ITEM_CHARS).trim())
    .filter(value => value.length > 0)
    .slice(0, MAX_CONTEXT_CONTENT_ITEMS);
  const refs = (Array.isArray(r.refs) ? r.refs : [])
    .slice(0, MAX_CONTEXT_CONTENT_REFS)
    .map(normalizeRef)
    .filter((ref): ref is ChatUiContentRef => !!ref);
  return { kind, text: clipped.text, truncated: clipped.truncated, items, refs };
}

/** —— 权威份：每个会话一份，后到的覆盖先到的 —— */

interface StoredContext { context: ChatUiContext; updatedAt: number }
const contexts = new Map<string, StoredContext>();

/** 会话键：用户 + 会话（**同名会话不同人各有一份**，不串）。 */
export function contextKey(user: string, conversationId: string): string {
  return `${String(user || 'unknown')}\u0000${String(conversationId || '')}`;
}

/** 记下当前上下文（后到的覆盖先到的 —— 一份权威份，不会有两份打架）。 */
export function setCurrentContext(user: string, conversationId: string, context: ChatUiContext): void {
  contexts.set(contextKey(user, conversationId), { context, updatedAt: Date.now() });
}

/** 取当前上下文（没有就是没有，不编）。 */
export function getCurrentContext(user: string, conversationId: string): ChatUiContext | undefined {
  const key = contextKey(user, conversationId);
  const hit = contexts.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.updatedAt > CONTEXT_TTL_MS) { contexts.delete(key); return undefined; }
  return hit.context;
}

/** 清掉某个会话的上下文（会话结束/切换时用）。 */
export function clearCurrentContext(user: string, conversationId: string): void {
  contexts.delete(contextKey(user, conversationId));
}

/**
 * 收一份新的上下文：**后来者覆盖先来者**，但**旧的不许盖新的**。
 *
 * 判据是 `updated_at`（前端打的时间戳）：
 * · 同一页面前后两次上报 ⇒ 后一次的时间戳更大 ⇒ 覆盖 ✓；
 * · 一份**在途**的旧上报晚到 ⇒ 时间戳更小 ⇒ **不覆盖**（否则会把用户刚切过去的那份盖回旧的）。
 *
 * 返回 true = 这一份被收下了。
 */
export function acceptCurrentContext(user: string, conversationId: string, context: ChatUiContext): boolean {
  const stored = getCurrentContext(user, conversationId);
  if (stored && Number(stored.updated_at ?? 0) > Number(context.updated_at ?? 0)) return false;
  setCurrentContext(user, conversationId, context);
  return true;
}

/** —— 核对：内容进提示词之前，按当前身份重读出处 —— */

/** 一处出处的读回结果。`values` 是读到的所有可见字符串。 */
export interface ContextRefReadResult {
  ok: boolean;
  /** 读不到时的原因（给用户/模型看的白话）。 */
  reason?: string;
  values?: string[];
}

/** 读一处理由服务端提供（按当前身份、带权限判断的读口）。 */
export type ContextRefReader = (ref: ChatUiContentRef) => Promise<ContextRefReadResult>;

/** 去掉 HTML 标签与常见实体、压掉空白 —— 让「屏幕上的文字」与「库里读到的文字」能对上。 */
export function normalizeReadableText(text: string): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 核对用的**紧凑写法**：把空白全部去掉。
 *
 * 为什么：库里存的是 HTML（`<p>王老师：</p><p>本期…</p>`），屏幕上看到的是纯文本
 * （`王老师：\n\n本期…`）—— 去掉空白后两边才是同一串字。
 * ⚠️ 这一步只用于**核对**（判断「这一段确实在当前身份读得到的内容里」），
 *   提示词里给模型看的仍是原文。
 */
function compactForCompare(text: string): string {
  return normalizeReadableText(text).replace(/\s+/g, '');
}

/** 把一个对象里的所有字符串值收集出来（读口回什么就核什么）。 */
export function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); return out; }
  if (typeof value === 'number' || typeof value === 'boolean') { out.push(String(value)); return out; }
  if (Array.isArray(value)) { for (const item of value) collectStringValues(item, out); return out; }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, out);
  }
  return out;
}

/** 核对结果。`dropped` 有值 = 内容被丢弃了（**正文没进提示词**）。 */
export interface ContextContentCheck {
  context: ChatUiContext;
  dropped?: { reason: string };
}

function withoutContent(context: ChatUiContext): ChatUiContext {
  const { content, ...rest } = context;
  void content;
  return rest;
}

/**
 * 核对内容段。
 *
 * 规则（**不许松**）：
 * · 出处读不到（换身份、撤权、对象已删）⇒ **整段内容丢弃**，并说明原因；
 * · 读回来了，但条目在读到的内容里找不到 ⇒ 说明这一段**当前身份读不到** ⇒ 丢弃；
 * · 全对得上 ⇒ 内容保留。
 */
export async function checkContextContent(
  context: ChatUiContext,
  reader: ContextRefReader,
): Promise<ContextContentCheck> {
  const content = context.content;
  if (!content) return { context };
  if (!content.refs.length) {
    return { context: withoutContent(context), dropped: { reason: '这段内容没有可核对的出处，已丢弃（不能确认当前身份还能读到它）。' } };
  }
  const values: string[] = [];
  for (const ref of content.refs) {
    let result: ContextRefReadResult;
    try { result = await reader(ref); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { context: withoutContent(context), dropped: { reason: `按当前身份重读这段内容的出处时失败（${reason}），已丢弃内容。` } };
    }
    if (!result?.ok) {
      return { context: withoutContent(context), dropped: { reason: `按当前身份重读这段内容的出处失败：${result?.reason || '当前身份已无权读取'}，已丢弃内容。` } };
    }
    values.push(...(result.values || []));
  }
  const readable = compactForCompare(values.join('\n'));
  for (const item of content.items) {
    const needle = compactForCompare(item);
    if (!needle) continue;
    if (!readable.includes(needle)) {
      return {
        context: withoutContent(context),
        dropped: { reason: `这段内容里有当前身份读不到的部分（${item.slice(0, 40)}），已丢弃内容。` },
      };
    }
  }
  return { context };
}

/**
 * 提示词里的「当前查看的内容」段。
 *
 * ⚠️ 这段**只是线索**：它可能是旧版本、也可能已被改过；
 * 业务事实必须用工具重查 —— 那句告诫在系统提示词里，**不许因为有了内容就删掉**。
 */
export function contextContentPrompt(context: ChatUiContext): string {
  const content = context.content;
  if (!content || !content.text.trim()) return '';
  return `\n当前查看的内容（用户屏幕上正在看的那一部分${content.truncated ? '，已截断' : ''}）：\n${content.text}\n`
    + '这段内容只是**线索**：它可能是旧版本、也可能已被改过；涉及业务事实时必须用工具重查，不要把它当成权威数据直接引用或写入。';
}
