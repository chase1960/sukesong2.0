// 数字员工最小运行时：持久职责 + 已发布流程 + 人工接管。
// 设计边界：
//   1. 员工配置只引用现有 workflow，不新增一套 Action/任务/审计模型；
//   2. worker 以人工派发者的可信身份运行，写动作仍受原有 effect/确认卡约束；
//   3. worker_runs 只是 flow_runs 的责任投影，事实轨迹仍以 execution.flow_runs 和 events 为准。
import { randomUUID } from 'node:crypto';
import { authorize, requireActor, type ActorContext } from './actor.ts';
import { appendEvent } from './events.ts';
import { atomic } from './storage/transaction.ts';
import type { Context, StateStore } from './types.ts';
import { getCapability } from './registry.ts';
import {
  capabilityIdsOf, getWorkflowTemplate, graphOf, runWorkflow, resumeWorkflow,
  type WorkflowTemplate,
} from './workflow-engine.ts';
import { handoffWorkflow } from './workflow-engine.ts';

export type WorkerProfileStatus = 'active' | 'paused' | 'retired';
export type WorkerRunStatus = 'dispatching' | 'running' | 'waiting' | 'paused' | 'handed_off' | 'completed' | 'failed';

export interface WorkerProfile {
  id: string; name: string; responsibility: string; flow_id: string;
  allowed_tools: string[]; owner: string; status: WorkerProfileStatus;
  revision: number; created_at: string; updated_at: string;
  _version?: number;
}

export interface WorkerRun {
  id: string; profile_id: string; flow_run_id: string; status: WorkerRunStatus;
  input: Record<string, unknown>; owner: string; handoff_to: string;
  pause_reason: string; error: string; created_at: string; updated_at: string; completed_at?: string;
  _version?: number;
}

const PROFILE_TABLE = 'worker_profiles';
const RUN_TABLE = 'worker_runs';
const WORKER_ID = /^worker\.[a-z][a-z0-9_.-]+$/;
const SIDE_EFFECTS = new Set(['ingest', 'propose']);
const TERMINAL = new Set<WorkerRunStatus>(['completed', 'failed']);

function now(): string { return new Date().toISOString(); }
function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}
function transactionRequired(store: StateStore): void {
  if (!store.guarantees?.transactions || !store.transaction) throw new Error('数字员工运行需要事务主存储（SQLite/Frappe），当前适配器不支持可靠恢复');
}
function profileFromRow(row: any): WorkerProfile {
  return { ...row, allowed_tools: parseJson<string[]>(row.allowed_tools, []), status: String(row.status) as WorkerProfileStatus };
}
function runFromRow(row: any): WorkerRun {
  return { ...row, input: parseJson<Record<string, unknown>>(row.input, {}) };
}
function kindOf(node: any): string {
  return node.kind || (node.approval ? 'approval' : node.candidateTools?.length && !node.capability ? 'agent' : 'capability');
}
function actorCanOperate(actor: ActorContext, run: WorkerRun): boolean {
  return actor.role === 'admin' || actor.id === run.owner || actor.id === run.handoff_to;
}

function validateProfileInput(input: { id: string; name: string; responsibility: string; flow_id: string; allowed_tools?: string[] }): { template: WorkflowTemplate; allowed: string[] } {
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim();
  const responsibility = String(input.responsibility || '').trim();
  const flowId = String(input.flow_id || '').trim();
  if (!WORKER_ID.test(id)) throw new Error('数字员工 id 须为 worker. 开头的小写标识');
  if (!name || name.length > 80) throw new Error('数字员工名称必填且不能超过 80 个字符');
  if (!responsibility || responsibility.length > 500) throw new Error('数字员工职责必填且不能超过 500 个字符');
  const template = getWorkflowTemplate(flowId);
  if (!template) throw new Error(`流程不存在或尚未发布：${flowId}`);
  const available = [...new Set(capabilityIdsOf(template))];
  const requested = input.allowed_tools == null ? available : [...new Set(input.allowed_tools.map(String).map(v => v.trim()).filter(Boolean))];
  if (!requested.length) throw new Error('数字员工至少需要一个允许能力');
  const extra = requested.filter(id => !available.includes(id));
  if (extra.length) throw new Error(`允许能力不在流程白名单内：${extra.join(', ')}`);
  const missing = available.filter(id => !requested.includes(id));
  if (missing.length) throw new Error(`流程包含未授权能力：${missing.join(', ')}`);
  for (const id of requested) {
    const cap = getCapability(id);
    if (!cap.effect || ['internal', 'orchestrate'].includes(cap.effect)) throw new Error(`能力不允许绑定数字员工：${id}`);
  }
  // 具有提案/写入效果的流程必须在其前面声明审批节点；真正执行仍由 ActionContract 再次确认。
  let approvalSeen = false;
  for (const node of graphOf(template).nodes) {
    const kind = kindOf(node);
    if (kind === 'approval') { approvalSeen = true; continue; }
    const ids = kind === 'agent' ? (node.candidateTools || []) : node.capability ? [node.capability] : [];
    for (const actionId of ids) {
      const cap = getCapability(actionId);
      if (SIDE_EFFECTS.has(String(cap.effect)) && !approvalSeen) throw new Error(`写入/提案能力 ${actionId} 前必须有人工审批节点`);
    }
  }
  return { template, allowed: requested };
}

