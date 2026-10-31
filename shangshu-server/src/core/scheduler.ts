// 定时触发：node-cron（进程内，跨平台，Windows 可用）。trigger 的 cron/enabled 在配置页改后调 rescheduleAll。
import cron from 'node-cron';
import { listTriggers, updateTrigger } from './registry.ts';
import { runTrigger } from './runner.ts';
import type { ExternalServices } from './types.ts';

const tasks = new Map<string, cron.ScheduledTask>();

let externalServices: ExternalServices | undefined;

export function setExternalServices(external: ExternalServices): void {
  externalServices = external;
}

export function rescheduleAll(): void {
  // 撤销全部
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  // 按 registry 当前状态重新武装
  for (const trigger of listTriggers()) {
    if (!trigger.enabled) continue;
    if (!cron.validate(trigger.schedule)) {
      console.warn(`[scheduler] cron 非法，跳过 ${trigger.id}: ${trigger.schedule}`);
      continue;
    }
    const task = cron.schedule(trigger.schedule, () => {
      runTrigger(trigger.id, externalServices).catch((e) => console.error(`[scheduler] ${trigger.id} 运行异常:`, e));
    });
    tasks.set(trigger.id, task);
  }
}

// 配置页改了 cron/enabled 后调
export function applyTriggerPatch(triggerId: string, patch: { schedule?: string; enabled?: boolean; params?: any }): void {
  updateTrigger(triggerId, patch);
  rescheduleAll();
}
