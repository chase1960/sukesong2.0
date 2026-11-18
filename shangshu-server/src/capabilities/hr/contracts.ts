// HR 中台的写动作契约：全部 human 确认，全部可审计。
//
// 契约只负责三件事：校验输入 → 组装出「人要看的那一版」payload → 事务内落库。
// 「谁可以做」由 core 的 roles 校验，「要不要人确认」由 confirmation:'human' 强制，
// 「这件事该是 L2 还是 L4」由 autonomy.decide 算，并写进 payload 供审计链回溯。
import { registerActionContract } from '../../core/action-contracts.ts';
import { HR_TABLES, listAll, findEmployee, nowIso } from './tables.ts';
import { decide } from './autonomy.ts';
import { publishKnowledge } from './knowledge.ts';
import { adoptBudgetShift } from './efficiency.ts';
import { proposePlan, modelFor } from './learning.ts';
import { getById } from './tables.ts';

const KINDS = ['project', 'performance', 'training', 'feedback', 'award', 'skill_demo', 'knowledge'];
const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];

/* 内核在 requestConfirmation / resolveConfirmation 两处校验的都是 **payload**（确认卡上人看到的那一版），
 * 不是 resolve 的入参。所以每个 schema 必须同时容纳 resolve 富化出来的字段（员工姓名、自主等级、
 * 计划动作包……），否则挂卡就会报"缺少 required / 多余属性"。
 * 下面两个片段统一描述富化字段，避免十份契约各自漂移。 */
const AUTONOMY = {
  type: 'object', additionalProperties: false,
  properties: { level: { type: 'string', enum: LEVELS }, reasons: { type: 'array', items: { type: 'string' } } },
  required: ['level', 'reasons'],
};
const ANY_ARRAY = { type: 'array' };
const ANY_OBJECT = { type: 'object' };

/** 员工建档/更新：L2。字段级覆盖，不整条替换，避免把已有事实（技能/教育）冲掉。 */
registerActionContract({
  id: 'hr.employee.save',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      employee_id: { type: 'string' },
      emp_no: { type: 'string' },
      name: { type: 'string' },
      dept: { type: 'string' },
      title: { type: 'string' },
      level: { type: 'string' },
      manager: { type: 'string' },
      join_date: { type: 'string' },
      location: { type: 'string' },
      education: { type: 'string' },
      employment_type: { type: 'string' },
      status: { type: 'string', enum: ['active', 'left'] },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string' }, level: { type: 'number' } },
          required: ['name', 'level'],
        },
      },
      mode: { type: 'string', enum: ['create', 'update'] },
      autonomy: AUTONOMY,
    },
    required: ['emp_no', 'name', 'dept', 'title', 'mode', 'autonomy'],
  },
  async resolve(store, input) {
    const empNo = String(input.emp_no || '').trim();
    const existing = await findEmployee(store, String(input.employee_id || empNo));
    const decision = decide({ action_key: 'hr.employee.save', risk: 'medium', sensitivity: ['personal'], confidence: 0.85 });
    return {
      entity_type: 'hr.employee',
      entity_id: existing ? String(existing.id) : `new:${empNo}`,
      payload: {
        ...input,
        employee_id: existing ? existing.id : '',
        status: input.status || 'active',
        autonomy: { level: decision.level, reasons: decision.reasons },
        mode: existing ? 'update' : 'create',
      },
    };
  },
  async snapshot(store, input) {
    const existing = await findEmployee(store, String(input.employee_id || input.emp_no || ''));
    return existing ? { exists: true, name: existing.name, dept: existing.dept, title: existing.title } : { exists: false };
  },
  async execute(payload, ctx) {
    const id = String(payload.employee_id || '');
    const ts = nowIso();
    if (id) {
      const patch: Record<string, any> = { updated_at: ts, updated_by: ctx.actor.id };
      for (const key of ['name', 'dept', 'title', 'level', 'manager', 'join_date', 'location', 'education', 'employment_type', 'status']) {
        if (payload[key] !== undefined && payload[key] !== '') patch[key] = payload[key];
      }
      if (payload.skills) patch.skills = JSON.stringify(payload.skills);
      await ctx.store.update('business', HR_TABLES.employees, id, patch);
      return;
    }
    await ctx.store.insert('business', HR_TABLES.employees, {
      emp_no: payload.emp_no, name: payload.name, dept: payload.dept, title: payload.title,
      level: payload.level || '', manager: payload.manager || '', join_date: payload.join_date || '',
      location: payload.location || '', education: payload.education || '',
      employment_type: payload.employment_type || '全职', status: payload.status || 'active',
      skills: JSON.stringify(payload.skills || []), source: 'manual',
      created_at: ts, updated_at: ts, created_by: ctx.actor.id,
    });
  },
});

