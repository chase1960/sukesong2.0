// 员工数据资产层：档案 + 原子事实 + 覆盖度 + 企业资产台账。
//
// 这里的口径决定后面所有 AI 结论的可信度：
//   - 「事实」才是有证据的一句话（项目、绩效、培训、反馈），不是 AI 的推测；
//   - 「覆盖度」衡量一个员工在企业里到底沉淀了多少可用数据，缺什么直接给补齐提示；
//   - 「资产台账」是企业视角：谁有档案没证据、哪些证据过期、哪个部门最薄。
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, fromJson, readSkills, isStale, tenureMonths } from './tables.ts';

export interface CompletenessItem {
  key: string;
  label: string;
  points: number;
  max: number;
  hint: string;
}

export interface Completeness {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  items: CompletenessItem[];
  hints: string[];
}

const FACT_KINDS = ['project', 'performance', 'training', 'feedback', 'award', 'skill_demo', 'knowledge'] as const;

export function factKindLabel(kind: string): string {
  const map: Record<string, string> = {
    project: '项目经历', performance: '绩效结果', training: '学习记录',
    feedback: '协作反馈', award: '荣誉奖励', skill_demo: '能力实证', knowledge: '经验贡献',
  };
  return map[String(kind)] || String(kind || '其他');
}

/** 覆盖度：分项给分 + 明确「还缺什么」，不做没有依据的整体印象分。 */
export function profileCompleteness(
  employee: any,
  facts: any[],
  extra: { knowledgeCount?: number; hasActivePlan?: boolean } = {},
): Completeness {
  const skills = readSkills(employee);
  const verified = facts.filter(f => f.status === 'verified');
  const projectFacts = verified.filter(f => f.kind === 'project' || f.kind === 'performance');
  const learningFacts = verified.filter(f => f.kind === 'training');
  const items: CompletenessItem[] = [];

  const baseOk = ['name', 'dept', 'title', 'level', 'manager', 'join_date'].filter(k => String(employee?.[k] || '').trim()).length;
  items.push({
    key: 'base', label: '基本信息', max: 15,
    points: Math.round((baseOk / 6) * 15),
    hint: baseOk === 6 ? '基本信息完整' : '补齐姓名/部门/岗位/职级/上级/入职日期',
  });

  const eduOk = String(employee?.education || '').trim() ? 1 : 0;
  items.push({
    key: 'edu', label: '教育与发展背景', max: 5, points: eduOk * 5,
    hint: eduOk ? '已登记教育背景' : '补齐教育背景（用于岗位能力建模）',
  });

  const skillPoints = skills.length >= 3 ? 20 : skills.length === 2 ? 14 : skills.length === 1 ? 8 : 0;
  items.push({
    key: 'skills', label: '能力标签', max: 20, points: skillPoints,
    hint: skills.length >= 3 ? `已登记 ${skills.length} 项能力` : '至少登记 3 项能力及熟练度（1-5 级）',
  });

  const factPoints = verified.length >= 5 ? 25 : verified.length >= 3 ? 18 : verified.length >= 1 ? 10 : 0;
  items.push({
    key: 'facts', label: '事实证据', max: 25, points: factPoints,
    hint: verified.length >= 5 ? `已核实 ${verified.length} 条事实` : '核实事实证据（项目/绩效/培训/反馈）至少 5 条',
  });

  const pfPoints = projectFacts.length >= 2 ? 15 : projectFacts.length === 1 ? 8 : 0;
  items.push({
    key: 'project', label: '项目与绩效', max: 15, points: pfPoints,
    hint: projectFacts.length >= 2 ? '项目与绩效证据充分' : '补充 2 条项目或绩效事实（含结果量化）',
  });

  const learnPoints = learningFacts.length >= 1 || extra.hasActivePlan ? 10 : 0;
  items.push({
    key: 'learning', label: '学习与成长', max: 10, points: learnPoints,
    hint: learnPoints ? '有学习记录或进行中的培养计划' : '登记学习记录，或生成一份 90 天培养计划',
  });

  const knowPoints = (extra.knowledgeCount || 0) > 0 ? 10 : 0;
  items.push({
    key: 'knowledge', label: '经验贡献', max: 10, points: knowPoints,
    hint: knowPoints ? '已贡献可复用经验' : '把一条项目经验沉淀为知识卡片',
  });

  const score = Math.max(0, Math.min(100, items.reduce((sum, i) => sum + i.points, 0)));
  const grade: Completeness['grade'] = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  return { score, grade, items, hints: items.filter(i => i.points < i.max).map(i => i.hint) };
}

