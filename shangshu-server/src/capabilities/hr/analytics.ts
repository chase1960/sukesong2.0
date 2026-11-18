// 中台驾驶舱：一个接口给出「人、能力、招聘、培养、知识、分身、人机协同」的全景。
//
// 为什么必须新增这个可视化模块：
//   前面的数据资产、数字分身、培养、知识、招聘效能各自都能用，但管理者看不到它们之间的因果。
//   驾驶舱不做"炫酷图表"，只回答四个问题：
//     1) 我们的员工数据资产厚不厚，哪里薄？
//     2) 能力缺口在哪，内部能不能补，补不了才外部招？
//     3) 招聘的钱花得值不值，单位成本与质量是否在改善？
//     4) AI 在哪些环节被允许自己做，哪些环节必须人介入，审计是否闭合？
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, tenureMonths, fromJson, readSkills } from './tables.ts';
import { assetLedger, profileCompleteness } from './assets.ts';
import { twinMetrics } from './twin.ts';
import { learningEffect, modelFor, skillGaps } from './learning.ts';
import { knowledgeHealth } from './knowledge.ts';
import { efficiencyView } from './efficiency.ts';
import { autonomyMatrix } from './autonomy.ts';
import { listPendingConfirmations } from '../../core/confirm.ts';

export async function dashboard(store: StateStore): Promise<any> {
  const [ledger, twins, learning, knowledge, efficiency, autonomy, employees, units, pending] = await Promise.all([
    assetLedger(store),
    twinMetrics(store),
    learningEffect(store),
    knowledgeHealth(store),
    efficiencyView(store),
    autonomyMatrix(store),
    listAll(store, HR_TABLES.employees),
    listAll(store, HR_TABLES.orgUnits),
    listPendingConfirmations(store),
  ]);

  const active = employees.filter((e: any) => (e.status || 'active') === 'active');
  const tenure = [
    { bucket: '<1 年', count: 0 },
    { bucket: '1-3 年', count: 0 },
    { bucket: '3-5 年', count: 0 },
    { bucket: '5 年以上', count: 0 },
  ];
  for (const e of active) {
    const months = tenureMonths(e.join_date);
    if (months < 12) tenure[0].count += 1;
    else if (months < 36) tenure[1].count += 1;
    else if (months < 60) tenure[2].count += 1;
    else tenure[3].count += 1;
  }

  const levels = [...new Map(active.map((e: any) => [String(e.level || '未定级'), 0])).keys()]
    .map(level => ({ level, count: active.filter((e: any) => String(e.level || '未定级') === level).length }))
    .sort((a, b) => b.count - a.count);

  const org = {
    units: units.map((u: any) => ({
      dept: u.dept, budget: Number(u.headcount_budget) || 0, onboard: Number(u.onboard) || 0,
      open: Math.max(0, (Number(u.headcount_budget) || 0) - (Number(u.onboard) || 0)),
      usage: Number(u.headcount_budget) ? Math.round(((Number(u.onboard) || 0) / Number(u.headcount_budget)) * 100) : 0,
      cost_budget: Number(u.cost_budget) || 0,
    })),
    budget_total: units.reduce((s: number, u: any) => s + (Number(u.headcount_budget) || 0), 0),
    onboard_total: units.reduce((s: number, u: any) => s + (Number(u.onboard) || 0), 0),
  };

  // 能力缺口聚合：把每个人的岗位模型差距压成"企业最缺哪几项能力"。
  const gapAgg = new Map<string, { skill: string; people: number; total_gap: number; required: number }>();
  for (const e of active) {
    const model = await modelFor(store, e.title || '');
    if (!model) continue;
    for (const gap of skillGaps(e, model)) {
      if (gap.gap <= 0) continue;
      const cur = gapAgg.get(gap.skill) || { skill: gap.skill, people: 0, total_gap: 0, required: gap.required };
      cur.people += 1;
      cur.total_gap += gap.gap;
      cur.required = Math.max(cur.required, gap.required);
      gapAgg.set(gap.skill, cur);
    }
  }
  const topGaps = [...gapAgg.values()]
    .map(g => ({ ...g, avg_gap: Math.round((g.total_gap / g.people) * 10) / 10 }))
    .sort((a, b) => b.people - a.people || b.avg_gap - a.avg_gap)
    .slice(0, 8);

  const pendingHr = pending.filter(p => String(p.capability || '').startsWith('hr.'));

  const headline = [
    { key: 'headcount', label: '在职人数', value: ledger.headcount, unit: '人', hint: `编制 ${org.budget_total} 人 · 缺口 ${Math.max(0, org.budget_total - ledger.headcount)}`, tone: 'blue' },
    { key: 'assets', label: '员工数据资产覆盖度', value: ledger.avg_completeness, unit: '分', hint: `事实 ${ledger.facts_total} 条 · 已核实 ${ledger.facts_verified}`, tone: ledger.avg_completeness >= 70 ? 'green' : 'amber' },
    { key: 'cph', label: '单人招聘成本', value: efficiency.totals.ai_adjusted_cost_per_hire, unit: '元', hint: `AI 抵扣 ¥${efficiency.totals.ai_value_saved} · 质量率 ${efficiency.totals.quality_rate}%`, tone: 'amber' },
    { key: 'ai', label: 'AI 独立处理', value: autonomy.usage.L1 + autonomy.usage.L2 + autonomy.usage.L0, unit: '次', hint: `L1/L2 决策 ${autonomy.usage.L1 + autonomy.usage.L2} 次 · 待确认 ${pendingHr.length}`, tone: 'blue' },
    { key: 'twin', label: '数字分身可用率', value: twins.answer_rate, unit: '%', hint: `${twins.twins_active} 个在授权 · 拒答 ${twins.refused} 次`, tone: twins.answer_rate >= 70 ? 'green' : 'amber' },
    { key: 'knowledge', label: '知识采纳率', value: knowledge.adoption_rate, unit: '%', hint: `${knowledge.published} 条已发布 · 复用 ${knowledge.usage_total} 次`, tone: knowledge.adoption_rate >= 50 ? 'green' : 'amber' },
  ];

  const risks: Array<{ level: string; title: string; detail: string; action: string }> = [];
  if (ledger.risks.thin_profile_count > 0) {
    risks.push({ level: 'medium', title: `${ledger.risks.thin_profile_count} 人数据覆盖度低于 60 分`, detail: '画像薄 → 能力差距算不准 → 培养与内部匹配都失真', action: '先补 3 条事实与 3 项能力标签' });
  }
  if (ledger.risks.stale_facts > 0) {
    risks.push({ level: 'medium', title: `${ledger.risks.stale_facts} 条证据超过 18 个月未更新`, detail: '过期证据会让分身说出"过去正确、现在过时"的答案', action: '按部门发起一次证据刷新' });
  }
  if (ledger.risks.missing_manager.length) {
    risks.push({ level: 'low', title: `${ledger.risks.missing_manager.length} 人未填直属上级`, detail: '审批链会断，L2/L3 确认找不到人', action: '补齐汇报线' });
  }
  if (twins.refused > 0) {
    risks.push({ level: 'low', title: `分身拒答 ${twins.refused} 次`, detail: `拒答集中在「${twins.refusal_topics[0]?.topic || '敏感主题'}」，说明边界生效`, action: '无需处理，保持拒答' });
  }
  if (autonomy.usage.L4 > 0) {
    risks.push({ level: 'low', title: `${autonomy.usage.L4} 次人主办决策`, detail: '薪酬/录用/离职等高危动作仍在人工轨道，符合设计', action: '抽查台账确保留痕完整' });
  }
  if (efficiency.totals.cost_per_hire > 0 && efficiency.totals.quality_rate < 70) {
    risks.push({ level: 'high', title: `招聘质量率仅 ${efficiency.totals.quality_rate}%`, detail: '低价渠道可能把成本转移到试用期流失', action: '按渠道看 quality_rate，先砍低质量渠道' });
  }

  return {
    generated_at: new Date().toISOString(),
    headline,
    workforce: {
      headcount: ledger.headcount,
      by_dept: ledger.depts,
      tenure,
      levels,
      org,
      fact_kinds: ledger.fact_kinds,
      grade_distribution: ledger.grade_distribution,
    },
    assets: {
      avg_completeness: ledger.avg_completeness,
      facts_total: ledger.facts_total,
      facts_per_employee: ledger.facts_per_employee,
      thin_profiles: ledger.thin_profiles,
      skills: ledger.skills,
      twins_active: twins.twins_active,
      knowledge_published: knowledge.published,
      plans_active: learning.plans_active,
    },
    recruitment: {
      funnel: efficiency.funnel,
      stages: efficiency.stages,
      totals: efficiency.totals,
      quality: efficiency.quality,
      channels: efficiency.channels,
      recommendations: efficiency.recommendations,
      snapshot_at: efficiency.snapshot?.at || '',
      snapshot_truncated: !!efficiency.snapshot?.truncated,
    },
    capability: {
      top_gaps: topGaps,
      skill_people: ledger.skills,
    },
    learning: {
      plans_active: learning.plans_active,
      completion_rate: learning.completion_rate,
      hours_total: learning.hours_total,
      cost_total: learning.cost_total,
      behavior_rate: learning.behavior_rate,
      uplift_count: learning.uplift_count,
      kirkpatrick: learning.kirkpatrick,
      roi_note: learning.roi_note,
    },
    knowledge: {
      published: knowledge.published,
      drafts: knowledge.drafts,
      usage_total: knowledge.usage_total,
      adoption_rate: knowledge.adoption_rate,
      top: knowledge.top,
      dormant: knowledge.dormant,
      suggestions: knowledge.suggestions,
    },
    autonomy: {
      levels: autonomy.levels,
      rows: autonomy.rows,
      usage: autonomy.usage,
      decisions_total: autonomy.decisions_total,
      recent: autonomy.recent_decisions,
      pending: pendingHr.slice(0, 10).map((p: any) => ({
        id: p.id, capability: p.capability, entity_id: p.entity_id,
        created_at: p.created_at, payload: fromJson(p.payload, {}),
      })),
    },
    twins: {
      total: twins.twins_total, active: twins.twins_active, ready: twins.twins_ready,
      answer_rate: twins.answer_rate, answered: twins.answered, refused: twins.refused,
      insufficient: twins.insufficient, refusal_topics: twins.refusal_topics,
      coverage_gap: twins.coverage_gap, avg_citations: twins.avg_citations,
      hours_saved: twins.hours_saved,
    },
    risks,
  };
}

