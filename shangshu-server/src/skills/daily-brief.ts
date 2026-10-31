// skill.daily-brief（A3 2026-08-10）：定时触发器执行 → 生成每日经营简报落库。
// 顺序 runner 执行（与 skill.invoice-collect 同一机制）；推送一期只落库，webhook 留配置位。
import { registerSkill } from '../core/runner.ts';
import { generateDailyBrief } from '../core/brief.ts';
import type { RunSummary } from '../core/runner.ts';

export function registerDailyBriefSkill() {
  registerSkill({
    id: 'skill.daily-brief',
    async run(ctx, _params): Promise<RunSummary> {
      const content = await generateDailyBrief(ctx.store, ctx.config);
      ctx.log(`📊 简报已生成（${content.split('\n')[0]}）`);
      return { collected: 0, added: 1, duplicate: 0, failed: 0 };
    },
  });
}
