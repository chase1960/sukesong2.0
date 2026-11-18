// HR 中台的对话层：查询用 registry 能力，写操作用确认卡。
//
// 对话在这里不是"问答皮肤的装饰"，而是中台的第二个入口：
//   管理者的真实动作是「先说一句话，再确认一张卡」。所以每个可写动作都必须有 confirm 工具，
//   且工具描述里写清介入等级与后果，模型才不会把 L4 的录用决定当成 L2 的字段修改。
import { registerCapability } from '../../core/registry.ts';
import { CHAT_TOOLS, type ChatToolDef } from '../../core/chat.ts';
import type { Capability, Context } from '../../core/types.ts';
import { HR_TABLES, listAll, findEmployee } from './tables.ts';
import { assetLedger, employeeView } from './assets.ts';
import { dashboard, employeeSnapshot } from './analytics.ts';
import { efficiencyView, internalCandidates, syncRecruitment } from './efficiency.ts';
import { autonomyMatrix, decide } from './autonomy.ts';
import { knowledgeHealth, listKnowledge, searchKnowledge } from './knowledge.ts';
import { twinMetrics, twinView, answerAsTwin, recordTwinQuery } from './twin.ts';
import { listPlans, modelFor, skillGaps } from './learning.ts';
import { buildContext } from '../../core/context.ts';

const ROLES = ['admin', 'manager'];
const OPERATOR = 'hr.copilot';

const overviewQuery: Capability<any, any> = {
  id: 'hr.query.overview', name: '查询 HR 中台总览', impl: 'script', effect: 'read', roles: ROLES,
  async run(_input, ctx: Context) {
    const snap = await dashboard(ctx.store);
    return {
      headcount: snap.workforce.headcount,
      asset_completeness: snap.assets.avg_completeness,
      thin_profiles: snap.assets.thin_profiles.length,
      top_gaps: snap.capability.top_gaps.slice(0, 5),
      recruitment: snap.recruitment.totals,
      learning: snap.learning,
      knowledge: { published: snap.knowledge.published, adoption_rate: snap.knowledge.adoption_rate },
      twins: snap.twins,
      autonomy: { usage: snap.autonomy.usage, pending: snap.autonomy.pending.length },
      risks: snap.risks,
    };
  },
};

const employeesQuery: Capability<any, any> = {
  id: 'hr.query.employees', name: '查询员工与资产覆盖度', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    const employees = await listAll(ctx.store, HR_TABLES.employees);
    const facts = await listAll(ctx.store, HR_TABLES.facts);
    const plans = await listAll(ctx.store, HR_TABLES.plans);
    const filtered = employees.filter((e: any) => {
      if (input?.dept && String(e.dept) !== String(input.dept)) return false;
      if (input?.name && !String(e.name || '').includes(String(input.name))) return false;
      return true;
    });
    const rows = await Promise.all(filtered.slice(0, 30).map(async (e: any) => {
      const view = await employeeView(ctx.store, e);
      return {
        id: e.id, name: e.name, emp_no: e.emp_no, dept: e.dept, title: e.title,
        completeness: view.completeness.score, grade: view.completeness.grade,
        facts: view.facts.length, hints: view.completeness.hints.slice(0, 3),
        twin: view.twin ? view.twin.status : '未授权',
        plan: plans.some((p: any) => String(p.employee_id) === String(e.id) && p.status === 'active') ? '进行中' : '无',
      };
    }));
    return { count: rows.length, employees: rows };
  },
};

