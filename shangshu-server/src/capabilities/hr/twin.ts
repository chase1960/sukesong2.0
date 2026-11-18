// 员工数字分身：本人授权 + 有证据的回答 + 明确边界 + 全程留痕。
//
// 设计取舍（写清楚，免得后面被当成"更聪明的聊天机器人"）：
//   1. 分身不是「把员工私聊记录喂给模型」——那是隐私事故，不是数字资产；
//   2. 分身的输出必须可溯源：每个结论后面挂事实 id，没有证据就说"暂无沉淀"；
//   3. 敏感主题一律拒答并转本人：薪酬、绩效评级、他人评价、离职意向、健康/婚育、法律医疗；
//   4. 回答用确定性检索 + 模板拼装，不用自由生成——宁可笨一点，也不让分身替员工说没说过的话。
// 模型只允许用于「把已检索到的事实说人话」，且失败即回落模板，不新增事实。
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, getById, findEmployee, fromJson, readSkills, isStale } from './tables.ts';
import { profileCompleteness } from './assets.ts';

export interface TwinScope {
  topics: string[];
  denied: string[];
  data_policy: { salary: boolean; performance: string; others_evaluation: boolean; personal: boolean };
}

export const DEFAULT_SCOPE: TwinScope = {
  topics: ['岗位职责', '项目经历', '技能与专长', '协作方式', '可提供的帮助', '成长与学习'],
  denied: ['薪酬与奖金', '绩效评级细节', '他人评价', '离职或求职意向', '健康与婚育', '法律与医疗建议', '公司未公开信息'],
  data_policy: { salary: false, performance: 'summary_only', others_evaluation: false, personal: false },
};

// 敏感词按主题分组：命中即拒答，不试图"委婉回答"。
const SENSITIVE_RULES: Array<{ topic: string; words: string[] }> = [
  { topic: '薪酬与奖金', words: ['薪酬', '工资', '薪资', '月薪', '年薪', '奖金', '期权', '股票', '调薪', '涨薪', 'package'] },
  { topic: '绩效评级细节', words: ['绩效', '评级', '打分', '末位', 'pip', '考核结果', '361'] },
  { topic: '他人评价', words: ['他怎么样', '她怎么样', '评价一下', '能力如何', '人品', '好不好用', '靠不靠谱'] },
  { topic: '离职或求职意向', words: ['离职', '跳槽', '辞职', '找工作', '简历', '面试其他公司', '意向'] },
  { topic: '健康与婚育', words: ['健康', '病历', '生病', '怀孕', '婚育', '生育', '年龄', '籍贯', '身份证', '家庭'] },
  { topic: '法律与医疗建议', words: ['仲裁', '诉讼', '打官司', '违法', '诊断', '用药', '治疗'] },
  { topic: '公司未公开信息', words: ['融资', '并购', '裁员', '未公开', '机密', '战略'] },
];

export interface TwinAnswer {
  ok: boolean;
  employee: { id: string; name: string; dept: string; title: string };
  twin_id: string;
  question: string;
  answer: string;
  refused: boolean;
  refused_reason: string;
  refused_topic: string;
  insufficient: boolean;
  citations: Array<{ kind: string; id: string; title: string; score: number }>;
  boundaries: string[];
  confidence: number;
  route: 'twin' | 'human';
  level: 'L1' | 'L4';
}

/** 授权是否仍然有效：状态、期限、范围三者缺一不可。 */
export function twinAuthorization(twin: any): { valid: boolean; reason: string } {
  if (!twin) return { valid: false, reason: '尚未授权数字分身' };
  if (twin.status !== 'active') return { valid: false, reason: `分身状态为 ${twin.status}` };
  if (twin.expires_at && Date.parse(String(twin.expires_at)) < Date.now()) {
    return { valid: false, reason: `授权已于 ${String(twin.expires_at).slice(0, 10)} 到期，需本人重新授权` };
  }
  const scope = fromJson<TwinScope>(twin.scope, DEFAULT_SCOPE);
  if (!scope.topics || !scope.topics.length) return { valid: false, reason: '授权范围为空' };
  return { valid: true, reason: '' };
}