/** 登记员工事实：L2。事实是画像与分身的地基，所以确认后直接标记 verified（确认人即背书人）。 */
registerActionContract({
  id: 'hr.fact.record',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      employee: { type: 'string' },
      kind: { type: 'string', enum: KINDS },
      title: { type: 'string' },
      summary: { type: 'string' },
      occurred_at: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      evidence_strength: { type: 'number', enum: [1, 2, 3] },
      employee_id: { type: 'string' },
      employee_name: { type: 'string' },
      autonomy: AUTONOMY,
    },
    required: ['employee', 'kind', 'title', 'summary', 'employee_id', 'employee_name', 'occurred_at', 'evidence_strength', 'autonomy'],
  },
  async resolve(store, input) {
    const employee = await findEmployee(store, String(input.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input.employee}`);
    const decision = decide({ action_key: 'hr.fact.record', risk: 'low', sensitivity: ['performance'], confidence: 0.8 });
    return {
      entity_type: 'hr.employee_fact',
      entity_id: `employee:${employee.id}`,
      payload: {
        ...input,
        employee_id: String(employee.id),
        employee_name: employee.name,
        occurred_at: input.occurred_at || new Date().toISOString().slice(0, 10),
        evidence_strength: input.evidence_strength || 2,
        autonomy: { level: decision.level, reasons: decision.reasons },
      },
    };
  },
  async execute(payload, ctx) {
    const ts = nowIso();
    await ctx.store.insert('business', HR_TABLES.facts, {
      employee_id: payload.employee_id, kind: payload.kind, title: payload.title,
      summary: payload.summary, occurred_at: payload.occurred_at,
      tags: JSON.stringify(payload.tags || []), evidence_strength: payload.evidence_strength,
      status: 'verified', verified_by: ctx.actor.id, verified_at: ts,
      source: 'human-confirmed', created_at: ts,
    });
  },
});

/** 事实核实：L2。用于 AI 起草、人工核实的场景（AI 不给自己写的东西背书）。 */
registerActionContract({
  id: 'hr.fact.verify',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      fact_id: { type: 'string' }, title: { type: 'string' }, employee_id: { type: 'string' },
    },
    required: ['fact_id', 'title', 'employee_id'],
  },
  async resolve(store, input) {
    const rows = await store.query('business', HR_TABLES.facts, { id: String(input.fact_id) });
    if (!rows[0]) throw new Error('事实记录不存在');
    return {
      entity_type: 'hr.employee_fact', entity_id: String(rows[0].id),
      payload: { fact_id: rows[0].id, title: rows[0].title, employee_id: rows[0].employee_id },
    };
  },
  async execute(payload, ctx) {
    await ctx.store.update('business', HR_TABLES.facts, String(payload.fact_id), {
      status: 'verified', verified_by: ctx.actor.id, verified_at: nowIso(),
    });
  },
});

/** 数字分身授权：L4。个人数据边界的让渡，必须人确认；范围与期限缺一不可。 */
registerActionContract({
  id: 'hr.twin.authorize',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      employee: { type: 'string' },
      topics: { type: 'array', items: { type: 'string' } },
      denied: { type: 'array', items: { type: 'string' } },
      expires_days: { type: 'number' },
      consent_channel: { type: 'string' },
      employee_id: { type: 'string' },
      employee_name: { type: 'string' },
      expires_at: { type: 'string' },
      existing_twin_id: { type: 'string' },
      autonomy: AUTONOMY,
    },
    required: ['employee_id', 'employee_name', 'expires_days', 'expires_at', 'consent_channel', 'autonomy'],
  },
  async resolve(store, input) {
    const employee = await findEmployee(store, String(input.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input.employee}`);
    const twins = await listAll(store, HR_TABLES.twins, { employee_id: String(employee.id) });
    const days = Number(input.expires_days) || 180;
    const expires = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    const decision = decide({ action_key: 'hr.twin.authorize', risk: 'high', reversible: false, sensitivity: ['personal'], confidence: 0.75 });
    return {
      entity_type: 'hr.twin',
      entity_id: twins[0] ? String(twins[0].id) : `new:${employee.id}`,
      payload: {
        employee_id: employee.id, employee_name: employee.name,
        topics: input.topics || undefined, denied: input.denied || undefined,
        expires_days: days, expires_at: expires,
        consent_channel: input.consent_channel || 'web-confirm',
        autonomy: { level: decision.level, reasons: decision.reasons },
        existing_twin_id: twins[0]?.id || '',
      },
    };
  },
  async execute(payload, ctx) {
    const scope = {
      topics: payload.topics || ['岗位职责', '项目经历', '技能与专长', '协作方式', '可提供的帮助', '成长与学习'],
      denied: payload.denied || ['薪酬与奖金', '绩效评级细节', '他人评价', '离职或求职意向', '健康与婚育', '法律与医疗建议', '公司未公开信息'],
      data_policy: { salary: false, performance: 'summary_only', others_evaluation: false, personal: false },
    };
    const ts = nowIso();
    if (payload.existing_twin_id) {
      await ctx.store.update('business', HR_TABLES.twins, String(payload.existing_twin_id), {
        status: 'active', scope: JSON.stringify(scope), expires_at: payload.expires_at,
        authorized_by: ctx.actor.id, authorized_at: ts, consent_channel: payload.consent_channel,
        level: 'L1', updated_at: ts,
      });
      return;
    }
    await ctx.store.insert('business', HR_TABLES.twins, {
      employee_id: payload.employee_id, display_name: `${payload.employee_name} 的数字分身`,
      status: 'active', level: 'L1', scope: JSON.stringify(scope),
      authorized_by: ctx.actor.id, authorized_at: ts, expires_at: payload.expires_at,
      consent_channel: payload.consent_channel, interaction_count: 0,
      created_at: ts, updated_at: ts,
    });
  },
});

