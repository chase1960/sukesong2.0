// 操作审计（P1 事件化）：审计 = 写事件流（capability=原 action，status=confirmed）。
// operation_logs 表保留旧数据，不再新增写入；返回原签名，调用方零改动。
// 失败只告警不阻断主流程（审计不该把业务搞挂）。
import type { StateStore } from '../types.ts';
import type { Session } from './session.ts';
import { appendEvent } from '../events.ts';

export async function audit(store: StateStore, user: Session | null, action: string, target: string, detail = ''): Promise<void> {
  try {
    await appendEvent(store, {
      capability: action,
      entity_type: 'audit',
      entity_id: target,
      payload: { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) },
      initiator: user?.username || '(匿名)',
      status: 'confirmed',
    });
  } catch (e) {
    console.warn('[audit] 写入失败:', (e as Error).message);
  }
}
