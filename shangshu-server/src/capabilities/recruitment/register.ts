// 招聘演示域注册入口（纯 Node 演示赛道：runtime store + 事件审计 + AI 提案/人确认）。
// Frappe 轨道的完整实现见 frappe_apps/shangshu_recruitment（27 动作/13 DocType），保留为架构故事。
import { registerRoute } from '../../core/registry.ts';
import { buildContext } from '../../core/context.ts';
import { recruitmentRouter } from './router.ts';
import { seedRecruitmentDemo } from './seed.ts';
import type { ExternalServices } from '../../core/types.ts';
// 副作用注册：ActionContract（jd.publish / interview.schedule / skill.activate）依赖 chat.ts 确认卡执行。
import './contracts.ts';
// 聊天工具（HR 个人代理：jd/筛选/面试/偏好规则话术 → 走 ActionContract 确认卡）。chat.ts 由并行任务产出。
import { registerRecruitmentChatTools } from './chat.ts';

export function registerRecruitment(external?: ExternalServices) {
  const createCtx = () => buildContext(() => {}, { external });
  registerRoute('/api/recruitment', recruitmentRouter(createCtx));
  // 聊天工具自己构建上下文（无参注册），无需注入 createCtx。
  registerRecruitmentChatTools();

  // 启动种子：幂等，只补演示起点数据（source:'demo'），失败仅告警不阻断服务。
  const seedCtx = buildContext(console.log, { external });
  seedRecruitmentDemo(seedCtx).catch(e =>
    console.warn('[seed] 招聘演示种子失败，跳过（不阻断启动）:', (e as Error).message),
  );
}
