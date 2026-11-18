// 招聘效能：用更少的钱、更短的时间，招到更合适的人。
//
// 这里刻意不做一个"招聘数据大屏"就结束，而是走完整闭环：
//   取数（招聘域只读能力）→ 算单位经济（CPA / 周期 / 质量）→ 出可执行建议
//   → 人确认后改预算 → 回测同一指标，写成"已测量"或"未达标"。
// 没有回测的降本就是口号；没有质量的低价招聘，是把成本挪到试用期。
import type { Capability, Context, StateStore } from '../../core/types.ts';
import { HR_TABLES, listAll, fromJson, nowIso, overlapScore, readSkills } from './tables.ts';
import { getCapability } from '../../core/registry.ts';

/** 能力可能尚未注册（招聘域被裁剪时）：取不到返回 null，让降本建议退化为"仅本地数据"。 */
function tryCapability(id: string): Capability | null {
  try { return getCapability(id); } catch { return null; }
}

export const INTERNAL_HOURLY_COST = 220;
export const AI_MINUTES_PER_SCREEN = 25;

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  spend: number;
  sourced: number;
  screened: number;
  interviewed: number;
  offers: number;
  hired: number;
  quality_hires: number;
  internal_hours: number;
  status: string;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function channelMetrics(row: any): any {
  const spend = num(row.spend);
  const hired = num(row.hired);
  const sourced = num(row.sourced);
  const interviewed = num(row.interviewed);
  const offers = num(row.offers);
  const cpa = hired ? Math.round(spend / hired) : 0;
  return {
    id: row.id, name: row.name, type: row.type || '外部',
    spend, sourced, screened: num(row.screened), interviewed, offers, hired,
    quality_hires: num(row.quality_hires),
    cpa,
    screen_rate: sourced ? Math.round((num(row.screened) / sourced) * 100) : 0,
    interview_rate: num(row.screened) ? Math.round((interviewed / num(row.screened)) * 100) : 0,
    offer_rate: interviewed ? Math.round((offers / interviewed) * 100) : 0,
    accept_rate: offers ? Math.round((hired / offers) * 100) : 0,
    quality_rate: hired ? Math.round((num(row.quality_hires) / hired) * 100) : 0,
    cost_per_quality_hire: num(row.quality_hires) ? Math.round(spend / num(row.quality_hires)) : 0,
    internal_hours: num(row.internal_hours),
    status: row.status || 'active',
  };
}

/** 从招聘域只读能力取数：跨域只走公共契约，不直读别人的表。 */
export async function syncRecruitment(store: StateStore, ctx: Context): Promise<any> {
  const appsCap = tryCapability('recruitment.query.applications');
  const jobsCap = tryCapability('recruitment.query.jobs');
  if (!appsCap) return { ok: false, error: '招聘域未注册只读能力，跳过同步' };

  const appsResult = await appsCap.run({}, ctx);
  const apps: any[] = Array.isArray(appsResult?.applications) ? appsResult.applications : [];
  const truncated = num(appsResult?.count) > apps.length;

  const stageCount = (stage: string) => apps.filter(a => a.stage === stage).length;
  const outcomeCount = (outcome: string) => apps.filter(a => a.outcome === outcome).length;
  const aiScreened = apps.filter(a => a.ai_recommendation).length;

  const jobsResult = jobsCap ? await jobsCap.run({}, ctx) : { jobs: [] };
  const jobs: any[] = Array.isArray(jobsResult?.jobs) ? jobsResult.jobs : [];
  const openJobs = jobs.filter((j: any) => String(j.status || '') === 'open' || !j.status);

  const snapshot = {
    at: nowIso(),
    source: 'recruitment.query.applications',
    truncated,
    applications_seen: apps.length,
    applications_total: num(appsResult?.count),
    stage: { screening: stageCount('screening'), interview: stageCount('interview'), offer: stageCount('offer'), onboarding: stageCount('onboarding') },
    outcome: { hired: outcomeCount('hired'), rejected: outcomeCount('rejected'), withdrawn: outcomeCount('withdrawn'), active: outcomeCount('active') },
    ai_screened: aiScreened,
    ai_screen_rate: apps.length ? Math.round((aiScreened / apps.length) * 100) : 0,
    open_jobs: openJobs.length,
    jobs: openJobs.map((j: any) => ({ code: j.code, title: j.title, dept: j.dept || '', status: j.status || 'open' })),
  };

  await store.insert('business', HR_TABLES.snapshots, {
    kind: 'funnel', source: snapshot.source, body: toJsonLocal(snapshot),
    truncated: truncated ? 1 : 0, created_at: snapshot.at,
  });
  return { ok: true, ...snapshot };
}

