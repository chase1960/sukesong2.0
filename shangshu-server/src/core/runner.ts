// Skill = 一段确定性流程，内部按顺序调能力。runner 负责建 ctx、记 JobRun、兜底异常。
// 这是「顺序 runner」；未来 LLM 决策的 harness loop 替换它，skill/能力不动（spec §5.5）。
import { buildContext } from './context.ts';
import { getTrigger, setTriggerRuntime } from './registry.ts';
import type { Context, ExternalServices } from './types.ts';

export interface Skill {
  id: string;
  run: (ctx: Context, params: Record<string, any>) => Promise<RunSummary>;
}
export interface RunSummary {
  collected: number; added: number; duplicate: number; failed: number;
}

const skills = new Map<string, Skill>();
export function registerSkill(s: Skill) { skills.set(s.id, s); }
export function getSkill(id: string): Skill {
  const s = skills.get(id);
  if (!s) throw new Error(`skill 未注册: ${id}`);
  return s;
}

// —— JobRun 存储（内存 + 持久化）——
import { randomUUID } from 'node:crypto';
import { getRuntimeStore } from './store.ts';
import { withActor } from './actor.ts';
import type { JobRun } from './types.ts';
const activeRuns = new Map<string, JobRun>();

export async function listJobRuns(triggerId?: string, limit = 50): Promise<JobRun[]> {
  return getRuntimeStore().query('execution','job_runs',triggerId?{trigger_id:triggerId}:undefined,{sort:{key:'started_at',dir:'desc'},limit});
}

let counter = 0;
function newRunId(): string {
  return randomUUID();
}

export async function runTrigger(triggerId: string, external?: ExternalServices): Promise<JobRun> {
  const trigger = getTrigger(triggerId);
  if (!trigger) throw new Error(`触发器不存在: ${triggerId}`);

  const log: string[] = [];
  const run: JobRun = {
    id: newRunId(), trigger_id: triggerId,
    started_at: new Date().toISOString(), finished_at: null,
    status: 'running', collected: 0, added: 0, duplicate: 0, failed: 0, log,
  };
  activeRuns.set(run.id, run);
  const store=getRuntimeStore();
  await store.insert('execution','job_runs',run);
  const startedAtIso = run.started_at;
  setTriggerRuntime(triggerId, { last_run_at: startedAtIso });

  try {
    const ctx = buildContext((m) => { log.push(`${new Date().toISOString()}  ${m}`); }, { external });
    ctx.actor = { id: 'trigger:' + triggerId, role: 'service', kind: 'service', channel: 'trigger' };
    log.push(`▶ 触发器「${trigger.name}」开始执行 skill ${trigger.skill}`);
    const summary = await withActor(ctx.actor,()=>getSkill(trigger.skill).run(ctx, trigger.params));
    run.collected = summary.collected; run.added = summary.added;
    run.duplicate = summary.duplicate; run.failed = summary.failed;
    run.status = 'done';
    log.push(`✔ 完成：收 ${summary.collected} · 新增 ${summary.added} · 重复 ${summary.duplicate} · 失败 ${summary.failed}`);
  } catch (e) {
    run.status = 'failed';
    log.push(`✘ 失败：${(e as Error).message}`);
    console.error(`[runner] trigger ${triggerId} 失败:`, e);
  } finally {
    run.finished_at = new Date().toISOString();
    activeRuns.delete(run.id);
    await store.update('execution','job_runs',run.id,run);
  }
  return run;
}
