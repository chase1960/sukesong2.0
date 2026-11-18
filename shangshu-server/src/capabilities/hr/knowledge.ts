// 经验沉淀：把散落在员工事实里的做法，变成可引用、可版本化、可度量的知识资产。
//
// 三步，缺一步都不算沉淀：
//   1) 采集：只从「已核实事实」抽，不凭模型想象；
//   2) 审核：草稿必须人发布（L2），发布即生成不可覆盖的新版本；
//   3) 复用计量：谁在什么场景引用、是否被采纳。没有复用数据的知识库只是文档坟墓。
import type { StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, fromJson, nowIso, overlapScore } from './tables.ts';

export interface KnowledgeDraft {
  title: string;
  domain: string;
  situation: string;
  action: string;
  result: string;
  reusable_rules: string[];
  tags: string[];
  source_employee_id: string;
  source_fact_ids: string[];
  ai_generated: boolean;
  evidence_strength: number;
}

/** 事实摘要若按「情境/行动/结果」写过，就结构化拆开；没写就诚实只放情境。 */
export function splitSro(summary: string): { situation: string; action: string; result: string } {
  const text = String(summary || '').trim();
  const pick = (label: string) => {
    const re = new RegExp(`${label}\\s*[:：]\\s*([^。；;\\n]*(?:[。；;][^。；;\\n]*)?)`);
    const m = re.exec(text);
    return m ? m[1].trim() : '';
  };
  const situation = pick('情境') || pick('背景');
  const action = pick('行动') || pick('做法');
  const result = pick('结果') || pick('成效');
  if (situation || action || result) return { situation, action, result };
  return { situation: text, action: '', result: '' };
}

/**
 * 确定性采集：同一主题下至少 2 条已核实事实才生成一条草稿。
 * 阈值存在的理由是：一条事实是个人经历，两条以上才可能是可复用的做法。
 */