/** 分身可用性：数据够不够、授权在不在、边界清不清。 */
export function twinReadiness(
  employee: any,
  twin: any,
  facts: any[],
  knowledge: any[],
): { ready: boolean; score: number; blockers: string[]; checks: Array<{ key: string; label: string; ok: boolean; detail: string }> } {
  const completeness = profileCompleteness(employee, facts, { knowledgeCount: knowledge.filter(k => k.status === 'published').length });
  const verified = facts.filter(f => f.status === 'verified');
  const auth = twinAuthorization(twin);
  const checks = [
    { key: 'auth', label: '本人授权有效', ok: auth.valid, detail: auth.valid ? '授权在有效期内' : auth.reason },
    { key: 'data', label: '数据覆盖度 ≥ 60', ok: completeness.score >= 60, detail: `当前 ${completeness.score} 分（${completeness.grade} 级）` },
    { key: 'evidence', label: '已核实事实 ≥ 3 条', ok: verified.length >= 3, detail: `当前 ${verified.length} 条` },
    {
      key: 'boundary', label: '边界与数据策略已声明',
      ok: !!(twin && fromJson<TwinScope>(twin.scope, DEFAULT_SCOPE).denied?.length),
      detail: twin ? '已声明拒答主题' : '未声明',
    },
  ];
  const score = Math.round((checks.filter(c => c.ok).length / checks.length) * 100);
  return { ready: checks.every(c => c.ok), score, blockers: checks.filter(c => !c.ok).map(c => c.detail), checks };
}

/** 分身记忆：只装可引用的事实，不装原始聊天与家属信息。 */
export async function twinMemory(store: StateStore, employeeId: string): Promise<any> {
  const employee = await findEmployee(store, employeeId);
  if (!employee) return null;
  const [facts, knowledge, twin] = await Promise.all([
    listAll(store, HR_TABLES.facts, { employee_id: String(employee.id) }),
    listAll(store, HR_TABLES.knowledge, { source_employee_id: String(employee.id) }),
    listAll(store, HR_TABLES.twins, { employee_id: String(employee.id) }),
  ]);
  return {
    profile: {
      name: employee.name, emp_no: employee.emp_no, dept: employee.dept, title: employee.title,
      level: employee.level, join_date: employee.join_date, education: employee.education || '',
    },
    skills: readSkills(employee),
    facts: facts.filter((f: any) => f.status === 'verified').slice(-12),
    knowledge: knowledge.filter((k: any) => k.status === 'published').slice(-6),
    twin: twin[0] || null,
  };
}

function detectSensitive(question: string): { topic: string; word: string } | null {
  const q = String(question || '').toLowerCase();
  for (const rule of SENSITIVE_RULES) {
    for (const word of rule.words) if (q.includes(word.toLowerCase())) return { topic: rule.topic, word };
  }
  return null;
}

/** 打分：标题/摘要/标签三路文本相关度，取最高两路加权（保守，宁可少引不可错引）。 */
function scoreEvidence(question: string, title: string, summary: string, tags: string[]): number {
  const parts = [title, summary, tags.join(' ')];
  let best = 0;
  let second = 0;
  for (const part of parts) {
    const s = simpleScore(question, part);
    if (s > best) { second = best; best = s; } else if (s > second) second = s;
  }
  return Math.round(best + second * 0.3);
}

function simpleScore(query: string, text: string): number {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const t = String(text || '').toLowerCase();
  if (!q || !t) return 0;
  if (t.includes(q)) return 100;
  const grams = new Set<string>();
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2));
  let hits = 0;
  for (const g of grams) if (t.includes(g)) hits += 1;
  return grams.size ? Math.round((hits / grams.size) * 80) : 0;
}

/**
 * 分身回答主流程。
 * 返回结构固定，前端与对话共用；拒答也走同一结构（refused=true），不抛异常——
 * 拒答是正常业务结果，不是系统故障。
 */
