// 招聘域动作契约（AI 提案 → 人确认 → 统一执行）。
// 聊天确认卡（core/chat.ts executeTool confirm 分支）与 /api/confirmations 共用这套契约，
// 自动继承：去重挂起、版本校验、快照漂移检测、hash 链审计。
// 注意：execute 在 resolveConfirmation 事务内被调用，store 即事务 tx，不可调用外部服务。
import { registerActionContract } from '../../core/action-contracts.ts';
import type { StateStore } from '../../core/types.ts';
import { currentActor } from '../../core/actor.ts';
import { aiGenerateJD } from './ai.ts';
import { activePreferenceLines } from './skills.ts';

// 与 router.ts 共享的表名（避免循环依赖，此处独立声明同款常量）
const T = {
  jobs: 'recruitment_jobs',
  applications: 'recruitment_applications',
  interviews: 'recruitment_interviews',
} as const;

const nowIso = () => new Date().toISOString();

async function findJob(store: StateStore, key: string): Promise<any | null> {
  // 支持 job code（JOB-2026-001）或 title 模糊匹配
  const jobs = await store.query('business', T.jobs);
  const k = String(key || '').trim();
  if (!k) return null;
  return jobs.find(j => j.id === k || j.code === k)
    || jobs.find(j => String(j.title || '').includes(k))
    || null;
}

async function findApplication(store: StateStore, candidateName: string): Promise<any | null> {
  const apps = await store.query('business', T.applications, { outcome: 'active' });
  const cands = await store.query('business', 'recruitment_candidates');
  const byId = new Map(cands.map(c => [c.id, c]));
  const k = String(candidateName || '').trim();
  if (!k) return null;
  return apps.find(a => {
    const c = byId.get(a.candidate_id);
    return c && String(c.name || '').includes(k);
  }) || null;
}

// —— JD 生成 + 发布（聊天里「帮我生成并发布 XX 岗位 JD」）——
// 一步走：resolve 阶段生成 AI JD 草稿（不落库），确认卡上人看到 AI JD 全文；execute 才落库发布。
// resolve 里的 LLM 调用发生在挂卡之前（不在事务内），确认时 execute 纯确定性写库。
registerActionContract({
  id: 'recruitment.jd.publish', revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object',
    properties: {
      job: { type: 'string', description: '岗位 code 或名称，如 JOB-2026-001 / 高级后端工程师' },
      requirements: { type: 'string', description: '任职要求补充（可选）' },
      highlights: { type: 'string', description: '亮点补充（可选）' },
    },
    required: ['job'],
  },
  async resolve(store, input) {
    const job = await findJob(store, String(input.job));
    if (!job) throw new Error(`岗位不存在：${input.job}`);
    if (job.status !== 'draft') throw new Error(`岗位 ${job.code} 当前状态为 ${job.status}，只有草稿态可发布（如需重发请先新建岗位）`);
    // AI 生成 JD 草稿（预生成，确认卡直接展示全文；失败落预录兜底）
    const { jd, fallback } = await aiGenerateJD({
      title: job.title, department: job.department, headcount: job.headcount,
      requirements: String(input.requirements || job.requirements || ''),
      highlights: String(input.highlights || job.highlights || ''),
      // 学习环闭环：active 的 jd_style 规则注入 AI 提示词（与 router.ts 的直接发布口径一致）
      preferences: (await activePreferenceLines(store)).jd,
    });
    return {
      entity_type: 'recruitment.job',
      entity_id: job.id,
      payload: { job_id: job.id, code: job.code, title: job.title, jd, fallback },
    };
  },
  async snapshot(store, payload) {
    const [job] = await store.query('business', T.jobs, { id: String(payload.job_id) });
    return { status: job?.status || '', jd_draft_len: String(job?.jd_draft || '').length };
  },
  async execute(payload, { store, actor }) {
    const jobId = String(payload.job_id);
    const jd = String(payload.jd || '');
    if (!jd.trim()) throw new Error('JD 为空，拒绝发布');
    const [job] = await store.query('business', T.jobs, { id: jobId });
    if (!job) throw new Error('岗位不存在');
    if (job.status !== 'draft') throw new Error(`岗位状态已变为 ${job.status}，请重新提案`);
    await store.update('business', T.jobs, jobId, {
      jd_draft: jd, jd_published: jd, status: 'open', updated_at: nowIso(),
    });
    return jobId;
  },
});

