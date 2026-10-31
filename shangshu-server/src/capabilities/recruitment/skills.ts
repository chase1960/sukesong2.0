// 招聘域 Skill 学习闭环（纯确定性，无 LLM）：
//   episodes（操作证据） → extractSkillDrafts（确定性规则提取） → 确认卡激活 → 注入 AI 提示词。
// 对外口径：这是「HR 确认的偏好规则」（人审门控下的受控迭代），不称自主进化。
// 表结构走 business 层通用 records（JSON body + _version 乐观锁），无需 DDL。
import type { StateStore } from '../../core/types.ts';

const T = {
  episodes: 'recruitment_episodes',
  skills: 'recruitment_skills',
  feedback: 'recruitment_skill_feedback',
} as const;

const nowIso = () => new Date().toISOString();

// —— Episode：操作证据快照（AI 原稿 vs HR 终稿 / AI 建议 vs HR 决定）——

export interface ScreeningEpisodeInput {
  kind: 'jd_edit' | 'screening_decision' | 'interview_feedback';
  job_id?: string;
  application_id?: string;
  ai_content?: string;      // jd_edit：AI 生成的 JD 草稿
  human_content?: string;   // jd_edit：HR 修订后的 JD
  ai_recommend?: string;    // screening_decision：AI 建议 advance/reject/review
  human_decision?: string;  // screening_decision：HR 实际决定
  candidate?: { name?: string; experience_years?: number; skills?: string[] };
  rating?: number;          // interview_feedback
  comment?: string;
  interviewer?: string;
}

export async function recordEpisode(store: StateStore, ep: ScreeningEpisodeInput, actor: string): Promise<string> {
  return store.insert('business', T.episodes, {
    ...ep,
    candidate: ep.candidate ? JSON.stringify(ep.candidate) : '',
    actor,
    created_at: nowIso(),
  });
}

export async function listEpisodes(store: StateStore, limit = 100): Promise<any[]> {
  const rows = await store.query('business', T.episodes);
  return rows
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map((r: any) => ({ ...r, candidate: safeJson(r.candidate) }));
}

