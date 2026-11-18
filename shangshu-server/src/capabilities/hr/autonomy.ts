// 人机介入分级引擎：什么时候 AI 自己做、什么时候必须人确认、什么时候只能人主办。
//
// 为什么要一个"引擎"而不是一张说明表：
//   同一个动作在不同情境下风险不同。给张三登记一条项目事实，和给全公司批量改职级，
//   不是同一件事。分级必须由「动作 × 风险 × 可逆性 × 影响面 × 置信度 × 敏感数据」
//   当场算出来，并留下可解释的理由与台账，否则事后无法复盘"AI 为什么被允许这么做"。
//
// 分级（L0-L4，与 Cloud Security Alliance 的自主等级同构，落到 HR 语境）：
//   L0 观察：只读、只出看板，AI 不产生任何动作
//   L1 建议：AI 出建议/草稿，人自己执行
//   L2 单步确认：AI 准备一条写入，人点一次确认
//   L3 计划确认：AI 准备多步或批量方案，人确认整包
//   L4 人主办：AI 只整理材料，判断与执行由人完成
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, nowIso, fromJson } from './tables.ts';

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type RiskLevel = 'low' | 'medium' | 'high';
export type BlastRadius = 'self' | 'team' | 'company';

export const LEVELS: Array<{ level: AutonomyLevel; name: string; desc: string; tone: string }> = [
  { level: 'L0', name: '观察', desc: '只读与看板。AI 可以算、可以展示，不产生任何业务动作。', tone: 'gray' },
  { level: 'L1', name: '建议', desc: 'AI 产出建议与草稿，由人自己决定是否采纳、自己做执行。', tone: 'blue' },
  { level: 'L2', name: '单步确认', desc: 'AI 准备一条写入，人在确认卡上核对后点一次确认，事务内落库并留审计。', tone: 'green' },
  { level: 'L3', name: '计划确认', desc: 'AI 准备多步或批量方案（培养计划、预算调整），人确认整包后按计划执行。', tone: 'amber' },
  { level: 'L4', name: '人主办', desc: 'AI 只做材料整理与检索，判断、沟通与执行必须由人完成。', tone: 'red' },
];

export const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const LEVEL_BY_RANK: AutonomyLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface AutonomyRule {
  action_key: string;
  name: string;
  default_level: AutonomyLevel;
  risk: RiskLevel;
  reversible: boolean;
  blast_radius: BlastRadius;
  sensitivity: string[];
  why: string;
  escalate: string;
}

