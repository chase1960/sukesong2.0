// LLM 客户端（P4）：OpenAI 兼容 chat completions（宿主 Ollama / DashScope 通用）。
// 只做协议搬运：流式解析增量文本 + tool_calls；不感知业务。
// SSRF 防护：base_url 允许本地/内网（宿主 Ollama 172.30.0.1），禁云元数据（169.254.*）。
import type { RuntimeConfig } from '../types.ts';

export interface LlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * 消息内容的一段（OpenAI 兼容的 `content` 数组）。
 *
 * **为什么要有图片段**（PKG-024-T01，2026-10-22 用户报「助手不能看图」）：
 * 「把图片内容交给模型」在 OpenAI 兼容协议里就是**用户消息的内容数组**里多一个
 * `image_url` 段 —— 纯文本协议里根本没有位置放像素。
 * ⇒ `content` 允许是数组：纯文字消息**照旧用字符串**（不空造数组，
 *   免得有些服务对数组消息挑刺），只有**真的要带图**时才用数组。
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  reasoning_content?: string | null;   // deepseek thinking 模式：assistant 消息后续轮次必须回传
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentPart[];
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmToolDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface LlmResult {
  text: string;                        // 累积文本（无 tool_calls 时即最终回答）
  tool_calls: LlmToolCall[];           // 完整拼装后的工具调用
  finish_reason: string | null;
  reasoning: string;                   // deepseek thinking 模式的 reasoning_content（多轮回传用）
}

// 2026-08-28 收紧：前缀匹配可被 [::ffff:169.254.x]/十进制IP 绕过，改用规范化主机名判断。
// llm 允许本地/内网（宿主 Ollama 172.30.0.1），禁云元数据（169.254.*）与保留段（100.64/10）。
function v4FromHost(h: string): number[] | null {
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^\d{1,3}$/.test(p)) v = Number(p);
    else return null;
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    bytes.push(v);
  }
  return bytes;
}
export function assertLlmUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('URL 格式非法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`协议非法：${u.protocol}`);
  let h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.startsWith('::ffff:')) h = h.slice(7);
  const v4 = v4FromHost(h);
  if (v4 && v4[0] === 169 && v4[1] === 254) throw new Error('禁止访问云元数据地址（169.254.*）');
  if (v4 && v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) throw new Error('禁止访问保留地址段');
}

// 一次流式对话：onDelta 回调收到文本增量与 tool_calls 增量（调用方转 SSE / 拼装）。
// signal：外部中止信号（客户端断开/用户点停止）——与 120s 超时合并监听，中止即断 LLM 拉取。
export async function chatCompletionsStream(
  cfg: RuntimeConfig['llm'],
  messages: LlmMessage[],
  tools: LlmToolSpec[],
  onDelta: (text: string, toolDeltas: LlmToolDelta[]) => void,
  signal?: AbortSignal,
): Promise<LlmResult> {
  assertLlmUrl(cfg.base_url);
  const url = cfg.base_url.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;

  const res = await fetch(url, {
    method: 'POST',
    redirect: 'error',   // SSRF：禁止跟随重定向（302 跳内网/元数据不做二次校验）
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      temperature: 0.2,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败（${res.status}）：${detail.slice(0, 200)}`);
  }

  // OpenAI SSE 流解析：data: {...} 行；[DONE] 结束。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';   // deepseek thinking 模式：多轮请求必须回传 assistant 的 reasoning_content，否则 400
  const toolAcc: LlmToolCall[] = [];
  const indexMap = new Map<number, number>();   // 流式 index → toolAcc 下标
  let finishReason: string | null = null;

  const flushToolDeltas = (deltas: LlmToolDelta[]): void => {
    for (const d of deltas) {
      let i = indexMap.get(d.index);
      if (i === undefined) {
        i = toolAcc.length;
        indexMap.set(d.index, i);
        toolAcc.push({ id: d.id ?? '', type: 'function', function: { name: '', arguments: '' } });
      }
      const tc = toolAcc[i];
      if (d.id) tc.id = d.id;
      if (d.name) tc.function.name += d.name;
      if (d.arguments) tc.function.arguments += d.arguments;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      // 思考过程字段两种命名都收：deepseek 用 reasoning_content，vLLM/Qwen3 用 reasoning
      const reasoningDelta = typeof delta.reasoning_content === 'string' && delta.reasoning_content
        ? delta.reasoning_content
        : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (reasoningDelta) reasoning += reasoningDelta;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta(delta.content, []);
      }
      if (Array.isArray(delta.tool_calls)) {
        const deltas: LlmToolDelta[] = delta.tool_calls.map((tc: any) => ({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        }));
        flushToolDeltas(deltas);
        onDelta('', deltas);
      }
    }
  }

  return { text, tool_calls: toolAcc, finish_reason: finishReason, reasoning };
}
