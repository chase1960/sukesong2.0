// HR 中台 REST 入口：读写分离，写操作全部单跳确认（resolve → 确认卡 → 事务执行）。
//
// 单跳的理由：UI 点击"确认"本身就是人的确认动作，不需要再跑一趟审批中心；
// 但审计链必须完整——proposed → confirmed → 执行结果，全在事件流里可查。
import express from 'express';
import { currentActor } from '../../core/actor.ts';
import { appendEvent } from '../../core/events.ts';
import { requestConfirmation, resolveConfirmation } from '../../core/confirm.ts';
import { getActionContract } from '../../core/action-contracts.ts';
import type { Context } from '../../core/types.ts';
import { HR_TABLES, listAll, findEmployee, nowIso } from './tables.ts';
import { employeeView, assetLedger } from './assets.ts';
import { dashboard, employeeSnapshot } from './analytics.ts';
import { listPlans, learningEffect, modelFor, skillGaps, proposePlan } from './learning.ts';
import { listKnowledge, createDrafts, captureKnowledgeDrafts, knowledgeHealth, knowledgeVersions } from './knowledge.ts';
import { efficiencyView, generateRecommendations, measureRecommendation, syncRecruitment, internalCandidates } from './efficiency.ts';
import { autonomyMatrix, decide, recordDecision } from './autonomy.ts';
import { answerAsTwin, recordTwinQuery, twinMetrics, twinView } from './twin.ts';

const ROLES = ['admin', 'manager'];

