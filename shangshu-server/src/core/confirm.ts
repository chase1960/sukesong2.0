// 持久化确认执行：业务状态、执行结果、审计在同一事务提交。
import { appendEvent, resolveEvent, parsePayload } from './events.ts';
import { atomic } from './storage/transaction.ts';
import { currentActor, requireActor, type ActorContext } from './actor.ts';
import { getActionContract, registerActionContract, checkAction, type ActionHandler, type ActionContract } from './action-contracts.ts';
import type { StateStore, ExecutionEvent } from './types.ts';
export type { ActionHandler } from './action-contracts.ts';

// 旧 handler 的显式迁移适配。新对象应注册完整 ActionContract。
export function registerActionHandler(id: string, execute: ActionHandler, options?: Partial<Pick<ActionContract,'revision'|'roles'|'inputSchema'|'resolve'|'snapshot'>>): void {
  registerActionContract({ id, revision: options?.revision || 1, roles: options?.roles || ['admin'], confirmation: 'human',
    inputSchema: options?.inputSchema || { type: 'object' }, resolve: options?.resolve, snapshot: options?.snapshot, execute }, { replace: true });
}

export async function requestConfirmation(store: StateStore, opts: {
  capability: string; entity_type: string; entity_id: string; payload: Record<string, unknown>; initiator: string;
}): Promise<string> {
  const contract = getActionContract(opts.capability);
  const actor = requireActor();
  checkAction(contract, actor, opts.payload);
  return atomic(store, async tx => {
    const id = await appendEvent(tx, { ...opts, status: 'proposed' });
    await tx.insert('execution', 'action_executions', {
      id, action_id: opts.capability, action_revision: contract.revision,
      entity_type: opts.entity_type, entity_id: opts.entity_id,
      payload: opts.payload, initiator: actor?.id || opts.initiator,
      resource_snapshot: contract.snapshot ? await contract.snapshot(tx, opts.payload) : null,
      status: 'proposed', attempt: 0, created_at: new Date().toISOString(),
    });
    return id;
  });
}

export async function resolveConfirmation(
  store: StateStore, eventId: string, decision: 'confirmed' | 'rejected', reviewer: string | ActorContext,
): Promise<void> {
  // 字符串只是旧 Web 展示名；授权来自认证上下文或显式服务端 ActorContext。
  const actor = requireActor(typeof reviewer === 'string' ? currentActor() : reviewer);
  const name = typeof reviewer === 'string' ? reviewer : actor.id;
  const [proposal] = await store.query('execution', 'events', { id: eventId });
  if (!proposal || proposal.status !== 'proposed') throw new Error(`事件不存在或非 proposed: ${eventId}`);
  let contract: ActionContract | undefined;
  try {contract=getActionContract(proposal.capability);}
  catch(error) {if(decision!=='rejected' || actor.role!=='admin') throw error;}
  if(contract) checkAction(contract, actor);
  let executing = false;
  try {
    await atomic(store, async tx => {
      const all = await tx.query('execution', 'events');
      if (all.some(r => parsePayload(r.payload)._resolves === eventId)) throw new Error(`该提案已处理: ${eventId}`);
      const [execution] = await tx.query('execution', 'action_executions', { id: eventId });
      if (decision === 'rejected') {
        await resolveEvent(tx, eventId, 'rejected', name);
        if (execution) await tx.update('execution', 'action_executions', eventId, { status: 'rejected', reviewer: actor.id });
        return;
      }
      if (!execution) throw new Error('旧提案缺少执行契约，请拒绝后按当前契约重新提案');
      if(!contract) throw new Error('动作未注册');
      if (execution.action_revision !== contract.revision) throw new Error('动作版本已变更，请重新提案确认');
      checkAction(contract, actor, execution.payload);
      if (contract.snapshot && JSON.stringify(await contract.snapshot(tx,execution.payload)) !== JSON.stringify(execution.resource_snapshot)) throw new Error('确认对象已变化，请重新提案');
      executing = true;
      await tx.update('execution', 'action_executions', eventId, { status: 'executing', attempt: execution.attempt + 1 });
      const createdId = await contract.execute(execution.payload, { store: tx, executionId: eventId, actor });
      await resolveEvent(tx, eventId, 'confirmed', name);
      if (createdId && /^(agent:|manual:)/.test(proposal.entity_id)) {
        await appendEvent(tx, { capability: `${proposal.capability}.link`, entity_type: proposal.entity_type,
          entity_id: createdId, payload: { _links: eventId, _via: proposal.capability },
          initiator: proposal.initiator, status: 'confirmed', reviewer: name, executor: actor.id });
      }
      await tx.update('execution', 'action_executions', eventId, {
        status: 'succeeded', result_id: createdId || '', reviewer: actor.id, finished_at: new Date().toISOString(),
      });
    });
  } catch (error) {
    // 业务事务已回滚；失败审计另行提交。不能在事务 handler 中调用外部服务。
    if (executing) await atomic(store, async tx => {
      const [execution] = await tx.query('execution', 'action_executions', { id: eventId });
      if (execution && !['succeeded','rejected'].includes(execution.status)) {
        await tx.update('execution', 'action_executions', eventId, { status: 'failed', attempt: execution.attempt + 1, error: (error as Error).message });
        await resolveEvent(tx, eventId, 'failed', name, { _error: (error as Error).message }, false);
      }
    });
    throw error;
  }
}

export async function listPendingConfirmations(store: StateStore): Promise<ExecutionEvent[]> {
  const rows = await store.query('execution', 'events');
  const resolved = new Set(rows.map(r => parsePayload(r.payload)._resolves));
  return rows.filter(r => {
    if (r.status !== 'proposed' || resolved.has(r.id)) return false;
    // 未注册执行契约的能力（如招聘域的 AI 草稿提案）不可确认，出现在待办里只会 500。
    try { getActionContract(r.capability); return true; } catch { return false; }
  })
    .sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(r => ({ ...r, payload: parsePayload(r.payload) }));
}
