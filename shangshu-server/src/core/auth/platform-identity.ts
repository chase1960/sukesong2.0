import type { Role } from './users.ts';

const aliases: Record<string, string> = {
  Administrator: 'admin', 'staff1@shangshu.local': 'staff',
  'manager1@shangshu.local': 'manager', 'finance1@shangshu.local': 'finance',
};

/**
 * 平台角色投影：Frappe 角色 + 能力 -> 平台角色标签。
 * 这是该映射的唯一实现，登录会话与账号清单共用，避免前端或路由各写一份而漂移。
 */
export function platformRoleOf(roles: string[] | undefined, capabilities: string[] | Record<string, unknown> | undefined): Role {
  const roleSet = new Set(roles || []);
  const caps = new Set(Array.isArray(capabilities) ? capabilities : Object.keys(capabilities || {}).filter((key) => (capabilities as Record<string, unknown>)[key]));
  if (roleSet.has('System Manager')) return 'admin';
  if (caps.has('finance_review') || caps.has('finance_payment')) return 'finance';
  if (caps.has('collaboration_manage')) return 'manager';
  return 'staff';
}

// 老服务滚动升级时保留投影；新服务返回持久 collaboration_key，不随用户名改名。
export function compatibilityFields(session: Record<string, any>) {
  const role = platformRoleOf(session.roles, session.capabilities);
  return {
    username: String(session.collaboration_key || aliases[session.user_name] || session.user_name || ''),
    display_name: String(session.display_name || session.user_name || ''), role,
  };
}

export class PlatformIdentityError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readPlatformIdentity(method: 'session' | 'people', cookie: string): Promise<any> {
  const upstream = process.env.FRAPPE_UPSTREAM;
  if (!upstream) throw new PlatformIdentityError(503, '平台身份服务不可用');
  let response: Response;
  try {
    response = await fetch(`${upstream.replace(/\/+$/, '')}/api/method/shangshu_core.public_api.http.${method}`, {
      headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new PlatformIdentityError(503, '平台身份服务暂时不可用，请重试'); }
  if (response.status === 401 || response.status === 403) throw new PlatformIdentityError(401, '登录已失效或账号已停用，请重新登录');
  if (!response.ok) throw new PlatformIdentityError(503, '平台身份服务暂时不可用，请重试');
  const body = await response.json().catch(() => null);
  if (!body || body.exc || body.exc_type || body.message == null) throw new PlatformIdentityError(503, '平台身份响应无效');
  if (method === 'session' && (!body.message.identity_id || !body.message.user_name || body.message.user_name === 'Guest')) {
    throw new PlatformIdentityError(401, '需要有效的平台员工身份');
  }
  if (method === 'session' && body.message.user_type && body.message.user_type !== 'System User') {
    throw new PlatformIdentityError(401, '协作功能需要员工身份');
  }
  if (method === 'people' && !Array.isArray(body.message)) throw new PlatformIdentityError(503, '平台人员目录暂时不可用');
  return body.message;
}
