// 培养与能力：岗位能力模型 → 能力差距 → 90 天计划 → 学习行为 → 效果衡量。
//
// AI Native 的点不在"生成一份漂亮的学习计划"，而在于：
//   计划里的每个动作都指向一条可验证的能力差距，差距来自员工自己的事实证据；
//   学完之后用同一把尺子回测（能力等级变化 + 主管确认 + 知识产出），
//   没有效果的计划不会继续推荐给下一个人。
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, fromJson, readSkills, findEmployee, nowIso } from './tables.ts';

/** 培训效果按柯氏四级简化：反应 / 学习 / 行为 / 结果。 */
export const KIRKPATRICK = [
  { level: 1, name: '反应', desc: '学员反馈与完成度' },
  { level: 2, name: '学习', desc: '测评分数与认证' },
  { level: 3, name: '行为', desc: '回到岗位后的行为变化（主管确认）' },
  { level: 4, name: '结果', desc: '对业务指标的影响（项目交付、缺陷率等）' },
];

const HOURLY_COST = 220; // 内部人力综合成本（元/小时），用于培训与 AI 节省的同一把尺子

export function normalize(name: string): string {
  return String(name || '').toLowerCase().replace(/\s+/g, '').replace(/[()（）/·-]/g, '');
}

function skillLevel(employee: any, name: string): number {
  const target = normalize(name);
  const hit = readSkills(employee).find(s => normalize(s.name) === target || normalize(s.name).includes(target) || target.includes(normalize(s.name)));
  return hit ? Number(hit.level) || 0 : 0;
}

export function modelFor(store: StateStore, title: string): Promise<any | null> {
  return listAll(store, HR_TABLES.skillModels).then(models => {
    const target = normalize(title);
    const exact = models.find((m: any) => normalize(m.title) === target || normalize(m.job_family) === target);
    if (exact) return exact;
    const fuzzy = models.find((m: any) => target && (normalize(m.title).includes(target) || target.includes(normalize(m.title))));
    return fuzzy || models[0] || null;
  });
}

export interface Gap {
  skill: string;
  current: number;
  required: number;
  gap: number;
  weight: number;
  priority: number;
  evidence_hint: string;
}

export function skillGaps(employee: any, model: any): Gap[] {
  const requirements = fromJson<Array<{ name: string; required_level: number; weight?: number }>>(model?.skills, []);
  return requirements
    .map(req => {
      const current = skillLevel(employee, req.name);
      const required = Number(req.required_level) || 3;
      const gap = Math.max(0, required - current);
      const weight = Number(req.weight) || 1;
      return {
        skill: req.name, current, required, gap, weight,
        priority: Math.round(gap * weight * 100) / 100,
        evidence_hint: gap > 0 ? `补齐一条「${req.name}」的能力实证或项目记录` : '已达岗位基线',
      };
    })
    .filter(g => g.required > 0)
    .sort((a, b) => b.priority - a.priority || b.gap - a.gap);
}

interface PlanAction {
  id: string;
  phase: string;
  type: 'course' | 'project' | 'mentor' | 'reading' | 'knowledge';
  title: string;
  hours: number;
  due_days: number;
  gap_skill: string;
}

/** 90 天计划：按差距大小分配动作，先补基础、再上项目、最后沉淀为可复用经验。 */
export function proposePlan(employee: any, model: any, targetRole?: string): any {
  const gaps = skillGaps(employee, model).filter(g => g.gap > 0);
  const actions: PlanAction[] = [];
  let seq = 0;
  const add = (phase: string, type: PlanAction['type'], title: string, hours: number, dueDays: number, gapSkill: string) => {
    seq += 1;
    actions.push({ id: `A${String(seq).padStart(2, '0')}`, phase, type, title, hours, due_days: dueDays, gap_skill: gapSkill });
  };

  for (const gap of gaps.slice(0, 6)) {
    if (gap.gap >= 2) {
      add('0-30 天', 'course', `${gap.skill} 系统课（从 ${gap.current} 级到 ${gap.current + 1} 级）`, 10, 30, gap.skill);
      add('31-60 天', 'mentor', `${gap.skill} 导师带练（每周 1 次复盘）`, 8, 60, gap.skill);
      add('61-90 天', 'knowledge', `沉淀《${gap.skill} 实战要点》知识卡片`, 4, 90, gap.skill);
    } else {
      add('0-30 天', 'reading', `${gap.skill} 专题阅读 + 输出笔记`, 5, 30, gap.skill);
      add('31-60 天', 'project', `在真实项目中承担 ${gap.skill} 相关任务并留证`, 16, 60, gap.skill);
    }
  }

  // 每个计划都强制一个可验证产出，避免"学完了但没有证据"。
  if (!actions.some(a => a.type === 'knowledge')) {
    add('61-90 天', 'knowledge', '把本轮提升沉淀为一条可复用经验（含情境/行动/结果）', 4, 90, gaps[0]?.skill || '综合能力');
  }

  const hours = actions.reduce((sum, a) => sum + a.hours, 0);
  return {
    employee_id: String(employee.id),
    employee_name: employee.name,
    target_role: targetRole || model?.title || employee.title,
    model_id: model?.id || '',
    gaps,
    actions,
    phases: [
      { key: '0-30 天', goal: '补齐基础与认知', actions: actions.filter(a => a.phase === '0-30 天').length },
      { key: '31-60 天', goal: '真实项目实战', actions: actions.filter(a => a.phase === '31-60 天').length },
      { key: '61-90 天', goal: '产出可复用经验', actions: actions.filter(a => a.phase === '61-90 天').length },
    ],
    hours,
    cost_estimate: hours * HOURLY_COST,
    baseline_skills: readSkills(employee),
    summary: gaps.length
      ? `${employee.name} 距「${targetRole || model?.title}」有 ${gaps.length} 项能力差距，最大差距是 ${gaps[0].skill}（${gaps[0].current}→${gaps[0].required} 级）。计划 ${actions.length} 个动作、约 ${hours} 小时，预计 90 天完成。`
      : `${employee.name} 已达到「${targetRole || model?.title}」的能力基线，建议转向更高一级岗位模型或跨域轮岗。`,
    fallback: !model,
  };
}