export async function latestSnapshot(store: StateStore): Promise<any | null> {
  const rows = await listAll(store, HR_TABLES.snapshots, { kind: 'funnel' });
  const last = rows[rows.length - 1];
  return last ? fromJson(last.body, null) : null;
}

/** 单位经济：把所有成本折成"每个成功入职多少钱"，并由 AI 节省做抵扣。 */
export async function efficiencyView(store: StateStore): Promise<any> {
  const [channels, recommendations] = await Promise.all([
    listAll(store, HR_TABLES.channels),
    listAll(store, HR_TABLES.recommendations),
  ]);
  const snapshot = await latestSnapshot(store);
  const rows = channels.map(channelMetrics);
  const active = rows.filter(c => c.status === 'active');

  const spend = active.reduce((s, c) => s + c.spend, 0);
  const internalHours = active.reduce((s, c) => s + c.internal_hours, 0);
  const internalCost = internalHours * INTERNAL_HOURLY_COST;
  const hired = active.reduce((s, c) => s + c.hired, 0);
  const sourced = active.reduce((s, c) => s + c.sourced, 0);
  const interviewed = active.reduce((s, c) => s + c.interviewed, 0);
  const offers = active.reduce((s, c) => s + c.offers, 0);
  const qualityHires = active.reduce((s, c) => s + c.quality_hires, 0);

  const aiScreenCount = Math.max(num(snapshot?.ai_screened), 0);
  const aiHoursSaved = Math.round((aiScreenCount * AI_MINUTES_PER_SCREEN / 60) * 10) / 10;
  const aiValueSaved = Math.round(aiHoursSaved * INTERNAL_HOURLY_COST);
  const totalCost = spend + internalCost;
  const costPerHire = hired ? Math.round(totalCost / hired) : 0;
  const aiAdjusted = hired ? Math.round((totalCost - aiValueSaved) / hired) : 0;

  const funnel = [
    { key: 'sourced', label: '触达/投递', value: sourced },
    { key: 'screened', label: '初筛通过', value: active.reduce((s, c) => s + c.screened, 0) },
    { key: 'interviewed', label: '进入面试', value: interviewed },
    { key: 'offers', label: '发出 Offer', value: offers },
    { key: 'hired', label: '成功入职', value: hired },
  ];
  const stages = funnel.map((f, i) => ({
    ...f,
    rate_from_prev: i === 0 ? 100 : (funnel[i - 1].value ? Math.round((f.value / funnel[i - 1].value) * 100) : 0),
    rate_from_top: sourced ? Math.round((f.value / sourced) * 100) : 0,
  }));

  const avgCpa = hired ? Math.round(spend / hired) : 0;
  const bestQuality = [...active].sort((a, b) => b.quality_rate - a.quality_rate)[0] || null;

  return {
    snapshot,
    funnel,
    stages,
    channels: rows,
    totals: {
      spend, internal_hours: internalHours, internal_cost: internalCost, total_cost: totalCost,
      hires: hired, cost_per_hire: costPerHire, ai_adjusted_cost_per_hire: aiAdjusted,
      quality_rate: hired ? Math.round((qualityHires / hired) * 100) : 0,
      ai_hours_saved: aiHoursSaved, ai_value_saved: aiValueSaved,
      ai_screen_rate: num(snapshot?.ai_screen_rate),
      avg_cpa: avgCpa,
      offer_accept_rate: offers ? Math.round((hired / offers) * 100) : 0,
    },
    quality: {
      best_channel: bestQuality ? bestQuality.name : '',
      best_channel_rate: bestQuality ? bestQuality.quality_rate : 0,
      note: '质量口径：入职 90 天通过试用期/首评达标的人数 ÷ 入职人数。价格便宜的渠道，如果试用期流失高，真实成本会翻倍。',
    },
    recommendations: recommendations
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r: any) => ({
        id: r.id, kind: r.kind, title: r.title, rationale: r.rationale, evidence: fromJson<any>(r.evidence, {}),
        expected_saving: num(r.expected_saving), status: r.status,
        baseline: fromJson<any>(r.baseline, {}), measured: fromJson<any>(r.measured, {}),
        created_at: r.created_at, adopted_at: r.adopted_at || '',
      })),
    benchmark_note: '行业参考：单次招聘成本受岗位类型影响极大（一线岗位数百元级、专业岗位数千元级、稀缺技术岗可达数万元），绝对值不跨岗位比较；本页只做同企业、同岗位族的相对比较。',
  };
}

/**
 * 建议生成：规则确定性，每条都带可核算的金额与依据。
 * 反复生成不会重复：用 signature（类型+对象+口径）去重。
 */