const employeeAssetsQuery: Capability<any, any> = {
  id: 'hr.query.employee_assets', name: '查询单个员工的数据资产', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    const employee = await findEmployee(ctx.store, String(input?.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input?.employee || ''}`);
    return employeeSnapshot(ctx.store, employee);
  },
};

const gapQuery: Capability<any, any> = {
  id: 'hr.query.skill_gap', name: '查询能力差距', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    if (input?.employee) {
      const employee = await findEmployee(ctx.store, String(input.employee));
      if (!employee) throw new Error(`员工不存在：${input.employee}`);
      const model = await modelFor(ctx.store, String(input.target_role || employee.title || ''));
      if (!model) throw new Error('缺少岗位能力模型');
      return {
        employee: employee.name, model: model.title,
        gaps: skillGaps(employee, model),
      };
    }
    const snap = await dashboard(ctx.store);
    return { top_gaps: snap.capability.top_gaps, note: '按人查询请传 employee' };
  },
};

const recruitQuery: Capability<any, any> = {
  id: 'hr.query.recruit_efficiency', name: '查询招聘效能与降本建议', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    const view = await efficiencyView(ctx.store);
    const matches = await internalCandidates(ctx.store, ctx);
    if (input?.sync === true) await syncRecruitment(ctx.store, ctx);
    return {
      funnel: view.funnel, stages: view.stages, totals: view.totals,
      channels: view.channels.map((c: any) => ({
        name: c.name, spend: c.spend, hired: c.hired, cpa: c.cpa, quality_rate: c.quality_rate,
      })),
      recommendations: view.recommendations.filter((r: any) => r.status === 'proposed'),
      internal_matches: matches,
      quality: view.quality,
    };
  },
};

const knowledgeQuery: Capability<any, any> = {
  id: 'hr.query.knowledge', name: '查询与检索经验知识', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    if (input?.query) {
      const hits = await searchKnowledge(ctx.store, String(input.query), Number(input.limit) || 5);
      return { query: input.query, hits };
    }
    const rows = await listKnowledge(ctx.store, { status: input?.status ? String(input.status) : undefined, limit: 20 });
    const health = await knowledgeHealth(ctx.store);
    return {
      items: rows.map((k: any) => ({
        id: k.id, title: k.title, domain: k.domain, status: k.status, version: k.version,
        reuse: k.reuse_count, adoption_rate: k.adoption_rate,
      })),
      health: { published: health.published, drafts: health.drafts, adoption_rate: health.adoption_rate, suggestions: health.suggestions },
    };
  },
};

const autonomyQuery: Capability<any, any> = {
  id: 'hr.query.autonomy', name: '查询人机介入分级', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    const matrix = await autonomyMatrix(ctx.store);
    const sample = input?.action_key
      ? decide({
        action_key: String(input.action_key),
        confidence: Number(input.confidence ?? 0.8),
        sensitivity: input.sensitivity ? String(input.sensitivity).split(',') : undefined,
      })
      : null;
    return {
      levels: matrix.levels, usage: matrix.usage,
      rows: matrix.rows.map((r: any) => ({
        action: r.action_key, name: r.name, level: r.effective_level, default_level: r.default_level,
        why: r.why, escalate: r.escalate, usage: r.usage,
      })),
      sample,
      recent: matrix.recent_decisions.slice(0, 8),
    };
  },
};

const twinQuery: Capability<any, any> = {
  id: 'hr.query.twin', name: '查询数字分身状态', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    if (input?.employee) {
      const employee = await findEmployee(ctx.store, String(input.employee));
      if (!employee) throw new Error(`员工不存在：${input.employee}`);
      const twins = await listAll(ctx.store, HR_TABLES.twins, { employee_id: String(employee.id) });
      if (!twins[0]) {
        const view = await employeeView(ctx.store, employee);
        return {
          employee: employee.name, authorized: false,
          readiness_score: view.completeness.score,
          blockers: ['尚未授权数字分身', ...view.completeness.hints.slice(0, 2)],
        };
      }
      return twinView(ctx.store, twins[0]);
    }
    return twinMetrics(ctx.store);
  },
};

/** 分身代答：属于读操作，但必须留痕，所以独立成一个能力而不是直连模型。 */
const twinAsk: Capability<any, any> = {
  id: 'hr.twin.ask', name: '向员工数字分身提问', impl: 'script', effect: 'read', roles: ROLES,
  async run(input, ctx: Context) {
    const employee = await findEmployee(ctx.store, String(input?.employee || ''));
    if (!employee) throw new Error(`员工不存在：${input?.employee || ''}`);
    const answer = await answerAsTwin(ctx.store, String(employee.id), String(input?.question || ''), OPERATOR);
    await recordTwinQuery(ctx.store, String(employee.id), answer, OPERATOR);
    const twins = await listAll(ctx.store, HR_TABLES.twins, { employee_id: String(employee.id) });
    if (twins[0]) {
      await ctx.store.update('business', HR_TABLES.twins, String(twins[0].id), {
        interaction_count: (Number(twins[0].interaction_count) || 0) + 1,
        last_active_at: new Date().toISOString(),
      });
    }
    return answer;
  },
};

const plansQuery: Capability<any, any> = {
  id: 'hr.query.learning_plans', name: '查询培养计划', impl: 'script', effect: 'read', roles: ROLES,
  async run(_input, ctx: Context) {
    return { plans: await listPlans(ctx.store) };
  },
};

export const HR_CHAT_TOOLS: ChatToolDef[] = [
  {
    name: 'hr_overview', capability: 'hr.query.overview', kind: 'query',
    description: '查询 HR 中台总览（真数据）：在职人数、员工数据资产覆盖度、企业能力缺口、招聘单位成本、培养完成率、知识采纳率、数字分身与人机介入分布、风险清单。问「HR 中台现在什么情况」「员工数据沉淀得怎么样」时用。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'hr_employees', capability: 'hr.query.employees', kind: 'query',
    description: '查询员工列表与数据资产覆盖度：每人覆盖度评分、事实条数、还缺什么、是否有分身与培养计划。问「哪些员工数据最薄」「研发部员工数据齐不齐」时用。',
    parameters: {
      type: 'object',
      properties: { dept: { type: 'string', description: '部门（可选）' }, name: { type: 'string', description: '姓名模糊匹配（可选）' } },
    },
  },
  {
    name: 'hr_employee_assets', capability: 'hr.query.employee_assets', kind: 'query',
    description: '查询单个员工的数据资产 360：档案、能力、事实证据、覆盖度分项、能力差距、培养计划、知识贡献。问「张三的数据资产有哪些」「他还缺什么证据」时用。',
    parameters: {
      type: 'object',
      properties: { employee: { type: 'string', description: '姓名、工号或 id' } },
      required: ['employee'],
    },
  },
  {
    name: 'hr_skill_gap', capability: 'hr.query.skill_gap', kind: 'query',
    description: '查询能力差距：按员工算他与目标岗位能力模型逐项差距；不传员工则给企业级最缺的能力。问「张三离高级工程师还差什么」「公司最缺哪项能力」时用。',
    parameters: {
      type: 'object',
      properties: { employee: { type: 'string', description: '员工（可选）' }, target_role: { type: 'string', description: '目标岗位（可选）' } },
    },
  },
  {
    name: 'hr_recruit_efficiency', capability: 'hr.query.recruit_efficiency', kind: 'query',
    description: '查询招聘效能（真数据）：漏斗与阶段转化、各渠道单人成本与质量率、AI 节省工时与金额、待采纳的降本建议、内部可转岗匹配。问「招聘每个入职花多少钱」「哪个渠道该砍」时用。',
    parameters: {
      type: 'object',
      properties: {
        sync: { type: 'boolean', description: '是否先从招聘域同步最新数据（可选）' },
      },
    },
  },
  {
    name: 'hr_knowledge', capability: 'hr.query.knowledge', kind: 'query',
    description: '查询或检索经验知识：已发布知识卡片、草稿、复用与采纳率、自进化建议；传 query 则做相关度检索。问「有没有关于灰度发布的经验」「知识库哪些没人用」时用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词（可选）' },
        status: { type: 'string', description: 'draft | published（可选）' },
      },
    },
  },
  {
    name: 'hr_autonomy', capability: 'hr.query.autonomy', kind: 'query',
    description: '查询人机介入分级矩阵：每个 HR 动作默认 L0-L4 哪一级、为什么、什么情况下升级；传 action_key 可试算某个情境下的级别。问「哪些事 AI 能自己做」「录用决策需要人介入吗」时用。',
    parameters: {
      type: 'object',
      properties: {
        action_key: { type: 'string', description: '动作 key，如 hr.offer.approve（可选）' },
        confidence: { type: 'number', description: 'AI 置信度 0-1（可选）' },
        sensitivity: { type: 'string', description: '敏感数据，逗号分隔：salary/performance/personal（可选）' },
      },
    },
  },
  {
    name: 'hr_twin', capability: 'hr.query.twin', kind: 'query',
    description: '查询数字分身：不传员工给运营指标（可用率、拒答主题、哪些问题答不了）；传员工给该分身的授权范围、边界、就绪度。问「分身都能答什么」「李四的分身授权到什么时候」时用。',
    parameters: { type: 'object', properties: { employee: { type: 'string', description: '员工（可选）' } } },
  },
  {
    name: 'hr_twin_ask', capability: 'hr.twin.ask', kind: 'query',
    description: '向某员工的数字分身提问（只答本人已核实的事实与经验，敏感主题直接拒答并建议找本人）。问「问一下王五的分身他负责过哪些项目」时用。',
    parameters: {
      type: 'object',
      properties: { employee: { type: 'string', description: '员工' }, question: { type: 'string', description: '问题' } },
      required: ['employee', 'question'],
    },
  },
  {
    name: 'hr_learning_plans', capability: 'hr.query.learning_plans', kind: 'query',
    description: '查询培养计划（真数据）：目标岗位、能力差距、90 天动作、完成率与学习记录。问「张三的培养计划进展」时用。',
    parameters: { type: 'object', properties: {} },
  },
  // —— 写操作：全部走 ActionContract 确认卡 ——
  {
    name: 'hr_employee_save', capability: 'hr.employee.save', kind: 'confirm',
    description: '新建或更新员工档案（写操作，需人确认，L2）：按工号定位，存在则字段级更新、不存在则建档。问「把张三的职级改成 P7」时用。',
    parameters: {
      type: 'object',
      properties: {
        emp_no: { type: 'string', description: '工号' }, name: { type: 'string', description: '姓名' },
        dept: { type: 'string', description: '部门' }, title: { type: 'string', description: '岗位' },
        level: { type: 'string', description: '职级（可选）' }, manager: { type: 'string', description: '直属上级（可选）' },
        join_date: { type: 'string', description: '入职日期（可选）' },
      },
      required: ['emp_no', 'name', 'dept', 'title'],
    },
  },
  {
    name: 'hr_fact_record', capability: 'hr.fact.record', kind: 'confirm',
    description: '登记一条员工事实（写操作，需人确认，L2）：这条事实会进入画像、能力匹配与数字分身，确认人即背书人。问「记录张三 9 月交付了推荐系统重构」时用。',
    parameters: {
      type: 'object',
      properties: {
        employee: { type: 'string', description: '员工' },
        kind: { type: 'string', description: 'project | performance | training | feedback | award | skill_demo | knowledge' },
        title: { type: 'string', description: '一句话标题' },
        summary: { type: 'string', description: '摘要，建议写成「情境/行动/结果」' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
      },
      required: ['employee', 'kind', 'title', 'summary'],
    },
  },
  {
    name: 'hr_learning_plan_publish', capability: 'hr.learning.plan.publish', kind: 'confirm',
    description: '生成并发布 90 天培养计划（写操作，需人确认，L3）：按目标岗位能力模型算差距、给分阶段动作与工时预算。问「给张三做一份进阶培养计划」时用。',
    parameters: {
      type: 'object',
      properties: { employee: { type: 'string', description: '员工' }, target_role: { type: 'string', description: '目标岗位（可选）' } },
      required: ['employee'],
    },
  },
  {
    name: 'hr_learning_event_record', capability: 'hr.learning.event', kind: 'confirm',
    description: '记录一次学习行为（写操作，需人确认，L2）：学时、分数、是否应用到工作、柯氏几级。问「张三完成了那门课，记 10 小时」时用。',
    parameters: {
      type: 'object',
      properties: {
        employee: { type: 'string' }, plan_id: { type: 'string', description: '培养计划 id（可选）' },
        action_id: { type: 'string', description: '计划动作 id（可选）' },
        kind: { type: 'string', description: 'course | project | mentor | reading | knowledge' },
        hours: { type: 'number' }, applied: { type: 'boolean', description: '是否已应用到工作（可选）' },
        kirkpatrick_level: { type: 'number', description: '1-4（可选）' },
      },
      required: ['employee', 'kind', 'hours'],
    },
  },
  {
    name: 'hr_knowledge_publish', capability: 'hr.knowledge.publish', kind: 'confirm',
    description: '发布知识卡片（写操作，需人确认，L2，带版本）：只发布草稿或已修订条目，发布后生成新版本可回溯。问「把这条经验发布出去」时用。',
    parameters: {
      type: 'object', properties: { knowledge_id: { type: 'string', description: '知识条目 id' } }, required: ['knowledge_id'],
    },
  },
  {
    name: 'hr_knowledge_usage', capability: 'hr.knowledge.usage', kind: 'confirm',
    description: '记录一次知识复用（写操作，需人确认）：在什么场景引用、是否被采纳。用于判断知识到底有没有用。问「这条经验在推荐系统项目里用上了」时用。',
    parameters: {
      type: 'object',
      properties: {
        knowledge_id: { type: 'string' }, context: { type: 'string', description: '使用场景' },
        adopted: { type: 'boolean', description: '是否采纳' },
      },
      required: ['knowledge_id', 'context', 'adopted'],
    },
  },
  {
    name: 'hr_recruit_budget_shift', capability: 'hr.recruit.budget.shift', kind: 'confirm',
    description: '按建议调整招聘渠道预算（写操作，需人确认，L3，花钱）：从低质量渠道挪到高质量渠道，确认后记基线用于回测。问「把招聘网站的预算挪 5000 给内推」时用。',
    parameters: {
      type: 'object',
      properties: {
        recommendation_id: { type: 'string', description: '建议 id' },
        from_channel: { type: 'string', description: '调出渠道名' },
        to_channel: { type: 'string', description: '调入渠道名' },
        amount: { type: 'number', description: '调整金额（元）' },
      },
      required: ['recommendation_id', 'from_channel', 'to_channel', 'amount'],
    },
  },
  {
    name: 'hr_autonomy_set', capability: 'hr.autonomy.set', kind: 'confirm',
    description: '调整某类 HR 动作的人机介入等级（写操作，需管理员确认，只能收紧不能放宽）：例如把「登记员工事实」固定为 L3。问「以后事实登记都要部门负责人确认」时用。',
    parameters: {
      type: 'object',
      properties: {
        action_key: { type: 'string' }, level: { type: 'string', description: 'L0-L4' },
        reason: { type: 'string', description: '调整理由' },
      },
      required: ['action_key', 'level', 'reason'],
    },
  },
  {
    name: 'hr_twin_authorize', capability: 'hr.twin.authorize', kind: 'confirm',
    description: '为员工开通/续期数字分身（写操作，需人确认，L4，涉及个人数据边界）：设定可见主题、拒答主题与授权期限。问「给张三开通数字分身，先开半年」时用。',
    parameters: {
      type: 'object',
      properties: {
        employee: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' }, description: '可见主题（可选）' },
        denied: { type: 'array', items: { type: 'string' }, description: '拒答主题（可选）' },
        expires_days: { type: 'number', description: '授权天数，默认 180（可选）' },
      },
      required: ['employee'],
    },
  },
];

export function registerHrChatTools(): void {
  for (const cap of [
    overviewQuery, employeesQuery, employeeAssetsQuery, gapQuery,
    recruitQuery, knowledgeQuery, autonomyQuery, twinQuery, twinAsk, plansQuery,
  ]) registerCapability(cap);
  for (const tool of HR_CHAT_TOOLS) CHAT_TOOLS.push(tool);
}

/** 供 REST 与测试复用的上下文（招聘域同款）。 */
export function hrContext() {
  return buildContext(() => {}, {});
}

export type { Capability };