function safeJson(raw: unknown): any {
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

// —— Skills：HR 确认的偏好规则 ——

export async function listSkills(store: StateStore, status?: string): Promise<any[]> {
  const rows = await store.query('business', T.skills);
  return rows
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .filter((s: any) => !status || s.status === status)
    .map((s: any) => ({ ...s, pattern: safeJson(s.pattern), evidence_ids: safeJson(s.evidence_ids) }));
}

/** 运行时生效点：把 active 规则序列化为 AI 提示词偏好段（注入 aiScreenApplication / aiGenerateJD）。 */
export async function activePreferenceLines(store: StateStore): Promise<{ screening: string[]; jd: string[] }> {
  const active = await listSkills(store, 'active');
  const screening: string[] = [];
  const jd: string[] = [];
  for (const s of active) {
    const p = s.pattern || {};
    if (s.rule_type === 'screening_preference') {
      if (p.min_experience_years) screening.push(`经验低于 ${p.min_experience_years} 年的候选人建议谨慎推进（倾向 review/reject），理由需点明经验差距`);
      if (p.favor_low_tenure) screening.push(String(p.favor_low_tenure));
    } else if (s.rule_type === 'jd_style') {
      if (p.remove_section) jd.push(`JD 删除段落「${p.remove_section}」——HR 多次删除该段，不要输出`);
      if (p.add_section) jd.push(`JD 需包含段落「${p.add_section}」——HR 多次补充该段`);
    }
  }
  return { screening, jd };
}

// —— 确定性提取器（决策 c：纯规则，无 LLM）——

const headings = (text: string): string[] =>
  String(text || '').split('\n').filter(l => /^#{1,6}\s/.test(l.trim())).map(l => l.replace(/^#{1,6}\s+/, '').trim());

export interface SkillDraft {
  rule_type: 'jd_style' | 'screening_preference';
  pattern: Record<string, unknown>;
  description: string;
  evidence_ids: string[];
}

/**
 * 从 episodes 提取偏好规则草稿（阈值：同一模式重复 ≥2 次才成候选）。
 * 纯确定性：
 *  - jd_edit：统计 HR 反复删除/新增的 JD 段落标题；
 *  - screening_decision：统计「AI 建议 advance、HR 改为 reject」的案例，若被拒者经验均低于某阈值
 *    → 提取最低经验年限偏好。
 */
export async function extractSkillDrafts(store: StateStore): Promise<SkillDraft[]> {
  const episodes = await listEpisodes(store, 500);
  const existing = await listSkills(store);
  const drafts: SkillDraft[] = [];

  // 1) JD 段落偏好
  const jdEdits = episodes.filter(e => e.kind === 'jd_edit' && e.ai_content && e.human_content);
  const removed = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  for (const e of jdEdits) {
    const aiH = headings(e.ai_content), humanH = headings(e.human_content);
    for (const h of aiH) if (!humanH.includes(h)) push(removed, h, e.id);
    for (const h of humanH) if (!aiH.includes(h)) push(added, h, e.id);
  }
  for (const [h, ids] of removed) {
    if (ids.length >= 2) drafts.push({
      rule_type: 'jd_style', pattern: { remove_section: h },
      description: `HR 在 ${ids.length} 次 JD 修订中删除了段落「${h}」，建议后续 JD 不再包含`,
      evidence_ids: ids,
    });
  }
  for (const [h, ids] of added) {
    if (ids.length >= 2) drafts.push({
      rule_type: 'jd_style', pattern: { add_section: h },
      description: `HR 在 ${ids.length} 次 JD 修订中补充了段落「${h}」，建议后续 JD 包含`,
      evidence_ids: ids,
    });
  }

  // 2) 筛选偏好：AI advance → HR reject，被拒者经验有共同下限
  const overrides = episodes.filter(e =>
    e.kind === 'screening_decision' && e.ai_recommend === 'advance' && e.human_decision === 'reject'
    && Number(e.candidate?.experience_years) > 0);
  if (overrides.length >= 2) {
    const maxExp = Math.max(...overrides.map(e => Number(e.candidate.experience_years)));
    // 且对照组：HR 同意推进的候选人经验都更高（避免把整体收紧误读为偏好）
    const approvals = episodes.filter(e =>
      e.kind === 'screening_decision' && e.human_decision === 'advance' && Number(e.candidate?.experience_years) > 0);
    const ok = approvals.length === 0 || approvals.every(e => Number(e.candidate.experience_years) >= maxExp);
    if (ok) drafts.push({
      rule_type: 'screening_preference',
      pattern: { min_experience_years: maxExp },
      description: `HR 连续 ${overrides.length} 次否决 AI 推进的经验 ≤${maxExp} 年候选人（被拒者：${overrides.map(e => e.candidate.name).join('、')}），建议低于 ${maxExp} 年谨慎推进`,
      evidence_ids: overrides.map(e => e.id),
    });
  }

  // 去重：已存在同 rule_type+pattern 的规则（含 draft/active/dismissed）不再重复提
  const key = (d: SkillDraft) => d.rule_type + '|' + JSON.stringify(d.pattern);
  const seen = new Set(existing.map(s => s.rule_type + '|' + JSON.stringify(s.pattern)));
  return drafts.filter(d => !seen.has(key(d)));
}

function push(m: Map<string, string[]>, k: string, id: string) {
  (m.get(k) || m.set(k, []).get(k)!).push(id);
}

/** 落草稿（status draft），返回创建的 skill 记录。激活走 recruitment.skill.activate 确认卡。 */
export async function createSkillDrafts(store: StateStore, owner: string): Promise<any[]> {
  const drafts = await extractSkillDrafts(store);
  const created: any[] = [];
  for (const d of drafts) {
    const id = await store.insert('business', T.skills, {
      rule_type: d.rule_type,
      pattern: JSON.stringify(d.pattern),
      description: d.description,
      evidence_ids: JSON.stringify(d.evidence_ids),
      status: 'draft',
      owner, activated_by: '', activated_at: '',
      created_at: nowIso(), updated_at: nowIso(),
    });
    created.push({ id, ...d, status: 'draft', owner });
  }
  return created;
}

// —— 反馈闭环：skill 生效后 HR 仍修改 AI 输出 → 记 feedback（演示口径：持续迭代）——
export async function recordFeedback(store: StateStore, skillId: string, episodeId: string, note: string): Promise<void> {
  await store.insert('business', T.feedback, {
    skill_id: skillId, episode_id: episodeId, note, created_at: nowIso(),
  });
}