export async function generateRecommendations(store: StateStore, ctx: Context): Promise<any[]> {
  const view = await efficiencyView(store);
  const [channels, existing] = await Promise.all([
    listAll(store, HR_TABLES.channels),
    listAll(store, HR_TABLES.recommendations),
  ]);
  const signatures = new Set(existing.map((r: any) => String(r.signature || '')));
  const created: any[] = [];
  const avgCpa = view.totals.avg_cpa || 1;

  const put = async (sig: string, kind: string, title: string, rationale: string, evidence: any, saving: number) => {
    if (signatures.has(sig)) return;
    const id = await store.insert('business', HR_TABLES.recommendations, {
      signature: sig, kind, title, rationale, evidence: toJsonLocal(evidence),
      expected_saving: Math.round(saving), status: 'proposed', baseline: toJsonLocal({
        cost_per_hire: view.totals.cost_per_hire, spend: view.totals.spend, hires: view.totals.hires,
        at: nowIso(),
      }),
      measured: 'null', created_at: nowIso(), adopted_at: '',
    });
    signatures.add(sig);
    created.push({ id, kind, title, rationale, expected_saving: Math.round(saving) });
  };

  for (const c of view.channels.filter((c: any) => c.status === 'active')) {
    if (c.hired >= 1 && avgCpa && c.cpa > avgCpa * 1.5) {
      const saving = Math.round(c.spend * (1 - avgCpa / c.cpa));
      await put(
        `budget_shift:${c.name}:cpa`,
        'budget_shift',
        `把「${c.name}」的预算向高质量渠道迁移`,
        `${c.name} 的单人成本 ¥${c.cpa}，是均值 ¥${avgCpa} 的 ${Math.round((c.cpa / avgCpa) * 10) / 10} 倍，且 90 天质量率仅 ${c.quality_rate}%。按同等入职量测算，迁移后可省约 ¥${saving}。`,
        { channel: c.name, cpa: c.cpa, avg_cpa: avgCpa, quality_rate: c.quality_rate, spend: c.spend, hires: c.hired },
        saving,
      );
    }
    if (c.hired >= 2 && c.quality_rate >= 80 && c.spend < view.totals.spend * 0.2) {
      await put(
        `budget_increase:${c.name}:quality`,
        'budget_increase',
        `给「${c.name}」加投（质量最高但预算占比低）`,
        `${c.name} 的 90 天质量率 ${c.quality_rate}%、单人成本 ¥${c.cpa}，但只占预算 ${Math.round((c.spend / (view.totals.spend || 1)) * 100)}%。加投的边际成本低于在低质量渠道上重复获客。`,
        { channel: c.name, quality_rate: c.quality_rate, cpa: c.cpa, spend_share: Math.round((c.spend / (view.totals.spend || 1)) * 100) },
        0,
      );
    }
  }

  if (view.totals.ai_screen_rate < 60 && view.snapshot?.applications_seen) {
    const gap = 100 - view.totals.ai_screen_rate;
    const saving = Math.round((view.snapshot.applications_seen * gap / 100) * (AI_MINUTES_PER_SCREEN / 60) * INTERNAL_HOURLY_COST);
    await put(
      `ai_screening:coverage`,
      'ai_screening',
      '把 AI 预筛覆盖率从当前水平提到 90% 以上',
      `当前有 ${view.totals.ai_screen_rate}% 的申请带 AI 预筛结论，仍有 ${gap}% 靠人工过简历。按每次人工初筛 ${AI_MINUTES_PER_SCREEN} 分钟测算，补齐可省约 ${Math.round((view.snapshot.applications_seen * gap / 100) * AI_MINUTES_PER_SCREEN / 60)} 小时/批。`,
      { ai_screen_rate: view.totals.ai_screen_rate, applications: view.snapshot.applications_seen },
      saving,
    );
  }

  // 内部优先：在招岗位与在职员工能力匹配，能内部补的就不外部招。
  const internalMatches = await internalCandidates(store, ctx);
  if (internalMatches.length) {
    await put(
      `internal_first:${internalMatches[0].job}`,
      'internal_first',
      '优先内部转岗：已有可匹配的在职员工',
      `「${internalMatches[0].job}」有 ${internalMatches[0].candidates.length} 名在职员工技能匹配度 ≥ 60%，优先内部转岗可省一次外部招聘（按均值 ¥${avgCpa} 计），且上手周期更短。`,
      { job: internalMatches[0].job, matches: internalMatches[0].candidates },
      avgCpa,
    );
  }

  return created;
}