/** 发布培养计划：L3。多步、跨 90 天、承诺资源，所以确认的是整包而不是单条。 */
registerActionContract({
  id: 'hr.learning.plan.publish',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      employee: { type: 'string' }, target_role: { type: 'string' },
      employee_id: { type: 'string' }, employee_name: { type: 'string' }, model_id: { type: 'string' },
      gaps: ANY_ARRAY, actions: ANY_ARRAY, baseline_skills: ANY_ARRAY, hours: { type: 'number' },
      summary: { type: 'string' },
      autonomy: AUTONOMY,
    },
    required: ['employee_id', 'employee_name', 'target_role', 'model_id', 'gaps', 'actions', 'hours', 'baseline_skills', 'summary', 'autonomy'],
  },
  async resolve(store, input) {
    const employee = await findEmployee(store, String(input.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input.employee}`);
    const model = await modelFor(store, String(input.target_role || employee.title || ''));
    if (!model) throw new Error('缺少岗位能力模型，无法生成计划；请先维护能力模型');
    const plan = proposePlan(employee, model, String(input.target_role || ''));
    const decision = decide({ action_key: 'hr.learning.plan.publish', risk: 'medium', blast_radius: 'team', sensitivity: ['performance'], confidence: 0.8 });
    return {
      entity_type: 'hr.learning_plan', entity_id: `employee:${employee.id}`,
      payload: {
        employee_id: employee.id, employee_name: employee.name, target_role: plan.target_role,
        model_id: model.id, gaps: plan.gaps, actions: plan.actions, hours: plan.hours,
        baseline_skills: plan.baseline_skills, summary: plan.summary,
        autonomy: { level: decision.level, reasons: decision.reasons },
      },
    };
  },
  async execute(payload, ctx) {
    const ts = nowIso();
    await ctx.store.insert('business', HR_TABLES.plans, {
      employee_id: payload.employee_id, target_role: payload.target_role, model_id: payload.model_id,
      gaps: JSON.stringify(payload.gaps), actions: JSON.stringify(payload.actions),
      hours: payload.hours, baseline_skills: JSON.stringify(payload.baseline_skills),
      status: 'active', owner: ctx.actor.id, started_at: ts, created_at: ts, updated_at: ts,
    });
  },
});

/** 记录学习行为：L2。没有行为数据，培训 ROI 永远是拍脑袋。 */
registerActionContract({
  id: 'hr.learning.event',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      employee: { type: 'string' },
      plan_id: { type: 'string' },
      action_id: { type: 'string' },
      kind: { type: 'string', enum: ['course', 'project', 'mentor', 'reading', 'knowledge'] },
      hours: { type: 'number' },
      score: { type: 'number' },
      applied: { type: 'boolean' },
      kirkpatrick_level: { type: 'number', enum: [1, 2, 3, 4] },
      note: { type: 'string' },
      employee_id: { type: 'string' },
      employee_name: { type: 'string' },
    },
    required: ['employee', 'kind', 'hours', 'employee_id', 'employee_name'],
  },
  async resolve(store, input) {
    const employee = await findEmployee(store, String(input.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input.employee}`);
    const plan = input.plan_id ? (await store.query('business', HR_TABLES.plans, { id: String(input.plan_id) }))[0] : null;
    if (input.plan_id && !plan) throw new Error('培养计划不存在');
    return {
      entity_type: 'hr.learning_event', entity_id: `employee:${employee.id}`,
      payload: { ...input, employee_id: employee.id, employee_name: employee.name },
    };
  },
  async execute(payload, ctx) {
    const ts = nowIso();
    await ctx.store.insert('business', HR_TABLES.learningEvents, {
      employee_id: payload.employee_id, plan_id: payload.plan_id || '', action_id: payload.action_id || '',
      kind: payload.kind, hours: payload.hours, score: payload.score || 0,
      applied: payload.applied === undefined ? false : payload.applied,
      kirkpatrick_level: payload.kirkpatrick_level || 1, note: payload.note || '',
      created_at: ts,
    });
    if (payload.plan_id && payload.action_id) {
      const plan = (await ctx.store.query('business', HR_TABLES.plans, { id: String(payload.plan_id) }))[0];
      if (plan) {
        const actions = JSON.parse(String(plan.actions || '[]'));
        const events = await ctx.store.query('business', HR_TABLES.learningEvents, { plan_id: String(payload.plan_id) });
        const done = new Set(events.map((e: any) => String(e.action_id)));
        if (actions.length && actions.every((a: any) => done.has(String(a.id)))) {
          await ctx.store.update('business', HR_TABLES.plans, String(plan.id), { status: 'done', completed_at: ts });
        }
      }
    }
  },
});

