// Pi 只负责编排；模型传输、工具授权、写确认、存储仍由尚书提供。
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { chatCompletionsStream, type LlmMessage } from './llm.ts';
import type { RuntimeConfig } from '../types.ts';
import { classifyUnfoundedClaims, truthfulReply, type AgentHooks, type ChatToolDef, type ChatToolExecutor } from '../chat.ts';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import {claimsConfirmation, NO_CONFIRMATION_REPLY} from './confirmation-reply.ts';
import { boundToolResult } from '../tool-result-bounds.ts';

const MAX_TURNS = 10, MAX_TOOLS = 40;
const LIMIT = '本轮已达到调用上限或出现重复调用，请检查已有工具结果后重新提问。';
// Pi 消息与 OpenAI 消息都可能携带内容数组；worker/聊天路径只需要可回传的文本段。
const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && (c as any).type === 'text')
      .map(c => c.text || '').join('')
    : '';

function toLlm(message: Message): LlmMessage {
  if (message.role === 'toolResult') return { role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) };
  if (message.role === 'assistant') {
    const calls = message.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
    return { role: 'assistant', content: textOf(message.content), tool_calls: calls.length ? calls : undefined,
      reasoning_content: message.content.filter(c => c.type === 'thinking').map(c => c.thinking).join('') || ' ' };
  }
  return { role: message.role, content: textOf(message.content) };
}