export async function createWorkerProfile(store: StateStore, input: { id: string; name: string; responsibility: string; flow_id: string; allowed_tools?: string[] }, actor = requireActor()): Promise<WorkerProfile> {
  authorize(['admin'], actor);
  transactionRequired(store);
  const { allowed } = validateProfileInput(input);
  const existing = await store.query('cognition', PROFILE_TABLE, { id: input.id });
  if (existing.length) throw new Error(`数字员工已存在：${input.id}`);
  const timestamp = now();
  const profile: WorkerProfile = {
    id: input.id, name: input.name.trim(), responsibility: input.responsibility.trim(), flow_id: input.flow_id.trim(),
    allowed_tools: allowed, owner: actor.id, status: 'active', revision: 1, created_at: timestamp, updated_at: timestamp,
  };
  await atomic(store, async tx => {
    await tx.insert('cognition', PROFILE_TABLE, { ...profile, allowed_tools: json(allowed) });
    await appendEvent(tx, { capability: 'worker.profile.create', entity_type: 'worker', entity_id: profile.id, payload: { flow_id: profile.flow_id, allowed_tools: allowed }, initiator: actor.id, status: 'confirmed', reviewer: actor.id, executor: actor.id });
  });
  return profile;
}

export async function listWorkerProfiles(store: StateStore, status?: WorkerProfileStatus): Promise<WorkerProfile[]> {
  const rows = await store.query('cognition', PROFILE_TABLE, status ? { status } : undefined);
  return rows.map(profileFromRow).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function getProfile(store: StateStore, id: string): Promise<WorkerProfile> {
  const [row] = await store.query('cognition', PROFILE_TABLE, { id });
  if (!row) throw new Error(`数字员工不存在：${id}`);
  return profileFromRow(row);
}

async function syncRun(store: StateStore, row: WorkerRun): Promise<WorkerRun> {
  if (!row.flow_run_id || TERMINAL.has(row.status) || ['paused', 'handed_off'].includes(row.status)) return row;
  const [flow] = await store.query('execution', 'flow_runs', { id: row.flow_run_id });
  if (!flow) return row;
  const mapped: WorkerRunStatus = flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'failed' : flow.status === 'waiting' ? 'waiting' : 'running';
  if (mapped === row.status && !(mapped === 'completed' && row.completed_at)) return row;
  const patch: any = { status: mapped, updated_at: now() };
  if (mapped === 'completed' || mapped === 'failed') patch.completed_at = now();
  if (mapped === 'failed') patch.error = String(flow.error || row.error || '流程执行失败');
  await store.update('execution', RUN_TABLE, row.id, patch);
  return { ...row, ...patch };
}

export async function listWorkerRuns(store: StateStore, profileId?: string): Promise<WorkerRun[]> {
  const rows = await store.query('execution', RUN_TABLE, profileId ? { profile_id: profileId } : undefined);
  const synced = await Promise.all(rows.map(row => syncRun(store, runFromRow(row))));
  return synced.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getWorkerRun(store: StateStore, id: string): Promise<WorkerRun | null> {
  const [row] = await store.query('execution', RUN_TABLE, { id });
  return row ? syncRun(store, runFromRow(row)) : null;
}

export async function dispatchWorker(store: StateStore, profileId: string, input: Record<string, unknown>, ctx: Context): Promise<WorkerRun> {
  const actor = requireActor(ctx.actor);
  transactionRequired(store);
  const profile = await getProfile(store, profileId);
  if (profile.status !== 'active') throw new Error(`数字员工当前不可派发：${profile.status}`);
  validateProfileInput({ id: profile.id, name: profile.name, responsibility: profile.responsibility, flow_id: profile.flow_id, allowed_tools: profile.allowed_tools });
  const run: WorkerRun = { id: `wr_${randomUUID()}`, profile_id: profile.id, flow_run_id: '', status: 'dispatching', input: structuredClone(input), owner: actor.id, handoff_to: '', pause_reason: '', error: '', created_at: now(), updated_at: now() };
  await atomic(store, async tx => {
    await tx.insert('execution', RUN_TABLE, { ...run, input: json(input) });
    await appendEvent(tx, { capability: 'worker.dispatch', entity_type: 'worker', entity_id: profile.id, payload: { run_id: run.id, flow_id: profile.flow_id }, initiator: actor.id, status: 'confirmed', reviewer: actor.id, executor: actor.id });
  });
  try {
    const flow = await runWorkflow(store, profile.flow_id, input, ctx, { initiator: profile.id });
    const status: WorkerRunStatus = flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'failed' : flow.status === 'waiting' ? 'waiting' : 'running';
    const patch: any = { flow_run_id: flow.id, status, updated_at: now() };
    if (status === 'completed' || status === 'failed') patch.completed_at = now();
    if (status === 'failed') patch.error = String(flow.error || '流程执行失败');
    await store.update('execution', RUN_TABLE, run.id, patch);
    return { ...run, ...patch, input };
  } catch (error) {
    const message = (error as Error).message;
    await store.update('execution', RUN_TABLE, run.id, { status: 'failed', error: message, updated_at: now(), completed_at: now() });
    throw error;
  }
}

async function getOperableRun(store: StateStore, id: string, actor: ActorContext): Promise<WorkerRun> {
  const run = await getWorkerRun(store, id);
  if (!run) throw new Error(`数字员工运行不存在：${id}`);
  if (!actorCanOperate(actor, run)) throw new Error('无权操作该数字员工运行');
  if (TERMINAL.has(run.status)) throw new Error(`运行已结束：${run.status}`);
  return run;
}

export async function pauseWorkerRun(store: StateStore, id: string, reason: string, actor = requireActor()): Promise<WorkerRun> {
  const run = await getOperableRun(store, id, actor);
  if (run.status !== 'waiting') throw new Error('只有等待人工处理的运行可以暂停');
  await store.update('execution', RUN_TABLE, id, { status: 'paused', pause_reason: String(reason || '人工暂停').slice(0, 200), updated_at: now() });
  return (await getWorkerRun(store, id))!;
}

export async function handoffWorkerRun(store: StateStore, id: string, target: ActorContext, actor = requireActor()): Promise<WorkerRun> {
  const run = await getOperableRun(store, id, actor);
  const recipient = String(target?.id || '').trim();
  if (!recipient) throw new Error('交接对象不能为空');
  if (target.kind !== 'human') throw new Error('数字员工只能交接给人工账号');
  if (!['waiting', 'paused', 'handed_off'].includes(run.status)) throw new Error('只有等待/暂停中的运行可以交接');
  if (!run.flow_run_id) throw new Error('运行缺少流程快照，无法交接');
  await handoffWorkflow(store, run.flow_run_id, target, actor);
  await store.update('execution', RUN_TABLE, id, { status: 'handed_off', handoff_to: recipient, updated_at: now() });
  await appendEvent(store, { capability: 'worker.handoff', entity_type: 'worker_run', entity_id: id, payload: { from: actor.id, to: recipient }, initiator: actor.id, status: 'confirmed', reviewer: actor.id, executor: actor.id });
  return (await getWorkerRun(store, id))!;
}

export async function resumeWorkerRun(store: StateStore, id: string, ctx: Context): Promise<WorkerRun> {
  const actor = requireActor(ctx.actor);
  const run = await getOperableRun(store, id, actor);
  if (!['paused', 'handed_off', 'waiting'].includes(run.status)) throw new Error(`当前运行不可恢复：${run.status}`);
  if (!run.flow_run_id) throw new Error('运行缺少流程快照，无法恢复');
  const flow = await resumeWorkflow(store, run.flow_run_id, ctx);
  const status: WorkerRunStatus = flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'failed' : flow.status === 'waiting' ? 'waiting' : 'running';
  const patch: any = { status, owner: run.handoff_to || run.owner, handoff_to: '', updated_at: now() };
  if (status === 'completed' || status === 'failed') patch.completed_at = now();
  if (status === 'failed') patch.error = String(flow.error || '流程执行失败');
  await store.update('execution', RUN_TABLE, id, patch);
  return (await getWorkerRun(store, id))!;
}