/** 发布知识卡片：L2，带版本。发布不是覆盖，历史版本永久可回溯。 */
registerActionContract({
  id: 'hr.knowledge.publish',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      knowledge_id: { type: 'string' }, title: { type: 'string' },
      version: { type: 'number' }, situation: { type: 'string' },
      autonomy: AUTONOMY,
    },
    required: ['knowledge_id', 'title', 'version', 'situation', 'autonomy'],
  },
  async resolve(store, input) {
    const row = await getById(store, HR_TABLES.knowledge, String(input.knowledge_id));
    if (!row) throw new Error('知识条目不存在');
    const decision = decide({ action_key: 'hr.knowledge.publish', risk: 'low', blast_radius: 'team', confidence: 0.85 });
    return {
      entity_type: 'hr.knowledge', entity_id: String(row.id),
      payload: {
        knowledge_id: row.id, title: row.title, version: Number(row.version || 0) + 1,
        situation: String(row.situation || '').slice(0, 200),
        autonomy: { level: decision.level, reasons: decision.reasons },
      },
    };
  },
  async execute(payload, ctx) {
    await publishKnowledge(ctx.store, String(payload.knowledge_id), ctx.actor.id);
  },
});

/** 知识复用记账：L1 的"用量"，但仍是写操作，走确认卡保证可审计。 */
registerActionContract({
  id: 'hr.knowledge.usage',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      knowledge_id: { type: 'string' }, context: { type: 'string' }, adopted: { type: 'boolean' },
      title: { type: 'string' },
    },
    required: ['knowledge_id', 'context', 'adopted', 'title'],
  },
  async resolve(store, input) {
    const row = await getById(store, HR_TABLES.knowledge, String(input.knowledge_id));
    if (!row) throw new Error('知识条目不存在');
    if (row.status !== 'published') throw new Error('只有已发布的知识可以被引用');
    return {
      entity_type: 'hr.knowledge', entity_id: String(row.id),
      payload: { ...input, title: row.title },
    };
  },
  async execute(payload, ctx) {
    const row = (await ctx.store.query('business', HR_TABLES.knowledge, { id: String(payload.knowledge_id) }))[0];
    await ctx.store.insert('business', HR_TABLES.knowledgeUsages, {
      knowledge_id: String(payload.knowledge_id), context: payload.context,
      adopted: !!payload.adopted, used_by: ctx.actor.id, created_at: nowIso(),
    });
    await ctx.store.update('business', HR_TABLES.knowledge, String(payload.knowledge_id), {
      reuse_count: (Number(row?.reuse_count) || 0) + 1,
      adopted_count: (Number(row?.adopted_count) || 0) + (payload.adopted ? 1 : 0),
      updated_at: nowIso(),
    });
  },
});