/** 员工视角聚合：档案 + 事实 + 覆盖度，供前端详情与对话查询共用同一口径。 */
export async function employeeView(store: StateStore, employee: any): Promise<any> {
  const employeeId = String(employee.id);
  const [facts, knowledge, plans, twins] = await Promise.all([
    listAll(store, HR_TABLES.facts, { employee_id: employeeId }),
    listAll(store, HR_TABLES.knowledge, { source_employee_id: employeeId }),
    listAll(store, HR_TABLES.plans, { employee_id: employeeId }),
    listAll(store, HR_TABLES.twins, { employee_id: employeeId }),
  ]);
  const publishedKnowledge = knowledge.filter((k: any) => k.status === 'published');
  const completeness = profileCompleteness(employee, facts, {
    knowledgeCount: publishedKnowledge.length,
    hasActivePlan: plans.some((p: any) => p.status === 'active'),
  });
  return {
    id: employee.id,
    emp_no: employee.emp_no,
    name: employee.name,
    dept: employee.dept,
    title: employee.title,
    level: employee.level,
    manager: employee.manager,
    join_date: employee.join_date,
    status: employee.status || 'active',
    location: employee.location || '',
    education: employee.education || '',
    tenure_months: tenureMonths(employee.join_date),
    skills: readSkills(employee),
    completeness,
    facts: facts
      .sort((a: any, b: any) => String(b.occurred_at || b.created_at).localeCompare(String(a.occurred_at || a.created_at)))
      .map((f: any) => ({
        id: f.id, kind: f.kind, kind_label: factKindLabel(f.kind), title: f.title, summary: f.summary,
        occurred_at: f.occurred_at || '', tags: fromJson<string[]>(f.tags, []),
        evidence_strength: Number(f.evidence_strength) || 1, status: f.status || 'draft',
        verified_by: f.verified_by || '', stale: isStale(f.occurred_at || f.created_at),
      })),
    knowledge: publishedKnowledge.map((k: any) => ({ id: k.id, title: k.title, reuse_count: Number(k.reuse_count) || 0 })),
    plans: plans.map((p: any) => ({ id: p.id, target_role: p.target_role, status: p.status, created_at: p.created_at })),
    twin: twins.length ? {
      id: twins[0].id, status: twins[0].status, level: twins[0].level,
      scope: fromJson(twins[0].scope, {}), expires_at: twins[0].expires_at || '',
      interaction_count: Number(twins[0].interaction_count) || 0,
    } : null,
  };
}

