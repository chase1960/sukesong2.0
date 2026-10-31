// skill.alerts-check（A4 2026-08-10）：定时扫描应收逾期/库存预警 → 生成提醒。
import { registerSkill } from '../core/runner.ts';
import { scanAlerts } from '../core/alerts.ts';
import type { RunSummary } from '../core/runner.ts';

export function registerAlertsCheckSkill() {
  registerSkill({
    id: 'skill.alerts-check',
    async run(ctx, _params): Promise<RunSummary> {
      const { added } = await scanAlerts(ctx.store, ctx.config);
      ctx.log(added ? `⚠ 新增 ${added} 条提醒` : '✓ 无新增提醒');
      return { collected: 0, added, duplicate: 0, failed: 0 };
    },
  });
}