/** 渠道预算调整：L3。花钱的动作只能整包确认，且金额不得超过该渠道现有预算。 */
registerActionContract({
  id: 'hr.recruit.budget.shift',
  revision: 1,
  roles: ['admin', 'manager'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      recommendation_id: { type: 'string' }, from_channel: { type: 'string' },
      to_channel: { type: 'string' }, amount: { type: 'number' },
      title: { type: 'string' },
      autonomy: AUTONOMY,
    },
    required: ['recommendation_id', 'from_channel', 'to_channel', 'amount', 'title', 'autonomy'],
  },
  async resolve(store, input) {
    const rec = await getById(store, HR_TABLES.recommendations, String(input.recommendation_id));
    if (!rec) throw new Error('建议不存在');
    if (rec.status !== 'proposed') throw new Error('只有待采纳的建议可以执行');
    const channels = await listAll(store, HR_TABLES.channels);
    const from = channels.find((c: any) => c.name === input.from_channel);
    const to = channels.find((c: any) => c.name === input.to_channel);
    if (!from || !to) throw new Error('渠道不存在');
    if (Number(input.amount) > Number(from.spend)) throw new Error('调整金额不能超过该渠道现有预算');
    const decision = decide({ action_key: 'hr.recruit.budget.shift', risk: 'medium', blast_radius: 'company', confidence: 0.8 });
    return {
      entity_type: 'hr.recruit_recommendation', entity_id: String(rec.id),
      payload: { ...input, title: rec.title, autonomy: { level: decision.level, reasons: decision.reasons } },
    };
  },
  async execute(payload, ctx) {
    await adoptBudgetShift(ctx.store, {
      recommendation_id: String(payload.recommendation_id),
      from_channel: String(payload.from_channel),
      to_channel: String(payload.to_channel),
      amount: Number(payload.amount),
    });
  },
});

/** 介入等级调整：只有管理员能改，且只能抬高门槛，不能把自动化放宽。 */
registerActionContract({
  id: 'hr.autonomy.set',
  revision: 1,
  roles: ['admin'],
  confirmation: 'human',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action_key: { type: 'string' }, level: { type: 'string', enum: LEVELS }, reason: { type: 'string' },
      existing: { type: 'string' },
    },
    required: ['action_key', 'level', 'reason', 'existing'],
  },
  async resolve(store, input) {
    const rows = await listAll(store, HR_TABLES.autonomyPolicies, { action_key: String(input.action_key) });
    return {
      entity_type: 'hr.autonomy_policy', entity_id: String(input.action_key),
      payload: { ...input, existing: rows[0]?.level || '' },
    };
  },
  async execute(payload, ctx) {
    const { canOverride } = await import('./autonomy.ts');
    const level = String(payload.level) as any;
    const check = await canOverride(ctx.store, String(payload.action_key), level, ctx.actor.role);
    if (!check.ok) throw new Error(check.reason);
    const rows = await listAll(ctx.store, HR_TABLES.autonomyPolicies, { action_key: String(payload.action_key) });
    if (rows[0]) {
      await ctx.store.update('business', HR_TABLES.autonomyPolicies, String(rows[0].id), {
        level, reason: payload.reason, updated_by: ctx.actor.id, updated_at: nowIso(),
      });
      return;
    }
    await ctx.store.insert('business', HR_TABLES.autonomyPolicies, {
      action_key: payload.action_key, level, reason: payload.reason,
      created_by: ctx.actor.id, created_at: nowIso(), updated_at: nowIso(),
    });
  },
});