export async function captureKnowledgeDrafts(store: StateStore): Promise<KnowledgeDraft[]> {
  const [facts, employees, existing] = await Promise.all([
    listAll(store, HR_TABLES.facts),
    listAll(store, HR_TABLES.employees),
    listAll(store, HR_TABLES.knowledge),
  ]);
  const empById = new Map(employees.map((e: any) => [String(e.id), e]));
  const verified = facts.filter((f: any) => f.status === 'verified');

  const groups = new Map<string, any[]>();
  for (const f of verified) {
    const tags = fromJson<string[]>(f.tags, []);
    const key = tags[0] || deptOf(empById.get(String(f.employee_id))) || '通用';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  const existingKeys = new Set(existing.map((k: any) => `${String(k.domain)}|${String(k.title)}`));
  const drafts: KnowledgeDraft[] = [];
  for (const [tag, group] of groups) {
    if (group.length < 2) continue;
    const titles = group.map((g: any) => String(g.title || '')).filter(Boolean);
    const title = `${tag}：${group.length} 条实践提炼出的可复用做法`;
    if (existingKeys.has(`${tag}|${title}`)) continue;

    const parts = group.map((g: any) => splitSro(g.summary));
    const situation = group.map((g: any, i: number) => `${i + 1}. ${g.title}：${parts[i].situation || '（无情境描述）'}`).join('\n');
    const action = parts.filter(p => p.action).map((p, i) => `${i + 1}. ${p.action}`).join('\n')
      || group.map((g: any, i: number) => `${i + 1}. 参考「${g.title}」的原始做法与边界`).join('\n');
    const result = parts.filter(p => p.result).map((p, i) => `${i + 1}. ${p.result}`).join('\n')
      || `已在 ${group.length} 条事实中被验证，具体效果以事实原文为准`;

    drafts.push({
      title, domain: tag, situation, action, result,
      reusable_rules: [
        `遇到与「${tag}」相关的场景，先按上表中的做法复现一遍，再决定改哪一步`,
        `边界：只复用在同类场景；跨部门使用前先确认前提条件是否成立`,
        `证据：本卡片由 ${group.length} 条已核实事实支撑，引用时请一并标明来源员工与事实 id`,
      ],
      tags: [tag],
      source_employee_id: String(group[0].employee_id || ''),
      source_fact_ids: group.map((g: any) => String(g.id)),
      ai_generated: false,
      evidence_strength: Math.min(3, group.length),
    });
  }
  return drafts;
}

function deptOf(employee: any): string {
  return String(employee?.dept || '');
}

export async function createDrafts(store: StateStore, owner: string): Promise<any[]> {
  const drafts = await captureKnowledgeDrafts(store);
  const created: any[] = [];
  for (const d of drafts) {
    const id = await store.insert('business', HR_TABLES.knowledge, {
      title: d.title, domain: d.domain, situation: d.situation, action: d.action, result: d.result,
      reusable_rules: toJsonLocal(d.reusable_rules), tags: toJsonLocal(d.tags),
      source_employee_id: d.source_employee_id, source_fact_ids: toJsonLocal(d.source_fact_ids),
      status: 'draft', version: 0, review_by: '', published_at: '',
      reuse_count: 0, adopted_count: 0, ai_generated: d.ai_generated, fallback: false,
      evidence_strength: d.evidence_strength, owner, created_at: nowIso(), updated_at: nowIso(),
    });
    created.push({ id, ...d, status: 'draft' });
  }
  return created;
}

/** 发布：写一条不可覆盖的版本快照，再更新主记录指针。回滚只能新建版本，不能覆盖历史。 */
export async function publishKnowledge(store: StateStore, knowledgeId: string, reviewer: string): Promise<any> {
  const rows = await store.query('business', HR_TABLES.knowledge, { id: String(knowledgeId) });
  const row = rows[0];
  if (!row) throw new Error(`知识条目不存在：${knowledgeId}`);
  if (row.status === 'published' || row.status === 'revising') {
    // 已发布条目再次发布 = 新修订；正文必须先被修改过（updated_at 变化由调用方保证）
  }
  const version = Number(row.version || 0) + 1;
  await store.insert('business', HR_TABLES.knowledgeVersions, {
    knowledge_id: String(knowledgeId),
    version,
    title: row.title, situation: row.situation, action: row.action, result: row.result,
    reusable_rules: row.reusable_rules, tags: row.tags,
    review_by: reviewer, published_at: nowIso(), created_at: nowIso(),
  });
  await store.update('business', HR_TABLES.knowledge, String(knowledgeId), {
    status: 'published', version, review_by: reviewer, published_at: nowIso(), updated_at: nowIso(),
  });
  return { id: knowledgeId, version, reviewer };
}

export async function listKnowledge(store: StateStore, opts: { status?: string; domain?: string; limit?: number } = {}): Promise<any[]> {
  const [rows, usages] = await Promise.all([
    listAll(store, HR_TABLES.knowledge),
    listAll(store, HR_TABLES.knowledgeUsages),
  ]);
  return rows
    .filter((k: any) => (!opts.status || k.status === opts.status) && (!opts.domain || k.domain === opts.domain))
    .sort((a: any, b: any) => String(b.published_at || b.created_at).localeCompare(String(a.published_at || a.created_at)))
    .slice(0, opts.limit || 200)
    .map((k: any) => {
      const own = usages.filter((u: any) => String(u.knowledge_id) === String(k.id));
      const adopted = own.filter((u: any) => u.adopted === true || u.adopted === 'true').length;
      return {
        id: k.id, title: k.title, domain: k.domain, status: k.status, version: Number(k.version) || 0,
        situation: k.situation, action: k.action, result: k.result,
        reusable_rules: fromJson<string[]>(k.reusable_rules, []),
        tags: fromJson<string[]>(k.tags, []),
        source_employee_id: k.source_employee_id || '',
        source_fact_ids: fromJson<string[]>(k.source_fact_ids, []),
        reuse_count: Number(k.reuse_count) || 0,
        adopted_count: Number(k.adopted_count) || 0,
        adoption_rate: own.length ? Math.round((adopted / own.length) * 100) : 0,
        ai_generated: !!k.ai_generated,
        published_at: k.published_at || '',
        created_at: k.created_at,
      };
    });
}

export async function searchKnowledge(store: StateStore, query: string, limit = 5): Promise<any[]> {
  const rows = await listKnowledge(store, { status: 'published' });
  return rows
    .map((k: any) => ({
      ...k,
      score: Math.max(
        overlapScore(query, k.title),
        overlapScore(query, k.situation),
        overlapScore(query, `${k.action} ${k.result}`),
        overlapScore(query, (k.tags || []).join(' ')),
        overlapScore(query, (k.reusable_rules || []).join(' ')),
      ),
    }))
    .filter((k: any) => k.score >= 30)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);
}