/** 员工 360：给详情页与"给 AI 看的一页纸"共用。 */
export async function employeeSnapshot(store: StateStore, employee: any): Promise<any> {
  const facts = await listAll(store, HR_TABLES.facts, { employee_id: String(employee.id) });
  const plans = await listAll(store, HR_TABLES.plans, { employee_id: String(employee.id) });
  const knowledge = await listAll(store, HR_TABLES.knowledge, { source_employee_id: String(employee.id) });
  const model = await modelFor(store, employee.title || '');
  const completeness = profileCompleteness(employee, facts, {
    knowledgeCount: knowledge.filter((k: any) => k.status === 'published').length,
    hasActivePlan: plans.some((p: any) => p.status === 'active'),
  });
  return {
    employee: {
      id: employee.id, name: employee.name, emp_no: employee.emp_no, dept: employee.dept,
      title: employee.title, level: employee.level, manager: employee.manager,
      join_date: employee.join_date, status: employee.status || 'active', education: employee.education || '',
    },
    completeness,
    skills: readSkills(employee),
    gaps: model ? skillGaps(employee, model) : [],
    model: model ? { id: model.id, title: model.title, job_family: model.job_family } : null,
    facts: facts.map((f: any) => ({ id: f.id, kind: f.kind, title: f.title, summary: f.summary, status: f.status, occurred_at: f.occurred_at, tags: fromJson<string[]>(f.tags, []), evidence_strength: Number(f.evidence_strength) || 1 })),
    plans: plans.map((p: any) => ({ id: p.id, target_role: p.target_role, status: p.status, gaps: fromJson<any[]>(p.gaps, []), actions: fromJson<any[]>(p.actions, []), hours: Number(p.hours) || 0 })),
    knowledge: knowledge.map((k: any) => ({ id: k.id, title: k.title, status: k.status, reuse_count: Number(k.reuse_count) || 0 })),
  };
}
