// 权限守卫：从 cookie 解析 session，按角色拦路由。
import type express from 'express';
import { getSession, destroySession, type Session } from './session.ts';
import { findUser, ROLES, type Role } from './users.ts';
import { getRuntimeStore } from '../store.ts';
import { withActor } from '../actor.ts';
import { compatibilityFields, PlatformIdentityError, readPlatformIdentity } from './platform-identity.ts';
import { withPeopleDirectory } from './people.ts';

const verifiedRequests = new WeakSet<express.Request>();

export function parseCookies(h?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const pair of h.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function currentUser(req: express.Request): Session | null {
  return getSession(parseCookies(req.headers.cookie).shangshu_token);
}

/** 要求登录（任意角色） */
export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const user = currentUser(req);
  if (!user) { res.status(401).json({ error: '未登录' }); return; }
  // 同一个请求只核验一次；下一次请求必须重查，不能用旧 token 延续已撤销权限。
  if (process.env.SHANGSHU_PLATFORM_MODE === 'frappe' || process.env.FRAPPE_UPSTREAM) {
    try {
      if (!verifiedRequests.has(req)) {
        const live = compatibilityFields(await readPlatformIdentity('session', req.headers.cookie || ''));
        if (live.username !== user.username) throw new PlatformIdentityError(401, '平台身份已变化，请重新登录');
        Object.assign(user, live);
        verifiedRequests.add(req);
      }
      withPeopleDirectory(() => readPlatformIdentity('people', req.headers.cookie || ''), () =>
        withActor({ id: user.username, role: user.role, kind: 'human', channel: 'web' }, next));
    } catch (error) {
      const status = error instanceof PlatformIdentityError ? error.status : 503;
      if (status === 401) destroySession(user.token);
      res.status(status).json({ error: error instanceof Error ? error.message : '平台身份服务不可用' });
    }
    return;
  }
  try {
    const live = await findUser(getRuntimeStore(),user.username);
    if (!live || live.status !== '启用' || !ROLES.includes(live.role)) {
      destroySession(user.token); res.status(401).json({error:'账号已停用或不存在，请重新登录'}); return;
    }
    user.role=live.role; user.display_name=live.display_name;
    withActor({ id: user.username, role: user.role, kind: 'human', channel: 'web' }, next);
  } catch (error) { next(error); }
}

/** 要求角色（含 admin 放行一切：管理员默认拥有所有权限） */
export function requireRole(...roles: Role[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => requireAuth(req,res,() => {
    const u = currentUser(req);
    if (!u) { res.status(401).json({ error: '未登录' }); return; }
    if (u.role !== 'admin' && !roles.includes(u.role)) {
      res.status(403).json({ error: `无权限（需要 ${roles.join('/')}）` });
      return;
    }
    withActor({ id: u.username, role: u.role, kind: 'human', channel: 'web' }, next);
  });
}