export async function answerAsTwin(
  store: StateStore,
  employeeKey: string,
  question: string,
  asker: string,
): Promise<TwinAnswer> {
  const employee = await findEmployee(store, employeeKey);
  if (!employee) throw new Error(`员工不存在：${employeeKey}`);
  const [facts, knowledge, twins] = await Promise.all([
    listAll(store, HR_TABLES.facts, { employee_id: String(employee.id) }),
    listAll(store, HR_TABLES.knowledge, { source_employee_id: String(employee.id) }),
    listAll(store, HR_TABLES.twins, { employee_id: String(employee.id) }),
  ]);
  const twin = twins[0] || null;
  const scope = twin ? fromJson<TwinScope>(twin.scope, DEFAULT_SCOPE) : DEFAULT_SCOPE;

  const base = {
    ok: true,
    employee: { id: String(employee.id), name: employee.name, dept: employee.dept, title: employee.title },
    twin_id: twin ? String(twin.id) : '',
    question: String(question || '').slice(0, 200),
  };

  const sensitive = detectSensitive(question);
  if (sensitive || !twin) {
    return {
      ...base,
      answer: sensitive
        ? `这个问题属于「${sensitive.topic}」，分身不代答。请直接联系 ${employee.name} 本人，或走 HR 正式流程。`
        : `${employee.name} 尚未开通数字分身，无法代答。请直接联系本人。`,
      refused: true,
      refused_reason: sensitive ? `敏感主题：${sensitive.topic}（命中「${sensitive.word}」）` : '未授权数字分身',
      refused_topic: sensitive ? sensitive.topic : '未授权',
      insufficient: false,
      citations: [],
      boundaries: scope.denied,
      confidence: 0,
      route: 'human',
      level: 'L4',
    };
  }

  const auth = twinAuthorization(twin);
  if (!auth.valid) {
    return {
      ...base,
      answer: `分身授权不可用（${auth.reason}），本次不代答。`,
      refused: true, refused_reason: auth.reason, refused_topic: '授权失效',
      insufficient: false, citations: [], boundaries: scope.denied,
      confidence: 0, route: 'human', level: 'L4',
    };
  }

  const candidates = [
    ...facts.filter((f: any) => f.status === 'verified').map((f: any) => ({
      kind: 'fact', id: String(f.id), title: String(f.title || ''), summary: String(f.summary || ''),
      tags: fromJson<string[]>(f.tags, []), date: String(f.occurred_at || f.created_at || ''),
      score: scoreEvidence(question, String(f.title || ''), String(f.summary || ''), fromJson<string[]>(f.tags, [])),
    })),
    ...knowledge.filter((k: any) => k.status === 'published').map((k: any) => ({
      kind: 'knowledge', id: String(k.id), title: String(k.title || ''),
      summary: `${String(k.situation || '')} ${String(k.action || '')} ${String(k.result || '')}`.trim(),
      tags: fromJson<string[]>(k.tags, []), date: String(k.published_at || k.created_at || ''),
      score: scoreEvidence(question, String(k.title || ''), `${k.situation || ''} ${k.action || ''} ${k.result || ''}`, fromJson<string[]>(k.tags, [])),
    })),
    ...readSkills(employee).map((s: any) => ({
      kind: 'skill', id: `skill:${s.name}`, title: s.name, summary: `熟练度 ${s.level}/5`,
      tags: [s.name], date: String(s.last_used_at || ''), score: simpleScore(question, s.name) + 10,
    })),
  ]
    .filter(c => c.score >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const insufficient = candidates.length === 0;
  const citations = candidates.map(c => ({ kind: c.kind, id: c.id, title: c.title, score: c.score }));

  const lines: string[] = [];
  lines.push(`我是 ${employee.name}（${employee.dept} · ${employee.title}）的数字分身，已由本人授权，回答只来自其已核实的事实与经验。`);
  if (insufficient) {
    lines.push(`关于「${question}」：目前没有足够沉淀的证据可以代答。建议直接联系 ${employee.name} 本人，或请其补充一条事实记录后再问。`);
  } else {
    lines.push(`关于「${question}」，可引用的记录：`);
    for (const c of candidates.slice(0, 3)) {
      const label = c.kind === 'knowledge' ? '经验' : c.kind === 'skill' ? '能力' : '事实';
      lines.push(`- [${label}] ${c.title}${c.summary ? `：${c.summary.slice(0, 90)}` : ''}${c.date ? `（${c.date.slice(0, 10)}）` : ''}`);
    }
    lines.push(`以上为可溯源记录；超出授权范围的判断（如是否适合某岗位、绩效高低）请由本人或 HR 当面确认。`);
  }

  const confidence = insufficient ? 0 : Math.min(95, 45 + candidates[0].score / 2);
  return {
    ...base,
    answer: lines.join('\n'),
    refused: false,
    refused_reason: '',
    refused_topic: '',
    insufficient,
    citations,
    boundaries: scope.denied,
    confidence: Math.round(confidence),
    route: insufficient ? 'human' : 'twin',
    level: insufficient ? 'L1' : 'L1',
  };
}

/** 问答留痕：分身每答一次都落一条审计，用于算可用率与拒答原因分布。 */
export async function recordTwinQuery(store: StateStore, employeeId: string, answer: TwinAnswer, askedBy: string): Promise<string> {
  return store.insert('business', HR_TABLES.twinQueries, {
    employee_id: String(employeeId),
    twin_id: answer.twin_id,
    question: answer.question,
    refused: answer.refused,
    refused_topic: answer.refused_topic || '',
    insufficient: answer.insufficient,
    citations: toJsonLocal(answer.citations.map(c => c.id)),
    confidence: answer.confidence,
    asked_by: askedBy,
    created_at: new Date().toISOString(),
  });
}

function toJsonLocal(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return 'null'; }
}

