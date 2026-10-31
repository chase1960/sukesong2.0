// 身份由通道认证后构造，绝不从模型参数/请求 body 读取角色。
import { AsyncLocalStorage } from 'node:async_hooks';
export interface ActorContext {
  id: string;
  role: 'admin' | 'finance' | 'manager' | 'staff' | 'service';
  kind: 'human' | 'service';
  channel: 'web' | 'chat' | 'flow' | 'trigger' | 'test';
}
const actors = new AsyncLocalStorage<ActorContext>();
export function currentActor(): ActorContext | undefined { return actors.getStore(); }
export function withActor<T>(actor: ActorContext, fn: () => T): T { return actors.run(Object.freeze({ ...actor }), fn); }
export function requireActor(actor = currentActor()): ActorContext {
  if (!actor?.id || !actor.role) throw new Error('缺少可信执行身份');
  return actor;
}
export function authorize(roles: readonly string[], actor = currentActor()): ActorContext {
  const who = requireActor(actor);
  if (who.role !== 'admin' && !roles.includes(who.role)) throw new Error(`无权限（需要 ${roles.join('/')}）`);
  return who;
}