export function hrRouter(createCtx: () => Context) {
  const router = express.Router();

  const guard = (req: any, res: any, next: any) => {
    const actor = currentActor();
    if (!actor) return res.status(401).json({ error: '未登录' });
    if (actor.role !== 'admin' && !ROLES.includes(String(actor.role))) {
      return res.status(403).json({ error: 'HR 中台仅对 HR / 管理者开放' });
    }
    next();
  };

  /** 单跳确认：合同 resolve 出「人要看的那一版」，确认卡落事件，确认即执行。 */
  async function settle(
    ctx: Context,
    actionId: string,
    input: Record<string, unknown>,
    entityId?: string,
  ): Promise<any> {
    const contract = getActionContract(actionId);
    const resolved = await contract.resolve!(ctx.store, input);
    const eventId = await requestConfirmation(ctx.store, {
      capability: actionId,
      entity_type: resolved.entity_type,
      entity_id: entityId || resolved.entity_id,
      payload: resolved.payload,
      initiator: 'agent',
    });
    await resolveConfirmation(ctx.store, eventId, 'confirmed', currentActor()?.id || 'admin');
    return { event_id: eventId, payload: resolved.payload };
  }

  router.use(guard);

  router.get('/overview', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json(await dashboard(ctx.store));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/employees', async (req, res) => {
    try {
      const ctx = createCtx();
      const employees = await listAll(ctx.store, HR_TABLES.employees);
      const dept = req.query.dept ? String(req.query.dept) : '';
      const q = req.query.q ? String(req.query.q) : '';
      const rows = await Promise.all(employees
        .filter((e: any) => (!dept || String(e.dept) === dept) && (!q || String(e.name).includes(q) || String(e.title).includes(q)))
        .map((e: any) => employeeView(ctx.store, e)));
      res.json({ count: rows.length, employees: rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/employees/:key', async (req, res) => {
    try {
      const ctx = createCtx();
      const employee = await findEmployee(ctx.store, req.params.key);
      if (!employee) return res.status(404).json({ error: '员工不存在' });
      const [snapshot, twins] = await Promise.all([
        employeeSnapshot(ctx.store, employee),
        listAll(ctx.store, HR_TABLES.twins, { employee_id: String(employee.id) }),
      ]);
      res.json({ ...snapshot, twin: twins[0] ? await twinView(ctx.store, twins[0]) : null });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/employees/:key/facts', async (req, res) => {
    try {
      const ctx = createCtx();
      const employee = await findEmployee(ctx.store, req.params.key);
      if (!employee) return res.status(404).json({ error: '员工不存在' });
      const result = await settle(ctx, 'hr.fact.record', { ...req.body, employee: employee.name });
      const row = (await ctx.store.query('business', HR_TABLES.facts, { employee_id: String(employee.id) })).pop();
      res.json({ ok: true, event_id: result.event_id, fact: row });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      res.status(msg.includes('员工不存在') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/facts/:id/verify', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.fact.verify', { fact_id: String(req.params.id) });
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/facts', async (req, res) => {
    try {
      const ctx = createCtx();
      const rows = await listAll(ctx.store, HR_TABLES.facts);
      res.json({ count: rows.length, facts: rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/assets/ledger', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json(await assetLedger(ctx.store));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 数字分身 ——
  router.get('/twins', async (_req, res) => {
    try {
      const ctx = createCtx();
      const twins = await listAll(ctx.store, HR_TABLES.twins);
      const rows = await Promise.all(twins.map((t: any) => twinView(ctx.store, t)));
      res.json({ twins: rows, metrics: await twinMetrics(ctx.store) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/twins/authorize', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.twin.authorize', req.body || {});
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/twins/:employee/ask', async (req, res) => {
    try {
      const ctx = createCtx();
      const employee = await findEmployee(ctx.store, req.params.employee);
      if (!employee) return res.status(404).json({ error: '员工不存在' });
      const answer = await answerAsTwin(
        ctx.store, String(employee.id), String(req.body?.question || ''), currentActor()?.id || 'admin',
      );
      await recordTwinQuery(ctx.store, String(employee.id), answer, currentActor()?.id || 'admin');
      const twins = await listAll(ctx.store, HR_TABLES.twins, { employee_id: String(employee.id) });
      if (twins[0]) {
        await ctx.store.update('business', HR_TABLES.twins, String(twins[0].id), {
          interaction_count: (Number(twins[0].interaction_count) || 0) + 1,
          last_active_at: nowIso(),
        });
      }
      await appendEvent(ctx.store, {
        capability: 'hr.twin.answer', entity_type: 'hr.twin', entity_id: twins[0]?.id || `employee:${employee.id}`,
        payload: { question: answer.question, refused: answer.refused, citations: answer.citations.length },
        initiator: 'agent', status: 'confirmed', reviewer: currentActor()?.id || 'admin',
      });
      res.json(answer);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // —— 培养与能力 ——
  router.get('/learning/plans', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json({ plans: await listPlans(ctx.store), effect: await learningEffect(ctx.store) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/learning/gap/:key', async (req, res) => {
    try {
      const ctx = createCtx();
      const employee = await findEmployee(ctx.store, req.params.key);
      if (!employee) return res.status(404).json({ error: '员工不存在' });
      const model = await modelFor(ctx.store, String(req.query.target || employee.title || ''));
      if (!model) return res.status(404).json({ error: '缺少岗位能力模型' });
      res.json({
        employee: employee.name, model: { id: model.id, title: model.title },
        gaps: skillGaps(employee, model),
        draft: proposePlan(employee, model, String(req.query.target || '')),
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/learning/plans', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.learning.plan.publish', {
        employee: String(req.body?.employee || ''),
        target_role: req.body?.target_role ? String(req.body.target_role) : undefined,
      });
      res.json({ ok: true, event_id: result.event_id, summary: result.payload.summary });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/learning/events', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.learning.event', req.body || {});
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // —— 知识沉淀 ——
  router.get('/knowledge', async (req, res) => {
    try {
      const ctx = createCtx();
      const pending = await captureKnowledgeDrafts(ctx.store);
      res.json({
        items: await listKnowledge(ctx.store, {
          status: req.query.status ? String(req.query.status) : undefined,
          limit: 200,
        }),
        health: await knowledgeHealth(ctx.store),
        drafts_available: pending.length,
      });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/knowledge/capture', async (_req, res) => {
    try {
      const ctx = createCtx();
      const drafts = await createDrafts(ctx.store, currentActor()?.id || 'admin');
      await appendEvent(ctx.store, {
        capability: 'hr.knowledge.capture', entity_type: 'hr.knowledge', entity_id: 'batch',
        payload: { created: drafts.length }, initiator: 'agent', status: 'proposed',
      });
      res.json({ created: drafts.length, drafts });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/knowledge/:id/publish', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.knowledge.publish', { knowledge_id: String(req.params.id) });
      res.json({ ok: true, event_id: result.event_id, version: result.payload.version });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/knowledge/:id/usage', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.knowledge.usage', {
        knowledge_id: String(req.params.id),
        context: String(req.body?.context || ''),
        adopted: !!req.body?.adopted,
      });
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/knowledge/:id/versions', async (req, res) => {
    try {
      const ctx = createCtx();
      res.json({ versions: await knowledgeVersions(ctx.store, String(req.params.id)) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // —— 招聘效能 ——
  router.get('/recruiting/efficiency', async (_req, res) => {
    try {
      const ctx = createCtx();
      const view = await efficiencyView(ctx.store);
      res.json({ ...view, internal_matches: await internalCandidates(ctx.store, ctx) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/recruiting/sync', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json(await syncRecruitment(ctx.store, ctx));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/recruiting/recommendations/generate', async (_req, res) => {
    try {
      const ctx = createCtx();
      const created = await generateRecommendations(ctx.store, ctx);
      await appendEvent(ctx.store, {
        capability: 'hr.recruit.recommend', entity_type: 'hr.recruit_recommendation', entity_id: 'batch',
        payload: { created: created.length }, initiator: 'agent', status: 'proposed',
      });
      res.json({ created: created.length, recommendations: created });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/recruiting/recommendations/:id/adopt', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.recruit.budget.shift', {
        recommendation_id: String(req.params.id),
        from_channel: String(req.body?.from_channel || ''),
        to_channel: String(req.body?.to_channel || ''),
        amount: Number(req.body?.amount || 0),
      });
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/recruiting/recommendations/:id/measure', async (req, res) => {
    try {
      const ctx = createCtx();
      const measured = await measureRecommendation(ctx.store, String(req.params.id), String(req.body?.note || ''));
      await appendEvent(ctx.store, {
        capability: 'hr.recruit.recommend.measure', entity_type: 'hr.recruit_recommendation', entity_id: String(req.params.id),
        payload: measured, initiator: 'agent', status: 'confirmed', reviewer: currentActor()?.id || 'admin',
      });
      res.json(measured);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // —— 人机介入 ——
  router.get('/autonomy', async (_req, res) => {
    try {
      const ctx = createCtx();
      res.json(await autonomyMatrix(ctx.store));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/autonomy/decide', async (req, res) => {
    try {
      const ctx = createCtx();
      const body = req.body || {};
      const decision = decide({
        action_key: String(body.action_key || ''),
        risk: body.risk, reversible: body.reversible, blast_radius: body.blast_radius,
        confidence: body.confidence === undefined ? 0.8 : Number(body.confidence),
        sensitivity: Array.isArray(body.sensitivity) ? body.sensitivity : undefined,
      });
      await recordDecision(ctx.store, decision, currentActor()?.id || 'admin', String(body.subject || ''));
      res.json(decision);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/autonomy/set', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await settle(ctx, 'hr.autonomy.set', {
        action_key: String(req.body?.action_key || ''),
        level: String(req.body?.level || ''),
        reason: String(req.body?.reason || ''),
      });
      res.json({ ok: true, event_id: result.event_id });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/events', async (_req, res) => {
    try {
      const ctx = createCtx();
      const events = await ctx.store.query('execution', 'events');
      const hrEvents = events
        .filter((e: any) => String(e.capability || '').startsWith('hr.'))
        .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 50);
      res.json({ events: hrEvents });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
