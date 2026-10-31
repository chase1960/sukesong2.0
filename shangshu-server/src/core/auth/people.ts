import { AsyncLocalStorage } from 'node:async_hooks';
import type { StateStore } from '../types.ts';

export interface CollaborationPerson { username: string; display_name: string; identity_id?: string; role?: string; group?: string; scope?: string }
const directories = new AsyncLocalStorage<() => Promise<CollaborationPerson[]>>();

export function withPeopleDirectory<T>(read: () => Promise<CollaborationPerson[]>, fn: () => T): T {
  let pending: Promise<CollaborationPerson[]> | undefined;
  return directories.run(() => pending ||= read(), fn);
}

export async function collaborationPeople(store: StateStore): Promise<CollaborationPerson[]> {
  const directory = directories.getStore();
  if (directory) return directory();
  if (process.env.SHANGSHU_PLATFORM_MODE === 'frappe' || process.env.FRAPPE_UPSTREAM) {
    throw new Error('缺少已验证的平台人员上下文，禁止回退旧账号');
  }
  const users = await store.query('cognition', 'users', { status: '启用' });
  return users.map(user => ({ username: user.username, display_name: user.display_name || user.username, role: user.role, group: String(user.collaboration_group || '') || undefined }));
}
