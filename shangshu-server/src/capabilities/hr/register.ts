// HR 中台注册入口：REST + 对话工具 + 动作契约 + 幂等演示种子。
//
// 与招聘域一样是"演示赛道"的独立能力包：不侵入既有发票/文档链路，
// 只通过公共契约读取招聘域的只读能力，把自己的表放在 hr_* 前缀下。
import { registerRoute } from '../../core/registry.ts';
import { buildContext } from '../../core/context.ts';
import { hrRouter } from './router.ts';
import { seedHrDemo } from './seed.ts';
import { registerHrChatTools } from './chat.ts';
import type { ExternalServices } from '../../core/types.ts';
// 副作用注册：写动作契约必须先于 router/确认卡可用。
import './contracts.ts';

export function registerHr(external?: ExternalServices) {
  const createCtx = () => buildContext(() => {}, { external });
  registerRoute('/api/hr', hrRouter(createCtx));
  registerHrChatTools();

  const seedCtx = buildContext(console.log, { external });
  seedHrDemo(seedCtx).catch(e =>
    console.warn('[seed] HR 中台演示种子失败，跳过（不阻断启动）:', (e as Error).message),
  );
}