/** 默认矩阵：每一项都写清"为什么是这个级别"和"什么情况下升级"。 */
export const DEFAULT_RULES: AutonomyRule[] = [
  { action_key: 'hr.analytics.view', name: '中台看板与指标', default_level: 'L0', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: [], why: '只读聚合，不写业务事实', escalate: '导出含个人敏感字段时升级到 L4 授权' },
  { action_key: 'hr.asset.ledger', name: '员工资产台账', default_level: 'L0', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: [], why: '只读资产覆盖度与缺口', escalate: '按人下钻到薪酬结构时升级' },
  { action_key: 'hr.twin.answer', name: '数字分身代答', default_level: 'L1', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: ['personal'], why: '限定在本人授权范围内，输出带证据引用', escalate: '越出授权主题或涉及他人评价时直接 L4 拒答' },
  { action_key: 'hr.knowledge.recommend', name: '知识推荐', default_level: 'L1', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: [], why: '只做检索与排序，不改知识内容', escalate: '推荐结果被用作处分依据时升级' },
  { action_key: 'hr.recruit.recommend', name: '招聘降本建议', default_level: 'L1', risk: 'low', reversible: true, blast_radius: 'team', sensitivity: [], why: '给建议与测算，不动预算', escalate: '采纳并改预算时升 L3' },
  { action_key: 'hr.learning.gap.propose', name: '能力差距与培养计划草稿', default_level: 'L1', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: ['performance'], why: '基于能力模型算差距，草稿可改', escalate: '计划与晋升/调薪挂钩时升 L4' },
  { action_key: 'hr.employee.save', name: '员工建档与字段更新', default_level: 'L2', risk: 'medium', reversible: true, blast_radius: 'self', sensitivity: ['personal'], why: '影响一个人的人事事实，需人核对', escalate: '改职级/汇报线/成本中心时升 L3' },
  { action_key: 'hr.fact.record', name: '登记员工事实', default_level: 'L2', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: ['performance'], why: '事实会进入画像与 AI 结论，必须人确认后才算数', escalate: '批量导入或跨部门写入时升 L3' },
  { action_key: 'hr.fact.verify', name: '核实员工事实', default_level: 'L2', risk: 'medium', reversible: true, blast_radius: 'self', sensitivity: ['performance'], why: '核实等于给证据背书，需责任人签字', escalate: '涉及争议事实时升 L4' },
  { action_key: 'hr.learning.event', name: '记录学习完成', default_level: 'L2', risk: 'low', reversible: true, blast_radius: 'self', sensitivity: [], why: '学习记录进入培养效果评估', escalate: '与认证/资格挂钩时升 L3' },
  { action_key: 'hr.knowledge.publish', name: '发布知识卡片', default_level: 'L2', risk: 'low', reversible: true, blast_radius: 'team', sensitivity: [], why: '影响团队做法，但有版本可回滚', escalate: '涉及客户信息或对外口径时升 L3' },
  { action_key: 'hr.interview.schedule', name: '安排面试', default_level: 'L2', risk: 'low', reversible: true, blast_radius: 'team', sensitivity: [], why: '占用面试官时间，需确认时间与轮次', escalate: '自动改面试结论时升 L4' },
  { action_key: 'hr.learning.plan.publish', name: '发布培养计划', default_level: 'L3', risk: 'medium', reversible: true, blast_radius: 'team', sensitivity: ['performance'], why: '跨 90 天多步动作，承诺资源与时间', escalate: '计划含晋升承诺时升 L4' },
  { action_key: 'hr.recruit.budget.shift', name: '招聘渠道预算调整', default_level: 'L3', risk: 'medium', reversible: true, blast_radius: 'company', sensitivity: [], why: '直接花钱且影响公司整体获客', escalate: '单次调整超过月预算 30% 时升 L4' },
  { action_key: 'hr.recruit.batch.screen', name: '批量筛选与批量淘汰', default_level: 'L3', risk: 'high', reversible: false, blast_radius: 'company', sensitivity: ['personal'], why: '一次影响多名候选人，且淘汰不可完全撤回', escalate: '命中受保护属性或批量>20 人时升 L4' },
  { action_key: 'hr.twin.authorize', name: '数字分身授权', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'self', sensitivity: ['personal'], why: '个人数据边界的让渡，必须本人知情同意', escalate: '授权范围含跨部门可见时需 HR 负责人共同签' },
  { action_key: 'hr.offer.approve', name: '录用与 Offer 决定', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'team', sensitivity: ['salary'], why: '涉及薪酬承诺与法律效力', escalate: '超带宽 Offer 需加一级审批' },
  { action_key: 'hr.comp.change', name: '调薪与奖金分配', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'team', sensitivity: ['salary'], why: '直接改变个人收入与团队公平', escalate: '一律人主办，AI 只做测算与材料' },
  { action_key: 'hr.performance.rating', name: '绩效评级', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'team', sensitivity: ['performance'], why: '评级影响晋升、调薪与去留', escalate: 'AI 不得给出评级结论，仅整理证据' },
  { action_key: 'hr.exit.process', name: '离职与解除处理', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'self', sensitivity: ['personal'], why: '法律与情绪风险都高', escalate: '一律人主办' },
  { action_key: 'hr.discipline', name: '纪律与投诉调查', default_level: 'L4', risk: 'high', reversible: false, blast_radius: 'team', sensitivity: ['personal'], why: '涉及事实认定与程序正义', escalate: '一律人主办' },
];

const RULE_BY_KEY = new Map(DEFAULT_RULES.map(r => [r.action_key, r]));

export function ruleFor(actionKey: string): AutonomyRule | null {
  return RULE_BY_KEY.get(actionKey) || null;
}

export interface DecideInput {
  action_key: string;
  risk?: RiskLevel;
  reversible?: boolean;
  blast_radius?: BlastRadius;
  confidence?: number;
  sensitivity?: string[];
  note?: string;
}

export interface AutonomyDecision {
  action_key: string;
  action_name: string;
  level: AutonomyLevel;
  base_level: AutonomyLevel;
  score: number;
  reasons: string[];
  approver: string;
  sla: string;
  guards: string[];
  policy_override: AutonomyLevel | null;
}

