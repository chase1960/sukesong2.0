// 一次性脚本：恢复演示用 draft 偏好规则（镜像 seed.ts 4c，不删任何数据）。
// 用法：cd shangshu-server && npx tsx scripts/restore-demo-draft.ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { loadConfig } = await import('../src/config.ts').catch(() => ({ loadConfig: null }));
// 直接复用 server 的运行时组装（与 main.ts 相同入口），避免重复拼 store 路径。
const server = await import('../src/adapters/web/server.ts').catch(async () => {
  // server.ts 可能只导出工厂；退路：直接开 SQLite store
  return null;
});

// 简单可靠路径：直接用 SQLite store（与 src/adapters/web/server.ts 一致的底层）。
const { openStore } = await import('../src/adapters/web/store.ts').catch(async () => {
  const m = await import('../src/core/store.ts');
  return m;
});

const store = await openStore(`${process.cwd()}/data/state.sqlite`);

const now = new Date().toISOString();
// seed 4b 中的两条 reject episodes（陈默涵 / 林小倩）
const eps = await store.query('business', 'recruitment_episodes');
const rejects = eps.filter(e =>
  e.kind === 'screening_decision' && e.ai_recommend === 'advance' && e.human_decision === 'reject');
if (rejects.length < 2) {
  console.error('reject episodes 不足 2 条，无法恢复演示草稿；现有:', rejects.length);
  process.exit(1);
}
const exists = (await store.query('business', 'recruitment_skills'))
  .filter(s => s.status === 'draft');
if (exists.length) {
  console.log('已有 draft，跳过：', exists.map(s => s.id).join(','));
  process.exit(0);
}

const { appendEvent } = await import('../src/core/events.ts');
const skillId = await store.insert('business', 'recruitment_skills', {
  rule_type: 'screening_preference',
  pattern: JSON.stringify({ min_experience_years: 5 }),
  description: `HR 连续 ${rejects.length} 次否决 AI 推进的经验 ≤5 年候选人（被拒者：${rejects.map(e => JSON.parse(e.candidate || '{}').name).join('、')}），建议低于 5 年谨慎推进`,
  evidence_ids: JSON.stringify(rejects.map(e => e.id)),
  status: 'draft',
  owner: 'system', activated_by: '', activated_at: '',
  source: 'demo', review_note: '演示数据',
  created_at: now, updated_at: now,
});
await appendEvent(store, {
  capability: 'recruitment.skill.propose', entity_type: 'recruitment.skill', entity_id: skillId,
  payload: { rule_type: 'screening_preference', min_experience_years: 5, status: 'draft', source: 'demo' },
  initiator: 'trigger', status: 'confirmed', reviewer: 'admin',
});
console.log('draft 恢复完成:', skillId);
process.exit(0);