/** 复用计量：一次引用一条记录；采纳与否决定这条知识到底有没有用。 */
export async function recordUsage(
  store: StateStore,
  knowledgeId: string,
  input: { context: string; adopted: boolean; by: string },
): Promise<any> {
  const rows = await store.query('business', HR_TABLES.knowledge, { id: String(knowledgeId) });
  const row = rows[0];
  if (!row) throw new Error(`知识条目不存在：${knowledgeId}`);
  if (row.status !== 'published') throw new Error('只有已发布的知识可以被引用');
  await store.insert('business', HR_TABLES.knowledgeUsages, {
    knowledge_id: String(knowledgeId),
    context: String(input.context || '').slice(0, 200),
    adopted: !!input.adopted,
    used_by: input.by,
    created_at: nowIso(),
  });
  await store.update('business', HR_TABLES.knowledge, String(knowledgeId), {
    reuse_count: (Number(row.reuse_count) || 0) + 1,
    adopted_count: (Number(row.adopted_count) || 0) + (input.adopted ? 1 : 0),
    updated_at: nowIso(),
  });
  return { id: knowledgeId, reused: true };
}

/**
 * 知识健康度 + 自进化建议（建议只提案，不自动改）：
 *   - 高复用 → 置顶 / 做成标准动作；
 *   - 90 天零引用 → 归档候选；
 *   - 引用多但采纳率低 → 修订候选（说明写得不落地）。
 */
export async function knowledgeHealth(store: StateStore): Promise<any> {
  const [rows, usages] = await Promise.all([
    listAll(store, HR_TABLES.knowledge),
    listAll(store, HR_TABLES.knowledgeUsages),
  ]);
  const published = rows.filter((r: any) => r.status === 'published');
  const totalUsage = usages.length;
  const adopted = usages.filter((u: any) => u.adopted === true || u.adopted === 'true').length;

  const items = published.map((k: any) => {
    const own = usages.filter((u: any) => String(u.knowledge_id) === String(k.id));
    const ownAdopted = own.filter((u: any) => u.adopted === true || u.adopted === 'true').length;
    const lastUsed = own.map((u: any) => String(u.created_at)).sort().pop() || '';
    const dormant = !lastUsed || (Date.now() - Date.parse(lastUsed)) > 90 * 24 * 3600 * 1000;
    return {
      id: k.id, title: k.title, usage: own.length, adopted: ownAdopted,
      adoption_rate: own.length ? Math.round((ownAdopted / own.length) * 100) : 0,
      last_used: lastUsed, dormant,
    };
  });

  const top = [...items].sort((a, b) => b.usage - a.usage).slice(0, 5);
  const dormant = items.filter(i => i.dormant).slice(0, 8);
  const weak = items.filter(i => i.usage >= 3 && i.adoption_rate < 40);

  const suggestions = [
    ...top.filter(i => i.usage >= 3).map(i => ({
      kind: 'promote', title: `把「${i.title}」提升为标准动作`, why: `已复用 ${i.usage} 次，采纳率 ${i.adoption_rate}%`,
    })),
    ...dormant.slice(0, 3).map(i => ({
      kind: 'archive', title: `「${i.title}」90 天零引用`, why: '建议归档或改写成更具体的场景卡片',
    })),
    ...weak.slice(0, 3).map(i => ({
      kind: 'revise', title: `「${i.title}」采纳率偏低（${i.adoption_rate}%）`, why: `被引用 ${i.usage} 次但只有 ${i.adopted} 次采纳，说明写得不够落地`,
    })),
  ];

  return {
    total: rows.length,
    published: published.length,
    drafts: rows.filter((r: any) => r.status === 'draft').length,
    usage_total: totalUsage,
    adopted_total: adopted,
    adoption_rate: totalUsage ? Math.round((adopted / totalUsage) * 100) : 0,
    coverage_domains: [...new Set(published.map((p: any) => String(p.domain)))].length,
    top,
    dormant,
    suggestions,
    evolution_note: '自进化只做「建议 → 人确认 → 新版本」，不做自动改写知识正文；知识是企业的公共事实，不能由模型静默覆盖。',
  };
}

export async function knowledgeVersions(store: StateStore, knowledgeId: string): Promise<any[]> {
  const rows = await listAll(store, HR_TABLES.knowledgeVersions);
  return rows
    .filter((r: any) => String(r.knowledge_id) === String(knowledgeId))
    .sort((a: any, b: any) => Number(b.version) - Number(a.version))
    .map((r: any) => ({
      version: r.version, title: r.title, review_by: r.review_by,
      published_at: r.published_at, situation: r.situation,
    }));
}

function toJsonLocal(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return 'null'; }
}