// —— 安排面试（聊天里「给张三安排明天 10 点一面，面试官李四」）——
registerActionContract({
  id: 'recruitment.interview.schedule', revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object',
    properties: {
      candidate: { type: 'string', description: '候选人姓名' },
      scheduled_at: { type: 'string', description: '面试时间，如 2026-11-01 10:00' },
      interviewer: { type: 'string', description: '面试官姓名' },
      round: { type: 'integer', description: '轮次（可选，默认自动递增）' },
    },
    required: ['candidate', 'scheduled_at', 'interviewer'],
  },
  async resolve(store, input) {
    const app = await findApplication(store, String(input.candidate));
    if (!app) throw new Error(`找不到进行中的申请（候选人：${input.candidate}）`);
    if (app.stage !== 'interview') throw new Error(`候选人 ${input.candidate} 当前在 ${app.stage} 阶段，仅在面试阶段可安排面试`);
    const cands = await store.query('business', 'recruitment_candidates', { id: app.candidate_id });
    const interviews = await store.query('business', T.interviews, { application_id: app.id });
    return {
      entity_type: 'recruitment.interview',
      entity_id: 'agent:' + app.id,
      payload: {
        application_id: app.id,
        candidate: cands[0]?.name || input.candidate,
        round: Number(input.round) || interviews.length + 1,
        scheduled_at: String(input.scheduled_at).slice(0, 30),
        interviewer: String(input.interviewer).slice(0, 30),
      },
    };
  },
  async snapshot(store, payload) {
    const rows = await store.query('business', T.interviews, { application_id: String(payload.application_id) });
    return { count: rows.length };
  },
  async execute(payload, { store }) {
    const appId = String(payload.application_id);
    const [app] = await store.query('business', T.applications, { id: appId });
    if (!app || app.outcome !== 'active' || app.stage !== 'interview') throw new Error('申请不在面试阶段，请重新提案');
    const existing = await store.query('business', T.interviews, { application_id: appId });
    const id = await store.insert('business', T.interviews, {
      application_id: appId,
      round: Number(payload.round) || existing.length + 1,
      scheduled_at: String(payload.scheduled_at).slice(0, 30),
      interviewer: String(payload.interviewer).slice(0, 30),
      status: 'scheduled', rating: 0, comment: '',
      created_at: nowIso(),
    });
    return id;
  },
});

// —— Skill 激活（能力线二：HR 确认的偏好规则）——
registerActionContract({
  id: 'recruitment.skill.activate', revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string' },
      action: { type: 'string', enum: ['activate', 'dismiss'] },
    },
    required: ['skill_id', 'action'],
  },
  async resolve(store, input) {
    const [skill] = await store.query('business', 'recruitment_skills', { id: String(input.skill_id) });
    if (!skill) throw new Error(`偏好规则不存在：${input.skill_id}`);
    if (skill.status !== 'draft') throw new Error(`规则当前状态为 ${skill.status}，只有草稿可处理`);
    return {
      entity_type: 'recruitment.skill',
      entity_id: skill.id,
      payload: {
        skill_id: skill.id, action: String(input.action),
        rule_type: skill.rule_type, pattern: JSON.parse(String(skill.pattern || '{}')),
        description: skill.description || '',
      },
    };
  },
  async snapshot(store, payload) {
    const [skill] = await store.query('business', 'recruitment_skills', { id: String(payload.skill_id) });
    return { status: skill?.status || '', version: skill?._version ?? 0 };
  },
  async execute(payload, { store, actor }) {
    const id = String(payload.skill_id);
    const next = String(payload.action) === 'activate' ? 'active' : 'dismissed';
    const [skill] = await store.query('business', 'recruitment_skills', { id });
    if (!skill || skill.status !== 'draft') throw new Error('规则状态已变化，请重新提案');
    await store.update('business', 'recruitment_skills', id, {
      status: next, activated_by: actor.id, activated_at: nowIso(), updated_at: nowIso(),
    });
    return id;
  },
});

export { findJob, findApplication };