/** 分身运营指标：不是"聊了多少"，而是"多少问题能在不越界的前提下被答掉"。 */
export async function twinMetrics(store: StateStore): Promise<any> {
  const [twins, queries, employees, facts] = await Promise.all([
    listAll(store, HR_TABLES.twins),
    listAll(store, HR_TABLES.twinQueries),
    listAll(store, HR_TABLES.employees),
    listAll(store, HR_TABLES.facts),
  ]);
  const answered = queries.filter((q: any) => !q.refused && !q.insufficient);
  const refused = queries.filter((q: any) => q.refused);
  const insufficient = queries.filter((q: any) => !q.refused && q.insufficient);
  const topicCount = new Map<string, number>();
  for (const q of refused) {
    const topic = String(q.refused_topic || '未标注');
    topicCount.set(topic, (topicCount.get(topic) || 0) + 1);
  }
  const avgCitations = answered.length
    ? Math.round((answered.reduce((s: number, q: any) => s + fromJson<any[]>(q.citations, []).length, 0) / answered.length) * 10) / 10
    : 0;

  const readinessRows = twins.map((t: any) => {
    const employee = employees.find((e: any) => String(e.id) === String(t.employee_id));
    const own = facts.filter((f: any) => String(f.employee_id) === String(t.employee_id));
    return employee ? twinReadiness(employee, t, own, []) : { ready: false, score: 0, blockers: ['员工档案缺失'] };
  });

  return {
    twins_total: twins.length,
    twins_active: twins.filter((t: any) => t.status === 'active').length,
    twins_ready: readinessRows.filter((r: any) => r.ready).length,
    queries_total: queries.length,
    answered: answered.length,
    refused: refused.length,
    insufficient: insufficient.length,
    answer_rate: queries.length ? Math.round((answered.length / queries.length) * 100) : 0,
    refusal_topics: [...topicCount.entries()].sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count })),
    avg_citations: avgCitations,
    coverage_gap: insufficient.slice(0, 6).map((q: any) => {
      const employee = employees.find((e: any) => String(e.id) === String(q.employee_id));
      return { employee: employee?.name || '', question: q.question, at: q.created_at };
    }),
    last_queries: queries
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 12)
      .map((q: any) => ({
        question: q.question, refused: q.refused, insufficient: q.insufficient,
        refused_topic: q.refused_topic || '', confidence: q.confidence, asked_by: q.asked_by, created_at: q.created_at,
        employee: employees.find((e: any) => String(e.id) === String(q.employee_id))?.name || '',
      })),
    hours_saved: Math.round(answered.length * 0.2 * 10) / 10,
  };
}

/** 分身详情（供前端卡片渲染）。 */
export async function twinView(store: StateStore, twin: any): Promise<any> {
  const employee = await getById(store, HR_TABLES.employees, String(twin.employee_id));
  const [facts, knowledge] = await Promise.all([
    listAll(store, HR_TABLES.facts, { employee_id: String(twin.employee_id) }),
    listAll(store, HR_TABLES.knowledge, { source_employee_id: String(twin.employee_id) }),
  ]);
  const readiness = employee ? twinReadiness(employee, twin, facts, knowledge) : { ready: false, score: 0, blockers: ['员工档案缺失'], checks: [] };
  return {
    id: twin.id,
    employee_id: twin.employee_id,
    employee_name: employee?.name || '',
    dept: employee?.dept || '',
    title: employee?.title || '',
    status: twin.status,
    level: twin.level || 'L1',
    scope: fromJson<TwinScope>(twin.scope, DEFAULT_SCOPE),
    authorized_by: twin.authorized_by || '',
    authorized_at: twin.authorized_at || '',
    expires_at: twin.expires_at || '',
    interaction_count: Number(twin.interaction_count) || 0,
    readiness,
    facts_count: facts.filter((f: any) => f.status === 'verified').length,
    knowledge_count: knowledge.filter((k: any) => k.status === 'published').length,
    memory_preview: {
      skills: employee ? readSkills(employee) : [],
      recent_facts: facts.filter((f: any) => f.status === 'verified').slice(-3).map((f: any) => ({ id: f.id, title: f.title, at: f.occurred_at })),
      stale_warning: facts.filter((f: any) => f.status === 'verified' && isStale(f.occurred_at || f.created_at)).length,
    },
  };
}
