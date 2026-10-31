// 用户体系（任务1 地基）：用户 CRUD + scrypt 密码哈希 + 首启 bootstrap。
// 数据走 StateStore（cognition.users），bitable 自动建表 / local 落 store.json，换底座不改代码。
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { StateStore } from '../types.ts';

export type Role = 'admin' | 'finance' | 'manager' | 'staff';
export const ROLES: Role[] = ['admin', 'finance', 'manager', 'staff'];
export const ROLE_NAMES: Record<Role, string> = { admin: '管理员', finance: '会计', manager: '项目负责人', staff: '员工' };

export interface User {
  id: string;
  username: string;
  role: Role;
  display_name: string;
  status: string;
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = scryptSync(pw, salt, 32);
    return timingSafeEqual(calc, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

export async function findUser(store: StateStore, username: string): Promise<(User & { password_hash: string }) | null> {
  const rows = await store.query('cognition', 'users', { username });
  const r = rows[0] as any;
  return r || null;
}

export async function listUsers(store: StateStore): Promise<User[]> {
  const rows = await store.query('cognition', 'users');
  return rows.map((r: any) => ({ id: r.id, username: r.username, role: r.role, display_name: r.display_name || r.username, status: r.status || '启用', collaboration_group: String(r.collaboration_group || '') }));
}

export const COLLABORATION_GROUPS = ['管理', '开发', '财务'] as const;

export async function createUser(store: StateStore, input: { username: string; password: string; role: Role; display_name?: string; collaboration_group?: string }): Promise<string> {
  if (!input.username || !input.password) throw new Error('用户名/密码不能为空');
  if (!ROLES.includes(input.role)) throw new Error(`非法角色：${input.role}`);
  const dup = await store.query('cognition', 'users', { username: input.username });
  if (dup.length) throw new Error(`用户名已存在：${input.username}`);
  // 与 updatePassword 同一策略：≥6 位（此前 create 漏校验，可建 1 位弱口令账号）。
  // 豁免 username==='admin'：首启 bootstrap 的 admin/admin 兜底账户（日志已提醒改密）。
  if (input.password.length < 6 && input.username !== 'admin') throw new Error('密码至少 6 位');
  return store.insert('cognition', 'users', {
    username: input.username,
    password_hash: hashPassword(input.password),
    role: input.role,
    display_name: input.display_name || input.username,
    status: '启用',
    collaboration_group: validateGroup(input.collaboration_group),
    created_at: new Date().toISOString(),
  });
}

// 协作分组：空=不收窄（全公司）；合法值固定，防止自由文本漂移
export function validateGroup(group: unknown): string {
  const value = String(group || '').trim();
  if (value && !(COLLABORATION_GROUPS as readonly string[]).includes(value)) throw new Error(`协作分组必须是：${COLLABORATION_GROUPS.join('、')}，或留空表示不收窄`);
  return value;
}

export async function setUserGroup(store: StateStore, id: string, group: unknown): Promise<void> {
  const value = validateGroup(group);
  const rows = await store.query('cognition', 'users', { id });
  if (!rows.length) throw new Error('用户不存在');
  await store.update('cognition', 'users', id, { collaboration_group: value });
}

// 首启 bootstrap：一个用户都没有时建默认 admin/admin（与旧单密码行为兼容），日志提醒改密。
export async function ensureBootstrap(store: StateStore): Promise<void> {
  const rows = await store.query('cognition', 'users');
  if (rows.length) return;
  await createUser(store, { username: 'admin', password: 'admin', role: 'admin', display_name: '管理员' });
  console.warn('[auth] 已创建默认账户 admin/admin —— 请尽快到用户管理修改密码');
}

// R0：改密（admin 代改/自改）——scrypt 哈希后写 users 表；不校验旧密码（管理员代改场景）
export async function updatePassword(store: StateStore, id: string, password: string): Promise<void> {
  if (!password || password.length < 6) throw new Error('密码至少 6 位');
  await store.update('cognition', 'users', id, { password_hash: hashPassword(password) });
}

// —— 账号管理（2026-08-27）：停用/启用、改角色、删除。护栏在路由层（不能操作自己、保底一个启用 admin）——
export async function setUserStatus(store: StateStore, id: string, status: '启用' | '停用'): Promise<void> {
  if (status !== '启用' && status !== '停用') throw new Error(`非法状态：${status}`);
  const rows = await store.query('cognition', 'users', { id });
  if (!rows.length) throw new Error('用户不存在');
  await store.update('cognition', 'users', id, { status });
}

export async function updateRole(store: StateStore, id: string, role: Role): Promise<void> {
  if (!ROLES.includes(role)) throw new Error(`非法角色：${role}`);
  const rows = await store.query('cognition', 'users', { id });
  if (!rows.length) throw new Error('用户不存在');
  await store.update('cognition', 'users', id, { role });
}

export async function deleteUser(store: StateStore, id: string): Promise<void> {
  const rows = await store.query('cognition', 'users', { id });
  if (!rows.length) throw new Error('用户不存在');
  await store.delete('cognition', 'users', id);
}

// 保底校验：操作后至少还有一个「启用」状态的 admin，否则整个系统失去管理员入口
export async function assertLastAdmin(store: StateStore, excludeId?: string): Promise<void> {
  const rows = await store.query('cognition', 'users');
  const enabledAdmins = rows.filter((u: any) => u.role === 'admin' && u.status !== '停用' && u.id !== excludeId);
  if (!enabledAdmins.length) throw new Error('至少保留一个启用状态的管理员账号');
}

