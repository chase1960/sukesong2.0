// 招聘演示域 REST API（/api/recruitment，走全局 requireAuth）。
// 状态机与已提交的 Frappe 语义保持一致：outcome 唯一落点
//   hired    ← onboarding.complete（唯一）
//   rejected ← screening.decide(reject)
//   withdrawn← offer declined
// AI 只提案（screening.propose / jd 草稿），一切落库动作由人确认后执行，每步 appendEvent。
import { Router } from 'express';
import type { Context } from '../../core/types.ts';
import { appendEvent, parsePayload } from '../../core/events.ts';
import { currentActor } from '../../core/actor.ts';
import { aiGenerateJD, aiParseResume, aiScreenApplication, type ParsedCandidate } from './ai.ts';
import { recordEpisode, listEpisodes, listSkills, activePreferenceLines, createSkillDrafts } from './skills.ts';
import { requestConfirmation, resolveConfirmation } from '../../core/confirm.ts';
import { getActionContract } from '../../core/action-contracts.ts';

// —— 表名（business 层，SQLite 通用 records 表，无需 DDL） ——
const T = {
  jobs: 'recruitment_jobs',
  candidates: 'recruitment_candidates',
  inbox: 'recruitment_inbox',
  applications: 'recruitment_applications',
  interviews: 'recruitment_interviews',
  offers: 'recruitment_offers',
  onboardings: 'recruitment_onboardings',
} as const;

const nowIso = () => new Date().toISOString();

async function listBy(ctx: Context, table: string, filter: Record<string, any>) {
  return ctx.store.query('business', table, filter, { sort: { key: 'created_at', dir: 'asc' } });
}
async function getById(ctx: Context, table: string, id: string) {
  const rows = await ctx.store.query('business', table, { id });
  return rows[0] || null;
}

function jsonSkills(skills: string[]): string { return JSON.stringify(skills || []); }
function parseSkills(raw: unknown): string[] { try { return JSON.parse(String(raw || '[]')); } catch { return []; } }