const SENSITIVE_HARD = new Set(['salary', 'performance', 'legal', 'health', 'personal']);

function approverFor(level: AutonomyLevel): string {
  if (level === 'L0') return '无需审批（只读）';
  if (level === 'L1') return '业务本人';
  if (level === 'L2') return '直属上级 / HR';
  if (level === 'L3') return '部门负责人 + HR';
  return 'HR 负责人 / 员工本人 / 委员会';
}

function slaFor(level: AutonomyLevel): string {
  if (level === 'L0' || level === 'L1') return '无审批时限';
  if (level === 'L2') return '4 小时内确认';
  if (level === 'L3') return '1 个工作日内确认';
  return '3 个工作日内给出结论';
}

function floorOf(r: AutonomyLevel, min: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[r] >= LEVEL_RANK[min] ? r : min;
}

/**
 * 核心判定。policyOverride 只能"抬高门槛"，不能把 L4 拉回自动化——
 * 这是分级引擎最重要的一条护栏：越权配置不会因为一张表就生效。
 */
export function decide(input: DecideInput, policyOverride?: AutonomyLevel | null): AutonomyDecision {
  const rule = ruleFor(input.action_key);
  const risk = input.risk || rule?.risk || 'medium';
  const reversible = input.reversible ?? rule?.reversible ?? true;
  const blast = input.blast_radius || rule?.blast_radius || 'team';
  const sensitivity = input.sensitivity || rule?.sensitivity || [];
  const confidence = input.confidence === undefined ? 0.8 : Math.max(0, Math.min(1, input.confidence));
  const baseLevel = rule?.default_level || 'L2';
  const reasons: string[] = [`基线：${rule ? rule.name : '未登记动作'}默认 ${baseLevel} 级`];
  const guards: string[] = [];

  let level = baseLevel;
  if (rule) guards.push(rule.escalate);

  if (policyOverride && LEVEL_RANK[policyOverride] > LEVEL_RANK[baseLevel]) {
    level = policyOverride;
    reasons.push(`策略覆盖：${input.action_key} 由管理员上调至 ${policyOverride}`);
  } else if (policyOverride && LEVEL_RANK[policyOverride] < LEVEL_RANK[baseLevel]) {
    reasons.push(`策略试图下调至 ${policyOverride}，但默认基线不允许下调（单人可改配置不等于可降低门槛）`);
  }

  if (sensitivity.some(s => SENSITIVE_HARD.has(s))) {
    const hard = sensitivity.includes('salary') || sensitivity.includes('legal') || sensitivity.includes('health');
    const min: AutonomyLevel = hard ? 'L4' : 'L3';
    if (LEVEL_RANK[level] < LEVEL_RANK[min]) {
      level = min;
      reasons.push(`命中敏感数据（${sensitivity.join('/')}），强制抬到 ${min}`);
    }
  } else if (sensitivity.length) {
    reasons.push(`涉及个人数据（${sensitivity.join('/')}），按敏感数据口径保守处理`);
  }

  if (risk === 'high') {
    level = floorOf(level, 'L3');
    reasons.push('高风险动作：至少 L3（计划确认）');
  } else if (risk === 'medium') {
    level = floorOf(level, 'L2');
    reasons.push('中风险动作：至少 L2（单步确认）');
  }

  if (!reversible) {
    level = floorOf(level, 'L3');
    reasons.push('不可逆动作：至少 L3');
  }

  if (blast === 'company') {
    level = floorOf(level, 'L3');
    reasons.push('影响面为公司级：至少 L3');
  } else if (blast === 'team') {
    level = floorOf(level, 'L2');
    reasons.push('影响面为团队级：至少 L2');
  }

  if (confidence < 0.6 && level !== 'L4') {
    level = LEVEL_BY_RANK[Math.min(4, LEVEL_RANK[level] + 1)];
    reasons.push(`AI 置信度 ${Math.round(confidence * 100)}% < 60%，上调一级`);
  } else if (confidence < 0.75 && LEVEL_RANK[level] === 1) {
    level = 'L2';
    reasons.push(`AI 置信度 ${Math.round(confidence * 100)}%，建议降级为单步确认`);
  } else if (confidence >= 0.9) {
    reasons.push(`AI 置信度 ${Math.round(confidence * 100)}%，未触发上调`);
  }

  // 最终硬护栏：薪酬/法律/健康 + 不可逆 + 公司级，无论配置如何都只能人主办。
  if ((sensitivity.includes('salary') || sensitivity.includes('legal') || sensitivity.includes('health'))
    && !reversible && blast === 'company') {
    level = 'L4';
    reasons.push('复合风险（敏感 + 不可逆 + 公司级）：锁定 L4');
  }
  if (baseLevel === 'L4' && level !== 'L4') {
    level = 'L4';
    reasons.push('默认 L4 的动作不允许被情境参数下调');
  }

  const score = Math.max(0, Math.min(100, 100 - LEVEL_RANK[level] * 18 - (confidence < 0.6 ? 10 : 0)));

  return {
    action_key: input.action_key,
    action_name: rule?.name || '未登记动作',
    level,
    base_level: baseLevel,
    score,
    reasons,
    approver: approverFor(level),
    sla: slaFor(level),
    guards,
    policy_override: policyOverride || null,
  };
}

