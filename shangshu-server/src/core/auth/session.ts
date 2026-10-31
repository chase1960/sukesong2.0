// 会话：内存 token → 用户身份。单租户单进程（铁律5），7 天过期，重启失效重新登录。
import { randomUUID } from 'node:crypto';
import type { Role } from './users.ts';

export interface Session { token: string; username: string; role: Role; display_name: string; exp: number }

const TTL_MS = 7 * 24 * 3600 * 1000;
const sessions = new Map<string, Session>();

export function createSession(u: { username: string; role: Role; display_name: string }): Session {
  const s: Session = { token: randomUUID(), username: u.username, role: u.role, display_name: u.display_name, exp: Date.now() + TTL_MS };
  sessions.set(s.token, s);
  return s;
}

export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}
