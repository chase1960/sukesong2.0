// 通用流程：只解释步骤契约，不认识发票、OCR 路径或具体业务表。
// 2026-08-28 图模型升级：模板可声明 graph{nodes,edges,start}（四类节点：capability/agent/approval/gateway；
// 边语义 success/rejected/timeout + 条件边 when.equals）。旧 steps[] 线性模板自动转链式图，行为不变。
// approval 节点：串行（按 roles 顺序逐个审）/any（任一角色通过即过）+ 超时边；决定走 execution.flow_approvals。
import { createHash, randomUUID } from 'node:crypto';
import { getCapability } from './registry.ts';
import { validateSchema, assertSchema, type JsonSchema } from './action-contracts.ts';
import { atomic } from './storage/transaction.ts';
import { requireActor, withActor, type ActorContext } from './actor.ts';
import type { Context, StateStore } from './types.ts';
import { getObjectType } from './objects.ts';
import { getDocType } from './doctypes.ts';

export type StepStrategy = 'fixed' | 'agent';
export type NodeKind = 'capability' | 'agent' | 'approval' | 'gateway';
export interface WorkflowStepDef {
  id: string; name: string; capability: string; strategy?: StepStrategy;
  candidateTools?: string[]; optional?: boolean; note?: string;
  inputMap?: Record<string, unknown>;
  when?: { missing?: string[]; path?: string; equals?: unknown };
  retry?: number;
}
export interface WorkflowNodeDef {
  id: string;
  kind?: NodeKind;                 // 缺省按 strategy 推断（兼容 steps 转 graph）
  name: string;
  capability?: string;             // capability 节点
  candidateTools?: string[];       // agent 节点
  inputMap?: Record<string, unknown>;
  when?: { missing?: string[]; path?: string; equals?: unknown };   // capability 节点自跳过（线性兼容）
  retry?: number; optional?: boolean; note?: string;
  approval?: {                     // approval 节点
    roles: string[];               // 有序：serial 按序逐个；any 任一通过
    mode?: 'serial' | 'any';       // 缺省 serial
    timeout_hours?: number;        // 超时 → timeout 边（懒检查：恢复/审批时判定）
  };
  switch?: { path: string };       // gateway 节点：取值路径，出边用 when.equals 匹配
  ui?: { x?: number; y?: number }; // 编辑器画布坐标（非执行语义）
}
export interface WorkflowEdgeDef {
  from: string; to: string;
  kind?: 'success' | 'rejected' | 'timeout';   // approval 出边语义；缺省 success
  when?: { path?: string; equals?: unknown };  // 条件边：命中即走（capability/gateway 出边）
  label?: string;
}
export interface WorkflowGraph { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[]; start: string; }
export interface WorkflowTemplate {
  id: string; name: string; description: string; doctype?: string;
  revision?: number; inputSchema?: JsonSchema; resultMap?: Record<string, unknown>;
  dependencies?: {objects?:string[];doctypes?:string[]};
  steps: WorkflowStepDef[];        // 线性模板（与 graph 二选一；graph 优先）
  graph?: WorkflowGraph;
}
export interface StepTrace {
  step_id: string; name: string; capability: string; strategy: StepStrategy;
  status: 'ok' | 'failed' | 'skipped'; started_at: string; finished_at: string;
  attribution?: string; warnings?: string[]; error?: string; output_keys?: string[];
  candidates?: string[]; selection_reason?: string; attempts?: number;
  input?: Record<string, unknown>; output?: Record<string, unknown>;
  kind?: NodeKind; approval?: { mode: string; roles: string[]; decision: 'approved' | 'rejected' | 'timeout'; decided_by?: string };
}
export interface WorkflowRunRecord {
  id: string; flow_id: string; status: 'running' | 'waiting' | 'completed' | 'failed';
  started_at: string; finished_at?: string; initiator: string; input_summary: string;
  steps: StepTrace[]; result?: Record<string, unknown>; error?: string;
  revision: number; template_hash: string; template: WorkflowTemplate;
  input: Record<string, unknown>; actor: ActorContext; capability_revisions: Record<string, number>;
  metadata_dependencies: Record<string,string>;
  cursor?: string;                 // 图游标：当前停留节点（waiting=卡在审批）
}
const templates = new Map<string, WorkflowTemplate>();
export function clearWorkflowTemplates(): void { templates.clear(); }