export async function runPiChat(opts: {
  cfg: RuntimeConfig['llm']; messages: LlmMessage[]; tools: ChatToolDef[];
  execute: ChatToolExecutor; hooks: AgentHooks; signal?: AbortSignal;
}): Promise<{ reply: string; reasoning: string }> {
  const { cfg, hooks } = opts;
  const model: Model<'openai-completions'> = { id: cfg.model, name: cfg.model, api: 'openai-completions', provider: cfg.provider,
    baseUrl: cfg.base_url, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 };
  const fresh = (): AssistantMessage => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  let turns = 0, toolsRun = 0, confirmations = 0, reply = '', reasoning = '', limitReached = false;
  let auditResolutionError: Error | undefined;
  const repeated = new Map<string, number>();
  // —— 与 classic 同口径的**回执收集**（声明-回执对账要用）：提案来自 onConfirm，读取来自 query 类工具。
  const turnProposals: Array<{ id: string; capability: string; entity_type: string; entity_id: string }> = [];
  const turnReads: string[] = [];
  // —— 空回答自动重试一次（BASE967-28）：无副作用、第一次空 ⇒ 给模型一句「上一条回复为空」再问一轮。
  let emptyRetried = false;
  let emptyNudge = '';
  // SDK 可自动转换参数类型；业务值不能因此变化，执行前再按原 schema 严格验证原值。
  const ajv = new Ajv({ strict: false, coerceTypes: false, validateFormats: false });
  const validators = new Map(opts.tools.map(t => [t.name, ajv.compile(t.parameters)]));
  const originals = new Map<string, unknown>();
  const requestIds = new Map<string, string>();
  const guarded: AgentHooks = { ...hooks, onConfirm: c => {
    confirmations++;
    turnProposals.push({ id: String(c.id), capability: String(c.capability), entity_type: String(c.entity_type), entity_id: String(c.entity_id) });
    hooks.onConfirm?.(c);
  } };
  const phase = (step: string, label: string, start = Date.now()) => hooks.onPhase?.({ step, label, ms: Date.now() - start });
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream(), message = fresh();
    void (async () => {
      try {
        options?.signal?.throwIfAborted();
        if (++turns > MAX_TURNS) throw Error(LIMIT);
        const start = Date.now(); phase('llm', `Pi · 第 ${turns} 轮思考`);
        message.content.push({ type: 'text', text: '' }); stream.push({ type: 'start', partial: message });
        const outgoing = context.messages.map(toLlm);
        if (emptyNudge) { outgoing.push({ role: 'system', content: emptyNudge }); emptyNudge = ''; }
        const result = await chatCompletionsStream(cfg, outgoing, opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), delta => {
          const part = message.content[0]; if (part.type === 'text') part.text += delta;
          if (delta) stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message });
        }, options?.signal);
        options?.signal?.throwIfAborted();
        // 参数解析失败即结束本轮，绝不将损坏 JSON 默默当成空对象执行。
        if (result.reasoning) message.content.push({ type: 'thinking', thinking: result.reasoning });
        for (const call of result.tool_calls) message.content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) });
        message.stopReason = result.finish_reason === 'length' ? 'length' : result.tool_calls.length ? 'toolUse' : 'stop';
        phase('llm_done', 'Pi · 思考完成', start);
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = (error as Error).message;
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { stream.end(message); }
    })();
    return stream;
  };
  const tools: AgentTool[] = opts.tools.map(def => ({ name: def.name, label: def.description, description: def.description,
    parameters: def.parameters as AgentTool['parameters'],
    execute: async (id, payload, signal) => {
      signal?.throwIfAborted();
      payload = originals.get(id); originals.delete(id);
      const start = Date.now(); phase('tool', `调用工具 ${def.name}`);
      const requestId = requestIds.get(id);
      if (!requestId) throw Error('工具缺少可信请求身份，本次未执行');
      const result = await opts.execute(def, { id, type: 'function', function: { name: def.name, arguments: JSON.stringify(payload) } }, guarded, {requestId});
      phase('tool_done', `工具完成 ${def.name}`, start);
      // 对话审计：工具**回执**（回灌给模型之前的原文，与 classic 同一口径）。
      await hooks.onAudit?.({ kind: 'tool_response', request_id: requestId,
        tool_call_id: id, result: result.content });
      // 工具结果回灌闸（FIX-02）：**回灌给模型之前**才截断（执行器与审计拿到的仍是全文）。
      if (def.kind === 'query') turnReads.push(def.name);
      const bounded = boundToolResult(textOf(result.content), { toolName: def.name, args: payload });
      return { content: [{ type: 'text', text: bounded.content }], details: undefined };
    } }));
  const agent = new Agent({ initialState: { model, tools, systemPrompt: textOf(opts.messages[0].content),
    messages: opts.messages.slice(1, -1).map(m => m.role === 'assistant' ? { ...fresh(), content: [{ type: 'text', text: textOf(m.content) }] } : { role: 'user', content: [{ type: 'text', text: textOf(m.content) }], timestamp: Date.now() }) },
    streamFn, toolExecution: 'sequential',
    beforeToolCall: async ({ toolCall }) => {
      // 对话审计（classic 同款）：**发起**与**回执**两段，Pi 路径原先一段都没有。
      const requestId = randomUUID();
      requestIds.set(toolCall.id, requestId);
      const definition = opts.tools.find(item => item.name === toolCall.name);
      let resolvedActionId: string | undefined;
      try {
        resolvedActionId = definition ? opts.execute.resolveAuditAction?.(definition, {
          id: toolCall.id, type: 'function', function: {name: toolCall.name, arguments: JSON.stringify(toolCall.arguments)},
        }) : undefined;
      } catch (error) {
        // SDK会把beforeToolCall抛错变成普通工具结果；可信审计解析失败必须明确终止。
        auditResolutionError = error instanceof Error ? error : Error('无法核实工具实际动作，本次未执行');
        return {block: true, terminate: true, reason: auditResolutionError.message};
      }
      await hooks.onAudit?.({ kind: 'tool_request', request_id: requestId,
        action_id: definition?.capability,
        ...(typeof resolvedActionId==='string'&&resolvedActionId.length?{resolved_action_id:resolvedActionId}:{}),
        tool_call_id: toolCall.id,
        tool: toolCall.name, arguments: JSON.stringify(toolCall.arguments) });
      const validate = validators.get(toolCall.name);
      if (!validate?.(toolCall.arguments)) return { block: true, reason: '参数不符合动作原始 schema：' + ajv.errorsText(validate?.errors) };
      originals.set(toolCall.id, toolCall.arguments);
      const key = toolCall.name + ':' + JSON.stringify(toolCall.arguments);
      const n = (repeated.get(key) || 0) + 1; repeated.set(key, n);
      if (++toolsRun > MAX_TOOLS || n >= 3) { limitReached = true; return { block: true, terminate: true, reason: LIMIT }; }
    },
    finishTurn: ({ message }) => {
      if (message.stopReason === 'length') { reply = '模型输出被截断，本轮未执行截断的工具调用，请缩小操作范围后重试。'; return { action: 'end' }; }
      if (limitReached || turns >= MAX_TURNS && message.content.some(c => c.type === 'toolCall')) { reply = LIMIT; return { action: 'end' }; }
      const text = textOf(message.content);
      if (!message.content.some(c => c.type === 'toolCall')) {
        // —— 空回答自动重试一次（BASE967-28，classic 同款）：**无副作用**时（没生成过候选）才重试。
        if (!text.trim() && !emptyRetried && confirmations === 0 && turns < MAX_TURNS - 1) {
          emptyRetried = true;
          emptyNudge = '你上一条回复为空。请直接给出回答；需要事实先调用工具。';
          return { action: 'continue' };   // 继续下一轮：下一轮会把上面这句带进模型上下文
        }
        // —— 声明-回执对账（classic 同款）：**写入/邮件类声明也要查**，不能只查确认类。
        const unfounded = classifyUnfoundedClaims(text, { proposals: turnProposals.length, reads: turnReads.length });
        if (unfounded.length) { reply = truthfulReply({ proposals: turnProposals, reads: turnReads }, unfounded); return { action: 'end' }; }
        reply = confirmations === 0 && claimsConfirmation(text) ? NO_CONFIRMATION_REPLY : text;
      }
    },
  });
  agent.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') hooks.onText?.(event.assistantMessageEvent.delta);
    if (event.type === 'message_end' && event.message.role === 'assistant') reasoning += event.message.content.filter(c => c.type === 'thinking').map(c => c.thinking).join('');
  });
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const abort = () => agent.abort(); signal.addEventListener('abort', abort, { once: true });
  try {
    if (!signal.aborted) await agent.prompt(textOf(opts.messages.at(-1)!.content));
    if (auditResolutionError) throw auditResolutionError;
    if (opts.signal?.aborted) return { reply: '', reasoning };
    signal.throwIfAborted();
    if (agent.state.errorMessage) throw Error(agent.state.errorMessage);
    return { reply: reply || '（未得到有效回答，请换个说法再试）', reasoning };
  } finally { signal.removeEventListener('abort', abort); }
}