export async function listPlans(store: StateStore): Promise<any[]> {
  const [plans, events, employees] = await Promise.all([
    listAll(store, HR_TABLES.plans),
    listAll(store, HR_TABLES.learningEvents),
    listAll(store, HR_TABLES.employees),
  ]);
  const empName = new Map(employees.map((e: any) => [String(e.id), e.name]));
  return plans
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((p: any) => {
      const actions = fromJson<any[]>(p.actions, []);
      const own = events.filter((e: any) => String(e.plan_id) === String(p.id));
      const done = new Set(own.map((e: any) => String(e.action_id)));
      const completion = actions.length ? Math.round((actions.filter(a => done.has(String(a.id))).length / actions.length) * 100) : 0;
      const hoursDone = own.reduce((s: number, e: any) => s + (Number(e.hours) || 0), 0);
      return {
        id: p.id, employee_id: p.employee_id, employee_name: empName.get(String(p.employee_id)) || '',
        target_role: p.target_role, status: p.status, created_at: p.created_at, started_at: p.started_at || '',
        gaps: fromJson<any[]>(p.gaps, []).slice(0, 6),
        actions: actions.map(a => ({ ...a, done: done.has(String(a.id)) })),
        hours_planned: Number(p.hours) || actions.reduce((s: number, a: any) => s + (Number(a.hours) || 0), 0),
        hours_done: hoursDone,
        completion,
        events: own.slice(-6).map((e: any) => ({ action_id: e.action_id, hours: e.hours, score: e.score, kirkpatrick: e.kirkpatrick_level, at: e.created_at })),
      };
    });
}

/** 培训效果：完成率、学时、柯氏分布、能力提升（与计划发布时的基线对比）。 */
export async function learningEffect(store: StateStore): Promise<any> {
  const [plans, events, employees] = await Promise.all([
    listAll(store, HR_TABLES.plans),
    listAll(store, HR_TABLES.learningEvents),
    listAll(store, HR_TABLES.employees),
  ]);
  const empById = new Map(employees.map((e: any) => [String(e.id), e]));
  const planViews = await listPlans(store);
  const active = planViews.filter((p: any) => p.status === 'active');
  const done = planViews.filter((p: any) => p.status === 'done');
  const totalActions = planViews.reduce((s: number, p: any) => s + p.actions.length, 0);
  const doneActions = planViews.reduce((s: number, p: any) => s + p.actions.filter((a: any) => a.done).length, 0);

  const kirk: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const e of events) if (e.kirkpatrick_level) kirk[String(e.kirkpatrick_level)] = (kirk[String(e.kirkpatrick_level)] || 0) + 1;

  // 能力提升：把计划发布时的 baseline_skills 与当前技能对比，gap 缩小的项数。
  const uplift: any[] = [];
  for (const p of plans) {
    const employee = empById.get(String(p.employee_id));
    if (!employee) continue;
    const baseline = fromJson<any[]>(p.baseline_skills, []);
    const before = new Map(baseline.map((s: any) => [normalize(s.name), Number(s.level) || 0]));
    for (const s of readSkills(employee)) {
      const old = before.get(normalize(s.name));
      if (old !== undefined && s.level > old) {
        uplift.push({ employee: employee.name, skill: s.name, before: old, after: s.level });
      }
    }
  }

  const hoursTotal = events.reduce((s: number, e: any) => s + (Number(e.hours) || 0), 0);
  const applied = events.filter((e: any) => e.applied === true || e.applied === 'true').length;
  return {
    plans_total: planViews.length,
    plans_active: active.length,
    plans_done: done.length,
    completion_rate: totalActions ? Math.round((doneActions / totalActions) * 100) : 0,
    hours_total: hoursTotal,
    cost_total: hoursTotal * HOURLY_COST,
    kirkpatrick: KIRKPATRICK.map(k => ({ ...k, count: kirk[String(k.level)] || 0 })),
    behavior_rate: events.length ? Math.round((applied / events.length) * 100) : 0,
    uplift_count: uplift.length,
    uplift: uplift.slice(0, 8),
    roi_note: hoursTotal
      ? `投入约 ${hoursTotal} 小时（¥${(hoursTotal * HOURLY_COST).toLocaleString('zh-CN')}），当前可验证的能力提升 ${uplift.length} 项；建议把未产生行为改变（柯氏 3 级）的课程下架。`
      : '尚无学习行为数据，先让一批计划跑起来再谈 ROI。',
    fallback: false,
  };
}