/** 内部人才匹配：在招岗位 × 在职员工能力，给出可聊的人而不是一张空岗表。 */
export async function internalCandidates(store: StateStore, ctx: Context): Promise<any[]> {
  const jobsCap = tryCapability('recruitment.query.jobs');
  if (!jobsCap) return [];
  const employees = await listAll(store, HR_TABLES.employees);
  const result = await jobsCap.run({}, ctx);
  const jobs: any[] = Array.isArray(result?.jobs) ? result.jobs : [];
  const open = jobs.filter((j: any) => String(j.status || 'open') === 'open');
  const out: any[] = [];
  for (const job of open) {
    const text = `${job.title || ''} ${job.requirements || ''} ${job.description || ''}`;
    const matches = employees
      .filter((e: any) => (e.status || 'active') === 'active')
      .map((e: any) => {
        const skills = readSkills(e);
        const skillHit = skills.reduce((s, sk) => s + overlapScore(sk.name, text), 0);
        const titleHit = overlapScore(e.title || '', text);
        const score = Math.min(100, Math.round(skillHit / Math.max(1, skills.length) * 0.6 + titleHit * 0.4));
        return { employee_id: e.id, name: e.name, dept: e.dept, title: e.title, score };
      })
      .filter(m => m.score >= 60)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (matches.length) out.push({ job: `${job.code || ''} ${job.title || ''}`.trim(), candidates: matches });
  }
  return out;
}

/** 采纳建议：改渠道预算 + 记基线，供后续回测。 */
export async function adoptBudgetShift(
  store: StateStore,
  input: { recommendation_id: string; from_channel: string; to_channel: string; amount: number },
): Promise<any> {
  const recRows = await store.query('business', HR_TABLES.recommendations, { id: String(input.recommendation_id) });
  const rec = recRows[0];
  if (!rec) throw new Error('建议不存在');
  if (rec.status !== 'proposed') throw new Error(`建议当前状态为 ${rec.status}，只有待采纳的建议可以执行`);
  const rows = await listAll(store, HR_TABLES.channels);
  const from = rows.find((c: any) => c.name === input.from_channel);
  const to = rows.find((c: any) => c.name === input.to_channel);
  if (!from || !to) throw new Error('渠道不存在');
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('调整金额必须大于 0');
  if (amount > num(from.spend)) throw new Error(`调整金额不能超过「${from.name}」当前预算 ¥${num(from.spend)}`);

  await store.update('business', HR_TABLES.channels, String(from.id), { spend: num(from.spend) - amount, updated_at: nowIso() });
  await store.update('business', HR_TABLES.channels, String(to.id), { spend: num(to.spend) + amount, updated_at: nowIso() });
  const baseline = await efficiencyView(store);
  await store.update('business', HR_TABLES.recommendations, String(rec.id), {
    status: 'adopted', adopted_at: nowIso(),
    baseline: toJsonLocal({
      cost_per_hire: baseline.totals.cost_per_hire,
      spend: baseline.totals.spend,
      hires: baseline.totals.hires,
      at: nowIso(),
      moved: { from: from.name, to: to.name, amount },
    }),
  });
  return { ok: true, moved: amount, baseline_cost_per_hire: baseline.totals.cost_per_hire };
}

/** 回测：同一口径的前后对比；不达标就写不达标，不粉饰。 */
export async function measureRecommendation(store: StateStore, recommendationId: string, note: string): Promise<any> {
  const rows = await store.query('business', HR_TABLES.recommendations, { id: String(recommendationId) });
  const rec = rows[0];
  if (!rec) throw new Error('建议不存在');
  if (rec.status !== 'adopted') throw new Error('只有已采纳的建议可以回测');
  const now = await efficiencyView(store);
  const baseline = fromJson<any>(rec.baseline, {});
  const before = num(baseline.cost_per_hire);
  const after = now.totals.cost_per_hire;
  const delta = before && after ? Math.round(before - after) : 0;
  const deltaRate = before ? Math.round(((before - after) / before) * 1000) / 10 : 0;
  const measured = {
    before_cost_per_hire: before, after_cost_per_hire: after,
    delta, delta_rate: deltaRate,
    before_hires: num(baseline.hires), after_hires: now.totals.hires,
    note: String(note || ''),
    at: nowIso(),
    verdict: delta > 0 ? '达标' : delta === 0 ? '暂无变化' : '未达标',
  };
  await store.update('business', HR_TABLES.recommendations, String(rec.id), {
    status: delta >= 0 ? 'measured' : 'measured_negative',
    measured: toJsonLocal(measured),
  });
  return measured;
}

function toJsonLocal(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return 'null'; }
}

export type { ChannelRow };