/** 企业资产台账：中台「我到底沉淀了什么」的唯一答案。 */
export async function assetLedger(store: StateStore): Promise<any> {
  const [employees, facts, knowledge, plans, twins] = await Promise.all([
    listAll(store, HR_TABLES.employees),
    listAll(store, HR_TABLES.facts),
    listAll(store, HR_TABLES.knowledge),
    listAll(store, HR_TABLES.plans),
    listAll(store, HR_TABLES.twins),
  ]);
  const active = employees.filter((e: any) => (e.status || 'active') === 'active');

  const factsByEmp = new Map<string, any[]>();
  for (const f of facts) {
    const key = String(f.employee_id || '');
    if (!factsByEmp.has(key)) factsByEmp.set(key, []);
    factsByEmp.get(key)!.push(f);
  }
  const knowledgeByEmp = new Map<string, number>();
  for (const k of knowledge) {
    if (k.status !== 'published') continue;
    const key = String(k.source_employee_id || '');
    knowledgeByEmp.set(key, (knowledgeByEmp.get(key) || 0) + 1);
  }
  const activePlanEmp = new Set(plans.filter((p: any) => p.status === 'active').map((p: any) => String(p.employee_id)));

  const rows = active.map((e: any) => {
    const own = factsByEmp.get(String(e.id)) || [];
    const completeness = profileCompleteness(e, own, {
      knowledgeCount: knowledgeByEmp.get(String(e.id)) || 0,
      hasActivePlan: activePlanEmp.has(String(e.id)),
    });
    return { employee: e, facts: own, completeness };
  });

  const byDept = new Map<string, { dept: string; headcount: number; facts: number; completeness: number; low: number }>();
  for (const r of rows) {
    const dept = String(r.employee.dept || '未分组');
    if (!byDept.has(dept)) byDept.set(dept, { dept, headcount: 0, facts: 0, completeness: 0, low: 0 });
    const bucket = byDept.get(dept)!;
    bucket.headcount += 1;
    bucket.facts += r.facts.length;
    bucket.completeness += r.completeness.score;
    if (r.completeness.score < 60) bucket.low += 1;
  }
  const depts = [...byDept.values()]
    .map(d => ({ ...d, avg_completeness: d.headcount ? Math.round(d.completeness / d.headcount) : 0 }))
    .sort((a, b) => b.headcount - a.headcount);

  const skillCount = new Map<string, { name: string; people: number; avg_level: number }>();
  for (const e of active) {
    for (const s of readSkills(e)) {
      if (!skillCount.has(s.name)) skillCount.set(s.name, { name: s.name, people: 0, avg_level: 0 });
      const bucket = skillCount.get(s.name)!;
      bucket.people += 1;
      bucket.avg_level += s.level;
    }
  }
  const skills = [...skillCount.values()]
    .map(s => ({ ...s, avg_level: s.people ? Math.round((s.avg_level / s.people) * 10) / 10 : 0 }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 12);

  const staleFacts = facts.filter((f: any) => f.status === 'verified' && isStale(f.occurred_at || f.created_at));
  const orphan = rows.filter(r => r.facts.filter((f: any) => f.status === 'verified').length === 0).map(r => r.employee.name);
  const missingManager = active.filter((e: any) => !String(e.manager || '').trim()).map((e: any) => e.name);

  return {
    headcount: active.length,
    employees_total: employees.length,
    facts_total: facts.length,
    facts_verified: facts.filter((f: any) => f.status === 'verified').length,
    facts_per_employee: active.length ? Math.round((facts.length / active.length) * 10) / 10 : 0,
    avg_completeness: rows.length ? Math.round(rows.reduce((s, r) => s + r.completeness.score, 0) / rows.length) : 0,
    grade_distribution: {
      A: rows.filter(r => r.completeness.grade === 'A').length,
      B: rows.filter(r => r.completeness.grade === 'B').length,
      C: rows.filter(r => r.completeness.grade === 'C').length,
      D: rows.filter(r => r.completeness.grade === 'D').length,
    },
    depts,
    skills,
    twins_active: twins.filter((t: any) => t.status === 'active').length,
    knowledge_published: knowledge.filter((k: any) => k.status === 'published').length,
    plans_active: plans.filter((p: any) => p.status === 'active').length,
    risks: {
      stale_facts: staleFacts.length,
      orphan_employees: orphan.slice(0, 10),
      missing_manager: missingManager.slice(0, 10),
      thin_profile_count: rows.filter(r => r.completeness.score < 60).length,
    },
    fact_kinds: FACT_KINDS.map(kind => ({
      kind, label: factKindLabel(kind), count: facts.filter((f: any) => f.kind === kind).length,
    })),
    thin_profiles: rows
      .filter(r => r.completeness.score < 70)
      .sort((a, b) => a.completeness.score - b.completeness.score)
      .slice(0, 10)
      .map(r => ({
        id: r.employee.id, name: r.employee.name, dept: r.employee.dept,
        score: r.completeness.score, hints: r.completeness.hints.slice(0, 3),
      })),
  };
}