// —— 归一化：graph 优先；无 graph 时把线性 steps 转成链式图（行为与旧引擎一致） ——
export function graphOf(t: WorkflowTemplate): WorkflowGraph {
  if (t.graph?.nodes?.length) return t.graph;
  const nodes: WorkflowNodeDef[] = t.steps.map(s => ({
    id: s.id, name: s.name, capability: s.capability,
    kind: s.strategy === 'agent' ? 'agent' : 'capability',
    candidateTools: s.candidateTools, inputMap: s.inputMap, when: s.when,
    retry: s.retry, optional: s.optional, note: s.note,
  }));
  const edges: WorkflowEdgeDef[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  return { nodes, edges, start: nodes[0]?.id || '' };
}
const nodeKind = (n: WorkflowNodeDef): NodeKind => n.kind || (n.candidateTools?.length && !n.capability ? 'agent' : n.approval ? 'approval' : 'capability');
const VALID_ROLES = ['admin', 'finance', 'manager', 'staff'];

// 模板引用的全部可执行能力 id（meta 发布校验用）
export function capabilityIdsOf(t: WorkflowTemplate): string[] {
  const ids: string[] = [];
  for (const node of graphOf(t).nodes) {
    const kind = nodeKind(node);
    if (kind === 'agent') ids.push(...(node.candidateTools || []));
    else if (kind === 'capability' && node.capability) ids.push(node.capability);
  }
  return ids;
}
export function validateWorkflow(t: WorkflowTemplate): void {
  if (!t.id) throw new Error('WorkflowTemplate 需 id');
  if (t.inputSchema) assertSchema(t.inputSchema);
  const g = graphOf(t);
  if (!g.nodes.length) throw new Error('WorkflowTemplate 需 steps 或 graph.nodes');
  const ids = new Set<string>();
  for (const node of g.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error('流程节点 id 缺失或重复');
    ids.add(node.id);
    const kind = nodeKind(node);
    if (kind === 'capability' || kind === 'agent') {
      if (kind === 'agent' && !node.candidateTools?.length) throw new Error('agent 节点必须声明候选白名单');
      if (kind === 'capability' && !node.capability) throw new Error(`节点 ${node.id} 缺少 capability`);
      if (node.retry != null && (!Number.isInteger(node.retry) || node.retry < 0 || node.retry > 3)) throw new Error('retry 仅允许 0–3');
    }
    if (kind === 'approval') {
      const a = node.approval;
      if (!a?.roles?.length || !a.roles.every((r) => VALID_ROLES.includes(r))) throw new Error(`审批节点 ${node.id} 角色非法（${VALID_ROLES.join('/')}）`);
      if (a.mode && !['serial', 'any'].includes(a.mode)) throw new Error(`审批节点 ${node.id} mode 仅 serial/any`);
      if (a.timeout_hours != null && (!(a.timeout_hours > 0) || a.timeout_hours > 24 * 30)) throw new Error(`审批节点 ${node.id} timeout_hours 非法`);
    }
    if (kind === 'gateway' && !node.switch?.path) throw new Error(`网关节点 ${node.id} 缺少 switch.path`);
  }
  if (!ids.has(g.start)) throw new Error('start 节点不存在');
  const defaults = new Map<string, number>();
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`边引用了不存在的节点: ${e.from}→${e.to}`);
    const src = g.nodes.find((n) => n.id === e.from)!;
    const kind = nodeKind(src);
    if (kind === 'approval') {
      if (e.kind && !['success', 'rejected', 'timeout'].includes(e.kind)) throw new Error(`审批出边仅允许 success/rejected/timeout: ${e.from}`);
      if (e.when) throw new Error(`审批出边不支持条件: ${e.from}`);
    } else if (e.kind && e.kind !== 'success') throw new Error(`非审批出边不支持 ${e.kind}: ${e.from}`);
    const srcKind = nodeKind(g.nodes.find((n) => n.id === e.from)!);
    if (!e.when && srcKind !== 'approval') defaults.set(e.from, (defaults.get(e.from) || 0) + 1);
  }
  for (const [from, count] of defaults) if (count > 1) throw new Error(`节点 ${from} 有多条无条件出边，路由歧义`);
}
export function registerWorkflowTemplate(t: WorkflowTemplate): void { validateWorkflow(t); templates.set(t.id, structuredClone(t)); }
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined { const t = templates.get(id); return t && structuredClone(t); }
export function listWorkflowTemplates() { return [...templates.values()].map(t => ({ ...structuredClone(t), step_count: graphOf(t).nodes.length })); }
function at(root: any, path: string): any {
  if (path.split('.').some(k => ['__proto__','prototype','constructor'].includes(k))) throw new Error('非法映射路径');
  return path.split('.').reduce((value,key) => value?.[key], root);
}
function mapped(value: any, root: any): any {
  if (typeof value === 'string' && value.startsWith('$')) return at(root, value.slice(1));
  // $coalesce 兼容两种写法：裸路径（旧 steps.resultMap 风格 steps.x.y）与 $ 前缀（inputMap 内 $input.x）
  if (value && typeof value === 'object' && Array.isArray(value.$coalesce)) return value.$coalesce.map((p: string) => at(root, p.startsWith('$') ? p.slice(1) : p)).find((v: unknown) => v !== undefined && v !== null);
  if (Array.isArray(value)) return value.map(v => mapped(v,root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,mapped(v,root)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function dependencyValue(key:string):unknown {
  const [kind,id]=key.split(':');
  const value=kind==='object' ? getObjectType(id) : getDocType(id);
  if(!value) throw new Error(`流程依赖元数据不存在: ${key}`);
  return value;
}
function dependencies(template:WorkflowTemplate,input:Record<string,unknown>):Record<string,string> {
  const keys=new Set<string>();
  for(const id of template.dependencies?.objects || []) keys.add(`object:${id}`);
  for(const id of template.dependencies?.doctypes || []) keys.add(`doctype:${id}`);
  if(template.doctype) keys.add(`doctype:${template.doctype}`);
  const nodes=graphOf(template).nodes;
  for(const source of [input,...nodes.map(node=>node.inputMap || {})]) {
    for(const kind of ['object','doctype']) if(typeof source[kind]==='string' && !source[kind].startsWith('$')) keys.add(`${kind}:${source[kind]}`);
  }
  return Object.fromEntries([...keys].map(key=>[key,digest(dependencyValue(key))]));
}

export async function runWorkflow(store: StateStore, flowId: string, input: Record<string, unknown>, ctx: Context, opts?: { initiator?: string }): Promise<WorkflowRunRecord> {
  const template = getWorkflowTemplate(flowId);
  if (!template) throw new Error(`未知办事流程: ${flowId}`);
  const actor = requireActor(ctx.actor);
  validateSchema(template.inputSchema || {type:'object'}, input);
  // 在写任何运行记录前验证所有可执行能力及效果，防止配置把 query 变成任意写。
  const capability_revisions: Record<string,number> = {};
  for (const node of graphOf(template).nodes) for (const id of nodeKind(node) === 'agent' ? node.candidateTools! : (nodeKind(node) === 'capability' ? [node.capability!] : [])) {
    const cap = getCapability(id);
    capability_revisions[id] = cap.revision || 1;
    if (!cap.effect || ['internal','orchestrate'].includes(cap.effect)) throw new Error(`能力未授权进入流程: ${id}`);
    if (node.retry && !['read','extract'].includes(cap.effect)) throw new Error('写步骤禁止自动重试；由原子检查点恢复');
  }
  const graph = graphOf(template);
  const record: WorkflowRunRecord = {
    id: `fr_${randomUUID()}`, flow_id: flowId, revision: template.revision || 1,
    template_hash: digest(template), template, capability_revisions, metadata_dependencies:dependencies(template,input), input: structuredClone(input), actor,
    status:'running', started_at:new Date().toISOString(), initiator:actor.id,
    input_summary: String(input.filename || input.file_token || input.summary || ''), steps:[], cursor: graph.start,
  };
  await atomic(store, tx => tx.insert('execution','flow_runs',record));
  return executeRun(store, record, ctx);
}

export async function resumeWorkflow(store: StateStore, id: string, ctx: Context): Promise<WorkflowRunRecord> {
  const record = await getWorkflowRun(store,id);
  if (!record) throw new Error('未找到运行记录');
  if(!record.actor || !record.template || !record.template_hash || !record.capability_revisions) throw new Error('旧流程缺少可恢复快照，只能查看历史；请创建新运行');
  const actor = requireActor(ctx.actor);
  if (actor.id !== record.actor.id && actor.role !== 'admin') throw new Error('无权恢复其他人的流程');
  if (record.status === 'completed') return record;
  if (record.template_hash !== digest(record.template)) throw new Error('流程快照校验失败');
  return executeRun(store, record, ctx);
}

// 图游标初始化：优先持久化 cursor；旧记录（无 cursor）按「首个未完成节点」恢复——与旧线性引擎跳过语义一致
function initialCursor(record: WorkflowRunRecord, graph: WorkflowGraph): string | null {
  if (record.cursor) return record.cursor;
  for (const node of graph.nodes) {
    const done = record.steps.some(t => t.step_id === node.id && t.status !== 'failed');
    if (!done) return node.id;
  }
  return null;   // 全部完成
}
// 出边选择：approval 按 kind；capability/agent/gateway 按条件边（when.equals 匹配 when.path ?? node.switch.path），无条件边兜底；无出边=完成
function nextNodeId(graph: WorkflowGraph, nodeId: string, edgeKind: 'success' | 'rejected' | 'timeout', root: any): string | null {
  const outs = graph.edges.filter(e => e.from === nodeId);
  if (!outs.length) return null;
  const node = graph.nodes.find(n => n.id === nodeId)!;
  if (nodeKind(node) === 'approval') {
    const hit = outs.find(e => (e.kind || 'success') === edgeKind);
    return hit ? hit.to : null;
  }
  for (const e of outs) {
    if (e.when && 'equals' in e.when) {
      const path = e.when.path || node.switch?.path;
      if (path && at(root, path) === e.when.equals) return e.to;
    }
  }
  return outs.find(e => !e.when)?.to ?? outs[0]?.to ?? null;
}

// —— 审批任务：serial=按 roles 顺序逐 slot 一张；any=每角色一张、首个决定生效 ——
export interface FlowApprovalTask {
  id: string; run_id: string; flow_id: string; node_id: string; node_name: string;
  mode: string; role: string; slot: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'timeout';
  note?: string; input_summary?: string; created_at: string; decided_at?: string; decided_by?: string;
}
export async function listMyApprovals(store: StateStore, actor: ActorContext): Promise<FlowApprovalTask[]> {
  const rows = (await store.query('execution', 'flow_approvals', { status: 'pending' })) as any[];
  return rows
    .filter((t) => actor.role === 'admin' || t.role === actor.role)
    .map((t) => ({ ...t, slot: Number(t.slot) || 0 }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
export async function decideFlowApproval(store: StateStore, taskId: string, decision: 'approved' | 'rejected', ctx: Context): Promise<WorkflowRunRecord> {
  const actor = requireActor(ctx.actor);
  const [task] = await store.query('execution', 'flow_approvals', { id: taskId });
  if (!task) throw new Error('审批任务不存在');
  if (task.status !== 'pending') throw new Error(`该任务已处理（${task.status}）`);
  if (actor.role !== 'admin' && actor.role !== task.role) throw new Error(`需要 ${task.role} 角色审批`);
  await atomic(store, async tx => {
    await tx.update('execution', 'flow_approvals', taskId, { status: decision, decided_at: new Date().toISOString(), decided_by: actor.id });
    if (task.mode === 'any' && decision === 'approved') {
      const sibs = (await tx.query('execution', 'flow_approvals', { run_id: task.run_id, node_id: task.node_id, status: 'pending' })) as any[];
      for (const s of sibs) await tx.update('execution', 'flow_approvals', s.id, { status: 'cancelled', decided_at: new Date().toISOString(), decided_by: actor.id });
    }
  });
  const record = await getWorkflowRun(store, task.run_id);
  if (!record) throw new Error('运行记录不存在');
  if (record.status !== 'waiting') throw new Error(`流程不在等待审批状态（${record.status}）`);
  if (record.template_hash !== digest(record.template)) throw new Error('流程快照校验失败');
  return executeRun(store, record, ctx);
}

async function executeRun(store: StateStore, record: WorkflowRunRecord, ctx: Context): Promise<WorkflowRunRecord> {
  const owner = randomUUID();
  // 租约阻止多个 worker 同时恢复；财务副作用与步骤检查点仍在同一事务。
  await atomic(store, async tx => {
    const [live] = await tx.query('execution','flow_runs',{id:record.id});
    if (live.lease_until && live.lease_until > Date.now()) throw new Error('流程正在执行，请待租约到期后恢复');
    record.steps = live.steps; record.cursor = live.cursor ?? record.cursor;
    await tx.update('execution','flow_runs',record.id,{ lease_owner:owner, lease_until:Date.now()+300000, status:'running' });
  });
  const graph = graphOf(record.template);
  const root: any = { input:record.input, steps:{} };
  record.status='running'; record.error=undefined;
  for (const trace of record.steps) if (trace.status === 'ok') root.steps[trace.step_id] = trace.output;
  let cursor = initialCursor(record, graph);
  try {
    while (cursor) {
      for(const [key,hash] of Object.entries(record.metadata_dependencies || {})) if(digest(dependencyValue(key))!==hash) throw new Error(`流程依赖元数据已变化，须按新版本重新运行: ${key}`);
      const node = graph.nodes.find(n => n.id === cursor);
      if (!node) throw new Error(`图游标指向不存在的节点: ${cursor}`);
      const kind = nodeKind(node);

      if (kind === 'approval') {
        const outcome = await runApprovalNode(store, record, node, root, ctx, owner);
        if (outcome.waiting) {
          record.status = 'waiting'; record.cursor = node.id; record.error = undefined;
          await atomic(store, async tx => { await tx.update('execution','flow_runs',record.id,{status:'waiting',cursor:node.id,steps:record.steps,lease_until:0}); });
          return record;
        }
        cursor = nextNodeId(graph, node.id, outcome.edge!, root);
        if (!cursor) throw new Error(`审批节点 ${node.id} 的 ${outcome.edge} 边没有去处`);
        record.cursor = cursor;
        // 终局轨迹必须当场落库：否则下一段 waiting 恢复时 live.steps 里没有它（审批轨迹丢失 bug）
        await atomic(store, async tx => { await checkLease(tx,record.id,owner); await tx.update('execution','flow_runs',record.id,{steps:record.steps,cursor:record.cursor,lease_until:Date.now()+300000}); });
        continue;
      }

      if (kind === 'gateway') {
        const trace: StepTrace = { step_id:node.id, name:node.name, capability:'gateway', strategy:'fixed', kind:'gateway', status:'ok', started_at:new Date().toISOString(), finished_at:new Date().toISOString(), output:{ value: at(root, node.switch!.path) } };
        record.steps = record.steps.filter(t => t.step_id !== node.id); record.steps.push(trace);
        root.steps[node.id] = trace.output;
        cursor = nextNodeId(graph, node.id, 'success', root);
        record.cursor = cursor || '';
        await atomic(store, async tx => { await checkLease(tx,record.id,owner); await tx.update('execution','flow_runs',record.id,{steps:record.steps,cursor:record.cursor,lease_until:Date.now()+300000}); });
        continue;
      }

      // capability / agent：与旧线性引擎同款执行语义（when 跳过 / 重试 / 效果分级 / 检查点）
      const trace: StepTrace = { step_id:node.id, name:node.name, capability:node.capability || '', strategy: kind === 'agent' ? 'agent' : 'fixed', kind, status:'ok', started_at:new Date().toISOString(), finished_at:'' };
      record.steps = record.steps.filter(t => t.step_id !== node.id);
      const skip = node.when && ((node.when.missing || []).some(p => at(root,p) != null) || (node.when.path && at(root,node.when.path) !== node.when.equals));
      const input = mapped(node.inputMap || '$input',root) as Record<string, unknown>;
      trace.input = input;
      try {
        if (skip) trace.status = 'skipped';
        else {
          if (kind === 'agent') {
            if (!ctx.selectTool) throw new Error('当前运行环境未配置 agent 选择器');
            const choice = await ctx.selectTool({candidates:node.candidateTools!,input});
            if (!node.candidateTools!.includes(choice.capability)) throw new Error('模型选择越过候选工具白名单');
            trace.capability = choice.capability; trace.candidates = node.candidateTools; trace.selection_reason = choice.reason;
          }
          const cap = getCapability(trace.capability);
          if ((cap.revision || 1) !== record.capability_revisions[trace.capability]) throw new Error('能力 revision 已变化，禁止按旧轨迹恢复新实现');
          if (!cap.effect || ['internal','orchestrate'].includes(cap.effect)) throw new Error('能力效果不允许进入流程');
          const call = async (tx: StateStore) => withActor(requireActor(ctx.actor), () => cap.run(input,{ ...ctx, store:tx }));
          if (['ingest','propose'].includes(cap.effect)) {
            await atomic(store, async tx => {
              await checkLease(tx,record.id,owner);
              trace.output = await call(tx);
              trace.finished_at = new Date().toISOString();
              await tx.update('execution','flow_runs',record.id,{steps:[...record.steps,trace],lease_until:Date.now()+300000});
            });
            record.steps.push(trace);
          } else {
            for (let attempt=0; ; attempt++) {
              trace.attempts=attempt+1;
              try { trace.output = await call(store); break; }
              catch(error) { if (attempt >= (node.retry || 0)) throw error; }
            }
          }
          root.steps[node.id] = trace.output;
          trace.attribution = String(trace.output?.attribution || trace.output?.tool_used || trace.capability);
          trace.output_keys = Object.keys(trace.output || {});
        }
      } catch(error) {
        delete trace.output;
        trace.error=(error as Error).message; trace.status=node.optional ? 'skipped' : 'failed';
        if (!node.optional) { record.steps.push(trace); throw error; }
      }
      trace.finished_at = trace.finished_at || new Date().toISOString();
      if (!record.steps.includes(trace)) record.steps.push(trace);
      cursor = trace.status === 'failed' ? null : nextNodeId(graph, node.id, 'success', root);
      record.cursor = cursor || '';
      await atomic(store, async tx => { await checkLease(tx,record.id,owner); await tx.update('execution','flow_runs',record.id,{steps:record.steps,cursor:record.cursor,lease_until:Date.now()+300000}); });
      if (trace.status === 'failed') throw new Error(trace.error || '节点执行失败');
    }
    record.result = mapped(record.template.resultMap || {steps:'$steps'},root);
    record.status='completed'; record.finished_at=new Date().toISOString(); record.cursor='';
    await atomic(store, async tx => { await checkLease(tx,record.id,owner); await tx.update('execution','flow_runs',record.id,{status:record.status,steps:record.steps,result:record.result,finished_at:record.finished_at,lease_until:0}); });
    return record;
  } catch(error) {
    record.status='failed'; record.error=(error as Error).message; record.finished_at=new Date().toISOString();
    await atomic(store, async tx => { await tx.update('execution','flow_runs',record.id,{status:'failed',steps:record.steps,error:record.error,lease_until:0,finished_at:record.finished_at}); });
    throw error;
  }
}

// 审批节点推进：已有 pending→等待（懒超时）；已决定→serial 下一 slot 或终局出边
async function runApprovalNode(store: StateStore, record: WorkflowRunRecord, node: WorkflowNodeDef, root: any, ctx: Context, owner: string)
  : Promise<{ waiting: true } | { waiting: false; edge: 'success' | 'rejected' | 'timeout' }> {
  const a = node.approval!;
  const mode = a.mode || 'serial';
  const tasks = (await store.query('execution', 'flow_approvals', { run_id: record.id, node_id: node.id })) as any[];
  const pending = tasks.filter(t => t.status === 'pending');
  if (pending.length && a.timeout_hours) {
    const deadline = Math.max(...pending.map(t => Date.parse(t.created_at) || 0)) + a.timeout_hours * 3600_000;
    if (Date.now() > deadline) {
      await atomic(store, async tx => {
        for (const t of pending) await tx.update('execution', 'flow_approvals', t.id, { status: 'timeout', decided_at: new Date().toISOString(), decided_by: 'system:timeout' });
      });
      pushApprovalTrace(record, node, mode, a.roles, 'timeout', 'system:timeout');
      return { waiting: false, edge: 'timeout' };
    }
  }
  if (pending.length) return { waiting: true };
  const approved = tasks.filter(t => t.status === 'approved');
  const rejected = tasks.find(t => t.status === 'rejected');
  if (rejected) {
    pushApprovalTrace(record, node, mode, a.roles, 'rejected', rejected.decided_by);
    return { waiting: false, edge: 'rejected' };
  }
  if (approved.length) {
    if (mode === 'serial') {
      const maxSlot = Math.max(...approved.map(t => Number(t.slot) || 0));
      if (maxSlot < a.roles.length - 1) {
        await createApprovalTasks(store, record, node, mode, a.roles, maxSlot + 1);
        return { waiting: true };
      }
    }
    pushApprovalTrace(record, node, mode, a.roles, 'approved', approved[approved.length - 1].decided_by);
    return { waiting: false, edge: 'success' };
  }
  // 首次进入：创建第一批任务
  await createApprovalTasks(store, record, node, mode, a.roles, 0);
  return { waiting: true };
}
async function createApprovalTasks(store: StateStore, record: WorkflowRunRecord, node: WorkflowNodeDef, mode: string, roles: string[], slot: number): Promise<void> {
  const note = node.inputMap ? JSON.stringify(mapped({ note: node.inputMap.note ?? '$input.summary' }, { input: record.input })) : record.input_summary;
  const now = new Date().toISOString();
  const targets = mode === 'serial' ? [{ role: roles[slot], slot }] : roles.map((role, i) => ({ role, slot: i }));
  await atomic(store, async tx => {
    for (const t of targets) await tx.insert('execution', 'flow_approvals', {
      id: `fa_${randomUUID()}`, run_id: record.id, flow_id: record.flow_id, node_id: node.id, node_name: node.name,
      mode, role: t.role, slot: t.slot, status: 'pending',
      note: typeof note === 'string' ? note.slice(0, 200) : record.input_summary,
      input_summary: record.input_summary, created_at: now,
    });
  });
}
function pushApprovalTrace(record: WorkflowRunRecord, node: WorkflowNodeDef, mode: string, roles: string[], decision: 'approved' | 'rejected' | 'timeout', decidedBy?: string): void {
  record.steps = record.steps.filter(t => t.step_id !== node.id);
  record.steps.push({
    step_id: node.id, name: node.name, capability: 'approval', strategy: 'fixed', kind: 'approval',
    status: 'ok', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    approval: { mode, roles, decision, decided_by: decidedBy },
    output: { decision },
  });
  record.steps[record.steps.length - 1].output_keys = ['decision'];
}
async function checkLease(store: StateStore,id:string,owner:string): Promise<void> {
  const [row] = await store.query('execution','flow_runs',{id});
  if (row?.lease_owner !== owner || row.lease_until < Date.now()) throw new Error('流程执行租约已失效');
}
export async function getWorkflowRun(store: StateStore,id: string): Promise<WorkflowRunRecord|null> { return (await store.query('execution','flow_runs',{id}))[0] || null; }
export async function listWorkflowRuns(store: StateStore,flowId?:string,limit=20): Promise<WorkflowRunRecord[]> {
  return store.query('execution','flow_runs',flowId ? {flow_id:flowId} : undefined,{sort:{key:'started_at',dir:'desc'},limit});
}
