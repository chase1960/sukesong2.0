// HR 中台（人在企业里的数据资产层）——表名与通用读写小工具。
//
// 为什么中台先做「数据资产」而不是先做更多流程：
//   招聘、培训、绩效、知识都要读同一份「员工事实」。没有事实层，每个流程各存一份，
//   企业越用越碎，AI 越用越像猜。中台的第一职责是把员工数据沉淀成可引用、可审计的资产。
// 存储沿用 business 层通用 records（JSON body + _version 乐观锁），无需 DDL。
import type { StateStore } from '../../core/types.ts';

export const HR_TABLES = {
  employees: 'hr_employees',
  facts: 'hr_employee_facts',
  twins: 'hr_twins',
  twinQueries: 'hr_twin_queries',
  skillModels: 'hr_skill_models',
  plans: 'hr_learning_plans',
  learningEvents: 'hr_learning_events',
  knowledge: 'hr_knowledge',
  knowledgeVersions: 'hr_knowledge_versions',
  knowledgeUsages: 'hr_knowledge_usages',
  channels: 'hr_recruit_channels',
  snapshots: 'hr_recruit_snapshots',
  recommendations: 'hr_recruit_recommendations',
  autonomyPolicies: 'hr_autonomy_policies',
  autonomyDecisions: 'hr_autonomy_decisions',
  orgUnits: 'hr_org_units',
} as const;

export const nowIso = () => new Date().toISOString();

export function toJson(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return 'null'; }
}

export function fromJson<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === 'object') return raw as T;
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export async function listAll(store: StateStore, table: string, filter: Record<string, any> = {}): Promise<any[]> {
  return store.query('business', table, filter, { sort: { key: 'created_at', dir: 'asc' } });
}

export async function getById(store: StateStore, table: string, id: string): Promise<any | null> {
  const rows = await store.query('business', table, { id: String(id) });
  return rows[0] || null;
}

/** 员工定位：支持 id / 工号 / 姓名（姓名允许模糊）。 */
export async function findEmployee(store: StateStore, key: string): Promise<any | null> {
  const k = String(key || '').trim();
  if (!k) return null;
  const employees = await listAll(store, HR_TABLES.employees);
  return employees.find((e: any) => e.id === k || e.emp_no === k)
    || employees.find((e: any) => String(e.name || '') === k)
    || employees.find((e: any) => String(e.name || '').includes(k))
    || null;
}

/** 员工技能的读取口径：空值一律当空数组，避免各处重复解析。 */
export function readSkills(employee: any): Array<{ name: string; level: number; last_used_at?: string }> {
  const parsed = fromJson<any[]>(employee?.skills, []);
  return Array.isArray(parsed)
    ? parsed.map(s => ({ name: String(s?.name || ''), level: Number(s?.level) || 0, last_used_at: s?.last_used_at || '' })).filter(s => s.name)
    : [];
}

/** 以月为单位算司龄（用于驾驶舱分布，不精确到日也无妨）。 */
export function tenureMonths(joinDate: string): number {
  const start = Date.parse(String(joinDate || ''));
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / (30.44 * 24 * 3600 * 1000)));
}

export function isStale(iso: string, months = 18): boolean {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > months * 30.44 * 24 * 3600 * 1000;
}

/** 中文文本相关度：二字片段重合 + 完整包含，够做确定性检索，不引入检索服务。 */
export function overlapScore(query: string, text: string): number {
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
