// 能力 / 触发器 / 路由 注册表（开发约定 §5.6、§9、§13）。
// 定制层/通用层都只能通过 register* 接入；内核不认具体能力。
import type { Capability, Trigger, WidgetDescriptor } from './types.ts';
import type { Router } from 'express';
import { authorize, currentActor, withActor, requireActor } from './actor.ts';
import { validateSchema, assertSchema } from './action-contracts.ts';
import { atomic } from './storage/transaction.ts';
import { readonlyStore } from './storage/readonly.ts';

const capabilities = new Map<string, Capability>();
const triggers = new Map<string, Trigger>();

export function registerCapability<I, O>(cap: Capability<I, O>): void {
  const previous = capabilities.get(cap.id);
  if (previous && previous.run !== cap.run && (cap.revision || 1) <= (previous.revision || 1)) throw new Error(`能力重复注册: ${cap.id}（修改实现必须使用更高的 revision）`);
  if (cap.inputSchema) assertSchema(cap.inputSchema);
  if (cap.outputSchema) assertSchema(cap.outputSchema);
  capabilities.set(cap.id, {revision:1,...cap} as Capability);
}

export function getCapability(id: string): Capability {
  const c = capabilities.get(id);
  if (!c) throw new Error(`能力未注册: ${id}`);
  return { ...c, async run(input, ctx) {
    authorize(c.roles || ['admin'], ctx.actor || currentActor());
    if (c.inputSchema) validateSchema(c.inputSchema,input);
    const call = async (store: typeof ctx.store) => {
      const scopedStore=c.effect==='read' || c.effect==='extract' ? readonlyStore(store) : store;
      const result = await withActor(requireActor(ctx.actor || currentActor()), () => c.run(input,{...ctx,store:scopedStore}));
      if (c.outputSchema) validateSchema(c.outputSchema,result);
      return result;
    };
    return c.effect === 'ingest' || c.effect === 'propose' ? atomic(ctx.store,call) : call(ctx.store);
  } };
}

export function listCapabilities(): Array<{
  id: string; name: string; impl: 'ai' | 'script' | 'external'; effect: string;
  revision: number; roles: string[]; inputSchema?: Record<string, any>; outputSchema?: Record<string, any>;
}> {
  return [...capabilities.values()].map(({ id, name, impl, effect, revision, roles, inputSchema, outputSchema }) => ({
    id, name, impl, effect: effect || 'internal', revision: revision || 1, roles: roles || ['admin'], inputSchema, outputSchema,
  }));
}

export function registerTrigger(t: Trigger): void {
  triggers.set(t.id, { ...t });
}

export function getTrigger(id: string): Trigger | undefined {
  return triggers.get(id) ? { ...triggers.get(id)! } : undefined;
}

export function listTriggers(): Trigger[] {
  return [...triggers.values()].map((t) => ({ ...t }));
}

export function updateTrigger(id: string, patch: Partial<Trigger>): Trigger {
  const t = triggers.get(id);
  if (!t) throw new Error(`触发器不存在: ${id}`);
  // cron / enabled / params / name 可改；id/skill 不改
  Object.assign(t, {
    schedule: patch.schedule ?? t.schedule,
    enabled: patch.enabled ?? t.enabled,
    params: patch.params ?? t.params,
    name: patch.name ?? t.name,
    description: patch.description ?? t.description,
  });
  return { ...t };
}

export function setTriggerRuntime(id: string, patch: Partial<Pick<Trigger, 'last_run_at' | 'next_run_at'>>): void {
  const t = triggers.get(id);
  if (t) Object.assign(t, patch);
}

// —— 通用层演进：路由 + Dashboard widget 注册（2026-07-23 官网接入 spec §3.1）——
const routes: Array<{ path: string; router: Router }> = [];
const widgets = new Map<string, WidgetDescriptor>();

export function registerRoute(path: string, router: Router): void {
  routes.push({ path, router });
}
export function listRoutes(): Array<{ path: string; router: Router }> {
  return [...routes];
}
export function registerDashboardWidget(w: WidgetDescriptor): void {
  if (widgets.has(w.id)) console.warn(`[registry] widget 已存在，覆盖: ${w.id}`);
  widgets.set(w.id, { ...w });
}
export function listDashboardWidgets(): WidgetDescriptor[] {
  return [...widgets.values()].map(w => ({ ...w })).sort((a, b) => a.order - b.order);
}