/** application 聚合视图：拼上候选人、岗位、面试、offer、入职信息，前端看板直接消费。 */
async function applicationView(ctx: Context, app: any) {
  const [cand, job] = await Promise.all([
    getById(ctx, T.candidates, app.candidate_id),
    getById(ctx, T.jobs, app.job_id),
  ]);
  const interviews = await listBy(ctx, T.interviews, { application_id: app.id });
  const offers = await listBy(ctx, T.offers, { application_id: app.id });
  const onboardings = await listBy(ctx, T.onboardings, { application_id: app.id });
  return {
    id: app.id,
    job: job ? { id: job.id, code: job.code, title: job.title, department: job.department } : null,
    candidate: cand ? {
      id: cand.id, name: cand.name, email: cand.email, phone: cand.phone,
      education: cand.education, experience_years: cand.experience_years,
      skills: parseSkills(cand.skills), summary: cand.summary,
    } : null,
    stage: app.stage,
    outcome: app.outcome,
    ai: {
      recommendation: app.ai_recommendation || '',
      score: app.ai_score || 0,
      reasoning: app.ai_reasoning || '',
      strengths: parseSkills(app.ai_strengths),
      concerns: parseSkills(app.ai_concerns),
      fallback: !!app.ai_fallback,
    },
    decided_by: app.decided_by || '',
    interviews: interviews.map(v => ({
      id: v.id, round: v.round, scheduled_at: v.scheduled_at, interviewer: v.interviewer,
      status: v.status, rating: v.rating || 0, comment: v.comment || '',
    })),
    offer: offers.length ? {
      id: offers[offers.length - 1].id, salary: offers[offers.length - 1].salary,
      content: offers[offers.length - 1].content, status: offers[offers.length - 1].status,
    } : null,
    onboarding: onboardings.length ? { id: onboardings[0].id, status: onboardings[0].status, completed_at: onboardings[0].completed_at || '' } : null,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

async function screenJobInput(ctx: Context, app: any): Promise<{ job: { title: string; requirements: string }; candidate: ParsedCandidate }> {
  const job = await getById(ctx, T.jobs, app.job_id);
  const cand = await getById(ctx, T.candidates, app.candidate_id);
  return {
    job: { title: job?.title || '', requirements: job?.requirements || '' },
    candidate: {
      name: cand?.name || '', email: cand?.email || '', phone: cand?.phone || '',
      education: cand?.education || '', experience_years: cand?.experience_years || 0,
      skills: parseSkills(cand?.skills), summary: cand?.summary || '',
    },
  };
}

export function recruitmentRouter(createCtx: () => Context): Router {
  const router = Router();

  // —— 总览 & 数据列表 ——

  router.get('/overview', async (_req, res) => {
    try {
      const ctx = createCtx();
      const [jobs, apps, inbox] = await Promise.all([
        listBy(ctx, T.jobs, {}),
        listBy(ctx, T.applications, {}),
        listBy(ctx, T.inbox, {}),
      ]);
      const openJobs = jobs.filter(j => j.status === 'open').length;
      const by = (s: string) => apps.filter(a => a.outcome === 'active' && a.stage === s).length;
      res.json({
        jobs_total: jobs.length, jobs_open: openJobs,
        inbox_new: inbox.filter(m => m.status === 'new').length,
        screening: by('screening'), interview: by('interview'), offer: by('offer'), onboarding: by('onboarding'),
        hired: apps.filter(a => a.outcome === 'hired').length,
        rejected: apps.filter(a => a.outcome === 'rejected').length,
        withdrawn: apps.filter(a => a.outcome === 'withdrawn').length,
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/jobs', async (_req, res) => {
    try {
      const jobs = await listBy(createCtx(), T.jobs, {});
      res.json(jobs.map(j => ({
        id: j.id, code: j.code, title: j.title, department: j.department, headcount: j.headcount,
        requirements: j.requirements, highlights: j.highlights, status: j.status,
        jd_draft: j.jd_draft || '', jd_published: j.jd_published || '',
        source: j.source || '', created_at: j.created_at, updated_at: j.updated_at,
      })));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/inbox', async (_req, res) => {
    try {
      const mails = await listBy(createCtx(), T.inbox, {});
      res.json(mails.map(m => ({
        id: m.id, mail_from: m.mail_from, subject: m.subject, received_at: m.received_at,
        resume_text: m.resume_text, status: m.status, application_id: m.application_id || '',
      })));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/applications', async (_req, res) => {
    try {
      const ctx = createCtx();
      const apps = await listBy(ctx, T.applications, {});
      res.json(await Promise.all(apps.map(a => applicationView(ctx, a))));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 审计时间线：只看招聘域事件，按时间倒序
  router.get('/events', async (req, res) => {
    try {
      const ctx = createCtx();
      const entityId = String(req.query.entity_id || '');
      const events = await ctx.store.query('execution', 'events', undefined, { sort: { key: 'created_at', dir: 'desc' }, limit: 200 });
      const rows = events
        .filter(e => String(e.capability || '').startsWith('recruitment.'))
        .filter(e => !entityId || e.entity_id === entityId)
        .slice(0, 100)
        .map(e => ({
          id: e.id, capability: e.capability, entity_type: e.entity_type, entity_id: e.entity_id,
          payload: parsePayload(e.payload), status: e.status, initiator: e.initiator, reviewer: e.reviewer || '',
          created_at: e.created_at,
        }));
      res.json(rows);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 岗位：创建 → AI 生成 JD（提案） → 人工确认发布 ——

  router.post('/jobs', async (req, res) => {
    try {
      const ctx = createCtx();
      const { title, department, headcount, requirements, highlights } = req.body || {};
      if (!title || !department) return res.status(400).json({ error: '岗位名称与部门必填' });
      const existing = await listBy(ctx, T.jobs, {});
      const id = await ctx.store.insert('business', T.jobs, {
        code: `JOB-2026-${String(existing.length + 1).padStart(3, '0')}`,
        title: String(title).slice(0, 60),
        department: String(department).slice(0, 40),
        headcount: Number(headcount) || 1,
        requirements: String(requirements || '').slice(0, 500),
        highlights: String(highlights || '').slice(0, 300),
        status: 'draft',
        jd_draft: '', jd_published: '',
        source: 'user', review_note: '',
        created_at: nowIso(), updated_at: nowIso(),
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.job.save', entity_type: 'recruitment.job', entity_id: id,
        payload: { title, department, status: 'draft' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.status(201).json(await getById(ctx, T.jobs, id));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/jobs/:id/ai-jd', async (req, res) => {
    try {
      const ctx = createCtx();
      const job = await getById(ctx, T.jobs, req.params.id);
      if (!job) return res.status(404).json({ error: '岗位不存在' });
      const { jd, fallback } = await aiGenerateJD({
        title: job.title, department: job.department, headcount: job.headcount,
        requirements: job.requirements, highlights: job.highlights,
        preferences: (await activePreferenceLines(ctx.store)).jd,
      });
      await ctx.store.update('business', T.jobs, job.id, { jd_draft: jd, updated_at: nowIso() });
      await appendEvent(ctx.store, {
        capability: 'recruitment.jd.ai', entity_type: 'recruitment.job', entity_id: job.id,
        payload: { fallback, length: jd.length }, initiator: 'agent', status: 'proposed',
      });
      res.json({ jd_draft: jd, fallback });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 人工修订 JD 草稿（确认卡上的编辑）
  router.post('/jobs/:id/jd', async (req, res) => {
    try {
      const ctx = createCtx();
      const job = await getById(ctx, T.jobs, req.params.id);
      if (!job) return res.status(404).json({ error: '岗位不存在' });
      const jd = String(req.body?.jd || '').slice(0, 5000);
      // 学习环证据：AI 原稿（保存前的 jd_draft）vs HR 终稿
      await recordEpisode(ctx.store, {
        kind: 'jd_edit', job_id: job.id,
        ai_content: String(job.jd_draft || ''), human_content: jd,
      }, currentActor()?.id || 'admin');
      await ctx.store.update('business', T.jobs, job.id, { jd_draft: jd, updated_at: nowIso() });
      await appendEvent(ctx.store, {
        capability: 'recruitment.jd.save', entity_type: 'recruitment.job', entity_id: job.id,
        payload: { jd }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.json(await getById(ctx, T.jobs, job.id));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/jobs/:id/publish', async (req, res) => {
    try {
      const ctx = createCtx();
      const job = await getById(ctx, T.jobs, req.params.id);
      if (!job) return res.status(404).json({ error: '岗位不存在' });
      const jd = String(req.body?.jd ?? job.jd_draft ?? '').slice(0, 5000);
      if (!jd.trim()) return res.status(400).json({ error: 'JD 为空：请先生成或填写 JD' });
      if (job.status !== 'draft') return res.status(400).json({ error: '只有草稿态岗位可发布' });
      await ctx.store.update('business', T.jobs, job.id, {
        jd_published: jd, status: 'open', updated_at: nowIso(),
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.jd.publish', entity_type: 'recruitment.job', entity_id: job.id,
        payload: { code: job.code, status: 'open' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.json(await getById(ctx, T.jobs, job.id));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/jobs/:id/close', async (req, res) => {
    try {
      const ctx = createCtx();
      const job = await getById(ctx, T.jobs, req.params.id);
      if (!job) return res.status(404).json({ error: '岗位不存在' });
      await ctx.store.update('business', T.jobs, job.id, { status: 'closed', updated_at: nowIso() });
      await appendEvent(ctx.store, {
        capability: 'recruitment.job.close', entity_type: 'recruitment.job', entity_id: job.id,
        payload: { code: job.code, status: 'closed' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.json(await getById(ctx, T.jobs, job.id));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 收件箱：AI 解析（提案） → 人工确认转申请 ——

  router.post('/inbox/:id/parse', async (req, res) => {
    try {
      const ctx = createCtx();
      const mail = await getById(ctx, T.inbox, req.params.id);
      if (!mail) return res.status(404).json({ error: '邮件不存在' });
      if (mail.status !== 'new') return res.status(400).json({ error: '该邮件已处理' });
      const { candidate, fallback } = await aiParseResume(mail.resume_text || '');
      const jobs = (await listBy(ctx, T.jobs, {})).filter(j => j.status === 'open');
      await appendEvent(ctx.store, {
        capability: 'recruitment.resume.parse', entity_type: 'recruitment.inbox', entity_id: mail.id,
        payload: { fallback, name: candidate.name }, initiator: 'agent', status: 'proposed',
      });
      res.json({ candidate, fallback, open_jobs: jobs.map(j => ({ id: j.id, title: j.title, code: j.code })) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 确认卡「确认转为申请」：落 candidate + application（screening 阶段）
  router.post('/inbox/:id/convert', async (req, res) => {
    try {
      const ctx = createCtx();
      const mail = await getById(ctx, T.inbox, req.params.id);
      if (!mail) return res.status(404).json({ error: '邮件不存在' });
      if (mail.status !== 'new') return res.status(400).json({ error: '该邮件已处理' });
      const { job_id, candidate } = req.body || {};
      if (!job_id) return res.status(400).json({ error: '请选择岗位' });
      const job = await getById(ctx, T.jobs, job_id);
      if (!job || job.status !== 'open') return res.status(400).json({ error: '岗位不存在或未开放' });
      const c = candidate || {};
      const ts = nowIso();
      const candId = await ctx.store.insert('business', T.candidates, {
        name: String(c.name || '候选人').slice(0, 50),
        email: String(c.email || mail.mail_from || '').slice(0, 100),
        phone: String(c.phone || '').slice(0, 30),
        education: String(c.education || '').slice(0, 100),
        experience_years: Number(c.experience_years) || 0,
        skills: jsonSkills(Array.isArray(c.skills) ? c.skills : []),
        summary: String(c.summary || '').slice(0, 200),
        source: 'mail', review_note: `来自邮件: ${mail.subject}`,
        created_at: ts,
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.candidate.save', entity_type: 'recruitment.candidate', entity_id: candId,
        payload: { name: c.name, source: 'mail' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      const appId = await ctx.store.insert('business', T.applications, {
        job_id: job.id, candidate_id: candId,
        stage: 'screening', outcome: 'active',
        ai_recommendation: '', ai_score: 0, ai_reasoning: '', ai_strengths: '[]', ai_concerns: '[]', ai_fallback: false,
        decided_by: '', decided_at: '',
        source: 'user', review_note: '',
        created_at: ts, updated_at: ts,
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.application.intake', entity_type: 'recruitment.application', entity_id: appId,
        payload: { job_id: job.id, candidate_id: candId, mail: mail.subject, stage: 'screening' },
        initiator: 'user', status: 'confirmed', reviewer: currentActor()?.id || 'admin',
      });
      await ctx.store.update('business', T.inbox, mail.id, { status: 'converted', application_id: appId });
      res.status(201).json({ application_id: appId, candidate_id: candId });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/inbox/:id/ignore', async (req, res) => {
    try {
      const ctx = createCtx();
      const mail = await getById(ctx, T.inbox, req.params.id);
      if (!mail) return res.status(404).json({ error: '邮件不存在' });
      const reason = String(req.body?.reason || '').slice(0, 100);
      await ctx.store.update('business', T.inbox, mail.id, { status: 'ignored' });
      await appendEvent(ctx.store, {
        capability: 'recruitment.intake.ignore', entity_type: 'recruitment.inbox', entity_id: mail.id,
        payload: { subject: mail.subject, reason }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 筛选：AI 建议（提案） → 人工定夺 ——

  router.post('/applications/:id/ai-screen', async (req, res) => {
    try {
      const ctx = createCtx();
      const app = await getById(ctx, T.applications, req.params.id);
      if (!app) return res.status(404).json({ error: '申请不存在' });
      if (app.outcome !== 'active' || app.stage !== 'screening') return res.status(400).json({ error: '仅在筛选阶段的进行中申请可生成 AI 建议' });
      const input = await screenJobInput(ctx, app);
      const { result, fallback } = await aiScreenApplication({
        ...input,
        preferences: (await activePreferenceLines(ctx.store)).screening,
      });
      await ctx.store.update('business', T.applications, app.id, {
        ai_recommendation: result.recommend, ai_score: result.score, ai_reasoning: result.reasoning,
        ai_strengths: jsonSkills(result.strengths), ai_concerns: jsonSkills(result.concerns),
        ai_fallback: fallback, updated_at: nowIso(),
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.screening.propose', entity_type: 'recruitment.application', entity_id: app.id,
        payload: { recommend: result.recommend, score: result.score, fallback }, initiator: 'agent', status: 'proposed',
      });
      res.json({ ...result, fallback });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 人工定夺：advance（进入面试）/ reject（终止）
  router.post('/applications/:id/decide', async (req, res) => {
    try {
      const ctx = createCtx();
      const app = await getById(ctx, T.applications, req.params.id);
      if (!app) return res.status(404).json({ error: '申请不存在' });
      if (app.outcome !== 'active') return res.status(400).json({ error: '申请已结束' });
      const action = req.body?.action;
      const reviewer = currentActor()?.id || 'admin';
      const ts = nowIso();
      // 学习环证据：AI 建议 vs HR 决定（含候选人画像，供确定性提取器分析）
      const cand = await getById(ctx, T.candidates, app.candidate_id);
      const recordScreeningEpisode = () => recordEpisode(ctx.store, {
        kind: 'screening_decision', application_id: app.id,
        ai_recommend: String(app.ai_recommendation || ''), human_decision: String(action),
        candidate: cand ? {
          name: cand.name, experience_years: Number(cand.experience_years) || 0,
          skills: parseSkills(cand.skills),
        } : undefined,
      }, reviewer);
      if (action === 'advance') {
        if (app.stage !== 'screening') return res.status(400).json({ error: '仅在筛选阶段可推进' });
        await ctx.store.update('business', T.applications, app.id, { stage: 'interview', decided_by: reviewer, decided_at: ts, updated_at: ts });
        await recordScreeningEpisode();
        await appendEvent(ctx.store, {
          capability: 'recruitment.screening.decide', entity_type: 'recruitment.application', entity_id: app.id,
          payload: { decision: 'advance', from: 'screening', to: 'interview', ai_recommend: app.ai_recommendation },
          initiator: 'user', status: 'confirmed', reviewer,
        });
      } else if (action === 'reject') {
        if (app.stage !== 'screening') return res.status(400).json({ error: '仅在筛选阶段可拒绝' });
        await ctx.store.update('business', T.applications, app.id, { outcome: 'rejected', decided_by: reviewer, decided_at: ts, updated_at: ts });
        await recordScreeningEpisode();
        await appendEvent(ctx.store, {
          capability: 'recruitment.screening.decide', entity_type: 'recruitment.application', entity_id: app.id,
          payload: { decision: 'reject', outcome: 'rejected', ai_recommend: app.ai_recommendation },
          initiator: 'user', status: 'confirmed', reviewer,
        });
      } else {
        return res.status(400).json({ error: 'action 必须为 advance 或 reject' });
      }
      res.json(await applicationView(ctx, await getById(ctx, T.applications, app.id)));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 面试：安排 → 评价 ——

  router.post('/applications/:id/interviews', async (req, res) => {
    try {
      const ctx = createCtx();
      const app = await getById(ctx, T.applications, req.params.id);
      if (!app) return res.status(404).json({ error: '申请不存在' });
      if (app.outcome !== 'active' || app.stage !== 'interview') return res.status(400).json({ error: '仅在面试阶段的进行中申请可安排面试' });
      const { scheduled_at, interviewer } = req.body || {};
      if (!scheduled_at || !interviewer) return res.status(400).json({ error: '面试时间与面试官必填' });
      const existing = await listBy(ctx, T.interviews, { application_id: app.id });
      const id = await ctx.store.insert('business', T.interviews, {
        application_id: app.id, round: existing.length + 1,
        scheduled_at: String(scheduled_at).slice(0, 30), interviewer: String(interviewer).slice(0, 30),
        status: 'scheduled', rating: 0, comment: '',
        created_at: nowIso(),
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.interview.schedule', entity_type: 'recruitment.interview', entity_id: id,
        payload: { application_id: app.id, round: existing.length + 1, scheduled_at, interviewer },
        initiator: 'user', status: 'confirmed', reviewer: currentActor()?.id || 'admin',
      });
      res.status(201).json({ interview_id: id, round: existing.length + 1 });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/interviews/:id/evaluate', async (req, res) => {
    try {
      const ctx = createCtx();
      const iv = await getById(ctx, T.interviews, req.params.id);
      if (!iv) return res.status(404).json({ error: '面试不存在' });
      if (iv.status !== 'scheduled') return res.status(400).json({ error: '该面试已评价' });
      const rating = Math.max(1, Math.min(5, Number(req.body?.rating) || 0));
      if (!rating) return res.status(400).json({ error: '评分 1-5 必填' });
      const comment = String(req.body?.comment || '').slice(0, 500);
      await ctx.store.update('business', T.interviews, iv.id, { status: 'completed', rating, comment });
      // 学习环证据：面试评价（rating + 评语），供后续反馈闭环展示
      await recordEpisode(ctx.store, {
        kind: 'interview_feedback', application_id: iv.application_id,
        rating, comment, interviewer: iv.interviewer,
      }, currentActor()?.id || 'admin');
      await appendEvent(ctx.store, {
        capability: 'recruitment.evaluation.submit', entity_type: 'recruitment.interview', entity_id: iv.id,
        payload: { application_id: iv.application_id, rating, comment }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      const app = await getById(ctx, T.applications, iv.application_id);
      res.json(app ? await applicationView(ctx, app) : { ok: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— Offer：创建 → 审批 → 候选人答复 ——

  router.post('/applications/:id/offer', async (req, res) => {
    try {
      const ctx = createCtx();
      const app = await getById(ctx, T.applications, req.params.id);
      if (!app) return res.status(404).json({ error: '申请不存在' });
      if (app.outcome !== 'active' || app.stage !== 'interview') return res.status(400).json({ error: '仅在面试阶段的进行中申请可发 Offer' });
      const { salary, content } = req.body || {};
      if (!salary) return res.status(400).json({ error: '薪酬必填' });
      const id = await ctx.store.insert('business', T.offers, {
        application_id: app.id, salary: String(salary).slice(0, 50),
        content: String(content || '').slice(0, 2000), status: 'pending',
        created_at: nowIso(),
      });
      await ctx.store.update('business', T.applications, app.id, { stage: 'offer', updated_at: nowIso() });
      await appendEvent(ctx.store, {
        capability: 'recruitment.offer.create', entity_type: 'recruitment.offer', entity_id: id,
        payload: { application_id: app.id, salary, stage: 'offer' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.status(201).json({ offer_id: id });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/offers/:id/approve', async (req, res) => {
    try {
      const ctx = createCtx();
      const offer = await getById(ctx, T.offers, req.params.id);
      if (!offer) return res.status(404).json({ error: 'Offer 不存在' });
      if (offer.status !== 'pending') return res.status(400).json({ error: '该 Offer 已审批' });
      await ctx.store.update('business', T.offers, offer.id, { status: 'approved' });
      await appendEvent(ctx.store, {
        capability: 'recruitment.offer.approve', entity_type: 'recruitment.offer', entity_id: offer.id,
        payload: { application_id: offer.application_id, salary: offer.salary }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 候选人答复：accepted → 入职阶段 + onboarding 记录；declined → outcome withdrawn（唯一落点）
  router.post('/offers/:id/reply', async (req, res) => {
    try {
      const ctx = createCtx();
      const offer = await getById(ctx, T.offers, req.params.id);
      if (!offer) return res.status(404).json({ error: 'Offer 不存在' });
      if (offer.status !== 'approved') return res.status(400).json({ error: 'Offer 审批后才可录入候选人答复' });
      const accept = !!req.body?.accept;
      const ts = nowIso();
      if (accept) {
        await ctx.store.update('business', T.offers, offer.id, { status: 'accepted' });
        const obId = await ctx.store.insert('business', T.onboardings, {
          application_id: offer.application_id, status: 'pending', completed_at: '',
          created_at: ts,
        });
        await ctx.store.update('business', T.applications, offer.application_id, { stage: 'onboarding', updated_at: ts });
        await appendEvent(ctx.store, {
          capability: 'recruitment.offer.record_reply', entity_type: 'recruitment.offer', entity_id: offer.id,
          payload: { reply: 'accepted', onboarding_id: obId, stage: 'onboarding' }, initiator: 'user', status: 'confirmed',
          reviewer: currentActor()?.id || 'admin',
        });
        res.json({ accepted: true, onboarding_id: obId });
      } else {
        await ctx.store.update('business', T.offers, offer.id, { status: 'declined' });
        await ctx.store.update('business', T.applications, offer.application_id, { outcome: 'withdrawn', updated_at: ts });
        await appendEvent(ctx.store, {
          capability: 'recruitment.offer.record_reply', entity_type: 'recruitment.offer', entity_id: offer.id,
          payload: { reply: 'declined', outcome: 'withdrawn' }, initiator: 'user', status: 'confirmed',
          reviewer: currentActor()?.id || 'admin',
        });
        res.json({ accepted: false });
      }
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 学习环：episodes / skills（HR 确认的偏好规则） ——

  router.get('/episodes', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json(await listEpisodes(ctx.store, 200));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/skills', async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      res.json(await listSkills(createCtx().store, status));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 从 episodes 确定性提取偏好规则草稿（status draft），写操作，沿用 currentActor 鉴权口径
  router.post('/skills/extract', async (_req, res) => {
    try {
      const ctx = createCtx();
      const drafts = await createSkillDrafts(ctx.store, currentActor()?.id || 'admin');
      await appendEvent(ctx.store, {
        capability: 'recruitment.skill.extract', entity_type: 'recruitment.skill', entity_id: 'batch',
        payload: { created: drafts.length }, initiator: 'agent', status: 'proposed',
      });
      res.json(drafts);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // 激活/忽略草稿规则：内部走 recruitment.skill.activate Action 契约
  // （resolve 丰富 payload → requestConfirmation → resolveConfirmation，单跳 UX，审计链完整）
  const settleSkill = (action: 'activate' | 'dismiss') => async (req: any, res: any) => {
    try {
      const ctx = createCtx();
      const contract = getActionContract('recruitment.skill.activate')!;
      const resolved = await contract.resolve!(ctx.store, { skill_id: req.params.id, action });
      const eventId = await requestConfirmation(ctx.store, {
        capability: 'recruitment.skill.activate',
        entity_type: resolved.entity_type,
        entity_id: resolved.entity_id,
        payload: resolved.payload,
        initiator: 'agent',
      });
      await resolveConfirmation(ctx.store, eventId, 'confirmed', currentActor()?.id || 'admin');
      const skill = (await ctx.store.query('business', 'recruitment_skills', { id: req.params.id }))[0];
      res.json(skill);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (msg.includes('不存在')) return res.status(404).json({ error: msg });
      if (msg.includes('状态')) return res.status(400).json({ error: msg });
      res.status(500).json({ error: msg });
    }
  };
  router.post('/skills/:id/activate', settleSkill('activate'));
  router.post('/skills/:id/dismiss', settleSkill('dismiss'));

  // —— 入职完成：outcome hired 的唯一落点 ——

  router.post('/onboardings/:id/complete', async (req, res) => {
    try {
      const ctx = createCtx();
      const ob = await getById(ctx, T.onboardings, req.params.id);
      if (!ob) return res.status(404).json({ error: '入职记录不存在' });
      if (ob.status !== 'pending') return res.status(400).json({ error: '该入职已完成' });
      const ts = nowIso();
      await ctx.store.update('business', T.onboardings, ob.id, { status: 'done', completed_at: ts });
      await ctx.store.update('business', T.applications, ob.application_id, { outcome: 'hired', updated_at: ts });
      await appendEvent(ctx.store, {
        capability: 'recruitment.onboarding.complete', entity_type: 'recruitment.onboarding', entity_id: ob.id,
        payload: { application_id: ob.application_id, outcome: 'hired' }, initiator: 'user', status: 'confirmed',
        reviewer: currentActor()?.id || 'admin',
      });
      const app = await getById(ctx, T.applications, ob.application_id);
      res.json(app ? await applicationView(ctx, app) : { ok: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