/** 分级矩阵：默认规则 + 管理员覆盖 + 真实使用统计。 */
export async function autonomyMatrix(store: StateStore): Promise<any> {
  const [policies, decisions] = await Promise.all([
    listAll(store, HR_TABLES.autonomyPolicies),
    listAll(store, HR_TABLES.autonomyDecisions),
  ]);
  const policyByKey = new Map(policies.map((p: any) => [String(p.action_key), p]));
  const rows = DEFAULT_RULES.map(rule => {
    const policy = policyByKey.get(rule.action_key);
    const own = decisions.filter((d: any) => d.action_key === rule.action_key);
    const last = own[own.length - 1];
    return {
      ...rule,
      policy_level: policy ? String(policy.level) : '',
      policy_reason: policy ? String(policy.reason || '') : '',
      effective_level: policy && LEVEL_RANK[String(policy.level) as AutonomyLevel] > LEVEL_RANK[rule.default_level]
        ? String(policy.level) : rule.default_level,
      usage: own.length,
      last_level: last ? String(last.level) : '',
      last_at: last ? String(last.created_at) : '',
    };
  });
  const usageByLevel: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const d of decisions) usageByLevel[String(d.level)] = (usageByLevel[String(d.level)] || 0) + 1;
  return {
    levels: LEVELS,
    rows,
    usage: usageByLevel,
    decisions_total: decisions.length,
    recent_decisions: decisions
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 15)
      .map((d: any) => ({
        id: d.id, action_key: d.action_key, action_name: d.action_name || '',
        level: d.level, reasons: fromJson<string[]>(d.reasons, []), actor: d.actor, created_at: d.created_at,
        subject: d.subject || '',
      })),
  };
}

export async function recordDecision(
  store: StateStore,
  decision: AutonomyDecision,
  actor: string,
  subject = '',
): Promise<string> {
  return store.insert('business', HR_TABLES.autonomyDecisions, {
    action_key: decision.action_key,
    action_name: decision.action_name,
    level: decision.level,
    base_level: decision.base_level,
    reasons: toJsonLocal(decision.reasons),
    approver: decision.approver,
    subject,
    actor,
    created_at: nowIso(),
  });
}

function toJsonLocal(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return 'null'; }
}

/** 覆盖配置的合法性：只有管理员能改，且只能"抬"不能"降"。 */
export async function canOverride(
  store: StateStore,
  actionKey: string,
  level: AutonomyLevel,
  actorRole: string,
): Promise<{ ok: boolean; reason: string }> {
  const rule = ruleFor(actionKey);
  if (!rule) return { ok: false, reason: '只能为已登记动作设置介入等级' };
  if (actorRole !== 'admin') return { ok: false, reason: '介入等级只能由系统管理员调整' };
  if (LEVEL_RANK[level] < LEVEL_RANK[rule.default_level]) {
    return { ok: false, reason: `不能把「${rule.name}」从 ${rule.default_level} 下调到 ${level}；自动化门槛只能收紧` };
  }
  if (rule.default_level === 'L4') return { ok: false, reason: 'L4 动作不接受任何自动化配置' };
  return { ok: true, reason: '' };
}
